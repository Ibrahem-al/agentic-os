/**
 * Skill-version lifecycle (§17 step 4 + §18 write path, phase 12): the
 * audited graph mutations behind the adoption gate —
 *
 *   record candidate  → SkillVersion{status: candidate|retired} + HAS_VERSION
 *   adopt             → candidate→active, prior active→retired, Skill updated
 *                       (current_version, instructions, re-embedded)
 *   retire candidate  → a rejected stylistic candidate leaves the queue
 *   rollback          → the adopted version steps down, the predecessor
 *                       returns (§20 drift watch's auto-revert + DoD 3)
 *
 * Every mutation is ONE audited write-lane job (§21 rules 1 + 11): the audit
 * log records the reversible delta, so a bad adoption is undoable from the
 * dashboard too. The adoption flip is deliberately a SEPARATE audit action
 * from the candidate record — undoing/rolling back an adoption keeps the
 * candidate version node as history ("versions retained for rollback").
 *
 * This module has NO runtime security imports (AuditLog crosses as a type
 * only), so security/stagedWrites.ts can import its committers for the
 * 'skill-improvement' staged kind without a module cycle.
 */
import { createHash } from 'node:crypto'
import type BetterSqlite3 from 'better-sqlite3'
import { SKILL_IMPROVEMENT_PROVENANCE } from '../../config'
import type { AuditLog } from '../../security/audit'
import type { StorageEngine } from '../../storage'
import {
  getImprovement,
  latestStandingAdoption,
  markImprovementDecision,
  markImprovementRolledBack
} from './state'
import { SkillImprovementError, type SkillAdoptionMode } from './types'

export const SKILL_IMPROVEMENT_STAGED_KIND = 'skill-improvement'
export const SKILL_IMPROVEMENT_AGENT_ID = 'skill-improvement-agent'

/** Deterministic candidate id: same instructions ⇒ same version identity. */
export function candidateVersionIdOf(skillId: string, instructions: string): string {
  const hash = createHash('sha256').update(instructions, 'utf8').digest('hex').slice(0, 8)
  return `sv-${skillId}-${hash}`
}

/** Deterministic staged-row id (crash-resumed write steps cannot duplicate). */
export function stagedWriteIdOf(candidateVersionId: string): string {
  return `sw-skill-${candidateVersionId}`
}

/**
 * The text a Skill embeds — exactly what retrieval renders for the label
 * (render.ts: joinNonEmpty([name, instructions], ': ')), so the vector index
 * serves back what the read path scores.
 */
export function skillEmbedText(name: string, instructions: string): string {
  return [name, instructions].filter((part) => part !== '').join(': ')
}

export interface SkillLifecycleDeps {
  readonly engine: StorageEngine
  readonly db: BetterSqlite3.Database
  readonly audit: AuditLog
  /** Required for adopt/rollback (the Skill re-embeds); structural (OllamaClient). */
  readonly embedder?: { embed(texts: string[]): Promise<number[][]> }
}

// ── record / retire ──────────────────────────────────────────────────────────

/**
 * Record a candidate SkillVersion + its stamped HAS_VERSION edge (one audited
 * lane job, idempotent upsert). `status` is 'candidate' for versions awaiting
 * adoption or review, 'retired' for verifiable candidates the gate rejected —
 * kept with their benchmark score as honest history.
 */
