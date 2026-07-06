/**
 * Runner completion mode end-to-end over the FAKE `claude -p` (phase 17;
 * P0.2/P0.4/P0.8/P0.9/§10.1). Every case drives the REAL spawn stack against
 * tests/fixtures/fake-runner.mjs via the `AGENTIC_OS_RUNNER_BINARY` seam
 * (binary.ts sees the `.mjs`, spawns `process.execPath [script,…]` with
 * ELECTRON_RUN_AS_NODE so the Node fake runs cross-platform, no shell, no real
 * CLI). Offline + hermetic. Pins:
 *   - the watchdog kills a hung fake's whole PROCESS TREE at the timeout (no orphan);
 *   - `runner_runs.started_at` is ISO-8601 UTC, and CallBudget.windowUsage reads it;
 *   - every envelope drift is a finalized error record, never a throw;
 *   - the completion fn maps auth/quota/drift/generic to the right typed error + health state;
 *   - CallBudget trips at RUNNER_TASK_MAX_CALLS and the quota self-throttle at the
 *     window fraction — both BEFORE any spawn;
 *   - wired as the ProviderRouter's `subscriptionComplete`/`runnerHealthy`, a
 *     subscribable role (enabled + healthy) routes to the runner ($0, no spend
 *     row, one runner_runs row), and disabled/unhealthy falls back to cloud
 *     (DEFAULT == TODAY);
 *   - `sweepZombies` kills an unfinished row whose live pid matches the runner
 *     image, finalizes stale rows, and leaves finished rows alone.
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { RUNNER_QUOTA_FRACTION, RUNNER_TASK_MAX_CALLS, RUNNER_WINDOW_TOKEN_BUDGET } from '../../src/main/config'
import {
  CallBudget,
  CallBudgetExceededError,
  ProviderRouter,
  RunnerQuotaError,
  SpendCeilingExceededError,
  SpendMeter,
  defaultModelSettings,
  defaultRunnerSettings,
  type CloudBrain,
  type ModelSettings,
  type OllamaLike
} from '../../src/main/models'
import {
  activeRunnerChildCount,
  resetRunnerLanesForTests,
  resolveClaudeBinary,
  Runner,
  RunnerCompletionError,
  RUNNER_BINARY_ENV,
  spawnClaude,
  type ResolvedBinary,
  type RunnerDeps
} from '../../src/main/runner'
import { openAppData, type AppData } from '../../src/main/storage'
import { createTelemetry, type Telemetry } from '../../src/main/telemetry'

const FAKE = fileURLToPath(new URL('../fixtures/fake-runner.mjs', import.meta.url))

interface RunnerRow {
  id: string
  task_id: string
  mode: string
  model: string | null
  pid: number | null
  started_at: string
  input_tokens: number | null
  output_tokens: number | null
  is_error: number | null
  exit_code: number | null
  error: string | null
}

let dir: string
let appData: AppData
let telemetry: Telemetry
let callBudget: CallBudget
let meter: SpendMeter
let settings: ModelSettings
let hasKey: boolean
let runSeq = 0
const victims: ChildProcess[] = []

/** A local model stand-in — never actually reached in these tests (cloud/runner win). */
const ollama: OllamaLike = { generate: async () => ({ text: 'local-reply', inputTokens: 1, outputTokens: 1 }) }

/** A cloud brain stand-in; a completion here DOES meter spend (proving $0 for the runner). */
const brain: CloudBrain = {
  provider: 'anthropic',
  model: 'claude-opus-4-8',
  complete: async (_messages, options) => ({
    text: 'cloud-reply',
    model: options?.model ?? 'claude-opus-4-8',
    usage: { inputTokens: 10, outputTokens: 5 },
    stopReason: 'end_turn'
  })
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'agentic-os-runner-'))
  appData = openAppData(join(dir, 'appdata.db'))
  telemetry = createTelemetry(appData.db)
  callBudget = new CallBudget({ db: appData.db })
  meter = new SpendMeter({ db: appData.db })
  settings = {
    ...defaultModelSettings(),
    reasoning: { backend: 'subscription-claude' },
    runner: { ...defaultRunnerSettings(), enabled: true }
  }
  hasKey = true
  runSeq = 0
  resetRunnerLanesForTests()
})

