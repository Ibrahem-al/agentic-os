/**
 * Memory deduplication (dashboard maintenance — user-directed spec extension).
 * Two services, both IPC-first like the rest of feature B; the MCP surface
 * reuses them (a read scanner + a STAGING proposer, never a direct merge —
 * §21 rule 6):
 *
 *  - `scanDuplicates` finds duplicate GROUPS across memory. EXACT groups are
 *    normalized-text equality on each retrievable label's retrieval-render text
 *    (Project/Skill/Preference/Knowledge) plus exact Tag names; NEAR groups are
 *    embedding cosine ≥ threshold (default DEDUPE_SIMILARITY_DEFAULT), probed
 *    against each node's OWN label vector index and union-found into groups.
 *    Read-only — nothing mutates. The scan is capped per label so a huge graph
 *    cannot hang it (the result flags `truncated` when a cap bit).
 *
 *  - `mergeDuplicates` collapses a group onto a keeper in ONE audited lane job
 *    (so it is undoable from History, §21 rule 11). v1 supports Preference,
 *    Knowledge and Tag ONLY: a Skill/Project carries versions, an improvement
 *    ledger and ownership edges whose automatic merge is unsafe, so those stay
 *    scan-report-only (recorded decision). Each removed node's incident edges
 *    are re-pointed onto the keeper (schema-valid pairs only — an edge that
 *    would become a self-loop or an off-schema pair is DROPPED and counted),
 *    preserving edge props (provenance included); createEdge is a MERGE, so a
 *    re-point onto an edge the keeper already has is idempotent. Then each
 *    removed node is DETACH-deleted (children before nothing — Tag/Preference/
 *    Knowledge own no cascade). The audit recorder captures the removed nodes'
 *    full pre-image (embedding + original edges), so one undo restores it all.
 *
 * The keeper a scan SUGGESTS (and a merge should target) is the group's
 * best-connected node — most incident edges, ties broken by newest updated_at.
 */
import { DEDUPE_NEAR_NEIGHBOR_K, DEDUPE_SCAN_PER_LABEL_CAP, DEDUPE_SIMILARITY_DEFAULT } from '../config'
import { skillEmbedText } from '../agents/skills/lifecycle'
import type { AuditLog } from '../security/audit'
import {
  REL_TABLES,
  relTable,
  type EdgeProps,
  type EdgeType,
  type NodeLabel,
  type NodeRef,
  type RetrievableLabel,
  type Row,
  type StorageEngine
} from '../storage'
import { MemoryEditError } from './edit'

// ── label vocabulary ──────────────────────────────────────────────────────────

/**
 * Labels a duplicate scan groups: the four retrievable labels (exact + near)
 * plus Tag (exact name only — Tags carry no embedding). Pinned against
 * RETRIEVABLE_LABELS in the dedupe test so it can never silently drift.
 */
export const DEDUPE_LABELS = ['Project', 'Skill', 'Preference', 'Knowledge', 'Tag'] as const
export type DedupeLabel = (typeof DEDUPE_LABELS)[number]

/**
 * Labels `mergeDuplicates` may auto-merge (v1): a Skill/Project has versions, a
 * §17 improvement ledger and ownership edges whose automatic merge is unsafe —
 * they stay scan-report-only (recorded decision, feature brief).
 */
export const DEDUPE_MERGE_LABELS = ['Preference', 'Knowledge', 'Tag'] as const
export type DedupeMergeLabel = (typeof DEDUPE_MERGE_LABELS)[number]

// ── retrieval-render per label (EXACTLY what the read path scores/embeds) ─────

interface LabelSpec {
  readonly columns: readonly string[]
  readonly render: (get: (column: string) => string) => string
  /** Retrievable labels carry an embedding + vector index ⇒ eligible for near. */
  readonly retrievable: boolean
}

const joinNonEmpty = (parts: string[], sep: string): string => parts.filter((p) => p !== '').join(sep)

/**
 * Mirrors retrieval/render.ts RENDERERS (Skill via skillEmbedText), so a scan's
 * exact-text key and display match what retrieval renders for the same node.
 */
