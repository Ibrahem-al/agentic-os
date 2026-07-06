/**
 * Benchmark step (§17 step 3, phase 12): candidate vs active over the test
 * set — multiple runs per case per configuration, scored on held-out cases.
 *
 * Verifiable skills → the ASSERTION GRADER, adapted from the vendored
 * skill-creator grader prompt (docs/reference/skill-creator/agents/grader.md):
 * PASS only on clear, citable evidence of genuine compliance; when uncertain
 * the burden of proof is on the expectation; superficial or coincidental
 * compliance fails; no partial credit per expectation. The grader runs on the
 * LOCAL tier with a schema-constrained verdict (phase-08 finding) and a
 * prompt/rubric separate from the executor (§15's own "local-model critic
 * against a rubric" shape); it grades BOTH configurations symmetrically, so
 * any grader bias cancels in the delta the adoption gate reads.
 *
 * Stylistic skills → the BLIND A/B COMPARATOR, adapted from the vendored
 * comparator prompt (agents/comparator.md): outputs labeled A/B with the
 * assignment alternating per comparison, judged on a content (correctness,
 * completeness, accuracy) + structure (organization, formatting, usability)
 * rubric, decisive — ties rare. Judged by the CLOUD tier: §17 mandates a
 * different model/tier from the (local) executor here.
 *
 * Executions run on the LOCAL tier (§7 budget rule — the cloud is spent on
 * rewriting and judging, not on generating dozens of case outputs).
 */
import { SKILL_BENCHMARK_RUNS, SKILL_COMPARATOR_MAX_TOKENS, SKILL_GENERATION_MAX_TOKENS, SKILL_GRADER_MAX_TOKENS } from '../../config'
import { meteredComplete } from '../../models'
import type {
  BenchmarkConfig,
  BenchmarkSummary,
  CaseRunResult,
  ComparisonResult,
  GradedExpectation,
  RegressionFinding,
  SkillAdoptionMode,
  SkillBenchmark,
  SkillCloud,
  SkillCloudCall,
  SkillLlm,
  SkillTestCase,
  SkillTestSet
} from './types'

// ── executor (local) ─────────────────────────────────────────────────────────

export const EXECUTOR_SYSTEM_MARKER = 'You are an agent executing a skill.'

export function executorSystemPrompt(instructions: string): string {
  return (
    `${EXECUTOR_SYSTEM_MARKER} Follow the skill instructions below exactly as written when responding — ` +
    `they are your operating procedure.\n\n<skill_instructions>\n${instructions}\n</skill_instructions>`
  )
}

// ── grader (local, schema-constrained; adapted from agents/grader.md) ───────

export const GRADER_SYSTEM_PROMPT =
  'You are a strict grader evaluating whether an execution output satisfies one expectation. ' +
  'PASS only when the output clearly demonstrates the expectation is true AND the evidence reflects genuine ' +
  'task compliance, not surface-level or coincidental wording. Cite the specific evidence. ' +
  'FAIL when there is no evidence, when evidence contradicts the expectation, or when the expectation cannot ' +
  'be verified from the output — when uncertain, the burden of proof is on the expectation. No partial credit.'

export const GRADER_FORMAT: Record<string, unknown> = {
  type: 'object',
  properties: {
    passed: { type: 'boolean' },
    evidence: { type: 'string' }
  },
  required: ['passed', 'evidence']
}

export function buildGraderPrompt(casePrompt: string, output: string, expectation: string): string {
  return (
    `Task given to the executor:\n${casePrompt}\n\n` +
    `Executor output:\n<output>\n${output}\n</output>\n\n` +
    `Expectation to evaluate:\n"${expectation}"\n\n` +
    `Does the output genuinely satisfy the expectation?`
  )
}

/** Tolerant verdict parse: unparseable ⇒ FAIL (burden of proof on the expectation). */
export function parseGraderReply(text: string): { passed: boolean; evidence: string } {
  try {
    const parsed: unknown = JSON.parse(text)
    if (parsed !== null && typeof parsed === 'object' && typeof (parsed as { passed?: unknown }).passed === 'boolean') {
      const evidence = (parsed as { evidence?: unknown }).evidence
      return { passed: (parsed as { passed: boolean }).passed, evidence: typeof evidence === 'string' ? evidence : '' }
    }
  } catch {
    // fall through to the regex rescue
  }
  const match = /"passed"\s*:\s*(true|false)/.exec(text)
  if (match !== null) return { passed: match[1] === 'true', evidence: '(rescued from malformed reply)' }
  return { passed: false, evidence: 'grader reply unparseable — failing the expectation (burden of proof)' }
}

// ── comparator (cloud, blind; adapted from agents/comparator.md) ─────────────

