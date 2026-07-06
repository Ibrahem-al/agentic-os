/**
 * retrieve(task, tags?) → ContextBundle: the §18 read path wrapped in the
 * bounded §15 self-correcting loop.
 *
 *   pass → local critic vs rubric → (pass? return : local rewrite → retry)
 *
 * Loop safety (§15): max LOOP_MAX_ITERATIONS passes; stop on non-improvement;
 * the per-task spend budget is consulted every iteration and halts the loop;
 * the best bundle seen is ALWAYS returned, flagged with a confidence value.
 * Everything the loop calls is the local tier — retrieval spends no cloud
 * money itself; the budget consult protects tasks whose ceiling was already
 * consumed elsewhere.
 */
import { LOOP_MAX_ITERATIONS, RETRIEVAL_CRITIC_PASS_SCORE } from '../config'
// TYPE-ONLY (phase 16b): the router is passed in at runtime by boot; we never
// construct it here, so the import is erased and cannot form a runtime cycle
// (models/* imports nothing from retrieval/*).
import type { ProviderRouter } from '../models/provider'
import { rewriteQuery, scoreBundle } from './critic'
import { runReadPath, type PassOptions, type RetrievalDeps } from './pipeline'
import type {
  AssembledBundle,
  BudgetGuard,
  ConfidenceFlag,
  ContextBundle,
  HaltReason,
  SmallLlm
} from './types'

export interface RetrieverDeps extends RetrievalDeps {
  /** The LOCAL small LLM (§15: critic tier ≠ generation tier, never cloud). */
  readonly llm: SmallLlm
  /**
   * Phase-16b: optional ReasoningProvider router. When present, the loop binds
   * the §11.4 `retrieval.critic` / `retrieval.rewrite` roles through it PER
   * retrieve() call instead of using `llm`. Both roles are §11.4 HARD-local, so
   * they ALWAYS resolve to local-qwen3 — behavior is identical to `llm`; the
   * router only future-proofs the seam and threads the run's taskId for span
   * correlation. Absent → today's injected `llm`, unchanged (every existing
   * fake-injecting test keeps injecting `llm`; only boot passes a router).
   */
  readonly router?: ProviderRouter
}

export interface RetrieveOptions {
  readonly tokenBudget?: number
  readonly tokenCounter?: PassOptions['tokenCounter']
  /** Loop cap; default LOOP_MAX_ITERATIONS (§20: 5). */
  readonly maxIterations?: number
  /** Normalized critic score that passes; default RETRIEVAL_CRITIC_PASS_SCORE. */
  readonly passScore?: number
  /** §14 spend guard, consulted every iteration. Requires `taskId`. */
  readonly spendMeter?: BudgetGuard
  readonly taskId?: string
  /** Per-task ceiling override forwarded to the spend guard. */
  readonly ceilingUsd?: number
}

export interface Retriever {
  /** The full loop. First-pass failures propagate; later failures return best-effort. */
  retrieve(task: string, tags?: readonly string[], options?: RetrieveOptions): Promise<ContextBundle>
  /** One read-path pass, no loop (building block; also what latency tests time). */
  singlePass(query: string, options?: PassOptions): Promise<AssembledBundle>
}

