/**
 * Regression guard for the will-quit teardown ORDER fix (§21.9, Stage A): the
 * quit path must drain the engine (engine.close() → lane.onIdle + checkpoint)
 * BEFORE it closes appdata.db, because a draining lane job still writes to
 * appdata.db — the audited 'pending'→ok/error finalize AND the lane-job journal's
 * jobFinished DELETE. Closing appdata.db first would make those writes hit a
 * closed SQLite handle and lose the record of the write.
 *
 * We can't drive Electron's will-quit here, but we can prove the invariant it
 * relies on: while an audited write is STILL in flight, run the exact will-quit
 * ordering — `engine.close().finally(() => appData.close())` — and assert that by
 * the time engine.close() resolves, the in-flight write has fully settled in
 * appdata.db (audit row 'ok', lane_jobs row gone) with appData STILL OPEN. If the
 * order were reversed, those appdata writes would have been lost.
 *
 * One store per test file (ryugraph 25.9.1 teardown discipline).
 */
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { AuditLog } from '../../src/main/security'
import { createLaneJournal } from '../../src/main/crashSweep'
import { openAppData, type AppData } from '../../src/main/storage'
import { openTestStore, type TestStore } from './helpers'

let store: TestStore
let appData: AppData

beforeAll(async () => {
  store = await openTestStore()
  appData = openAppData(join(store.baseDir, 'appdata.db'))
  store.engine.setLaneJournal(createLaneJournal(appData.db))
})

afterAll(async () => {
  // store.cleanup() closes the engine; if the test already closed it, the guard
  // in close() makes the second call a no-op. appData is closed by the test.
  await store.cleanup().catch(() => undefined)
})

describe('will-quit order: engine drains (appdata writes land) before appData closes', () => {
  it('an in-flight audited write settles in appdata.db during engine.close(), appData still open', async () => {
    const audit = new AuditLog({ db: appData.db, backupsDir: store.backupsDir, engine: store.engine })
    const laneJobCount = (): number =>
      Number((appData.db.prepare('SELECT count(*) AS c FROM lane_jobs').get() as { c: number }).c)

    // Start an audited write but DON'T await it — its lane job is enqueued
    // synchronously, so engine.close()'s lane.onIdle drain must wait for it.
    let actionId = ''
    const inFlight = audit
      .graphWrite('quit-order', 'in-flight at quit', async (tx) => {
        await tx.upsertNode('Tag', { id: 'quit-order-node', name: 'q', is_global: false })
      })
      .then((r) => {
        actionId = r.actionId
      })

    // The exact will-quit ordering: drain the engine FIRST, close appData in the
    // .finally AFTER. skipDatabaseClose mirrors the real quit (leak the graph
    // handle; the checkpoint makes on-disk state clean).
    let appDataClosed = false
    await store.engine.close({ skipDatabaseClose: true }).finally(() => {
      // Right here, BEFORE appData.close(), the draining lane job's appdata
      // writes must already be durable (engine.close awaited lane.onIdle).
      expect(laneJobCount()).toBe(0) // jobFinished DELETE landed
      const settled = appData.db
        .prepare(`SELECT outcome FROM audit_log WHERE outcome != 'pending'`)
        .get() as { outcome: string } | undefined
      expect(settled?.outcome).toBe('ok') // pending→ok finalize landed
      appDataClosed = true
      appData.close()
    })

    await inFlight
    expect(actionId).not.toBe('') // the write really did resolve during the drain
    expect(appDataClosed).toBe(true)
  }, 30_000)
})
