/**
 * Durable task queue — the §8 resource scheduler. An in-process priority
 * queue (the speed layer) mirrored to the appdata `tasks` table (the
 * durability layer): enqueue = INSERT, every status transition = UPDATE, and
 * start() reloads pending/running/deferred rows, so queued tasks survive
 * crashes and reboots. The dashboard's tasks panel reads this same table.
 *
 * Semantics:
 *  - Ordering: effective priority = priority + min(floor(waited / aging
 *    interval), TASK_AGING_MAX_BONUS) (§8 "aging prevents background
 *    starvation"), FIFO within a priority. Priority classes (§8 "live MCP >
 *    user-initiated > background") are numeric bands on the priority column
 *    (TASK_CLASS_BAND); the aging cap sits below the band width, so aging
 *    never lifts a task across a class boundary.
 *    Dispatch is serial and cooperative — one task at a time, never preempted
 *    mid-run (§8 "no mid-generation preemption"); heavy resources serialize
 *    in their own lanes anyway (write lane, cloud lane).
 *  - Live-session yield (§8): while `shouldYield()` reports a live MCP call
 *    in flight, dispatch waits — but never beyond TASK_YIELD_MAX_MS per
 *    dispatch (the aging guarantee applied to the yield itself).
 *  - Retry/backoff (§20): a failed task retries up to JOB_RETRY_ATTEMPTS
 *    times at 1 m / 5 m / 25 m, then flips to 'deferred' with the error
 *    flagged (§15 "defer to the next run"). Deferral persists; the next
 *    start() gives a deferred task a fresh round — the next launch IS its
 *    next run.
 *  - §13 approvals: a handler throwing KernelApprovalPendingError parks the
 *    task as 'deferred' + waiting_approval_id (headless it stays queued);
 *    onApprovalDecided() re-runs it on approval or fails it on denial —
 *    persisted, so a decision taken while the app is closed applies at the
 *    next start().
 *  - Dedup: callers may supply a deterministic id; enqueueing an id that
 *    already exists in ANY status is a no-op (`deduped: true`) — this is the
 *    §6 "extracted exactly once" mechanism (hook AND inactivity fallback
 *    enqueue `extract-<sessionId>`).
 *
 * Workflow job rows (kind 'workflow', owned by the LangGraphRunner) live in
 * the same table but are invisible to the queue: only kinds with a registered
 * handler are reloaded or dispatched.
 */
import { randomUUID } from 'node:crypto'
import type BetterSqlite3 from 'better-sqlite3'
import {
  JOB_RETRY_ATTEMPTS,
  JOB_RETRY_BACKOFF_MS,
  TASK_AGING_INTERVAL_MS,
  TASK_AGING_MAX_BONUS,
  TASK_YIELD_MAX_MS,
  TASK_YIELD_RECHECK_MS
} from '../config'
import { KernelApprovalPendingError, type JsonObject } from '../kernel'

/** Thrown by a handler when retrying is pointless (fails the task, no backoff). */
export class TaskFatalError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause })
    this.name = 'TaskFatalError'
  }
}

/**
 * Thrown by a handler when an upstream resource said "come back later" at a
 * KNOWN time (runner auth expiry, a provider quota window — phase 14,
 * MCP-COVERAGE P0.7): the task re-pends at exactly `retryAtUnixMs` and the
 * execution is NOT counted against the §20 retry round — waiting out a quota
 * window must never burn the three real attempts.
 */
export class TaskRetryAtError extends Error {
  constructor(
    readonly retryAtUnixMs: number,
    message?: string
  ) {
    super(message ?? `retry not before ${new Date(retryAtUnixMs).toISOString()}`)
    this.name = 'TaskRetryAtError'
  }
}

/**
 * Thrown by the task-control operations (retryDeferred / runNow / cancel) when a
 * request cannot be honored. `code` maps onto the MCP tool-error vocabulary
 * (NOT_FOUND / INVALID_STATE) without this module importing mcp.
 */
export class TaskRetryError extends Error {
  constructor(
    readonly code: 'NOT_FOUND' | 'INVALID_STATE',
    message: string
  ) {
    super(message)
    this.name = 'TaskRetryError'
  }
}

export interface EnqueueRequest {
  /** Deterministic id for dedup (e.g. `extract-<sessionId>`); default random. */
  readonly id?: string
  readonly kind: string
  readonly payload?: JsonObject
  /** Higher runs first (defaults from TASK_PRIORITY; 0 if omitted). */
  readonly priority?: number
  /** Unix ms before which the task must not run. */
  readonly notBeforeUnixMs?: number
}

