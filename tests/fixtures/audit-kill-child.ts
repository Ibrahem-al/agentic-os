/**
 * Child process for the crash-safety kill-mid-write proof (§21.9). Bundled with
 * esbuild and spawned under plain node by
 * tests/integration/storage.crashSweep.kill.test.ts.
 *
 * Behavior: open the REAL RyuGraph engine + appdata.db over the given dirs, wire
 * the lane-job journal EXACTLY as boot does, then:
 *   1. seed one CLEAN baseline node (a settled write — the sweep must NOT touch it),
 *   2. start a LONG audited `graphWrite` that upserts several nodes with a slow
 *      point, and once its committed prefix + the 'pending' audit row's inverses
 *      are durably on disk, print the handshake and BLOCK forever.
 *
 * The parent SIGKILLs this process while the audited write is mid-lane-job, so
 * the graph keeps the committed prefix (the write lane is exclusive, NOT
 * transactional — each statement auto-commits) and appdata.db keeps the 'pending'
 * audit row + the `graph-write:<id>` lane_jobs row. The parent then reopens both
 * stores and runs the boot sweep, which must roll the partial write back.
 */
import { AuditLog } from '../../src/main/security'
import { createLaneJournal } from '../../src/main/crashSweep'
import { openAppData, openRyuGraphEngine } from '../../src/main/storage'
import { AUDIT_KILL_BASELINE_ID, AUDIT_KILL_HANDSHAKE, AUDIT_KILL_PARTIAL_IDS } from './audit-kill-constants'

async function main(): Promise<void> {
  const [, , graphDir, appDbPath, extensionsDir, backupsDir] = process.argv
  if (!graphDir || !appDbPath || !extensionsDir || !backupsDir) {
    throw new Error('usage: audit-kill-child <graphDir> <appDbPath> <extensionsDir> <backupsDir>')
  }
  const engine = await openRyuGraphEngine({ graphDir, backupsDir, extensionsDir })
  const appData = openAppData(appDbPath)
  // Wire the crash-safety lane-job journal exactly as bootStorage does.
  engine.setLaneJournal(createLaneJournal(appData.db))
  const audit = new AuditLog({ db: appData.db, backupsDir, engine })

  // (1) A clean baseline write that SETTLES — proves the sweep is selective
  // (it rolls back only the interrupted write, never this durable node).
  await engine.upsertNode('Tag', { id: AUDIT_KILL_BASELINE_ID, name: 'baseline', is_global: false })

  // (2) The long audited write. Started but NOT awaited: each upsert auto-commits
  // and its inverse is persisted BEFORE the forward write, so by the time we
  // print the handshake the committed prefix AND its roll-back inverses are
  // durably on disk. We then block forever inside fn — graphWrite never reaches
  // its finalize(), leaving the row 'pending' and the lane_jobs row present.
  void audit
    .graphWrite('kill-agent', 'interrupted multi-node write', async (tx) => {
      for (const id of AUDIT_KILL_PARTIAL_IDS) {
        await tx.upsertNode('Tag', { id, name: id, is_global: false })
      }
      console.log(AUDIT_KILL_HANDSHAKE)
      await new Promise<void>(() => undefined) // block until the parent SIGKILLs us
    })
    .catch((err: unknown) => {
      console.error(err)
      process.exit(1)
    })

  // Keep the event loop alive until SIGKILL.
  setInterval(() => undefined, 60_000)
}

main().catch((err: unknown) => {
  console.error(err)
  process.exit(1)
})
