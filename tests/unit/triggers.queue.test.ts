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
import {
  JOB_RETRY_BACKOFF_MS,
  TASK_AGING_INTERVAL_MS,
  TASK_AGING_MAX_BONUS,
  TASK_CLASS_BAND,
  TASK_PRIORITY,
  TASK_YIELD_MAX_MS
} from '../../src/main/config'
import { ExtractionUnavailableError } from '../../src/main/agents'
import { KernelApprovalPendingError } from '../../src/main/kernel'
import { openAppData, type AppData } from '../../src/main/storage'
import { DurableTaskQueue, TaskFatalError, TaskRetryAtError, TaskRetryError } from '../../src/main/triggers'

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

  it('caps the aging bonus at TASK_AGING_MAX_BONUS (§8 within-class aging only)', async () => {
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
    queue.enqueue({ id: 'ancient', kind: 'probe', payload: { tag: 'ancient' }, priority: 0 })
    // Far beyond cap × interval: uncapped, 'ancient' would score ~3× the cap;
    // capped, its effective score is exactly 0 + TASK_AGING_MAX_BONUS — a
    // fresh task one point above the cap must win.
    await vi.advanceTimersByTimeAsync(3 * TASK_AGING_MAX_BONUS * TASK_AGING_INTERVAL_MS)
    queue.enqueue({
      id: 'above-cap',
      kind: 'probe',
      payload: { tag: 'above-cap' },
      priority: TASK_AGING_MAX_BONUS + 1
    })
    release!()
    await tick()
    await tick()
    expect(order).toEqual(['above-cap', 'ancient'])
  })

  it('a fresh user-band task outranks a long-starved background task (§8 classes)', async () => {
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
    queue.enqueue({
      id: 'bg-starved',
      kind: 'probe',
      payload: { tag: 'bg-starved' },
      priority: TASK_CLASS_BAND.background + TASK_PRIORITY.extraction
    })
    // 30 days of waiting cannot lift a background task across the band.
    await vi.advanceTimersByTimeAsync(30 * 24 * 60 * 60_000)
    queue.enqueue({
      id: 'user-fresh',
      kind: 'probe',
      payload: { tag: 'user-fresh' },
      priority: TASK_CLASS_BAND.user + TASK_PRIORITY.skillImprove
    })
    release!()
    await tick()
    await tick()
    expect(order).toEqual(['user-fresh', 'bg-starved'])
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

  it('TaskRetryAtError re-pends at exactly the stated time without consuming a §20 attempt (P0.7)', async () => {
    const queue = makeQueue()
    let execs = 0
    let retryAt = 0
    queue.registerHandler('quota', () => {
      execs += 1
      if (execs === 1) {
        retryAt = Date.now() + 10 * 60_000
        throw new TaskRetryAtError(retryAt, 'quota window exhausted — resets soon')
      }
      throw new Error(`boom ${execs}`)
    })
    queue.start()
    queue.enqueue({ id: 'q1', kind: 'quota' })
    await tick()
    expect(execs).toBe(1)
    // Re-pended at EXACTLY retryAt — no backoff arithmetic — error recorded.
    const parked = row('q1')
    expect(parked.status).toBe('pending')
    expect(parked.not_before_unix_ms).toBe(retryAt)
    expect(parked.last_error).toContain('quota window exhausted')
    // Nothing runs before the stated moment…
    await vi.advanceTimersByTimeAsync(10 * 60_000 - 20)
    expect(execs).toBe(1)
    // …and the wake-up execution starts a FULL fresh §20 round: 4 more
    // executions (1m/5m/25m backoffs) before deferral — the retry-at
    // execution consumed no attempt.
    await vi.advanceTimersByTimeAsync(40)
    expect(execs).toBe(2)
    await vi.advanceTimersByTimeAsync(JOB_RETRY_BACKOFF_MS[0] + 10)
    expect(execs).toBe(3)
    await vi.advanceTimersByTimeAsync(JOB_RETRY_BACKOFF_MS[1] + 10)
    expect(execs).toBe(4)
    await vi.advanceTimersByTimeAsync(JOB_RETRY_BACKOFF_MS[2] + 10)
    expect(execs).toBe(5)
    const after = row('q1')
    expect(after.status).toBe('deferred')
    expect(after.attempts).toBe(5) // lifetime count stays honest
    expect(after.last_error).toContain('deferred after 4 attempts') // the round never saw the retry-at exec
  })

  it('retryDeferred re-runs a deferred task now with a fresh round (§4.E retry_task)', async () => {
    const queue = makeQueue()
    const ran: string[] = []
    queue.registerHandler('probe', (payload, ctx) => {
      ran.push(`${ctx.taskId}:${String(payload['tag'])}`)
      return Promise.resolve()
    })
    queue.start()
    // A task deferred by a previous round, simulated directly in the mirror
    // (same approach as the reload test — start() already ran, so only
    // retryDeferred can bring it back this launch).
    appData.db
      .prepare(
        `INSERT INTO tasks (id, kind, payload_json, status, attempts, priority, last_error)
         VALUES ('rd1', 'probe', '{"tag":"x"}', 'deferred', 4, 0, 'deferred after 4 attempts')`
      )
      .run()
    expect(queue.retryDeferred('rd1')).toEqual({ taskId: 'rd1', status: 'pending' })
    expect(row('rd1').status).toBe('pending')
    expect(row('rd1').last_error).toBeNull() // fresh round, slate wiped
    await tick()
    expect(ran).toEqual(['rd1:x']) // payload survived the round trip
    expect(row('rd1').status).toBe('done')
  })

  it('retryDeferred guards: NOT_FOUND / wrong status / no handler / approval-parked', async () => {
    const queue = makeQueue()
    queue.registerHandler('probe', () => Promise.resolve())
    queue.start()
    const codeOf = (fn: () => unknown): string | null => {
      try {
        fn()
      } catch (err) {
        return err instanceof TaskRetryError ? err.code : `not-a-TaskRetryError: ${String(err)}`
      }
      return null
    }
    // Unknown id.
    expect(codeOf(() => queue.retryDeferred('ghost'))).toBe('NOT_FOUND')
    // Wrong status (§4.E: pending/running/done are INVALID_STATE).
    const insert = appData.db.prepare(
      `INSERT INTO tasks (id, kind, payload_json, status, attempts, priority, waiting_approval_id)
       VALUES (?, 'probe', '{}', ?, 0, 0, ?)`
    )
    insert.run('rd-done', 'done', null)
    expect(codeOf(() => queue.retryDeferred('rd-done'))).toBe('INVALID_STATE')
    expect(() => queue.retryDeferred('rd-done')).toThrow(/not 'deferred'/)
    // Deferred, but its kind has no handler this launch.
    insert.run('rd-alien', 'deferred', null)
    appData.db.prepare(`UPDATE tasks SET kind = 'alien' WHERE id = 'rd-alien'`).run()
    expect(codeOf(() => queue.retryDeferred('rd-alien'))).toBe('INVALID_STATE')
    expect(() => queue.retryDeferred('rd-alien')).toThrow(/no handler registered/)
    // Parked behind a pending §13 approval: the human decides, not retry_task.
    insert.run('rd-parked', 'deferred', 'apr-parked')
    expect(codeOf(() => queue.retryDeferred('rd-parked'))).toBe('INVALID_STATE')
    expect(() => queue.retryDeferred('rd-parked')).toThrow(/approval 'apr-parked'/)
    // None of the refused rows were touched.
    expect(row('rd-done').status).toBe('done')
    expect(row('rd-alien').status).toBe('deferred')
    expect(row('rd-parked')).toMatchObject({ status: 'deferred', waiting_approval_id: 'apr-parked' })
    await tick()
  })

  it('an ExtractionUnavailableError-throwing handler retries and DEFERS — never done, never failed (P0.1)', async () => {
    const queue = makeQueue()
    let attempts = 0
    queue.registerHandler('extraction-sim', () => {
      attempts += 1
      throw new ExtractionUnavailableError('extraction: all 3 local fuzzy-pass calls failed')
    })
    queue.start()
    queue.enqueue({ id: 'extract-p01', kind: 'extraction-sim' })
    await tick()
    // Retryable, not fatal: the first failure re-pends with the §20 backoff.
    expect(row('extract-p01').status).toBe('pending')
    await vi.advanceTimersByTimeAsync(JOB_RETRY_BACKOFF_MS[0] + 10)
    await vi.advanceTimersByTimeAsync(JOB_RETRY_BACKOFF_MS[1] + 10)
    await vi.advanceTimersByTimeAsync(JOB_RETRY_BACKOFF_MS[2] + 10)
    expect(attempts).toBe(4)
    const after = row('extract-p01')
    expect(after.status).toBe('deferred') // NOT 'done' (silent loss) and NOT 'failed' (unretryable)
    expect(after.last_error).toContain('fuzzy-pass calls failed')
    // …and §4.E retryDeferred hands the exactly-once token a fresh round.
    expect(queue.retryDeferred('extract-p01')).toEqual({ taskId: 'extract-p01', status: 'pending' })
    await tick()
    expect(attempts).toBe(5)
    expect(row('extract-p01').status).toBe('pending') // failing again → a new backoff round, still not lost
  })
})
