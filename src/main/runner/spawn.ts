/**
 * The runner spawn primitive (phase 17; P0.4/P0.10/§10.1/§10.10/§6.7).
 *
 * `spawnClaude` argv-array-spawns one headless `claude` (NEVER a shell), feeds
 * the prompt on stdin, captures stdout+stderr, and enforces a wall-clock
 * watchdog that kills the whole PROCESS TREE (`taskkill /T /F` on win32, a
 * negative-pid group kill on POSIX — the child is spawned `detached` there so it
 * owns a killable process group). Every spawn rides a `runner.spawn` telemetry
 * span so the CLI's otherwise-invisible lifecycle shows up in the trace spine.
 *
 * Crash-safe accounting (§10.1 zombie defense): a `runner_runs` row is inserted
 * with the pid + `started_at` the instant the child exists, then finalized on
 * exit. An app crash between insert and finalize leaves the row UNFINISHED
 * (`is_error`/`exit_code` both null) with a real pid — exactly what the boot
 * sweep looks for. `started_at` is `new Date().toISOString()` (the phase-14
 * `CallBudget.windowUsage` contract). The envelope parse is defensive: a missing
 * required field (`is_error`/`result`/`session_id`) is a not-installed-grade
 * failure that never crashes the caller.
 */
import { spawn as nodeSpawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import type BetterSqlite3 from 'better-sqlite3'
import type { Telemetry } from '../telemetry'
import type { RunnerEnvelope, RunnerMode, RunnerRunRecord, ResolvedBinary } from './types'

/** Full stdout kept (a completion `result` can be a few KB of text). */
export const RUNNER_MAX_OUTPUT_BYTES = 4 * 1024 * 1024
/** stderr tail persisted into `runner_runs.stderr_tail` (~2 KB, §10.10). */
export const RUNNER_STDERR_TAIL_BYTES = 2048

// ── envelope parse (§6.7/§10.12) ──────────────────────────────────────────────

export type EnvelopeParseResult =
  | { readonly ok: true; readonly envelope: RunnerEnvelope }
  | { readonly ok: false; readonly reason: 'empty' | 'not-json' | 'missing-field'; readonly detail: string }

function numOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function firstLine(text: string): string {
  return (text.split(/\r?\n/, 1)[0] ?? '').slice(0, 200)
}

/** Best-effort recovery of a JSON object when the CLI prefixes noise. */
function sliceLastJsonObject(text: string): string | null {
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  return start >= 0 && end > start ? text.slice(start, end + 1) : null
}

/**
 * Parse the `--output-format json` envelope. Unknown fields are ignored; the
 * three required fields are typed-checked. Tolerant to a trailing newline and to
 * leading log noise (retries on the last `{…}` slice).
 */
export function parseRunnerEnvelope(stdout: string): EnvelopeParseResult {
  const trimmed = stdout.trim()
  if (trimmed === '') return { ok: false, reason: 'empty', detail: 'runner produced no stdout' }

  let raw: unknown
  try {
    raw = JSON.parse(trimmed)
  } catch {
    const sliced = sliceLastJsonObject(trimmed)
    if (sliced === null) return { ok: false, reason: 'not-json', detail: firstLine(trimmed) }
    try {
      raw = JSON.parse(sliced)
    } catch {
      return { ok: false, reason: 'not-json', detail: firstLine(trimmed) }
    }
  }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, reason: 'not-json', detail: 'stdout was not a JSON object' }
  }
  const obj = raw as Record<string, unknown>
  const sessionId = obj['session_id']
  const isError = obj['is_error']
  const result = obj['result']
  if (typeof sessionId !== 'string' || typeof isError !== 'boolean' || typeof result !== 'string') {
    return {
      ok: false,
      reason: 'missing-field',
      detail: `envelope missing required is_error/result/session_id (keys: ${Object.keys(obj).slice(0, 12).join(',')})`
    }
  }
  const usage = obj['usage']
  const usageObj = usage !== null && typeof usage === 'object' && !Array.isArray(usage) ? (usage as Record<string, unknown>) : null
  return {
    ok: true,
    envelope: {
      sessionId,
      isError,
      result,
      numTurns: numOrNull(obj['num_turns']),
      durationMs: numOrNull(obj['duration_ms']),
      inputTokens: numOrNull(usageObj?.['input_tokens']),
      outputTokens: numOrNull(usageObj?.['output_tokens']),
      totalCostUsd: numOrNull(obj['total_cost_usd'])
    }
  }
}

