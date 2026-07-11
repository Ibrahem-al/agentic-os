/**
 * Staged-writes lifecycle (§13, phase 09): propose → human-readable diff →
 * approve (commit via the single write lane, audited) / reject.
 *
 * Five proposers feed `staged_writes` (appdata.db):
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
 *  - codebase skill extraction (kind 'skill-import', feature A / Stage 3): a
 *    SKILL.md / .claude command / LLM-proposed skill discovered while ingesting
 *    a repo. A skill becomes standing instructions served over get_skill, so it
 *    is DATA that must pass the injection scanner and a human before it goes
 *    live (§21 rule 5). Approve, mode create = one audited base-Skill import
 *    (importSkill; embedding computed at commit — P1.7); mode revision = a
 *    stamped candidate SkillVersion, NEVER auto-adopted. Reject leaves no
 *    residue beyond the log (nothing was ever written to the graph).
 *  - memory dedupe (kind 'dedupe-merge', proposer `claude-mcp:<session>` via the
 *    propose_dedupe_merge tool): a proposed MERGE of duplicate memory nodes
 *    (Preference/Knowledge/Tag) onto a keeper. Claude never merges directly
 *    (§21 rule 6); approval runs the SAME audited mergeDuplicates the dashboard
 *    uses (re-points edges + deletes the removed nodes — undoable). Reject
 *    leaves no residue beyond the log.
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
import { randomUUID } from 'node:crypto'
import type BetterSqlite3 from 'better-sqlite3'
import { PROJECT_SKILL_EXTRACTION_PROVENANCE } from '../config'
import {
  SKILL_IMPROVEMENT_STAGED_KIND,
  candidateVersionIdOf,
  cleanupRejectedSkillImprovement,
  commitSkillImprovementApproval,
  decodeSkillImprovementPayload,
  diffLines,
  importSkill,
  recordCandidateVersion,
  renderSkillImprovementDiff,
  skillEmbedText,
  type SkillLifecycleDeps
} from '../agents/skills/lifecycle'
import { SkillImprovementError } from '../agents/skills/types'
import { MemoryEditError, mergeDuplicates } from '../memory'
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

/**
 * §9.2 preflight (P1.7): does approving this staged row need a live embedder at
 * commit time? True for EXACTLY the case `commitExtraction` embeds — an
 * extraction `create` of a retrievable node marked `embedOnCommit` — so the
 * approve UI can preflight `OllamaClient.status()` and WARN (never block) when
 * Ollama is down at click time (esp. under stageAll, where a batch of new
 * Preferences all need a vector at commit). A non-throwing read over the raw
 * payload: correction/skill-improvement rows and merge/`embedOnCommit:false`
 * extractions are always false.
 */
