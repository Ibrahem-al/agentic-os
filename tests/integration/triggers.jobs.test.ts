/**
 * Phase-11 maintenance jobs over the REAL engine:
 *
 *  - 'prune' (§6/§20): Sessions older than 14 days lose transcript_ref, the
 *    stubs and everything extracted stay; the prune is an AUDITED structured
 *    write — undoing it restores the pre-image (the §13 reversible-delta
 *    guarantee applies to the OS's own maintenance too). Phase 13: the same
 *    slot sweeps finished task rows + dead workflow checkpoints, sparing the
 *    §6 exactly-once dedup tokens (extraction rows, extract-* workflow ids);
 *  - 'export': the §5 weekly dump lands in exports/<date>/ with a manifest;
 *  - 'skill-improvement': owned by the REAL phase-12 agent
 *    (agents.skillimprove.test.ts); here we pin that a launch WITHOUT the
 *    agent parks the slot's task as deferred instead of burning retries.
 *
 * The maintenance kinds run as queue tasks through
 * registerMaintenanceHandlers — the exact wiring the croner schedules
 * enqueue into.
 */
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { TASK_ROW_RETENTION_DAYS } from '../../src/main/config'
import { AuditLog } from '../../src/main/security'
import { DurableTaskQueue, registerMaintenanceHandlers, runPruneJob } from '../../src/main/triggers'
import { runTaskRetentionSweep } from '../../src/main/triggers/jobs'
import { openKernelStack, type KernelTestStack } from '../fixtures/kernel-helpers'
import { openTestStore, type TestStore } from './helpers'

const DAY_MS = 24 * 60 * 60 * 1000

let baseDir: string
let store: TestStore
let stack: KernelTestStack
let audit: AuditLog
let queue: DurableTaskQueue
let exportsDir: string

const transcriptRefOf = async (id: string): Promise<string | null> => {
  const rows = await store.engine.cypher(`MATCH (s:Session {id: $id}) RETURN s.transcript_ref AS ref`, { id })
  expect(rows).toHaveLength(1)
  const ref = rows[0]?.['ref']
  return ref === null || ref === undefined ? null : String(ref)
}

const waitForTask = async (id: string, timeoutMs = 15_000): Promise<{ status: string; last_error: string | null }> => {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const row = stack.appData.db.prepare('SELECT status, last_error FROM tasks WHERE id = ?').get(id) as
      | { status: string; last_error: string | null }
      | undefined
    if (row !== undefined && row.status !== 'pending' && row.status !== 'running') return row
    if (Date.now() > deadline) throw new Error(`task ${id} did not settle (row: ${JSON.stringify(row ?? null)})`)
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
}

beforeAll(async () => {
  baseDir = mkdtempSync(join(tmpdir(), 'agentic-os-jobs-'))
  exportsDir = join(baseDir, 'exports')
  store = await openTestStore()
  stack = openKernelStack()
  audit = new AuditLog({ db: stack.appData.db, backupsDir: join(baseDir, 'backups'), engine: store.engine })

  const now = Date.now()
  await store.engine.upsertNode('Session', {
    id: 'session-ancient',
    started_at: new Date(now - 20 * DAY_MS),
    ended_at: new Date(now - 20 * DAY_MS + 60_000),
    transcript_ref: '/transcripts/ancient.jsonl'
  })
  await store.engine.upsertNode('Session', {
    id: 'session-old-no-ref',
    started_at: new Date(now - 30 * DAY_MS),
    ended_at: new Date(now - 30 * DAY_MS + 60_000)
  })
  await store.engine.upsertNode('Session', {
    id: 'session-fresh',
    started_at: new Date(now - 1 * DAY_MS),
    ended_at: new Date(now - 1 * DAY_MS + 60_000),
    transcript_ref: '/transcripts/fresh.jsonl'
  })

  queue = new DurableTaskQueue({ db: stack.appData.db })
  registerMaintenanceHandlers(queue, { engine: store.engine, audit, exportsDir })
  queue.start()
})

afterAll(async () => {
  await queue.stop(0)
  stack.cleanup()
  await store.cleanup()
  rmSync(baseDir, { recursive: true, force: true })
})

describe('nightly prune (§20: transcript_ref dropped after 14 days, stubs kept)', () => {
  it('drops only expired refs, keeps every Session stub, and is undoable (§13)', async () => {
    queue.enqueue({ id: 'prune-run-1', kind: 'prune' })
    const settled = await waitForTask('prune-run-1')
    expect(settled.status).toBe('done')

    expect(await transcriptRefOf('session-ancient')).toBeNull() // pruned
    expect(await transcriptRefOf('session-fresh')).toBe('/transcripts/fresh.jsonl') // kept
    expect(await transcriptRefOf('session-old-no-ref')).toBeNull() // nothing to drop
    const stubs = await store.engine.cypher(`MATCH (s:Session) RETURN count(s) AS c`)
    expect(Number(stubs[0]?.['c'])).toBe(3) // stubs stay

    // The prune is an audited REVERSIBLE action: undo restores the pre-image.
    const action = audit
      .listActions({ kind: 'graph-write' })
      .find((row) => row.description.includes('nightly prune'))
    expect(action).toBeDefined()
    expect(action?.reversible).toBe(true)
    await audit.undo(action!.id, 'user:test')
    expect(await transcriptRefOf('session-ancient')).toBe('/transcripts/ancient.jsonl')
  }, 30_000)

  it('is idempotent: a rerun after re-prune finds nothing new', async () => {
    // Re-prune (the undo above restored the ref), then prune again: no-op.
    const first = await runPruneJob({ engine: store.engine, audit, exportsDir })
    expect(first.pruned).toEqual(['session-ancient'])
    const second = await runPruneJob({ engine: store.engine, audit, exportsDir })
    expect(second.pruned).toEqual([])
  }, 30_000)
})