afterEach(async () => {
  for (const v of victims) killVictim(v)
  victims.length = 0
  await telemetry.shutdown()
  appData.close()
  rmSync(dir, { recursive: true, force: true })
})

// ── helpers ──────────────────────────────────────────────────────────────────

/** Build a Runner pointed at the fake, with the health probes stubbed (no real --version / npm). */
function makeRunner(overrides: Partial<RunnerDeps> = {}): Runner {
  return new Runner({
    db: appData.db,
    loadSettings: () => settings,
    telemetry,
    callBudget,
    env: { ...process.env, [RUNNER_BINARY_ENV]: FAKE },
    probeVersion: async () => '2.0.0',
    npmBinDir: async () => null,
    ...overrides
  })
}

/** The node-script invocation the runner resolves the fake to (for spawnClaude-direct tests). */
function fakeInvocation(): ResolvedBinary {
  const inv = resolveClaudeBinary({ env: { ...process.env, [RUNNER_BINARY_ENV]: FAKE } })
  if (inv === null) throw new Error('fake runner did not resolve')
  return inv
}

function rows(taskId?: string): RunnerRow[] {
  const sql = taskId === undefined ? 'SELECT * FROM runner_runs ORDER BY started_at' : 'SELECT * FROM runner_runs WHERE task_id = ? ORDER BY started_at'
  const stmt = appData.db.prepare(sql)
  return (taskId === undefined ? stmt.all() : stmt.all(taskId)) as RunnerRow[]
}

function countRuns(taskId?: string): number {
  return rows(taskId).length
}

/** Seed a FINISHED runner_runs row (ledger entry for CallBudget / windowUsage). */
function seedRun(taskId: string, tokens: { input?: number; output?: number } = {}): void {
  appData.db
    .prepare(
      `INSERT INTO runner_runs (id, task_id, mode, started_at, input_tokens, output_tokens, is_error, exit_code)
       VALUES (?, ?, 'completion', ?, ?, ?, 0, 0)`
    )
    .run(`seed-${runSeq++}`, taskId, new Date().toISOString(), tokens.input ?? null, tokens.output ?? null)
}

function killVictim(v: ChildProcess): void {
  try {
    if (process.platform !== 'win32' && typeof v.pid === 'number') process.kill(-v.pid, 'SIGKILL')
  } catch {
    /* group already gone */
  }
  try {
    v.kill('SIGKILL')
  } catch {
    /* already gone */
  }
}

async function waitUntilDead(pid: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    try {
      process.kill(pid, 0)
    } catch {
      return // ESRCH → dead
    }
    if (Date.now() > deadline) throw new Error(`pid ${pid} still alive after ${timeoutMs}ms`)
    await new Promise((resolve) => setTimeout(resolve, 40))
  }
}

// ── spawnClaude: watchdog + envelope recording ────────────────────────────────

