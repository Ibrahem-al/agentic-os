/**
 * Pure graph-model helpers for the visualization — no canvas, no React, so the
 * layout-independent logic (adjacency, local-graph BFS, node sizing) is unit
 * testable on its own. ForceGraph consumes these; GraphPanel uses `neighborhood`
 * for its Obsidian-style "local graph" mode.
 */
import type { GraphEdgeDto, GraphNodeDto } from '../../../../shared/ipc'

/** Undirected adjacency: node key → the set of keys it shares an edge with. */
export function buildAdjacency(edges: readonly GraphEdgeDto[]): Map<string, Set<string>> {
  const adj = new Map<string, Set<string>>()
  const link = (a: string, b: string): void => {
    const set = adj.get(a)
    if (set !== undefined) set.add(b)
    else adj.set(a, new Set([b]))
  }
  for (const edge of edges) {
    if (edge.source === edge.target) continue // self-loops add no neighbors
    link(edge.source, edge.target)
    link(edge.target, edge.source)
  }
  return adj
}

/**
 * Keys within `depth` undirected hops of `start` (inclusive of `start`). Depth 1
 * is the node plus its immediate neighbors — Obsidian's default local graph.
 * Returns just `{start}` when the node has no edges.
 */
export function neighborhood(
  start: string,
  adjacency: Map<string, Set<string>>,
  depth: number
): Set<string> {
  const visited = new Set<string>([start])
  let frontier: string[] = [start]
  const maxDepth = Math.max(0, Math.trunc(depth))
  for (let d = 0; d < maxDepth; d++) {
    const next: string[] = []
    for (const key of frontier) {
      const neighbors = adjacency.get(key)
      if (neighbors === undefined) continue
      for (const n of neighbors) {
        if (!visited.has(n)) {
          visited.add(n)
          next.push(n)
        }
      }
    }
    if (next.length === 0) break
    frontier = next
  }
  return visited
}

/**
 * Node render radius (world units) from its degree — a gentle sqrt curve so a
 * hub reads as bigger without a single node dwarfing the field (Obsidian sizes
 * nodes by link count the same way).
 */
export function nodeRadius(degree: number): number {
  return 3 + Math.sqrt(Math.max(0, degree)) * 1.6
}

/** Filter a node/edge set to the given key set (local-graph mode / label filter). */
export function subgraph(
  nodes: readonly GraphNodeDto[],
  edges: readonly GraphEdgeDto[],
  keep: Set<string>
): { nodes: GraphNodeDto[]; edges: GraphEdgeDto[] } {
  return {
    nodes: nodes.filter((n) => keep.has(n.key)),
    edges: edges.filter((e) => keep.has(e.source) && keep.has(e.target))
  }
}
