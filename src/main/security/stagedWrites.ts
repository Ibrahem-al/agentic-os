/**
 * Staged-writes lifecycle (§13, phase 09): propose → human-readable diff →
 * approve (commit via the single write lane, audited) / reject.
 *
 * Three proposers feed `staged_writes` (appdata.db):
 *  - `propose_correction` (kind 'propose_correction', proposer
 *    `claude-mcp:<session>`): payload `{ patch, reason }` against an existing
 *    node — Claude's ONLY write path (§21 rule 6).
 *  - the extraction agent (kind 'extraction', proposer
 *    `extraction-agent:<sessionNode>`): self-contained payload
 *    `{ op, node, embedOnCommit, edges, tagCreates, provenance, evidence,
 *    reason, session }` for items below the §17 write gate.
 *  - the skill-improvement agent (kind 'skill-improvement', phase 12): a
 *    stylistic skill's benchmarked candidate awaiting the §17 one-click human
 *    approval. Approve = the audited adoption flip (candidate→active,
 *    active→retired, Skill updated + re-embedded); reject = the row PLUS an
 *    audited retire of the already-recorded candidate version (this kind's
 *    candidate is a first-class graph record before review — recorded
 *    deviation from the other kinds' "rejection touches nothing").
 *
 * Approval commits through ONE audited write-lane job (§21 rules 1 + 4 —
 * extraction payload edges carry their provenance stamps verbatim; the audit
 * row carries the reversible delta so a bad approval is undoable). Rejection
 * touches nothing but the row for correction/extraction kinds.
 *
 * Status flow: staged → approved (decision recorded) → committed (graph
 * updated). A commit failure leaves the row 'approved' with the error in
 * validation_json; calling approve() again retries the commit.
 */
import type BetterSqlite3 from 'better-sqlite3'
import {
  SKILL_IMPROVEMENT_STAGED_KIND,
  cleanupRejectedSkillImprovement,
  commitSkillImprovementApproval,
  decodeSkillImprovementPayload,
  renderSkillImprovementDiff,
  type SkillLifecycleDeps
} from '../agents/skills/lifecycle'
import { SkillImprovementError } from '../agents/skills/types'
import { EDGE_TYPES, NODE_LABELS, type EdgeType, type NodeLabel, type StorageEngine } from '../storage'
import type { AuditLog } from './audit'

export type StagedWriteStatus = 'staged' | 'approved' | 'rejected' | 'committed'

export interface StagedWriteRow {
  readonly id: string
  readonly proposedBy: string
  readonly kind: string
  readonly targetLabel: string | null
  readonly targetId: string | null
  readonly payload: Record<string, unknown>
  readonly status: StagedWriteStatus
  readonly validation: Record<string, unknown> | null
  readonly createdAt: string
  readonly decidedAt: string | null
  readonly committedAt: string | null
}

export type StagedWriteErrorCode = 'NOT_FOUND' | 'INVALID_STATE' | 'INVALID_PAYLOAD' | 'COMMIT_FAILED'

export class StagedWriteError extends Error {
  readonly code: StagedWriteErrorCode

  constructor(code: StagedWriteErrorCode, message: string) {
    super(message)
    this.name = 'StagedWriteError'
    this.code = code
  }
}

/** Structural — satisfied by OllamaClient (embedOnCommit for new Preferences). */
export interface CommitEmbedder {
  embed(texts: string[]): Promise<number[][]>
}

export interface StagedWritesDeps {
  readonly db: BetterSqlite3.Database
  readonly engine: StorageEngine
  /** Commits are audited agent actions (§13) — reversible deltas + undo. */
  readonly audit: AuditLog
  /** Needed only when approving extraction creates with embedOnCommit. */
  readonly embedder?: CommitEmbedder
}

// ── payload shapes (validated, never trusted blindly) ────────────────────────

interface CorrectionPayload {
  readonly patch: Record<string, unknown>
  readonly reason: string
}

interface ExtractionEdge {
  readonly type: EdgeType
  readonly from: { label: NodeLabel; id: string }
  readonly to: { label: NodeLabel; id: string }
  readonly props: { extracted_by?: string; confidence?: number }
}

interface ExtractionPayload {
  readonly op: 'create' | 'merge'
  readonly node: { label: NodeLabel; id: string; props: Record<string, unknown> } | null
  readonly embedOnCommit: boolean
  readonly edges: readonly ExtractionEdge[]
  readonly tagCreates: readonly { id: string; name: string }[]
  readonly provenance: { extracted_by: string; confidence: number }
  readonly evidence: string
  readonly reason: string
  readonly session: string
}

