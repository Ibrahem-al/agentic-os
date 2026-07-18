/**
 * Knowledge-graph overview read (graph.overview IPC) — the whole §18 graph
 * projected for the Obsidian-style force-directed visualization.
 *
 * Shape: every node as {key, label, id, display, degree} + every edge between
 * the returned nodes as {source, target, type}. Reuses the memory browser's
 * DISPLAY_PROPS projection so a node's `display` is the same human handle the
 * inspector shows, and — like every read here — never selects the embedding
 * vector. Node ids are unique only within a label table, so the graph-wide
 * identity is `${label}:${id}` (edges reference nodes by that key).
 *
 * Bounded like the dedupe scan: at most GRAPH_OVERVIEW_MAX_NODES nodes (the
 * most-recently-updated across all labels win) and GRAPH_OVERVIEW_MAX_EDGES
 * edges; `truncated` is set when the store held more than was returned. Pure
 * read — no driver import, no write.
 */
import type { GraphEdgeDto, GraphNodeDto, GraphOverviewDto, IpcEdgeType, IpcNodeLabel } from '../../shared/ipc'
import { GRAPH_OVERVIEW_MAX_EDGES, GRAPH_OVERVIEW_MAX_NODES } from '../config'
import { NODE_TABLES, REL_TABLES, type StorageEngine } from '../storage'
import { DISPLAY_PROPS, displayOf } from './memory'

/** Graph-wide node identity (ids collide across label tables; this does not). */
const graphKey = (label: string, id: string): string => `${label}:${id}`

/** Engine-decoded timestamp → epoch ms for newest-first sorting (0 when absent/unparseable). */
function updatedMs(value: unknown): number {
  if (value instanceof Date) return value.getTime()
  if (typeof value === 'string') {
    const parsed = Date.parse(value)
    return Number.isNaN(parsed) ? 0 : parsed
  }
  return 0
}

export interface GraphOverviewArgs {
  /** Node ceiling; clamped to [1, GRAPH_OVERVIEW_MAX_NODES]. Defaults to the max. */
  readonly limit?: number
}

interface CollectedNode {
  readonly key: string
  readonly label: IpcNodeLabel
  readonly id: string
  readonly display: string
  readonly updatedMs: number
}

/** The full graph for the visualization: nodes + edges + truncation bookkeeping. */
export async function graphOverview(
  engine: StorageEngine,
  { limit }: GraphOverviewArgs = {}
): Promise<GraphOverviewDto> {
  const requested = Math.trunc(limit ?? GRAPH_OVERVIEW_MAX_NODES) || GRAPH_OVERVIEW_MAX_NODES
  const cap = Math.min(Math.max(requested, 1), GRAPH_OVERVIEW_MAX_NODES)

  // 1. Nodes: per label, id + display columns + updated_at, newest first, capped.
  const collected: CollectedNode[] = []
  let totalNodes = 0
  for (const spec of NODE_TABLES) {
    const label = spec.label as IpcNodeLabel
    const countRows = await engine.cypher(`MATCH (n:${spec.label}) RETURN count(n) AS c`)
    totalNodes += Number(countRows[0]?.['c'] ?? 0)

    const displayCols = DISPLAY_PROPS[label]
    const select = ['n.id AS id', 'n.updated_at AS updated_at', ...displayCols.map((p) => `n.${p} AS ${p}`)]
    const rows = await engine.cypher(
      `MATCH (n:${spec.label}) RETURN ${select.join(', ')} ORDER BY n.updated_at DESC, n.id LIMIT ${cap}`
    )
    for (const row of rows) {
      const id = String(row['id'] ?? '')
      if (id === '') continue
      collected.push({
        key: graphKey(spec.label, id),
        label,
        id,
        display: displayOf(label, row, id),
        updatedMs: updatedMs(row['updated_at'])
      })
    }
  }

  // Global newest-first cap across labels (each label was capped, so this trims
  // the union down to the single graph-wide ceiling).
  collected.sort((a, b) => b.updatedMs - a.updatedMs)
  const kept = collected.length > cap ? collected.slice(0, cap) : collected
  const includedKeys = new Set(kept.map((n) => n.key))
  const degree = new Map<string, number>()

  // 2. Edges between included nodes only, bounded by the edge cap.
  const edges: GraphEdgeDto[] = []
  let edgeTruncated = false
  outer: for (const rel of REL_TABLES) {
    for (const [from, to] of rel.pairs) {
      const rows = await engine.cypher(
        `MATCH (n:${from})-[:${rel.type}]->(m:${to}) RETURN n.id AS s, m.id AS t LIMIT ${GRAPH_OVERVIEW_MAX_EDGES}`
      )
      for (const row of rows) {
        const source = graphKey(from, String(row['s'] ?? ''))
        const target = graphKey(to, String(row['t'] ?? ''))
        if (!includedKeys.has(source) || !includedKeys.has(target)) continue
        if (edges.length >= GRAPH_OVERVIEW_MAX_EDGES) {
          edgeTruncated = true
          break outer
        }
        edges.push({ source, target, type: rel.type as IpcEdgeType })
        degree.set(source, (degree.get(source) ?? 0) + 1)
        degree.set(target, (degree.get(target) ?? 0) + 1)
      }
    }
  }

  const nodes: GraphNodeDto[] = kept.map((n) => ({
    key: n.key,
    label: n.label,
    id: n.id,
    display: n.display,
    degree: degree.get(n.key) ?? 0
  }))

  return { nodes, edges, totalNodes, truncated: totalNodes > kept.length || edgeTruncated }
}