export function stagedWriteRequiresEmbedder(row: Pick<StagedWriteRow, 'kind' | 'payload'>): boolean {
  if (row.kind === SKILL_IMPORT_STAGED_KIND) {
    // A create commits a fresh Skill whose embedding is computed at commit time
    // (P1.7 — like an extraction create); a revision only records a candidate
    // SkillVersion (no Skill re-embed), so it needs no embedder.
    return row.payload['mode'] === 'create'
  }
  if (row.kind !== 'extraction') return false
  const p = row.payload
  return p['op'] === 'create' && p['embedOnCommit'] === true && p['node'] !== null && p['node'] !== undefined
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

  if (row.kind === SKILL_IMPORT_STAGED_KIND) {
    const payload = decodeSkillImportPayload(row.payload, `staged write ${row.id}`)
    lines.push(
      payload.mode === 'create'
        ? `+ NEW SKILL '${payload.name}' from project ${payload.projectName || payload.projectId}`
        : `~ REVISION candidate for skill '${payload.name}' (${payload.skillId}) — recorded, NOT auto-adopted`,
      `source: ${payload.source}`,
      `confidence: ${payload.confidence} (${payload.proposal ? 'LLM proposal' : 'artifact'})`
    )
    if (payload.injectionFlagged) {
      lines.push('⚠ the injection scanner flagged this content — it is stored as inert data; review before approving')
    }
    if (payload.mode === 'revision') {
      const cur = await deps.engine.cypher('MATCH (s:Skill {id: $id}) RETURN s.instructions AS ins LIMIT 1', {
        id: payload.skillId
      })
      const active = typeof cur[0]?.['ins'] === 'string' ? String(cur[0]!['ins']) : ''
      lines.push('', 'instructions diff (active → candidate):', ...diffLines(active, payload.instructions))
    } else {
      lines.push('', 'instructions:', ...payload.instructions.split('\n').map((l) => `  ${l}`))
    }
    return lines.join('\n')
  }

  if (row.kind === DEDUPE_MERGE_STAGED_KIND) {
    const payload = decodeDedupeMergePayload(row.payload, `staged write ${row.id}`)
    // Plain sentences (§13 "user-visible diff"): keep one, remove the rest.
    lines.push(
      `Merge ${payload.removeIds.length} duplicate ${payload.label}${payload.removeIds.length === 1 ? '' : 's'} into one.`,
      `Keep '${payload.keepDisplay}' (${payload.keepId}).`,
      `Remove ${payload.removeIds.length} duplicate${payload.removeIds.length === 1 ? '' : 's'}:`
    )
    for (const removal of payload.displays) lines.push(`  - '${removal.display}' (${removal.id})`)
    lines.push("Each removed node's edges move onto the kept node; this is undoable from History.")
    if (payload.rationale !== '') lines.push(`rationale: ${payload.rationale}`)
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
            : row.kind === SKILL_IMPORT_STAGED_KIND
              ? await commitSkillImport(deps, row)
              : row.kind === DEDUPE_MERGE_STAGED_KIND
                ? await commitDedupeMerge(deps, row)
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

// ── the 'skill-import' staged-write kind (feature A / Stage 3) ────────────────

/** staged_writes.kind for a project skill discovered during codebase ingest. */
export const SKILL_IMPORT_STAGED_KIND = 'skill-import'

export interface SkillImportPayload {
  /** Skill display name (SKILL.md frontmatter name, or `cmd-<file>` for a command). */
  readonly name: string
  /** Full SKILL.md text / command body (verbatim) — the skill's instructions. */
  readonly instructions: string
  /** Where it was found (repo-relative path, or `llm-proposal:<name>`). */
  readonly source: string
  readonly projectId: string
  readonly projectName: string
  /** sha256 of `${name}\n\n${instructions}` — the re-ingest dedup key. */
  readonly contentHash: string
  /** True for an LLM proposal (confidence 0.6), false for a deterministic artifact (1.0). */
  readonly proposal: boolean
  /** create = new Skill; revision = same-name Skill exists → candidate version only. */
  readonly mode: 'create' | 'revision'
  /** create: the new `skl-…` id; revision: the existing Skill's id. */
  readonly skillId: string
  readonly confidence: number
  /** The injection scanner flagged the instructions (advisory — never blocks). */
  readonly injectionFlagged: boolean
}

export function decodeSkillImportPayload(payload: Record<string, unknown>, context: string): SkillImportPayload {
  const str = (key: string): string => {
    const value = payload[key]
    if (typeof value !== 'string' || value === '') {
      throw new StagedWriteError('INVALID_PAYLOAD', `${context}: field '${key}' must be a non-empty string`)
    }
    return value
  }
  const mode = payload['mode'] === 'revision' ? 'revision' : 'create'
  return {
    name: str('name'),
    instructions: str('instructions'),
    source: typeof payload['source'] === 'string' ? payload['source'] : '',
    projectId: str('projectId'),
    projectName: typeof payload['projectName'] === 'string' ? payload['projectName'] : '',
    contentHash: typeof payload['contentHash'] === 'string' ? payload['contentHash'] : '',
    proposal: payload['proposal'] === true,
    mode,
    skillId: str('skillId'),
    confidence: typeof payload['confidence'] === 'number' ? payload['confidence'] : mode === 'create' ? 1 : 0.6,
    injectionFlagged: payload['injectionFlagged'] === true
  }
}

/**
 * Content hashes of every skill-import row NOT rejected (staged/approved/
 * committed) — the re-ingest dedup source: an identical SKILL.md already
 * staged-or-live is skipped, but a previously REJECTED one may be re-proposed.
 */
export function stagedSkillImportHashes(db: BetterSqlite3.Database): Set<string> {
  const rows = db
    .prepare(`SELECT payload_json FROM staged_writes WHERE kind = ? AND status IN ('staged', 'approved', 'committed')`)
    .all(SKILL_IMPORT_STAGED_KIND) as { payload_json: string }[]
  const hashes = new Set<string>()
  for (const row of rows) {
    try {
      const payload = JSON.parse(row.payload_json) as Record<string, unknown>
      if (typeof payload['contentHash'] === 'string' && payload['contentHash'] !== '') hashes.add(payload['contentHash'])
    } catch {
      // a malformed row can't match a fresh candidate's hash — skip it
    }
  }
  return hashes
}

/** Insert a skill-import staged row (random id — a rejected same-hash row may re-stage). */
export function stageSkillImport(db: BetterSqlite3.Database, proposedBy: string, payload: SkillImportPayload): string {
  const id = `sw-skimport-${randomUUID().slice(0, 16)}`
  db.prepare(
    `INSERT INTO staged_writes (id, proposed_by, kind, target_label, target_id, payload_json)
     VALUES (?, ?, ?, 'Skill', ?, ?)`
  ).run(id, proposedBy, SKILL_IMPORT_STAGED_KIND, payload.skillId, JSON.stringify(payload))
  return id
}

/**
 * Approve committer: mode create → one audited base-Skill import (importSkill;
 * Skill + active SkillVersion + HAS_VERSION + Project USES, embedding computed
 * HERE at commit — P1.7, provenance `project-skill-extraction@0.0.1` on the
 * edges). Mode revision → a stamped candidate SkillVersion (recordCandidateVersion,
 * status candidate) — NEVER auto-adopted; the user adopts it from the Skills
 * panel / improvement loop. The commit is attributed to the ingest proposer.
 */
async function commitSkillImport(deps: StagedWritesDeps, row: StagedWriteRow): Promise<string> {
  const payload = decodeSkillImportPayload(row.payload, `staged write ${row.id}`)
  const provenance = { extracted_by: PROJECT_SKILL_EXTRACTION_PROVENANCE, confidence: payload.confidence }

  if (payload.mode === 'revision') {
    const versionId = candidateVersionIdOf(payload.skillId, payload.instructions)
    const { auditActionId } = await recordCandidateVersion(skillLifecycleDeps(deps), {
      skillId: payload.skillId,
      candidateVersionId: versionId,
      instructions: payload.instructions,
      benchmarkScore: null,
      status: 'candidate',
      agentId: row.proposedBy,
      extractedBy: PROJECT_SKILL_EXTRACTION_PROVENANCE,
      edgeConfidence: payload.confidence,
      description: `skill-import: record revision candidate ${versionId} for skill ${payload.skillId} ('${payload.name}') — NOT auto-adopted`
    })
    return auditActionId
  }

  if (deps.embedder === undefined) {
    throw new StagedWriteError(
      'COMMIT_FAILED',
      `staged write ${row.id} creates a Skill (embedded at commit) but no embedder is configured (is Ollama running?)`
    )
  }
  const vectors = await deps.embedder.embed([skillEmbedText(payload.name, payload.instructions)])
  const embedding = vectors[0]
  if (embedding === undefined) throw new StagedWriteError('COMMIT_FAILED', 'embedder returned no vector for the skill')

  const { auditActionId } = await importSkill(
    { audit: deps.audit },
    {
      skillId: payload.skillId,
      name: payload.name,
      instructions: payload.instructions,
      embedding,
      projectId: payload.projectId,
      provenance,
      agentId: row.proposedBy,
      description: `skill-import: create Skill ${payload.skillId} ('${payload.name}') from ${payload.projectName || payload.projectId}`
    }
  )
  return auditActionId
}

// ── the 'dedupe-merge' staged-write kind (dashboard dedupe over MCP) ──────────

/** staged_writes.kind for a memory de-duplication merge proposed over MCP. */
export const DEDUPE_MERGE_STAGED_KIND = 'dedupe-merge'

export interface DedupeMergePayload {
  /** Node label being merged (Preference | Knowledge | Tag — mergeDuplicates re-checks). */
  readonly label: string
  /** The surviving node. */
  readonly keepId: string
  /** The nodes folded into the keeper. */
  readonly removeIds: readonly string[]
  /** Human handle of the keeper (for the review diff — resolved at propose time). */
  readonly keepDisplay: string
  /** Human handle of each removed node (for the review diff). */
  readonly displays: readonly { readonly id: string; readonly display: string }[]
  readonly rationale: string
}

export function decodeDedupeMergePayload(payload: Record<string, unknown>, context: string): DedupeMergePayload {
  const label = payload['label']
  const keepId = payload['keepId']
  if (typeof label !== 'string' || label === '') {
    throw new StagedWriteError('INVALID_PAYLOAD', `${context}: 'label' must be a non-empty string`)
  }
  if (typeof keepId !== 'string' || keepId === '') {
    throw new StagedWriteError('INVALID_PAYLOAD', `${context}: 'keepId' must be a non-empty string`)
  }
  const removeRaw = Array.isArray(payload['removeIds']) ? (payload['removeIds'] as unknown[]) : []
  const removeIds = removeRaw.filter((v): v is string => typeof v === 'string' && v !== '')
  if (removeIds.length === 0) {
    throw new StagedWriteError('INVALID_PAYLOAD', `${context}: 'removeIds' must list at least one node id`)
  }
  const displaysRaw = Array.isArray(payload['displays']) ? (payload['displays'] as unknown[]) : []
  const displays = displaysRaw
    .map((d) => (d !== null && typeof d === 'object' ? (d as { id?: unknown; display?: unknown }) : {}))
    .filter((d): d is { id: string; display: string } => typeof d.id === 'string' && typeof d.display === 'string')
  return {
    label,
    keepId,
    removeIds,
    keepDisplay: typeof payload['keepDisplay'] === 'string' ? payload['keepDisplay'] : keepId,
    displays: displays.length > 0 ? displays : removeIds.map((id) => ({ id, display: id })),
    rationale: typeof payload['rationale'] === 'string' ? payload['rationale'] : ''
  }
}

/** Insert a dedupe-merge staged row (random id — a merge is never de-duplicated). */
export function stageDedupeMerge(db: BetterSqlite3.Database, proposedBy: string, payload: DedupeMergePayload): string {
  const id = `sw-dedupe-${randomUUID().slice(0, 16)}`
  db.prepare(
    `INSERT INTO staged_writes (id, proposed_by, kind, target_label, target_id, payload_json)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(id, proposedBy, DEDUPE_MERGE_STAGED_KIND, payload.label, payload.keepId, JSON.stringify(payload))
  return id
}

/**
 * Approve committer: run the SAME audited mergeDuplicates the dashboard uses
 * (no embedder needed — a merge re-points edges + deletes nodes, never
 * re-embeds; stagedWriteRequiresEmbedder returns false for this kind).
 * mergeDuplicates re-validates existence at commit, so a node deleted since
 * staging fails cleanly. Attributed to the proposer (§13).
 */
async function commitDedupeMerge(deps: StagedWritesDeps, row: StagedWriteRow): Promise<string> {
  const payload = decodeDedupeMergePayload(row.payload, `staged write ${row.id}`)
  try {
    const result = await mergeDuplicates(
      { engine: deps.engine, audit: deps.audit, actor: row.proposedBy },
      { label: payload.label, keepId: payload.keepId, removeIds: payload.removeIds }
    )
    return result.auditActionId
  } catch (err) {
    if (err instanceof MemoryEditError) {
      throw new StagedWriteError(err.code === 'NOT_FOUND' ? 'COMMIT_FAILED' : 'INVALID_PAYLOAD', err.message)
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