export function createRetriever(deps: RetrieverDeps): Retriever {
  const singlePass = (query: string, options: PassOptions = {}): Promise<AssembledBundle> =>
    runReadPath(deps, query, options)

  const retrieve = async (
    task: string,
    tags: readonly string[] = [],
    options: RetrieveOptions = {}
  ): Promise<ContextBundle> => {
    if (task.trim() === '') throw new Error('retrieve: task must be a non-empty string')
    if (options.spendMeter && options.taskId === undefined) {
      throw new Error('retrieve: options.taskId is required when a spendMeter is provided')
    }
    const maxIterations = options.maxIterations ?? LOOP_MAX_ITERATIONS
    if (!Number.isSafeInteger(maxIterations) || maxIterations < 1) {
      throw new Error(`retrieve: maxIterations must be a positive integer, got ${maxIterations}`)
    }
    const passScore = options.passScore ?? RETRIEVAL_CRITIC_PASS_SCORE
    const passOptions: PassOptions = {
      tags,
      ...(options.tokenBudget !== undefined ? { tokenBudget: options.tokenBudget } : {}),
      ...(options.tokenCounter !== undefined ? { tokenCounter: options.tokenCounter } : {})
    }

    // Phase-16b: bind the two §11.4 retrieval roles for THIS run. Both are
    // HARD-local, so with a router they still resolve to local-qwen3 — identical
    // behavior to the injected `llm`; this only routes through the seam and
    // threads the live taskId (already 'live:<sessionId>' from phase-15's budget
    // wiring; span-correlation only for a free local role). No router → `llm`.
    const roleTaskId = options.taskId ?? 'live:unknown'
    const critic: SmallLlm = deps.router ? deps.router.forRole('retrieval.critic', roleTaskId) : deps.llm
    const rewriter: SmallLlm = deps.router ? deps.router.forRole('retrieval.rewrite', roleTaskId) : deps.llm

    const queriesTried: string[] = []
    let best: AssembledBundle | null = null
    let bestScore = Number.NEGATIVE_INFINITY
    let criticScore: number | null = null
    let iterations = 0
    let confidence: ConfidenceFlag = 'low'
    let haltReason: HaltReason = 'max-iterations'
    let query = task

    const budgetExceeded = (): boolean => {
      if (!options.spendMeter) return false
      try {
        options.spendMeter.checkBudget(options.taskId as string, options.ceilingUsd)
        return false
      } catch {
        return true
      }
    }

    for (;;) {
      // §14/§15: the per-task budget is consulted every iteration.
      if (budgetExceeded()) {
        haltReason = 'budget-exceeded'
        if (best === null) {
          // Best-effort even here: one pass is pure local reads and costs $0;
          // only the (equally free, but pointless once halted) critic/rewrite
          // iteration is skipped. Rule-12 choice, recorded in the report.
          queriesTried.push(query)
          iterations += 1
          best = await singlePass(query, passOptions)
        }
        break
      }

      queriesTried.push(query)
      iterations += 1
      let bundle: AssembledBundle
      if (best === null) {
        bundle = await singlePass(query, passOptions) // first pass: errors propagate
      } else {
        try {
          bundle = await singlePass(query, passOptions)
        } catch {
          haltReason = 'loop-error'
          break
        }
      }

      let verdictScore: number
      let verdictFeedback: string
      try {
        const verdict = await scoreBundle(critic, task, bundle)
        verdictScore = verdict.score
        verdictFeedback = verdict.feedback
      } catch {
        // Critic unavailable: keep the best judged bundle, or this one if none.
        best ??= bundle
        haltReason = 'loop-error'
        break
      }

      const improved = verdictScore > bestScore
      if (improved) {
        best = bundle
        bestScore = verdictScore
      }
      criticScore = bestScore

      if (verdictScore >= passScore) {
        confidence = 'high'
        haltReason = 'passed'
        break
      }
      if (iterations >= maxIterations) {
        haltReason = 'max-iterations'
        break
      }
      if (!improved) {
        haltReason = 'non-improvement'
        break
      }

      let next: string | null
      try {
        next = await rewriteQuery(rewriter, task, verdictFeedback, queriesTried)
      } catch {
        haltReason = 'loop-error'
        break
      }
      if (next === null) {
        // The rewriter produced nothing new to try — no path to improvement.
        haltReason = 'non-improvement'
        break
      }
      query = next
    }

    // `best` is set on every halt path above.
    const finalBundle = best as AssembledBundle
    return {
      ...finalBundle,
      task,
      confidence,
      iterations,
      criticScore,
      haltReason,
      queriesTried
    }
  }

  return { retrieve, singlePass }
}
