/**
 * search_memory (§12): direct hybrid search over the retrievable nodes — the
 * two search arms + fusion + rerank of the §18 read path, with NO graph
 * expansion, NO global-preference section, NO token budget, and NO §15 loop.
 * §2 defines hybrid retrieval as "fused, then reranked", so the cross-encoder
 * stays; everything loop/bundle-shaped is get_context's job.
 *
 * Read-only, like the whole retrieval module: never touches the write lane.
 */
import {
  RETRIEVAL_FTS_TOP_K,
  RETRIEVAL_RERANK_TOP_K,
  RETRIEVAL_VECTOR_TOP_K,
  SEARCH_MEMORY_DEFAULT_K,
  SEARCH_MEMORY_MAX_K
} from '../config'
import { RETRIEVABLE_LABELS, type RetrievableLabel } from '../storage'
import { candidateKey, fuseCandidates, mergeCandidate, type Candidate } from './fusion'
import { ftsQueryOf, type RetrievalDeps } from './pipeline'
import { fetchNodeTexts } from './render'
import type { FusionSignals } from './types'

export interface SearchMemoryOptions {
  /** Labels to search; default all four retrievable labels. */
  readonly labels?: readonly string[]
  /** Result count; default SEARCH_MEMORY_DEFAULT_K, max SEARCH_MEMORY_MAX_K. */
  readonly k?: number
}

/** One direct-search hit (highest rerank score first). */
export interface SearchMemoryHit {
  readonly id: string
  readonly label: RetrievableLabel
  /** Rendered node text (same rendering the read path bundles). */
  readonly text: string
  /** Cross-encoder logit (higher = more relevant). */
  readonly rerankScore: number
  /** Fused hybrid score (graph arm is 0 — no expansion in direct search). */
  readonly fusedScore: number
  readonly signals: FusionSignals
}

function parseLabels(labels: readonly string[] | undefined): readonly RetrievableLabel[] {
  if (labels === undefined || labels.length === 0) return RETRIEVABLE_LABELS
  const seen = new Set<RetrievableLabel>()
  for (const label of labels) {
    const match = RETRIEVABLE_LABELS.find((l) => l === label)
    if (!match) {
      throw new Error(
        `searchMemory: unknown label '${label}' — retrievable labels are ${RETRIEVABLE_LABELS.join(', ')}`
      )
    }
    seen.add(match)
  }
  return [...seen]
}

/** Run one direct hybrid search for `query`, returning the top-k hits. */
export async function searchMemory(
  deps: RetrievalDeps,
  query: string,
  options: SearchMemoryOptions = {}
): Promise<SearchMemoryHit[]> {
  const { engine, embedder, reranker } = deps
  if (query.trim() === '') throw new Error('searchMemory: query must be a non-empty string')
  const labels = parseLabels(options.labels)
  const k = options.k ?? SEARCH_MEMORY_DEFAULT_K
  if (!Number.isSafeInteger(k) || k < 1 || k > SEARCH_MEMORY_MAX_K) {
    throw new Error(`searchMemory: k must be an integer in 1..${SEARCH_MEMORY_MAX_K}, got ${k}`)
  }

  // The two search arms, exactly as in the read path (§20: vector top-30 per
  // label, FTS overall top-30) but restricted to the requested labels.
  const [queryEmbedding] = await embedder.embed([query])
  if (!queryEmbedding) throw new Error('embedder returned no embedding for the query')
  const ftsQuery = ftsQueryOf(query)
  const [vectorHitsPerLabel, textHitsPerLabel] = await Promise.all([
    Promise.all(labels.map((label) => engine.vectorSearch(label, queryEmbedding, RETRIEVAL_VECTOR_TOP_K))),
    Promise.all(
      labels.map((label) =>
        ftsQuery === '' ? Promise.resolve([]) : engine.textSearch(label, ftsQuery, RETRIEVAL_FTS_TOP_K)
      )
    )
  ])

  const candidates = new Map<string, Candidate>()
  for (const [i, label] of labels.entries()) {
    for (const hit of vectorHitsPerLabel[i] ?? []) {
      mergeCandidate(candidates, { label, id: hit.id, vectorDistance: hit.distance })
    }
  }
  const ftsOverall = labels
    .flatMap((label, i) => (textHitsPerLabel[i] ?? []).map((hit) => ({ label, id: hit.id, score: hit.score })))
    .sort((a, b) => b.score - a.score || candidateKey(a.label, a.id).localeCompare(candidateKey(b.label, b.id)))
    .slice(0, RETRIEVAL_FTS_TOP_K)
  for (const hit of ftsOverall) {
    mergeCandidate(candidates, { label: hit.label, id: hit.id, ftsScore: hit.score })
  }

  // Fuse (graph arm is structurally 0 — nothing sets graphHops here), render
  // texts, rerank the fused head once, return the top-k.
  const fused = fuseCandidates(candidates.values())
  const texts = await fetchNodeTexts(
    engine,
    fused.map((c) => ({ label: c.label as RetrievableLabel, id: c.id }))
  )
  const rerankPool = fused
    .filter((c) => (texts.get(candidateKey(c.label, c.id)) ?? '') !== '')
    .slice(0, RETRIEVAL_RERANK_TOP_K)
  const scores = await reranker.rerank(
    query,
    rerankPool.map((c) => texts.get(candidateKey(c.label, c.id)) as string)
  )
  if (scores.length !== rerankPool.length) {
    throw new Error(`reranker returned ${scores.length} scores for ${rerankPool.length} docs`)
  }
  return rerankPool
    .map((c, i) => ({ candidate: c, rerankScore: scores[i] as number }))
    .sort(
      (a, b) =>
        b.rerankScore - a.rerankScore ||
        b.candidate.fusedScore - a.candidate.fusedScore ||
        candidateKey(a.candidate.label, a.candidate.id).localeCompare(candidateKey(b.candidate.label, b.candidate.id))
    )
    .slice(0, k)
    .map(({ candidate, rerankScore }) => ({
      id: candidate.id,
      label: candidate.label as RetrievableLabel,
      text: texts.get(candidateKey(candidate.label, candidate.id)) as string,
      rerankScore,
      fusedScore: candidate.fusedScore,
      signals: candidate.signals
    }))
}
