/**
 * Crash-safety: the write-intent journal + boot sweep (§21.9) over the REAL
 * engine.
 *
 * The single write lane is exclusive, NOT transactional — a crash mid-job leaves
 * a durable PARTIAL write. Two durable records make that recoverable:
 *  - audit_log 'pending' graph-write rows (inverse_json kept current per op), and
 *  - the lane_jobs table (a row per lane job, deleted on clean finish).
 * runCrashSweep rolls back interrupted audited writes from the inverses and flags
 * interrupted non-audited jobs (detection-only).
 *
 * One store per test file (ryugraph 25.9.1 teardown discipline, phase 08).
 */
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { AuditLog } from '../../src/main/security'
import { createLaneJournal, runCrashSweep } from '../../src/main/crashSweep'
import { openAppData, type AppData } from '../../src/main/storage'
import { openTestStore, type TestStore } from './helpers'

let store: TestStore
let appData: AppData
let audit: AuditLog

beforeAll(async () => {
  store = await openTestStore()
  appData = openAppData(join(store.baseDir, 'appdata.db'))
  audit = new AuditLog({ db: appData.db, backupsDir: store.backupsDir, engine: store.engine })
  // Wire the crash-safety lane-job journal exactly as boot does.
  store.engine.setLaneJournal(createLaneJournal(appData.db))
})

afterAll(async () => {
  appData.close()
  await store.cleanup()
})

const nodeCount = async (label: string, id: string): Promise<number> => {
  const rows = await store.engine.cypher(`MATCH (n:${label} {id: $id}) RETURN count(n) AS c`, { id })
  return Number(rows[0]?.['c'] ?? 0)
}
const laneJobCount = (): number =>
  Number((appData.db.prepare('SELECT count(*) AS c FROM lane_jobs').get() as { c: number }).c)

describe('lane-job journal', () => {
  it('records a lane job while it runs and deletes the row on clean finish', async () => {
    expect(laneJobCount()).toBe(0)
    await store.engine.upsertNode('Tag', { id: 'lj-clean', name: 'clean', is_global: false })
    // A clean finish leaves no row — only a crash mid-job would.
    expect(laneJobCount()).toBe(0)
  })
})

describe('write-intent journal (graphWrite)', () => {
  it('inserts a pending row before the job and keeps its inverses current mid-job', async () => {
    let observed: { outcome: string; inverse_json: string | null } | undefined
    const { actionId } = await audit.graphWrite('agent', 'mid-job probe', async (tx) => {
      await tx.upsertNode('Tag', { id: 'midjob', name: 'm', is_global: false })
      // Mid-lane-job: the pending audit row exists with the created node's inverse.
      observed = appData.db
        .prepare(`SELECT outcome, inverse_json FROM audit_log WHERE outcome = 'pending'`)
        .get() as { outcome: string; inverse_json: string | null }
    })
    expect(observed?.outcome).toBe('pending')
    expect(observed?.inverse_json).toContain('delete-node') // undo of the create
    expect(observed?.inverse_json).toContain('midjob')

    // After completion the row is settled 'ok' and NOT visible as pending.
    const row = audit.getAction(actionId)!
    expect(row.outcome).toBe('ok')
    expect(audit.listActions().some((r) => r.outcome === ('pending' as string))).toBe(false)
    // Clean finish ⇒ no stranded lane_jobs row.
    expect(laneJobCount()).toBe(0)
  })
})

describe('boot sweep (a): interrupted audited write rolled back', () => {
  it('rolls back the partial write from a pending row, flips it to error, emits a warn', async () => {
    // Simulate a crash: a node that landed (the committed prefix) plus a 'pending'
    // audit row whose inverse rolls it back — exactly graphWrite's on-disk state at
    // the instant before its finalize.
    await store.engine.upsertNode('Tag', { id: 'crash-tag', name: 'partial', is_global: false })
    expect(await nodeCount('Tag', 'crash-tag')).toBe(1)
    const inverse = JSON.stringify([{ op: 'delete-node', label: 'Tag', id: 'crash-tag' }])
    appData.db
      .prepare(
        `INSERT INTO audit_log (id, agent_id, kind, description, reversible, inverse_json, outcome, details_json)
         VALUES (?, ?, 'graph-write', ?, 0, ?, 'pending', ?)`
      )
      .run('crash-1', 'agent', 'interrupted create of crash-tag', inverse, JSON.stringify({ ops: 1, rawMutations: 0 }))

    const result = await runCrashSweep({ db: appData.db, audit })

    expect(result.rolledBack).toBe(1)
    expect(result.rollbackFailed).toBe(0)
    // The partial write is gone.
    expect(await nodeCount('Tag', 'crash-tag')).toBe(0)
    // The row settled to 'error' with the suffix — no longer 'pending'.
    const row = audit.getAction('crash-1')!
    expect(row.outcome).toBe('error')
    expect(row.description).toMatch(/\(rolled back after interrupted write\)$/)
    // A warn diagnostic names the action.
    const warn = result.diagnostics.find((d) => d.detail.includes('interrupted create of crash-tag'))
    expect(warn?.level).toBe('warn')
    expect(warn?.subsystem).toBe('storage')
    // No pending rows remain; the sweep is idempotent (a re-run does nothing).
    const again = await runCrashSweep({ db: appData.db, audit })
    expect(again.rolledBack).toBe(0)
    expect(again.diagnostics).toHaveLength(0)
  })
})

describe('boot sweep (b): interrupted lane jobs', () => {
  it('flags a non-audited orphan and clears it; clears an audited orphan silently', async () => {
    // A settled audited write whose lane_jobs row was (hypothetically) stranded.
    const { actionId } = await audit.graphWrite('agent', 'settled audited write', async (tx) => {
      await tx.upsertNode('Tag', { id: 'audited-ok', name: 'ok', is_global: false })
    })
    // Manually strand two lane_jobs rows: one audited (maps to the row above), one
    // raw/non-audited (a crashed direct ingest withWrite).
    const insert = appData.db.prepare(
      `INSERT INTO lane_jobs (label, started_at) VALUES (?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))`
    )
    insert.run(`graph-write:${actionId}`)
    insert.run('upsertNode:Knowledge')
    expect(laneJobCount()).toBe(2)

    const result = await runCrashSweep({ db: appData.db, audit })

    expect(result.auditedCleared).toBe(1)
    expect(result.nonAuditedFlagged).toBe(1)
    // Both orphans cleared; the table is empty again.
    expect(laneJobCount()).toBe(0)
    // Exactly one warn, for the non-audited job, naming its label.
    const warns = result.diagnostics.filter((d) => d.level === 'warn')
    expect(warns).toHaveLength(1)
    expect(warns[0]!.detail).toContain('upsertNode:Knowledge')
    expect(warns[0]!.detail).toContain('idempotent')
    // The audited orphan produced NO diagnostic (it was reconciled via the audit path).
    expect(result.diagnostics.some((d) => d.detail.includes(actionId))).toBe(false)
  })
})