export const COMPARATOR_SYSTEM_PROMPT =
  'You are a blind comparator judging which of two outputs better accomplishes a task. You do NOT know which ' +
  'configuration produced which output — judge purely on output quality and task completion. ' +
  'Evaluate each output against a rubric: content (correctness, completeness, accuracy) and structure ' +
  '(organization, formatting, usability), 1-5 per criterion, then compare overall. If expectations are ' +
  'provided, use them as secondary evidence — output quality first. Be decisive: ties should be rare; one ' +
  'output is usually better, even if marginally. ' +
  'Reply with ONLY JSON: {"winner": "A" | "B" | "TIE", "reasoning": "..."}'

export function buildComparatorPrompt(
  casePrompt: string,
  outputA: string,
  outputB: string,
  expectations: readonly string[]
): string {
  const expectationBlock =
    expectations.length > 0 ? `\nExpectations (secondary evidence):\n${expectations.map((e) => `- ${e}`).join('\n')}\n` : ''
  return (
    `The task:\n${casePrompt}\n${expectationBlock}\n` +
    `Output A:\n<output_a>\n${outputA}\n</output_a>\n\n` +
    `Output B:\n<output_b>\n${outputB}\n</output_b>\n\n` +
    `Which output better accomplishes the task?`
  )
}

export function parseComparatorReply(text: string): { winner: 'A' | 'B' | 'TIE' | null; reasoning: string } {
  const jsonMatch = /\{[\s\S]*\}/.exec(text)
  if (jsonMatch !== null) {
    try {
      const parsed: unknown = JSON.parse(jsonMatch[0])
      if (parsed !== null && typeof parsed === 'object') {
        const winner = (parsed as { winner?: unknown }).winner
        const reasoning = (parsed as { reasoning?: unknown }).reasoning
        if (winner === 'A' || winner === 'B' || winner === 'TIE') {
          return { winner, reasoning: typeof reasoning === 'string' ? reasoning : '' }
        }
      }
    } catch {
      // fall through
    }
  }
  const bare = /\b(A|B|TIE)\b/.exec(text.toUpperCase())
  if (bare !== null) return { winner: bare[1] as 'A' | 'B' | 'TIE', reasoning: '(rescued from malformed reply)' }
  return { winner: null, reasoning: 'comparator reply unparseable' }
}

// ── aggregation ──────────────────────────────────────────────────────────────

/** Strict majority of runs (3 runs ⇒ ≥2; even counts need MORE than half). */
export function majorityPass(passRuns: number, runs: number): boolean {
  return passRuns * 2 > runs
}

const meanPassRate = (runs: readonly CaseRunResult[]): number =>
  runs.length === 0 ? 0 : runs.reduce((sum, run) => sum + run.passRate, 0) / runs.length

/**
 * Regression detection (§17 adoption gate): a correction-derived case —
 * either split — that the ACTIVE configuration majority-passes while the
 * CANDIDATE majority-fails is a broken previously-fixed correction.
 */
export function findRegressions(cases: readonly SkillTestCase[], runs: readonly CaseRunResult[]): RegressionFinding[] {
  const findings: RegressionFinding[] = []
  for (const testCase of cases) {
    if (testCase.source !== 'correction' || testCase.correctionId === null) continue
    const caseRuns = (config: BenchmarkConfig): CaseRunResult[] =>
      runs.filter((run) => run.caseId === testCase.id && run.config === config)
    const activeRuns = caseRuns('active')
    const candidateRuns = caseRuns('candidate')
    if (activeRuns.length === 0 || candidateRuns.length === 0) continue
    const activePass = activeRuns.filter((run) => run.passRate === 1).length
    const candidatePass = candidateRuns.filter((run) => run.passRate === 1).length
    if (majorityPass(activePass, activeRuns.length) && !majorityPass(candidatePass, candidateRuns.length)) {
      findings.push({
        caseId: testCase.id,
        correctionId: testCase.correctionId,
        expectation: testCase.expectations[0] ?? '',
        activePassRuns: activePass,
        candidatePassRuns: candidatePass,
        runs: activeRuns.length
      })
    }
  }
  return findings
}

