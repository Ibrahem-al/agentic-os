/**
 * Runner health cache + the ONE failure classifier (phase 17; P0.7/P0.8/§9.1/§9.7).
 *
 * There is no reliable offline "am I logged in" probe (§9.7), and scraping the
 * CLI's credential files violates the app's secret hygiene — so auth/quota state
 * is learned by CLASSIFYING real run failures, and the only proactive probe is
 * `claude --version` (binary present + new enough). `classifyRunnerFailure` is
 * the single source both the completion path and (later) the queue's retry
 * taxonomy read, so the auth/quota/not-installed strings never drift.
 *
 * `isHealthy()` is SYNCHRONOUS (it is the router's injected `runnerHealthy()`,
 * called per route): it reads the cached snapshot and, when the snapshot is
 * missing or older than `RUNNER_HEALTH_TTL_MS`, kicks a background refresh
 * (never blocking the caller). A sticky auth/quota/not-installed state suppresses
 * routing for up to one TTL, then decays to `unknown` so exactly one task
 * re-probes per window — the rest defer without each paying to rediscover an
 * expired login (§9.7).
 */
import { RUNNER_HEALTH_TTL_MS, RUNNER_MIN_CLI_VERSION } from '../config'
import type { ModelSettings } from '../models/settings'
import {
  meetsMinVersion,
  npmGlobalBinDir,
  probeClaudeVersion,
  resolveClaudeBinary,
  type BinaryResolveDeps
} from './binary'
import type { ResolvedBinary, RunnerEnvelope, RunnerFailure, RunnerHealthSnapshot, RunnerHealthState } from './types'

// ── the one classifier (§9.1/§9.7) ────────────────────────────────────────────

const AUTH_RE = /please run \/login|oauth|credential|authentication_error|invalid api key/i
const QUOTA_RE = /usage limit|rate limit|resets at|overloaded|429/i

function firstMatchLine(text: string, re: RegExp): string {
  for (const line of text.split(/\r?\n/)) {
    if (re.test(line)) return line.trim().slice(0, 200)
  }
  return text.split(/\r?\n/, 1)[0]?.trim().slice(0, 200) ?? ''
}

/** Best-effort parse of a quota "resets at <time>" hint → a future unix-ms. */
export function parseResetTime(text: string, nowMs: number): number | undefined {
  const iso = /\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?/.exec(text)
  if (iso !== null) {
    const t = Date.parse(iso[0])
    if (!Number.isNaN(t) && t > nowMs) return t
  }
  const clock = /resets?\s+at\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/i.exec(text)
  if (clock !== null) {
    let hour = Number(clock[1])
    const min = clock[2] !== undefined ? Number(clock[2]) : 0
    const meridiem = clock[3]?.toLowerCase()
    if (meridiem === 'pm' && hour < 12) hour += 12
    if (meridiem === 'am' && hour === 12) hour = 0
    if (hour > 23 || min > 59) return undefined
    const d = new Date(nowMs)
    d.setHours(hour, min, 0, 0)
    let t = d.getTime()
    if (t <= nowMs) t += 24 * 60 * 60 * 1000 // the next occurrence
    return t
  }
  return undefined
}

/**
 * Classify a failed run (envelope may be null when the CLI printed no valid
 * envelope). Auth and quota are matched against BOTH stderr and the envelope's
 * result text; everything else with no envelope is `not-installed` (drift / CLI
 * missing), and a present-but-`is_error` envelope with no auth/quota signal is a
 * transient `other`.
 */
export function classifyRunnerFailure(
  envelope: RunnerEnvelope | null,
  stderr: string,
  nowMs: number = Date.now()
): RunnerFailure {
  const haystack = `${stderr}\n${envelope?.result ?? ''}`
  if (AUTH_RE.test(haystack)) {
    return { kind: 'auth', detail: firstMatchLine(haystack, AUTH_RE) }
  }
  if (QUOTA_RE.test(haystack)) {
    const resetAtUnixMs = parseResetTime(haystack, nowMs)
    return {
      kind: 'quota',
      detail: firstMatchLine(haystack, QUOTA_RE),
      ...(resetAtUnixMs !== undefined ? { resetAtUnixMs } : {})
    }
  }
  if (envelope === null) {
    const detail = stderr.trim().split(/\r?\n/, 1)[0]?.slice(0, 200)
    return { kind: 'not-installed', detail: detail !== undefined && detail !== '' ? detail : 'runner produced no valid envelope (CLI missing or drifted)' }
  }
  return { kind: 'other', detail: 'runner reported is_error with no auth/quota signal' }
}

