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
 * ── AGENT MODE (phase-19; connect back to the loopback MCP server) ───────────
 * Triggered when AGENTIC_OS_FAKE_RUNNER_MODE=agent OR argv contains `--mcp-config`
 * (the real agent-mode spawn always passes it). The fake then behaves like the real
 * `claude -p … --mcp-config <path>` agent child: it CONNECTS BACK to the loopback
 * MCP server named in the config and drives ONE tool call, then prints the SAME
 * `--output-format json` completion envelope so spawnClaude records a clean
 * runner_runs row. The completion-mode branch above is left completely untouched.
 *
 * Flow (node:http only): read `--mcp-config <path>` → parse the .mcp.json → pick the
 * first mcpServers entry with a `url` (prefers the 'agentic-os' key) → expand every
 * `${VAR}` in the header values from process.env (so `${AGENTIC_OS_RUNNER_TOKEN}` →
 * the token that is passed ONLY in the child's env, never plaintext on disk) → speak
 * MCP Streamable HTTP with those headers (Authorization + X-Agentic-Os-Runner-Task):
 *   1. POST `initialize` (Accept: application/json, text/event-stream) → capture the
 *      `mcp-session-id` response header + the negotiated protocolVersion;
 *   2. POST the `notifications/initialized` notification (→ 202, like a real client);
 *   3. POST `tools/call` for submit_extraction_items with a scripted `arguments`
 *      payload → parse the SSE `data:` response frame.
 * A completed round-trip prints an is_error=false envelope + exit 0 (a tool-level
 * isError is DATA — the CLI still ran; it rides inside the envelope `result`). A
 * transport failure (no config / bad url / non-200 / missing session id) prints an
 * is_error=true envelope + exit 1 so the runner records the failure.
 *
 *   agent-mode env knobs (all optional):
 *   AGENTIC_OS_FAKE_RUNNER_MODE=agent           force agent mode (else `--mcp-config` triggers it)
 *   AGENTIC_OS_FAKE_RUNNER_TOOL                  tool to call (default submit_extraction_items)
 *   AGENTIC_OS_FAKE_RUNNER_TOOL_ARGS_JSON        full JSON `arguments` for the tool (overrides the builders below)
 *   AGENTIC_OS_FAKE_RUNNER_SUBMIT_SESSION_ID     submit_extraction_items.session_id (default 'fake-agent-session')
 *   AGENTIC_OS_FAKE_RUNNER_COMPONENTS            JSON array of component submissions
 *   AGENTIC_OS_FAKE_RUNNER_PREFERENCES           JSON array of preference submissions
 *   AGENTIC_OS_FAKE_RUNNER_CORRECTIONS           JSON array of correction submissions
 *       (none of the three given → one default component so the batch is never empty,
 *        which submit_extraction_items rejects)
 *   AGENTIC_OS_FAKE_RUNNER_MCP_TIMEOUT_MS        per-HTTP-request timeout ms (default 20000)
 * The envelope session_id = the `--session-id <uuid>` argv value when present (the
 * P0.5 pre-assigned id), else the AGENTIC_OS_FAKE_RUNNER_SESSION_ID / sha256(stdin)
 * default. All other envelope knobs (tokens/cost/…) apply exactly as in completion mode.
 *
 * Node built-ins only. stdout/stderr are written with fs.writeSync so a fast
 * process.exit() never drops piped output on linux (phase-13 lesson).
 */
import { Buffer } from 'node:buffer'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync, writeSync } from 'node:fs'
import { request as httpRequest } from 'node:http'
import process from 'node:process'
import { setTimeout } from 'node:timers'
import { URL } from 'node:url'

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

// ── Agent mode (phase-19: connect back to the loopback MCP + submit) ──────────

/** JSON-RPC ids for the two request round-trips (the notification carries none). */
const AGENT_INIT_ID = 1
const AGENT_TOOL_ID = 2

/** Agent mode iff the env forces it OR the real agent-mode `--mcp-config` is present. */
function isAgentMode(args) {
  if ((ENV.AGENTIC_OS_FAKE_RUNNER_MODE ?? '').trim() === 'agent') return true
  return args.includes('--mcp-config')
}

