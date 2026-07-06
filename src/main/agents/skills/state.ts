/**
 * Skill-improvement operational state (appdata v6, phase 12):
 *
 *  - `skill_settings` — the §17 per-skill adoption setting ('verifiable' may
 *    auto-adopt behind the no-regression gate; 'stylistic' — the DEFAULT —
 *    always routes to the review queue), the §20 drift auto-revert toggle
 *    (off by default) and the event-gate cursor (last_run_at).
 *  - `skill_improvements` — one ledger row per candidate attempt: benchmark
 *    detail, adoption/rollback timestamps, the predecessor snapshot rollback
 *    restores, and the §20 drift-watch columns.
 *
 * SQLite-only module (no graph, no security imports) — shared by the agent,
 * the staged-write committers and the dashboard IPC.
 */
import type BetterSqlite3 from 'better-sqlite3'
import { DRIFT_AUTO_REVERT } from '../../config'
import type { SkillAdoptionMode } from './types'

export interface SkillSettings {
  readonly skillId: string
  readonly mode: SkillAdoptionMode
  readonly autoRevert: boolean
  readonly lastRunAt: string | null
}

const DEFAULT_MODE: SkillAdoptionMode = 'stylistic'

/** Settings for one skill; unset skills get the conservative defaults. */
export function getSkillSettings(db: BetterSqlite3.Database, skillId: string): SkillSettings {
  const row = db
    .prepare('SELECT skill_id, mode, auto_revert, last_run_at FROM skill_settings WHERE skill_id = ?')
    .get(skillId) as { skill_id: string; mode: string; auto_revert: number; last_run_at: string | null } | undefined
  if (row === undefined) {
    return { skillId, mode: DEFAULT_MODE, autoRevert: DRIFT_AUTO_REVERT, lastRunAt: null }
  }
  return {
    skillId: row.skill_id,
    mode: row.mode === 'verifiable' ? 'verifiable' : 'stylistic',
    autoRevert: row.auto_revert === 1,
    lastRunAt: row.last_run_at
  }
}

export function setSkillSettings(
  db: BetterSqlite3.Database,
  skillId: string,
  patch: { mode?: SkillAdoptionMode; autoRevert?: boolean }
): SkillSettings {
  const current = getSkillSettings(db, skillId)
  const mode = patch.mode ?? current.mode
  const autoRevert = patch.autoRevert ?? current.autoRevert
  db.prepare(
    `INSERT INTO skill_settings (skill_id, mode, auto_revert, last_run_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(skill_id) DO UPDATE SET mode = excluded.mode, auto_revert = excluded.auto_revert,
       updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')`
  ).run(skillId, mode, autoRevert ? 1 : 0, current.lastRunAt)
  return { skillId, mode, autoRevert, lastRunAt: current.lastRunAt }
}

/** Advance the event-gate cursor after a completed improvement pass. */
export function markSkillRun(db: BetterSqlite3.Database, skillId: string, runAtIso: string): void {
  db.prepare(
    `INSERT INTO skill_settings (skill_id, last_run_at) VALUES (?, ?)
     ON CONFLICT(skill_id) DO UPDATE SET last_run_at = excluded.last_run_at,
       updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')`
  ).run(skillId, runAtIso)
}

// ── Improvement ledger ───────────────────────────────────────────────────────

export type ImprovementOutcome = 'adopted' | 'rejected' | 'staged'

export interface ImprovementRow {
  readonly id: string
  readonly skillId: string
  readonly candidateVersionId: string
  readonly predecessorVersionId: string | null
  /** Snapshot of the Skill's instructions before adoption (rollback source). */
  readonly predecessorInstructions: string | null
  readonly mode: SkillAdoptionMode
  readonly outcome: ImprovementOutcome
  readonly benchmark: Record<string, unknown>
  readonly reason: string | null
  readonly jobId: string | null
  readonly createdAt: string
  readonly adoptedAt: string | null
  readonly rolledBackAt: string | null
  readonly driftFlaggedAt: string | null
  readonly drift: Record<string, unknown> | null
  readonly driftResolvedAt: string | null
}

interface RawImprovementRow {
  id: string
  skill_id: string
  candidate_version_id: string
  predecessor_version_id: string | null
  predecessor_instructions: string | null
  mode: string
  outcome: string
  benchmark_json: string
  reason: string | null
  job_id: string | null
  created_at: string
  adopted_at: string | null
  rolled_back_at: string | null
  drift_flagged_at: string | null
  drift_json: string | null
  drift_resolved_at: string | null
}

function decodeImprovement(row: RawImprovementRow): ImprovementRow {
  return {
    id: row.id,
    skillId: row.skill_id,
    candidateVersionId: row.candidate_version_id,
    predecessorVersionId: row.predecessor_version_id,
    predecessorInstructions: row.predecessor_instructions,
    mode: row.mode === 'verifiable' ? 'verifiable' : 'stylistic',
    outcome: row.outcome as ImprovementOutcome,
    benchmark: JSON.parse(row.benchmark_json) as Record<string, unknown>,
    reason: row.reason,
    jobId: row.job_id,
    createdAt: row.created_at,
    adoptedAt: row.adopted_at,
    rolledBackAt: row.rolled_back_at,
    driftFlaggedAt: row.drift_flagged_at,
    drift: row.drift_json === null ? null : (JSON.parse(row.drift_json) as Record<string, unknown>),
    driftResolvedAt: row.drift_resolved_at
  }
}

