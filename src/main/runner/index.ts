/**
 * Runner module barrel + the `Runner` facade (phase 17).
 *
 * `Runner` wires binary resolution + the health cache + the two spawn lanes +
 * the spawn primitive + completion mode over `{ db, loadSettings, telemetry,
 * callBudget }`. Boot (a later stage) builds ONE `Runner` and injects
 * `complete`/`isHealthy` into the phase-16 `ProviderRouter` (both left unset
 * there), calls `sweepZombies()` on startup, and `killChildren()` in `will-quit`
 * BEFORE the queue/MCP teardown.
 *
 * SHIPS OFF: with `runner.enabled=false` (the default) `isHealthy()` returns
 * false, the router never routes to the subscription, and nothing here spawns
 * `claude` — a default install is byte-for-byte today.
 */
import { spawn as nodeSpawn } from 'node:child_process'
import { basename } from 'node:path'
import type BetterSqlite3 from 'better-sqlite3'
import { RUNNER_MODEL_DEFAULT } from '../config'
import type { CallBudget } from '../models/callBudget'
import type { SubscriptionComplete } from '../models/provider'
import type { ModelSettings } from '../models/settings'
import type { Telemetry } from '../telemetry'
import { runAgentMode as runAgentModeChild, type RunAgentModeResult } from './agent'
import { resolveClaudeBinary, type BinaryResolveDeps } from './binary'
import {
  makeSubscriptionComplete,
  runTestConnection,
  type CompletionDeps,
  type TestConnectionResult
} from './completion'
import { RunnerHealth } from './health'
import { type RunnerLane } from './lanes'
import { killAllRunnerChildren, killProcessTree, killRunnerChildrenForTask, type SpawnImpl } from './spawn'
import type { ResolvedBinary, RunnerHealthSnapshot } from './types'

// ── barrel re-exports (consumers import from `../runner`) ─────────────────────

export type {
  BinaryStrategy,
  ResolvedBinary,
  RunnerEnvelope,
  RunnerFailure,
  RunnerFailureKind,
  RunnerHealthSnapshot,
  RunnerHealthState,
  RunnerMode,
  RunnerRunRecord
} from './types'
export {
  meetsMinVersion,
  npmGlobalBinDir,
  parseSemver,
  probeClaudeVersion,
  resolveClaudeBinary,
  RUNNER_BINARY_ENV,
  type BinaryResolveDeps
} from './binary'
export { classifyRunnerFailure, parseResetTime, RunnerHealth, type RunnerHealthDeps } from './health'
export {
  laneForTask,
  resetRunnerLanesForTests,
  RunnerLane,
  runnerBackgroundLane,
  runnerLiveLane
} from './lanes'
export {
  activeRunnerChildCount,
  killAllRunnerChildren,
  killProcessTree,
  killRunnerChildrenForTask,
  parseRunnerEnvelope,
  spawnClaude,
  type SpawnClaudeContext,
  type SpawnClaudeOptions,
  type SpawnClaudeResult,
  type SpawnImpl
} from './spawn'
export {
  makeSubscriptionComplete,
  runTestConnection,
  RunnerCompletionError,
  RUNNER_DISALLOWED_TOOLS,
  type CompletionDeps,
  type TestConnectionResult
} from './completion'
export {
  buildAgentArgv,
  runAgentMode,
  RUNNER_AGENT_ALLOWED_TOOLS,
  RUNNER_AGENT_SCOPE_GUARD,
  RUNNER_AGENT_SETTINGS,
  type RunAgentModeOptions,
  type RunAgentModeResult
} from './agent'
export {
  deleteRunnerMcpConfig,
  runnerConfigDir,
  runnerMcpConfigObject,
  runnerMcpConfigPath,
  writeRunnerMcpConfig,
  RUNNER_TOKEN_ENV_REF,
  type RunnerMcpConfig
} from './mcpConfig'

// ── the facade ────────────────────────────────────────────────────────────────

