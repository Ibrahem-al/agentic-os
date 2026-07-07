/**
 * Runner binary resolution + version gate (phase 17; P1.9/§10.12).
 *
 * A GUI-launched Electron app inherits the DESKTOP environment, not the user's
 * shell profile — so `claude` "on PATH" in a terminal is frequently absent from
 * the app, and Claude Code's native install (`~/.local/bin`) + nvm/npm prefixes
 * are the usual real locations. Resolution order (first hit wins):
 *   1. the `AGENTIC_OS_RUNNER_BINARY` env seam, then `settings.runner.binaryPath`
 *      — both win over ALL probing (the test seam + the user's explicit override);
 *   2. well-known locations (`~/.local/bin`, an async-resolved npm global bin,
 *      `/usr/local/bin`, `/opt/homebrew/bin`);
 *   3. bare `claude` on PATH.
 *
 * Two spawn shapes never use a shell (argv-injection safety, §10.12):
 *   - a `.mjs`/`.js` target → `process.execPath` + `[script, ...argv]`, so a Node
 *     fake runner runs cross-platform under vitest with no CLI installed;
 *   - a win32 npm `claude.cmd` shim → `cmd.exe /d /s /c <cmd> …` (NEVER
 *     `shell:true`), preferring a native `claude.exe` when one exists.
 *
 * `resolveClaudeBinary` is SYNC and does only fast fs existence checks — it runs
 * inside `get_runner_status` and (indirectly) the router's `runnerHealthy()`, so
 * it must never block on a subprocess. The two subprocess probes (`claude
 * --version`, `npm prefix -g`) are ASYNC + bounded and run only inside the health
 * cache's refresh, behind `RUNNER_HEALTH_TTL_MS`.
 */
import { spawn as nodeSpawn } from 'node:child_process'
import { existsSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { posix, win32 } from 'node:path'
import { RUNNER_MIN_CLI_VERSION } from '../config'
import type { BinaryStrategy, ResolvedBinary } from './types'

/** Path semantics + PATH separator for the RESOLVED platform (honors the seam). */
function pathModule(platform: NodeJS.Platform): typeof posix {
  return platform === 'win32' ? win32 : posix
}
function pathDelimiter(platform: NodeJS.Platform): string {
  return platform === 'win32' ? ';' : ':'
}

/** The env var whose value, when set, wins over all binary probing (test seam). */
export const RUNNER_BINARY_ENV = 'AGENTIC_OS_RUNNER_BINARY'

/** Injected seams (defaults read the real process/fs); tests pass fakes. */
export interface BinaryResolveDeps {
  /** `settings.runner.binaryPath` — honored right after the env seam. */
  readonly settingsBinaryPath?: string
  readonly env?: NodeJS.ProcessEnv
  readonly platform?: NodeJS.Platform
  readonly homeDir?: string
  readonly execPath?: string
  /** Existence predicate (default: exists AND is a regular file). */
  readonly fileExists?: (path: string) => boolean
  /** Extra well-known dirs (e.g. an async-resolved npm global bin) to probe. */
  readonly extraDirs?: readonly string[]
}

function defaultFileExists(path: string): boolean {
  try {
    return existsSync(path) && statSync(path).isFile()
  } catch {
    return false
  }
}

function isNodeScript(path: string): boolean {
  const lower = path.toLowerCase()
  return lower.endsWith('.mjs') || lower.endsWith('.cjs') || lower.endsWith('.js')
}

/**
 * Turn an absolute target path into a spawnable invocation. The SPAWN-mechanism
 * strategies win when they apply (`node-script`, `cmd-shim`) because they change
 * `command`/`prefixArgs`; otherwise the SOURCE strategy (`env`/`settings`/
 * `well-known`/`path`) is kept for `get_runner_status`.
 */
function classify(
  path: string,
  source: BinaryStrategy,
  platform: NodeJS.Platform,
  execPath: string,
  env: NodeJS.ProcessEnv
): ResolvedBinary {
  if (isNodeScript(path)) {
    return { path, command: execPath, prefixArgs: [path], strategy: 'node-script' }
  }
  if (platform === 'win32' && path.toLowerCase().endsWith('.cmd')) {
    const comspec = env['ComSpec'] ?? env['COMSPEC'] ?? 'cmd.exe'
    // `/d` skip AutoRun, `/s` keep quoting literal, `/c` run then exit — args
    // still ride the spawn array, so no shell parsing of untrusted input.
    return { path, command: comspec, prefixArgs: ['/d', '/s', '/c', path], strategy: 'cmd-shim' }
  }
  return { path, command: path, prefixArgs: [], strategy: source }
}

/** Windows candidates prefer the native `.exe` (directly spawnable) over `.cmd`. */
function candidateNames(platform: NodeJS.Platform): string[] {
  return platform === 'win32' ? ['claude.exe', 'claude.cmd'] : ['claude']
}

/** Absolute well-known dirs Claude Code / npm typically install into. */
function wellKnownDirs(platform: NodeJS.Platform, home: string, extra: readonly string[]): string[] {
  const pm = pathModule(platform)
  const dirs: string[] = [pm.join(home, '.local', 'bin'), ...extra]
  if (platform !== 'win32') dirs.push('/usr/local/bin', '/opt/homebrew/bin')
  return dirs
}

/** Scan PATH for the first existing candidate (win32 prefers `claude.exe`). */
function findOnPath(platform: NodeJS.Platform, env: NodeJS.ProcessEnv, fileExists: (p: string) => boolean): string | null {
  const raw = env['PATH'] ?? env['Path'] ?? ''
  if (raw === '') return null
  const pm = pathModule(platform)
  for (const dir of raw.split(pathDelimiter(platform))) {
    if (dir === '') continue
    for (const name of candidateNames(platform)) {
      const candidate = pm.join(dir, name)
      if (fileExists(candidate)) return candidate
    }
  }
  return null
}

/**
 * Resolve the runner invocation, or `null` when no `claude` can be found. Sync +
 * fs-only (no subprocess). The env seam and `settings.runner.binaryPath` are
 * honored UNCONDITIONALLY (they win over all probing) — a wrong explicit path
 * surfaces as a `not-installed` health failure on first spawn, never a silent
 * fall-through to a different binary.
 */
export function resolveClaudeBinary(deps: BinaryResolveDeps = {}): ResolvedBinary | null {
  const env = deps.env ?? process.env
  const platform = deps.platform ?? process.platform
  const home = deps.homeDir ?? homedir()
  const execPath = deps.execPath ?? process.execPath
  const fileExists = deps.fileExists ?? defaultFileExists

  const envOverride = env[RUNNER_BINARY_ENV]
  if (envOverride !== undefined && envOverride !== '') {
    return classify(envOverride, 'env', platform, execPath, env)
  }
  if (deps.settingsBinaryPath !== undefined && deps.settingsBinaryPath !== '') {
    return classify(deps.settingsBinaryPath, 'settings', platform, execPath, env)
  }

  const pm = pathModule(platform)
  for (const dir of wellKnownDirs(platform, home, deps.extraDirs ?? [])) {
    for (const name of candidateNames(platform)) {
      const candidate = pm.join(dir, name)
      if (fileExists(candidate)) return classify(candidate, 'well-known', platform, execPath, env)
    }
  }

  const onPath = findOnPath(platform, env, fileExists)
  if (onPath !== null) return classify(onPath, 'path', platform, execPath, env)

  return null
}

// ── async, bounded subprocess probes (refresh-only) ──────────────────────────

/** Spawn `command args`, capture trimmed stdout, or resolve `null` on any failure/timeout. */
function captureStdout(
  command: string,
  args: readonly string[],
  timeoutMs: number,
  env: NodeJS.ProcessEnv
): Promise<string | null> {
  return new Promise((resolve) => {
    let child
    try {
      child = nodeSpawn(command, [...args], { windowsHide: true, env, stdio: ['ignore', 'pipe', 'ignore'] })
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
        /* already gone */
      }
      settle(null)
    }, timeoutMs)
    child.stdout?.setEncoding('utf8')
    child.stdout?.on('data', (chunk: string) => (stdout += chunk))
    child.on('error', () => settle(null))
    child.on('close', (code) => settle(code === 0 ? stdout.trim() : null))
  })
}