const DEDUPE_RENDER: Readonly<Record<DedupeLabel, LabelSpec>> = {
  Project: { columns: ['name', 'summary'], render: (g) => joinNonEmpty([g('name'), g('summary')], ' — '), retrievable: true },
  Skill: { columns: ['name', 'instructions'], render: (g) => skillEmbedText(g('name'), g('instructions')), retrievable: true },
  Preference: { columns: ['statement'], render: (g) => g('statement'), retrievable: true },
  Knowledge: { columns: ['content'], render: (g) => g('content'), retrievable: true },
  Tag: { columns: ['name'], render: (g) => g('name'), retrievable: false }
}

/** Trim, collapse internal whitespace, casefold — the exact-duplicate key. */
const normalizeText = (text: string): string => text.trim().replace(/\s+/g, ' ').toLowerCase()

const truncate = (text: string, max = 140): string => (text.length > max ? `${text.slice(0, max - 1)}…` : text)

// ── scan ──────────────────────────────────────────────────────────────────────

export interface DedupeScanDeps {
  readonly engine: StorageEngine
}

export interface ScanDuplicatesOptions {
  /** Restrict to these labels (default: every DEDUPE_LABELS). */
  readonly labels?: readonly string[]
  /** Near-duplicate cosine floor (default DEDUPE_SIMILARITY_DEFAULT). */
  readonly threshold?: number
  /** Per-label node cap (default DEDUPE_SCAN_PER_LABEL_CAP). */
  readonly perLabelCap?: number
  /** Vector-probe k per node (default DEDUPE_NEAR_NEIGHBOR_K). */
  readonly nearK?: number
}

export interface DuplicateNode {
  readonly id: string
  /** One-line human handle (the truncated retrieval-render text / Tag name). */
  readonly display: string
  readonly updatedAt: string | null
  /** Incident-edge count — the primary keeper signal. */
  readonly edgeCount: number
}

export interface DuplicateGroup {
  readonly label: DedupeLabel
  readonly reason: 'exact' | 'near'
  /** Set for `reason: 'near'` only — the group's weakest pairwise cosine. */
  readonly similarity?: number
  /** Members, best keeper first (most edges, then newest). */
  readonly nodes: readonly DuplicateNode[]
  /** Suggested survivor = nodes[0].id (most edges, tie → newest updated_at). */
  readonly suggestedKeepId: string
}

export interface ScanDuplicatesResult {
  readonly groups: readonly DuplicateGroup[]
  /** True when some label had more nodes than the cap ⇒ the scan was partial. */
  readonly truncated: boolean
}

/** One node pulled for scanning (retrievable nodes also carry their embedding). */
interface ScannedNode {
  readonly id: string
  /** Normalized render text (exact key); '' means "nothing to compare". */
  readonly key: string
  readonly display: string
  readonly updatedAtIso: string | null
  readonly updatedMs: number
  readonly embedding: number[] | null
}

const clamp01 = (n: number): number => Math.min(1, Math.max(0, n))

