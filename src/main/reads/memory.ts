/**
 * Memory-browser reads (§4.C) — the shared source for the dashboard's
 * `memory.counts` / `memory.list` / `memory.node` IPC handlers AND the
 * `memory_counts` / `list_nodes` / `get_node` MCP read tools.
 *
 * Extracted verbatim from `ipc.ts` (helpers moved in wholesale) so the phase-15
 * DRY refactor is behavior-identical: same DISPLAY_PROPS projection, same
 * inspector columns, and — critically — the node embedding vector is NEVER
 * shipped (inspectableColumns omits it).
 */
import { IPC_NODE_LABELS, type IpcNodeLabel, type JsonObject, type LabelCountDto, type MemoryEdgeDto, type MemoryNodeDetailDto, type MemoryNodeSummaryDto } from '../../shared/ipc'
import { IngestError } from '../ingest'
import { NODE_TABLES, REL_TABLES, nodeTable, type NodeLabel, type StorageEngine } from '../storage'
import { jsonObject, jsonify } from './serialize'

/** The property that names a node in lists (label-specific, schema-backed). */
export const DISPLAY_PROPS: Readonly<Record<IpcNodeLabel, readonly string[]>> = {
  Session: ['transcript_ref'],
  Project: ['name'],
  Skill: ['name'],
  SkillVersion: ['status'],
  Example: ['kind', 'content'],
  Correction: ['content'],
  Preference: ['statement'],
  MCP: ['name'],
  Plugin: ['name'],
  Component: ['name'],
  Document: ['source'],
  Knowledge: ['content'],
  Tag: ['name']
}

export const truncate = (text: string, max = 140): string =>
  text.length > max ? `${text.slice(0, max - 1)}…` : text

export const displayOf = (label: IpcNodeLabel, row: Record<string, unknown>, id: string): string => {
  const parts = DISPLAY_PROPS[label]
    .map((prop) => row[prop])
    .filter((v): v is string => typeof v === 'string' && v !== '')
  return parts.length > 0 ? truncate(parts.join(' · ').replace(/\s+/g, ' ')) : id
}

export const assertLabel = (label: string): IpcNodeLabel => {
  if (!(IPC_NODE_LABELS as readonly string[]).includes(label)) {
    throw new IngestError('INVALID_INPUT', `unknown node label '${label}'`)
  }
  return label as IpcNodeLabel
}

/** Node columns worth shipping to the inspector (embedding never crosses). */
export const inspectableColumns = (label: NodeLabel): string[] => {
  const spec = nodeTable(label)
  const cols = ['id', ...spec.properties.map((p) => p.name)]
  if (spec.provenance) cols.push('extracted_by', 'confidence')
  cols.push('created_at', 'updated_at')
  return cols
}

const edgeDto = (
  type: string,
  direction: 'out' | 'in',
  label: IpcNodeLabel,
  row: Record<string, unknown>
): MemoryEdgeDto => {
  const id = String(row['id'] ?? '')
  const props: JsonObject = {}
  for (const [key, value] of Object.entries(row)) {
    if (key.startsWith('r_') && value !== null && value !== undefined) {
      props[key.slice(2)] = jsonify(value)
    }
  }
  return { type, direction, label, id, display: displayOf(label, row, id), props }
}

/** Per-`NODE_TABLES` node count — the memory browser's rail totals. */
export async function memoryCounts(engine: StorageEngine): Promise<LabelCountDto[]> {
  const counts: LabelCountDto[] = []
  for (const spec of NODE_TABLES) {
    const rows = await engine.cypher(`MATCH (n:${spec.label}) RETURN count(n) AS c`)
    counts.push({ label: spec.label, count: Number(rows[0]?.['c'] ?? 0) })
  }
  return counts
}

export interface ListNodesArgs {
  readonly label: string
  readonly limit: number
  readonly offset: number
}

/** One page of nodes for a label (DISPLAY_PROPS projection) + the total. */
export async function listNodes(
  engine: StorageEngine,
  { label, limit, offset }: ListNodesArgs
): Promise<{ rows: MemoryNodeSummaryDto[]; total: number }> {
  const safeLabel = assertLabel(label)
  const safeLimit = Math.min(Math.max(Math.trunc(limit) || 0, 1), 200)
  const safeOffset = Math.max(Math.trunc(offset) || 0, 0)
  const displayCols = DISPLAY_PROPS[safeLabel]
  const select = ['n.id AS id', 'n.updated_at AS updated_at', ...displayCols.map((p) => `n.${p} AS ${p}`)]
  const rows = await engine.cypher(
    `MATCH (n:${safeLabel}) RETURN ${select.join(', ')} ORDER BY n.updated_at DESC, n.id SKIP ${safeOffset} LIMIT ${safeLimit}`
  )
  const totalRows = await engine.cypher(`MATCH (n:${safeLabel}) RETURN count(n) AS c`)
  const summaries: MemoryNodeSummaryDto[] = rows.map((row) => {
    const id = String(row['id'] ?? '')
    const updated = row['updated_at']
    return {
      label: safeLabel,
      id,
      display: displayOf(safeLabel, row, id),
      updatedAt: updated instanceof Date ? updated.toISOString() : updated == null ? null : String(updated)
    }
  })
  return { rows: summaries, total: Number(totalRows[0]?.['c'] ?? 0) }
}

export interface GetNodeArgs {
  readonly label: string
  readonly id: string
}

/** Inspector detail for one node: props (no embedding) + typed neighborhood. */
export async function getNode(engine: StorageEngine, { label, id }: GetNodeArgs): Promise<MemoryNodeDetailDto> {
  const safeLabel = assertLabel(label)
  const cols = inspectableColumns(safeLabel)
  const propRows = await engine.cypher(
    `MATCH (n:${safeLabel} {id: $id}) RETURN ${cols.map((c) => `n.${c} AS ${c}`).join(', ')} LIMIT 1`,
    { id }
  )
  const propRow = propRows[0]
  if (propRow === undefined) {
    throw new IngestError('NOT_FOUND', `${safeLabel} ${id} does not exist`)
  }

  const edges: { outgoing: MemoryEdgeDto[]; incoming: MemoryEdgeDto[] } = { outgoing: [], incoming: [] }
  const relSelect = 'r.extracted_by AS r_extracted_by, r.confidence AS r_confidence, r.created_at AS r_created_at'
  for (const rel of REL_TABLES) {
    for (const [from, to] of rel.pairs) {
      if (from === safeLabel) {
        const otherCols = DISPLAY_PROPS[to].map((p) => `m.${p} AS ${p}`).join(', ')
        const rows = await engine.cypher(
          `MATCH (n:${safeLabel} {id: $id})-[r:${rel.type}]->(m:${to}) RETURN m.id AS id${otherCols ? `, ${otherCols}` : ''}, ${relSelect} LIMIT 100`,
          { id }
        )
        for (const row of rows) edges.outgoing.push(edgeDto(rel.type, 'out', to, row))
      }
      if (to === safeLabel) {
        const otherCols = DISPLAY_PROPS[from].map((p) => `m.${p} AS ${p}`).join(', ')
        const rows = await engine.cypher(
          `MATCH (m:${from})-[r:${rel.type}]->(n:${safeLabel} {id: $id}) RETURN m.id AS id${otherCols ? `, ${otherCols}` : ''}, ${relSelect} LIMIT 100`,
          { id }
        )
        for (const row of rows) edges.incoming.push(edgeDto(rel.type, 'in', from, row))
      }
    }
  }

  return {
    label: safeLabel,
    id,
    props: jsonObject(propRow),
    outgoing: edges.outgoing,
    incoming: edges.incoming
  }
}
