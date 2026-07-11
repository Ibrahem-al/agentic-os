/**
 * Boot-time crash sweep + the lane-job journal impl (§21.9 crash-safety).
 *
 * The single write lane provides exclusivity, NOT a transaction — each statement
 * auto-commits — so a crash mid-write leaves a durable PARTIAL write. Two durable
 * records let the next boot detect and reconcile that:
 *
 *  - the audit log's 'pending' graph-write rows (security/audit.ts): a write's
 *    accumulated inverse ops, persisted before each forward mutation. The sweep
 *    ROLLS BACK the committed prefix via the existing undo machinery and settles
 *    the row to 'error'.
 *  - the `lane_jobs` table (createLaneJournal below): one row per write lane job,
 *    inserted on start and DELETED on clean finish, so a row present at boot is a
 *    lane job the process died mid-execution. A row that maps to an audited write
 *    (label `graph-write:<actionId>` / an undo/rollback) is already reconciled by
 *    the audit path above and just cleared; any OTHER row is a non-audited write
 *    (e.g. a raw ingest withWrite) with no recorded inverse — detection-only: the
 *    sweep flags it (writes are idempotent, so re-running the ingest/task
 *    reconciles) and clears it.
 *
 * Runs after both stores open and BEFORE any subsystem, so no new write races it.
 */
import type BetterSqlite3 from 'better-sqlite3'
import type { BootDiagnosticDto } from '../shared/ipc'
import { approveStagedWrite, listStagedWrites, stagedWriteRequiresEmbedder, type AuditLog } from './security'
import type { LaneJournal, StorageEngine } from './storage'

/**
 * The lane-job journal backing the storage engine's crash-safety hook, over the
 * `lane_jobs` appdata table. jobStarted inserts a row (returns its id); jobFinished
 * deletes it. Both swallow errors — journaling must NEVER break or fail a write
 * (a lost/failed journal row only costs a spurious/absent boot diagnostic, never
 * data). Wired at boot after appdata.db opens.
 */
export function createLaneJournal(db: BetterSqlite3.Database): LaneJournal {
  const insert = db.prepare(`INSERT INTO lane_jobs (label, started_at) VALUES (?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))`)
  const del = db.prepare('DELETE FROM lane_jobs WHERE id = ?')
  return {
    jobStarted(label: string): number | null {
      try {
        return Number(insert.run(label).lastInsertRowid)
      } catch {
        return null
      }
    },
    jobFinished(id: number): void {
      try {
        del.run(id)
      } catch {
        /* best effort — a stranded row is swept next boot */
      }
    }
  }
}

export interface CrashSweepDeps {
  readonly db: BetterSqlite3.Database
  /** Constructed over the same db + engine — supplies the rollback machinery. */
  readonly audit: AuditLog
}

export interface CrashSweepResult {
  /** Warn/error diagnostics to fold into the dashboard's boot diagnostics. */
  readonly diagnostics: BootDiagnosticDto[]
  readonly rolledBack: number
  readonly rollbackFailed: number
  /** Non-audited interrupted lane jobs flagged (detection-only). */
  readonly nonAuditedFlagged: number
  /** Audited lane-job rows cleared (already reconciled via the audit path). */
  readonly auditedCleared: number
}

/** The subsystem all crash-sweep diagnostics attach to (matches bootDiagnostics). */
const STORAGE = 'storage'

/**
 * Roll back writes the last shutdown interrupted mid-lane-job and surface any
 * interrupted non-audited write. Idempotent and self-clearing: a second run finds
 * no 'pending' rows (they were settled) and no lane_jobs rows (they were deleted).
 * Never throws — a per-row rollback failure becomes an error diagnostic and leaves
 * that row for inspection; the write remains durable either way.
 */
export async function runCrashSweep(deps: CrashSweepDeps): Promise<CrashSweepResult> {
  const { db, audit } = deps
  const diagnostics: BootDiagnosticDto[] = []
  let rolledBack = 0
  let rollbackFailed = 0
  let nonAuditedFlagged = 0
  let auditedCleared = 0

  // (a) 'pending' graph-write rows — a write the process died mid-job. Roll back
  // the committed prefix from the recorded inverses, then settle the row.
  const pending = db.prepare(`SELECT id, description FROM audit_log WHERE outcome = 'pending'`).all() as {
    id: string
    description: string
  }[]
  for (const row of pending) {
    try {
      await audit.rollbackInterruptedWrite(row.id)
      rolledBack += 1
      diagnostics.push({
        subsystem: STORAGE,
        level: 'warn',
        detail: `rolled back a write interrupted by the last shutdown: ${row.description}`
      })
    } catch (err) {
      rollbackFailed += 1
      diagnostics.push({
        subsystem: STORAGE,
        level: 'error',
        detail: `could not roll back an interrupted write (${row.description}) — the partial write remains on disk; inspect the audit log (${
          err instanceof Error ? err.message : String(err)
        })`
      })
    }
  }

  // (b) lane_jobs rows — any lane job present here died mid-execution (a clean
  // finish deletes its row). An audited write is already handled by (a); flag the
  // rest as non-audited interrupted jobs (idempotent re-run reconciles them).
  const orphans = db.prepare(`SELECT id, label FROM lane_jobs WHERE finished_at IS NULL`).all() as {
    id: number
    label: string | null
  }[]
  const auditExists = db.prepare('SELECT 1 FROM audit_log WHERE id = ?')
  const deleteOrphan = db.prepare('DELETE FROM lane_jobs WHERE id = ?')
  for (const orphan of orphans) {
    const auditedId = auditedActionIdOf(orphan.label)
    const covered = auditedId !== null && auditExists.get(auditedId) !== undefined
    if (covered) {
      auditedCleared += 1
    } else {
      nonAuditedFlagged += 1
      diagnostics.push({
        subsystem: STORAGE,
        level: 'warn',
        detail: `a write job (${orphan.label ?? 'unknown'}) was interrupted by the last shutdown; re-running the ingest/task will reconcile (writes are idempotent)`
      })
    }
    deleteOrphan.run(orphan.id)
  }

  return { diagnostics, rolledBack, rollbackFailed, nonAuditedFlagged, auditedCleared }
}

