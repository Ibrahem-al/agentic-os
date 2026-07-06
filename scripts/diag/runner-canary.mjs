/**
 * Subscription-runner CLI canary (phase 20; P2, GATED) — catches upstream drift
 * in the `claude` CLI's `--output-format json` envelope that the subscription
 * runner depends on (src/main/runner/spawn.ts:parseRunnerEnvelope).
 *
 * GATED on `claude` being resolvable. This script NEVER fails a run just because
 * `claude` is absent — that is the expected state in CI (we deliberately do NOT
 * install `claude` there) and on a default machine. It only makes a real,
 * one-turn, tools-stripped call when a `claude` binary is actually present, and
 * only flags a hard FAIL when the CLI exits 0 but the JSON envelope contract is
 * broken — the one signal that means the runner's parser needs updating.
 *
 * Dependency-free: node built-ins only, so it runs in CI with no build and no
 * install. The resolve + spawn + envelope logic mirrors (does not import) the
 * runner so this stays a black-box probe of the same contract.
 *
 * Invocation mirrors completion mode (spawn.ts / completion.ts): the prompt
 * rides stdin; argv is `-p --output-format json --max-turns 1 --disallowedTools …`
 * (no MCP, no tools). `--model` is intentionally omitted so the probe does not
 * depend on a specific model alias — the envelope shape is model-independent.
 *
 * Exit codes:
 *   0  skipped (no `claude`) · PASS (valid envelope) · INCONCLUSIVE (claude
 *      present but the call couldn't complete — not logged in / offline / quota;
 *      not a drift signal, so never a failure)
 *   1  FAIL — `claude` exited 0 but produced no valid `--output-format json`
 *      envelope (missing/mistyped is_error/result/session_id) = upstream drift
 *
 * Usage:  node scripts/diag/runner-canary.mjs
 * Env:    AGENTIC_OS_RUNNER_BINARY (same seam the app honors) · CLAUDE_BIN
 *         RUNNER_CANARY_TIMEOUT_MS (default 120000)
 */
import { spawn } from 'node:child_process'
import { existsSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, join } from 'node:path'
import { clearTimeout, setTimeout } from 'node:timers'
import process from 'node:process'
import console from 'node:console'

const PLATFORM = process.platform
const IS_WIN = PLATFORM === 'win32'
const TIMEOUT_MS = Number(process.env['RUNNER_CANARY_TIMEOUT_MS']) || 120_000
const PROMPT = 'Reply with the single word: OK'
// Same tools the runner strips (completion.ts:RUNNER_DISALLOWED_TOOLS).
const DISALLOWED = 'Bash,Edit,Write,NotebookEdit,WebFetch,WebSearch,Task'
const ARGV = ['-p', '--output-format', 'json', '--max-turns', '1', '--disallowedTools', DISALLOWED]

const log = (msg) => console.log(`runner-canary: ${msg}`)

// ── resolution (mirrors runner/binary.ts, running-platform only) ─────────────

const fileExists = (p) => {
  try {
    return existsSync(p) && statSync(p).isFile()
  } catch {
    return false
  }
}

const candidateNames = () => (IS_WIN ? ['claude.exe', 'claude.cmd'] : ['claude'])

function wellKnownDirs() {
  const home = homedir()
  const dirs = [join(home, '.local', 'bin')]
  if (!IS_WIN) dirs.push('/usr/local/bin', '/opt/homebrew/bin')
  return dirs
}

/** Turn a resolved path into a spawnable invocation (never a shell). */
function classify(path) {
  const lower = path.toLowerCase()
  if (lower.endsWith('.mjs') || lower.endsWith('.cjs') || lower.endsWith('.js')) {
    return { path, command: process.execPath, prefixArgs: [path], nodeScript: true }
  }
  if (IS_WIN && lower.endsWith('.cmd')) {
    const comspec = process.env['ComSpec'] ?? process.env['COMSPEC'] ?? 'cmd.exe'
    return { path, command: comspec, prefixArgs: ['/d', '/s', '/c', path], nodeScript: false }
  }
  return { path, command: path, prefixArgs: [], nodeScript: false }
}

/** First hit wins: env seams → well-known dirs → PATH. `null` when absent. */
function resolveClaude() {
  const override = process.env['AGENTIC_OS_RUNNER_BINARY'] || process.env['CLAUDE_BIN']
  if (override && override !== '') return classify(override)

  for (const dir of wellKnownDirs()) {
    for (const name of candidateNames()) {
      const candidate = join(dir, name)
      if (fileExists(candidate)) return classify(candidate)
    }
  }

  const rawPath = process.env['PATH'] ?? process.env['Path'] ?? ''
  for (const dir of rawPath.split(delimiter)) {
    if (dir === '') continue
    for (const name of candidateNames()) {
      const candidate = join(dir, name)
      if (fileExists(candidate)) return classify(candidate)
    }
  }
  return null
}

// ── envelope parse (mirrors spawn.ts:parseRunnerEnvelope) ────────────────────

function sliceLastJsonObject(text) {
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  return start >= 0 && end > start ? text.slice(start, end + 1) : null
}