/** Same protected set the propose tool enforces — re-checked at commit time. */
const PROTECTED_PATCH_KEYS = ['id', 'created_at', 'updated_at', 'embedding', 'extracted_by', 'confidence'] as const

const assertLabel = (label: unknown, context: string): NodeLabel => {
  if (typeof label !== 'string' || !(NODE_LABELS as readonly string[]).includes(label)) {
    throw new StagedWriteError('INVALID_PAYLOAD', `${context}: unknown node label '${String(label)}'`)
  }
  return label as NodeLabel
}
const assertEdgeType = (type: unknown, context: string): EdgeType => {
  if (typeof type !== 'string' || !(EDGE_TYPES as readonly string[]).includes(type)) {
    throw new StagedWriteError('INVALID_PAYLOAD', `${context}: unknown edge type '${String(type)}'`)
  }
  return type as EdgeType
}

// ── queries ───────────────────────────────────────────────────────────────────

export function listStagedWrites(
  db: BetterSqlite3.Database,
  filter?: { status?: StagedWriteStatus }
): StagedWriteRow[] {
  const rows = (
    filter?.status !== undefined
      ? db.prepare('SELECT * FROM staged_writes WHERE status = ? ORDER BY created_at, id').all(filter.status)
      : db.prepare('SELECT * FROM staged_writes ORDER BY created_at, id').all()
  ) as RawStagedRow[]
  return rows.map(decodeRow)
}

export function getStagedWrite(db: BetterSqlite3.Database, id: string): StagedWriteRow | undefined {
  const row = db.prepare('SELECT * FROM staged_writes WHERE id = ?').get(id) as RawStagedRow | undefined
  return row === undefined ? undefined : decodeRow(row)
}

// ── human-readable diff (§13 "user-visible diff before commit") ──────────────

export async function renderStagedWriteDiff(
  deps: Pick<StagedWritesDeps, 'db' | 'engine'>,
  id: string
): Promise<string> {
  const row = requireRow(deps.db, id)
  const lines: string[] = [
    `staged write ${row.id} [${row.status}] — proposed by ${row.proposedBy} (${row.kind})`
  ]

  if (row.kind === 'propose_correction') {
    const payload = correctionPayload(row)
    const label = assertLabel(row.targetLabel, 'correction target')
    const targetId = row.targetId ?? ''
    lines.push(`PATCH ${label} ${targetId}`, `reason: ${payload.reason}`)
    const keys = Object.keys(payload.patch)
    const current = new Map<string, unknown>()
    for (const key of keys) {
      if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(key)) continue
      const rows = await deps.engine.cypher(`MATCH (n:${label} {id: $id}) RETURN n.${key} AS v LIMIT 1`, {
        id: targetId
      })
      current.set(key, rows[0]?.['v'] ?? null)
    }
    for (const key of keys) {
      lines.push(`  ~ ${key}: ${show(current.get(key))} → ${show(payload.patch[key])}`)
    }
    return lines.join('\n')
  }

  if (row.kind === 'extraction') {
    const payload = extractionPayload(row)
    lines.push(
      payload.node !== null
        ? `${payload.op === 'create' ? '+ CREATE' : '~ MERGE'} ${payload.node.label} ${payload.node.id}`
        : `~ MERGE onto existing ${row.targetLabel ?? '?'} ${row.targetId ?? '?'} (evidence only — content untouched)`
    )
    if (payload.node !== null) {
      for (const [key, value] of Object.entries(payload.node.props)) lines.push(`    ${key}: ${show(value)}`)
      if (payload.embedOnCommit) lines.push('    (embedding computed at commit)')
    }
    for (const tag of payload.tagCreates) lines.push(`  + Tag ${tag.id} ('${tag.name}')`)
    for (const edge of payload.edges) {
      lines.push(`  + (${edge.from.label} ${edge.from.id})-[:${edge.type}]->(${edge.to.label} ${edge.to.id})`)
    }
    lines.push(
      `provenance: ${payload.provenance.extracted_by} confidence ${payload.provenance.confidence}`,
      `evidence: ${payload.evidence}`,
      `reason: ${payload.reason}`
    )
    return lines.join('\n')
  }

  if (row.kind === SKILL_IMPROVEMENT_STAGED_KIND) {
    lines.push(renderSkillImprovementDiff(skillPayload(row)))
    return lines.join('\n')
  }

  lines.push(`(unknown kind — raw payload) ${JSON.stringify(row.payload)}`)
  return lines.join('\n')
}

