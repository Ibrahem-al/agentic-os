/**
 * The §18 read path, one pass:
 *
 *   embed query (BGE-M3) → in parallel: vector top-30 per retrievable label +
 *   FTS top-30 → graph expansion (§18 step 2) → fusion (0.5 vector /
 *   0.2 keyword / 0.3 graph-proximity) → in-process ONNX rerank → top-8 →
 *   bundle assembled within the token budget, global-tag preferences always
 *   included.
 *
 * No writes anywhere in this path (§21 / phase doc): reads go straight to the
 * engine's read connection and the write lane stays untouched.
 */
import {
  RETRIEVAL_BUNDLE_TOKEN_BUDGET,
  RETRIEVAL_BUNDLE_TOP_N,
  RETRIEVAL_FTS_TOP_K,
  RETRIEVAL_RERANK_TOP_K,
  RETRIEVAL_VECTOR_TOP_K
} from '../config'
import { RETRIEVABLE_LABELS, type StorageEngine } from '../storage'
import { expandGraph } from './expand'
import { candidateKey, fuseCandidates, mergeCandidate, type Candidate } from './fusion'
import { fetchNodeTexts, isCandidateLabel, type CandidateLabel } from './render'
import { estimatingTokenCounter, type TokenCounter } from './tokens'
import type { AssembledBundle, BundleItem, Embedder, RerankerLike } from './types'

export interface RetrievalDeps {
  readonly engine: StorageEngine
  readonly embedder: Embedder
  readonly reranker: RerankerLike
}

export interface PassOptions {
  /** Tag names to match explicitly (the `tags?` of retrieve(task, tags?)). */
  readonly tags?: readonly string[]
  /** Bundle token budget; default RETRIEVAL_BUNDLE_TOKEN_BUDGET. */
  readonly tokenBudget?: number
  /** Token counter; default = estimating counter for the default provider. */
  readonly tokenCounter?: TokenCounter
}

/**
 * FTS treats most punctuation as noise and its tokenizer strips digits
 * (phase-01 finding 8); feed it plain word characters only. Shared with
 * search.ts (the §12 search_memory arm).
 */
