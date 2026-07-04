/**
 * Fusion scoring unit tests: the §20 weights (0.5 vector / 0.2 keyword /
 * 0.3 graph-proximity), per-arm normalization, best-signal merging.
 */
import { describe, expect, it } from 'vitest'
import { RETRIEVAL_FUSION_WEIGHTS, RETRIEVAL_GRAPH_DECAY } from '../../src/main/config'
import { candidateKey, fuseCandidates, mergeCandidate, type Candidate } from '../../src/main/retrieval'

describe('candidateKey', () => {
  it('scopes ids by label (same id under two labels = two candidates)', () => {
    const map = new Map<string, Candidate>()
    mergeCandidate(map, { label: 'Project', id: 'x', vectorDistance: 0.1 })
    mergeCandidate(map, { label: 'Skill', id: 'x', vectorDistance: 0.2 })
    expect(map.size).toBe(2)
    expect(candidateKey('Project', 'x')).not.toBe(candidateKey('Skill', 'x'))
  })
})

describe('mergeCandidate', () => {
  it('keeps the best signal on re-observation: min distance, max fts, min hops', () => {
    const map = new Map<string, Candidate>()
    mergeCandidate(map, { label: 'Knowledge', id: 'k', vectorDistance: 0.4, ftsScore: 2, graphHops: 2 })
    mergeCandidate(map, { label: 'Knowledge', id: 'k', vectorDistance: 0.6, ftsScore: 5, graphHops: 1 })
    const merged = map.get(candidateKey('Knowledge', 'k'))
    expect(merged).toMatchObject({ vectorDistance: 0.4, ftsScore: 5, graphHops: 1 })
  })

  it('fills signals missing from the first observation', () => {
    const map = new Map<string, Candidate>()
    mergeCandidate(map, { label: 'Preference', id: 'p', ftsScore: 3 })
    mergeCandidate(map, { label: 'Preference', id: 'p', vectorDistance: 0.2, graphHops: 1 })
    expect(map.get(candidateKey('Preference', 'p'))).toMatchObject({
      vectorDistance: 0.2,
      ftsScore: 3,
      graphHops: 1
    })
  })
})

describe('fuseCandidates', () => {
  it('applies the §20 weights to normalized signals', () => {
    const [fused] = fuseCandidates([
      { label: 'Knowledge', id: 'k', vectorDistance: 0.2, ftsScore: 10, graphHops: 1 }
    ])
    // vector = 1 − 0.2 = 0.8; keyword = 10/10 = 1; graph = 0.5^1
    const expected =
      RETRIEVAL_FUSION_WEIGHTS.vector * 0.8 +
      RETRIEVAL_FUSION_WEIGHTS.keyword * 1 +
      RETRIEVAL_FUSION_WEIGHTS.graphProximity * RETRIEVAL_GRAPH_DECAY
    expect(fused!.fusedScore).toBeCloseTo(expected, 10)
    expect(fused!.signals).toEqual({ vector: 0.8, keyword: 1, graph: RETRIEVAL_GRAPH_DECAY })
  })

  it('normalizes keyword scores by the max in the candidate set', () => {
    const fused = fuseCandidates([
      { label: 'Knowledge', id: 'hi', ftsScore: 8 },
      { label: 'Knowledge', id: 'lo', ftsScore: 2 }
    ])
    const byId = new Map(fused.map((c) => [c.id, c]))
    expect(byId.get('hi')!.signals.keyword).toBe(1)
    expect(byId.get('lo')!.signals.keyword).toBeCloseTo(0.25, 10)
  })

  it('decays graph proximity per hop and gives absent signals zero', () => {
    const fused = fuseCandidates([
      { label: 'Skill', id: 'seed-linked', graphHops: 1 },
      { label: 'SkillVersion', id: 'two-hops', graphHops: 2 },
      { label: 'Knowledge', id: 'unlinked' }
    ])
    const byId = new Map(fused.map((c) => [c.id, c]))
    expect(byId.get('seed-linked')!.signals).toEqual({ vector: 0, keyword: 0, graph: 0.5 })
    expect(byId.get('two-hops')!.signals.graph).toBeCloseTo(0.25, 10)
    expect(byId.get('unlinked')!.fusedScore).toBe(0)
  })

  it('clamps out-of-range vector similarity (distance > 1 → 0)', () => {
    const [fused] = fuseCandidates([{ label: 'Knowledge', id: 'far', vectorDistance: 1.7 }])
    expect(fused!.signals.vector).toBe(0)
  })

  it('sorts by fused score descending with a stable key tiebreak', () => {
    const fused = fuseCandidates([
      { label: 'Knowledge', id: 'b', ftsScore: 4 },
      { label: 'Knowledge', id: 'a', ftsScore: 4 },
      { label: 'Knowledge', id: 'top', vectorDistance: 0 }
    ])
    expect(fused.map((c) => c.id)).toEqual(['top', 'a', 'b'])
  })
})
