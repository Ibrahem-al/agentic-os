/**
 * Skill-improvement agent types (§17 "Skill-improvement agent — detailed
 * design", phase 12). The agent is a Phase-04 workflow — every slice of state
 * below checkpoints between steps, so everything is plain JSON. Graph +
 * ledger writes happen ONLY in the final `write` step: a crash between steps
 * leaves skill memory untouched, and resume() replays from the last completed
 * step without re-buying cloud calls (the candidate rewrite checkpoints
 * BEFORE the local-heavy benchmark runs).
 *
 * Model dependencies are structural (the extraction pattern): the real
 * OllamaClient / CloudBrain / SpendMeter satisfy them; tests inject fakes.
 */
import type BetterSqlite3 from 'better-sqlite3'
import type { WorkflowRunner } from '../../kernel'
import type { CloudBrain, ProviderRouter, SpendMeter } from '../../models'
import type { AuditLog } from '../../security/audit'
import type { StorageEngine } from '../../storage'

// ── Structural model interfaces ──────────────────────────────────────────────

/** Satisfied by OllamaClient (bge-m3 — Skill re-embeds on adoption). */
export interface SkillEmbedder {
  embed(texts: string[]): Promise<number[][]>
}

/**
 * Satisfied by OllamaClient — the LOCAL small LLM runs the benchmark's case
 * executions and the assertion grader (schema-constrained, phase-08 finding).
 */
export interface SkillLlm {
  generate(
    prompt: string,
    options?: {
      system?: string
      maxTokens?: number
      temperature?: number
      format?: 'json' | Record<string, unknown>
    }
  ): Promise<{ text: string }>
}

/**
 * The cloud tier: test-set synthesis, candidate rewrite, and the stylistic
 * blind comparator (§17: "judged by a different model/tier" — the executor is
 * local). Every call is metered against the workflow job id (§14 ceiling).
 */
export interface SkillCloud {
  readonly brain: CloudBrain
  readonly meter: SpendMeter
}

/**
 * A role-bound cloud completion for the §17 cloud-tier roles (testset / rewrite
 * / comparator): either the phase-16b router's cloud/subscription tier or
 * today's metered `meteredComplete`. The caller holds `null` when NO genuinely
 * different (non-local) tier serves the role — reproducing today's "no cloud
 * tier" behavior exactly (the keyless default) and keeping §17's blind
 * comparator on a different tier from the local executor. Only `.text` is used.
 */
export type SkillCloudCall = (req: {
  readonly prompt: string
  readonly system?: string
  readonly maxTokens?: number
}) => Promise<{ text: string }>

export interface SkillAgentDeps {
  readonly engine: StorageEngine
  /** appdata.db — skill_settings/skill_improvements + staged_writes (SQLite). */
  readonly db: BetterSqlite3.Database
  readonly runner: WorkflowRunner
  readonly embedder: SkillEmbedder
  readonly llm: SkillLlm
  /** Absent = no API key configured; gated skills skip with a warning. */
  readonly cloud?: SkillCloud | null
  /**
   * §11.4 provider router (phase-16b). When present it OWNS role→backend
   * resolution PER RUN and WINS over `llm`/`cloud`; when absent the agent uses
   * today's `llm`/`cloud` unchanged (DEFAULT == TODAY). Only boot injects it, so
   * every existing fake-injecting test rig (no router) keeps its exact behavior.
   */
  readonly router?: ProviderRouter
  /**
   * §13 audit log — REQUIRED: every version flip records a reversible delta
   * (§21 rule 11), and rollback rides those recorded inverses.
   */
  readonly audit: AuditLog
}

// ── Errors ───────────────────────────────────────────────────────────────────

export type SkillImprovementErrorCode = 'INVALID_INPUT' | 'NOT_FOUND' | 'INVALID_STATE'

export class SkillImprovementError extends Error {
  readonly code: SkillImprovementErrorCode

  constructor(code: SkillImprovementErrorCode, message: string) {
    super(message)
    this.name = 'SkillImprovementError'
    this.code = code
  }
}

// ── plan step (event gate + drift scan) ──────────────────────────────────────

export type SkillAdoptionMode = 'verifiable' | 'stylistic'

export interface SkillSignalCorrection {
  readonly id: string
  readonly content: string
  readonly createdAt: string | null
  /** True when created after the skill's last improvement run (gate signal). */
  readonly isNew: boolean
}

export interface SkillSignalExample {
  readonly id: string
  readonly content: string
  readonly createdAt: string | null
  readonly isNew: boolean
}

/** One skill selected for improvement this run. */
export interface SkillWorkItem {
  readonly skillId: string
  readonly skillName: string
  /** The baseline instructions being benchmarked against (SKILL.md or legacy plain text). */
  readonly activeInstructions: string
  /** Active SkillVersion node id, when one exists (first adoptions have none). */
  readonly activeVersionId: string | null
  readonly mode: SkillAdoptionMode
  readonly autoRevert: boolean
  /** ALL of the skill's corrections (§17: "past Corrections"), capped. */
  readonly corrections: readonly SkillSignalCorrection[]
  /** Failure examples — rewrite input + gate signal. */
  readonly failureExamples: readonly SkillSignalExample[]
}

/** A skill looked at and deliberately not processed (honest task notes). */
export interface SkillSkipNote {
  readonly skillId: string
  readonly skillName: string
  readonly reason: string
}

