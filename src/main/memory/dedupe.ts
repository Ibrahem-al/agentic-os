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
 *    Read-only — nothing mutates.
 *
 *    COST MODEL (user-directed improvement): the scan is split into a CHEAP
 *    exact pass (text/name columns only, no embeddings, covers up to
 *    DEDUPE_EXACT_SCAN_CAP nodes/label) and an EXPENSIVE near pass (loads
 *    embeddings + probes the ANN index) whose CANDIDATE set is bounded by the
 *    scope. `scope`:
 *      · omitted  — legacy whole-DB pass (newest per-label caps, every group).
 *      · 'recent' — only nodes changed since `sinceUpdatedAtIso`. KEY WIN: a
 *        newly-introduced duplicate must involve a recent node, so probing ONLY
 *        the recent candidates against the FULL ANN index still finds
 *        recent-vs-old dups — O(recent·k) instead of O(all·k).
 *      · 'count'  — the newest `count` nodes across the scanned labels.
 *      · 'all'    — every node (bounded only by DEDUPE_HARD_NODE_CEILING).
 *    For 'recent'/'count' a group is surfaced only when it contains ≥1 in-scope
 *    node; the OTHER (older) members of a near/exact match are pulled in on
 *    demand so a recent-vs-old duplicate is never hidden. The scan flags
 *    `truncated` when a cap bit, reports `scannedNodes`, honours an AbortSignal
 *    (cooperative cancel) and an onProgress tick — the background scan
 *    controller drives both.
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
import {
  DEDUPE_COUNT_DEFAULT,
  DEDUPE_EXACT_SCAN_CAP,
  DEDUPE_HARD_NODE_CEILING,
  DEDUPE_NEAR_NEIGHBOR_K,
  DEDUPE_PROGRESS_EMIT_INTERVAL,
  DEDUPE_SCAN_PER_LABEL_CAP,
  DEDUPE_SIMILARITY_DEFAULT
} from '../config'
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

/** Which slice of memory a scan compares (see ScanDuplicatesOptions.scope). */
export type DedupeScope = 'recent' | 'count' | 'all'

/** Progress tick during the near pass (drives the background controller's UI). */
export interface DedupeScanProgress {
  readonly scannedNodes: number
  readonly totalNodes: number
  readonly currentLabel: DedupeLabel
}

export interface ScanDuplicatesOptions {
  /** Restrict to these labels (default: every DEDUPE_LABELS). */
  readonly labels?: readonly string[]
  /** Near-duplicate cosine floor (default DEDUPE_SIMILARITY_DEFAULT). */
  readonly threshold?: number
  /** Run the (expensive) near pass. Default true; false = cheap exact-only. */
  readonly near?: boolean
  /**
   * Which slice to compare. Omitted = the legacy whole-DB pass. See the file
   * header for 'recent' / 'count' / 'all' semantics.
   */
  readonly scope?: DedupeScope
  /** scope==='count': newest-N budget across the scanned labels (default DEDUPE_COUNT_DEFAULT). */
  readonly count?: number
  /** scope==='recent': the resolved cutoff (ISO). Nodes with updated_at > this are in scope. */
  readonly sinceUpdatedAtIso?: string
  /** Near-candidate per-label cap (default DEDUPE_SCAN_PER_LABEL_CAP; 'all' uses the ceiling). */
  readonly perLabelCap?: number
  /** Exact-pass per-label cap (default DEDUPE_EXACT_SCAN_CAP). */
  readonly exactCap?: number
  /** Vector-probe k per node (default DEDUPE_NEAR_NEIGHBOR_K). */
  readonly nearK?: number
  /** Cooperative cancel — checked between probes; aborting throws DedupeScanAbortedError. */
  readonly signal?: AbortSignal
  /** Fired every DEDUPE_PROGRESS_EMIT_INTERVAL near probes (and once per label). */
  readonly onProgress?: (p: DedupeScanProgress) => void
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
  /** True when some label had more nodes than its cap ⇒ the scan was partial. */
  readonly truncated: boolean
  /** Near-pass nodes examined (the final progress numerator). */
  readonly scannedNodes: number
}

/** Thrown by scanDuplicates when its AbortSignal fires — the controller treats it as a cancel, not an error. */
export class DedupeScanAbortedError extends Error {
  constructor() {
    super('duplicate scan cancelled')
    this.name = 'DedupeScanAbortedError'
  }
}

/** One node pulled for scanning (near candidates also carry their embedding). */
interface ScanNode {
  readonly id: string
  /** Normalized render text (exact key); '' means "nothing to compare". */
  readonly key: string
  readonly display: string
  readonly updatedIso: string | null
  readonly updatedMs: number
  readonly embedding: number[] | null
}

const clamp01 = (n: number): number => Math.min(1, Math.max(0, n))

