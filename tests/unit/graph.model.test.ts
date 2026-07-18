/**
 * Pure knowledge-graph helpers (renderer, no canvas): adjacency + local-graph
 * BFS + subgraph crop + node sizing, and the per-label color palette. These back
 * the ForceGraph visualization and GraphPanel's Obsidian-style local view.
 */
import { describe, expect, it } from 'vitest'
import type { GraphEdgeDto, GraphNodeDto } from '../../src/shared/ipc'
import { IPC_NODE_LABELS } from '../../src/shared/ipc'
import { buildAdjacency, neighborhood, nodeRadius, subgraph } from '../../src/renderer/src/ui/graph/model'
import { GRAPH_LABEL_COLOR, colorForLabel, withAlpha } from '../../src/renderer/src/ui/graph/colors'

const edge = (source: string, target: string): GraphEdgeDto => ({ source, target, type: 'DEPENDS_ON' })
const node = (key: string): GraphNodeDto => ({
  key,
  label: 'Knowledge',
  id: key.split(':')[1] ?? key,
  display: key,
  degree: 0
})

// A → B → C → D chain, plus a self-loop on A that must be ignored.
const CHAIN: GraphEdgeDto[] = [edge('K:a', 'K:b'), edge('K:b', 'K:c'), edge('K:c', 'K:d'), edge('K:a', 'K:a')]

describe('buildAdjacency', () => {
  it('is undirected and drops self-loops', () => {
    const adj = buildAdjacency(CHAIN)
    expect([...(adj.get('K:a') ?? [])]).toEqual(['K:b'])
    expect(new Set(adj.get('K:b'))).toEqual(new Set(['K:a', 'K:c']))
    expect(new Set(adj.get('K:c'))).toEqual(new Set(['K:b', 'K:d']))
    expect(adj.get('K:a')?.has('K:a')).toBe(false)
  })
})

describe('neighborhood (local-graph BFS)', () => {
  const adj = buildAdjacency(CHAIN)
  it('depth 1 = the node and its direct neighbors', () => {
    expect(neighborhood('K:a', adj, 1)).toEqual(new Set(['K:a', 'K:b']))
  })
  it('depth grows the frontier one hop at a time', () => {
    expect(neighborhood('K:a', adj, 2)).toEqual(new Set(['K:a', 'K:b', 'K:c']))
    expect(neighborhood('K:a', adj, 3)).toEqual(new Set(['K:a', 'K:b', 'K:c', 'K:d']))
  })
  it('an isolated node returns just itself', () => {
    expect(neighborhood('K:z', new Map(), 2)).toEqual(new Set(['K:z']))
  })
})

describe('subgraph', () => {
  it('keeps only nodes/edges fully inside the key set', () => {
    const nodes = [node('K:a'), node('K:b'), node('K:c')]
    const keep = new Set(['K:a', 'K:b'])
    const out = subgraph(nodes, CHAIN, keep)
    expect(out.nodes.map((n) => n.key)).toEqual(['K:a', 'K:b'])
    // Only the A–B edge survives (self-loop on A stays, B–C is cut).
    expect(out.edges).toEqual([edge('K:a', 'K:b'), edge('K:a', 'K:a')])
  })
})

describe('nodeRadius', () => {
  it('grows with degree but never below the floor', () => {
    expect(nodeRadius(0)).toBeCloseTo(3)
    expect(nodeRadius(-5)).toBeCloseTo(3)
    expect(nodeRadius(4)).toBeGreaterThan(nodeRadius(1))
    expect(nodeRadius(100)).toBeGreaterThan(nodeRadius(4))
  })
})

describe('label colors', () => {
  it('assigns a distinct color to every §18 node label', () => {
    for (const label of IPC_NODE_LABELS) {
      expect(GRAPH_LABEL_COLOR[label]).toMatch(/^oklch\(/)
    }
    const values = IPC_NODE_LABELS.map((l) => GRAPH_LABEL_COLOR[l])
    expect(new Set(values).size).toBe(IPC_NODE_LABELS.length) // all unique
  })
  it('falls back to gray for an unknown label', () => {
    expect(colorForLabel('Nonsense')).toBe('oklch(0.68 0 0)')
    expect(colorForLabel('Session')).toBe(GRAPH_LABEL_COLOR.Session)
  })
  it('withAlpha injects the alpha slot and clamps', () => {
    expect(withAlpha('oklch(0.72 0.14 268)', 0.5)).toBe('oklch(0.72 0.14 268 / 0.5)')
    expect(withAlpha('oklch(0.68 0 0)', 2)).toBe('oklch(0.68 0 0 / 1)')
    expect(withAlpha('oklch(0.68 0 0)', -1)).toBe('oklch(0.68 0 0 / 0)')
  })
})