// ── process-tree kill (P0.4/§10.1) ────────────────────────────────────────────

/**
 * Kill a spawned runner and its whole descendant tree. POSIX children are
 * spawned `detached`, so `process.kill(-pid)` drops the entire process group;
 * win32 uses `taskkill /T /F` (async, fire-and-forget) plus a direct
 * `child.kill` for immediacy. Every path is guarded — a race with normal exit
 * (pid already reaped) must never throw into a watchdog or teardown.
 */
export function killProcessTree(
  pid: number | null,
  platform: NodeJS.Platform,
  killChild?: () => void
): void {
  if (pid === null || pid <= 0) {
    try {
      killChild?.()
    } catch {
      /* already gone */
    }
    return
  }
  if (platform === 'win32') {
    try {
      nodeSpawn('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }).on('error', () => undefined)
    } catch {
      /* taskkill missing — fall back to the direct kill below */
    }
    try {
      killChild?.()
    } catch {
      /* already gone */
    }
    return
  }
  // POSIX: negative pid = the process GROUP the detached child leads.
  try {
    process.kill(-pid, 'SIGKILL')
  } catch {
    try {
      killChild?.()
    } catch {
      /* already gone */
    }
  }
}

// ── live-child registry (P0.4 will-quit + boot sweep support) ────────────────

interface LiveChild {
  readonly pid: number | null
  /** The spawn's task id — a queue task id (agent mode) or a `<jobId>`/`live:<sid>` key. */
  readonly taskId: string
  readonly kill: () => void
}

const liveChildren = new Set<LiveChild>()

/** Kill every runner child this process has in flight (called from will-quit). */
export function killAllRunnerChildren(): void {
  for (const child of liveChildren) {
    try {
      child.kill()
    } catch {
      /* best effort */
    }
  }
  liveChildren.clear()
}

/**
 * Kill the in-flight runner children belonging to a cancelled task (§8 cancel):
 * the exact task id OR any child keyed by a `<taskId>-…` id — in practice the
 * `<taskId>-wf` workflow job whose completion calls ride that id (task ids are
 * UUID-suffixed, so a prefix match never collides across sessions). Kills LIVE
 * registry handles — the pid-reuse-safe authority — never a recycled DB pid.
 * Returns how many were killed.
 */
export function killRunnerChildrenForTask(taskId: string): number {
  let killed = 0
  for (const child of liveChildren) {
    if (child.taskId === taskId || child.taskId.startsWith(`${taskId}-`)) {
      try {
        child.kill()
      } catch {
        /* already gone */
      }
      liveChildren.delete(child)
      killed += 1
    }
  }
  return killed
}

/** How many runner children are in flight right now (observability/tests). */
export function activeRunnerChildCount(): number {
  return liveChildren.size
}

// ── runner_runs statements (memoized per db handle) ──────────────────────────

interface RunnerRunStatements {
  readonly insertStart: BetterSqlite3.Statement
  readonly finalize: BetterSqlite3.Statement
}

const statementCache = new WeakMap<BetterSqlite3.Database, RunnerRunStatements>()

function statementsFor(db: BetterSqlite3.Database): RunnerRunStatements {
  const cached = statementCache.get(db)
  if (cached !== undefined) return cached
  const stmts: RunnerRunStatements = {
    insertStart: db.prepare(
      `INSERT INTO runner_runs (id, task_id, mode, model, claude_session_id, transport_session_id, pid, started_at)
       VALUES (@id, @task_id, @mode, @model, @claude_session_id, @transport_session_id, @pid, @started_at)`
    ),
    finalize: db.prepare(
      `UPDATE runner_runs SET
         duration_ms = @duration_ms, num_turns = @num_turns, input_tokens = @input_tokens,
         output_tokens = @output_tokens, shadow_cost_usd = @shadow_cost_usd, stderr_tail = @stderr_tail,
         is_error = @is_error, error = @error, exit_code = @exit_code,
         claude_session_id = COALESCE(@claude_session_id, claude_session_id)
       WHERE id = @id`
    )
  }
  statementCache.set(db, stmts)
  return stmts
}

function boolToInt(value: boolean | null): number | null {
  return value === null ? null : value ? 1 : 0
}

// ── spawnClaude ───────────────────────────────────────────────────────────────

export type SpawnImpl = (
  command: string,
  args: readonly string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv; windowsHide?: boolean; detached?: boolean }
) => ChildProcessWithoutNullStreams