export interface RunnerDeps {
  readonly db: BetterSqlite3.Database
  readonly loadSettings: () => ModelSettings
  readonly telemetry: Telemetry
  readonly callBudget: CallBudget
  readonly now?: () => number
  readonly platform?: NodeJS.Platform
  readonly env?: NodeJS.ProcessEnv
  readonly homeDir?: string
  readonly execPath?: string
  /** `<userData>` — agent mode writes each spawn's `.mcp.json` under `<userData>/runner/`. */
  readonly userDataDir?: string
  readonly spawnImpl?: SpawnImpl
  readonly ttlMs?: number
  readonly minVersion?: string
  /** Health seams (default the real binary-module fns). */
  readonly resolveBinary?: (deps: BinaryResolveDeps) => ResolvedBinary | null
  readonly probeVersion?: (invocation: ResolvedBinary) => Promise<string | null>
  readonly npmBinDir?: () => Promise<string | null>
  /** Test seam: choose the spawn lane for a taskId. */
  readonly laneFor?: (taskId: string) => RunnerLane
}

export class Runner {
  readonly health: RunnerHealth
  /** The `subscriptionComplete` injected into the ProviderRouter. */
  readonly complete: SubscriptionComplete

  private readonly deps: RunnerDeps
  private readonly platform: NodeJS.Platform
  private readonly completionDeps: CompletionDeps
  private readonly finalizeSweptStmt: BetterSqlite3.Statement
  private readonly selectUnfinishedStmt: BetterSqlite3.Statement

  constructor(deps: RunnerDeps) {
    this.deps = deps
    this.platform = deps.platform ?? process.platform
    this.health = new RunnerHealth({
      loadSettings: deps.loadSettings,
      ...(deps.now !== undefined ? { now: deps.now } : {}),
      ...(deps.ttlMs !== undefined ? { ttlMs: deps.ttlMs } : {}),
      ...(deps.minVersion !== undefined ? { minVersion: deps.minVersion } : {}),
      ...(deps.env !== undefined ? { env: deps.env } : {}),
      ...(deps.platform !== undefined ? { platform: deps.platform } : {}),
      ...(deps.homeDir !== undefined ? { homeDir: deps.homeDir } : {}),
      ...(deps.execPath !== undefined ? { execPath: deps.execPath } : {}),
      ...(deps.resolveBinary !== undefined ? { resolveBinary: deps.resolveBinary } : {}),
      ...(deps.probeVersion !== undefined ? { probeVersion: deps.probeVersion } : {}),
      ...(deps.npmBinDir !== undefined ? { npmBinDir: deps.npmBinDir } : {})
    })
    this.completionDeps = {
      db: deps.db,
      loadSettings: deps.loadSettings,
      telemetry: deps.telemetry,
      callBudget: deps.callBudget,
      health: this.health,
      ...(deps.now !== undefined ? { now: deps.now } : {}),
      ...(deps.platform !== undefined ? { platform: deps.platform } : {}),
      ...(deps.env !== undefined ? { env: deps.env } : {}),
      ...(deps.spawnImpl !== undefined ? { spawnImpl: deps.spawnImpl } : {}),
      ...(deps.laneFor !== undefined ? { laneFor: deps.laneFor } : {})
    }
    this.complete = makeSubscriptionComplete(this.completionDeps)
    this.selectUnfinishedStmt = deps.db.prepare(
      `SELECT id, pid FROM runner_runs WHERE is_error IS NULL AND exit_code IS NULL AND pid IS NOT NULL`
    )
    this.finalizeSweptStmt = deps.db.prepare(
      `UPDATE runner_runs SET is_error = 1, exit_code = -1, error = @error, duration_ms = COALESCE(duration_ms, 0) WHERE id = @id`
    )
  }

  /** The router's `runnerHealthy()` — synchronous, safe as a per-route call. */
  isHealthy(): boolean {
    return this.health.isHealthy()
  }