describe('spawnClaude — watchdog + envelope recording (real fake over stdin)', () => {
  it('kills a hung fake at the timeout — the whole process TREE, leaving no orphan', async () => {
    const result = await spawnClaude(
      {
        db: appData.db,
        telemetry,
        mode: 'completion',
        model: 'sonnet',
        taskId: 'hang-task',
        // The fake spawns a grandchild sleeper so the PROCESS-TREE kill is observable.
        env: { ...process.env, AGENTIC_OS_FAKE_RUNNER_HANG_CHILD: '1' },
        runId: 'hang-1'
      },
      { invocation: fakeInvocation(), argv: ['-p'], stdin: 'FAKE_RUNNER_HANG', timeoutMs: 1500 }
    )

    expect(result.timedOut).toBe(true)
    expect(result.envelope).toBeNull()
    expect(activeRunnerChildCount()).toBe(0) // the live-child handle was deregistered

    // The row is finalized as a wall-clock-timeout error.
    const row = appData.db.prepare('SELECT * FROM runner_runs WHERE id = ?').get('hang-1') as RunnerRow
    expect(row.is_error).toBe(1)
    expect(row.error).toMatch(/timeout/i)

    // No orphan: the grandchild the fake announced on stderr is dead.
    const m = /hang-child-pid=(\d+)/.exec(result.stderr)
    expect(m).not.toBeNull()
    await waitUntilDead(Number(m![1]), 6000)
  }, 15_000)

  it('records an ISO-8601 UTC started_at that CallBudget.windowUsage reads back', async () => {
    const result = await spawnClaude(
      {
        db: appData.db,
        telemetry,
        mode: 'completion',
        model: 'sonnet',
        taskId: 'iso-task',
        env: { ...process.env, AGENTIC_OS_FAKE_RUNNER_INPUT_TOKENS: '1000', AGENTIC_OS_FAKE_RUNNER_OUTPUT_TOKENS: '500' },
        runId: 'iso-1'
      },
      { invocation: fakeInvocation(), argv: ['-p'], stdin: 'FAKE_RUNNER_ECHO:hi', timeoutMs: 15_000 }
    )
    expect(result.envelope?.result).toBe('hi')
    expect(result.record.isError).toBe(false)

    const row = appData.db.prepare('SELECT * FROM runner_runs WHERE id = ?').get('iso-1') as RunnerRow
    // ISO-8601 UTC with milliseconds + Z — the exact CallBudget.windowUsage contract.
    expect(row.started_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
    expect(new Date(row.started_at).toISOString()).toBe(row.started_at)
    expect(row.input_tokens).toBe(1000)
    expect(row.output_tokens).toBe(500)

    // The lexicographic time compare finds this row's tokens in the trailing window.
    expect(callBudget.windowUsage(Date.now())).toEqual({ inputTokens: 1000, outputTokens: 500 })
  }, 20_000)

  it('every envelope drift is a finalized error record — spawnClaude never throws', async () => {
    const invocation = fakeInvocation()
    const drifts = ['FAKE_RUNNER_DRIFT_NORESULT', 'FAKE_RUNNER_DRIFT_NOSESSION', 'FAKE_RUNNER_DRIFT_NONJSON', 'FAKE_RUNNER_DRIFT_EMPTY']
    for (const marker of drifts) {
      const result = await spawnClaude(
        { db: appData.db, telemetry, mode: 'completion', model: 'sonnet', taskId: `drift-${marker}`, runId: `spawn-${marker}` },
        { invocation, argv: ['-p'], stdin: marker, timeoutMs: 15_000 }
      )
      expect(result.envelope, marker).toBeNull()
      expect(result.parseError, marker).toBeTruthy()
      expect(result.record.isError, marker).toBe(true)
      const row = appData.db.prepare('SELECT is_error FROM runner_runs WHERE id = ?').get(`spawn-${marker}`) as { is_error: number }
      expect(row.is_error, marker).toBe(1)
    }
  }, 20_000)
})

// ── the completion fn (makeSubscriptionComplete / runner.complete) ────────────

describe('completion fn (runner.complete)', () => {
  it('returns the reply text on a normal run and notes health ok, recording ONE completion row', async () => {
    const runner = makeRunner()
    const res = await runner.complete({ prompt: 'FAKE_RUNNER_ECHO:hello', taskId: 'c1' })
    expect(res.text).toBe('hello')
    expect(runner.healthSnapshot().state).toBe('ok')

    const recorded = rows('c1')
    expect(recorded).toHaveLength(1)
    expect(recorded[0]!.mode).toBe('completion')
    expect(recorded[0]!.is_error).toBe(0)
  }, 15_000)

  it('maps auth / quota / generic failures to the right typed error and sticky health state', async () => {
    const cases: { marker: string; error: 'completion' | 'quota'; kind?: string; state: string }[] = [
      { marker: 'FAKE_RUNNER_AUTH', error: 'completion', kind: 'auth', state: 'auth-expired' },
      { marker: 'FAKE_RUNNER_QUOTA', error: 'quota', state: 'quota-exhausted' },
      { marker: 'FAKE_RUNNER_QUOTA_429', error: 'quota', state: 'quota-exhausted' },
      { marker: 'FAKE_RUNNER_ERROR', error: 'completion', kind: 'other', state: 'unknown' }
    ]
    let i = 0
    for (const c of cases) {
      const runner = makeRunner()
      const err = await runner.complete({ prompt: c.marker, taskId: `fail-${i++}` }).catch((e: unknown) => e)
      if (c.error === 'quota') {
        expect(err, c.marker).toBeInstanceOf(RunnerQuotaError)
      } else {
        expect(err, c.marker).toBeInstanceOf(RunnerCompletionError)
        expect((err as RunnerCompletionError).failure.kind, c.marker).toBe(c.kind)
      }
      expect(runner.healthSnapshot().state, c.marker).toBe(c.state)
    }
  }, 20_000)

  it('grades every envelope drift as a not-installed RunnerCompletionError + flips health to not-installed', async () => {
    const drifts = ['FAKE_RUNNER_DRIFT_NORESULT', 'FAKE_RUNNER_DRIFT_NOSESSION', 'FAKE_RUNNER_DRIFT_NONJSON', 'FAKE_RUNNER_DRIFT_EMPTY']
    let i = 0
    for (const marker of drifts) {
      const runner = makeRunner()
      const err = await runner.complete({ prompt: marker, taskId: `cdrift-${i++}` }).catch((e: unknown) => e)
      expect(err, marker).toBeInstanceOf(RunnerCompletionError)
      expect((err as RunnerCompletionError).failure.kind, marker).toBe('not-installed')
      expect(runner.healthSnapshot().state, marker).toBe('not-installed')
    }
  }, 20_000)

  it('CallBudget trips at RUNNER_TASK_MAX_CALLS BEFORE spawning (the $0.50-ceiling replacement)', async () => {
    for (let n = 0; n < RUNNER_TASK_MAX_CALLS; n++) seedRun('budget-task')
    const runner = makeRunner()
    const before = countRuns()
    const err = await runner.complete({ prompt: 'FAKE_RUNNER_ECHO:x', taskId: 'budget-task' }).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(CallBudgetExceededError)
    expect(err).toBeInstanceOf(SpendCeilingExceededError) // the load-bearing halt seam
    expect(countRuns()).toBe(before) // no spawn — no new row
  }, 15_000)

  it('the quota self-throttle refuses at RUNNER_WINDOW_TOKEN_BUDGET × RUNNER_QUOTA_FRACTION, before spawning', async () => {
    const ceiling = RUNNER_WINDOW_TOKEN_BUDGET * RUNNER_QUOTA_FRACTION
    expect(ceiling).toBe(150_000)
    // Seed the window to EXACTLY the ceiling under a DIFFERENT task (so this task's call budget is clean).
    seedRun('someone-else', { input: ceiling, output: 0 })
    const runner = makeRunner()
    const before = countRuns('q-task')
    const err = await runner.complete({ prompt: 'FAKE_RUNNER_ECHO:x', taskId: 'q-task' }).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(RunnerQuotaError)
    expect(countRuns('q-task')).toBe(before) // refused before any spawn
  }, 15_000)

  it('proceeds when the window is JUST under the fraction (the >= boundary)', async () => {
    seedRun('someone-else', { input: RUNNER_WINDOW_TOKEN_BUDGET * RUNNER_QUOTA_FRACTION - 1, output: 0 })
    const runner = makeRunner()
    const res = await runner.complete({ prompt: 'FAKE_RUNNER_ECHO:ok', taskId: 'q-ok' })
    expect(res.text).toBe('ok') // under the ceiling → the spawn happened
    expect(countRuns('q-ok')).toBe(1)
  }, 15_000)
})

// ── router wiring (the phase-16 ProviderRouter injections) ────────────────────

describe('router wiring (subscriptionComplete + runnerHealthy injected)', () => {
  function makeRouter(runner: Runner): ProviderRouter {
    return new ProviderRouter({
      loadSnapshot: () => settings,
      ollama,
      makeCloud: () => (hasKey ? { brain, meter } : null),
      subscriptionComplete: runner.complete,
      runnerHealthy: () => runner.isHealthy(),
      callBudget
    })
  }

  it('a subscribable role (enabled + healthy) routes to the runner: $0, no spend row, one runner_runs row', async () => {
    const runner = makeRunner()
    await runner.refreshHealth()
    expect(runner.isHealthy()).toBe(true)

    const router = makeRouter(runner)
    expect(router.resolve('skills.rewrite').backend).toBe('subscription-claude')

    const res = await router.complete('skills.rewrite', { prompt: 'FAKE_RUNNER_ECHO:routed', taskId: 'router-1' })
    expect(res.text).toBe('routed')
    expect(res.reportedCostUsd).toBe(0) // a subscription is flat-fee — never fabricate dollars

    const recorded = rows('router-1')
    expect(recorded).toHaveLength(1)
    expect(recorded[0]!.mode).toBe('completion')
    expect(recorded[0]!.model).toBe('sonnet') // the runner model, threaded through the router
    expect(recorded[0]!.is_error).toBe(0)
    expect(meter.totalSpendUsd()).toBe(0) // ZERO spend rows
  }, 15_000)

  it('a DISABLED runner falls back to cloud (DEFAULT == TODAY) and records no runner_runs row', async () => {
    const runner = makeRunner()
    await runner.refreshHealth()
    settings.runner!.enabled = false // the master switch off
    const router = makeRouter(runner)

    expect(router.resolve('skills.rewrite').backend).toBe('cloud-api')
    const res = await router.complete('skills.rewrite', { prompt: 'anything', taskId: 'router-2' })
    expect(res.text).toBe('cloud-reply')
    expect(countRuns('router-2')).toBe(0) // the runner never spawned
  }, 15_000)

  it('an UNHEALTHY runner (version probe fails) falls back to cloud, records no runner_runs row', async () => {
    const runner = makeRunner({ probeVersion: async () => null }) // --version won't run → versionOk false
    await runner.refreshHealth()
    expect(runner.isHealthy()).toBe(false)

    const router = makeRouter(runner)
    expect(router.resolve('skills.rewrite').backend).toBe('cloud-api')
    const res = await router.complete('skills.rewrite', { prompt: 'anything', taskId: 'router-3' })
    expect(res.text).toBe('cloud-reply')
    expect(countRuns('router-3')).toBe(0)
  }, 15_000)
})

// ── boot zombie defense (§10.1) ───────────────────────────────────────────────

describe('sweepZombies (boot zombie defense)', () => {
  it('kills an unfinished row whose live pid matches the runner image, finalizes stale rows, leaves finished rows', async () => {
    // A real, long-lived stand-in for a stranded `claude` child: same execPath as
    // the resolved runner (node-script command === process.execPath), so its image
    // matches; detached so it leads a killable process group on POSIX (as the real
    // runner spawns its children). ELECTRON_RUN_AS_NODE keeps it a Node loop under
    // the Electron runtime too.
    const victim = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1 << 30)'], {
      detached: process.platform !== 'win32',
      stdio: 'ignore',
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }
    })
    victims.push(victim)
    const victimPid = victim.pid
    if (typeof victimPid !== 'number') throw new Error('victim did not spawn')

    const now = new Date().toISOString()
    // (a) unfinished, live matching pid → must be killed + finalized.
    appData.db
      .prepare(`INSERT INTO runner_runs (id, task_id, mode, pid, started_at) VALUES ('z-live', 't', 'completion', ?, ?)`)
      .run(victimPid, now)
    // (b) unfinished, DEAD/bogus pid → NEVER killed by pid alone (pids recycle), but still finalized.
    appData.db
      .prepare(`INSERT INTO runner_runs (id, task_id, mode, pid, started_at) VALUES ('z-dead', 't', 'completion', 2147483646, ?)`)
      .run(now)
    // (c) already finished → untouched (even though it shares the live pid).
    appData.db
      .prepare(
        `INSERT INTO runner_runs (id, task_id, mode, pid, started_at, is_error, exit_code, error)
         VALUES ('done', 't', 'completion', ?, ?, 0, 0, 'ok')`
      )
      .run(victimPid, now)

    const runner = makeRunner()
    const killed = await runner.sweepZombies()
    expect(killed).toBe(1) // exactly the one live, matching zombie

    await waitUntilDead(victimPid, 6000) // the tree kill landed

    const byId = new Map(rows().map((r) => [r.id, r]))
    // Both unfinished rows are finalized so the next boot never re-sweeps them.
    expect(byId.get('z-live')!.is_error).toBe(1)
    expect(byId.get('z-live')!.exit_code).toBe(-1)
    expect(byId.get('z-dead')!.is_error).toBe(1)
    expect(byId.get('z-dead')!.exit_code).toBe(-1)
    // The finished row is byte-for-byte untouched.
    expect(byId.get('done')!.is_error).toBe(0)
    expect(byId.get('done')!.error).toBe('ok')
  }, 15_000)
})