const defaultSpawn: SpawnImpl = (command, args, options) => nodeSpawn(command, [...args], { ...options, stdio: 'pipe' })

/** Per-spawn bookkeeping context (the recording + tracing spine). */
export interface SpawnClaudeContext {
  readonly db: BetterSqlite3.Database
  readonly telemetry: Telemetry
  readonly mode: RunnerMode
  /** Resolved model id for the `runner_runs` row + span; null → CLI default. */
  readonly model: string | null
  /** Budget/trace key (workflow job id, or `live:<sid>` on the live path). */
  readonly taskId: string
  readonly now?: () => number
  readonly platform?: NodeJS.Platform
  readonly env?: NodeJS.ProcessEnv
  readonly spawnImpl?: SpawnImpl
  /** Test seam: pin the `runner_runs` row id. */
  readonly runId?: string
}

export interface SpawnClaudeOptions {
  readonly invocation: ResolvedBinary
  /** The claude args (appended after the invocation's prefixArgs). */
  readonly argv: readonly string[]
  /** The prompt (system+user) written to the child's stdin. */
  readonly stdin: string
  readonly cwd?: string
  readonly timeoutMs: number
  readonly signal?: AbortSignal
}

export interface SpawnClaudeResult {
  readonly record: RunnerRunRecord
  readonly envelope: RunnerEnvelope | null
  readonly parseError: string | null
  readonly stdout: string
  readonly stderr: string
  readonly exitCode: number | null
  readonly timedOut: boolean
  readonly spawnError: string | null
}

interface CollectOutcome {
  readonly stdout: string
  readonly stderr: string
  readonly exitCode: number | null
  readonly timedOut: boolean
}

/** Feed stdin, collect bounded stdout/stderr, enforce the watchdog + signal. */
function collect(
  child: ChildProcessWithoutNullStreams,
  opts: SpawnClaudeOptions,
  platform: NodeJS.Platform
): Promise<CollectOutcome> {
  return new Promise((resolve) => {
    let stdout = ''
    let stderr = ''
    let timedOut = false
    let settled = false
    const pid = child.pid ?? null

    const settle = (outcome: CollectOutcome): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (opts.signal !== undefined) opts.signal.removeEventListener('abort', onAbort)
      resolve(outcome)
    }
    const onAbort = (): void => {
      timedOut = false
      killProcessTree(pid, platform, () => child.kill('SIGKILL'))
    }

    const timer = setTimeout(() => {
      timedOut = true
      killProcessTree(pid, platform, () => child.kill('SIGKILL'))
    }, opts.timeoutMs)

    if (opts.signal !== undefined) {
      if (opts.signal.aborted) onAbort()
      else opts.signal.addEventListener('abort', onAbort, { once: true })
    }

    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      if (stdout.length < RUNNER_MAX_OUTPUT_BYTES) stdout = (stdout + chunk).slice(0, RUNNER_MAX_OUTPUT_BYTES)
    })
    child.stderr.on('data', (chunk: string) => {
      // Keep only the tail — the diagnostic value is at the end (the error line).
      stderr = (stderr + chunk).slice(-RUNNER_MAX_OUTPUT_BYTES)
    })
    child.on('error', () => settle({ stdout, stderr, exitCode: null, timedOut }))
    child.on('close', (code) => settle({ stdout, stderr, exitCode: code, timedOut }))

    child.stdin.on('error', () => undefined) // a child may exit before reading stdin
    child.stdin.end(opts.stdin)
  })
}