/** Value after `--flag` (or `--flag=value`); null when the flag is absent. */
function argValue(args, flag) {
  const at = args.indexOf(flag)
  if (at !== -1 && at + 1 < args.length) return args[at + 1]
  const eq = args.find((a) => a.startsWith(`${flag}=`))
  return eq !== undefined ? eq.slice(flag.length + 1) : null
}

function errMessage(err) {
  return err && err.message ? err.message : String(err)
}

function firstLine(text) {
  return String(text).split(/\r?\n/, 1)[0].slice(0, 200)
}

function firstNonEmpty(...values) {
  for (const v of values) {
    if (typeof v === 'string' && v.trim() !== '') return v.trim()
  }
  return ''
}

/** Expand every `${VAR}` in a header value from process.env (the token never on disk). */
function expandEnvVars(value) {
  return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_, name) => ENV[name] ?? '')
}

function expandHeaders(headers) {
  const out = {}
  for (const [k, v] of Object.entries(headers ?? {})) out[k] = typeof v === 'string' ? expandEnvVars(v) : v
  return out
}

/** The first mcpServers entry carrying a url (prefers the 'agentic-os' key). */
function firstMcpServer(config) {
  const servers = config !== null && typeof config === 'object' ? config.mcpServers : null
  if (servers === null || typeof servers !== 'object') return null
  const preferred = servers['agentic-os']
  if (preferred && typeof preferred === 'object' && typeof preferred.url === 'string') return preferred
  for (const entry of Object.values(servers)) {
    if (entry && typeof entry === 'object' && typeof entry.url === 'string') return entry
  }
  return null
}

/** One POST to the MCP endpoint over node:http. Resolves { status, headers, bodyText }. */
function postMcp({ url, headers, body, sessionId: mcpSessionId, protocolVersion, timeoutMs }) {
  return new Promise((resolve, reject) => {
    const u = new URL(url)
    const payload = JSON.stringify(body)
    const reqHeaders = {
      ...headers, // Authorization + X-Agentic-Os-Runner-Task (env-expanded), auth'd every request
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream', // Streamable HTTP requires BOTH or 406
      'Content-Length': Buffer.byteLength(payload),
      ...(mcpSessionId !== undefined ? { 'mcp-session-id': mcpSessionId } : {}),
      ...(protocolVersion !== undefined && protocolVersion !== '' ? { 'mcp-protocol-version': protocolVersion } : {})
    }
    const req = httpRequest(
      { hostname: u.hostname, port: u.port, path: u.pathname + u.search, method: 'POST', headers: reqHeaders },
      (res) => {
        let text = ''
        res.setEncoding('utf8')
        res.on('data', (chunk) => {
          text += chunk
        })
        res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, bodyText: text }))
      }
    )
    req.on('error', reject)
    req.setTimeout(timeoutMs, () => req.destroy(new Error(`mcp request timed out after ${timeoutMs}ms`)))
    req.write(payload)
    req.end()
  })
}

/** The transport answers over SSE (no enableJsonResponse) — pull the `data:` frames. */
function parseRpcMessages(headers, bodyText) {
  const contentType = String(headers['content-type'] ?? '')
  const messages = []
  const push = (raw) => {
    try {
      const parsed = JSON.parse(raw)
      if (Array.isArray(parsed)) messages.push(...parsed)
      else messages.push(parsed)
    } catch {
      /* ignore a non-JSON frame */
    }
  }
  if (contentType.includes('text/event-stream')) {
    for (const block of bodyText.split(/\n\n/)) {
      const data = block
        .split(/\r?\n/)
        .filter((l) => l.startsWith('data:'))
        .map((l) => l.slice('data:'.length).replace(/^ /, ''))
        .join('\n')
      if (data !== '') push(data)
    }
  } else if (bodyText.trim() !== '') {
    push(bodyText.trim())
  }
  return messages
}

