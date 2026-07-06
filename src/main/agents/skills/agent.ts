/**
 * The skill-improvement agent (§17 agent #4), assembled as a Phase-04
 * workflow:
 *
 *   plan → testset → candidate → benchmark → write
 *
 * Every step's output checkpoints into appdata.db (durability 'sync'): a
 * crash resumes from the last completed step, so the CLOUD calls (test-set
 * synthesis in `testset`, the rewrite in `candidate`) are never re-bought by
 * a crash inside the local-heavy `benchmark` step. ALL graph/ledger/staging
 * writes live in the final `write` step — a crash anywhere earlier leaves
 * skill memory untouched.
 *
 * Triggers: the 02:00 §20 slot enqueues the nightly task (kind
 * 'skill-improvement', no payload — event-gated inside `plan`), and the
 * dashboard's "improve now" enqueues a manual task carrying a skillId.
 * handler.ts wires both to exactly these entry points.
 */
import { randomUUID } from 'node:crypto'
import type { JsonObject, WorkflowStep } from '../../kernel'
import { meteredComplete } from '../../models'
import type { RoleKey } from '../../models'
import { runBenchmark } from './benchmark'
import { generateCandidate } from './candidate'
import { planImprovementRun } from './gate'
import {
  adoptSkillVersion,
  recordCandidateVersion,
  rollbackSkillAdoption,
  stageSkillImprovement,
  stagedWriteIdOf,
  SKILL_IMPROVEMENT_AGENT_ID,
  type SkillImprovementPayload,
  type SkillLifecycleDeps
} from './lifecycle'
import { ensureSkillMd, parseSkillMd, serializeSkillMd, skillMdNameOf } from './skillmd'
import {
  getImprovement,
  latestStandingAdoption,
  markImprovementDrift,
  markSkillRun,
  recordImprovement
} from './state'
import { buildTestSet } from './testset'
import {
  SkillImprovementError,
  type BenchmarkState,
  type CandidateState,
  type DriftApplied,
  type PlanState,
  type ProcessedSkill,
  type SkillAgentDeps,
  type SkillBenchmark,
  type SkillCandidate,
  type SkillCloudCall,
  type SkillImprovementResult,
  type SkillImprovementRunResult,
  type SkillLlm,
  type SkillTestSet,
  type SkillWorkItem,
  type TestsetState
} from './types'

export const SKILL_IMPROVEMENT_WORKFLOW = 'skill-improvement'
export { SKILL_IMPROVEMENT_AGENT_ID }

export const CLOUD_UNAVAILABLE_ERROR = 'cloud tier unavailable — configure an API key in settings to generate candidates'

export interface RunImprovementOptions {
  /** Improve one skill (the manual trigger); omitted = the nightly event gate. */
  readonly skillId?: string
  /** Caller-supplied job id (the queue handler); defaults to a random UUID. */
  readonly jobId?: string
}

export interface SkillImprovementAgent {
  runImprovement(options?: RunImprovementOptions): Promise<SkillImprovementRunResult>
  resumeImprovement(jobId: string): Promise<SkillImprovementRunResult>
}

interface ImprovementInput {
  readonly mode: 'nightly' | 'manual'
  readonly skillId: string | null
}

/**
 * Baseline SKILL.md for a skill whose stored instructions may be legacy plain
 * text (or even a corrupt frontmatter attempt): always yields a valid file +
 * the frontmatter name candidates must keep.
 */
export function baselineSkillMdOf(item: Pick<SkillWorkItem, 'skillName' | 'activeInstructions'>): {
  md: string
  name: string
} {
  let md: string
  try {
    md = ensureSkillMd(item.skillName, item.activeInstructions)
  } catch {
    // Stored text opens with a fence but violates the format — wrap it whole.
    md = serializeSkillMd({
      name: skillMdNameOf(item.skillName),
      description: `Instructions for the ${item.skillName} skill.`.replace(/[<>]/g, ''),
      body: item.activeInstructions
    })
  }
  return { md, name: parseSkillMd(md).name }
}

