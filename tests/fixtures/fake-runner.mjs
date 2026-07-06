/**
 * Fake `claude -p --output-format json` — a standalone, dependency-free Node
 * script that stands in for the real Claude Code CLI so the phase-17 runner
 * tests never need a real binary, network, or subscription (offline + hermetic).
 *
 * Point the runner at it with `AGENTIC_OS_RUNNER_BINARY=<abs>/fake-runner.mjs`
 * (binary.ts sees the `.mjs` and spawns `process.execPath [scriptPath,...argv]`,
 * so this runs cross-platform with NO shell). It reads argv + all of stdin and
 * writes ONE result envelope to stdout, marker-dispatched so tests can script
 * every failure mode the runner must survive.
 *
 * ── Invocation shapes ────────────────────────────────────────────────────────
 *   node fake-runner.mjs --version
 *       → prints a version string (default `2.0.0 (Claude Code)`, ≥
 *         RUNNER_MIN_CLI_VERSION='1.0.0'), exit 0. Does NOT read stdin.
 *   node fake-runner.mjs -p --output-format json --max-turns 1 --model <m> ...
 *       → reads the prompt (system+user) from stdin, emits the envelope. Extra
 *         flags (--disallowedTools, --model, …) are accepted and ignored.
 *
 * ── The envelope (stdout, one JSON object; §6.7/§10.12) ──────────────────────
 *   { session_id, is_error, num_turns, duration_ms,
 *     usage: { input_tokens, output_tokens }, total_cost_usd, result }
 *   All values are DETERMINISTIC: session_id = sha256(stdin) as a uuid;
 *   tokens = ceil(len/4); cost = $3/M in + $15/M out; num_turns=1; duration=123.
 *   Every one of these is overridable by an env knob (below) for exact control.
 *
 * ── Scenario dispatch (precedence: env MODE > stdin marker > `ok`) ───────────
 *   AGENTIC_OS_FAKE_RUNNER_MODE forces a scenario if set; otherwise the first
 *   recognized marker found in stdin wins; otherwise a normal reply.
 *
 *   scenario         env MODE          stdin marker                  behaviour
 *   ---------------  ----------------  ----------------------------  --------------------------------------------
 *   normal reply     ok (default)      (none) / FAKE_RUNNER_ECHO:x   valid envelope, is_error=false, exit 0
 *   auth-expiry      auth              FAKE_RUNNER_AUTH              envelope is_error=true; stderr 'Please run
 *                                                                    /login'; exit 1  (classifier → auth-expired)
 *   quota (limit)    quota             FAKE_RUNNER_QUOTA            envelope is_error=true; stderr 'usage limit
 *                                                                    ... resets at <t>'; exit 1  (→ quota)
 *   quota (429)      quota-429         FAKE_RUNNER_QUOTA_429        envelope is_error=true; stderr '429 rate
 *                                                                    limit'; exit 1  (→ quota)
 *   generic error    error             FAKE_RUNNER_ERROR           envelope is_error=true; unclassified stderr;
 *                                                                    exit 1  (classifier → not-installed/else)
 *   drift: no result drift-no-result  FAKE_RUNNER_DRIFT_NORESULT   valid JSON but `result` OMITTED; exit 0
 *   drift: no sid    drift-no-session  FAKE_RUNNER_DRIFT_NOSESSION  valid JSON but `session_id` OMITTED; exit 0
 *   drift: non-JSON  drift-nonjson     FAKE_RUNNER_DRIFT_NONJSON    prints a NON-JSON line; exit 0
 *   drift: empty     drift-empty       FAKE_RUNNER_DRIFT_EMPTY      prints NOTHING to stdout; exit 0
 *   hang             hang              FAKE_RUNNER_HANG             sleeps (no output) until the watchdog kills
 *                                                                    the tree; self-exits after HANG_MS as a net
 * (Every `drift-*` exits 0 — the CLI "succeeded" but the parser must reject the
 *  output as a not-installed-grade failure. auth/quota/error carry the telltale
 *  in BOTH stderr and `result`, so classifyRunnerFailure matches either way.)
 *
 * ── Normal-reply result text (mode `ok`) — first match wins ──────────────────
 *   1. env AGENTIC_OS_FAKE_RUNNER_RESULT           → that exact string
 *   2. `FAKE_RUNNER_ECHO:<text>` in stdin          → <text> up to end-of-line
 *   3. otherwise                                    → the whole stdin, verbatim
 *      (empty stdin → a fixed fallback string) — proves the stdin→result round-trip.
 *
 * ── Env knobs (all optional; deterministic defaults) ─────────────────────────
 *   AGENTIC_OS_FAKE_RUNNER_MODE           force a scenario (see table)
 *   AGENTIC_OS_FAKE_RUNNER_RESULT         exact `result` text (ok mode)
 *   AGENTIC_OS_FAKE_RUNNER_VERSION        `--version` output (e.g. '0.9.0' to fail the min-version gate)
 *   AGENTIC_OS_FAKE_RUNNER_SESSION_ID     fixed session_id
 *   AGENTIC_OS_FAKE_RUNNER_INPUT_TOKENS   usage.input_tokens (quota/window-usage tests)
 *   AGENTIC_OS_FAKE_RUNNER_OUTPUT_TOKENS  usage.output_tokens
 *   AGENTIC_OS_FAKE_RUNNER_COST_USD       total_cost_usd (the shadow-cost estimate)
 *   AGENTIC_OS_FAKE_RUNNER_NUM_TURNS      num_turns
 *   AGENTIC_OS_FAKE_RUNNER_DURATION_MS    duration_ms
 *   AGENTIC_OS_FAKE_RUNNER_RESET_AT       quota reset timestamp embedded in the message
 *   AGENTIC_OS_FAKE_RUNNER_HANG_MS        hang self-exit safety net (default 60000)
 *   AGENTIC_OS_FAKE_RUNNER_HANG_CHILD     truthy → also spawn a grandchild sleeper (stays in the process
 *                                         group/tree, pid printed to stderr) so the process-TREE kill is testable
 *
 * Node built-ins only. stdout/stderr are written with fs.writeSync so a fast
 * process.exit() never drops piped output on linux (phase-13 lesson).
 */
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { writeSync } from 'node:fs'
import process from 'node:process'
import { setTimeout } from 'node:timers'

