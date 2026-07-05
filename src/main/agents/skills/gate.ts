/**
 * Plan step (§17 + §20, phase 12): the EVENT GATE — only skills that accrued
 * new Corrections or failure Examples since their last improvement run are
 * processed (nightly); the manual "improve now" trigger bypasses the
 * new-since-last-run filter but still needs SOME signal to improve from —
 * and the §20 DRIFT SCAN over open watches from previous adoptions.
 *
 * Read-only: the plan computes; the write step applies (flags, reverts,
 * last_run_at). All timestamps compare through the engine's `timestamp($iso)`
 * (the phase-11 prune pattern).
 */
import type BetterSqlite3 from 'better-sqlite3'
import { DRIFT_WATCH_USES, SKILL_IMPROVEMENT_MAX_PER_RUN } from '../../config'
import type { StorageEngine } from '../../storage'
import { SKILL_IMPROVEMENT_STAGED_KIND } from './lifecycle'
import { getSkillSettings, listOpenDriftWatches, type ImprovementRow } from './state'
import {
  SkillImprovementError,
  type DriftFinding,
  type PlanState,
  type SkillSignalCorrection,
  type SkillSignalExample,
  type SkillSkipNote,
  type SkillWorkItem
} from './types'

const toIso = (value: unknown): string | null =>
  value instanceof Date ? value.toISOString() : typeof value === 'string' && value !== '' ? value : null

const isAfter = (iso: string | null, cursor: string | null): boolean => {
  if (iso === null) return false
  if (cursor === null) return true
  return iso > cursor
}

interface SkillRow {
  readonly id: string
  readonly name: string
  readonly instructions: string
  readonly currentVersion: string | null
}

async function listSkills(engine: StorageEngine, skillId?: string): Promise<SkillRow[]> {
  const rows =
    skillId !== undefined
      ? await engine.cypher(
          `MATCH (s:Skill {id: $id}) RETURN s.id AS id, s.name AS name, s.instructions AS instructions,
           s.current_version AS current_version`,
          { id: skillId }
        )
      : await engine.cypher(
          `MATCH (s:Skill) RETURN s.id AS id, s.name AS name, s.instructions AS instructions,
           s.current_version AS current_version ORDER BY s.id`
        )
  return rows.map((row) => ({
    id: String(row['id']),
    name: String(row['name'] ?? row['id']),
    instructions: String(row['instructions'] ?? ''),
    currentVersion: row['current_version'] == null || row['current_version'] === '' ? null : String(row['current_version'])
  }))
}

async function collectSignal(
  engine: StorageEngine,
  skillId: string,
  cursor: string | null
): Promise<{ corrections: SkillSignalCorrection[]; failureExamples: SkillSignalExample[] }> {
  const correctionRows = await engine.cypher(
    `MATCH (c:Correction)-[:IMPROVED]->(s:Skill {id: $id})
     RETURN c.id AS id, c.content AS content, c.created_at AS created_at
     ORDER BY c.created_at DESC, c.id`,
    { id: skillId }
  )
  const exampleRows = await engine.cypher(
    `MATCH (s:Skill {id: $id})-[:HAS_EXAMPLE]->(e:Example) WHERE e.kind = 'failure'
     RETURN e.id AS id, e.content AS content, e.created_at AS created_at
     ORDER BY e.created_at DESC, e.id`,
    { id: skillId }
  )
  return {
    corrections: correctionRows.map((row) => {
      const createdAt = toIso(row['created_at'])
      return {
        id: String(row['id']),
        content: String(row['content'] ?? ''),
        createdAt,
        isNew: isAfter(createdAt, cursor)
      }
    }),
    failureExamples: exampleRows.map((row) => {
      const createdAt = toIso(row['created_at'])
      return {
        id: String(row['id']),
        content: String(row['content'] ?? ''),
        createdAt,
        isNew: isAfter(createdAt, cursor)
      }
    })
  }
}

/** Active-version instructions (get_skill semantics) with Skill fallback. */
async function activeInstructionsOf(
  engine: StorageEngine,
  skill: SkillRow
): Promise<{ instructions: string; activeVersionId: string | null }> {
  const rows = await engine.cypher(
    `MATCH (s:Skill {id: $id})-[:HAS_VERSION]->(v:SkillVersion) WHERE v.status = 'active'
     RETURN v.id AS id, v.instructions AS instructions ORDER BY v.created_at DESC, v.id LIMIT 1`,
    { id: skill.id }
  )
  const row = rows[0]
  if (row === undefined) return { instructions: skill.instructions, activeVersionId: null }
  const versionInstructions = String(row['instructions'] ?? '')
  return {
    instructions: versionInstructions !== '' ? versionInstructions : skill.instructions,
    activeVersionId: String(row['id'])
  }
}

