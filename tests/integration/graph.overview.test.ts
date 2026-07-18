/**
 * graph.overview read over the REAL engine — the payload behind the Obsidian-
 * style knowledge-graph visualization. Seeds the full fixture (all 13 §18 node
 * labels + all 15 edge types) and checks the projection: graph-wide keys,
 * human display handles (no embeddings), edge endpoints that resolve, degree
 * that matches the edges, and the newest-first node cap + truncation flag.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { graphOverview } from '../../src/main/reads'
import { FIXTURE_EDGES, FIXTURE_NODES, seedFixtureGraph } from '../fixtures/graph-seed'
import { openTestStore, type TestStore } from './helpers'

let store: TestStore

beforeAll(async () => {
  store = await openTestStore()
  await seedFixtureGraph(store.engine)
})

afterAll(async () => {
  await store.cleanup()
})

describe('graphOverview', () => {
  it('returns every node with a graph-wide key + a human display, no truncation', async () => {
    const graph = await graphOverview(store.engine)

    expect(graph.totalNodes).toBe(FIXTURE_NODES.length)
    expect(graph.nodes.length).toBe(FIXTURE_NODES.length)
    expect(graph.truncated).toBe(false)

    for (const n of graph.nodes) {
      expect(n.key).toBe(`${n.label}:${n.id}`)
      expect(n.id).not.toBe('')
      expect(n.display.length).toBeGreaterThan(0)
      // The embedding vector must never cross into the visualization payload.
      expect(Object.keys(n)).not.toContain('embedding')
    }
    // Keys are unique across the whole graph.
    expect(new Set(graph.nodes.map((n) => n.key)).size).toBe(graph.nodes.length)
  })

  it('returns every stored edge, both endpoints resolvable, degree matching', async () => {
    const graph = await graphOverview(store.engine)
    const keys = new Set(graph.nodes.map((n) => n.key))

    expect(graph.edges.length).toBe(FIXTURE_EDGES.length)
    for (const e of graph.edges) {
      expect(keys.has(e.source)).toBe(true)
      expect(keys.has(e.target)).toBe(true)
    }

    // Each edge contributes +1 to its source and +1 to its target degree.
    const degreeSum = graph.nodes.reduce((sum, n) => sum + n.degree, 0)
    expect(degreeSum).toBe(graph.edges.length * 2)

    // A hub (a node that actually has edges) reports a positive degree.
    expect(graph.nodes.some((n) => n.degree > 0)).toBe(true)
  })

  it('caps to the newest N nodes and flags truncation, keeping edges within the kept set', async () => {
    const graph = await graphOverview(store.engine, { limit: 5 })

    expect(graph.nodes.length).toBe(5)
    expect(graph.totalNodes).toBe(FIXTURE_NODES.length)
    expect(graph.truncated).toBe(true)

    const keys = new Set(graph.nodes.map((n) => n.key))
    for (const e of graph.edges) {
      expect(keys.has(e.source)).toBe(true)
      expect(keys.has(e.target)).toBe(true)
    }
  })
})