export async function recordCandidateVersion(
  deps: SkillLifecycleDeps,
  entry: {
    skillId: string
    candidateVersionId: string
    instructions: string
    benchmarkScore: number | null
    status: 'candidate' | 'retired'
    agentId?: string
    /**
     * HAS_VERSION provenance (§21 rule 4). Defaults to the improvement agent's
     * stamp; the Stage-3 skill-import REVISION path passes
     * `project-skill-extraction@0.0.1` + its per-candidate confidence so an
     * imported revision candidate is stamped as an extraction, not an
     * improvement.
     */
    extractedBy?: string
    edgeConfidence?: number | null
    description?: string
  }
): Promise<{ auditActionId: string }> {
  const edgeConfidence = entry.edgeConfidence !== undefined ? entry.edgeConfidence : entry.benchmarkScore
  const { actionId } = await deps.audit.graphWrite(
    entry.agentId ?? SKILL_IMPROVEMENT_AGENT_ID,
    entry.description ??
      `skill-improvement: record ${entry.status} version ${entry.candidateVersionId} for skill ${entry.skillId}`,
    async (tx) => {
      await tx.upsertNode('SkillVersion', {
        id: entry.candidateVersionId,
        instructions: entry.instructions,
        status: entry.status,
        ...(entry.benchmarkScore !== null ? { benchmark_score: entry.benchmarkScore } : {})
      })
      await tx.createEdge(
        'HAS_VERSION',
        { label: 'Skill', id: entry.skillId },
        { label: 'SkillVersion', id: entry.candidateVersionId },
        {
          extracted_by: entry.extractedBy ?? SKILL_IMPROVEMENT_PROVENANCE,
          ...(edgeConfidence !== null ? { confidence: edgeConfidence } : {})
        }
      )
    }
  )
  return { auditActionId: actionId }
}

// ── import (base-Skill creation — dashboard create + Stage-3 skill-import) ────

/** Minimal deps for {@link importSkill} — only the audit log (which owns the lane). */
export interface ImportSkillDeps {
  readonly audit: AuditLog
}

export interface ImportSkillEntry {
  /** Server-generated Skill id (dashboard: `usr-skill-…`; import: `skl-…`). */
  readonly skillId: string
  readonly name: string
  /** Full SKILL.md text (verbatim), stored on both the Skill and its version. */
  readonly instructions: string
  /** Pre-computed by the caller (dashboard: pre-lane; import: at commit). */
  readonly embedding: number[]
  /** When set, links the source Project via Project-[:USES]->Skill (stamped). */
  readonly projectId?: string
  /**
   * Extraction provenance for the written EDGES (HAS_VERSION + USES). Skill and
   * SkillVersion nodes carry NO provenance columns (§18), so the stamp only
   * rides the edges. Omit for a user-authored dashboard create (no stamp).
   */
  readonly provenance?: { readonly extracted_by: string; readonly confidence: number }
  /** Audit actor (§13) + History description subject. */
  readonly agentId: string
  readonly description?: string
}

export interface ImportSkillResult {
  readonly auditActionId: string
  readonly skillId: string
  readonly versionId: string
}

/**
 * The single base-Skill committer (feature A / Stage 3): create a `Skill` + its
 * active `SkillVersion` + `HAS_VERSION` (and, for an import, the Project `USES`
 * link) in ONE audited lane job (§21 rules 1 + 11) — so the reversible delta
 * undoes the whole shape. The version id is `candidateVersionIdOf(skillId,
 * instructions)`, so re-committing identical instructions is idempotent.
 *
 * Both writers of a first-class Skill converge here: the dashboard
 * `memory.node.create` Skill branch (no project link, no provenance — the
 * embedding computed pre-lane) and the staged `skill-import` approve path
 * (Project-linked + stamped — the embedding computed at commit, P1.7).
 */
export async function importSkill(deps: ImportSkillDeps, entry: ImportSkillEntry): Promise<ImportSkillResult> {
  const versionId = candidateVersionIdOf(entry.skillId, entry.instructions)
  const edgeProps =
    entry.provenance !== undefined
      ? { extracted_by: entry.provenance.extracted_by, confidence: entry.provenance.confidence }
      : undefined
  const { actionId } = await deps.audit.graphWrite(
    entry.agentId,
    entry.description ?? `import Skill ${entry.skillId} ('${entry.name}')`,
    async (tx) => {
      await tx.upsertNode('Skill', {
        id: entry.skillId,
        name: entry.name,
        instructions: entry.instructions,
        current_version: versionId,
        embedding: entry.embedding
      })
      await tx.upsertNode('SkillVersion', { id: versionId, instructions: entry.instructions, status: 'active' })
      await tx.createEdge(
        'HAS_VERSION',
        { label: 'Skill', id: entry.skillId },
        { label: 'SkillVersion', id: versionId },
        edgeProps
      )
      if (entry.projectId !== undefined) {
        // The §18 skill↔project edge is Project-[:USES]->Skill (schema
        // REL_TABLES: USES pairs include [Project, Skill]) — stamped like the
        // HAS_VERSION edge so the link is provenance-attributable.
        await tx.createEdge(
          'USES',
          { label: 'Project', id: entry.projectId },
          { label: 'Skill', id: entry.skillId },
          edgeProps
        )
      }
    }
  )
  return { auditActionId: actionId, skillId: entry.skillId, versionId }
}

