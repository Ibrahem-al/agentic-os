/**
 * Maintenance job handlers for the §20 schedule slots (phase 11):
 *
 *  - 'prune' (§6/§20): Session nodes older than TRANSCRIPT_RETENTION_DAYS
 *    lose their `transcript_ref` — the raw-transcript pointer is dropped, the
 *    distilled Session stub and every extracted node/edge stay. The whole
 *    prune is ONE structured, audited write-lane job (per-property pre-images
 *    recorded), so it is undoable from the dashboard like any §13 action.
 *    Phase 13: the same slot also sweeps finished task rows and dead
 *    workflow checkpoints (runTaskRetentionSweep below).
 *  - 'export' (§5 memory insurance): the phase-01 exportGraph dump into
 *    exports/<date>/ (CSV + Cypher + manifest).
 *
 * The 02:00 'skill-improvement' slot is handled by the REAL agent since
 * phase 12 (registerSkillImprovementHandler in src/main/agents/skills) — the
 * phase-11 no-op stub is gone.
 */
import type BetterSqlite3 from 'better-sqlite3'
import { TASK_ROW_RETENTION_DAYS, TRANSCRIPT_RETENTION_DAYS } from '../config'
import type { AuditLog } from '../security'
import { exportGraph, type StorageEngine, type WriteTx } from '../storage'
import type { DurableTaskQueue } from './queue'
import { EXTRACTION_TASK_KIND } from './sessionEnd'

export interface MaintenanceJobDeps {
  readonly engine: StorageEngine
  /** Present in the app boot; absent only in minimal test rigs. */
  readonly audit?: AuditLog
  readonly exportsDir: string
}

export interface PruneResult {
  /** Session ids whose transcript_ref was dropped this run. */
  readonly pruned: readonly string[]
  readonly cutoffIso: string
}

/**
 * Drop `transcript_ref` from Sessions older than the §20 retention window
 * (14 days), keeping the stubs. Idempotent: already-pruned sessions no longer
 * match the IS NOT NULL filter.
 */
export async function runPruneJob(deps: MaintenanceJobDeps, now: Date = new Date()): Promise<PruneResult> {
  const cutoffIso = new Date(now.getTime() - TRANSCRIPT_RETENTION_DAYS * 24 * 60 * 60 * 1000).toISOString()
  const rows = await deps.engine.cypher(
    `MATCH (s:Session)
     WHERE s.transcript_ref IS NOT NULL AND coalesce(s.ended_at, s.started_at) < timestamp($cutoff)
     RETURN s.id AS id ORDER BY s.id`,
    { cutoff: cutoffIso }
  )
  const ids = rows.map((row) => String(row['id']))
  if (ids.length === 0) return { pruned: [], cutoffIso }

  const drop = async (tx: WriteTx): Promise<void> => {
    for (const id of ids) {
      await tx.upsertNode('Session', { id, transcript_ref: null })
    }
  }
  if (deps.audit !== undefined) {
    await deps.audit.graphWrite(
      'system',
      `nightly prune: dropped transcript_ref from ${ids.length} session(s) older than ${TRANSCRIPT_RETENTION_DAYS}d`,
      drop
    )
  } else {
    await deps.engine.withWrite(drop)
  }
  return { pruned: ids, cutoffIso }
}

export interface TaskSweepResult {
  /** done/failed task rows deleted (§6 dedup tokens excluded). */
  readonly taskRows: number
  /** workflow_checkpoints + workflow_checkpoint_writes rows deleted. */
  readonly checkpointRows: number
  readonly cutoffIso: string
}

/**
 * Phase-13 hardening: sweep task rows with status done/failed older than
 * TASK_ROW_RETENTION_DAYS, plus the checkpoints of finished workflow jobs.
 * Deliberately NOT audited — the §13 audit discipline covers graph + file
 * writes; task rows are queue bookkeeping (appdata-only operational state,
 * like spend rows).
 *
 * Kept forever: kind='extraction' rows and kind='workflow' rows whose id
 * starts with 'extract-' — those ids are the §6 exactly-once dedup tokens
 * (the mcp_calls inactivity sweep and the spool drain rely on the row
 * existing; a swept row would allow re-extraction). Checkpoints of DONE
 * workflow jobs go regardless (resume() no-ops on done rows) — that includes
 * extract-*-wf checkpoints, safe because their task rows are kept and done
 * tasks never re-fire.
 *
 * Phase-18 exemption: `extract-cont-*` rows (delegate/continuation tasks + their
 * `-wf` jobs) are NOT §6 exactly-once tokens — nothing re-derives them from a
 * quiet session — so they sweep after retention like any other finished row.
 */
export function runTaskRetentionSweep(db: BetterSqlite3.Database, now: Date = new Date()): TaskSweepResult {
  // tasks.updated_at is TEXT strftime('%Y-%m-%dT%H:%M:%fZ') — the same shape
  // as Date.toISOString(), so lexicographic comparison is chronological.
  const cutoffIso = new Date(now.getTime() - TASK_ROW_RETENTION_DAYS * 24 * 60 * 60 * 1000).toISOString()
  // Checkpoints first: their thread_id subquery must still see the finished
  // workflow rows the task sweep below deletes.
  const checkpointRows =
    db
      .prepare(
        `DELETE FROM workflow_checkpoints WHERE thread_id IN (
           SELECT id FROM tasks WHERE kind = 'workflow' AND status = 'done' AND updated_at < ?)`
      )
      .run(cutoffIso).changes +
    db
      .prepare(
        `DELETE FROM workflow_checkpoint_writes WHERE thread_id IN (
           SELECT id FROM tasks WHERE kind = 'workflow' AND status = 'done' AND updated_at < ?)`
      )
      .run(cutoffIso).changes
  const taskRows = db
    .prepare(
      `DELETE FROM tasks
       WHERE status IN ('done', 'failed', 'cancelled') AND updated_at < ?
         AND NOT (kind = ? AND id NOT LIKE 'extract-cont-%')
         AND NOT (kind = 'workflow' AND id LIKE 'extract-%' AND id NOT LIKE 'extract-cont-%')`
    )
    .run(cutoffIso, EXTRACTION_TASK_KIND).changes
  return { taskRows, checkpointRows, cutoffIso }
}

