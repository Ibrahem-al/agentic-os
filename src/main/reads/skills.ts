/**
 * Skill reads (§4.B) — the shared source for the dashboard's `skills.detail`
 * and `skills.improvement` IPC handlers AND the `get_skill_full` /
 * `get_skill_signal` MCP read tools.
 *
 *  - getSkillDetail / getSkillImprovement: extracted verbatim from `ipc.ts`
 *    (behavior-identical after the wire refactor).
 *  - getSkillFull: the tool payload = detail + the improvement ledger.
 *  - getSkillSignal: the §17/§20 event-gate signal, read-only — the same
 *    `collectSignal` + `hasPendingReview` the nightly plan uses.
 */
import type BetterSqlite3 from 'better-sqlite3'
import type {
  SkillDetailDto,
  SkillImprovementDto,
  SkillImprovementEntryDto
} from '../../shared/ipc'
import {
  collectSignal,
  getSkillSettings,
  hasPendingReview,
  latestStandingAdoption,
  listImprovements,
  type ImprovementRow
} from '../agents'
import { IngestError } from '../ingest'
import type { StorageEngine } from '../storage'
import { jsonObject } from './serialize'
import type { SkillFullDto, SkillSignalDto, SkillSignalItemDto } from './types'

/** One ledger row → its shipped DTO (shared by detail + pending-work). */
export function improvementEntryDto(row: ImprovementRow): SkillImprovementEntryDto {
  return {
    id: row.id,
    candidateVersionId: row.candidateVersionId,
    predecessorVersionId: row.predecessorVersionId,
    mode: row.mode,
    outcome: row.outcome,
    reason: row.reason,
    createdAt: row.createdAt,
    adoptedAt: row.adoptedAt,
    rolledBackAt: row.rolledBackAt,
    driftFlaggedAt: row.driftFlaggedAt,
    driftResolvedAt: row.driftResolvedAt,
    benchmark: jsonObject(row.benchmark),
    drift: row.drift === null ? null : jsonObject(row.drift)
  }
}

/** The graph-side skill detail (versions/examples/corrections) — ipc skills.detail. */
export async function getSkillDetail(engine: StorageEngine, { id }: { id: string }): Promise<SkillDetailDto> {
  const skillRows = await engine.cypher(
    `MATCH (s:Skill {id: $id}) RETURN s.id AS id, s.name AS name, s.instructions AS instructions,
     s.current_version AS current_version LIMIT 1`,
    { id }
  )
  const skill = skillRows[0]
  if (skill === undefined) throw new IngestError('NOT_FOUND', `Skill ${id} does not exist`)
  const versionRows = await engine.cypher(
    `MATCH (s:Skill {id: $id})-[:HAS_VERSION]->(v:SkillVersion)
     RETURN v.id AS id, v.status AS status, v.benchmark_score AS score, v.instructions AS instructions,
            v.created_at AS created_at ORDER BY v.created_at DESC LIMIT 20`,
    { id }
  )
  const exampleRows = await engine.cypher(
    `MATCH (s:Skill {id: $id})-[:HAS_EXAMPLE]->(e:Example)
     RETURN e.id AS id, e.kind AS kind, e.content AS content ORDER BY e.created_at DESC LIMIT 20`,
    { id }
  )
  const correctionRows = await engine.cypher(
    `MATCH (c:Correction)-[:IMPROVED]->(s:Skill {id: $id})
     RETURN c.id AS id, c.content AS content ORDER BY c.created_at DESC LIMIT 20`,
    { id }
  )
  return {
    id: String(skill['id']),
    name: String(skill['name'] ?? skill['id']),
    instructions: String(skill['instructions'] ?? ''),
    currentVersion: skill['current_version'] == null ? null : String(skill['current_version']),
    versions: versionRows.map((row) => ({
      id: String(row['id']),
      status: String(row['status'] ?? 'unknown'),
      benchmarkScore: typeof row['score'] === 'number' ? row['score'] : null,
      instructions: String(row['instructions'] ?? ''),
      createdAt: row['created_at'] instanceof Date ? row['created_at'].toISOString() : null
    })),
    examples: exampleRows.map((row) => ({
      id: String(row['id']),
      kind: String(row['kind'] ?? 'unknown'),
      content: String(row['content'] ?? '')
    })),
    corrections: correctionRows.map((row) => ({
      id: String(row['id']),
      content: String(row['content'] ?? '')
    }))
  }
}

/** The appdata-side improvement view (settings + ledger) — ipc skills.improvement. */
export function getSkillImprovement(db: BetterSqlite3.Database, { skillId }: { skillId: string }): SkillImprovementDto {
  const settings = getSkillSettings(db, skillId)
  const history = listImprovements(db, skillId).map(improvementEntryDto)
  return {
    skillId,
    settings: { mode: settings.mode, autoRevert: settings.autoRevert, lastRunAt: settings.lastRunAt },
    history,
    canRollback: latestStandingAdoption(db, skillId) !== undefined
  }
}

export interface SkillReadDeps {
  readonly engine: StorageEngine
  readonly db: BetterSqlite3.Database
}

/** get_skill_full: the skill's graph detail plus its improvement ledger. */
export async function getSkillFull(deps: SkillReadDeps, { id }: { id: string }): Promise<SkillFullDto> {
  const detail = await getSkillDetail(deps.engine, { id })
  return { ...detail, improvement: getSkillImprovement(deps.db, { skillId: id }) }
}

const signalItem = (item: { id: string; content: string; createdAt: string | null; isNew: boolean }): SkillSignalItemDto => ({
  id: item.id,
  content: item.content,
  createdAt: item.createdAt,
  isNew: item.isNew
})

/** get_skill_signal: the read-only event-gate signal for one skill (§17/§20). */
export async function getSkillSignal(deps: SkillReadDeps, { skillId }: { skillId: string }): Promise<SkillSignalDto> {
  const settings = getSkillSettings(deps.db, skillId)
  const signal = await collectSignal(deps.engine, skillId, settings.lastRunAt)
  const newSignalCount =
    signal.corrections.filter((c) => c.isNew).length + signal.failureExamples.filter((e) => e.isNew).length
  return {
    skillId,
    lastRunAt: settings.lastRunAt,
    newSignalCount,
    corrections: signal.corrections.map(signalItem),
    failureExamples: signal.failureExamples.map(signalItem),
    hasPendingReview: hasPendingReview(deps.db, skillId)
  }
}