export function summarizeBenchmark(
  kind: SkillAdoptionMode,
  cases: readonly SkillTestCase[],
  runs: readonly CaseRunResult[],
  comparisons: readonly ComparisonResult[],
  extraNotes: readonly string[]
): BenchmarkSummary {
  const heldout = new Set(cases.filter((c) => c.split === 'heldout').map((c) => c.id))
  const train = new Set(cases.filter((c) => c.split === 'train').map((c) => c.id))
  const notes = [...extraNotes]

  if (kind === 'verifiable') {
    const score = (config: BenchmarkConfig, ids: Set<string>): number =>
      meanPassRate(runs.filter((run) => run.config === config && ids.has(run.caseId)))
    const regressions = findRegressions(cases, runs)
    const heldoutScore = { candidate: score('candidate', heldout), active: score('active', heldout) }
    const trainScore = { candidate: score('candidate', train), active: score('active', train) }
    const netPositive = heldoutScore.candidate > heldoutScore.active
    if (!netPositive) {
      notes.push(
        `not net-positive on held-out: candidate ${heldoutScore.candidate.toFixed(2)} vs active ${heldoutScore.active.toFixed(2)}`
      )
    }
    for (const regression of regressions) {
      notes.push(
        `regression on ${regression.correctionId}: active passed ${regression.activePassRuns}/${regression.runs} runs, candidate ${regression.candidatePassRuns}/${regression.runs}`
      )
    }
    return {
      kind,
      runsPerCase: SKILL_BENCHMARK_RUNS,
      trainCases: train.size,
      heldoutCases: heldout.size,
      heldoutScore,
      trainScore,
      comparisons: null,
      regressions,
      netPositive,
      zeroRegression: regressions.length === 0,
      notes
    }
  }

  // Stylistic: held-out blind comparisons; assertions play no gating role —
  // the §17 human approval is the gate, this summary informs it.
  let candidateWins = 0
  let activeWins = 0
  let ties = 0
  let unavailable = 0
  for (const comparison of comparisons) {
    if (comparison.winner === 'candidate') candidateWins += 1
    else if (comparison.winner === 'active') activeWins += 1
    else if (comparison.winner === 'tie') ties += 1
    else unavailable += 1
  }
  if (unavailable > 0) notes.push(`${unavailable} comparison(s) unavailable (judge unreachable or unparseable)`)
  notes.push('stylistic path: the review-queue approval is the adoption gate (§17)')
  return {
    kind,
    runsPerCase: SKILL_BENCHMARK_RUNS,
    trainCases: train.size,
    heldoutCases: heldout.size,
    heldoutScore: null,
    trainScore: null,
    comparisons: { candidateWins, activeWins, ties },
    regressions: [],
    netPositive: candidateWins > activeWins,
    zeroRegression: true,
    notes
  }
}

// ── the step ─────────────────────────────────────────────────────────────────

export interface RunBenchmarkOptions {
  /**
   * The local case executor + assertion grader. Today / direct callers pass one
   * `llm` (both roles run on it). Phase-16b's agent binds them SEPARATELY via
   * the router as `executor`/`grader` (both still §11.4 HARD-local, so they
   * resolve local anyway and the §7 ×3 volume rule is unchanged); when supplied
   * they win over `llm`.
   */
  readonly llm?: SkillLlm
  readonly executor?: SkillLlm
  readonly grader?: SkillLlm
  /**
   * The stylistic blind comparator (§17: a DIFFERENT tier from the local
   * executor). Phase-16b's agent passes a router-bound `skills.comparator` call;
   * direct callers may pass a metered cloud tier via `cloud`. `comparator` wins;
   * `null` = no different tier available → today's "no cloud tier" behavior.
   */
  readonly comparator?: SkillCloudCall | null
  readonly cloud?: (SkillCloud & { taskId: string }) | null
  readonly kind: SkillAdoptionMode
  readonly testset: SkillTestSet
  readonly candidateInstructions: string
  readonly activeInstructions: string
  /** Test seam; defaults to the §-referenced 3 runs per case per config. */
  readonly runsPerCase?: number
}

/** Wrap a raw metered cloud tier as a `SkillCloudCall` (direct-caller path). */
function cloudTierCall(cloud: SkillCloud & { taskId: string }): SkillCloudCall {
  return async (req) => {
    const completion = await meteredComplete(cloud.brain, cloud.meter, cloud.taskId, [{ role: 'user', content: req.prompt }], {
      ...(req.system !== undefined ? { system: req.system } : {}),
      ...(req.maxTokens !== undefined ? { maxTokens: req.maxTokens } : {})
    })
    return { text: completion.text }
  }
}

