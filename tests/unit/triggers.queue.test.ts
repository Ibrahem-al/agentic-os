/**
 * DurableTaskQueue (§8 scheduler, phase 11): mirror-to-tasks durability,
 * priority + aging ordering, §20 retry/backoff → deferral, §13 approval
 * parking, dedup-by-id (the §6 exactly-once mechanism), reload semantics and
 * the live-session yield. Fake timers drive the clock; better-sqlite3 is
 * synchronous so the mirror is always inspectable mid-flight.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { JOB_RETRY_BACKOFF_MS, TASK_YIELD_MAX_MS } from '../../src/main/config'
import { KernelApprovalPendingError } from '../../src/main/kernel'
import { openAppData, type AppData } from '../../src/main/storage'
import { DurableTaskQueue, TaskFatalError } from '../../src/main/triggers'

interface TaskRow {
  id: string
  kind: string
  status: string
  attempts: number
  priority: number
  not_before_unix_ms: number | null
  waiting_approval_id: string | null
  last_error: string | null
}

let dir: string
let appData: AppData
let queues: DurableTaskQueue[]

beforeEach(() => {
  vi.useFakeTimers()
  dir = mkdtempSync(join(tmpdir(), 'agentic-os-queue-'))
  appData = openAppData(join(dir, 'appdata.db'))
  queues = []
})

afterEach(async () => {
  for (const queue of queues) await queue.stop(0)
  vi.useRealTimers()
  appData.close()
  rmSync(dir, { recursive: true, force: true })
})

const makeQueue = (shouldYield?: () => boolean): DurableTaskQueue => {
  const queue = new DurableTaskQueue({ db: appData.db, ...(shouldYield !== undefined ? { shouldYield } : {}) })
  queues.push(queue)
  return queue
}

const row = (id: string): TaskRow =>
  appData.db
    .prepare(
      'SELECT id, kind, status, attempts, priority, not_before_unix_ms, waiting_approval_id, last_error FROM tasks WHERE id = ?'
    )
    .get(id) as TaskRow

/** Let the dispatch timer fire and any settled handlers complete. */
const tick = async (ms = 5): Promise<void> => {
  await vi.advanceTimersByTimeAsync(ms)
}

const insertApproval = (id: string, status: 'pending' | 'approved' | 'denied'): void => {
  appData.db
    .prepare(
      `INSERT INTO approvals (id, signature, agent_id, action_kind, action_name, tier, status)
       VALUES (?, ?, 'rule:test', 'sandbox-run', 'demo', 'sandbox', ?)`
    )
    .run(id, `sig-${id}-${randomUUID()}`, status)
}

const approvalError = (approvalId: string): KernelApprovalPendingError =>
  new KernelApprovalPendingError('rule:test', { kind: 'sandbox-run', name: 'demo' }, 'queued for approval', approvalId)