/**
 * Record one candidate attempt (id = candidate version id, so a crash-resumed
 * write step upserts instead of duplicating).
 */
export function recordImprovement(
  db: BetterSqlite3.Database,
  entry: {
    skillId: string
    candidateVersionId: string
    predecessorVersionId: string | null
    predecessorInstructions: string | null
    mode: SkillAdoptionMode
    outcome: ImprovementOutcome
    benchmark: Record<string, unknown>
    reason: string
    jobId: string
    adoptedAtIso: string | null
    /**
     * P1.8: the reasoning model resolved for this run. When present it is stamped
     * into benchmark_json as `model`, so a later drift scan can tell whether the
     * model changed mid-window (and refuse to auto-revert if it did). Null/absent
     * (no router) → benchmark_json is unchanged from before P1.8.
     */
    model?: string | null
  }
): void {
  const benchmark = entry.model != null ? { ...entry.benchmark, model: entry.model } : entry.benchmark
  db.prepare(
    `INSERT INTO skill_improvements
       (id, skill_id, candidate_version_id, predecessor_version_id, predecessor_instructions,
        mode, outcome, benchmark_json, reason, job_id, adopted_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       outcome = excluded.outcome, benchmark_json = excluded.benchmark_json,
       reason = excluded.reason, job_id = excluded.job_id, adopted_at = excluded.adopted_at`
  ).run(
    entry.candidateVersionId,
    entry.skillId,
    entry.candidateVersionId,
    entry.predecessorVersionId,
    entry.predecessorInstructions,
    entry.mode,
    entry.outcome,
    JSON.stringify(benchmark),
    entry.reason,
    entry.jobId,
    entry.adoptedAtIso
  )
}

export function getImprovement(db: BetterSqlite3.Database, id: string): ImprovementRow | undefined {
  const row = db.prepare('SELECT * FROM skill_improvements WHERE id = ?').get(id) as RawImprovementRow | undefined
  return row === undefined ? undefined : decodeImprovement(row)
}

export function listImprovements(db: BetterSqlite3.Database, skillId?: string): ImprovementRow[] {
  const rows = (
    skillId !== undefined
      ? db.prepare('SELECT * FROM skill_improvements WHERE skill_id = ? ORDER BY created_at DESC, id').all(skillId)
      : db.prepare('SELECT * FROM skill_improvements ORDER BY created_at DESC, id').all()
  ) as RawImprovementRow[]
  return rows.map(decodeImprovement)
}

/** The stylistic review path decided: staged → adopted / rejected. */
export function markImprovementDecision(
  db: BetterSqlite3.Database,
  id: string,
  decision: { outcome: 'adopted'; adoptedAtIso: string } | { outcome: 'rejected' }
): void {
  if (decision.outcome === 'adopted') {
    db.prepare(`UPDATE skill_improvements SET outcome = 'adopted', adopted_at = ? WHERE id = ?`).run(
      decision.adoptedAtIso,
      id
    )
  } else {
    db.prepare(`UPDATE skill_improvements SET outcome = 'rejected' WHERE id = ?`).run(id)
  }
}

export function markImprovementRolledBack(db: BetterSqlite3.Database, id: string, atIso: string): void {
  db.prepare('UPDATE skill_improvements SET rolled_back_at = ? WHERE id = ?').run(atIso, id)
}

export function markImprovementDrift(
  db: BetterSqlite3.Database,
  id: string,
  drift: { flaggedAtIso: string; details: Record<string, unknown> } | { resolvedAtIso: string }
): void {
  if ('flaggedAtIso' in drift) {
    db.prepare('UPDATE skill_improvements SET drift_flagged_at = ?, drift_json = ? WHERE id = ?').run(
      drift.flaggedAtIso,
      JSON.stringify(drift.details),
      id
    )
  } else {
    db.prepare('UPDATE skill_improvements SET drift_resolved_at = ? WHERE id = ?').run(drift.resolvedAtIso, id)
  }
}

/** Adoptions whose §20 drift watch is still open (nightly scan input). */
export function listOpenDriftWatches(db: BetterSqlite3.Database): ImprovementRow[] {
  const rows = db
    .prepare(
      `SELECT * FROM skill_improvements
       WHERE outcome = 'adopted' AND adopted_at IS NOT NULL AND rolled_back_at IS NULL
         AND drift_flagged_at IS NULL AND drift_resolved_at IS NULL
       ORDER BY adopted_at, id`
    )
    .all() as RawImprovementRow[]
  return rows.map(decodeImprovement)
}

/**
 * The adoption a rollback undoes: the most recent still-standing adopted row
 * for the skill (its candidate must still be the live version).
 */
export function latestStandingAdoption(db: BetterSqlite3.Database, skillId: string): ImprovementRow | undefined {
  const row = db
    .prepare(
      `SELECT * FROM skill_improvements
       WHERE skill_id = ? AND outcome = 'adopted' AND adopted_at IS NOT NULL AND rolled_back_at IS NULL
       ORDER BY adopted_at DESC, id DESC LIMIT 1`
    )
    .get(skillId) as RawImprovementRow | undefined
  return row === undefined ? undefined : decodeImprovement(row)
}