/**
 * Spawn one `claude`, record + finalize its `runner_runs` row, and return the
 * defensively-parsed envelope. Never throws for a runner-side failure (bad
 * binary, timeout, drift) — those come back as a finalized error record with
 * `envelope: null` + `spawnError`/`parseError`, so the completion/facade layer
 * can classify and decide. Only a programming error (e.g. a broken DB handle)
 * would propagate.
 */
export async function spawnClaude(ctx: SpawnClaudeContext, opts: SpawnClaudeOptions): Promise<SpawnClaudeResult> {
  const now = ctx.now ?? (() => Date.now())
  const platform = ctx.platform ?? process.platform
  const spawnImpl = ctx.spawnImpl ?? defaultSpawn
  const baseEnv = ctx.env ?? process.env
  const stmts = statementsFor(ctx.db)
  const id = ctx.runId ?? randomUUID()
  const startMs = now()
  const startedAt = new Date(startMs).toISOString()

  // Node's `.mjs`/`.js` seam: process.execPath may be an Electron binary, which
  // only behaves as Node with this env flag set (harmless under plain Node/vitest).
  const childEnv: NodeJS.ProcessEnv =
    opts.invocation.strategy === 'node-script' ? { ...baseEnv, ELECTRON_RUN_AS_NODE: '1' } : baseEnv

  return ctx.telemetry.withSpan(
    'runner.spawn',
    { 'runner.mode': ctx.mode, 'runner.model': ctx.model ?? '(default)', 'runner.task_id': ctx.taskId },
    async (span): Promise<SpawnClaudeResult> => {
      // 1. Spawn (sync). A synchronous throw = the binary is unspawnable.
      let child: ChildProcessWithoutNullStreams
      try {
        child = spawnImpl(opts.invocation.command, [...opts.invocation.prefixArgs, ...opts.argv], {
          ...(opts.cwd !== undefined ? { cwd: opts.cwd } : {}),
          env: childEnv,
          windowsHide: true,
          detached: platform !== 'win32'
        })
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        const record = finalizedRecord({
          id,
          ctx,
          startedAt,
          pid: null,
          durationMs: now() - startMs,
          envelope: null,
          stderrTail: null,
          isError: true,
          error: `spawn failed: ${message}`,
          exitCode: null
        })
        stmts.insertStart.run(startRow(record))
        stmts.finalize.run(finalizeRow(record))
        span.setAttribute('runner.exit_code', -1)
        return { record, envelope: null, parseError: null, stdout: '', stderr: '', exitCode: null, timedOut: false, spawnError: message }
      }

      // 2. The child exists — record its pid immediately (crash-safe), register it.
      const pid = child.pid ?? null
      const startRecord: RunnerRunRecord = {
        id,
        taskId: ctx.taskId,
        mode: ctx.mode,
        model: ctx.model,
        claudeSessionId: null,
        transportSessionId: null,
        pid,
        startedAt,
        durationMs: null,
        numTurns: null,
        inputTokens: null,
        outputTokens: null,
        shadowCostUsd: null,
        stderrTail: null,
        isError: null,
        error: null,
        exitCode: null
      }
      stmts.insertStart.run(startRow(startRecord))
      const handle: LiveChild = {
        pid,
        taskId: ctx.taskId,
        kill: () => killProcessTree(pid, platform, () => child.kill('SIGKILL'))
      }
      liveChildren.add(handle)

      // 3. Collect + finalize.
      try {
        const outcome = await collect(child, opts, platform)
        const parse = parseRunnerEnvelope(outcome.stdout)
        const envelope = parse.ok ? parse.envelope : null
        const parseError = parse.ok ? null : `${parse.reason}: ${parse.detail}`

        const { isError, error } = classifyOutcome(outcome, parse)
        const record = finalizedRecord({
          id,
          ctx,
          startedAt,
          pid,
          durationMs: now() - startMs,
          envelope,
          stderrTail: outcome.stderr === '' ? null : outcome.stderr.slice(-RUNNER_STDERR_TAIL_BYTES),
          isError,
          error,
          exitCode: outcome.exitCode
        })
        stmts.finalize.run(finalizeRow(record))

        span.setAttribute('runner.exit_code', outcome.exitCode ?? (outcome.timedOut ? 124 : -1))
        if (envelope?.numTurns != null) span.setAttribute('runner.num_turns', envelope.numTurns)
        if (outcome.timedOut) span.setAttribute('runner.timed_out', true)

        return {
          record,
          envelope,
          parseError,
          stdout: outcome.stdout,
          stderr: outcome.stderr,
          exitCode: outcome.exitCode,
          timedOut: outcome.timedOut,
          spawnError: null
        }
      } finally {
        liveChildren.delete(handle)
      }
    }
  )
}

