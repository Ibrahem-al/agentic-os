/**
 * Shared runner vocabulary (phase 17, feature spec `website/MCP-COVERAGE.md`
 * §3 + §9–§11 P0s). The headless-runner module spawns one `claude -p` per
 * reasoning call (completion mode) as the `subscription-claude` backend behind
 * the phase-16 ProviderRouter. Agent mode (loopback MCP connect-back) is
 * phase-19 — the `RunnerMode` union names it, but this module only ever runs
 * `'completion'`.
 *
 * PRIME DIRECTIVE — SHIPS OFF. With `runner.enabled=false` (the default) nothing
 * here ever spawns `claude`; every completion the router asks for falls back to
 * cloud-api / local-qwen3 exactly as today. This file holds only types, so it is
 * side-effect-free and safe to import from anywhere.
 */

/**
 * The two run shapes (§3.2). This phase implements ONLY `'completion'`
 * (`claude -p --max-turns 1`, tools stripped, no MCP); `'agent'` (a whole task
 * delegated to a loopback-MCP session) lands in phase-19. The value is stamped
 * on every `runner_runs` row and the `runner.spawn` telemetry span.
 */
export type RunnerMode = 'completion' | 'agent'

/**
 * The last known runner state (§9.7). `isHealthy()` treats `ok`/`unknown` as
 * usable (a never-probed binary is `unknown`, not a hard failure — the real run
 * IS the probe, §9.7). The other three are sticky failure states surfaced by
 * `get_runner_status` + the dashboard banner, cleared by the next success.
 */
export type RunnerHealthState = 'ok' | 'not-installed' | 'auth-expired' | 'quota-exhausted' | 'unknown'

/** How the binary was resolved (§10.12) — recorded for `get_runner_status`. */
export type BinaryStrategy =
  | 'env' // AGENTIC_OS_RUNNER_BINARY test seam (wins over all probing)
  | 'settings' // settings.runner.binaryPath
  | 'node-script' // a `.mjs`/`.js` target → process.execPath + [script, ...argv]
  | 'cmd-shim' // win32 npm `claude.cmd` → cmd.exe /d /s /c <cmd> (NEVER shell:true)
  | 'well-known' // ~/.local/bin, /usr/local/bin, /opt/homebrew/bin, npm prefix
  | 'path' // bare `claude` (or claude.exe) found on PATH

/**
 * A resolved runner invocation. `command` + `prefixArgs` are what actually get
 * argv-array-spawned (NEVER a shell); the claude args are appended after
 * `prefixArgs`. `path` is the human-facing absolute location surfaced in
 * `get_runner_status`. For a normal native binary `command === path` and
 * `prefixArgs` is empty; for the `.mjs` test seam `command` is `process.execPath`
 * and `prefixArgs` is `[scriptPath]`; for a win32 `.cmd` shim `command` is
 * `cmd.exe` and `prefixArgs` is `['/d','/s','/c', cmdPath]`.
 */
export interface ResolvedBinary {
  readonly path: string
  readonly command: string
  readonly prefixArgs: readonly string[]
  readonly strategy: BinaryStrategy
}

/**
 * The `--output-format json` envelope, NORMALIZED + defensively parsed
 * (§6.7/§10.12). Only `session_id`, `is_error`, and `result` are required — a
 * missing one is a `not-installed`-grade failure (envelope drift from a CLI
 * upgrade), never a crash. Unknown wire fields are ignored; `usage`/`num_turns`/
 * `duration_ms`/`total_cost_usd` are best-effort.
 */
export interface RunnerEnvelope {
  readonly sessionId: string
  readonly isError: boolean
  readonly result: string
  readonly numTurns: number | null
  readonly durationMs: number | null
  readonly inputTokens: number | null
  readonly outputTokens: number | null
  readonly totalCostUsd: number | null
}

/**
 * One `runner_runs` row (phase-14 appdata v7). Inserted at spawn START with the
 * pid + `startedAt` (so a crash orphaning the child leaves an UNFINISHED row —
 * `isError`/`exitCode` both null — for the §10.1 boot sweep to find), then
 * finalized on exit. `startedAt` MUST be `new Date().toISOString()` — the
 * phase-14 `CallBudget.windowUsage` contract does a lexicographic time compare.
 * `shadowCostUsd` copies the envelope's `total_cost_usd` and is an ESTIMATE
 * everywhere it surfaces (a subscription is flat-fee; there are no `spend` rows).
 */
export interface RunnerRunRecord {
  readonly id: string
  readonly taskId: string
  readonly mode: RunnerMode
  readonly model: string | null
  readonly claudeSessionId: string | null
  readonly transportSessionId: string | null
  readonly pid: number | null
  /** ISO-8601 UTC (Date.toISOString) — load-bearing for CallBudget.windowUsage. */
  readonly startedAt: string
  readonly durationMs: number | null
  readonly numTurns: number | null
  readonly inputTokens: number | null
  readonly outputTokens: number | null
  readonly shadowCostUsd: number | null
  readonly stderrTail: string | null
  readonly isError: boolean | null
  readonly error: string | null
  readonly exitCode: number | null
}

/**
 * The ONE failure classifier's output (§9.1/§9.7). `auth`/`quota`/`not-installed`
 * map to the sticky `RunnerHealthState`s; `other` leaves the state as-is (a
 * transient run failure the queue retries). `resetAtUnixMs` is a best-effort
 * parse of a quota "resets at <time>" hint — the seam a later phase turns into a
 * reset-aware `TaskRetryAtError` deferral (no retry attempt consumed).
 */
export type RunnerFailureKind = 'auth' | 'quota' | 'not-installed' | 'other'

export interface RunnerFailure {
  readonly kind: RunnerFailureKind
  readonly detail: string
  readonly resetAtUnixMs?: number
}

/**
 * The health-cache snapshot (§9.7) behind `get_runner_status` + the dashboard
 * banner. `resolved`/`version`/`versionOk` come from the last binary probe;
 * `state`/`lastError` from the last probe OR the last real run's classified
 * failure. `enabled` mirrors `settings.runner.enabled` at snapshot time.
 */
export interface RunnerHealthSnapshot {
  readonly enabled: boolean
  readonly resolved: ResolvedBinary | null
  readonly binaryPath: string | null
  readonly version: string | null
  readonly versionOk: boolean
  readonly state: RunnerHealthState
  readonly checkedAtMs: number
  readonly lastAuthOkAtMs: number | null
  readonly lastError: string | null
}