export async function scanDuplicates(
  deps: DedupeScanDeps,
  options: ScanDuplicatesOptions = {}
): Promise<ScanDuplicatesResult> {
  const requested = options.labels ?? DEDUPE_LABELS
  const threshold = clamp01(options.threshold ?? DEDUPE_SIMILARITY_DEFAULT)
  const perLabelCap = Math.max(1, Math.trunc(options.perLabelCap ?? DEDUPE_SCAN_PER_LABEL_CAP))
  const nearK = Math.max(1, Math.trunc(options.nearK ?? DEDUPE_NEAR_NEIGHBOR_K))
  // VectorHit.distance is cosine distance (1 − similarity): near ⟺ distance ≤ 1 − threshold.
  const maxDistance = 1 - threshold

  const groups: DuplicateGroup[] = []
  let truncated = false

  for (const raw of requested) {
    if (!(DEDUPE_LABELS as readonly string[]).includes(raw)) {
      throw new MemoryEditError(
        'INVALID_INPUT',
        `cannot scan '${raw}' for duplicates — only ${DEDUPE_LABELS.join(', ')} are supported`
      )
    }
    const label = raw as DedupeLabel
    const spec = DEDUPE_RENDER[label]
    const { nodes, truncated: labelTruncated } = await scanLabelNodes(deps.engine, label, perLabelCap)
    if (labelTruncated) truncated = true

    // ── exact groups (take priority — an exact pair is also a near pair) ──
    const claimed = new Set<string>()
    const byKey = new Map<string, ScannedNode[]>()
    for (const node of nodes) {
      if (node.key === '') continue
      const list = byKey.get(node.key) ?? []
      list.push(node)
      byKey.set(node.key, list)
    }
    for (const list of byKey.values()) {
      if (list.length < 2) continue
      for (const n of list) claimed.add(n.id)
      groups.push(await buildGroup(deps.engine, label, list, 'exact', undefined))
    }

    // ── near groups (retrievable labels only; exact-claimed nodes excluded) ──
    if (spec.retrievable) {
      const retrievableLabel = label as RetrievableLabel // spec.retrievable ⇒ label ∈ RETRIEVABLE_LABELS
      const byId = new Map(nodes.map((n) => [n.id, n] as const))
      const dsu = new Dsu()
      const pairSim = new Map<string, number>()
      for (const node of nodes) {
        if (node.embedding === null || claimed.has(node.id)) continue
        const hits = await deps.engine.vectorSearch(retrievableLabel, node.embedding, nearK)
        for (const hit of hits) {
          if (hit.id === node.id || hit.distance > maxDistance) continue
          if (!byId.has(hit.id) || claimed.has(hit.id)) continue
          dsu.union(node.id, hit.id)
          const pk = node.id < hit.id ? `${node.id}|${hit.id}` : `${hit.id}|${node.id}`
          const sim = 1 - hit.distance
          const prev = pairSim.get(pk)
          if (prev === undefined || sim < prev) pairSim.set(pk, sim)
        }
      }
      const comps = new Map<string, ScannedNode[]>()
      for (const node of nodes) {
        if (node.embedding === null || claimed.has(node.id) || !dsu.has(node.id)) continue
        const root = dsu.find(node.id)
        const list = comps.get(root) ?? []
        list.push(node)
        comps.set(root, list)
      }
      for (const [root, list] of comps) {
        if (list.length < 2) continue
        // The group's similarity is its weakest connecting edge (honest floor).
        let minSim = 1
        for (const [pk, sim] of pairSim) {
          const bar = pk.indexOf('|')
          const a = pk.slice(0, bar)
          const b = pk.slice(bar + 1)
          if (dsu.has(a) && dsu.has(b) && dsu.find(a) === root && dsu.find(b) === root && sim < minSim) minSim = sim
        }
        groups.push(await buildGroup(deps.engine, label, list, 'near', minSim))
      }
    }
  }

  return { groups: sortGroups(groups), truncated }
}

async function scanLabelNodes(
  engine: StorageEngine,
  label: DedupeLabel,
  cap: number
): Promise<{ nodes: ScannedNode[]; truncated: boolean }> {
  const spec = DEDUPE_RENDER[label]
  const totalRows = await engine.cypher(`MATCH (n:${label}) RETURN count(n) AS c`)
  const total = Number(totalRows[0]?.['c'] ?? 0)
  const cols = ['n.id AS id', 'n.updated_at AS updated_at', ...spec.columns.map((c) => `n.${c} AS ${c}`)]
  if (spec.retrievable) cols.push('n.embedding AS embedding')
  // Newest-first so a truncated scan keeps the freshest nodes (LIMIT is the cap).
  const rows = await engine.cypher(
    `MATCH (n:${label}) RETURN ${cols.join(', ')} ORDER BY n.updated_at DESC, n.id LIMIT ${cap}`
  )
  const nodes = rows.map((row): ScannedNode => {
    const get = (c: string): string => {
      const v = row[c]
      return typeof v === 'string' ? v : ''
    }
    const rendered = spec.render(get)
    const updated = row['updated_at']
    const embedding = row['embedding']
    const id = String(row['id'] ?? '')
    return {
      id,
      key: normalizeText(rendered),
      display: truncate(rendered.replace(/\s+/g, ' ').trim()) || id,
      updatedAtIso: updated instanceof Date ? updated.toISOString() : null,
      updatedMs: updated instanceof Date ? updated.getTime() : 0,
      embedding: spec.retrievable && Array.isArray(embedding) ? (embedding as number[]) : null
    }
  })
  return { nodes, truncated: total > cap }
}