describe('weekly export + nightly skill slot', () => {
  it('the export task dumps the graph to exports/<date>/', async () => {
    queue.enqueue({ id: 'export-run-1', kind: 'export' })
    const settled = await waitForTask('export-run-1', 30_000)
    expect(settled.status).toBe('done')
    const days = readdirSync(exportsDir)
    expect(days).toHaveLength(1)
    const dir = join(exportsDir, days[0]!)
    expect(existsSync(join(dir, 'manifest.json'))).toBe(true)
    expect(existsSync(join(dir, 'graph.cypher'))).toBe(true)
    expect(existsSync(join(dir, 'nodes_Session.csv'))).toBe(true)
  }, 60_000)

  it('the skill-improvement slot parks as deferred when the phase-12 agent did not boot', async () => {
    // This queue registered only the maintenance handlers — the same shape as
    // a launch where the skill agent is unavailable: the task defers for a
    // launch that has it (never fails, never burns retries).
    queue.enqueue({ id: 'skill-run-1', kind: 'skill-improvement' })
    const settled = await waitForTask('skill-run-1')
    expect(settled.status).toBe('deferred')
    expect(settled.last_error).toContain("no handler registered for kind 'skill-improvement'")
  })
})

describe('task-row retention sweep (phase 13: the prune slot also cleans appdata)', () => {
  it('sweeps old finished rows + finished-workflow checkpoints, keeps the §6 dedup tokens', async () => {
    const db = stack.appData.db
    const insert = db.prepare(
      `INSERT INTO tasks (id, kind, payload_json, status, attempts, priority) VALUES (?, ?, '{}', ?, 1, 0)`
    )
    insert.run('old-done-probe', 'ingest-file', 'done') // old + finished → swept
    insert.run('old-failed-probe', 'watch-scan', 'failed') // old + finished → swept
    insert.run('extract-abc', 'extraction', 'done') // §6 dedup token → kept forever
    insert.run('extract-abc-wf', 'workflow', 'done') // extraction workflow id → kept
    insert.run('skill-xyz-wf', 'workflow', 'done') // ordinary finished workflow → swept
    insert.run('old-pending', 'ingest-file', 'pending') // not finished → kept
    insert.run('fresh-done', 'ingest-file', 'done') // finished but fresh → kept
    const backdated = new Date(Date.now() - (TASK_ROW_RETENTION_DAYS + 5) * DAY_MS).toISOString()
    db.prepare(
      `UPDATE tasks SET updated_at = ? WHERE id IN
       ('old-done-probe','old-failed-probe','extract-abc','extract-abc-wf','skill-xyz-wf','old-pending')`
    ).run(backdated)
    // Checkpoints of BOTH finished workflow jobs — dead weight either way
    // (extract-abc-wf keeps its task row, but its checkpoints still go).
    const insertCp = db.prepare(
      `INSERT INTO workflow_checkpoints (thread_id, checkpoint_ns, checkpoint_id, checkpoint, metadata)
       VALUES (?, '', ?, x'00', x'00')`
    )
    const insertCpWrite = db.prepare(
      `INSERT INTO workflow_checkpoint_writes (thread_id, checkpoint_ns, checkpoint_id, task_id, idx, channel, type, value)
       VALUES (?, '', ?, 'wt', 0, 'ch', 'json', x'00')`
    )
    insertCp.run('extract-abc-wf', 'cp-1')
    insertCp.run('extract-abc-wf', 'cp-2')
    insertCpWrite.run('extract-abc-wf', 'cp-2')
    insertCp.run('skill-xyz-wf', 'cp-1')
    insertCpWrite.run('skill-xyz-wf', 'cp-1')

    const logSpy = vi.spyOn(console, 'log')
    try {
      queue.enqueue({ id: 'prune-run-2', kind: 'prune' })
      const settled = await waitForTask('prune-run-2')
      expect(settled.status).toBe('done')
      // The handler note carries the sweep counts (3 task rows, 5 checkpoint
      // rows across both checkpoint tables).
      const noteLine = logSpy.mock.calls.map((args) => args.join(' ')).find((line) => line.includes('prune-run-2'))
      expect(noteLine).toContain('swept 3 task row(s), 5 checkpoint row(s)')
    } finally {
      logSpy.mockRestore()
    }

    const has = (id: string): boolean => db.prepare('SELECT 1 FROM tasks WHERE id = ?').get(id) !== undefined
    expect(has('old-done-probe')).toBe(false)
    expect(has('old-failed-probe')).toBe(false)
    expect(has('skill-xyz-wf')).toBe(false)
    expect(has('extract-abc')).toBe(true) // re-extraction stays impossible
    expect(has('extract-abc-wf')).toBe(true)
    expect(has('old-pending')).toBe(true)
    expect(has('fresh-done')).toBe(true)

    const checkpointCount = (threadId: string): number =>
      Number(
        (db.prepare('SELECT count(*) AS c FROM workflow_checkpoints WHERE thread_id = ?').get(threadId) as { c: number })
          .c
      ) +
      Number(
        (
          db.prepare('SELECT count(*) AS c FROM workflow_checkpoint_writes WHERE thread_id = ?').get(threadId) as {
            c: number
          }
        ).c
      )
    expect(checkpointCount('extract-abc-wf')).toBe(0)
    expect(checkpointCount('skill-xyz-wf')).toBe(0)
  }, 30_000)

  it('is idempotent: a rerun finds nothing left to sweep', () => {
    const sweep = runTaskRetentionSweep(stack.appData.db)
    expect(sweep.taskRows).toBe(0)
    expect(sweep.checkpointRows).toBe(0)
  })
})