function hasPendingReview(db: BetterSqlite3.Database, skillId: string): boolean {
  const row = db
    .prepare(
      `SELECT 1 AS x FROM staged_writes
       WHERE kind = ? AND target_id = ? AND status IN ('staged', 'approved') LIMIT 1`
    )
    .get(SKILL_IMPROVEMENT_STAGED_KIND, skillId)
  return row !== undefined
}

export interface PlanOptions {
  readonly engine: StorageEngine
  readonly db: BetterSqlite3.Database
  readonly mode: 'nightly' | 'manual'
  /** Required in manual mode: the one skill to improve. */
  readonly skillId?: string | null
  readonly now?: Date
}

/** The event gate + drift scan — everything the later steps need, read-only. */
export async function planImprovementRun(options: PlanOptions): Promise<PlanState> {
  const now = options.now ?? new Date()
  const runStartedAt = now.toISOString()
  const warnings: string[] = []
  const skipped: SkillSkipNote[] = []
  const work: SkillWorkItem[] = []

  if (options.mode === 'manual' && (options.skillId === undefined || options.skillId === null || options.skillId === '')) {
    throw new SkillImprovementError('INVALID_INPUT', "manual skill-improvement needs a skillId ('improve this skill now')")
  }
  const skills = await listSkills(options.engine, options.mode === 'manual' ? options.skillId ?? undefined : undefined)
  if (options.mode === 'manual' && skills.length === 0) {
    throw new SkillImprovementError('NOT_FOUND', `Skill ${options.skillId ?? ''} does not exist`)
  }

  for (const skill of skills) {
    const settings = getSkillSettings(options.db, skill.id)
    const signal = await collectSignal(options.engine, skill.id, settings.lastRunAt)
    const newSignal = signal.corrections.filter((c) => c.isNew).length + signal.failureExamples.filter((e) => e.isNew).length
    const anySignal = signal.corrections.length + signal.failureExamples.length

    if (options.mode === 'nightly' && newSignal === 0) continue // gated out silently — the common case
    if (anySignal === 0) {
      skipped.push({
        skillId: skill.id,
        skillName: skill.name,
        reason: 'no corrections or failure examples exist — nothing to improve from'
      })
      continue
    }
    if (hasPendingReview(options.db, skill.id)) {
      skipped.push({
        skillId: skill.id,
        skillName: skill.name,
        reason: 'a previous candidate is awaiting review — decide it before generating another'
      })
      continue
    }
    if (options.mode === 'nightly' && work.length >= SKILL_IMPROVEMENT_MAX_PER_RUN) {
      skipped.push({
        skillId: skill.id,
        skillName: skill.name,
        reason: `deferred — per-run cap of ${SKILL_IMPROVEMENT_MAX_PER_RUN} skills reached (signal kept for the next run)`
      })
      continue
    }
    const active = await activeInstructionsOf(options.engine, skill)
    work.push({
      skillId: skill.id,
      skillName: skill.name,
      activeInstructions: active.instructions,
      activeVersionId: active.activeVersionId,
      mode: settings.mode,
      autoRevert: settings.autoRevert,
      corrections: signal.corrections,
      failureExamples: signal.failureExamples
    })
  }

  const drift = options.mode === 'nightly' ? await scanDrift(options.engine, options.db, now) : []
  return { mode: options.mode, runStartedAt, work, skipped, drift, warnings }
}

// ── §20 drift watch: corrections rate over the next 20 uses vs predecessor ──

async function scanDrift(engine: StorageEngine, db: BetterSqlite3.Database, now: Date): Promise<DriftFinding[]> {
  const findings: DriftFinding[] = []
  for (const adoption of listOpenDriftWatches(db)) {
    const finding = await evaluateDrift(engine, db, adoption, now)
    if (finding !== null) findings.push(finding)
  }
  return findings
}