const ENV = process.env

// ── Marker / mode tables ─────────────────────────────────────────────────────

const MODES = new Set([
  'ok', 'auth', 'quota', 'quota-429', 'error',
  'drift-no-result', 'drift-no-session', 'drift-nonjson', 'drift-empty', 'hang'
])

/** Ordered so longer markers are tested before their prefixes (QUOTA_429 > QUOTA). */
const STDIN_MARKERS = [
  ['FAKE_RUNNER_HANG', 'hang'],
  ['FAKE_RUNNER_AUTH', 'auth'],
  ['FAKE_RUNNER_QUOTA_429', 'quota-429'],
  ['FAKE_RUNNER_QUOTA', 'quota'],
  ['FAKE_RUNNER_DRIFT_NORESULT', 'drift-no-result'],
  ['FAKE_RUNNER_DRIFT_NOSESSION', 'drift-no-session'],
  ['FAKE_RUNNER_DRIFT_NONJSON', 'drift-nonjson'],
  ['FAKE_RUNNER_DRIFT_EMPTY', 'drift-empty'],
  ['FAKE_RUNNER_ERROR', 'error']
]

const ECHO_MARKER = 'FAKE_RUNNER_ECHO:'

// ── Small helpers ─────────────────────────────────────────────────────────────

function writeOut(text) {
  writeSync(1, text)
}

function writeErr(text) {
  writeSync(2, text)
}

function envInt(name, fallback) {
  const raw = ENV[name]
  if (raw === undefined || raw.trim() === '') return fallback
  const n = Number.parseInt(raw, 10)
  return Number.isFinite(n) ? n : fallback
}