// ── the health cache ──────────────────────────────────────────────────────────

export interface RunnerHealthDeps {
  readonly loadSettings: () => ModelSettings
  readonly now?: () => number
  readonly ttlMs?: number
  readonly minVersion?: string
  readonly env?: NodeJS.ProcessEnv
  readonly platform?: NodeJS.Platform
  readonly homeDir?: string
  readonly execPath?: string
  /** Seams (default the real binary-module fns). */
  readonly resolveBinary?: (deps: BinaryResolveDeps) => ResolvedBinary | null
  readonly probeVersion?: (invocation: ResolvedBinary) => Promise<string | null>
  readonly npmBinDir?: () => Promise<string | null>
}

export class RunnerHealth {
  private readonly now: () => number
  private readonly ttlMs: number
  private readonly minVersion: string
  private readonly resolveBinaryFn: (deps: BinaryResolveDeps) => ResolvedBinary | null
  private readonly probeVersionFn: (invocation: ResolvedBinary) => Promise<string | null>
  private readonly npmBinDirFn: () => Promise<string | null>

  private resolved: ResolvedBinary | null = null
  private version: string | null = null
  private versionOk = false
  private state: RunnerHealthState = 'unknown'
  private stateSetAtMs = 0
  private checkedAtMs = 0
  private lastAuthOkAtMs: number | null = null
  private lastError: string | null = null
  private refreshing: Promise<RunnerHealthSnapshot> | null = null
  private cachedNpmBinDir: string | null | undefined = undefined

  constructor(private readonly deps: RunnerHealthDeps) {
    this.now = deps.now ?? (() => Date.now())
    this.ttlMs = deps.ttlMs ?? RUNNER_HEALTH_TTL_MS
    this.minVersion = deps.minVersion ?? RUNNER_MIN_CLI_VERSION
    this.resolveBinaryFn = deps.resolveBinary ?? resolveClaudeBinary
    this.probeVersionFn = deps.probeVersion ?? ((invocation) => probeClaudeVersion(invocation, { ...(deps.env !== undefined ? { env: deps.env } : {}) }))
    this.npmBinDirFn =
      deps.npmBinDir ??
      (() =>
        npmGlobalBinDir({
          ...(deps.env !== undefined ? { env: deps.env } : {}),
          ...(deps.platform !== undefined ? { platform: deps.platform } : {})
        }))
  }

  private enabled(): boolean {
    return this.deps.loadSettings().runner?.enabled === true
  }

  /**
   * A sticky failure suppresses routing only within one TTL; afterwards it decays
   * to `unknown` so the next attempt re-probes (the real run IS the auth probe).
   */
  private effectiveState(nowMs: number): RunnerHealthState {
    if (this.state === 'auth-expired' || this.state === 'quota-exhausted' || this.state === 'not-installed') {
      return nowMs - this.stateSetAtMs < this.ttlMs ? this.state : 'unknown'
    }
    return this.state
  }

  /**
   * The router's `runnerHealthy()`. Synchronous: enabled ∧ resolved ∧ version-ok
   * ∧ effective-state usable. Kicks a non-blocking refresh when the snapshot is
   * missing or stale so the NEXT call reflects a fresh probe.
   */
  isHealthy(): boolean {
    if (!this.enabled()) return false
    const now = this.now()
    if (this.checkedAtMs === 0 || now - this.checkedAtMs > this.ttlMs) this.kickRefresh()
    if (this.resolved === null || !this.versionOk) return false
    const eff = this.effectiveState(now)
    return eff === 'ok' || eff === 'unknown'
  }