describe('DurableTaskQueue (§8 mirror + §20 retry + §13 approvals)', () => {
  it('mirrors enqueue to the tasks table and runs the handler to done', async () => {
    const queue = makeQueue()
    const ran: string[] = []
    queue.registerHandler('probe', (payload) => {
      ran.push(String(payload['tag']))
      return Promise.resolve({ note: 'ok' })
    })
    queue.start()
    const result = queue.enqueue({ id: 't1', kind: 'probe', payload: { tag: 'a' }, priority: 3 })
    expect(result).toEqual({ taskId: 't1', deduped: false })
    expect(row('t1').status).toBe('pending')
    expect(row('t1').priority).toBe(3)
    await tick()
    expect(ran).toEqual(['a'])
    expect(row('t1')).toMatchObject({ status: 'done', attempts: 1, last_error: null })
  })

  it('dedups by id in every status — the §6 exactly-once mechanism', async () => {
    const queue = makeQueue()
    let runs = 0
    queue.registerHandler('probe', () => {
      runs += 1
      return Promise.resolve()
    })
    queue.start()
    queue.enqueue({ id: 'extract-s1', kind: 'probe' })
    expect(queue.enqueue({ id: 'extract-s1', kind: 'probe' })).toEqual({ taskId: 'extract-s1', deduped: true })
    await tick()
    expect(row('extract-s1').status).toBe('done')
    // Enqueueing after completion is STILL deduped (extracted exactly once).
    expect(queue.enqueue({ id: 'extract-s1', kind: 'probe' }).deduped).toBe(true)
    await tick()
    expect(runs).toBe(1)
  })

  it('orders by priority, FIFO within a priority', async () => {
    const queue = makeQueue()
    const order: string[] = []
    let release: (() => void) | null = null
    queue.registerHandler('blocker', () => new Promise<void>((resolve) => (release = resolve)))
    queue.registerHandler('probe', (payload) => {
      order.push(String(payload['tag']))
      return Promise.resolve()
    })
    queue.start()
    queue.enqueue({ id: 'block', kind: 'blocker' })
    await tick()
    // Enqueued while the blocker holds the (serial) dispatcher.
    queue.enqueue({ id: 'low-1', kind: 'probe', payload: { tag: 'low-1' }, priority: 0 })
    queue.enqueue({ id: 'high', kind: 'probe', payload: { tag: 'high' }, priority: 5 })
    queue.enqueue({ id: 'low-2', kind: 'probe', payload: { tag: 'low-2' }, priority: 0 })
    release!()
    await tick()
    await tick()
    await tick()
    expect(order).toEqual(['high', 'low-1', 'low-2'])
  })

  it('aging lifts a starved task past fresher higher-priority work (§8)', async () => {
    const queue = makeQueue()
    const order: string[] = []
    let release: (() => void) | null = null
    queue.registerHandler('blocker', () => new Promise<void>((resolve) => (release = resolve)))
    queue.registerHandler('probe', (payload) => {
      order.push(String(payload['tag']))
      return Promise.resolve()
    })
    queue.start()
    queue.enqueue({ id: 'block', kind: 'blocker' })
    await tick()
    queue.enqueue({ id: 'old-low', kind: 'probe', payload: { tag: 'old-low' }, priority: 0 })
    // 26 minutes pass while the blocker runs: effective = 0 + floor(26/5) = 5.
    await vi.advanceTimersByTimeAsync(26 * 60_000)
    queue.enqueue({ id: 'fresh-high', kind: 'probe', payload: { tag: 'fresh-high' }, priority: 4 })
    release!()
    await tick()
    await tick()
    expect(order).toEqual(['old-low', 'fresh-high'])
  })

  it('retries with the §20 backoff (1m / 5m / 25m) then defers + flags', async () => {
    const queue = makeQueue()
    let attempts = 0
    queue.registerHandler('flaky', () => {
      attempts += 1
      throw new Error(`boom ${attempts}`)
    })
    queue.start()
    queue.enqueue({ id: 'f1', kind: 'flaky' })
    await tick()
    expect(attempts).toBe(1)
    expect(row('f1').status).toBe('pending')
    const notBefore = row('f1').not_before_unix_ms ?? 0
    expect(notBefore).toBeGreaterThan(Date.now() + JOB_RETRY_BACKOFF_MS[0] - 100)
    expect(notBefore).toBeLessThanOrEqual(Date.now() + JOB_RETRY_BACKOFF_MS[0])
    // Not yet: just short of the scheduled retry moment.
    await vi.advanceTimersByTimeAsync(notBefore - Date.now() - 10)
    expect(attempts).toBe(1)
    await vi.advanceTimersByTimeAsync(20)
    expect(attempts).toBe(2)
    await vi.advanceTimersByTimeAsync(JOB_RETRY_BACKOFF_MS[1] + 10)
    expect(attempts).toBe(3)
    await vi.advanceTimersByTimeAsync(JOB_RETRY_BACKOFF_MS[2] + 10)
    expect(attempts).toBe(4)
    const after = row('f1')
    expect(after.status).toBe('deferred')
    expect(after.attempts).toBe(4)
    expect(after.last_error).toContain('deferred after 4 attempts')
    expect(after.last_error).toContain('boom 4')
    // Deferral persists: nothing else runs it this launch.
    await vi.advanceTimersByTimeAsync(60 * 60_000)
    expect(attempts).toBe(4)
  })

  it('TaskFatalError fails immediately without retries', async () => {
    const queue = makeQueue()
    let attempts = 0
    queue.registerHandler('fatal', () => {
      attempts += 1
      throw new TaskFatalError('pointless to retry')
    })
    queue.start()
    queue.enqueue({ id: 'x1', kind: 'fatal' })
    await tick()
    await vi.advanceTimersByTimeAsync(30 * 60_000)
    expect(attempts).toBe(1)
    expect(row('x1')).toMatchObject({ status: 'failed', last_error: 'pointless to retry' })
  })

  it('parks a task behind a §13 approval; approval decision re-runs or fails it', async () => {
    const queue = makeQueue()
    insertApproval('apr-1', 'pending')
    insertApproval('apr-2', 'pending')
    let allowed = false
    const ran: string[] = []
    queue.registerHandler('gated', (payload) => {
      const tag = String(payload['tag'])
      if (!allowed) throw approvalError(tag === 'a' ? 'apr-1' : 'apr-2')
      ran.push(tag)
      return Promise.resolve()
    })
    queue.start()
    queue.enqueue({ id: 'g1', kind: 'gated', payload: { tag: 'a' } })
    queue.enqueue({ id: 'g2', kind: 'gated', payload: { tag: 'b' } })
    await tick()
    await tick()
    expect(row('g1')).toMatchObject({ status: 'deferred', waiting_approval_id: 'apr-1' })
    expect(row('g2')).toMatchObject({ status: 'deferred', waiting_approval_id: 'apr-2' })
    // No retry churn while parked.
    await vi.advanceTimersByTimeAsync(60 * 60_000)
    expect(ran).toEqual([])

    allowed = true
    queue.onApprovalDecided('apr-1', 'approved')
    await tick()
    expect(ran).toEqual(['a'])
    expect(row('g1').status).toBe('done')

    queue.onApprovalDecided('apr-2', 'denied')
    await tick()
    expect(row('g2').status).toBe('failed')
    expect(row('g2').last_error).toContain('apr-2')
    expect(ran).toEqual(['a'])
  })

  it('reloads pending, crashed-running and deferred rows on start (§8 durability)', async () => {
    // Simulate a previous launch's leftovers directly in the mirror.
    const insert = appData.db.prepare(
      `INSERT INTO tasks (id, kind, payload_json, status, attempts, not_before_unix_ms, priority, waiting_approval_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    insert.run('p1', 'probe', '{"tag":"p1"}', 'pending', 0, null, 0, null)
    insert.run('r1', 'probe', '{"tag":"r1"}', 'running', 1, null, 0, null) // crashed mid-run
    insert.run('d1', 'probe', '{"tag":"d1"}', 'deferred', 4, null, 0, null) // retry-exhausted last launch
    insert.run('done1', 'probe', '{"tag":"done1"}', 'done', 1, null, 0, null) // never reloaded
    insert.run('w1', 'workflow', '{}', 'running', 1, null, 0, null) // runner-owned, invisible
    insert.run('other', 'unregistered-kind', '{}', 'pending', 0, null, 0, null) // no handler → stays put

    const queue = makeQueue()
    const ran: string[] = []
    queue.registerHandler('probe', (payload) => {
      ran.push(String(payload['tag']))
      return Promise.resolve()
    })
    const { reloaded } = queue.start()
    expect(reloaded).toBe(3)
    await tick()
    await tick()
    await tick()
    expect(ran.sort()).toEqual(['d1', 'p1', 'r1'])
    expect(row('w1').status).toBe('running') // untouched
    expect(row('other').status).toBe('pending') // untouched, waits for its launch
    expect(row('done1').attempts).toBe(1)
  })

  it('applies an approval decided while the app was down, at reload', async () => {
    insertApproval('apr-ok', 'approved')
    insertApproval('apr-no', 'denied')
    insertApproval('apr-wait', 'pending')
    const insert = appData.db.prepare(
      `INSERT INTO tasks (id, kind, payload_json, status, attempts, priority, waiting_approval_id)
       VALUES (?, 'gated', '{}', 'deferred', 1, 0, ?)`
    )
    insert.run('ga', 'apr-ok')
    insert.run('gb', 'apr-no')
    insert.run('gc', 'apr-wait')

    const queue = makeQueue()
    const ran: string[] = []
    queue.registerHandler('gated', (_payload, ctx) => {
      ran.push(ctx.taskId)
      return Promise.resolve()
    })
    queue.start()
    await tick()
    expect(ran).toEqual(['ga']) // approved → ran
    expect(row('gb').status).toBe('failed') // denied → failed at reload
    expect(row('gc').status).toBe('deferred') // still parked
    queue.onApprovalDecided('apr-wait', 'approved')
    await tick()
    expect(ran).toEqual(['ga', 'gc'])
  })

  it('yields to live MCP work, but never past the §8 aging cap', async () => {
    let live = true
    const queue = makeQueue(() => live)
    const ran: string[] = []
    queue.registerHandler('probe', (_payload, ctx) => {
      ran.push(ctx.taskId)
      return Promise.resolve()
    })
    queue.start()
    queue.enqueue({ id: 'y1', kind: 'probe' })
    await vi.advanceTimersByTimeAsync(5_000)
    expect(ran).toEqual([]) // yielding while a live call is in flight
    live = false
    await tick(1_500)
    expect(ran).toEqual(['y1']) // resumes promptly once the live call ends

    live = true
    queue.enqueue({ id: 'y2', kind: 'probe' })
    await vi.advanceTimersByTimeAsync(TASK_YIELD_MAX_MS + 5_000)
    expect(ran).toEqual(['y1', 'y2']) // the cap: background is never starved
  })

  it('parks a dispatched task whose kind lost its handler (defensive)', async () => {
    // enqueue() accepts any kind; dispatch defers unhandled kinds so the task
    // survives to a launch where the subsystem booted.
    const queue = makeQueue()
    queue.registerHandler('probe', () => Promise.resolve())
    queue.start()
    queue.enqueue({ id: 'nh1', kind: 'needs-agent' })
    await tick()
    expect(row('nh1').status).toBe('deferred')
    expect(row('nh1').last_error).toContain('no handler registered')
  })

  it('respects notBeforeUnixMs', async () => {
    const queue = makeQueue()
    const ran: string[] = []
    queue.registerHandler('probe', (_payload, ctx) => {
      ran.push(ctx.taskId)
      return Promise.resolve()
    })
    queue.start()
    queue.enqueue({ id: 'later', kind: 'probe', notBeforeUnixMs: Date.now() + 60_000 })
    await vi.advanceTimersByTimeAsync(59_000)
    expect(ran).toEqual([])
    await vi.advanceTimersByTimeAsync(2_000)
    expect(ran).toEqual(['later'])
  })
})
