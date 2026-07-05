/**
 * Maintenance job handlers for the §20 schedule slots (phase 11):
 *
 *  - 'prune' (§6/§20): Session nodes older than TRANSCRIPT_RETENTION_DAYS
 *    lose their `transcript_ref` — the raw-transcript pointer is dropped, the
 *    distilled Session stub and every extracted node/edge stay. The whole
 *    prune is ONE structured, audited write-lane job (per-property pre-images
 *    recorded), so it is undoable from the dashboard like any §13 action.
 *  - 'export' (§5 memory insurance): the phase-01 exportGraph dump into
 *    exports/<date>/ (CSV + Cypher + manifest).
 *
 * The 02:00 'skill-improvement' slot is handled by the REAL agent since
 * phase 12 (registerSkillImprovementHandler in src/main/agents/skills) — the
 * phase-11 no-op stub is gone.
 */
import { TRANSCRIPT_RETENTION_DAYS } from '../config'
import type { AuditLog } from '../security'
import { exportGraph, type StorageEngine, type WriteTx } from '../storage'
import type { DurableTaskQueue } from './queue'

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

/** Register the prune/export schedule-slot handlers on the queue. */
export function registerMaintenanceHandlers(queue: DurableTaskQueue, deps: MaintenanceJobDeps): void {
  queue.registerHandler('prune', async () => {
    const result = await runPruneJob(deps)
    return {
      note:
        result.pruned.length === 0
          ? `no sessions older than ${TRANSCRIPT_RETENTION_DAYS}d carry a transcript_ref`
          : `dropped transcript_ref from ${result.pruned.length} session(s), stubs kept`
    }
  })

  queue.registerHandler('export', async () => {
    const result = await exportGraph(deps.engine, deps.exportsDir)
    const nodes = Object.values(result.nodeCounts).reduce((a, b) => a + b, 0)
    const rels = Object.values(result.relCounts).reduce((a, b) => a + b, 0)
    return { note: `graph exported to ${result.dir} (${nodes} nodes, ${rels} relationships)` }
  })
}