  /** The resolved invocation (cached from health, else a fresh sync fs resolve). */
  resolveBinary(): ResolvedBinary | null {
    const cached = this.health.resolvedBinary()
    if (cached !== null) return cached
    const runnerSettings = this.deps.loadSettings().runner
    return resolveClaudeBinary({
      ...(runnerSettings?.binaryPath !== undefined ? { settingsBinaryPath: runnerSettings.binaryPath } : {}),
      ...(this.deps.env !== undefined ? { env: this.deps.env } : {}),
      ...(this.deps.platform !== undefined ? { platform: this.deps.platform } : {}),
      ...(this.deps.homeDir !== undefined ? { homeDir: this.deps.homeDir } : {}),
      ...(this.deps.execPath !== undefined ? { execPath: this.deps.execPath } : {})
    })
  }

  /** The health snapshot for `get_runner_status` + the dashboard banner. */
  healthSnapshot(): RunnerHealthSnapshot {
    return this.health.snapshot()
  }

  /** Force a health probe (resolve + `claude --version`). */
  refreshHealth(): Promise<RunnerHealthSnapshot> {
    return this.health.refresh()
  }

  /** The manual 1-turn canary (§3.7 — user-triggered, NEVER scheduled). */
  testConnection(): Promise<TestConnectionResult> {
    return runTestConnection(this.completionDeps)
  }

  /**
   * Agent mode (phase 19; §3.2/§8 Phase 5) — spawn a headless `claude -p` that
   * connects back to the loopback MCP with the runner token, reads its inputs
   * via READ tools, and stages its outputs via `submit_extraction_items`. Writes
   * the per-task `.mcp.json` (real token ONLY in the child env, §10.5/P0.3),
   * spawns on the background lane, and deletes the config afterwards; the caller
   * (the delegate, 18) then loads `runner_submissions` bound to `task.taskId`.
   *
   * Runs ONLY when the handler has already checked `enabled ∧ healthy ∧
   * mode==='agent'`; a stale health cache leaving the binary unresolved, or a
   * missing `userDataDir`, throws (the queue fails the extraction task and
   * retries) rather than spawning blind.
   */
  async runAgentMode(task: {
    readonly taskId: string
    readonly brief: string
    readonly runnerToken: string
    readonly sessionId?: string
    readonly model?: string
    readonly mcpUrl?: string
  }): Promise<RunAgentModeResult> {
    const invocation = this.resolveBinary()
    if (invocation === null) {
      throw new Error('runner agent mode: no claude binary resolved (health should have gated this call)')
    }
    const userDataDir = this.deps.userDataDir
    if (userDataDir === undefined || userDataDir === '') {
      throw new Error('runner agent mode: userDataDir is not configured — cannot write the per-task .mcp.json')
    }
    const model = task.model ?? this.deps.loadSettings().runner?.model ?? RUNNER_MODEL_DEFAULT
    return runAgentModeChild({
      taskId: task.taskId,
      brief: task.brief,
      runnerToken: task.runnerToken,
      userDataDir,
      invocation,
      db: this.deps.db,
      telemetry: this.deps.telemetry,
      model,
      ...(task.sessionId !== undefined ? { sessionId: task.sessionId } : {}),
      ...(task.mcpUrl !== undefined ? { mcpUrl: task.mcpUrl } : {}),
      ...(this.deps.now !== undefined ? { now: this.deps.now } : {}),
      ...(this.deps.platform !== undefined ? { platform: this.deps.platform } : {}),
      ...(this.deps.env !== undefined ? { env: this.deps.env } : {}),
      ...(this.deps.spawnImpl !== undefined ? { spawnImpl: this.deps.spawnImpl } : {}),
      ...(this.deps.laneFor !== undefined ? { laneFor: this.deps.laneFor } : {})
    })
  }

  /** Kill every in-flight runner child of THIS process (will-quit). */
  killChildren(): void {
    killAllRunnerChildren()
  }

  /**
   * Kill the in-flight runner children of a cancelled task (§8 cancel) — its own id
   * or its `<taskId>-wf` workflow job. Pid-reuse-safe (live registry handles, never
   * a DB pid). Returns how many child trees were killed. The queue injects this as
   * its `killChildrenForTask` cancel hook.
   */
  killTaskChildren(taskId: string): number {
    return killRunnerChildrenForTask(taskId)
  }