async function buildGroup(
  engine: StorageEngine,
  label: DedupeLabel,
  members: readonly ScannedNode[],
  reason: 'exact' | 'near',
  similarity: number | undefined
): Promise<DuplicateGroup> {
  const withCounts = await Promise.all(
    members.map(async (node) => ({ node, edgeCount: await edgeCountOf(engine, label, node.id) }))
  )
  // Keeper ranking: most edges, tie → newest updated_at, tie → id (determinism).
  withCounts.sort(
    (a, b) =>
      b.edgeCount - a.edgeCount ||
      b.node.updatedMs - a.node.updatedMs ||
      (a.node.id < b.node.id ? -1 : a.node.id > b.node.id ? 1 : 0)
  )
  const nodes: DuplicateNode[] = withCounts.map((w) => ({
    id: w.node.id,
    display: w.node.display,
    updatedAt: w.node.updatedAtIso,
    edgeCount: w.edgeCount
  }))
  return {
    label,
    reason,
    ...(similarity !== undefined ? { similarity } : {}),
    nodes,
    suggestedKeepId: nodes[0]?.id ?? ''
  }
}

/** Deterministic group order: by label, exact before near, then keeper id. */
function sortGroups(groups: DuplicateGroup[]): DuplicateGroup[] {
  const order = (l: DedupeLabel): number => (DEDUPE_LABELS as readonly string[]).indexOf(l)
  return [...groups].sort(
    (a, b) =>
      order(a.label) - order(b.label) ||
      (a.reason === b.reason ? 0 : a.reason === 'exact' ? -1 : 1) ||
      (a.suggestedKeepId < b.suggestedKeepId ? -1 : a.suggestedKeepId > b.suggestedKeepId ? 1 : 0)
  )
}

/**
 * Count every edge incident to a node (both directions), enumerated over the
 * §18 schema pairs (the driver has no generic type() projection — same walk as
 * audit's incidentEdgesOf). No DEDUPE_LABEL is its own FROM+TO pair, so no edge
 * is double-counted here.
 */
async function edgeCountOf(engine: StorageEngine, label: NodeLabel, id: string): Promise<number> {
  let total = 0
  for (const spec of REL_TABLES) {
    for (const [fromLabel, toLabel] of spec.pairs) {
      if (fromLabel === label) {
        const rows = await engine.cypher(
          `MATCH (n:${label} {id: $id})-[r:${spec.type}]->(:${toLabel}) RETURN count(r) AS c`,
          { id }
        )
        total += Number(rows[0]?.['c'] ?? 0)
      }
      if (toLabel === label) {
        const rows = await engine.cypher(
          `MATCH (:${fromLabel})-[r:${spec.type}]->(n:${label} {id: $id}) RETURN count(r) AS c`,
          { id }
        )
        total += Number(rows[0]?.['c'] ?? 0)
      }
    }
  }
  return total
}

// ── merge ─────────────────────────────────────────────────────────────────────

export interface DedupeMergeDeps {
  readonly engine: StorageEngine
  readonly audit: AuditLog
  /** Recorded as the audit actor (§13) — DASHBOARD_USER for IPC, the proposer for a staged approve. */
  readonly actor: string
}

export interface DedupeMergePlan {
  readonly label: DedupeMergeLabel
  readonly keepId: string
  readonly keepDisplay: string
  readonly removals: readonly { readonly id: string; readonly display: string }[]
}