// ── approve / reject ──────────────────────────────────────────────────────────

export interface ApproveResult {
  readonly id: string
  readonly status: 'committed'
  /** The audit action carrying the reversible delta of the commit. */
  readonly auditActionId: string
}

export async function approveStagedWrite(
  deps: StagedWritesDeps,
  id: string,
  options: { decidedBy: string }
): Promise<ApproveResult> {
  const row = requireRow(deps.db, id)
  if (row.status !== 'staged' && row.status !== 'approved') {
    throw new StagedWriteError('INVALID_STATE', `staged write ${id} is '${row.status}' — only staged/approved rows can commit`)
  }
  if (row.status === 'staged') {
    deps.db
      .prepare(
        `UPDATE staged_writes SET status = 'approved', decided_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?`
      )
      .run(id)
  }

  let auditActionId: string
  try {
    auditActionId =
      row.kind === 'propose_correction'
        ? await commitCorrection(deps, row)
        : row.kind === 'extraction'
          ? await commitExtraction(deps, row)
          : row.kind === SKILL_IMPROVEMENT_STAGED_KIND
            ? await commitSkillImprovement(deps, row, options.decidedBy)
            : raise(new StagedWriteError('INVALID_PAYLOAD', `staged write ${id} has unknown kind '${row.kind}'`))
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    deps.db
      .prepare(`UPDATE staged_writes SET validation_json = ? WHERE id = ?`)
      .run(JSON.stringify({ decidedBy: options.decidedBy, commitError: message }), id)
    throw err instanceof StagedWriteError ? err : new StagedWriteError('COMMIT_FAILED', message)
  }

  deps.db
    .prepare(
      `UPDATE staged_writes SET status = 'committed', committed_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'),
       validation_json = ? WHERE id = ?`
    )
    .run(JSON.stringify({ decidedBy: options.decidedBy, auditActionId }), id)
  return { id, status: 'committed', auditActionId }
}

export function rejectStagedWrite(
  db: BetterSqlite3.Database,
  id: string,
  options: { decidedBy: string; reason?: string }
): void {
  const row = requireRow(db, id)
  if (row.status !== 'staged') {
    throw new StagedWriteError('INVALID_STATE', `staged write ${id} is '${row.status}' — only staged rows can be rejected`)
  }
  // The ONLY effect of a rejection: the row's own status. The graph never
  // hears about it — no trace beyond the log (§13; DoD-pinned). (The
  // skill-improvement kind additionally retires its recorded candidate —
  // callers with graph access use rejectStagedWriteWithEffects.)
  db.prepare(
    `UPDATE staged_writes SET status = 'rejected', decided_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'),
     validation_json = ? WHERE id = ?`
  ).run(JSON.stringify({ decidedBy: options.decidedBy, ...(options.reason !== undefined ? { reason: options.reason } : {}) }), id)
}

/**
 * Reject with kind-specific cleanup: correction/extraction rows behave
 * exactly like rejectStagedWrite (graph untouched); a 'skill-improvement'
 * row additionally retires its already-recorded candidate SkillVersion
 * (audited) and records the ledger decision, so no orphaned 'candidate'
 * version lingers in the graph.
 */
export async function rejectStagedWriteWithEffects(
  deps: StagedWritesDeps,
  id: string,
  options: { decidedBy: string; reason?: string }
): Promise<void> {
  const row = requireRow(deps.db, id)
  rejectStagedWrite(deps.db, id, options)
  if (row.kind !== SKILL_IMPROVEMENT_STAGED_KIND) return
  await cleanupRejectedSkillImprovement(skillLifecycleDeps(deps), skillPayload(row), options)
}

// ── committers (ONE audited lane job each) ───────────────────────────────────

