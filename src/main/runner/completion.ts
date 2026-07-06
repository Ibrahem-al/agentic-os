/**
 * Completion mode (phase 17; §2.1/§3.4/P0.2/P0.8) — the `subscriptionComplete`
 * fn the phase-16 `ProviderRouter` injects for the `subscription-claude` backend.
 *
 * One headless `claude -p --output-format json --max-turns 1 --model <model>`
 * per reasoning call, tools stripped (`--disallowedTools …`, NO `--mcp-config`),
 * the system+user prompt on stdin, RESULT text out. NO MCP connection — that is
 * agent mode (phase-19). Before every spawn, two gates fire (the $0.50-ceiling
 * replacement, §2.4):
 *   1. `CallBudget.checkBudget(taskId)` — the durable per-task runner-call
 *      ceiling (throws `CallBudgetExceededError`, an `instanceof
 *      SpendCeilingExceededError`);
 *   2. the quota SELF-throttle — trailing-window token usage vs
 *      `RUNNER_WINDOW_TOKEN_BUDGET × RUNNER_QUOTA_FRACTION` → `RunnerQuotaError`,
 *      so the app backs off BEFORE Anthropic does, leaving headroom for the
 *      human's own interactive Claude Code (the quota is shared, §9.1).
 *
 * A run that fails is classified (auth/quota/not-installed) into the health cache
 * and re-thrown: the router re-routes the NEXT call to cloud/local (call-time
 * fallback, §10.11). This module never falls back mid-call.
 */
import { randomUUID } from 'node:crypto'
import type BetterSqlite3 from 'better-sqlite3'
import {
  RUNNER_COMPLETION_TIMEOUT_MS,
  RUNNER_MODEL_DEFAULT,
  RUNNER_QUOTA_FRACTION,
  RUNNER_WINDOW_TOKEN_BUDGET
} from '../config'
import { RunnerQuotaError, type CallBudget } from '../models/callBudget'
import type { SubscriptionComplete } from '../models/provider'
import type { ModelSettings } from '../models/settings'
import type { Telemetry } from '../telemetry'
import { resolveClaudeBinary } from './binary'
import { classifyRunnerFailure, type RunnerHealth } from './health'
import { laneForTask, runnerLiveLane, type RunnerLane } from './lanes'
import { spawnClaude, type SpawnClaudeResult, type SpawnImpl } from './spawn'
import type { ResolvedBinary, RunnerFailure, RunnerHealthState } from './types'

/** Tools stripped from every completion (no filesystem/shell/web/subagents). */
export const RUNNER_DISALLOWED_TOOLS = 'Bash,Edit,Write,NotebookEdit,WebFetch,WebSearch,Task'

/** A completion spawn that ran but did not yield a usable reply (post-spawn). */
export class RunnerCompletionError extends Error {
  constructor(
    readonly failure: RunnerFailure,
    readonly stderrTail?: string
  ) {
    super(`runner completion failed (${failure.kind}): ${failure.detail}`)
    this.name = 'RunnerCompletionError'
  }
}

export interface CompletionDeps {
  readonly db: BetterSqlite3.Database
  readonly loadSettings: () => ModelSettings
  readonly telemetry: Telemetry
  readonly callBudget: CallBudget
  readonly health: RunnerHealth
  readonly now?: () => number
  readonly platform?: NodeJS.Platform
  readonly env?: NodeJS.ProcessEnv
  readonly spawnImpl?: SpawnImpl
  /** Test seam: pick the spawn lane for a taskId (default `laneForTask`). */
  readonly laneFor?: (taskId: string) => RunnerLane
}

/** The completion-mode argv (everything after the resolved invocation). */
function completionArgv(model: string): string[] {
  return ['-p', '--output-format', 'json', '--max-turns', '1', '--model', model, '--disallowedTools', RUNNER_DISALLOWED_TOOLS]
}

/** Fold system + user into one stdin document (§3.4: both ride stdin). */
function stdinFor(prompt: string, system: string | undefined): string {
  return system !== undefined && system !== '' ? `${system}\n\n${prompt}` : prompt
}

function resolveModel(deps: CompletionDeps, requested: string | undefined): string {
  return requested ?? deps.loadSettings().runner?.model ?? RUNNER_MODEL_DEFAULT
}

/** The binary to spawn: the health cache's resolved one, else a fresh sync resolve. */
function invocationFor(deps: CompletionDeps): ResolvedBinary | null {
  const cached = deps.health.resolvedBinary()
  if (cached !== null) return cached
  const runnerSettings = deps.loadSettings().runner
  return resolveClaudeBinary({
    ...(runnerSettings?.binaryPath !== undefined ? { settingsBinaryPath: runnerSettings.binaryPath } : {}),
    ...(deps.env !== undefined ? { env: deps.env } : {}),
    ...(deps.platform !== undefined ? { platform: deps.platform } : {})
  })
}