export async function runBenchmark(options: RunBenchmarkOptions): Promise<SkillBenchmark> {
  const runsPerCase = options.runsPerCase ?? SKILL_BENCHMARK_RUNS
  const notes: string[] = []
  const runs: CaseRunResult[] = []
  const comparisons: ComparisonResult[] = []
  const cases = options.testset.cases

  if (cases.length === 0) {
    return {
      skillId: options.testset.skillId,
      summary: summarizeBenchmark(options.kind, cases, [], [], ['no test cases — nothing to benchmark']),
      runs: [],
      comparisons: [],
      error: 'no test cases'
    }
  }

  // §11.4 role binding (16b): executor/grader are HARD-local; `comparator` is a
  // different tier (or null = unavailable). Direct callers get today's shape via
  // `llm` + `cloud`; the router path passes the bound roles from the agent.
  const executor = options.executor ?? options.llm
  const grader = options.grader ?? options.llm
  if (executor === undefined || grader === undefined) {
    throw new Error('runBenchmark requires `llm` (or both `executor` and `grader`)')
  }
  const comparator: SkillCloudCall | null =
    options.comparator !== undefined ? options.comparator : options.cloud != null ? cloudTierCall(options.cloud) : null

  try {
    for (const testCase of cases) {
      for (const config of ['candidate', 'active'] as const) {
        const instructions = config === 'candidate' ? options.candidateInstructions : options.activeInstructions
        for (let runIndex = 0; runIndex < runsPerCase; runIndex++) {
          const generated = await executor.generate(testCase.prompt, {
            system: executorSystemPrompt(instructions),
            maxTokens: SKILL_GENERATION_MAX_TOKENS
          })
          const output = generated.text
          let graded: GradedExpectation[] = []
          let passRate = 0
          if (options.kind === 'verifiable') {
            graded = []
            for (const expectation of testCase.expectations) {
              const verdictReply = await grader.generate(buildGraderPrompt(testCase.prompt, output, expectation), {
                system: GRADER_SYSTEM_PROMPT,
                maxTokens: SKILL_GRADER_MAX_TOKENS,
                format: GRADER_FORMAT
              })
              const verdict = parseGraderReply(verdictReply.text)
              graded.push({ expectation, passed: verdict.passed, evidence: verdict.evidence })
            }
            passRate = graded.length === 0 ? 0 : graded.filter((g) => g.passed).length / graded.length
          }
          runs.push({ caseId: testCase.id, config, runIndex, output, graded, passRate })
        }
      }
    }
  } catch (err) {
    // The local executor/grader is down — no benchmark, no adoption.
    return {
      skillId: options.testset.skillId,
      summary: summarizeBenchmark(options.kind, cases, [], [], []),
      runs,
      comparisons: [],
      error: `benchmark execution failed: ${err instanceof Error ? err.message : String(err)}`
    }
  }

  if (options.kind === 'stylistic') {
    const heldoutCases = cases.filter((c) => c.split === 'heldout')
    if (comparator === null) {
      notes.push('no cloud tier — blind comparison unavailable; review with the raw outputs')
      for (const [caseIndex, testCase] of heldoutCases.entries()) {
        void caseIndex
        for (let runIndex = 0; runIndex < runsPerCase; runIndex++) {
          comparisons.push({ caseId: testCase.id, runIndex, winner: 'unavailable', reasoning: 'no cloud tier' })
        }
      }
    } else {
      const outputOf = (caseId: string, config: BenchmarkConfig, runIndex: number): string =>
        runs.find((run) => run.caseId === caseId && run.config === config && run.runIndex === runIndex)?.output ?? ''
      let judgeDown = false
      for (const [caseIndex, testCase] of heldoutCases.entries()) {
        for (let runIndex = 0; runIndex < runsPerCase; runIndex++) {
          if (judgeDown) {
            comparisons.push({ caseId: testCase.id, runIndex, winner: 'unavailable', reasoning: 'judge unavailable' })
            continue
          }
          // Blind assignment alternates so neither side owns a label (§17
          // "blind A/B"): candidate is A on even (case+run) parity.
          const candidateIsA = (caseIndex + runIndex) % 2 === 0
          const candidateOutput = outputOf(testCase.id, 'candidate', runIndex)
          const activeOutput = outputOf(testCase.id, 'active', runIndex)
          try {
            const completion = await comparator({
              prompt: buildComparatorPrompt(
                testCase.prompt,
                candidateIsA ? candidateOutput : activeOutput,
                candidateIsA ? activeOutput : candidateOutput,
                testCase.expectations
              ),
              system: COMPARATOR_SYSTEM_PROMPT,
              maxTokens: SKILL_COMPARATOR_MAX_TOKENS
            })
            const verdict = parseComparatorReply(completion.text)
            const winner =
              verdict.winner === 'TIE'
                ? ('tie' as const)
                : verdict.winner === null
                  ? ('unavailable' as const)
                  : (verdict.winner === 'A') === candidateIsA
                    ? ('candidate' as const)
                    : ('active' as const)
            comparisons.push({ caseId: testCase.id, runIndex, winner, reasoning: verdict.reasoning })
          } catch (err) {
            judgeDown = true
            notes.push(`comparator failed: ${err instanceof Error ? err.message : String(err)} — remaining comparisons skipped`)
            comparisons.push({ caseId: testCase.id, runIndex, winner: 'unavailable', reasoning: 'judge call failed' })
          }
        }
      }
    }
  }

  return {
    skillId: options.testset.skillId,
    summary: summarizeBenchmark(options.kind, cases, runs, comparisons, notes),
    runs,
    comparisons,
    error: null
  }
}