export function createSkillImprovementAgent(deps: SkillAgentDeps): SkillImprovementAgent {
  const lifecycleDeps: SkillLifecycleDeps = {
    engine: deps.engine,
    db: deps.db,
    audit: deps.audit,
    embedder: deps.embedder
  }

  const steps: readonly WorkflowStep[] = [
    {
      name: 'plan',
      async run(state): Promise<JsonObject> {
        const input = state as unknown as ImprovementInput
        const plan = await planImprovementRun({
          engine: deps.engine,
          db: deps.db,
          mode: input.mode,
          skillId: input.skillId
        })
        return { plan } as unknown as JsonObject
      }
    },
    {
      name: 'testset',
      async run(state, ctx): Promise<JsonObject> {
        const plan = state['plan'] as PlanState
        // Bind the cloud role for THIS run (ctx.jobId is the budget/trace key).
        const cloud = cloudCallFor(deps, 'skills.testset', ctx.jobId)
        const testsets: SkillTestSet[] = []
        const warnings: string[] = []
        for (const item of plan.work) {
          const baseline = baselineSkillMdOf(item)
          const testset = await buildTestSet({ item, skillMd: baseline.md, cloud })
          testsets.push(testset)
          warnings.push(...testset.warnings)
        }
        return { testsets: { testsets, warnings } satisfies TestsetState } as unknown as JsonObject
      }
    },
    {
      name: 'candidate',
      async run(state, ctx): Promise<JsonObject> {
        const plan = state['plan'] as PlanState
        const cloud = cloudCallFor(deps, 'skills.rewrite', ctx.jobId)
        const candidates: SkillCandidate[] = []
        const warnings: string[] = []
        for (const item of plan.work) {
          if (cloud === null) {
            // No cloud/subscription tier for the rewrite (keyless default resolves
            // local) → skip, exactly as today. DEFAULT == TODAY.
            candidates.push({
              skillId: item.skillId,
              candidateVersionId: '',
              instructions: '',
              error: CLOUD_UNAVAILABLE_ERROR
            })
            continue
          }
          const baseline = baselineSkillMdOf(item)
          const candidate = await generateCandidate({
            item,
            skillMd: baseline.md,
            expectedName: baseline.name,
            cloud
          })
          if (candidate.error !== null) warnings.push(`${item.skillId}: ${candidate.error}`)
          candidates.push(candidate)
        }
        return { candidates: { candidates, warnings } satisfies CandidateState } as unknown as JsonObject
      }
    },
    {
      name: 'benchmark',
      async run(state, ctx): Promise<JsonObject> {
        const plan = state['plan'] as PlanState
        const testsetState = state['testsets'] as TestsetState
        const candidateState = state['candidates'] as CandidateState
        // executor/grader are §11.4 HARD-local (forRole resolves local anyway);
        // comparator is a different tier (or null = unavailable).
        const executor = localReasonerFor(deps, 'skills.executor', ctx.jobId)
        const grader = localReasonerFor(deps, 'skills.grader', ctx.jobId)
        const comparator = cloudCallFor(deps, 'skills.comparator', ctx.jobId)
        const benchmarks: (SkillBenchmark | null)[] = []
        const warnings: string[] = []
        for (const [index, item] of plan.work.entries()) {
          const candidate = candidateState.candidates[index]
          const testset = testsetState.testsets[index]
          if (candidate === undefined || testset === undefined || candidate.error !== null) {
            benchmarks.push(null)
            continue
          }
          const benchmark = await runBenchmark({
            executor,
            grader,
            comparator,
            kind: item.mode,
            testset,
            candidateInstructions: candidate.instructions,
            activeInstructions: item.activeInstructions
          })
          if (benchmark.error !== null) warnings.push(`${item.skillId}: ${benchmark.error}`)
          benchmarks.push(benchmark)
        }
        return { benchmarks: { benchmarks, warnings } satisfies BenchmarkState } as unknown as JsonObject
      }
    },
    {
      name: 'write',
      async run(state, ctx): Promise<JsonObject> {
        const plan = state['plan'] as PlanState
        const testsetState = state['testsets'] as TestsetState
        const candidateState = state['candidates'] as CandidateState
        const benchmarkState = state['benchmarks'] as BenchmarkState
        const result = await performWrite({
          deps,
          lifecycleDeps,
          jobId: ctx.jobId,
          plan,
          testsets: testsetState.testsets,
          candidates: candidateState.candidates,
          benchmarks: benchmarkState.benchmarks,
          stepWarnings: [
            ...plan.warnings,
            ...testsetState.warnings,
            ...candidateState.warnings,
            ...benchmarkState.warnings
          ]
        })
        return { result } as unknown as JsonObject
      }
    }
  ]

  deps.runner.define(SKILL_IMPROVEMENT_WORKFLOW, steps)

  const resultOf = async (jobId: string): Promise<SkillImprovementRunResult> => {
    const job = await deps.runner.getJob(jobId)
    const result = job?.state['result'] as SkillImprovementResult | undefined
    if (result === undefined) {
      throw new Error(`skill-improvement job ${jobId} finished without a result in its state — this is a bug`)
    }
    return { jobId, ...result }
  }

  return {
    async runImprovement(options = {}) {
      const jobId = options.jobId ?? randomUUID()
      const input: ImprovementInput = {
        mode: options.skillId !== undefined && options.skillId !== '' ? 'manual' : 'nightly',
        skillId: options.skillId ?? null
      }
      await deps.runner.run(SKILL_IMPROVEMENT_WORKFLOW, input as unknown as JsonObject, {
        jobId,
        agentId: SKILL_IMPROVEMENT_AGENT_ID
      })
      return resultOf(jobId)
    },
    async resumeImprovement(jobId) {
      await deps.runner.resume(jobId)
      return resultOf(jobId)
    }
  }
}