// ── record helpers ────────────────────────────────────────────────────────────

/** Decide `is_error` + a human error string from the process outcome + parse. */
function classifyOutcome(outcome: CollectOutcome, parse: EnvelopeParseResult): { isError: boolean; error: string | null } {
  if (outcome.timedOut) return { isError: true, error: `killed at wall-clock timeout` }
  if (outcome.exitCode !== 0 && outcome.exitCode !== null) return { isError: true, error: `claude exited with code ${outcome.exitCode}` }
  if (!parse.ok) return { isError: true, error: `envelope ${parse.reason}: ${parse.detail}` }
  if (parse.envelope.isError) return { isError: true, error: 'envelope is_error=true' }
  return { isError: false, error: null }
}

interface FinalizeInput {
  readonly id: string
  readonly ctx: SpawnClaudeContext
  readonly startedAt: string
  readonly pid: number | null
  readonly durationMs: number
  readonly envelope: RunnerEnvelope | null
  readonly stderrTail: string | null
  readonly isError: boolean
  readonly error: string | null
  readonly exitCode: number | null
}

function finalizedRecord(input: FinalizeInput): RunnerRunRecord {
  return {
    id: input.id,
    taskId: input.ctx.taskId,
    mode: input.ctx.mode,
    model: input.ctx.model,
    claudeSessionId: input.envelope?.sessionId ?? null,
    transportSessionId: null, // completion mode has no MCP transport session
    pid: input.pid,
    startedAt: input.startedAt,
    durationMs: input.durationMs,
    numTurns: input.envelope?.numTurns ?? null,
    inputTokens: input.envelope?.inputTokens ?? null,
    outputTokens: input.envelope?.outputTokens ?? null,
    shadowCostUsd: input.envelope?.totalCostUsd ?? null,
    stderrTail: input.stderrTail,
    isError: input.isError,
    error: input.error,
    exitCode: input.exitCode
  }
}

/** Bind params for the start INSERT (8 columns). */
function startRow(r: RunnerRunRecord): Record<string, string | number | null> {
  return {
    id: r.id,
    task_id: r.taskId,
    mode: r.mode,
    model: r.model,
    claude_session_id: r.claudeSessionId,
    transport_session_id: r.transportSessionId,
    pid: r.pid,
    started_at: r.startedAt
  }
}

/** Bind params for the finalize UPDATE. */
function finalizeRow(r: RunnerRunRecord): Record<string, string | number | null> {
  return {
    id: r.id,
    duration_ms: r.durationMs,
    num_turns: r.numTurns,
    input_tokens: r.inputTokens,
    output_tokens: r.outputTokens,
    shadow_cost_usd: r.shadowCostUsd,
    stderr_tail: r.stderrTail,
    is_error: boolToInt(r.isError),
    error: r.error,
    exit_code: r.exitCode,
    claude_session_id: r.claudeSessionId
  }
}