export interface EnqueueResult {
  readonly taskId: string
  /** true = a task with this id already exists (any status); nothing inserted. */
  readonly deduped: boolean
}

export interface TaskRunContext {
  readonly taskId: string
  readonly kind: string
  /** Lifetime execution count including this run. */
  readonly attempts: number
  /**
   * §8 cooperative cancel: fires when `cancel(taskId)` targets the in-flight task.
   * A handler should thread it into the work it drives (e.g. the workflow runner's
   * run/resume, or an Ollama call) so a cancel takes effect promptly. The queue also
   * marks the task 'cancelled' once the handler unwinds — a handler that ignores the
   * signal still gets cancelled, just at its next natural stopping point.
   */
  readonly signal: AbortSignal
}

/** A handler may return a short note (logged); throwing drives retry/backoff. */
export type TaskHandler = (payload: JsonObject, ctx: TaskRunContext) => Promise<{ note?: string } | void>

export interface DurableTaskQueueDeps {
  readonly db: BetterSqlite3.Database
  /** §8: background dispatch yields while this reports live MCP work in flight. */
  readonly shouldYield?: () => boolean
  /**
   * Cancel hook: kill any OS child process(es) a task spawned (e.g. a runner
   * `claude` child), returning how many were killed. Called by cancel() for the
   * targeted task. Absent ⇒ cancel still marks the task 'cancelled' and aborts the
   * in-flight signal; it just cannot reach out-of-process children. Injected at boot
   * over the runner's live-child registry (pid-reuse-safe — never kills by DB pid).
   */
  readonly killChildrenForTask?: (taskId: string) => number
}

interface MemTask {
  readonly id: string
  readonly kind: string
  readonly payload: JsonObject
  readonly priority: number
  notBeforeUnixMs: number | null
  readonly enqueuedAtMs: number
  readonly seq: number
  /** Executions in the current retry round (a reload/approval starts a fresh round). */
  roundExecs: number
}

interface TaskRow {
  id: string
  kind: string
  payload_json: string | null
  status: string
  attempts: number
  not_before_unix_ms: number | null
  priority: number
  waiting_approval_id: string | null
}

const nowIso = (): string => new Date().toISOString()

/** The in-flight task + its cancel machinery (§8 cooperative cancel). */
interface CurrentTask {
  readonly task: MemTask
  done: Promise<void>
  readonly abort: AbortController
  /** Set by cancel(); read by runTask's settle path — the SINGLE writer of 'cancelled'. */
  cancelRequested: boolean
  /**
   * Set by pause(); read by runTask's settle path. Like cancelRequested but the
   * task re-enters the queue on resume() instead of being terminal. cancel wins
   * if BOTH are set (the stronger, terminal action).
   */
  pauseRequested: boolean
}

export class DurableTaskQueue {
  private readonly db: BetterSqlite3.Database
  private readonly shouldYield: (() => boolean) | undefined
  private readonly killChildrenForTask: ((taskId: string) => number) | undefined
  private readonly handlers = new Map<string, TaskHandler>()
  private readonly pending = new Map<string, MemTask>()
  /** approvalId → tasks parked behind that §13 pending approval. */
  private readonly waiting = new Map<string, MemTask[]>()
  private readonly insertTask: BetterSqlite3.Statement
  private readonly updateStatus: BetterSqlite3.Statement
  private readonly markRunning: BetterSqlite3.Statement
  private started = false
  private stopped = false
  private timer: NodeJS.Timeout | null = null
  private current: CurrentTask | null = null
  private seqCounter = 0
  private yieldedMs = 0

  constructor(deps: DurableTaskQueueDeps) {
    this.db = deps.db
    this.shouldYield = deps.shouldYield
    this.killChildrenForTask = deps.killChildrenForTask
    this.insertTask = deps.db.prepare(
      `INSERT INTO tasks (id, kind, payload_json, status, priority, not_before_unix_ms)
       VALUES (?, ?, ?, 'pending', ?, ?)
       ON CONFLICT(id) DO NOTHING`
    )
    this.updateStatus = deps.db.prepare(
      `UPDATE tasks SET status = ?, not_before_unix_ms = ?, waiting_approval_id = ?, last_error = ?, updated_at = ?
       WHERE id = ?`
    )
    this.markRunning = deps.db.prepare(
      `UPDATE tasks SET status = 'running', attempts = attempts + 1, waiting_approval_id = NULL,
              started_at = ?, updated_at = ?
       WHERE id = ?`
    )
  }