// ── the write step (all mutations; idempotent, resume-safe) ──────────────────

interface WriteOptions {
  readonly deps: SkillAgentDeps
  readonly lifecycleDeps: SkillLifecycleDeps
  readonly jobId: string
  readonly plan: PlanState
  readonly testsets: readonly SkillTestSet[]
  readonly candidates: readonly SkillCandidate[]
  readonly benchmarks: readonly (SkillBenchmark | null)[]
  readonly stepWarnings: readonly string[]
}

async function performWrite(options: WriteOptions): Promise<SkillImprovementResult> {
  const { deps, lifecycleDeps, plan } = options
  const warnings = [...options.stepWarnings]
  const processed: ProcessedSkill[] = []

  for (const note of plan.skipped) {
    processed.push({
      skillId: note.skillId,
      skillName: note.skillName,
      outcome: note.reason.startsWith('a previous candidate')
        ? 'skipped-pending-review'
        : note.reason.startsWith('deferred')
          ? 'skipped-deferred'
          : 'skipped-no-signal',
      candidateVersionId: null,
      stagedWriteId: null,
      heldoutScore: null,
      regressions: 0,
      note: note.reason
    })
  }

  for (const [index, item] of plan.work.entries()) {
    const candidate = options.candidates[index]
    const benchmark = options.benchmarks[index] ?? null

    if (candidate === undefined || candidate.error !== null) {
      const error = candidate?.error ?? 'candidate step produced no entry (bug)'
      processed.push({
        skillId: item.skillId,
        skillName: item.skillName,
        outcome: error === CLOUD_UNAVAILABLE_ERROR ? 'skipped-no-cloud' : 'failed-candidate',
        candidateVersionId: null,
        stagedWriteId: null,
        heldoutScore: null,
        regressions: 0,
        note: error
      })
      continue // signal kept — last_run_at not advanced
    }
    if (benchmark === null || benchmark.error !== null) {
      processed.push({
        skillId: item.skillId,
        skillName: item.skillName,
        outcome: 'failed-benchmark',
        candidateVersionId: candidate.candidateVersionId,
        stagedWriteId: null,
        heldoutScore: null,
        regressions: 0,
        note: benchmark?.error ?? 'benchmark step produced no entry (bug)'
      })
      continue // signal kept
    }

    const summary = benchmark.summary
    const benchmarkJson = { summary, comparisons: benchmark.comparisons } as unknown as Record<string, unknown>
    const candidateScore =
      summary.kind === 'verifiable'
        ? (summary.heldoutScore?.candidate ?? 0)
        : winRateOf(summary.comparisons ?? { candidateWins: 0, activeWins: 0, ties: 0 })

    if (item.mode === 'verifiable') {
      const adopt = summary.netPositive && summary.zeroRegression
      if (adopt) {
        await recordCandidateVersion(lifecycleDeps, {
          skillId: item.skillId,
          candidateVersionId: candidate.candidateVersionId,
          instructions: candidate.instructions,
          benchmarkScore: candidateScore,
          status: 'candidate'
        })
        await adoptSkillVersion(lifecycleDeps, {
          skillId: item.skillId,
          candidateVersionId: candidate.candidateVersionId,
          instructions: candidate.instructions,
          decidedBy: SKILL_IMPROVEMENT_AGENT_ID
        })
        recordImprovement(deps.db, {
          skillId: item.skillId,
          candidateVersionId: candidate.candidateVersionId,
          predecessorVersionId: item.activeVersionId,
          predecessorInstructions: item.activeInstructions,
          mode: item.mode,
          outcome: 'adopted',
          benchmark: benchmarkJson,
          reason: `net-positive on held-out (${(summary.heldoutScore?.candidate ?? 0).toFixed(2)} vs ${(summary.heldoutScore?.active ?? 0).toFixed(2)}) with zero regressions`,
          jobId: options.jobId,
          adoptedAtIso: new Date().toISOString()
        })
        processed.push({
          skillId: item.skillId,
          skillName: item.skillName,
          outcome: 'adopted',
          candidateVersionId: candidate.candidateVersionId,
          stagedWriteId: null,
          heldoutScore: summary.heldoutScore,
          regressions: 0,
          note: `adopted — candidate ${candidate.candidateVersionId} is now active`
        })
      } else {
        const reason = summary.zeroRegression
          ? `not net-positive on held-out (candidate ${(summary.heldoutScore?.candidate ?? 0).toFixed(2)} vs active ${(summary.heldoutScore?.active ?? 0).toFixed(2)})`
          : `${summary.regressions.length} regression(s) on previously-fixed corrections (${summary.regressions.map((r) => r.correctionId).join(', ')})`
        await recordCandidateVersion(lifecycleDeps, {
          skillId: item.skillId,
          candidateVersionId: candidate.candidateVersionId,
          instructions: candidate.instructions,
          benchmarkScore: candidateScore,
          status: 'retired'
        })
        recordImprovement(deps.db, {
          skillId: item.skillId,
          candidateVersionId: candidate.candidateVersionId,
          predecessorVersionId: item.activeVersionId,
          predecessorInstructions: item.activeInstructions,
          mode: item.mode,
          outcome: 'rejected',
          benchmark: benchmarkJson,
          reason,
          jobId: options.jobId,
          adoptedAtIso: null
        })
        processed.push({
          skillId: item.skillId,
          skillName: item.skillName,
          outcome: 'rejected',
          candidateVersionId: candidate.candidateVersionId,
          stagedWriteId: null,
          heldoutScore: summary.heldoutScore,
          regressions: summary.regressions.length,
          note: `rejected — ${reason}`
        })
      }
    } else {
      // Stylistic (§17): the candidate is recorded, the benchmark ran, and a
      // human gets the one-click approval row — NEVER auto-adopted.
      await recordCandidateVersion(lifecycleDeps, {
        skillId: item.skillId,
        candidateVersionId: candidate.candidateVersionId,
        instructions: candidate.instructions,
        benchmarkScore: candidateScore,
        status: 'candidate'
      })
      const payload: SkillImprovementPayload = {
        skillId: item.skillId,
        skillName: item.skillName,
        mode: item.mode,
        candidateVersionId: candidate.candidateVersionId,
        predecessorVersionId: item.activeVersionId,
        candidateInstructions: candidate.instructions,
        activeInstructions: item.activeInstructions,
        benchmark: summary as unknown as Record<string, unknown>,
        reason: 'stylistic skill — §17 requires one-click human approval before adoption'
      }
      const stagedId = stageSkillImprovement(deps.db, payload)
      recordImprovement(deps.db, {
        skillId: item.skillId,
        candidateVersionId: candidate.candidateVersionId,
        predecessorVersionId: item.activeVersionId,
        predecessorInstructions: item.activeInstructions,
        mode: item.mode,
        outcome: 'staged',
        benchmark: benchmarkJson,
        reason: 'awaiting review-queue approval',
        jobId: options.jobId,
        adoptedAtIso: null
      })
      processed.push({
        skillId: item.skillId,
        skillName: item.skillName,
        outcome: 'staged',
        candidateVersionId: candidate.candidateVersionId,
        stagedWriteId: stagedId,
        heldoutScore: summary.heldoutScore,
        regressions: 0,
        note: `staged for review (${stagedWriteIdOf(candidate.candidateVersionId)}) — blind A/B: candidate ${summary.comparisons?.candidateWins ?? 0} / active ${summary.comparisons?.activeWins ?? 0} / tie ${summary.comparisons?.ties ?? 0}`
      })
    }
    // Signal consumed for this skill — the event gate moves past it.
    markSkillRun(deps.db, item.skillId, plan.runStartedAt)
  }

  // §20 drift watch: apply the plan's findings (flag / auto-revert / clear).
  const drift: DriftApplied[] = []
  for (const finding of plan.drift) {
    if (finding.verdict === 'cleared') {
      markImprovementDrift(deps.db, finding.improvementId, { resolvedAtIso: new Date().toISOString() })
      drift.push({ ...finding, action: 'cleared' })
      continue
    }
    markImprovementDrift(deps.db, finding.improvementId, {
      flaggedAtIso: new Date().toISOString(),
      details: {
        newRate: finding.newRate,
        predecessorRate: finding.predecessorRate,
        usesObserved: finding.usesObserved,
        correctionsObserved: finding.correctionsObserved
      }
    })
    if (finding.autoRevert) {
      // Resume safety: the revert must target EXACTLY the flagged adoption.
      // If it was already rolled back (a re-run write step) or a newer
      // adoption has superseded it, rolling back "the latest standing
      // adoption" would undo the WRONG version — flag only.
      const flagged = getImprovement(deps.db, finding.improvementId)
      const standing = latestStandingAdoption(deps.db, finding.skillId)
      if (flagged === undefined || flagged.rolledBackAt !== null || standing?.id !== finding.improvementId) {
        warnings.push(
          `${finding.skillId}: auto-revert skipped — adoption ${finding.improvementId} is ${flagged?.rolledBackAt !== null && flagged !== undefined ? 'already rolled back' : 'no longer the standing adoption'}; flag stands`
        )
        drift.push({ ...finding, action: 'flagged' })
        continue
      }
      try {
        await rollbackSkillAdoption(lifecycleDeps, {
          skillId: finding.skillId,
          decidedBy: SKILL_IMPROVEMENT_AGENT_ID,
          reason: `drift auto-revert: ${finding.correctionsObserved} correction(s) over ${finding.usesObserved} use(s) (rate ${finding.newRate.toFixed(2)} vs predecessor ${finding.predecessorRate.toFixed(2)})`
        })
        drift.push({ ...finding, action: 'auto-reverted' })
      } catch (err) {
        if (err instanceof SkillImprovementError) {
          // The graph moved under us (e.g. an operator rollback raced) — flag stands.
          warnings.push(`${finding.skillId}: auto-revert skipped — ${err.message}`)
          drift.push({ ...finding, action: 'flagged' })
        } else {
          throw err
        }
      }
    } else {
      drift.push({ ...finding, action: 'flagged' })
    }
  }

  return { mode: plan.mode, processed, drift, warnings }
}