  /** The resolved invocation for the completion path (may be stale — refresh keeps it live). */
  resolvedBinary(): ResolvedBinary | null {
    return this.resolved
  }

  /** The current snapshot (RAW sticky state, for `get_runner_status` + the banner). */
  snapshot(): RunnerHealthSnapshot {
    return {
      enabled: this.enabled(),
      resolved: this.resolved,
      binaryPath: this.resolved?.path ?? null,
      version: this.version,
      versionOk: this.versionOk,
      state: this.state,
      checkedAtMs: this.checkedAtMs,
      lastAuthOkAtMs: this.lastAuthOkAtMs,
      lastError: this.lastError
    }
  }

  private setState(state: RunnerHealthState, atMs: number, error: string | null): void {
    this.state = state
    this.stateSetAtMs = atMs
    this.lastError = error
  }

  /** A successful run/canary — clears any sticky failure and stamps the auth-ok time. */
  noteSuccess(): void {
    const now = this.now()
    this.setState('ok', now, null)
    this.lastAuthOkAtMs = now
  }

  /** A classified failure — flips the sticky state (never for a transient `other`). */
  noteFailure(failure: RunnerFailure): void {
    const now = this.now()
    switch (failure.kind) {
      case 'auth':
        this.setState('auth-expired', now, failure.detail)
        break
      case 'quota':
        this.setState('quota-exhausted', now, failure.detail)
        break
      case 'not-installed':
        this.versionOk = false
        this.setState('not-installed', now, failure.detail)
        break
      case 'other':
        this.lastError = failure.detail
        break
    }
  }

  /** Kick a background refresh (deduped) — never awaited by the caller. */
  kickRefresh(): void {
    if (this.refreshing !== null) return
    void this.refresh().catch(() => undefined)
  }

  /** Re-resolve the binary + probe its version; updates the snapshot. Deduped. */
  refresh(): Promise<RunnerHealthSnapshot> {
    if (this.refreshing !== null) return this.refreshing
    const run = this.doRefresh().finally(() => {
      this.refreshing = null
    })
    this.refreshing = run
    return run
  }

  private async doRefresh(): Promise<RunnerHealthSnapshot> {
    const now = this.now()
    if (this.cachedNpmBinDir === undefined) {
      this.cachedNpmBinDir = await this.npmBinDirFn().catch(() => null)
    }
    const runnerSettings = this.deps.loadSettings().runner
    const resolveDeps: BinaryResolveDeps = {
      ...(runnerSettings?.binaryPath !== undefined ? { settingsBinaryPath: runnerSettings.binaryPath } : {}),
      ...(this.deps.env !== undefined ? { env: this.deps.env } : {}),
      ...(this.deps.platform !== undefined ? { platform: this.deps.platform } : {}),
      ...(this.deps.homeDir !== undefined ? { homeDir: this.deps.homeDir } : {}),
      ...(this.deps.execPath !== undefined ? { execPath: this.deps.execPath } : {}),
      ...(this.cachedNpmBinDir !== null ? { extraDirs: [this.cachedNpmBinDir] } : {})
    }
    const resolved = this.resolveBinaryFn(resolveDeps)
    this.resolved = resolved
    this.checkedAtMs = now

    if (resolved === null) {
      this.version = null
      this.versionOk = false
      this.setState('not-installed', now, 'claude binary not found (settings.runner.binaryPath / ~/.local/bin / PATH)')
      return this.snapshot()
    }

    const version = await this.probeVersionFn(resolved)
    this.version = version
    if (version === null || !meetsMinVersion(version, this.minVersion)) {
      this.versionOk = false
      this.setState(
        'not-installed',
        now,
        version === null ? 'claude --version did not run' : `claude ${version} is below the minimum ${this.minVersion}`
      )
    } else {
      this.versionOk = true
      // Binary present + new enough. Recover from a stale `not-installed`;
      // preserve auth/quota/ok (auth cannot be probed offline — §9.7).
      if (this.state === 'not-installed') this.setState('unknown', now, null)
    }
    return this.snapshot()
  }
}