/** Run one completion spawn on `lane`, recording its `runner_runs` row. */
function runSpawn(
  deps: CompletionDeps,
  args: { invocation: ResolvedBinary; model: string; taskId: string; stdin: string; lane: RunnerLane }
): Promise<SpawnClaudeResult> {
  const now = deps.now ?? (() => Date.now())
  return args.lane.run(() =>
    spawnClaude(
      {
        db: deps.db,
        telemetry: deps.telemetry,
        mode: 'completion',
        model: args.model,
        taskId: args.taskId,
        now,
        ...(deps.platform !== undefined ? { platform: deps.platform } : {}),
        ...(deps.env !== undefined ? { env: deps.env } : {}),
        ...(deps.spawnImpl !== undefined ? { spawnImpl: deps.spawnImpl } : {})
      },
      { invocation: args.invocation, argv: completionArgv(args.model), stdin: args.stdin, timeoutMs: RUNNER_COMPLETION_TIMEOUT_MS }
    )
  )
}

/**
 * Build the `subscriptionComplete` fn injected into the ProviderRouter. The
 * router folds any `schema` hint into `prompt` first, so this receives a
 * schema-free request; it uses `prompt`/`system`/`model`/`taskId`.
 */
export function makeSubscriptionComplete(deps: CompletionDeps): SubscriptionComplete {
  const now = deps.now ?? (() => Date.now())
  return async (req) => {
    // 1. Durable per-task call ceiling (throws CallBudgetExceededError).
    deps.callBudget.checkBudget(req.taskId)

    // 2. Quota self-throttle — back off before the shared window is exhausted.
    const usage = deps.callBudget.windowUsage(now())
    const windowTokens = usage.inputTokens + usage.outputTokens
    const ceiling = RUNNER_WINDOW_TOKEN_BUDGET * RUNNER_QUOTA_FRACTION
    if (windowTokens >= ceiling) {
      throw new RunnerQuotaError(
        `runner self-throttled: ${windowTokens} tokens used in the trailing window ≥ ${ceiling} ` +
          `(RUNNER_WINDOW_TOKEN_BUDGET × RUNNER_QUOTA_FRACTION) — leaving headroom for your own Claude Code`
      )
    }

    // 3. Resolve the binary (the router only routes here when healthy, so this
    //    is normally the health cache's already-resolved invocation).
    const invocation = invocationFor(deps)
    if (invocation === null) {
      const failure: RunnerFailure = { kind: 'not-installed', detail: 'no claude binary resolved for the runner' }
      deps.health.noteFailure(failure)
      throw new RunnerCompletionError(failure)
    }

    // 4. Spawn on the taskId's lane.
    const model = resolveModel(deps, req.model)
    const lane = (deps.laneFor ?? laneForTask)(req.taskId)
    const result = await runSpawn(deps, {
      invocation,
      model,
      taskId: req.taskId,
      stdin: stdinFor(req.prompt, req.system),
      lane
    })

    // 5. Interpret the envelope.
    const env = result.envelope
    if (env !== null && !env.isError) {
      deps.health.noteSuccess()
      const usageOut =
        env.inputTokens !== null && env.outputTokens !== null
          ? { inputTokens: env.inputTokens, outputTokens: env.outputTokens }
          : undefined
      return { text: env.result, ...(usageOut !== undefined ? { usage: usageOut } : {}) }
    }

    const failure = classifyRunnerFailure(env, result.stderr, now())
    deps.health.noteFailure(failure)
    // A quota discovered mid-run surfaces as the spec's named RunnerQuotaError
    // (the later queue stage maps it to a reset-aware deferral); everything else
    // as a RunnerCompletionError carrying the classification.
    if (failure.kind === 'quota') {
      throw new RunnerQuotaError(`runner hit a subscription limit: ${failure.detail}`)
    }
    throw new RunnerCompletionError(failure, result.stderr.slice(-2048))
  }
}

// ── manual test-connection canary (§3.7 — NEVER scheduled) ───────────────────

export interface TestConnectionResult {
  readonly ok: boolean
  readonly state: RunnerHealthState
  readonly version: string | null
  readonly binaryPath: string | null
  /** The canary reply (truncated) on success. */
  readonly sample?: string
  readonly error?: string
}

/**
 * A one-turn canary the user triggers from the settings panel — the closest
 * thing to an auth probe (§9.7). Refreshes health (resolve + version) first,
 * then runs a trivial completion on the LIVE lane. Updates the health cache from
 * the outcome. Never scheduled automatically.
 */
export async function runTestConnection(deps: CompletionDeps): Promise<TestConnectionResult> {
  const now = deps.now ?? (() => Date.now())
  await deps.health.refresh()
  const invocation = deps.health.resolvedBinary()
  if (invocation === null) {
    const snap = deps.health.snapshot()
    return {
      ok: false,
      state: snap.state,
      version: snap.version,
      binaryPath: null,
      error: snap.lastError ?? 'claude binary not found'
    }
  }
  const model = resolveModel(deps, undefined)
  const result = await runSpawn(deps, {
    invocation,
    model,
    taskId: `canary:${randomUUID()}`,
    stdin: 'Reply with the single word: OK',
    lane: (deps.laneFor ?? (() => runnerLiveLane))('live:canary')
  })
  const env = result.envelope
  if (env !== null && !env.isError) {
    deps.health.noteSuccess()
    const snap = deps.health.snapshot()
    return { ok: true, state: snap.state, version: snap.version, binaryPath: invocation.path, sample: env.result.slice(0, 200) }
  }
  const failure = classifyRunnerFailure(env, result.stderr, now())
  deps.health.noteFailure(failure)
  const snap = deps.health.snapshot()
  return { ok: false, state: snap.state, version: snap.version, binaryPath: invocation.path, error: failure.detail }
}