export interface MergeDuplicatesResult {
  readonly auditActionId: string
  readonly removed: number
  readonly edgesRepointed: number
  readonly edgesDropped: number
}

/**
 * Validate a merge request and resolve the human displays (all PRE-lane, so a
 * bad request leaves no trace). Shared by `mergeDuplicates` and the MCP
 * `propose_dedupe_merge` staging tool (which stores the displays in its payload
 * for the review diff). Throws MemoryEditError (INVALID_INPUT / NOT_FOUND).
 */
export async function planDedupeMerge(
  deps: { readonly engine: StorageEngine },
  args: { label: string; keepId: string; removeIds: readonly string[] }
): Promise<DedupeMergePlan> {
  if (!(DEDUPE_MERGE_LABELS as readonly string[]).includes(args.label)) {
    throw new MemoryEditError(
      'INVALID_INPUT',
      `merge is not supported for '${args.label}' — v1 merges ${DEDUPE_MERGE_LABELS.join(', ')} only; ` +
        'Skill and Project are scan-report-only (their versions, improvement ledger and ownership make an automatic merge unsafe)'
    )
  }
  const label = args.label as DedupeMergeLabel
  const removeIds = [...new Set(args.removeIds)]
  if (removeIds.length === 0) {
    throw new MemoryEditError('INVALID_INPUT', `merge ${label}: provide at least one node id to remove`)
  }
  if (removeIds.includes(args.keepId)) {
    throw new MemoryEditError('INVALID_INPUT', `merge ${label}: the keeper ${args.keepId} cannot also be in removeIds`)
  }
  const keepDisplay = await resolveDisplay(deps.engine, label, args.keepId)
  if (keepDisplay === null) throw new MemoryEditError('NOT_FOUND', `${label} ${args.keepId} does not exist`)
  const removals: { id: string; display: string }[] = []
  for (const id of removeIds) {
    const display = await resolveDisplay(deps.engine, label, id)
    if (display === null) throw new MemoryEditError('NOT_FOUND', `${label} ${id} does not exist`)
    removals.push({ id, display })
  }
  return { label, keepId: args.keepId, keepDisplay, removals }
}

export async function mergeDuplicates(
  deps: DedupeMergeDeps,
  args: { label: string; keepId: string; removeIds: readonly string[] }
): Promise<MergeDuplicatesResult> {
  const plan = await planDedupeMerge({ engine: deps.engine }, args) // validates + resolves displays (pre-lane)
  const { label, keepId } = plan
  const removeIds = plan.removals.map((r) => r.id)
  const removeSet = new Set(removeIds)

  // Collect every incident edge of every removed node ONCE, keyed by physical
  // identity, so an edge between two removed nodes is not processed twice.
  const original = new Map<string, IncidentEdge>()
  for (const id of removeIds) {
    for (const edge of await incidentEdges(deps.engine, label, id)) {
      const key = `${edge.type}|${edge.from.label}:${edge.from.id}|${edge.to.label}:${edge.to.id}`
      if (!original.has(key)) original.set(key, edge)
    }
  }

  // Re-point each unique edge onto the keeper. Any removed endpoint maps to the
  // keeper; an edge that then self-loops or leaves the schema is DROPPED.
  const repoint = new Map<string, IncidentEdge>()
  let edgesDropped = 0
  for (const edge of original.values()) {
    const from: NodeRef = removeSet.has(edge.from.id) ? { label: edge.from.label, id: keepId } : edge.from
    const to: NodeRef = removeSet.has(edge.to.id) ? { label: edge.to.label, id: keepId } : edge.to
    if (from.id === to.id || !isSchemaPair(edge.type, from, to)) {
      edgesDropped += 1
      continue
    }
    const key = `${edge.type}|${from.id}|${to.id}`
    if (!repoint.has(key)) repoint.set(key, { type: edge.type, from, to, ...(edge.props !== undefined ? { props: edge.props } : {}) })
  }
  const edgesRepointed = repoint.size

  const description =
    `dashboard: merge ${removeIds.length} duplicate ${label} into ${keepId}` +
    (plan.keepDisplay !== keepId ? ` ('${plan.keepDisplay}')` : '')
  const { actionId } = await deps.audit.graphWrite(deps.actor, description, async (tx) => {
    // Re-point first (both endpoints still exist), then delete the removed nodes.
    for (const edge of repoint.values()) await tx.createEdge(edge.type, edge.from, edge.to, edge.props)
    for (const id of removeIds) await tx.deleteNode(label, id)
  })
  return { auditActionId: actionId, removed: removeIds.length, edgesRepointed, edgesDropped }
}

