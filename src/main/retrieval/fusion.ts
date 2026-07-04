/**
 * Fusion scoring (§18 read path step 3): vector + keyword + graph-proximity
 * sub-scores normalized to 0..1 and combined with the §20 weights
 * (0.5 / 0.2 / 0.3). Pure functions — unit-tested without a graph.
 *
 * Normalization (rule-12 choices, recorded in the phase report):
 * - vector: cosine similarity = 1 − distance, clamped to [0, 1] (the HNSW
 *   index metric is cosine distance; BGE-M3 similarities live in [0, 1] in
 *   practice, and absolute similarity is meaningful, so no re-scaling).
 * - keyword: BM25-style FTS scores are unbounded → divided by the maximum
 *   score in the current candidate set.
 * - graph: decay^hops from the nearest seed hit (seed = hop 0 = 1.0).
 */
import { RETRIEVAL_FUSION_WEIGHTS, RETRIEVAL_GRAPH_DECAY } from '../config'
import type { NodeLabel } from '../storage'
import type { FusionSignals } from './types'

/** A retrieval candidate accumulated across the two search arms + expansion. */
export interface Candidate {
  readonly label: NodeLabel
  readonly id: string
  /** Best (smallest) cosine distance from the vector arm, if it hit. */
  vectorDistance?: number
  /** Best (largest) FTS score from the keyword arm, if it hit. */
  ftsScore?: number
  /** Minimum hop count from any seed hit (0 = the node is itself a seed). */
  graphHops?: number
}

/** Candidates are keyed by label+id — ids are only unique per label. */
export function candidateKey(label: NodeLabel, id: string): string {
  return `${label}:${id}`
}

export interface FusedCandidate extends Candidate {
  readonly fusedScore: number
  readonly signals: FusionSignals
}

/** Merge a new observation of a node into the candidate map (best-signal-wins). */
export function mergeCandidate(
  into: Map<string, Candidate>,
  next: Candidate
): void {
  const key = candidateKey(next.label, next.id)
  const existing = into.get(key)
  if (!existing) {
    into.set(key, { ...next })
    return
  }
  if (next.vectorDistance !== undefined) {
    existing.vectorDistance =
      existing.vectorDistance === undefined
        ? next.vectorDistance
        : Math.min(existing.vectorDistance, next.vectorDistance)
  }
  if (next.ftsScore !== undefined) {
    existing.ftsScore =
      existing.ftsScore === undefined ? next.ftsScore : Math.max(existing.ftsScore, next.ftsScore)
  }
  if (next.graphHops !== undefined) {
    existing.graphHops =
      existing.graphHops === undefined ? next.graphHops : Math.min(existing.graphHops, next.graphHops)
  }
}

function clamp01(value: number): number {
  if (value < 0) return 0
  if (value > 1) return 1
  return value
}

/** Fuse all candidates; returns them sorted by fused score (desc), stable by key. */
export function fuseCandidates(candidates: Iterable<Candidate>): FusedCandidate[] {
  const list = [...candidates]
  let maxFts = 0
  for (const c of list) {
    if (c.ftsScore !== undefined && c.ftsScore > maxFts) maxFts = c.ftsScore
  }
  const fused = list.map((c): FusedCandidate => {
    const vector = c.vectorDistance === undefined ? 0 : clamp01(1 - c.vectorDistance)
    const keyword = c.ftsScore === undefined || maxFts <= 0 ? 0 : clamp01(c.ftsScore / maxFts)
    const graph = c.graphHops === undefined ? 0 : RETRIEVAL_GRAPH_DECAY ** c.graphHops
    const signals: FusionSignals = { vector, keyword, graph }
    const fusedScore =
      RETRIEVAL_FUSION_WEIGHTS.vector * vector +
      RETRIEVAL_FUSION_WEIGHTS.keyword * keyword +
      RETRIEVAL_FUSION_WEIGHTS.graphProximity * graph
    return { ...c, fusedScore, signals }
  })
  fused.sort(
    (a, b) =>
      b.fusedScore - a.fusedScore || candidateKey(a.label, a.id).localeCompare(candidateKey(b.label, b.id))
  )
  return fused
}