export interface DriftFinding {
  readonly improvementId: string
  readonly skillId: string
  readonly skillName: string
  readonly versionId: string
  /** corrections per use over the new version's first ≤20 uses. */
  readonly newRate: number
  readonly predecessorRate: number
  readonly usesObserved: number
  readonly correctionsObserved: number
  readonly verdict: 'worse' | 'cleared'
  /** Whether the per-skill setting asks for auto-revert on a worse verdict. */
  readonly autoRevert: boolean
}

export interface PlanState {
  readonly mode: 'nightly' | 'manual'
  /** ISO run-start — becomes last_run_at for every processed skill. */
  readonly runStartedAt: string
  readonly work: readonly SkillWorkItem[]
  readonly skipped: readonly SkillSkipNote[]
  readonly drift: readonly DriftFinding[]
  readonly warnings: readonly string[]
}

// ── testset step ─────────────────────────────────────────────────────────────

export type SkillCaseSource = 'correction' | 'synthetic'
export type SkillCaseSplit = 'train' | 'heldout'

export interface SkillTestCase {
  readonly id: string
  readonly source: SkillCaseSource
  /** The Correction node this regression case guards (correction cases only). */
  readonly correctionId: string | null
  readonly prompt: string
  readonly expectations: readonly string[]
  readonly split: SkillCaseSplit
}

export interface SkillTestSet {
  readonly skillId: string
  readonly cases: readonly SkillTestCase[]
  readonly warnings: readonly string[]
}

export interface TestsetState {
  readonly testsets: readonly SkillTestSet[]
  readonly warnings: readonly string[]
}

// ── candidate step ───────────────────────────────────────────────────────────

export interface SkillCandidate {
  readonly skillId: string
  /** Deterministic version id derived from the instructions content hash. */
  readonly candidateVersionId: string
  /** The full SKILL.md text (validated frontmatter + body). */
  readonly instructions: string
  /** null = the rewrite failed; the reason lands in warnings + skip notes. */
  readonly error: string | null
}

export interface CandidateState {
  readonly candidates: readonly SkillCandidate[]
  readonly warnings: readonly string[]
}

// ── benchmark step ───────────────────────────────────────────────────────────

export type BenchmarkConfig = 'candidate' | 'active'

/** One graded expectation of one run (verifiable path). */
export interface GradedExpectation {
  readonly expectation: string
  readonly passed: boolean
  readonly evidence: string
}

export interface CaseRunResult {
  readonly caseId: string
  readonly config: BenchmarkConfig
  readonly runIndex: number
  readonly output: string
  /** Verifiable path: per-expectation verdicts; empty for stylistic. */
  readonly graded: readonly GradedExpectation[]
  /** Fraction of the case's expectations passed in this run (verifiable). */
  readonly passRate: number
}

/** One blind A/B comparison of candidate vs active outputs (stylistic path). */
export interface ComparisonResult {
  readonly caseId: string
  readonly runIndex: number
  readonly winner: 'candidate' | 'active' | 'tie' | 'unavailable'
  readonly reasoning: string
}

export interface RegressionFinding {
  readonly caseId: string
  readonly correctionId: string
  readonly expectation: string
  /** active majority-passed while candidate majority-failed. */
  readonly activePassRuns: number
  readonly candidatePassRuns: number
  readonly runs: number
}

export interface BenchmarkSummary {
  readonly kind: SkillAdoptionMode
  readonly runsPerCase: number
  readonly trainCases: number
  readonly heldoutCases: number
  /** Verifiable: mean pass rate over held-out case-runs, per config. */
  readonly heldoutScore: { readonly candidate: number; readonly active: number } | null
  readonly trainScore: { readonly candidate: number; readonly active: number } | null
  /** Stylistic: held-out blind-comparison tallies. */
  readonly comparisons: { readonly candidateWins: number; readonly activeWins: number; readonly ties: number } | null
  readonly regressions: readonly RegressionFinding[]
  readonly netPositive: boolean
  readonly zeroRegression: boolean
  readonly notes: readonly string[]
}

export interface SkillBenchmark {
  readonly skillId: string
  readonly summary: BenchmarkSummary
  readonly runs: readonly CaseRunResult[]
  readonly comparisons: readonly ComparisonResult[]
  /** null = the benchmark could not run (budget halt, model down); no adoption. */
  readonly error: string | null
}

export interface BenchmarkState {
  /** Aligned with plan.work; null = the skill had no benchmarkable candidate. */
  readonly benchmarks: readonly (SkillBenchmark | null)[]
  readonly warnings: readonly string[]
}

// ── write step result ────────────────────────────────────────────────────────

export type SkillOutcome =
  | 'adopted'
  | 'rejected'
  | 'staged'
  | 'skipped-no-signal'
  | 'skipped-pending-review'
  | 'skipped-no-cloud'
  | 'skipped-deferred'
  | 'failed-candidate'
  | 'failed-benchmark'

export interface ProcessedSkill {
  readonly skillId: string
  readonly skillName: string
  readonly outcome: SkillOutcome
  readonly candidateVersionId: string | null
  readonly stagedWriteId: string | null
  readonly heldoutScore: { readonly candidate: number; readonly active: number } | null
  readonly regressions: number
  readonly note: string
}

export interface DriftApplied extends DriftFinding {
  readonly action: 'flagged' | 'auto-reverted' | 'cleared'
}

export interface SkillImprovementResult {
  readonly mode: 'nightly' | 'manual'
  readonly processed: readonly ProcessedSkill[]
  readonly drift: readonly DriftApplied[]
  readonly warnings: readonly string[]
}

export interface SkillImprovementRunResult extends SkillImprovementResult {
  readonly jobId: string
}