function envNum(name, fallback) {
  const raw = ENV[name]
  if (raw === undefined || raw.trim() === '') return fallback
  const n = Number(raw)
  return Number.isFinite(n) ? n : fallback
}

function truthy(value) {
  if (value === undefined) return false
  const v = value.trim().toLowerCase()
  return v !== '' && v !== '0' && v !== 'false' && v !== 'no'
}

function estimateTokens(text) {
  return Math.max(1, Math.ceil(text.length / 4))
}

function defaultCost(inputTokens, outputTokens) {
  return Number(((inputTokens * 3 + outputTokens * 15) / 1_000_000).toFixed(6))
}

function resolveVersion() {
  const v = ENV.AGENTIC_OS_FAKE_RUNNER_VERSION
  return v !== undefined && v.trim() !== '' ? v.trim() : '2.0.0 (Claude Code)'
}

function resetTime() {
  const v = ENV.AGENTIC_OS_FAKE_RUNNER_RESET_AT
  return v !== undefined && v.trim() !== '' ? v.trim() : '2026-07-06T18:00:00.000Z'
}

// ── Input ─────────────────────────────────────────────────────────────────────

/** Read ALL of stdin as UTF-8. Resolves '' when stdin is a TTY (no pipe). */
function readStdin() {
  return new Promise((resolve) => {
    if (process.stdin.isTTY) {
      resolve('')
      return
    }
    let data = ''
    process.stdin.setEncoding('utf8')
    process.stdin.on('data', (chunk) => {
      data += chunk
    })
    process.stdin.on('end', () => resolve(data))
    process.stdin.on('error', () => resolve(data))
    process.stdin.resume()
  })
}

function resolveMode(stdin) {
  const envMode = (ENV.AGENTIC_OS_FAKE_RUNNER_MODE ?? '').trim()
  if (envMode !== '') {
    if (MODES.has(envMode)) return envMode
    writeErr(`[fake-runner] unknown AGENTIC_OS_FAKE_RUNNER_MODE='${envMode}' — defaulting to ok\n`)
    return 'ok'
  }
  for (const [marker, mode] of STDIN_MARKERS) {
    if (stdin.includes(marker)) return mode
  }
  return 'ok'
}

function resolveResult(stdin) {
  const override = ENV.AGENTIC_OS_FAKE_RUNNER_RESULT
  if (override !== undefined) return override
  const at = stdin.indexOf(ECHO_MARKER)
  if (at !== -1) {
    const start = at + ECHO_MARKER.length
    const nl = stdin.indexOf('\n', start)
    return (nl === -1 ? stdin.slice(start) : stdin.slice(start, nl)).trim()
  }
  const trimmed = stdin.trim()
  return trimmed === '' ? 'fake-runner: ok (no prompt on stdin)' : trimmed
}