/** A rejected stylistic candidate retires (audited; the record stays). */
export async function retireCandidateVersion(
  deps: SkillLifecycleDeps,
  entry: { skillId: string; candidateVersionId: string; decidedBy: string; reason: string }
): Promise<{ auditActionId: string }> {
  const { actionId } = await deps.audit.graphWrite(
    entry.decidedBy,
    `skill-improvement: retire candidate ${entry.candidateVersionId} for skill ${entry.skillId} — ${entry.reason}`,
    async (tx) => {
      await tx.upsertNode('SkillVersion', { id: entry.candidateVersionId, status: 'retired' })
    }
  )
  return { auditActionId: actionId }
}

// ── adopt ────────────────────────────────────────────────────────────────────

async function readSkill(
  engine: StorageEngine,
  skillId: string
): Promise<{ id: string; name: string; instructions: string; currentVersion: string | null }> {
  const rows = await engine.cypher(
    `MATCH (s:Skill {id: $id}) RETURN s.id AS id, s.name AS name, s.instructions AS instructions,
     s.current_version AS current_version LIMIT 1`,
    { id: skillId }
  )
  const row = rows[0]
  if (row === undefined) throw new SkillImprovementError('NOT_FOUND', `Skill ${skillId} does not exist`)
  return {
    id: String(row['id']),
    name: String(row['name'] ?? row['id']),
    instructions: String(row['instructions'] ?? ''),
    currentVersion: row['current_version'] == null || row['current_version'] === '' ? null : String(row['current_version'])
  }
}

async function readVersionStatus(engine: StorageEngine, versionId: string): Promise<string | null> {
  const rows = await engine.cypher(`MATCH (v:SkillVersion {id: $id}) RETURN v.status AS status LIMIT 1`, {
    id: versionId
  })
  const row = rows[0]
  return row === undefined ? null : String(row['status'] ?? '')
}

export interface AdoptResult {
  readonly auditActionId: string
  /** Version ids that stepped down from 'active' (empty on a first adoption). */
  readonly retiredVersionIds: readonly string[]
  /** True when the flip had already happened (idempotent retry). */
  readonly alreadyAdopted: boolean
}

/**
 * The §17 adoption flip: candidate→active, prior active→retired, and the
 * Skill node takes the candidate's instructions (current_version + re-embed,
 * so retrieval and get_skill serve the adopted version immediately). ONE
 * audited lane job — its recorded inverse IS a rollback.
 */