  /** Register the handler for a task kind. Must happen before start(). */
  registerHandler(kind: string, handler: TaskHandler): void {
    if (kind === 'workflow') throw new Error("kind 'workflow' belongs to the workflow runner, not the queue")
    if (this.handlers.has(kind)) throw new Error(`a handler for task kind '${kind}' is already registered`)
    this.handlers.set(kind, handler)
  }

  get registeredKinds(): readonly string[] {
    return [...this.handlers.keys()]
  }

  /** The id of the task executing right now (dashboard status). */
  get runningTaskId(): string | null {
    return this.current?.task.id ?? null
  }

  /**
   * The appdata handle behind the mirror. The nightly retention sweep
   * (jobs.ts) prunes finished rows from this same table via the queue
   * reference the prune handler already holds — no extra boot wiring.
   */
  get mirrorDb(): BetterSqlite3.Database {
    return this.db
  }

  enqueue(request: EnqueueRequest): EnqueueResult {
    const taskId = request.id ?? randomUUID()
    const payload = request.payload ?? {}
    const inserted = this.insertTask.run(
      taskId,
      request.kind,
      JSON.stringify(payload),
      request.priority ?? 0,
      request.notBeforeUnixMs ?? null
    )
    if (inserted.changes === 0) return { taskId, deduped: true }
    if (this.started && !this.stopped) {
      this.pending.set(taskId, {
        id: taskId,
        kind: request.kind,
        payload,
        priority: request.priority ?? 0,
        notBeforeUnixMs: request.notBeforeUnixMs ?? null,
        enqueuedAtMs: Date.now(),
        seq: this.seqCounter++,
        roundExecs: 0
      })
      this.poke()
    }
    return { taskId, deduped: false }
  }