/** → { ok:true, envelope } | { ok:false, reason, detail }. */
function parseEnvelope(stdout) {
  const trimmed = stdout.trim()
  if (trimmed === '') return { ok: false, reason: 'empty', detail: 'no stdout' }
  let raw
  try {
    raw = JSON.parse(trimmed)
  } catch {
    const sliced = sliceLastJsonObject(trimmed)
    if (sliced === null) return { ok: false, reason: 'not-json', detail: trimmed.slice(0, 200) }
    try {
      raw = JSON.parse(sliced)
    } catch {
      return { ok: false, reason: 'not-json', detail: trimmed.slice(0, 200) }
    }
  }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, reason: 'not-json', detail: 'stdout was not a JSON object' }
  }
  const sessionId = raw['session_id']
  const isError = raw['is_error']
  const result = raw['result']
  if (typeof sessionId !== 'string' || typeof isError !== 'boolean' || typeof result !== 'string') {
    return {
      ok: false,
      reason: 'missing-field',
      detail: `keys: ${Object.keys(raw).slice(0, 12).join(',')}`
    }
  }
  return { ok: true, envelope: { sessionId, isError, result } }
}

// ── spawn one bounded call ───────────────────────────────────────────────────

function runClaude(inv) {
  return new Promise((resolve) => {
    const env = inv.nodeScript ? { ...process.env, ELECTRON_RUN_AS_NODE: '1' } : process.env
    let child
    try {
      child = spawn(inv.command, [...inv.prefixArgs, ...ARGV], {
        env,
        windowsHide: true,
        detached: !IS_WIN,
        stdio: 'pipe'
      })
    } catch (err) {
      resolve({ spawnError: err instanceof Error ? err.message : String(err) })
      return
    }

    const pid = child.pid ?? null
    let stdout = ''
    let stderr = ''
    let timedOut = false
    let settled = false
    const settle = (outcome) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(outcome)
    }

    const killTree = () => {
      if (pid !== null && !IS_WIN) {
        try {
          process.kill(-pid, 'SIGKILL')
          return
        } catch {
          /* fall through to direct kill */
        }
      }
      if (IS_WIN && pid !== null) {
        try {
          spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }).on('error', () => undefined)
        } catch {
          /* fall through */
        }
      }
      try {
        child.kill('SIGKILL')
      } catch {
        /* already gone */
      }
    }

    const timer = setTimeout(() => {
      timedOut = true
      killTree()
    }, TIMEOUT_MS)

    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (c) => (stdout += c))
    child.stderr.on('data', (c) => (stderr = (stderr + c).slice(-4096)))
    child.on('error', (err) => settle({ spawnError: err instanceof Error ? err.message : String(err) }))
    child.on('close', (code) => settle({ stdout, stderr, exitCode: code, timedOut }))
    child.stdin.on('error', () => undefined)
    child.stdin.end(PROMPT)
  })
}

// ── main ──────────────────────────────────────────────────────────────────────

const inv = resolveClaude()
if (inv === null) {
  log('skipped: claude not installed (not found via AGENTIC_OS_RUNNER_BINARY/CLAUDE_BIN, well-known dirs, or PATH)')
  process.exit(0)
}

log(`claude resolved at ${inv.path} (platform ${PLATFORM}); probing 'claude ${ARGV.join(' ')}' with prompt on stdin`)

const outcome = await runClaude(inv)

if (outcome.spawnError !== undefined) {
  // Resolution raced with a removed/renamed binary — treat as absence, never a failure.
  log(`skipped: claude present at resolve time but not spawnable (${outcome.spawnError})`)
  process.exit(0)
}

if (outcome.timedOut) {
  log(`INCONCLUSIVE: no reply within ${TIMEOUT_MS}ms — killed. Likely offline or awaiting interactive auth; not asserting the envelope.`)
  process.exit(0)
}

const parsed = parseEnvelope(outcome.stdout ?? '')
const stderrTail = (outcome.stderr ?? '').trim().slice(-400)

if (parsed.ok) {
  const { sessionId, isError, result } = parsed.envelope
  log(`envelope OK — is_error=${isError} · session_id=${sessionId.slice(0, 12)}… · result=${JSON.stringify(result.slice(0, 60))}`)
  if (isError) {
    log('PASS (envelope contract intact) — note: is_error=true (auth/quota/policy on the account, not CLI drift).')
  } else {
    log('PASS — envelope fields is_error/result/session_id all present and well-typed.')
  }
  process.exit(0)
}

// No valid envelope. Only a CLEAN exit (0) with a malformed envelope is drift.
if (outcome.exitCode === 0) {
  log(`FAIL: claude exited 0 but the --output-format json envelope is invalid (${parsed.reason}: ${parsed.detail}).`)
  log('This is upstream CLI drift — update src/main/runner/spawn.ts:parseRunnerEnvelope to match.')
  if (stderrTail !== '') log(`stderr tail: ${stderrTail}`)
  process.exit(1)
}

log(
  `INCONCLUSIVE: claude present but the call did not complete (exit ${outcome.exitCode}; envelope ${parsed.reason}). ` +
    'Likely not logged in, offline, or out of quota — not a drift signal, so not failing.'
)
if (stderrTail !== '') log(`stderr tail: ${stderrTail}`)
process.exit(0)