function sessionId(stdin) {
  const override = ENV.AGENTIC_OS_FAKE_RUNNER_SESSION_ID
  if (override !== undefined && override.trim() !== '') return override.trim()
  const h = createHash('sha256').update(stdin).digest('hex')
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`
}

/** The full, well-formed envelope. Drift scenarios delete fields off it. */
function fullEnvelope(sid, isError, result, stdin) {
  const inputTokens = envInt('AGENTIC_OS_FAKE_RUNNER_INPUT_TOKENS', estimateTokens(stdin))
  const outputTokens = envInt('AGENTIC_OS_FAKE_RUNNER_OUTPUT_TOKENS', estimateTokens(result))
  return {
    session_id: sid,
    is_error: isError,
    num_turns: envInt('AGENTIC_OS_FAKE_RUNNER_NUM_TURNS', 1),
    duration_ms: envInt('AGENTIC_OS_FAKE_RUNNER_DURATION_MS', 123),
    usage: { input_tokens: inputTokens, output_tokens: outputTokens },
    total_cost_usd: envNum('AGENTIC_OS_FAKE_RUNNER_COST_USD', defaultCost(inputTokens, outputTokens)),
    result
  }
}

const line = (obj) => JSON.stringify(obj) + '\n'

// ── Scenarios ─────────────────────────────────────────────────────────────────

function computeOutcome(mode, stdin, sid) {
  switch (mode) {
    case 'auth': {
      const env = fullEnvelope(sid, true, 'authentication_error: credentials expired — please run /login', stdin)
      return { stdout: line(env), stderr: 'Please run /login to authenticate with your Claude account.\n', exitCode: 1 }
    }
    case 'quota': {
      const resetAt = resetTime()
      const env = fullEnvelope(sid, true, `usage limit reached; resets at ${resetAt}`, stdin)
      return { stdout: line(env), stderr: `Claude usage limit reached — your limit resets at ${resetAt}.\n`, exitCode: 1 }
    }
    case 'quota-429': {
      const env = fullEnvelope(sid, true, '429 rate limit exceeded', stdin)
      return { stdout: line(env), stderr: 'API error: 429 Too Many Requests — rate limit exceeded.\n', exitCode: 1 }
    }
    case 'error': {
      const env = fullEnvelope(sid, true, 'fake-runner forced error', stdin)
      return { stdout: line(env), stderr: 'fake-runner: forced generic failure (is_error).\n', exitCode: 1 }
    }
    case 'drift-no-result': {
      const env = fullEnvelope(sid, false, resolveResult(stdin), stdin)
      delete env.result
      return { stdout: line(env), stderr: '', exitCode: 0 }
    }
    case 'drift-no-session': {
      const env = fullEnvelope(sid, false, resolveResult(stdin), stdin)
      delete env.session_id
      return { stdout: line(env), stderr: '', exitCode: 0 }
    }
    case 'drift-nonjson': {
      return { stdout: 'fake-runner: this line is deliberately not JSON\n', stderr: '', exitCode: 0 }
    }
    case 'drift-empty': {
      return { stdout: '', stderr: '', exitCode: 0 }
    }
    default: {
      // 'ok' (and any unreachable fallthrough) — a normal reply.
      return { stdout: line(fullEnvelope(sid, false, resolveResult(stdin), stdin)), stderr: '', exitCode: 0 }
    }
  }
}

/**
 * Hang until the watchdog force-kills the process tree. Optionally spawns a
 * grandchild sleeper (NOT detached, so it shares this process's group/tree and
 * is reaped by `taskkill /T` / negative-pid group kill) to make the runner's
 * PROCESS-TREE kill assertion meaningful. Self-exits after HANG_MS as a net so
 * a misconfigured test can never wedge CI forever.
 */
function hang() {
  return new Promise((resolve) => {
    let child = null
    if (truthy(ENV.AGENTIC_OS_FAKE_RUNNER_HANG_CHILD)) {
      child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1 << 30)'], { stdio: 'ignore' })
      writeErr(`[fake-runner] hang-child-pid=${child.pid}\n`)
    }
    setTimeout(() => {
      if (child !== null) {
        try {
          child.kill('SIGKILL')
        } catch {
          /* grandchild already reaped by the watchdog's tree kill */
        }
      }
      resolve()
    }, envInt('AGENTIC_OS_FAKE_RUNNER_HANG_MS', 60_000))
  })
}

// ── Entry ─────────────────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2)

  if (args.includes('--version')) {
    writeOut(resolveVersion() + '\n')
    process.exit(0)
  }

  const stdin = await readStdin()
  const mode = resolveMode(stdin)

  if (mode === 'hang') {
    await hang()
    // Reached only if the watchdog never fired (HANG_MS elapsed): behave like a
    // clean-but-silent exit so the runner still records a non-envelope failure.
    process.exit(0)
  }

  const { stdout, stderr, exitCode } = computeOutcome(mode, stdin, sessionId(stdin))
  if (stderr !== '') writeErr(stderr)
  if (stdout !== '') writeOut(stdout)
  process.exit(exitCode)
}

main().catch((err) => {
  writeErr(`[fake-runner] internal error: ${err && err.stack ? err.stack : String(err)}\n`)
  process.exit(70)
})