  /**
   * Reload the durable rows (pending / crashed-running / deferred) for every
   * registered kind and begin dispatching. Deferred rows start a fresh retry
   * round; rows parked behind a §13 approval follow the approval's decision.
   */
  start(): { reloaded: number } {
    if (this.started) throw new Error('queue already started')
    this.started = true
    const kinds = [...this.handlers.keys()]
    let reloaded = 0
    if (kinds.length > 0) {
      const placeholders = kinds.map(() => '?').join(', ')
      const rows = this.db
        .prepare(
          `SELECT id, kind, payload_json, status, attempts, not_before_unix_ms, priority, waiting_approval_id
           FROM tasks
           WHERE status IN ('pending', 'running', 'deferred') AND kind IN (${placeholders})
           ORDER BY created_at, rowid`
        )
        .all(...kinds) as TaskRow[]
      const approvalStatus = this.db.prepare('SELECT status FROM approvals WHERE id = ?')
      for (const row of rows) {
        let payload: JsonObject = {}
        try {
          const parsed: unknown = JSON.parse(row.payload_json ?? '{}')
          if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) payload = parsed as JsonObject
        } catch {
          // A corrupt payload cannot run — flag it rather than crash the boot.
          this.updateStatus.run('failed', null, null, 'unparseable payload_json on reload', nowIso(), row.id)
          continue
        }
        const task: MemTask = {
          id: row.id,
          kind: row.kind,
          payload,
          priority: row.priority,
          notBeforeUnixMs: row.status === 'pending' ? row.not_before_unix_ms : null,
          enqueuedAtMs: Date.now(),
          seq: this.seqCounter++,
          roundExecs: 0
        }
        if (row.status === 'deferred' && row.waiting_approval_id !== null) {
          const approval = approvalStatus.get(row.waiting_approval_id) as { status: string } | undefined
          if (approval?.status === 'denied') {
            this.updateStatus.run(
              'failed',
              null,
              null,
              `approval ${row.waiting_approval_id} was denied`,
              nowIso(),
              row.id
            )
            continue
          }
          if (approval?.status === 'pending') {
            const parked = this.waiting.get(row.waiting_approval_id) ?? []
            parked.push(task)
            this.waiting.set(row.waiting_approval_id, parked)
            reloaded += 1
            continue
          }
          // approved (or the approval row vanished): run it now.
        }
        this.pending.set(task.id, task)
        if (row.status !== 'pending') {
          // Crashed-running and deferred rows re-enter as pending (a fresh
          // round); already-pending rows keep their backoff schedule + error.
          this.updateStatus.run('pending', task.notBeforeUnixMs, null, null, nowIso(), task.id)
        }
        reloaded += 1
      }
    }
    this.poke()
    return { reloaded }
  }

  /**
   * Stop dispatching. Resolves when the in-flight task (if any) finishes, or
   * after `timeoutMs` — a task cut off by quit stays 'running' in the mirror
   * and the next start() re-runs it (handlers are idempotent by design).
   */
  stop(timeoutMs = 5000): Promise<void> {
    this.stopped = true
    if (this.timer !== null) {
      clearTimeout(this.timer)
      this.timer = null
    }
    const inFlight = this.current?.done
    if (inFlight === undefined) return Promise.resolve()
    return new Promise((resolve) => {
      const cap = setTimeout(resolve, timeoutMs)
      void inFlight.finally(() => {
        clearTimeout(cap)
        resolve()
      })
    })
  }

  /**
   * A §13 approval was decided (dashboard or API). Tasks parked behind it
   * re-enter the queue (approved) or fail (denied). Unknown ids still update
   * any matching durable rows so a decision never gets lost across launches.
   */
  onApprovalDecided(approvalId: string, decision: 'approved' | 'denied'): void {
    const parked = this.waiting.get(approvalId) ?? []
    this.waiting.delete(approvalId)
    for (const task of parked) {
      if (decision === 'approved') {
        task.roundExecs = 0
        task.notBeforeUnixMs = null
        this.pending.set(task.id, task)
        this.updateStatus.run('pending', null, null, null, nowIso(), task.id)
      } else {
        this.updateStatus.run('failed', null, null, `approval ${approvalId} was denied`, nowIso(), task.id)
      }
    }
    // Durable fallback for rows not loaded in this process (applied next boot
    // otherwise): approved rows become pending, denied rows fail.
    const inMemory = new Set(parked.map((t) => t.id))
    const rows = this.db
      .prepare(`SELECT id FROM tasks WHERE waiting_approval_id = ? AND status = 'deferred'`)
      .all(approvalId) as { id: string }[]
    for (const row of rows) {
      if (inMemory.has(row.id)) continue
      if (decision === 'approved') this.updateStatus.run('pending', null, null, null, nowIso(), row.id)
      else this.updateStatus.run('failed', null, null, `approval ${approvalId} was denied`, nowIso(), row.id)
    }
    this.poke()
  }

  /**
   * Re-run a 'deferred' task NOW with a fresh §20 retry round (phase 14;
   * MCP-COVERAGE §4.E `retry_task`) — semantically what the next start()
   * reload would do to the row, without the restart. Deferred-only; the broader
   * "run it regardless of status" action is runNow(). Failures throw
   * TaskRetryError with an MCP-mappable code.
   */
  retryDeferred(taskId: string): { taskId: string; status: 'pending' } {
    return this.forceRun(taskId, new Set(['deferred']), 'retried (only deferred tasks can be retried)')
  }

  /**
   * "Run now" — the user (or an MCP client) forces a task to run immediately,
   * regardless of whether it is deferred, failed, cancelled, or a pending row
   * sitting out a retry backoff. Resets the §20 retry round and clears any backoff.
   * Rejects a task that is already running, already done, of an unregistered kind,
   * or parked behind a §13 human approval (that decision is the human's — decide it
   * in Approvals). Failures throw TaskRetryError with an MCP-mappable code.
   */
  runNow(taskId: string): { taskId: string; status: 'pending' } {
    return this.forceRun(
      taskId,
      new Set(['deferred', 'failed', 'cancelled', 'pending']),
      'run now (already done, or still running)'
    )
  }

  /**
   * Shared body of retryDeferred/runNow: validate the row against `allowed`
   * statuses, then re-pend it with a fresh round + cleared backoff. A row already
   * queued in memory (a pending backoff) is nudged in place rather than
   * double-inserted; a corrupt payload is flagged failed and rejected.
   */
  private forceRun(taskId: string, allowed: Set<string>, verb: string): { taskId: string; status: 'pending' } {
    const row = this.db
      .prepare(
        `SELECT id, kind, payload_json, status, attempts, not_before_unix_ms, priority, waiting_approval_id
         FROM tasks WHERE id = ?`
      )
      .get(taskId) as TaskRow | undefined
    if (row === undefined) throw new TaskRetryError('NOT_FOUND', `no task with id '${taskId}'`)
    if (this.current?.task.id === taskId) {
      throw new TaskRetryError('INVALID_STATE', `task '${taskId}' is already running`)
    }
    if (!allowed.has(row.status)) {
      throw new TaskRetryError('INVALID_STATE', `task '${taskId}' is '${row.status}' — cannot be ${verb}`)
    }
    if (row.waiting_approval_id !== null) {
      throw new TaskRetryError(
        'INVALID_STATE',
        `task '${taskId}' is parked behind approval '${row.waiting_approval_id}' — decide the approval instead`
      )
    }
    if (!this.handlers.has(row.kind)) {
      throw new TaskRetryError(
        'INVALID_STATE',
        `task '${taskId}' has kind '${row.kind}', which has no handler registered this launch`
      )
    }
    // Already queued in memory (a 'pending' row awaiting its backoff): nudge it to
    // run now — clear the backoff + reset the round — instead of a second insert.
    const queued = this.pending.get(taskId)
    if (queued !== undefined) {
      queued.notBeforeUnixMs = null
      queued.roundExecs = 0
      this.updateStatus.run('pending', null, null, null, nowIso(), taskId)
      this.poke()
      return { taskId, status: 'pending' }
    }
    let payload: JsonObject = {}
    try {
      const parsed: unknown = JSON.parse(row.payload_json ?? '{}')
      if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) payload = parsed as JsonObject
    } catch {
      // Same posture as start(): a corrupt payload cannot run — flag it.
      this.updateStatus.run('failed', null, null, 'unparseable payload_json on run', nowIso(), row.id)
      throw new TaskRetryError('INVALID_STATE', `task '${taskId}' has unparseable payload_json — marked failed`)
    }
    this.updateStatus.run('pending', null, null, null, nowIso(), taskId)
    this.pending.set(taskId, {
      id: row.id,
      kind: row.kind,
      payload,
      priority: row.priority,
      notBeforeUnixMs: null,
      enqueuedAtMs: Date.now(),
      seq: this.seqCounter++,
      roundExecs: 0
    })
    this.poke()
    return { taskId, status: 'pending' }
  }

  /**
   * Cancel a task (§8 user cancel). Semantics by state:
   *  - the in-flight task → set the cancel flag + abort its signal (a handler that
   *    threads ctx.signal stops promptly; one that ignores it stops at its next
   *    natural boundary), and kill any OS child it spawned. runTask's settle path is
   *    the SINGLE writer of the 'cancelled' row — no race with retry/defer/done.
   *  - a pending / deferred / orphaned-running / bare workflow row → drop it from
   *    memory and mark the row 'cancelled' now; kill any crash-orphaned child.
   * Rejects an already-finished task (done/failed/cancelled) and one parked behind a
   * §13 approval (decide it in Approvals — the human-gated spine stays untouched).
   * Cancelling is not terminal-forever: runNow revives a cancelled task (the workflow
   * job resumes from its last checkpoint, exactly like a failed one).
   */
  cancel(taskId: string): { taskId: string; status: 'cancelled'; wasRunning: boolean; killedChildren: number } {
    const row = this.db.prepare('SELECT id, kind, status, waiting_approval_id FROM tasks WHERE id = ?').get(taskId) as
      | { id: string; kind: string; status: string; waiting_approval_id: string | null }
      | undefined
    if (row === undefined) throw new TaskRetryError('NOT_FOUND', `no task with id '${taskId}'`)
    // A workflow (`<taskId>-wf`) row is an internal job owned by the runner, not a
    // queue task. If its DRIVER task is the in-flight one, redirect the cancel to the
    // driver so the driver's signal is aborted and its settle path is the single
    // writer of 'cancelled' (cancelling the raw -wf row would only kill the child and
    // race the runner's own terminal write). The dashboard already hides Cancel on
    // workflow rows; this guards any other caller. Driver kind is never 'workflow',
    // so the recursion is one level. A non-live -wf row falls through (harmless).
    if (row.kind === 'workflow' && row.id.endsWith('-wf')) {
      const driverId = row.id.slice(0, -'-wf'.length)
      if (this.current?.task.id === driverId) return this.cancel(driverId)
    }
    // A row that is 'running' in the DB but is THIS launch's current task is
    // cancellable; a terminal row (done/failed/cancelled) is not.
    const isCurrent = this.current?.task.id === taskId
    if (!isCurrent && (row.status === 'done' || row.status === 'failed' || row.status === 'cancelled')) {
      throw new TaskRetryError('INVALID_STATE', `task '${taskId}' is already '${row.status}' — nothing to cancel`)
    }
    if (row.waiting_approval_id !== null) {
      throw new TaskRetryError(
        'INVALID_STATE',
        `task '${taskId}' is waiting on approval '${row.waiting_approval_id}' — decide it in Approvals`
      )
    }
    if (isCurrent && this.current !== null) {
      // In flight: flag + abort; the settle path writes 'cancelled'. Do NOT write the
      // row here (that would race runTask's own settle write).
      this.current.cancelRequested = true
      this.current.abort.abort()
      const killedChildren = this.killChildrenForTask?.(taskId) ?? 0
      return { taskId, status: 'cancelled', wasRunning: true, killedChildren }
    }
    // Not in flight: drop from memory and settle the row now (single writer — no
    // dispatch is touching it).
    this.pending.delete(taskId)
    this.removeFromWaiting(taskId)
    this.updateStatus.run('cancelled', null, null, 'cancelled by user', nowIso(), taskId)
    const killedChildren = this.killChildrenForTask?.(taskId) ?? 0
    return { taskId, status: 'cancelled', wasRunning: false, killedChildren }
  }

  /**
   * Pause a task (§8 user pause — the non-destructive alternative to cancel).
   * Semantics by state:
   *  - the in-flight task → set the pause flag + abort its signal (cooperative,
   *    like cancel) and kill any OS child it spawned; runTask's settle path is the
   *    SINGLE writer of the 'paused' row. A workflow resumes from its last
   *    checkpoint on resume(); a plain handler re-runs (idempotent).
   *  - a pending / deferred row → drop it from memory and mark it 'paused' now, so
   *    the scheduler won't pick it up until resume() re-queues it. Paused rows are
   *    NOT reloaded by start(), so a pause survives restarts.
   * Rejects a finished task (done/failed/cancelled), an already-paused one, and one
   * parked behind a §13 approval (decide it in Approvals). resume() reverses it.
   */
  pause(taskId: string): { taskId: string; status: 'paused'; wasRunning: boolean; killedChildren: number } {
    const row = this.db.prepare('SELECT id, kind, status, waiting_approval_id FROM tasks WHERE id = ?').get(taskId) as
      | { id: string; kind: string; status: string; waiting_approval_id: string | null }
      | undefined
    if (row === undefined) throw new TaskRetryError('NOT_FOUND', `no task with id '${taskId}'`)
    // Redirect a live workflow (`<taskId>-wf`) row to its driver (same reasoning as cancel()).
    if (row.kind === 'workflow' && row.id.endsWith('-wf')) {
      const driverId = row.id.slice(0, -'-wf'.length)
      if (this.current?.task.id === driverId) return this.pause(driverId)
    }
    const isCurrent = this.current?.task.id === taskId
    if (!isCurrent && (row.status === 'done' || row.status === 'failed' || row.status === 'cancelled')) {
      throw new TaskRetryError('INVALID_STATE', `task '${taskId}' is already '${row.status}' — nothing to pause`)
    }
    if (!isCurrent && row.status === 'paused') {
      throw new TaskRetryError('INVALID_STATE', `task '${taskId}' is already paused`)
    }
    if (row.waiting_approval_id !== null) {
      throw new TaskRetryError(
        'INVALID_STATE',
        `task '${taskId}' is waiting on approval '${row.waiting_approval_id}' — decide it in Approvals`
      )
    }
    if (isCurrent && this.current !== null) {
      // In flight: flag + abort; the settle path writes 'paused'. (Same single-writer
      // discipline as cancel — do NOT write the row here.)
      this.current.pauseRequested = true
      this.current.abort.abort()
      const killedChildren = this.killChildrenForTask?.(taskId) ?? 0
      return { taskId, status: 'paused', wasRunning: true, killedChildren }
    }
    // Not in flight: drop from memory and hold the row.
    this.pending.delete(taskId)
    this.removeFromWaiting(taskId)
    this.updateStatus.run('paused', null, null, 'paused by user', nowIso(), taskId)
    const killedChildren = this.killChildrenForTask?.(taskId) ?? 0
    return { taskId, status: 'paused', wasRunning: false, killedChildren }
  }

  /**
   * Resume a 'paused' task — re-queue it with a fresh §20 round (a workflow picks
   * up from its last checkpoint, a plain handler re-runs). Paused-only; other
   * states use runNow(). Throws TaskRetryError with an MCP-mappable code.
   */
  resume(taskId: string): { taskId: string; status: 'pending' } {
    return this.forceRun(taskId, new Set(['paused']), 'resumed (only paused tasks can be resumed)')
  }

  /** Remove a task from every §13 approval-parked list it might sit in (cancel cleanup). */
  private removeFromWaiting(taskId: string): void {
    for (const [approvalId, parked] of this.waiting) {
      const next = parked.filter((t) => t.id !== taskId)
      if (next.length === 0) this.waiting.delete(approvalId)
      else if (next.length !== parked.length) this.waiting.set(approvalId, next)
    }
  }

  /** Status counts over the queue's rows (workflow jobs excluded). */
  counts(): Record<string, number> {
    const rows = this.db
      .prepare(`SELECT status, count(*) AS c FROM tasks WHERE kind != 'workflow' GROUP BY status`)
      .all() as { status: string; c: number }[]
    return Object.fromEntries(rows.map((r) => [r.status, r.c]))
  }

  /** Re-evaluate dispatch (new task, approval decision, timer wake). */
  poke(): void {
    this.schedule(0)
  }

  private schedule(delayMs: number): void {
    if (!this.started || this.stopped) return
    if (this.timer !== null) clearTimeout(this.timer)
    this.timer = setTimeout(() => {
      this.timer = null
      this.tick()
    }, delayMs)
  }

  private tick(): void {
    if (!this.started || this.stopped || this.current !== null) return
    const now = Date.now()
    let best: MemTask | null = null
    let bestScore = -Infinity
    let nextWake = Infinity
    for (const task of this.pending.values()) {
      const notBefore = task.notBeforeUnixMs ?? 0
      if (notBefore > now) {
        nextWake = Math.min(nextWake, notBefore)
        continue
      }
      const waited = Math.max(0, now - task.enqueuedAtMs)
      // Priority classes are numeric bands on the priority column
      // (TASK_CLASS_BAND in config.ts); capping aging below the band width
      // means a background task can never out-rank a user-initiated one,
      // while within-class aging still prevents starvation (§8). The 'live'
      // class is the shouldYield gate below — live MCP work is not a queue
      // task.
      const aging = Math.min(TASK_AGING_MAX_BONUS, Math.floor(waited / TASK_AGING_INTERVAL_MS))
      const score = task.priority + aging
      if (score > bestScore || (score === bestScore && best !== null && task.seq < best.seq)) {
        best = task
        bestScore = score
      }
    }
    if (best === null) {
      if (nextWake !== Infinity) this.schedule(Math.max(1, nextWake - now))
      return
    }
    if (this.shouldYield?.() === true && this.yieldedMs < TASK_YIELD_MAX_MS) {
      // §8: live MCP work is prioritized; background yields — but aging caps
      // the total yield so background work is never starved outright.
      this.yieldedMs += TASK_YIELD_RECHECK_MS
      this.schedule(TASK_YIELD_RECHECK_MS)
      return
    }
    this.yieldedMs = 0
    const task = best
    this.pending.delete(task.id)
    const entry: CurrentTask = {
      task,
      done: Promise.resolve(),
      abort: new AbortController(),
      cancelRequested: false,
      pauseRequested: false
    }
    this.current = entry
    entry.done = this.runTask(task, entry)
    void entry.done.finally(() => {
      this.current = null
      this.poke()
    })
  }

  private async runTask(task: MemTask, entry: CurrentTask): Promise<void> {
    task.roundExecs += 1
    let attempts = task.roundExecs
    try {
      const startIso = nowIso()
      this.markRunning.run(startIso, startIso, task.id)
      const row = this.db.prepare('SELECT attempts FROM tasks WHERE id = ?').get(task.id) as
        | { attempts: number }
        | undefined
      attempts = row?.attempts ?? attempts
      const handler = this.handlers.get(task.kind)
      if (handler === undefined) {
        // Should be impossible (reload filters on registered kinds) — park it
        // for a launch that has the subsystem instead of burning retries.
        this.updateStatus.run(
          'deferred',
          null,
          null,
          `no handler registered for kind '${task.kind}' this launch`,
          nowIso(),
          task.id
        )
        return
      }
      const outcome = await handler(task.payload, {
        taskId: task.id,
        kind: task.kind,
        attempts,
        signal: entry.abort.signal
      })
      // A handler that RETURNED wins over a racing cancel — the work finished, so
      // honor it as 'done' (matches "done beats cancel when it completes first").
      this.updateStatus.run('done', null, null, null, nowIso(), task.id)
      if (outcome?.note !== undefined) {
        console.log(`[triggers] task ${task.id} (${task.kind}) done — ${outcome.note}`)
      }
    } catch (err) {
      // §8 user cancel is the SINGLE writer of 'cancelled': cancel() only set the
      // flag + aborted the signal; here (the handler unwound via that abort) we
      // settle the row, so recordFailure never overwrites a cancel with retry/defer.
      // Cancel wins over pause when both are set (the terminal action).
      if (entry.cancelRequested) {
        try {
          this.updateStatus.run('cancelled', null, null, 'cancelled by user', nowIso(), task.id)
          console.warn(`[triggers] task ${task.id} (${task.kind}) cancelled by user`)
        } catch (updateErr) {
          console.warn(`[triggers] could not record cancel of task ${task.id}: ${String(updateErr)}`)
        }
        return
      }
      // §8 user pause: like cancel, the settle path is the SINGLE writer of 'paused'
      // (so recordFailure can't overwrite it). resume() re-pends the row later —
      // a workflow resumes from its last checkpoint, a plain handler re-runs (idempotent).
      if (entry.pauseRequested) {
        try {
          this.updateStatus.run('paused', null, null, 'paused by user', nowIso(), task.id)
          console.warn(`[triggers] task ${task.id} (${task.kind}) paused by user`)
        } catch (updateErr) {
          console.warn(`[triggers] could not record pause of task ${task.id}: ${String(updateErr)}`)
        }
        return
      }
      this.recordFailure(task, err)
    }
  }

  private recordFailure(task: MemTask, err: unknown): void {
    const message = err instanceof Error ? err.message : String(err)
    try {
      if (err instanceof KernelApprovalPendingError) {
        // §13: not a failure — parked until the dashboard decides.
        const parked = this.waiting.get(err.approvalId) ?? []
        parked.push(task)
        this.waiting.set(err.approvalId, parked)
        this.updateStatus.run(
          'deferred',
          null,
          err.approvalId,
          `waiting on approval ${err.approvalId}: ${message}`,
          nowIso(),
          task.id
        )
        return
      }
      if (err instanceof TaskFatalError) {
        this.updateStatus.run('failed', null, null, message, nowIso(), task.id)
        console.error(`[triggers] task ${task.id} (${task.kind}) failed permanently: ${message}`)
        return
      }
      if (err instanceof TaskRetryAtError) {
        // P0.7 (phase 14): not a real failure — the handler asked to be
        // re-run at a known time (auth/quota reset). Un-consume runTask's
        // pre-increment so the §20 retry round stays intact, and schedule
        // exactly there (no backoff arithmetic).
        task.roundExecs -= 1
        task.notBeforeUnixMs = err.retryAtUnixMs
        this.pending.set(task.id, task)
        this.updateStatus.run('pending', err.retryAtUnixMs, null, message, nowIso(), task.id)
        console.warn(
          `[triggers] task ${task.id} (${task.kind}) waiting until ${new Date(err.retryAtUnixMs).toISOString()} (no attempt consumed): ${message}`
        )
        return
      }
      const retryIndex = task.roundExecs - 1
      const backoff = JOB_RETRY_BACKOFF_MS[retryIndex]
      if (retryIndex < JOB_RETRY_ATTEMPTS && backoff !== undefined) {
        const notBefore = Date.now() + backoff
        task.notBeforeUnixMs = notBefore
        this.pending.set(task.id, task)
        this.updateStatus.run('pending', notBefore, null, message, nowIso(), task.id)
        console.warn(
          `[triggers] task ${task.id} (${task.kind}) failed (attempt ${task.roundExecs}) — retrying in ${Math.round(backoff / 1000)}s: ${message}`
        )
        return
      }
      // §20: after the retry round, defer to the next run + flag.
      this.updateStatus.run(
        'deferred',
        null,
        null,
        `deferred after ${task.roundExecs} attempts this round: ${message}`,
        nowIso(),
        task.id
      )
      console.error(`[triggers] task ${task.id} (${task.kind}) deferred after ${task.roundExecs} attempts: ${message}`)
    } catch (updateErr) {
      // The mirror update itself failed (e.g. db closed during quit) — the row
      // stays 'running' and the next start() re-runs the task.
      console.warn(`[triggers] could not record task ${task.id} outcome: ${String(updateErr)}`)
    }
  }
}