const checkAbort = (signal: AbortSignal | undefined): void => {
  if (signal?.aborted === true) throw new DedupeScanAbortedError()
}

export async function scanDuplicates(
  deps: DedupeScanDeps,
  options: ScanDuplicatesOptions = {}
): Promise<ScanDuplicatesResult> {
  const requested = options.labels ?? DEDUPE_LABELS
  for (const raw of requested) {
    if (!(DEDUPE_LABELS as readonly string[]).includes(raw)) {
      throw new MemoryEditError(
        'INVALID_INPUT',
        `cannot scan '${raw}' for duplicates — only ${DEDUPE_LABELS.join(', ')} are supported`
      )
    }
  }
  const labels = requested as readonly DedupeLabel[]
  const engine = deps.engine
  const scope = options.scope
  const runNear = options.near ?? true
  const threshold = clamp01(options.threshold ?? DEDUPE_SIMILARITY_DEFAULT)
  const maxDistance = 1 - threshold // VectorHit.distance is cosine distance (1 − similarity)
  const exactCap = Math.max(1, Math.trunc(options.exactCap ?? DEDUPE_EXACT_SCAN_CAP))
  const nearCap =
    scope === 'all' ? DEDUPE_HARD_NODE_CEILING : Math.max(1, Math.trunc(options.perLabelCap ?? DEDUPE_SCAN_PER_LABEL_CAP))
  const nearK = Math.max(1, Math.trunc(options.nearK ?? DEDUPE_NEAR_NEIGHBOR_K))
  const countBudget = Math.max(1, Math.trunc(options.count ?? DEDUPE_COUNT_DEFAULT))
  const cutoffMs =
    scope === 'recent' && options.sinceUpdatedAtIso !== undefined ? Date.parse(options.sinceUpdatedAtIso) : null
  const cutoffIso = cutoffMs !== null && Number.isFinite(cutoffMs) ? new Date(cutoffMs).toISOString() : null

  const groups: DuplicateGroup[] = []
  let truncated = false
  let scannedNodes = 0

  // scope==='count': the candidate set is the newest-N ACROSS labels, so gather
  // (and bucket) it once up-front. 'count' is intentionally partial, so it does
  // NOT set `truncated` (the UI copy says "newest N" — a flag would be noise).
  let countByLabel: Map<DedupeLabel, ScanNode[]> | null = null
  let countIdSet: Set<string> | null = null
  if (scope === 'count') {
    const gathered = await gatherCountCandidates(engine, labels, countBudget)
    countByLabel = gathered.byLabel
    countIdSet = gathered.ids
  }

  // Progress denominator (near pass only): the total candidate count.
  let totalNodes = 0
  if (runNear) {
    if (scope === 'count') {
      totalNodes = countIdSet?.size ?? 0
    } else {
      for (const label of labels) {
        if (!DEDUPE_RENDER[label].retrievable) continue
        totalNodes += await plannedNearCount(engine, label, cutoffIso, nearCap)
      }
    }
  }
  const emitProgress = (label: DedupeLabel): void =>
    options.onProgress?.({ scannedNodes, totalNodes, currentLabel: label })

  for (const label of labels) {
    checkAbort(options.signal)
    const spec = DEDUPE_RENDER[label]

    // ── EXACT pass (cheap: text/name only, broad) ──────────────────────────
    const exact = await fetchExactNodes(engine, label, exactCap)
    if (exact.truncated) truncated = true
    const cache = new Map<string, ScanNode>()
    for (const n of exact.nodes) cache.set(n.id, n)

    const claimed = new Set<string>()
    const byKey = new Map<string, ScanNode[]>()
    for (const n of exact.nodes) {
      if (n.key === '') continue
      const list = byKey.get(n.key) ?? []
      list.push(n)
      byKey.set(n.key, list)
    }
    for (const list of byKey.values()) {
      if (list.length < 2) continue
      if (!exactGroupInScope(list, scope, cutoffMs, countIdSet)) continue
      for (const n of list) claimed.add(n.id)
      groups.push(await buildGroup(engine, label, list.map((n) => n.id), 'exact', undefined, cache))
    }

    // ── NEAR pass (bounded candidate set; probes the FULL ANN index) ────────
    if (runNear && spec.retrievable) {
      const retrievableLabel = label as RetrievableLabel // spec.retrievable ⇒ label ∈ RETRIEVABLE_LABELS
      let candidates: ScanNode[]
      if (scope === 'count') {
        candidates = countByLabel?.get(label) ?? []
      } else {
        const fetched = await fetchNearCandidates(engine, label, cutoffIso, nearCap)
        if (fetched.truncated) truncated = true
        candidates = fetched.nodes
      }
      for (const n of candidates) cache.set(n.id, n)

      const dsu = new Dsu()
      const pairSim = new Map<string, number>()
      for (const node of candidates) {
        if (node.embedding === null || claimed.has(node.id)) {
          scannedNodes += 1
          continue
        }
        const hits = await engine.vectorSearch(retrievableLabel, node.embedding, nearK)
        for (const hit of hits) {
          if (hit.id === node.id || hit.distance > maxDistance || claimed.has(hit.id)) continue
          dsu.union(node.id, hit.id)
          const pk = node.id < hit.id ? `${node.id}|${hit.id}` : `${hit.id}|${node.id}`
          const sim = 1 - hit.distance
          const prev = pairSim.get(pk)
          if (prev === undefined || sim < prev) pairSim.set(pk, sim)
        }
        scannedNodes += 1
        if (scannedNodes % DEDUPE_PROGRESS_EMIT_INTERVAL === 0) {
          checkAbort(options.signal)
          emitProgress(label)
        }
      }

      // Union-find components (may include OLD nodes reached only as hits).
      const comps = new Map<string, string[]>()
      for (const id of dsu.members()) {
        const root = dsu.find(id)
        const list = comps.get(root) ?? []
        list.push(id)
        comps.set(root, list)
      }
      for (const [root, ids] of comps) {
        if (ids.length < 2) continue
        let minSim = 1 // the group's similarity is its weakest connecting edge (honest floor)
        for (const [pk, sim] of pairSim) {
          const bar = pk.indexOf('|')
          if (dsu.find(pk.slice(0, bar)) === root && dsu.find(pk.slice(bar + 1)) === root && sim < minSim) minSim = sim
        }
        const group = await buildGroup(engine, label, ids, 'near', minSim, cache)
        if (group.nodes.length >= 2) groups.push(group) // a member may vanish mid-scan
      }
    }
    emitProgress(label)
  }

  return { groups: sortGroups(groups), truncated, scannedNodes }
}