export async function adoptSkillVersion(
  deps: SkillLifecycleDeps,
  entry: { skillId: string; candidateVersionId: string; instructions: string; decidedBy: string }
): Promise<AdoptResult> {
  const skill = await readSkill(deps.engine, entry.skillId)
  const candidateStatus = await readVersionStatus(deps.engine, entry.candidateVersionId)
  if (candidateStatus === null) {
    throw new SkillImprovementError('NOT_FOUND', `candidate SkillVersion ${entry.candidateVersionId} does not exist`)
  }
  if (candidateStatus === 'active' && skill.currentVersion === entry.candidateVersionId) {
    // A retried approve after a mid-commit crash: the flip already landed.
    return { auditActionId: '', retiredVersionIds: [], alreadyAdopted: true }
  }
  if (candidateStatus !== 'candidate') {
    throw new SkillImprovementError(
      'INVALID_STATE',
      `SkillVersion ${entry.candidateVersionId} is '${candidateStatus}' — only a candidate can be adopted`
    )
  }
  if (deps.embedder === undefined) {
    throw new SkillImprovementError(
      'INVALID_STATE',
      'adoption re-embeds the Skill but no embedder is configured (is Ollama running?)'
    )
  }
  const activeRows = await deps.engine.cypher(
    `MATCH (s:Skill {id: $id})-[:HAS_VERSION]->(v:SkillVersion) WHERE v.status = 'active'
     RETURN v.id AS id ORDER BY v.id`,
    { id: entry.skillId }
  )
  const retiredVersionIds = activeRows.map((row) => String(row['id'])).filter((id) => id !== entry.candidateVersionId)
  const vectors = await deps.embedder.embed([skillEmbedText(skill.name, entry.instructions)])
  const embedding = vectors[0]
  if (embedding === undefined) throw new SkillImprovementError('INVALID_STATE', 'embedder returned no vector')

  const { actionId } = await deps.audit.graphWrite(
    entry.decidedBy,
    `skill-improvement: adopt ${entry.candidateVersionId} for skill ${entry.skillId} (${retiredVersionIds.length > 0 ? `retiring ${retiredVersionIds.join(', ')}` : 'first adoption'})`,
    async (tx) => {
      for (const versionId of retiredVersionIds) {
        await tx.upsertNode('SkillVersion', { id: versionId, status: 'retired' })
      }
      await tx.upsertNode('SkillVersion', { id: entry.candidateVersionId, status: 'active' })
      await tx.upsertNode('Skill', {
        id: entry.skillId,
        instructions: entry.instructions,
        current_version: entry.candidateVersionId,
        embedding
      })
    }
  )
  return { auditActionId: actionId, retiredVersionIds, alreadyAdopted: false }
}

// ── rollback (DoD 3 + §20 auto-revert) ───────────────────────────────────────

export interface RollbackResult {
  readonly auditActionId: string
  readonly restoredVersionId: string | null
  readonly retiredVersionId: string
}

/**
 * Undo the most recent standing adoption: the adopted version retires, the
 * predecessor (version node when one exists; otherwise the ledger's
 * instructions snapshot) becomes active again, and the Skill re-embeds its
 * restored instructions. Audited like the adoption itself.
 */
export async function rollbackSkillAdoption(
  deps: SkillLifecycleDeps,
  entry: { skillId: string; decidedBy: string; reason?: string }
): Promise<RollbackResult> {
  const adoption = latestStandingAdoption(deps.db, entry.skillId)
  if (adoption === undefined) {
    throw new SkillImprovementError('NOT_FOUND', `skill ${entry.skillId} has no standing adoption to roll back`)
  }
  const skill = await readSkill(deps.engine, entry.skillId)
  if (skill.currentVersion !== adoption.candidateVersionId) {
    throw new SkillImprovementError(
      'INVALID_STATE',
      `skill ${entry.skillId} current_version is '${skill.currentVersion ?? '(none)'}', not the adopted ${adoption.candidateVersionId} — nothing to roll back`
    )
  }
  const restoredInstructions =
    adoption.predecessorInstructions ??
    raiseState(`adoption ${adoption.id} recorded no predecessor snapshot — cannot roll back`)
  if (deps.embedder === undefined) {
    throw new SkillImprovementError(
      'INVALID_STATE',
      'rollback re-embeds the Skill but no embedder is configured (is Ollama running?)'
    )
  }
  const vectors = await deps.embedder.embed([skillEmbedText(skill.name, restoredInstructions)])
  const embedding = vectors[0]
  if (embedding === undefined) throw new SkillImprovementError('INVALID_STATE', 'embedder returned no vector')

  const reason = entry.reason ?? 'operator rollback'
  const { actionId } = await deps.audit.graphWrite(
    entry.decidedBy,
    `skill-improvement: roll back ${adoption.candidateVersionId} for skill ${entry.skillId} (restore ${adoption.predecessorVersionId ?? 'pre-version instructions'}) — ${reason}`,
    async (tx) => {
      await tx.upsertNode('SkillVersion', { id: adoption.candidateVersionId, status: 'retired' })
      if (adoption.predecessorVersionId !== null) {
        await tx.upsertNode('SkillVersion', { id: adoption.predecessorVersionId, status: 'active' })
      }
      await tx.upsertNode('Skill', {
        id: entry.skillId,
        instructions: restoredInstructions,
        current_version: adoption.predecessorVersionId ?? '',
        embedding
      })
    }
  )
  markImprovementRolledBack(deps.db, adoption.id, new Date().toISOString())
  return {
    auditActionId: actionId,
    restoredVersionId: adoption.predecessorVersionId,
    retiredVersionId: adoption.candidateVersionId
  }
}