export interface StagedApprovedSweepDeps {
  readonly db: BetterSqlite3.Database
  readonly engine: StorageEngine
  /** Constructed over the same db + engine — commits are audited (§13). */
  readonly audit: AuditLog
}

export interface StagedApprovedSweepResult {
  readonly diagnostics: BootDiagnosticDto[]
  /** Embedder-free approved rows re-driven to committed. */
  readonly reCommitted: number
  /** Approved rows whose re-drive failed (left approved for a retry). */
  readonly reCommitFailed: number
  /** Approved rows left because their commit needs the embedder (surfaced to Approvals). */
  readonly embedderDeferred: number
}

/** The subsystem the staged-approved sweep diagnostics attach to. */
const STAGED = 'storage'

/** The actor recorded on a boot-swept re-commit (§13 attribution). */
const SWEEP_ACTOR = 'boot-sweep'

/**
 * Boot sweep for `staged_writes` rows stuck at status 'approved' (§21.9): the app
 * died between the audited commit and the status flip, OR between the flip's two
 * halves. `approveStagedWrite` is designed re-drivable on an 'approved' row (it
 * re-invokes the commit), so:
 *  - a row whose commit is EMBEDDER-FREE (stagedWriteRequiresEmbedder=false) is
 *    re-driven here — it lands 'committed'. The commit ops are idempotent
 *    (upsert/MERGE), so the rare crash-window where the graph write already
 *    completed but the flip didn't yields a second, honest audit action rather
 *    than a lost commit (recorded decision — a benign double-action beats a stuck
 *    row). A merge whose targets were already consumed fails cleanly and is left.
 *  - a row that NEEDS the embedder is LEFT untouched with a warn diagnostic
 *    pointing the user at Approvals (the sweep has no embedder — that build is
 *    later in boot, and Ollama may be down; the user finishes it with one click).
 *
 * Idempotent and fail-safe: a re-run finds no 'approved' rows it can advance, and
 * a per-row failure never throws (it becomes a diagnostic and leaves the row).
 */
export async function runStagedApprovedSweep(deps: StagedApprovedSweepDeps): Promise<StagedApprovedSweepResult> {
  const { db } = deps
  const diagnostics: BootDiagnosticDto[] = []
  let reCommitted = 0
  let reCommitFailed = 0
  let embedderDeferred = 0

  const approved = listStagedWrites(db, { status: 'approved' })
  for (const row of approved) {
    if (stagedWriteRequiresEmbedder(row)) {
      embedderDeferred += 1
      diagnostics.push({
        subsystem: STAGED,
        level: 'warn',
        detail: 'an approved change is waiting to finish committing — open Approvals'
      })
      continue
    }
    try {
      await approveStagedWrite(
        { db, engine: deps.engine, audit: deps.audit },
        row.id,
        { decidedBy: SWEEP_ACTOR }
      )
      reCommitted += 1
      diagnostics.push({
        subsystem: STAGED,
        level: 'warn',
        detail: `finished committing an approved change interrupted by the last shutdown (${row.kind})`
      })
    } catch (err) {
      reCommitFailed += 1
      diagnostics.push({
        subsystem: STAGED,
        level: 'error',
        detail: `could not finish committing an approved change (${row.kind}) — it is left in Approvals to retry (${
          err instanceof Error ? err.message : String(err)
        })`
      })
    }
  }

  return { diagnostics, reCommitted, reCommitFailed, embedderDeferred }
}

/**
 * The audit action id a lane-job label references, or null when the label is not
 * an audited-write lane job. graphWrite labels its lane job `graph-write:<id>`,
 * and the audit undo/rollback jobs `undo:<id>` / `interrupted-rollback:<id>` — all
 * carry an audit_log id the sweep can check, so a stranded row from any of them is
 * reconciled by the audit path, not double-reported as a non-audited job.
 */
function auditedActionIdOf(label: string | null): string | null {
  if (label === null) return null
  for (const prefix of ['graph-write:', 'undo:', 'interrupted-rollback:']) {
    if (label.startsWith(prefix)) return label.slice(prefix.length)
  }
  return null
}