async function commitCorrection(deps: StagedWritesDeps, row: StagedWriteRow): Promise<string> {
  const payload = correctionPayload(row)
  const label = assertLabel(row.targetLabel, 'correction target')
  const targetId = row.targetId
  if (targetId === null || targetId === '') {
    throw new StagedWriteError('INVALID_PAYLOAD', `correction ${row.id} has no target id`)
  }
  const patchKeys = Object.keys(payload.patch)
  if (patchKeys.length === 0) {
    throw new StagedWriteError('INVALID_PAYLOAD', `correction ${row.id} has an empty patch`)
  }
  const banned = patchKeys.filter((k) => (PROTECTED_PATCH_KEYS as readonly string[]).includes(k))
  if (banned.length > 0) {
    // Defense in depth: the propose tool already refuses these; a row edited
    // out-of-band must not slip identity/provenance rewrites through commit.
    throw new StagedWriteError('INVALID_PAYLOAD', `correction ${row.id} patches protected keys (${banned.join(', ')})`)
  }
  const exists = await deps.engine.cypher(`MATCH (n:${label} {id: $id}) RETURN n.id AS id LIMIT 1`, { id: targetId })
  if (exists.length === 0) {
    throw new StagedWriteError('COMMIT_FAILED', `correction target ${label} ${targetId} no longer exists`)
  }
  const { actionId } = await deps.audit.graphWrite(
    row.proposedBy,
    `staged correction ${row.id}: patch ${label} ${targetId}`,
    async (tx) => {
      await tx.upsertNode(label, { id: targetId, ...payload.patch })
    }
  )
  return actionId
}

async function commitExtraction(deps: StagedWritesDeps, row: StagedWriteRow): Promise<string> {
  const payload = extractionPayload(row)

  // Embeddings are never staged (statements are); new retrievable nodes embed
  // at commit time with the ONE embedding model (§18).
  let embedding: number[] | null = null
  if (payload.node !== null && payload.op === 'create' && payload.embedOnCommit) {
    if (deps.embedder === undefined) {
      throw new StagedWriteError(
        'COMMIT_FAILED',
        `staged write ${row.id} needs an embedding at commit but no embedder is configured (is Ollama running?)`
      )
    }
    const statement = payload.node.props['statement']
    if (typeof statement !== 'string' || statement === '') {
      throw new StagedWriteError('INVALID_PAYLOAD', `staged write ${row.id} marks embedOnCommit but has no statement`)
    }
    const vectors = await deps.embedder.embed([statement])
    embedding = vectors[0] ?? null
    if (embedding === null) throw new StagedWriteError('COMMIT_FAILED', 'embedder returned no vector')
  }

  const { actionId } = await deps.audit.graphWrite(
    row.proposedBy,
    `staged extraction ${row.id}: ${payload.op} ${row.targetLabel ?? '?'} ${row.targetId ?? '?'}`,
    async (tx) => {
      for (const tag of payload.tagCreates) {
        await tx.upsertNode('Tag', { id: tag.id, name: tag.name, is_global: false })
      }
      if (payload.node !== null) {
        await tx.upsertNode(payload.node.label, {
          ...payload.node.props,
          id: payload.node.id,
          ...(embedding !== null ? { embedding } : {})
        })
      }
      for (const edge of payload.edges) {
        await tx.createEdge(edge.type, edge.from, edge.to, edge.props)
      }
    }
  )
  return actionId
}

async function commitSkillImprovement(deps: StagedWritesDeps, row: StagedWriteRow, decidedBy: string): Promise<string> {
  const payload = skillPayload(row)
  try {
    return await commitSkillImprovementApproval(skillLifecycleDeps(deps), payload, { decidedBy })
  } catch (err) {
    if (err instanceof SkillImprovementError) {
      const code = err.code === 'NOT_FOUND' ? 'COMMIT_FAILED' : err.code === 'INVALID_INPUT' ? 'INVALID_PAYLOAD' : 'COMMIT_FAILED'
      throw new StagedWriteError(code, err.message)
    }
    throw err
  }
}

function skillLifecycleDeps(deps: StagedWritesDeps): SkillLifecycleDeps {
  return {
    engine: deps.engine,
    db: deps.db,
    audit: deps.audit,
    ...(deps.embedder !== undefined ? { embedder: deps.embedder } : {})
  }
}

function skillPayload(row: StagedWriteRow) {
  try {
    return decodeSkillImprovementPayload(row.payload, `staged write ${row.id}`)
  } catch (err) {
    throw new StagedWriteError('INVALID_PAYLOAD', err instanceof Error ? err.message : String(err))
  }
}

// ── decode / validate helpers ─────────────────────────────────────────────────

interface RawStagedRow {
  id: string
  proposed_by: string
  kind: string
  target_label: string | null
  target_id: string | null
  payload_json: string
  status: StagedWriteStatus
  validation_json: string | null
  created_at: string
  decided_at: string | null
  committed_at: string | null
}

function decodeRow(row: RawStagedRow): StagedWriteRow {
  return {
    id: row.id,
    proposedBy: row.proposed_by,
    kind: row.kind,
    targetLabel: row.target_label,
    targetId: row.target_id,
    payload: JSON.parse(row.payload_json) as Record<string, unknown>,
    status: row.status,
    validation: row.validation_json === null ? null : (JSON.parse(row.validation_json) as Record<string, unknown>),
    createdAt: row.created_at,
    decidedAt: row.decided_at,
    committedAt: row.committed_at
  }
}