async function evaluateDrift(
  engine: StorageEngine,
  db: BetterSqlite3.Database,
  adoption: ImprovementRow,
  now: Date
): Promise<DriftFinding | null> {
  const adoptedAt = adoption.adoptedAt
  if (adoptedAt === null) return null
  const skillRows = await engine.cypher(`MATCH (s:Skill {id: $id}) RETURN s.name AS name LIMIT 1`, {
    id: adoption.skillId
  })
  const skillName = String(skillRows[0]?.['name'] ?? adoption.skillId)

  // Uses of the skill since adoption, oldest first, one past the window so we
  // know whether the watch is complete.
  const useRows = await engine.cypher(
    `MATCH (sess:Session)-[r:USED]->(s:Skill {id: $id}) WHERE r.created_at > timestamp($from)
     RETURN r.created_at AS at ORDER BY r.created_at LIMIT ${DRIFT_WATCH_USES + 1}`,
    { id: adoption.skillId, from: adoptedAt }
  )
  const useTimes = useRows.map((row) => toIso(row['at'])).filter((t): t is string => t !== null)
  const usesObserved = Math.min(useTimes.length, DRIFT_WATCH_USES)
  if (usesObserved === 0) return null // nothing to measure yet — watch stays open

  const windowEnd = useTimes.length > DRIFT_WATCH_USES ? useTimes[DRIFT_WATCH_USES - 1]! : now.toISOString()
  const corrections = await countCorrections(engine, adoption.skillId, adoptedAt, windowEnd)
  const newRate = corrections / usesObserved

  const predecessorRate = await predecessorRateOf(engine, db, adoption)
  const watchComplete = useTimes.length >= DRIFT_WATCH_USES
  const settings = getSkillSettings(db, adoption.skillId)

  if (newRate > predecessorRate) {
    return {
      improvementId: adoption.id,
      skillId: adoption.skillId,
      skillName,
      versionId: adoption.candidateVersionId,
      newRate,
      predecessorRate,
      usesObserved,
      correctionsObserved: corrections,
      verdict: 'worse',
      autoRevert: settings.autoRevert
    }
  }
  if (watchComplete) {
    return {
      improvementId: adoption.id,
      skillId: adoption.skillId,
      skillName,
      versionId: adoption.candidateVersionId,
      newRate,
      predecessorRate,
      usesObserved,
      correctionsObserved: corrections,
      verdict: 'cleared',
      autoRevert: settings.autoRevert
    }
  }
  return null // watch still open, nothing worse yet
}

async function countCorrections(engine: StorageEngine, skillId: string, fromIso: string, toIsoBound: string): Promise<number> {
  const rows = await engine.cypher(
    `MATCH (c:Correction)-[:IMPROVED]->(s:Skill {id: $id})
     WHERE c.created_at > timestamp($from) AND c.created_at <= timestamp($to)
     RETURN count(c) AS c`,
    { id: skillId, from: fromIso, to: toIsoBound }
  )
  return Number(rows[0]?.['c'] ?? 0)
}

async function countUses(engine: StorageEngine, skillId: string, fromIso: string | null, toIsoBound: string): Promise<number> {
  const rows =
    fromIso !== null
      ? await engine.cypher(
          `MATCH (sess:Session)-[r:USED]->(s:Skill {id: $id})
           WHERE r.created_at > timestamp($from) AND r.created_at <= timestamp($to)
           RETURN count(r) AS c`,
          { id: skillId, from: fromIso, to: toIsoBound }
        )
      : await engine.cypher(
          `MATCH (sess:Session)-[r:USED]->(s:Skill {id: $id}) WHERE r.created_at <= timestamp($to)
           RETURN count(r) AS c`,
          { id: skillId, to: toIsoBound }
        )
  return Number(rows[0]?.['c'] ?? 0)
}

/**
 * The predecessor's corrections-per-use over its own tenure: from the
 * previous adoption (ledger) or the predecessor version's creation, up to
 * this adoption. No usable start point ⇒ all history before the adoption.
 */
async function predecessorRateOf(
  engine: StorageEngine,
  db: BetterSqlite3.Database,
  adoption: ImprovementRow
): Promise<number> {
  const adoptedAt = adoption.adoptedAt ?? new Date(0).toISOString()
  const prior = db
    .prepare(
      `SELECT adopted_at FROM skill_improvements
       WHERE skill_id = ? AND adopted_at IS NOT NULL AND adopted_at < ? ORDER BY adopted_at DESC LIMIT 1`
    )
    .get(adoption.skillId, adoptedAt) as { adopted_at: string } | undefined
  let from: string | null = prior?.adopted_at ?? null
  if (from === null && adoption.predecessorVersionId !== null) {
    const rows = await engine.cypher(`MATCH (v:SkillVersion {id: $id}) RETURN v.created_at AS at LIMIT 1`, {
      id: adoption.predecessorVersionId
    })
    from = toIso(rows[0]?.['at'])
  }
  const uses = await countUses(engine, adoption.skillId, from, adoptedAt)
  const corrections = await countCorrectionsInWindow(engine, adoption.skillId, from, adoptedAt)
  return corrections / Math.max(uses, 1)
}

async function countCorrectionsInWindow(
  engine: StorageEngine,
  skillId: string,
  fromIso: string | null,
  toIsoBound: string
): Promise<number> {
  const rows =
    fromIso !== null
      ? await engine.cypher(
          `MATCH (c:Correction)-[:IMPROVED]->(s:Skill {id: $id})
           WHERE c.created_at > timestamp($from) AND c.created_at <= timestamp($to)
           RETURN count(c) AS c`,
          { id: skillId, from: fromIso, to: toIsoBound }
        )
      : await engine.cypher(
          `MATCH (c:Correction)-[:IMPROVED]->(s:Skill {id: $id}) WHERE c.created_at <= timestamp($to)
           RETURN count(c) AS c`,
          { id: skillId, to: toIsoBound }
        )
  return Number(rows[0]?.['c'] ?? 0)
}