/** COUNT(n:label), or the count since a cutoff when `cutoffIso` is set. */
async function countLabel(engine: StorageEngine, label: DedupeLabel, cutoffIso: string | null): Promise<number> {
  const rows =
    cutoffIso === null
      ? await engine.cypher(`MATCH (n:${label}) RETURN count(n) AS c`)
      : await engine.cypher(`MATCH (n:${label}) WHERE n.updated_at > timestamp($cutoff) RETURN count(n) AS c`, {
          cutoff: cutoffIso
        })
  return Number(rows[0]?.['c'] ?? 0)
}

/** Planned near-candidate count for a label (for the progress denominator). */
async function plannedNearCount(
  engine: StorageEngine,
  label: DedupeLabel,
  cutoffIso: string | null,
  cap: number
): Promise<number> {
  return Math.min(await countLabel(engine, label, cutoffIso), cap)
}

const scanNodeFrom = (spec: LabelSpec, row: Row, withEmbedding: boolean): ScanNode => {
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
    updatedIso: updated instanceof Date ? updated.toISOString() : null,
    updatedMs: updated instanceof Date ? updated.getTime() : 0,
    embedding: withEmbedding && Array.isArray(embedding) ? (embedding as number[]) : null
  }
}

/** Newest `cap` nodes of a label for the exact pass — text columns only, NO embedding. */
async function fetchExactNodes(
  engine: StorageEngine,
  label: DedupeLabel,
  cap: number
): Promise<{ nodes: ScanNode[]; truncated: boolean }> {
  const spec = DEDUPE_RENDER[label]
  const total = await countLabel(engine, label, null)
  const cols = ['n.id AS id', 'n.updated_at AS updated_at', ...spec.columns.map((c) => `n.${c} AS ${c}`)]
  const rows = await engine.cypher(
    `MATCH (n:${label}) RETURN ${cols.join(', ')} ORDER BY n.updated_at DESC, n.id LIMIT ${cap}`
  )
  return { nodes: rows.map((row) => scanNodeFrom(spec, row, false)), truncated: total > cap }
}

/** Near candidates for a label (embeddings loaded), optionally since a cutoff. */
async function fetchNearCandidates(
  engine: StorageEngine,
  label: DedupeLabel,
  cutoffIso: string | null,
  cap: number
): Promise<{ nodes: ScanNode[]; truncated: boolean }> {
  const spec = DEDUPE_RENDER[label]
  const total = await countLabel(engine, label, cutoffIso)
  const cols = [
    'n.id AS id',
    'n.updated_at AS updated_at',
    ...spec.columns.map((c) => `n.${c} AS ${c}`),
    'n.embedding AS embedding'
  ]
  const where = cutoffIso === null ? '' : 'WHERE n.updated_at > timestamp($cutoff) '
  const rows = await engine.cypher(
    `MATCH (n:${label}) ${where}RETURN ${cols.join(', ')} ORDER BY n.updated_at DESC, n.id LIMIT ${cap}`,
    cutoffIso === null ? {} : { cutoff: cutoffIso }
  )
  return { nodes: rows.map((row) => scanNodeFrom(spec, row, true)), truncated: total > cap }
}