function requireRow(db: BetterSqlite3.Database, id: string): StagedWriteRow {
  const row = getStagedWrite(db, id)
  if (row === undefined) throw new StagedWriteError('NOT_FOUND', `staged write ${id} does not exist`)
  return row
}

function correctionPayload(row: StagedWriteRow): CorrectionPayload {
  const patch = row.payload['patch']
  const reason = row.payload['reason']
  if (patch === null || typeof patch !== 'object' || Array.isArray(patch) || typeof reason !== 'string') {
    throw new StagedWriteError('INVALID_PAYLOAD', `staged write ${row.id} is not a valid correction payload`)
  }
  return { patch: patch as Record<string, unknown>, reason }
}

function extractionPayload(row: StagedWriteRow): ExtractionPayload {
  const p = row.payload
  const op = p['op']
  if (op !== 'create' && op !== 'merge') {
    throw new StagedWriteError('INVALID_PAYLOAD', `staged write ${row.id}: op must be create|merge`)
  }
  const nodeRaw = p['node']
  let node: ExtractionPayload['node'] = null
  if (nodeRaw !== null && nodeRaw !== undefined) {
    const n = nodeRaw as { label?: unknown; id?: unknown; props?: unknown }
    const label = assertLabel(n.label, `staged write ${row.id} node`)
    if (typeof n.id !== 'string' || n.id === '' || n.props === null || typeof n.props !== 'object') {
      throw new StagedWriteError('INVALID_PAYLOAD', `staged write ${row.id}: malformed node`)
    }
    node = { label, id: n.id, props: n.props as Record<string, unknown> }
  }
  const edgesRaw = Array.isArray(p['edges']) ? (p['edges'] as unknown[]) : []
  const edges = edgesRaw.map((e, i): ExtractionEdge => {
    const edge = e as { type?: unknown; from?: unknown; to?: unknown; props?: unknown }
    const type = assertEdgeType(edge.type, `staged write ${row.id} edge[${i}]`)
    const from = edge.from as { label?: unknown; id?: unknown }
    const to = edge.to as { label?: unknown; id?: unknown }
    const fromLabel = assertLabel(from?.label, `staged write ${row.id} edge[${i}].from`)
    const toLabel = assertLabel(to?.label, `staged write ${row.id} edge[${i}].to`)
    if (typeof from?.id !== 'string' || typeof to?.id !== 'string') {
      throw new StagedWriteError('INVALID_PAYLOAD', `staged write ${row.id}: edge[${i}] endpoints need ids`)
    }
    return {
      type,
      from: { label: fromLabel, id: from.id },
      to: { label: toLabel, id: to.id },
      props: (edge.props ?? {}) as ExtractionEdge['props']
    }
  })
  const tagsRaw = Array.isArray(p['tagCreates']) ? (p['tagCreates'] as unknown[]) : []
  const tagCreates = tagsRaw.map((t, i) => {
    const tag = t as { id?: unknown; name?: unknown }
    if (typeof tag.id !== 'string' || typeof tag.name !== 'string') {
      throw new StagedWriteError('INVALID_PAYLOAD', `staged write ${row.id}: tagCreates[${i}] malformed`)
    }
    return { id: tag.id, name: tag.name }
  })
  const provenance = (p['provenance'] ?? {}) as { extracted_by?: unknown; confidence?: unknown }
  return {
    op,
    node,
    embedOnCommit: p['embedOnCommit'] === true,
    edges,
    tagCreates,
    provenance: {
      extracted_by: typeof provenance.extracted_by === 'string' ? provenance.extracted_by : 'unknown',
      confidence: typeof provenance.confidence === 'number' ? provenance.confidence : 0
    },
    evidence: typeof p['evidence'] === 'string' ? p['evidence'] : '',
    reason: typeof p['reason'] === 'string' ? p['reason'] : '',
    session: typeof p['session'] === 'string' ? p['session'] : ''
  }
}

function show(value: unknown): string {
  if (value === null || value === undefined) return '(unset)'
  if (value instanceof Date) return value.toISOString()
  if (typeof value === 'string') return `'${value.length > 120 ? value.slice(0, 117) + '…' : value}'`
  return JSON.stringify(value)
}

function raise(err: Error): never {
  throw err
}
