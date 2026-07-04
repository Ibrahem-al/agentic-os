/**
 * Retrieval types (§2, §15, §18 read path).
 *
 * The pipeline depends on models through minimal structural interfaces so the
 * real OllamaClient / Reranker / SpendMeter satisfy them without imports in
 * this direction being load-bearing, and tests can inject deterministic fakes
 * (golden tests must run offline).
 */
import type { NodeLabel } from '../storage'

/** Satisfied by OllamaClient (bge-m3, 1024-dim — the only embedding model). */
export interface Embedder {
  embed(texts: string[]): Promise<number[][]>
}

/** Satisfied by Reranker (in-process int8 ONNX cross-encoder, raw logits). */
export interface RerankerLike {
  rerank(query: string, docs: string[]): Promise<number[]>
}

/** Satisfied by OllamaClient — the LOCAL tier the §15 critic must use. */
export interface SmallLlm {
  generate(
    prompt: string,
    options?: { system?: string; maxTokens?: number; temperature?: number }
  ): Promise<{ text: string }>
}

/** Satisfied by SpendMeter; throws SpendCeilingExceededError at/over ceiling. */
export interface BudgetGuard {
  checkBudget(taskId: string, ceilingUsdOverride?: number): void
}

/** Per-arm normalized sub-scores (0..1) that fed a candidate's fused score. */
export interface FusionSignals {
  readonly vector: number
  readonly keyword: number
  readonly graph: number
}

/** One entry of the assembled context bundle. */
export interface BundleItem {
  readonly id: string
  readonly label: NodeLabel
  /** Rendered node text (what was reranked and what the consumer reads). */
  readonly text: string
  /** Estimated token count of `text` (per-provider estimating counter). */
  readonly tokens: number
  /** Fused hybrid score (0.5 vector / 0.2 keyword / 0.3 graph-proximity). */
  readonly fusedScore: number
  /** Cross-encoder logit (higher = more relevant); null when not reranked. */
  readonly rerankScore: number | null
  readonly signals: FusionSignals
}

/** Output of one §18 read-path pass (before the §15 loop wraps it). */
export interface AssembledBundle {
  /** The query string this pass actually searched with. */
  readonly query: string
  /** Reranked top-N (≤ RETRIEVAL_BUNDLE_TOP_N), trimmed to the token budget. */
  readonly items: BundleItem[]
  /** The global Tag's preferences — always included (§18 read path step 1). */
  readonly globalPreferences: BundleItem[]
  /** Estimated tokens across items + globalPreferences. */
  readonly totalTokens: number
  /**
   * Candidates that competed for the rerank stage (seeds + graph expansion,
   * minus global preferences and text-less nodes).
   */
  readonly candidateCount: number
}

export type ConfidenceFlag = 'high' | 'low'

export type HaltReason =
  | 'passed' // critic score reached the pass threshold
  | 'non-improvement' // §15: stop when an iteration fails to beat the best
  | 'max-iterations' // §15: iteration cap reached
  | 'budget-exceeded' // §14/§15: per-task spend ceiling halted the loop
  | 'loop-error' // a mid-loop model call failed after a bundle existed; best-effort return

/** `retrieve(task, tags?)` result: the best bundle plus loop provenance (§15). */
export interface ContextBundle extends AssembledBundle {
  /** The original task the loop was asked to serve. */
  readonly task: string
  /** high = passed the critic rubric; low = best-effort (§15 flag). */
  readonly confidence: ConfidenceFlag
  /** Read-path passes executed (1..LOOP_MAX_ITERATIONS). */
  readonly iterations: number
  /** Best normalized critic score seen (0..1); null if the critic never ran. */
  readonly criticScore: number | null
  readonly haltReason: HaltReason
  /** Every query tried, in order (task first, then rewrites). */
  readonly queriesTried: string[]
}