function firstHeaderValue(value) {
  if (Array.isArray(value)) return value[0]
  return typeof value === 'string' ? value : undefined
}

function parseJsonArrayEnv(name) {
  const raw = ENV[name]
  if (raw === undefined || raw.trim() === '') return null
  try {
    const value = JSON.parse(raw)
    return Array.isArray(value) ? value : null
  } catch (err) {
    writeErr(`[fake-runner] bad ${name} (expected a JSON array): ${errMessage(err)}\n`)
    return null
  }
}

/** The `arguments` object the child submits — full override, else per-tool builders. */
function agentToolArgs(toolName) {
  const override = ENV.AGENTIC_OS_FAKE_RUNNER_TOOL_ARGS_JSON
  if (override !== undefined && override.trim() !== '') {
    try {
      return JSON.parse(override)
    } catch (err) {
      writeErr(`[fake-runner] bad AGENTIC_OS_FAKE_RUNNER_TOOL_ARGS_JSON: ${errMessage(err)}\n`)
    }
  }
  if (toolName !== 'submit_extraction_items') return {}
  const args = { session_id: firstNonEmpty(ENV.AGENTIC_OS_FAKE_RUNNER_SUBMIT_SESSION_ID, 'fake-agent-session') }
  const components = parseJsonArrayEnv('AGENTIC_OS_FAKE_RUNNER_COMPONENTS')
  const preferences = parseJsonArrayEnv('AGENTIC_OS_FAKE_RUNNER_PREFERENCES')
  const corrections = parseJsonArrayEnv('AGENTIC_OS_FAKE_RUNNER_CORRECTIONS')
  if (components !== null) args.components = components
  if (preferences !== null) args.preferences = preferences
  if (corrections !== null) args.corrections = corrections
  // submit_extraction_items rejects an empty batch — default to one valid component.
  if (components === null && preferences === null && corrections === null) {
    args.components = [
      { name: 'FakeAgentComponent', type: 'component', evidence: 'submitted by the fake agent runner', confidence: 0.5 }
    ]
  }
  return args
}

/** The envelope session_id = the pre-assigned `--session-id` (P0.5) when present. */
function agentSessionId(args, brief) {
  const fromArg = argValue(args, '--session-id')
  if (fromArg !== null && fromArg.trim() !== '') return fromArg.trim()
  return sessionId(brief)
}

/** Build the completion-envelope outcome ({ stdout, stderr, exitCode }) for agent mode. */
function agentOutcome(sid, brief, { isError, result, stderr, exitCode }) {
  return { stdout: line(fullEnvelope(sid, isError, result, brief)), stderr, exitCode }
}

/**
 * Connect back to the loopback MCP server named in `--mcp-config` and drive one
 * tool call, then return the SAME completion-envelope outcome completion mode
 * emits (so spawnClaude parses it into a clean runner_runs row). node:http only.
 */
