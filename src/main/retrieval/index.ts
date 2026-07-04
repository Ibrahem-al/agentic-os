/**
 * Retrieval barrel (§2, §15, §18 read path) — the rest of the app imports from
 * here. Not exposed over MCP yet (phase 05) and writes nothing, ever.
 */
export { createRetriever, type Retriever, type RetrieveOptions, type RetrieverDeps } from './loop'
export { rerankAdmissionOrder, runReadPath, type PassOptions, type RetrievalDeps } from './pipeline'
export { searchMemory, type SearchMemoryHit, type SearchMemoryOptions } from './search'
export { parseCriticVerdict, rewriteQuery, scoreBundle, type CriticVerdict } from './critic'
export { estimatingTokenCounter, type TokenCounter } from './tokens'
export {
  candidateKey,
  fuseCandidates,
  mergeCandidate,
  type Candidate,
  type FusedCandidate
} from './fusion'
export type {
  AssembledBundle,
  BudgetGuard,
  BundleItem,
  ConfidenceFlag,
  ContextBundle,
  Embedder,
  FusionSignals,
  HaltReason,
  RerankerLike,
  SmallLlm
} from './types'