// ── the 'skill-improvement' staged-write shape (§13 review queue) ────────────

export interface SkillImprovementPayload {
  readonly skillId: string
  readonly skillName: string
  readonly mode: SkillAdoptionMode
  readonly candidateVersionId: string
  readonly predecessorVersionId: string | null
  readonly candidateInstructions: string
  readonly activeInstructions: string
  /** BenchmarkSummary as plain JSON (win/loss/tie counts, scores, notes). */
  readonly benchmark: Record<string, unknown>
  readonly reason: string
}

export function decodeSkillImprovementPayload(
  payload: Record<string, unknown>,
  context: string
): SkillImprovementPayload {
  const str = (key: string): string => {
    const value = payload[key]
    if (typeof value !== 'string' || value === '') {
      throw new SkillImprovementError('INVALID_INPUT', `${context}: payload field '${key}' must be a non-empty string`)
    }
    return value
  }
  const benchmark = payload['benchmark']
  return {
    skillId: str('skillId'),
    skillName: str('skillName'),
    mode: payload['mode'] === 'verifiable' ? 'verifiable' : 'stylistic',
    candidateVersionId: str('candidateVersionId'),
    predecessorVersionId:
      typeof payload['predecessorVersionId'] === 'string' && payload['predecessorVersionId'] !== ''
        ? payload['predecessorVersionId']
        : null,
    candidateInstructions: str('candidateInstructions'),
    activeInstructions: typeof payload['activeInstructions'] === 'string' ? payload['activeInstructions'] : '',
    benchmark:
      benchmark !== null && typeof benchmark === 'object' && !Array.isArray(benchmark)
        ? (benchmark as Record<string, unknown>)
        : {},
    reason: typeof payload['reason'] === 'string' ? payload['reason'] : ''
  }
}

/**
 * Stage a stylistic candidate for one-click review (INSERT OR IGNORE on the
 * deterministic id — a crash-resumed write step cannot duplicate the row).
 */
export function stageSkillImprovement(db: BetterSqlite3.Database, payload: SkillImprovementPayload): string {
  const id = stagedWriteIdOf(payload.candidateVersionId)
  db.prepare(
    `INSERT OR IGNORE INTO staged_writes (id, proposed_by, kind, target_label, target_id, payload_json)
     VALUES (?, ?, ?, 'Skill', ?, ?)`
  ).run(id, SKILL_IMPROVEMENT_AGENT_ID, SKILL_IMPROVEMENT_STAGED_KIND, payload.skillId, JSON.stringify(payload))
  return id
}

/**
 * Approve committer (called by security/stagedWrites for this kind): the
 * audited adoption flip + the ledger decision. Returns the audit action id.
 */
export async function commitSkillImprovementApproval(
  deps: SkillLifecycleDeps,
  payload: SkillImprovementPayload,
  options: { decidedBy: string }
): Promise<string> {
  const result = await adoptSkillVersion(deps, {
    skillId: payload.skillId,
    candidateVersionId: payload.candidateVersionId,
    instructions: payload.candidateInstructions,
    decidedBy: options.decidedBy
  })
  if (getImprovement(deps.db, payload.candidateVersionId) !== undefined) {
    markImprovementDecision(deps.db, payload.candidateVersionId, {
      outcome: 'adopted',
      adoptedAtIso: new Date().toISOString()
    })
  }
  return result.auditActionId
}