async function runAgentMode(args) {
  const brief = await readStdin() // drain the brief so the parent's stdin.end() never blocks
  const sid = agentSessionId(args, brief)
  const timeoutMs = envInt('AGENTIC_OS_FAKE_RUNNER_MCP_TIMEOUT_MS', 20_000)
  const fail = (detail) =>
    agentOutcome(sid, brief, {
      isError: true,
      result: `agent-mode error: ${detail}`,
      stderr: `[fake-runner] agent mode failed: ${detail}\n`,
      exitCode: 1
    })

  const configPath = argValue(args, '--mcp-config')
  if (configPath === null) return fail('agent mode requires --mcp-config <path>')

  let config
  try {
    config = JSON.parse(readFileSync(configPath, 'utf8'))
  } catch (err) {
    return fail(`cannot read --mcp-config ${configPath}: ${errMessage(err)}`)
  }

  const server = firstMcpServer(config)
  if (server === null || typeof server.url !== 'string' || server.url === '') {
    return fail('the --mcp-config file has no mcpServers entry with a url')
  }
  const url = server.url
  const headers = expandHeaders(server.headers)

  // 1. initialize — capture the mcp-session-id header + the negotiated version.
  let initRes
  try {
    initRes = await postMcp({
      url,
      headers,
      timeoutMs,
      body: {
        jsonrpc: '2.0',
        id: AGENT_INIT_ID,
        method: 'initialize',
        params: {
          protocolVersion: '2025-06-18',
          capabilities: {},
          clientInfo: { name: 'fake-agent-runner', version: resolveVersion() }
        }
      }
    })
  } catch (err) {
    return fail(`initialize transport error: ${errMessage(err)}`)
  }
  if (initRes.status !== 200) return fail(`initialize HTTP ${initRes.status}: ${firstLine(initRes.bodyText)}`)
  const mcpSessionId = firstHeaderValue(initRes.headers['mcp-session-id'])
  if (mcpSessionId === undefined || mcpSessionId === '') return fail('initialize returned no mcp-session-id header')
  const initMsg = parseRpcMessages(initRes.headers, initRes.bodyText).find((m) => m && m.id === AGENT_INIT_ID)
  const protocolVersion = initMsg && initMsg.result ? initMsg.result.protocolVersion : undefined

  // 2. notifications/initialized (→ 202). A real MCP client always sends this.
  try {
    await postMcp({
      url,
      headers,
      timeoutMs,
      sessionId: mcpSessionId,
      protocolVersion,
      body: { jsonrpc: '2.0', method: 'notifications/initialized' }
    })
  } catch (err) {
    return fail(`initialized notification error: ${errMessage(err)}`)
  }

  // 3. tools/call — the whole point: submit extracted items over the runner session.
  const toolName = firstNonEmpty(ENV.AGENTIC_OS_FAKE_RUNNER_TOOL, 'submit_extraction_items')
  const toolArgs = agentToolArgs(toolName)
  let callRes
  try {
    callRes = await postMcp({
      url,
      headers,
      timeoutMs,
      sessionId: mcpSessionId,
      protocolVersion,
      body: { jsonrpc: '2.0', id: AGENT_TOOL_ID, method: 'tools/call', params: { name: toolName, arguments: toolArgs } }
    })
  } catch (err) {
    return fail(`tools/call transport error: ${errMessage(err)}`)
  }
  if (callRes.status !== 200) return fail(`tools/call HTTP ${callRes.status}: ${firstLine(callRes.bodyText)}`)
  const callMsg = parseRpcMessages(callRes.headers, callRes.bodyText).find((m) => m && m.id === AGENT_TOOL_ID)
  if (callMsg === undefined) return fail('tools/call returned no JSON-RPC response')
  if (callMsg.error) return fail(`tools/call JSON-RPC error ${callMsg.error.code}: ${callMsg.error.message ?? ''}`)

  // The CallToolResult `text` is the tool's JSON reply (or a structured tool error).
  const toolResult = callMsg.result ?? {}
  const toolText = Array.isArray(toolResult.content) ? toolResult.content[0]?.text ?? '' : ''
  let toolReply
  try {
    toolReply = JSON.parse(toolText)
  } catch {
    toolReply = toolText
  }

  // A tool-level isError is DATA (the CLI ran fine); it rides inside the envelope result.
  const result = JSON.stringify({
    ok: true,
    tool: toolName,
    mcpSessionId,
    toolIsError: toolResult.isError === true,
    reply: toolReply
  })
  return agentOutcome(sid, brief, {
    isError: false,
    result,
    stderr: `[fake-runner] agent mode: called ${toolName} on ${url} (mcp-session ${mcpSessionId})\n`,
    exitCode: 0
  })
}

// ── Entry ─────────────────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2)

  if (args.includes('--version')) {
    writeOut(resolveVersion() + '\n')
    process.exit(0)
  }

  // Phase-19 agent mode connects back to the loopback MCP server and submits; the
  // completion-mode path below is left exactly as the phase 17/18 tests depend on it.
  if (isAgentMode(args)) {
    const { stdout, stderr, exitCode } = await runAgentMode(args)
    if (stderr !== '') writeErr(stderr)
    if (stdout !== '') writeOut(stdout)
    process.exit(exitCode)
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
