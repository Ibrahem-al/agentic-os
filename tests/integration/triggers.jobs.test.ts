/**
 * Phase-11 maintenance jobs over the REAL engine:
 *
 *  - 'prune' (§6/§20): Sessions older than 14 days lose transcript_ref, the
 *    stubs and everything extracted stay; the prune is an AUDITED structured
 *    write — undoing it restores the pre-image (the §13 reversible-delta
 *    guarantee applies to the OS's own maintenance too);
 *  - 'export': the §5 weekly dump lands in exports/<date>/ with a manifest;
 *  - 'skill-improvement': the 02:00 slot completes as an explicit no-op
 *    until phase 12.
 *
 * All three run as queue tasks through registerMaintenanceHandlers — the
 * exact wiring the croner schedules enqueue into.
 */
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { AuditLog } from '../../src/main/security'
import { DurableTaskQueue, registerMaintenanceHandlers, runPruneJob } from '../../src/main/triggers'
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

  it('the skill-improvement slot completes as an explicit no-op (phase 12 fills it)', async () => {
    queue.enqueue({ id: 'skill-run-1', kind: 'skill-improvement' })
    const settled = await waitForTask('skill-run-1')
    expect(settled.status).toBe('done')
    expect(settled.last_error).toBeNull()
  })
})