/**
 * The newest `budget` nodes across the retrievable scanned labels (with
 * embeddings), bucketed per label. Fetching the newest `budget` PER label and
 * merge-taking the global top `budget` is exact: any node in the global newest-N
 * ranks ≤ N within its own label, so it is captured.
 */
async function gatherCountCandidates(
  engine: StorageEngine,
  labels: readonly DedupeLabel[],
  budget: number
): Promise<{ byLabel: Map<DedupeLabel, ScanNode[]>; ids: Set<string> }> {
  const all: { label: DedupeLabel; node: ScanNode }[] = []
  for (const label of labels) {
    const spec = DEDUPE_RENDER[label]
    if (!spec.retrievable) continue
    const cols = [
      'n.id AS id',
      'n.updated_at AS updated_at',
      ...spec.columns.map((c) => `n.${c} AS ${c}`),
      'n.embedding AS embedding'
    ]
    const rows = await engine.cypher(
      `MATCH (n:${label}) RETURN ${cols.join(', ')} ORDER BY n.updated_at DESC, n.id LIMIT ${budget}`
    )
    for (const row of rows) all.push({ label, node: scanNodeFrom(spec, row, true) })
  }
  all.sort((a, b) => b.node.updatedMs - a.node.updatedMs || (a.node.id < b.node.id ? -1 : a.node.id > b.node.id ? 1 : 0))
  const byLabel = new Map<DedupeLabel, ScanNode[]>()
  const ids = new Set<string>()
  for (const { label, node } of all.slice(0, budget)) {
    const list = byLabel.get(label) ?? []
    list.push(node)
    byLabel.set(label, list)
    ids.add(node.id)
  }
  return { byLabel, ids }
}

/** Whether an exact group touches the current scope (recent/count filter). */
function exactGroupInScope(
  members: readonly ScanNode[],
  scope: DedupeScope | undefined,
  cutoffMs: number | null,
  countIdSet: Set<string> | null
): boolean {
  if (scope === undefined || scope === 'all') return true
  if (scope === 'recent') return cutoffMs === null ? true : members.some((n) => n.updatedMs > cutoffMs)
  // scope === 'count'
  return countIdSet !== null && members.some((n) => countIdSet.has(n.id))
}

/** Resolve a member not already scanned into memory (an OLD node pulled in by a near hit). */
async function materializeNode(
  engine: StorageEngine,
  label: DedupeLabel,
  id: string
): Promise<{ display: string; updatedIso: string | null; updatedMs: number } | null> {
  const spec = DEDUPE_RENDER[label]
  const cols = ['n.updated_at AS updated_at', ...spec.columns.map((c) => `n.${c} AS ${c}`)]
  const rows = await engine.cypher(`MATCH (n:${label} {id: $id}) RETURN ${cols.join(', ')} LIMIT 1`, { id })
  const row = rows[0]
  if (row === undefined) return null
  const get = (c: string): string => {
    const v = row[c]
    return typeof v === 'string' ? v : ''
  }
  const rendered = spec.render(get)
  const updated = row['updated_at']
  return {
    display: truncate(rendered.replace(/\s+/g, ' ').trim()) || id,
    updatedIso: updated instanceof Date ? updated.toISOString() : null,
    updatedMs: updated instanceof Date ? updated.getTime() : 0
  }
}

async function buildGroup(
  engine: StorageEngine,
  label: DedupeLabel,
  memberIds: readonly string[],
  reason: 'exact' | 'near',
  similarity: number | undefined,
  cache: Map<string, ScanNode>
): Promise<DuplicateGroup> {
  const resolved: { id: string; display: string; updatedMs: number; updatedIso: string | null; edgeCount: number }[] = []
  for (const id of memberIds) {
    const cached = cache.get(id)
    const base = cached ?? (await materializeNode(engine, label, id))
    if (base === null) continue // deleted mid-scan — drop it
    const updatedIso = cached !== undefined ? cached.updatedIso : base.updatedIso
    resolved.push({
      id,
      display: base.display,
      updatedMs: cached !== undefined ? cached.updatedMs : base.updatedMs,
      updatedIso,
      edgeCount: await edgeCountOf(engine, label, id)
    })
  }
  // Keeper ranking: most edges, tie → newest updated_at, tie → id (determinism).
  resolved.sort(
    (a, b) =>
      b.edgeCount - a.edgeCount || b.updatedMs - a.updatedMs || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
  )
  const nodes: DuplicateNode[] = resolved.map((r) => ({
    id: r.id,
    display: r.display,
    updatedAt: r.updatedIso,
    edgeCount: r.edgeCount
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

  members(): IterableIterator<string> {
    return this.parent.keys()
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