/**
 * Reject cleanup (called after the row flips to 'rejected'): the recorded
 * candidate retires (audited) and the ledger records the decision. The graph
 * keeps the version node as history — recorded deviation from the
 * "rejection touches nothing" rule of the other kinds, because this kind's
 * candidate was ALREADY a first-class graph record before review.
 */
export async function cleanupRejectedSkillImprovement(
  deps: SkillLifecycleDeps,
  payload: SkillImprovementPayload,
  options: { decidedBy: string; reason?: string }
): Promise<void> {
  const status = await readVersionStatus(deps.engine, payload.candidateVersionId)
  if (status === 'candidate') {
    await retireCandidateVersion(deps, {
      skillId: payload.skillId,
      candidateVersionId: payload.candidateVersionId,
      decidedBy: options.decidedBy,
      reason: options.reason ?? 'rejected in review'
    })
  }
  if (getImprovement(deps.db, payload.candidateVersionId) !== undefined) {
    markImprovementDecision(deps.db, payload.candidateVersionId, { outcome: 'rejected' })
  }
}

// ── human-readable diff (§13 "user-visible diff before commit") ──────────────

/** Dependency-free LCS line diff (the hookInstaller pattern). */
export function diffLines(before: string, after: string): string[] {
  const a = before.split('\n')
  const b = after.split('\n')
  const n = a.length
  const m = b.length
  // lcs[i][j] = LCS length of a[i..] and b[j..]
  const lcs: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0))
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i]![j] = a[i] === b[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!)
    }
  }
  const out: string[] = []
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      out.push(`  ${a[i]}`)
      i += 1
      j += 1
    } else if (lcs[i + 1]![j]! >= lcs[i]![j + 1]!) {
      out.push(`- ${a[i]}`)
      i += 1
    } else {
      out.push(`+ ${b[j]}`)
      j += 1
    }
  }
  while (i < n) out.push(`- ${a[i++]}`)
  while (j < m) out.push(`+ ${b[j++]}`)
  return out
}

/** The review queue's rendered body for a 'skill-improvement' staged row. */
export function renderSkillImprovementDiff(payload: SkillImprovementPayload): string {
  const lines: string[] = [
    `ADOPT SkillVersion ${payload.candidateVersionId} for Skill ${payload.skillId} ('${payload.skillName}')`,
    `mode: ${payload.mode} — §17: stylistic skills need one-click human approval before adoption`,
    `predecessor: ${payload.predecessorVersionId ?? '(no prior version — first adoption)'}`
  ]
  const summary = payload.benchmark
  const comparisons = summary['comparisons']
  if (comparisons !== null && typeof comparisons === 'object' && !Array.isArray(comparisons)) {
    const c = comparisons as Record<string, unknown>
    lines.push(
      `benchmark (blind A/B on held-out cases): candidate wins ${Number(c['candidateWins'] ?? 0)}, active wins ${Number(c['activeWins'] ?? 0)}, ties ${Number(c['ties'] ?? 0)}`
    )
  }
  const heldout = summary['heldoutScore']
  if (heldout !== null && typeof heldout === 'object' && !Array.isArray(heldout)) {
    const h = heldout as Record<string, unknown>
    lines.push(`held-out pass rate: candidate ${Number(h['candidate'] ?? 0).toFixed(2)} vs active ${Number(h['active'] ?? 0).toFixed(2)}`)
  }
  if (payload.reason !== '') lines.push(`reason: ${payload.reason}`)
  lines.push('', 'instructions diff (active → candidate):')
  lines.push(...diffLines(payload.activeInstructions, payload.candidateInstructions))
  return lines.join('\n')
}

function raiseState(message: string): never {
  throw new SkillImprovementError('INVALID_STATE', message)
}