interface IncidentEdge {
  readonly type: EdgeType
  readonly from: NodeRef
  readonly to: NodeRef
  readonly props?: EdgeProps
}

async function incidentEdges(engine: StorageEngine, label: NodeLabel, id: string): Promise<IncidentEdge[]> {
  const out: IncidentEdge[] = []
  for (const spec of REL_TABLES) {
    for (const [fromLabel, toLabel] of spec.pairs) {
      if (fromLabel === label) {
        const rows = await engine.cypher(
          `MATCH (n:${label} {id: $id})-[r:${spec.type}]->(m:${toLabel})
           RETURN m.id AS other, r.extracted_by AS eb, r.confidence AS conf`,
          { id }
        )
        for (const row of rows) {
          out.push({ type: spec.type, from: { label, id }, to: { label: toLabel, id: String(row['other']) }, props: edgePropsOf(row) })
        }
      }
      if (toLabel === label) {
        const rows = await engine.cypher(
          `MATCH (m:${fromLabel})-[r:${spec.type}]->(n:${label} {id: $id})
           RETURN m.id AS other, r.extracted_by AS eb, r.confidence AS conf`,
          { id }
        )
        for (const row of rows) {
          out.push({ type: spec.type, from: { label: fromLabel, id: String(row['other']) }, to: { label, id }, props: edgePropsOf(row) })
        }
      }
    }
  }
  return out
}

async function resolveDisplay(engine: StorageEngine, label: DedupeLabel, id: string): Promise<string | null> {
  const spec = DEDUPE_RENDER[label]
  const cols = spec.columns.map((c) => `n.${c} AS ${c}`).join(', ')
  const rows = await engine.cypher(`MATCH (n:${label} {id: $id}) RETURN ${cols} LIMIT 1`, { id })
  const row = rows[0]
  if (row === undefined) return null
  const get = (c: string): string => {
    const v = row[c]
    return typeof v === 'string' ? v : ''
  }
  return truncate(spec.render(get).replace(/\s+/g, ' ').trim()) || id
}

function isSchemaPair(type: EdgeType, from: NodeRef, to: NodeRef): boolean {
  return relTable(type).pairs.some(([f, t]) => f === from.label && t === to.label)
}

/** The stamped edge props (extracted_by/confidence), or undefined when none set. */
function edgePropsOf(row: Row): EdgeProps | undefined {
  const props: { extracted_by?: string; confidence?: number } = {}
  if (typeof row['eb'] === 'string') props.extracted_by = row['eb']
  if (typeof row['conf'] === 'number') props.confidence = row['conf']
  return Object.keys(props).length > 0 ? props : undefined
}

// ── union-find (string ids) ────────────────────────────────────────────────────

class Dsu {
  private readonly parent = new Map<string, string>()

  private ensure(x: string): void {
    if (!this.parent.has(x)) this.parent.set(x, x)
  }

  has(x: string): boolean {
    return this.parent.has(x)
  }

  find(x: string): string {
    this.ensure(x)
    let root = x
    while (this.parent.get(root)! !== root) root = this.parent.get(root)!
    let cur = x
    while (cur !== root) {
      const next = this.parent.get(cur)!
      this.parent.set(cur, root)
      cur = next
    }
    return root
  }

  union(a: string, b: string): void {
    const ra = this.find(a)
    const rb = this.find(b)
    if (ra !== rb) this.parent.set(ra, rb)
  }
}