export interface NpmPrefixDeps {
  readonly env?: NodeJS.ProcessEnv
  readonly platform?: NodeJS.Platform
  readonly timeoutMs?: number
}

/**
 * Best-effort `npm prefix -g` → the dir global bins live in (§10.12), or `null`.
 * Bounded + guarded so a missing/hung npm can never stall the health refresh.
 * win32 npm is `npm.cmd` (unspawnable directly), so it rides `cmd.exe /d /s /c`.
 */
export async function npmGlobalBinDir(deps: NpmPrefixDeps = {}): Promise<string | null> {
  const env = deps.env ?? process.env
  const platform = deps.platform ?? process.platform
  const timeout = deps.timeoutMs ?? 2500
  const out =
    platform === 'win32'
      ? await captureStdout(env['ComSpec'] ?? 'cmd.exe', ['/d', '/s', '/c', 'npm', 'prefix', '-g'], timeout, env)
      : await captureStdout('npm', ['prefix', '-g'], timeout, env)
  if (out === null || out === '') return null
  const prefix = out.split(/\r?\n/)[0]?.trim()
  if (prefix === undefined || prefix === '') return null
  // npm puts global bins at <prefix> on win32, <prefix>/bin on POSIX.
  return platform === 'win32' ? prefix : posix.join(prefix, 'bin')
}

export interface VersionProbeDeps {
  readonly timeoutMs?: number
  readonly env?: NodeJS.ProcessEnv
  /** Test seam: run the argv and return stdout (default: async spawn). */
  readonly runVersion?: (command: string, args: readonly string[]) => Promise<string | null>
}

/**
 * `claude --version` → the normalized `major.minor.patch` string, or `null` when
 * the binary can't be run or prints nothing parseable. Async + bounded.
 */
export async function probeClaudeVersion(invocation: ResolvedBinary, deps: VersionProbeDeps = {}): Promise<string | null> {
  const timeout = deps.timeoutMs ?? 10_000
  const env = deps.env ?? process.env
  const run = deps.runVersion ?? ((command: string, args: readonly string[]) => captureStdout(command, args, timeout, env))
  const out = await run(invocation.command, [...invocation.prefixArgs, '--version'])
  if (out === null) return null
  const parsed = parseSemver(out)
  return parsed !== null ? `${parsed[0]}.${parsed[1]}.${parsed[2]}` : null
}

// ── version comparison (RUNNER_MIN_CLI_VERSION) ──────────────────────────────

/** Parse the first `d.d.d` triple out of `claude --version` output. */
export function parseSemver(text: string): [number, number, number] | null {
  const m = /(\d+)\.(\d+)\.(\d+)/.exec(text)
  if (m === null) return null
  return [Number(m[1]), Number(m[2]), Number(m[3])]
}

/** `a >= b` over `major.minor.patch`; an unparseable `version` is never `>=`. */
export function meetsMinVersion(version: string, min: string = RUNNER_MIN_CLI_VERSION): boolean {
  const a = parseSemver(version)
  const b = parseSemver(min)
  if (a === null || b === null) return false
  for (let i = 0; i < 3; i++) {
    const av = a[i] ?? 0
    const bv = b[i] ?? 0
    if (av !== bv) return av > bv
  }
  return true
}