const winRateOf = (c: { candidateWins: number; activeWins: number; ties: number }): number => {
  const total = c.candidateWins + c.activeWins + c.ties
  return total === 0 ? 0 : c.candidateWins / total
}

// ── per-run §11.4 role binding (phase-16b) ───────────────────────────────────

/**
 * A role-bound cloud completion for a §17 cloud-tier role (`skills.testset` /
 * `skills.rewrite` / `skills.comparator`).
 *
 *  - Router present → route through it, but ONLY when the role resolves to a
 *    genuinely non-local tier (cloud-api or subscription). The keyless default
 *    resolves local, so these roles then return `null` and behave as today's
 *    "no cloud tier": DEFAULT == TODAY, and §17's blind comparator never runs on
 *    the same local tier as the executor.
 *  - Router absent → today's metered cloud via `deps.cloud` (or `null`).
 *
 * The router's cloud adapter rides `meteredComplete`, so the §14 $0.50 ceiling
 * wraps every cloud call on both paths automatically.
 */
function cloudCallFor(deps: SkillAgentDeps, role: RoleKey, jobId: string): SkillCloudCall | null {
  const router = deps.router
  if (router !== undefined) {
    if (router.resolve(role).backend === 'local-qwen3') return null
    return async (req) => {
      const res = await router.complete(role, {
        prompt: req.prompt,
        ...(req.system !== undefined ? { system: req.system } : {}),
        ...(req.maxTokens !== undefined ? { maxTokens: req.maxTokens } : {}),
        taskId: jobId
      })
      return { text: res.text }
    }
  }
  const cloud = deps.cloud
  if (cloud) {
    return async (req) => {
      const completion = await meteredComplete(cloud.brain, cloud.meter, jobId, [{ role: 'user', content: req.prompt }], {
        ...(req.system !== undefined ? { system: req.system } : {}),
        ...(req.maxTokens !== undefined ? { maxTokens: req.maxTokens } : {})
      })
      return { text: completion.text }
    }
  }
  return null
}

/**
 * The local `SkillLlm` for a §17 HARD-local role (`skills.executor` /
 * `skills.grader`). Router present → `forRole` (resolves local anyway per §11.4,
 * but honors per-role model overrides + span correlation, and preserves the §7
 * local-×3 volume rule); router absent → today's `deps.llm`.
 */
function localReasonerFor(deps: SkillAgentDeps, role: RoleKey, jobId: string): SkillLlm {
  return deps.router !== undefined ? deps.router.forRole(role, jobId) : deps.llm
}