export function ftsQueryOf(query: string): string {
  return query
    .replace(/[^\p{L}\p{N}\s]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

const ZERO_SIGNALS = { vector: 0, keyword: 0, graph: 0 } as const

/** Run one full read-path pass for `query`. */
export async function runReadPath(
  deps: RetrievalDeps,
  query: string,
  options: PassOptions = {}
): Promise<AssembledBundle> {
  const { engine, embedder, reranker } = deps

  // 1. Embed the query, then the two search arms in parallel over the four
  //    retrievable labels (§20: vector top-30 per label + FTS top-30 overall).
  const [queryEmbedding] = await embedder.embed([query])
  if (!queryEmbedding) throw new Error('embedder returned no embedding for the query')
  const ftsQuery = ftsQueryOf(query)
  const [vectorHitsPerLabel, textHitsPerLabel] = await Promise.all([
    Promise.all(
      RETRIEVABLE_LABELS.map((label) => engine.vectorSearch(label, queryEmbedding, RETRIEVAL_VECTOR_TOP_K))
    ),
    Promise.all(
      RETRIEVABLE_LABELS.map((label) =>
        ftsQuery === '' ? Promise.resolve([]) : engine.textSearch(label, ftsQuery, RETRIEVAL_FTS_TOP_K)
      )
    )
  ])

  // 2. Seed candidates. FTS scores are comparable enough across the four
  //    per-label result lists to take a single overall top-30 (§20 wording:
  //    "FTS top-30" vs vector's explicit "per label" — recorded in the report).
  const candidates = new Map<string, Candidate>()
  for (const [i, label] of RETRIEVABLE_LABELS.entries()) {
    for (const hit of vectorHitsPerLabel[i] ?? []) {
      mergeCandidate(candidates, { label, id: hit.id, vectorDistance: hit.distance })
    }
  }
  const ftsOverall = RETRIEVABLE_LABELS.flatMap((label, i) =>
    (textHitsPerLabel[i] ?? []).map((hit) => ({ label, id: hit.id, score: hit.score }))
  )
    .sort((a, b) => b.score - a.score || candidateKey(a.label, a.id).localeCompare(candidateKey(b.label, b.id)))
    .slice(0, RETRIEVAL_FTS_TOP_K)
  for (const hit of ftsOverall) {
    mergeCandidate(candidates, { label: hit.label, id: hit.id, ftsScore: hit.score })
  }

  // 3. Graph expansion (§18 step 2) + the always-included global preferences.
  const expansion = await expandGraph(engine, candidates, options.tags ?? [])

  // 4. Fetch + render candidate texts (global preferences included).
  const refs: { label: CandidateLabel; id: string }[] = []
  for (const c of candidates.values()) {
    if (isCandidateLabel(c.label)) refs.push({ label: c.label, id: c.id })
  }
  for (const id of expansion.globalPreferenceIds) refs.push({ label: 'Preference', id })
  const texts = await fetchNodeTexts(engine, refs)

  // 5. Fuse; global preferences ride their own bundle section, so they do not
  //    compete for the top-8 item slots.
  const fusedAll = fuseCandidates(candidates.values())
  const globalPrefKeys = new Set(expansion.globalPreferenceIds.map((id) => candidateKey('Preference', id)))
  const fused = fusedAll.filter((c) => {
    const key = candidateKey(c.label, c.id)
    return !globalPrefKeys.has(key) && (texts.get(key) ?? '') !== ''
  })

  // 6. Rerank the fused head once (cross-encoder logits, higher = better).
  const rerankPool = fused.slice(0, RETRIEVAL_RERANK_TOP_K)
  const scores = await reranker.rerank(
    query,
    rerankPool.map((c) => texts.get(candidateKey(c.label, c.id)) as string)
  )
  if (scores.length !== rerankPool.length) {
    throw new Error(`reranker returned ${scores.length} scores for ${rerankPool.length} docs`)
  }
  const reranked = rerankPool
    .map((c, i) => ({ candidate: c, rerankScore: scores[i] as number }))
    .sort(
      (a, b) =>
        b.rerankScore - a.rerankScore ||
        b.candidate.fusedScore - a.candidate.fusedScore ||
        candidateKey(a.candidate.label, a.candidate.id).localeCompare(
          candidateKey(b.candidate.label, b.candidate.id)
        )
    )
    .slice(0, RETRIEVAL_BUNDLE_TOP_N)

  // 7. Assemble within the token budget. Global preferences are mandatory
  //    (§18 step 1) and enter first; the reranked top-8 then fill the rest in
  //    rank order, skipping items that no longer fit.
  const counter = options.tokenCounter ?? estimatingTokenCounter()
  const budget = options.tokenBudget ?? RETRIEVAL_BUNDLE_TOKEN_BUDGET
  const fusedByKey = new Map(fusedAll.map((c) => [candidateKey(c.label, c.id), c]))

  let totalTokens = 0
  const globalPreferences: BundleItem[] = []
  for (const id of expansion.globalPreferenceIds) {
    const key = candidateKey('Preference', id)
    const text = texts.get(key) ?? ''
    if (text === '') continue
    const tokens = counter.count(text)
    const asCandidate = fusedByKey.get(key)
    globalPreferences.push({
      id,
      label: 'Preference',
      text,
      tokens,
      fusedScore: asCandidate?.fusedScore ?? 0,
      rerankScore: null,
      signals: asCandidate?.signals ?? ZERO_SIGNALS
    })
    totalTokens += tokens
  }

  const items: BundleItem[] = []
  for (const { candidate, rerankScore } of reranked) {
    const text = texts.get(candidateKey(candidate.label, candidate.id)) as string
    const tokens = counter.count(text)
    if (totalTokens + tokens > budget) continue
    items.push({
      id: candidate.id,
      label: candidate.label,
      text,
      tokens,
      fusedScore: candidate.fusedScore,
      rerankScore,
      signals: candidate.signals
    })
    totalTokens += tokens
  }

  return { query, items, globalPreferences, totalTokens, candidateCount: fused.length }
}