  /**
   * Boot zombie defense (§10.1). Every `runner_runs` row still marked unfinished
   * (`is_error`/`exit_code` both null) at boot is from a PREVIOUS process
   * generation — this process has spawned nothing yet. For each such row whose
   * recorded pid STILL resolves to a process whose image matches the resolved
   * runner binary (NEVER kill by pid alone — pids recycle), kill the tree; then
   * finalize every stale row so it is neither re-swept nor left dangling.
   * Returns the number of live zombies actually killed.
   */
  async sweepZombies(): Promise<number> {
    const rows = this.selectUnfinishedStmt.all() as { id: string; pid: number | null }[]
    if (rows.length === 0) return 0
    const resolved = this.resolveBinary()
    let killed = 0
    for (const row of rows) {
      if (row.pid !== null && resolved !== null) {
        const image = await processImageName(row.pid, this.platform, this.deps.env)
        if (image !== null && imageMatches(image, resolved)) {
          killProcessTree(row.pid, this.platform)
          killed++
        }
      }
      this.finalizeSweptStmt.run({ id: row.id, error: 'killed on boot (zombie / stale row from a previous process)' })
    }
    return killed
  }
}

// ── process-image probe (zombie verification) ─────────────────────────────────

/** Spawn `command args`, capture trimmed stdout, or null on any failure/timeout. */
function runCapture(command: string, args: readonly string[], env: NodeJS.ProcessEnv | undefined): Promise<string | null> {
  return new Promise((resolve) => {
    let child
    try {
      child = nodeSpawn(command, [...args], {
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'ignore'],
        ...(env !== undefined ? { env } : {})
      })
    } catch {
      resolve(null)
      return
    }
    let stdout = ''
    let settled = false
    const settle = (value: string | null): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(value)
    }
    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL')
      } catch {
        /* gone */
      }
      settle(null)
    }, 5000)
    child.stdout?.setEncoding('utf8')
    child.stdout?.on('data', (chunk: string) => (stdout += chunk))
    child.on('error', () => settle(null))
    child.on('close', (code) => settle(code === 0 ? stdout : null))
  })
}

/**
 * The image/command line of a pid, or null when it does not resolve. POSIX
 * probes `args=` (argv), NOT `comm=`: comm is the kernel THREAD name, and
 * Node ≥24 names its main thread "MainThread" (prctl PR_SET_NAME), so on Linux
 * every node-based zombie — including the real `claude` CLI and the node-script
 * seam — reported comm "MainThread" and was never matched (found on CI, where
 * node 24 made sweepZombies kill nothing). argv's first token is the spawned
 * executable, and a `process.title` rewrite still leaves the title in the line.
 */
async function processImageName(pid: number, platform: NodeJS.Platform, env: NodeJS.ProcessEnv | undefined): Promise<string | null> {
  if (platform === 'win32') {
    const out = await runCapture('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], env)
    if (out === null) return null
    // A found task prints `"image.exe","pid",...`; "no tasks" prints an INFO line.
    const m = /^"([^"]+)"/.exec(out.trim())
    return m !== null ? (m[1] ?? null) : null
  }
  // -ww: never truncate the command line (BSD ps clips at window width).
  const out = await runCapture('ps', ['-ww', '-p', String(pid), '-o', 'args='], env)
  if (out === null) return null
  const line = out.trim().split(/\r?\n/, 1)[0]?.trim()
  return line !== undefined && line !== '' ? line : null
}

/** Does a process image plausibly belong to OUR resolved runner invocation? */
function imageMatches(image: string, resolved: ResolvedBinary): boolean {
  const stripExt = (s: string): string => s.toLowerCase().replace(/\.(exe|cmd|bat)$/, '')
  // POSIX images are full command lines; the executable is the first token.
  // (Windows tasklist images are bare names — the split is a no-op there.)
  const img = stripExt(basename(image.split(/\s+/, 1)[0] ?? image))
  return (
    img === stripExt(basename(resolved.command)) ||
    img === stripExt(basename(resolved.path)) ||
    image.toLowerCase().includes('claude')
  )
}