export interface WorkflowReconcileResult {
  /** kind='workflow' rows stuck 'running' with no live driver → flipped to 'failed'. */
  readonly orphanedRunningFixed: number
  /** Benign "nothing to extract" workflow rows left 'failed' → settled to 'done'. */
  readonly benignResolved: number
}

/**
 * Boot reconciliation of the workflow (kind='workflow') rows — run ONCE before
 * queue.start(), so nothing races the reload/resume it decides against:
 *
 *  (a) A `<taskId>-wf` row stuck 'running' is a crash orphan. It gets resumed only
 *      when its DRIVER task (`<taskId>`) is reloaded by start() — i.e. the driver is
 *      pending/deferred/running. When the driver is TERMINAL (done/failed/cancelled)
 *      or absent, nothing will ever resume the row, so it lingers 'running' forever
 *      (the "stuck workflow for days" the user saw). Flip those to 'failed'. Rows
 *      whose driver WILL resume them are left untouched.
 *  (b) A workflow row left 'failed' by a benign "nothing to extract" run (collect
 *      threw NOT_FOUND; the driver extraction task is 'done') is not a real failure —
 *      settle it to 'done' so it stops showing as a scary failed job. Keyed on the
 *      exact last_error phrase AND a 'done' driver so a real failure is never touched.
 *
 * Only `<taskId>-wf`-shaped ids are considered, so a non-task workflow job is never
 * disturbed. Idempotent: a second run finds nothing to fix.
 */
export function reconcileWorkflowJobs(db: BetterSqlite3.Database): WorkflowReconcileResult {
  const nowExpr = `strftime('%Y-%m-%dT%H:%M:%fZ','now')`
  const driverStatus = db.prepare('SELECT status FROM tasks WHERE id = ?')
  const terminal = new Set(['done', 'failed', 'cancelled'])

  // (a) orphaned running workflow rows.
  const running = db.prepare(`SELECT id FROM tasks WHERE kind = 'workflow' AND status = 'running'`).all() as {
    id: string
  }[]
  const markOrphanFailed = db.prepare(
    `UPDATE tasks SET status = 'failed', last_error = ?, updated_at = ${nowExpr} WHERE id = ? AND status = 'running'`
  )
  let orphanedRunningFixed = 0
  for (const row of running) {
    if (!row.id.endsWith('-wf')) continue // only task-driven workflow jobs
    const driverId = row.id.slice(0, -'-wf'.length)
    const driver = driverStatus.get(driverId) as { status: string } | undefined
    const willResume = driver !== undefined && !terminal.has(driver.status)
    if (willResume) continue // start() reloads the driver, which resumes this row
    markOrphanFailed.run('interrupted by a shutdown with no pending driver task to resume it', row.id)
    orphanedRunningFixed += 1
  }

  // (b) benign "nothing to extract" failed workflow rows with a completed driver.
  const benignFailed = db
    .prepare(
      `SELECT id FROM tasks WHERE kind = 'workflow' AND status = 'failed' AND last_error LIKE '%nothing to extract%'`
    )
    .all() as { id: string }[]
  const markBenignDone = db.prepare(
    `UPDATE tasks SET status = 'done', last_error = NULL, updated_at = ${nowExpr} WHERE id = ? AND status = 'failed'`
  )
  let benignResolved = 0
  for (const row of benignFailed) {
    if (!row.id.endsWith('-wf')) continue
    const driver = driverStatus.get(row.id.slice(0, -'-wf'.length)) as { status: string } | undefined
    if (driver?.status !== 'done') continue // a real failure or an unfinished driver — leave it
    markBenignDone.run(row.id)
    benignResolved += 1
  }

  return { orphanedRunningFixed, benignResolved }
}

/** Register the prune/export schedule-slot handlers on the queue. */
export function registerMaintenanceHandlers(queue: DurableTaskQueue, deps: MaintenanceJobDeps): void {
  queue.registerHandler('prune', async () => {
    const result = await runPruneJob(deps)
    // The nightly 03:00 slot doubles as the appdata retention sweep.
    const sweep = runTaskRetentionSweep(queue.mirrorDb)
    const pruneNote =
      result.pruned.length === 0
        ? `no sessions older than ${TRANSCRIPT_RETENTION_DAYS}d carry a transcript_ref`
        : `dropped transcript_ref from ${result.pruned.length} session(s), stubs kept`
    return {
      note: `${pruneNote}; swept ${sweep.taskRows} task row(s), ${sweep.checkpointRows} checkpoint row(s)`
    }
  })

  queue.registerHandler('export', async () => {
    const result = await exportGraph(deps.engine, deps.exportsDir)
    const nodes = Object.values(result.nodeCounts).reduce((a, b) => a + b, 0)
    const rels = Object.values(result.relCounts).reduce((a, b) => a + b, 0)
    return { note: `graph exported to ${result.dir} (${nodes} nodes, ${rels} relationships)` }
  })
}
