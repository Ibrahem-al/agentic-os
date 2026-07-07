/**
 * Runner agent mode end-to-end over the FAKE `claude -p` (phase 19;
 * §3.2/§10.5/P0.3/P0.4). Drives the REAL spawn stack (spawnClaude watchdog +
 * process-tree kill + `runner_runs` recording) against tests/fixtures/
 * fake-runner.mjs, whose phase-19 agent mode CONNECTS BACK to the loopback MCP
 * server named in `--mcp-config`, expands `${AGENTIC_OS_RUNNER_TOKEN}` from its
 * env, and drives `submit_extraction_items`. A minimal node:http MCP stand-in
 * plays the loopback server so the connect-back is exercised without the whole
 * app; a node:net stall server proves the watchdog. Offline + hermetic. Pins:
 *   - the spawned argv is the agent shape (strict single server + the 3 tools +
 *     the forced `--session-id`), and the config is written then DELETED;
 *   - the connect-back carries `Authorization: Bearer <realToken>` (EXPANDED
 *     from the child env — the literal `${…}` never left disk, §10.5/P0.3) and
 *     the `X-Agentic-Os-Runner-Task: <taskId>` binding header;
 *   - the child submits and the run records a clean `mode='agent'` row;
 *   - the watchdog kills a hung agent and the config is still cleaned up;
 *   - `Runner.runAgentMode` wires binary + userDataDir + model, and refuses
 *     (rejects) rather than spawning blind when userDataDir is unset.
 */
import { spawn as nodeSpawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createServer as createHttpServer } from 'node:http'
import { createServer as createNetServer, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { RUNNER_TOKEN_ENV } from '../../src/main/config'
import { CallBudget, defaultModelSettings, defaultRunnerSettings, type ModelSettings } from '../../src/main/models'
import {
  resetRunnerLanesForTests,
  resolveClaudeBinary,
  runAgentMode,
  runnerMcpConfigPath,
  Runner,
  RUNNER_AGENT_ALLOWED_TOOLS,
  RUNNER_BINARY_ENV,
  RUNNER_DISALLOWED_TOOLS,
  type ResolvedBinary,
  type SpawnImpl
} from '../../src/main/runner'
import { openAppData, type AppData } from '../../src/main/storage'
import { createTelemetry, type Telemetry } from '../../src/main/telemetry'

const FAKE = fileURLToPath(new URL('../fixtures/fake-runner.mjs', import.meta.url))
const TOKEN = 'runner-secret-TESTONLY-do-not-write-to-disk'

interface RunnerRow {
  id: string
  task_id: string
  mode: string
  model: string | null
  is_error: number | null
  error: string | null
}

interface SpawnCapture {
  args: string[]
  env: NodeJS.ProcessEnv | undefined
  /** The .mcp.json text AT SPAWN TIME (before the post-run delete). */
  configText: string | null
}

/** One request the fake made to the loopback MCP stand-in. */
interface McpRequest {
  method: string
  authorization: string | undefined
  taskHeader: string | undefined
}

interface FakeMcp {
  url: string
  requests: McpRequest[]
  close: () => Promise<void>
}

let dir: string
let appData: AppData
let telemetry: Telemetry
let settings: ModelSettings
const cleanups: Array<() => Promise<void>> = []
const victimPids: number[] = []

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'agentic-os-agent-'))
  appData = openAppData(join(dir, 'appdata.db'))
  telemetry = createTelemetry(appData.db)
  settings = {
    ...defaultModelSettings(),
    reasoning: { backend: 'subscription-claude' },
    runner: { ...defaultRunnerSettings(), enabled: true, mode: 'agent' }
  }
  resetRunnerLanesForTests()
})

afterEach(async () => {
  for (const close of cleanups.splice(0)) await close().catch(() => undefined)
  for (const pid of victimPids.splice(0)) {
    try {
      process.kill(process.platform !== 'win32' ? -pid : pid, 'SIGKILL')
    } catch {
      /* gone */
    }
  }
  await telemetry.shutdown()
  appData.close()
  rmSync(dir, { recursive: true, force: true })
})

// ── loopback MCP stand-in (just enough for the fake's initialize→call flow) ───

function startFakeMcp(): Promise<FakeMcp> {
  const requests: McpRequest[] = []
  const server = createHttpServer((req, res) => {
    let raw = ''
    req.setEncoding('utf8')
    req.on('data', (c) => (raw += c))
    req.on('end', () => {
      let body: { id?: number; method?: string } = {}
      try {
        body = JSON.parse(raw) as { id?: number; method?: string }
      } catch {
        /* notifications may be empty-ish */
      }
      const method = body.method ?? ''
      requests.push({
        method,
        authorization: typeof req.headers['authorization'] === 'string' ? req.headers['authorization'] : undefined,
        taskHeader:
          typeof req.headers['x-agentic-os-runner-task'] === 'string' ? req.headers['x-agentic-os-runner-task'] : undefined
      })
      if (method === 'initialize') {
        res.writeHead(200, { 'Content-Type': 'application/json', 'mcp-session-id': 'fake-mcp-session-1' })
        res.end(
          JSON.stringify({
            jsonrpc: '2.0',
            id: body.id,
            result: { protocolVersion: '2025-06-18', capabilities: {}, serverInfo: { name: 'fake-mcp', version: '1' } }
          })
        )
      } else if (method === 'notifications/initialized') {
        res.writeHead(202)
        res.end()
      } else if (method === 'tools/call') {
        const reply = JSON.stringify({ staged: true, submitted: 1, inserted: 1, boundToRunnerTask: true })
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: { content: [{ type: 'text', text: reply }], isError: false } }))
      } else {
        res.writeHead(400)
        res.end()
      }
    })
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address()
      const port = typeof addr === 'object' && addr !== null ? addr.port : 0
      const fake: FakeMcp = {
        url: `http://127.0.0.1:${port}/mcp`,
        requests,
        close: () => new Promise((r) => server.close(() => r()))
      }
      cleanups.push(fake.close)
      resolve(fake)
    })
  })
}

/** A TCP server that accepts then never answers — the fake's HTTP call hangs. */
function startStallServer(): Promise<string> {
  const sockets = new Set<Socket>()
  const server = createNetServer((socket) => {
    sockets.add(socket)
    socket.on('error', () => undefined)
    socket.on('close', () => sockets.delete(socket))
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address()
      const port = typeof addr === 'object' && addr !== null ? addr.port : 0
      cleanups.push(
        () =>
          new Promise((r) => {
            for (const s of sockets) s.destroy()
            server.close(() => r())
          })
      )
      resolve(`http://127.0.0.1:${port}/mcp`)
    })
  })
}

// ── other helpers ──────────────────────────────────────────────────────────────

function fakeInvocation(): ResolvedBinary {
  const inv = resolveClaudeBinary({ env: { ...process.env, [RUNNER_BINARY_ENV]: FAKE } })
  if (inv === null) throw new Error('fake runner did not resolve')
  return inv
}

/** A spawnImpl that records argv/env/config-at-spawn, then really spawns the fake. */
function recordingSpawn(captures: SpawnCapture[]): SpawnImpl {
  return (command, args, options) => {
    const at = args.indexOf('--mcp-config')
    const cfgPath = at >= 0 ? args[at + 1] : undefined
    let configText: string | null = null
    if (typeof cfgPath === 'string') {
      try {
        configText = readFileSync(cfgPath, 'utf8')
      } catch {
        configText = null
      }
    }
    captures.push({ args: [...args], env: options.env, configText })
    return nodeSpawn(command, [...args], { ...options, stdio: 'pipe' })
  }
}

function valueAfter(argv: readonly string[], flag: string): string | undefined {
  const i = argv.indexOf(flag)
  return i >= 0 ? argv[i + 1] : undefined
}

function rowById(id: string): RunnerRow {
  return appData.db.prepare('SELECT * FROM runner_runs WHERE id = ?').get(id) as RunnerRow
}

async function waitUntilDead(pid: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    try {
      process.kill(pid, 0)
    } catch {
      return
    }
    if (Date.now() > deadline) throw new Error(`pid ${pid} still alive after ${timeoutMs}ms`)
    await new Promise((resolve) => setTimeout(resolve, 40))
  }
}

// ── runAgentMode (the free function over the real spawn stack) ─────────────────

describe('runAgentMode — spawn shape, token hygiene, connect-back, cleanup', () => {
  it('spawns the agent argv, connects back with the EXPANDED token + task header, submits, cleans up', async () => {
    const mcp = await startFakeMcp()
    const captures: SpawnCapture[] = []
    const res = await runAgentMode({
      taskId: 'extract-sess-1',
      brief: 'Extract from session sess-1 and submit via submit_extraction_items.',
      runnerToken: TOKEN,
      userDataDir: dir,
      invocation: fakeInvocation(),
      db: appData.db,
      telemetry,
      sessionId: 'child-uuid-A',
      model: 'sonnet',
      mcpUrl: mcp.url,
      spawnImpl: recordingSpawn(captures),
      runId: 'agent-1'
    })

    // We return OUR forced session id (P0.5), and the child submitted cleanly.
    expect(res.claudeSessionId).toBe('child-uuid-A')
    expect(res.result.timedOut).toBe(false)
    expect(res.envelope?.isError).toBe(false)
    const reply = JSON.parse(res.envelope!.result) as { ok: boolean; tool: string }
    expect(reply.ok).toBe(true)
    expect(reply.tool).toBe('submit_extraction_items')

    // The argv reached the process (args = [scriptPath, ...agentArgv]).
    const argv = captures[0]!.args
    expect(argv).toContain('--strict-mcp-config')
    expect(valueAfter(argv, '--mcp-config')).toBe(res.configPath)
    expect(valueAfter(argv, '--mcp-config')).toBe(runnerMcpConfigPath(dir, 'extract-sess-1'))
    expect(valueAfter(argv, '--allowedTools')).toBe(RUNNER_AGENT_ALLOWED_TOOLS)
    expect(valueAfter(argv, '--disallowedTools')).toBe(RUNNER_DISALLOWED_TOOLS)
    expect(valueAfter(argv, '--session-id')).toBe('child-uuid-A')

    // §10.5/P0.3: the REAL token rode the child ENV and the HTTP request; the
    // on-disk config held ONLY the literal reference.
    expect(captures[0]!.env?.[RUNNER_TOKEN_ENV]).toBe(TOKEN)
    expect(captures[0]!.configText).toContain('${AGENTIC_OS_RUNNER_TOKEN}')
    expect(captures[0]!.configText).not.toContain(TOKEN)
    const initReq = mcp.requests.find((r) => r.method === 'initialize')
    expect(initReq?.authorization).toBe(`Bearer ${TOKEN}`) // expanded from env, NOT the literal
    expect(initReq?.taskHeader).toBe('extract-sess-1') // the binding header
    expect(mcp.requests.some((r) => r.method === 'tools/call')).toBe(true)

    // The config is deleted after the run; the row is a clean agent-mode run.
    expect(existsSync(res.configPath)).toBe(false)
    const row = rowById('agent-1')
    expect(row.mode).toBe('agent')
    expect(row.model).toBe('sonnet')
    expect(row.is_error).toBe(0)
  }, 20_000)

  it('the watchdog kills a hung agent and still deletes the config', async () => {
    const stallUrl = await startStallServer()
    const res = await runAgentMode({
      taskId: 'extract-hang',
      brief: 'FAKE_RUNNER_HANG',
      runnerToken: TOKEN,
      userDataDir: dir,
      invocation: fakeInvocation(),
      db: appData.db,
      telemetry,
      sessionId: 'child-uuid-H',
      mcpUrl: stallUrl, // accepts the TCP connection but never answers → the fake hangs
      timeoutMs: 1500,
      runId: 'agent-hang'
    })

    expect(res.result.timedOut).toBe(true)
    expect(res.envelope).toBeNull()
    expect(existsSync(res.configPath)).toBe(false) // finally-cleanup ran

    const row = rowById('agent-hang')
    expect(row.is_error).toBe(1)
    expect(row.error).toMatch(/timeout/i)
    if (typeof res.result.record.pid === 'number') {
      victimPids.push(res.result.record.pid)
      await waitUntilDead(res.result.record.pid, 6000) // the tree kill landed
    }
  }, 15_000)
})

// ── Runner.runAgentMode (the facade wiring) ───────────────────────────────────

describe('Runner.runAgentMode — facade resolves binary + userDataDir + model', () => {
  function makeRunner(userDataDir?: string): Runner {
    return new Runner({
      db: appData.db,
      loadSettings: () => settings,
      telemetry,
      callBudget: new CallBudget({ db: appData.db }),
      env: { ...process.env, [RUNNER_BINARY_ENV]: FAKE },
      ...(userDataDir !== undefined ? { userDataDir } : {}),
      probeVersion: async () => '2.0.0',
      npmBinDir: async () => null
    })
  }

  it('writes the config under <userData>/runner, connects back, returns + cleans up', async () => {
    const mcp = await startFakeMcp()
    const runner = makeRunner(dir)
    await runner.refreshHealth()
    expect(runner.isHealthy()).toBe(true)

    const res = await runner.runAgentMode({
      taskId: 'extract-sess-facade',
      brief: 'Extract and submit.',
      runnerToken: TOKEN,
      sessionId: 'facade-uuid',
      mcpUrl: mcp.url
    })
    expect(res.claudeSessionId).toBe('facade-uuid')
    expect(res.envelope?.isError).toBe(false)
    expect(res.configPath).toBe(runnerMcpConfigPath(dir, 'extract-sess-facade'))
    expect(existsSync(res.configPath)).toBe(false)
    expect(mcp.requests.find((r) => r.method === 'initialize')?.authorization).toBe(`Bearer ${TOKEN}`)

    const row = appData.db.prepare('SELECT * FROM runner_runs WHERE task_id = ?').get('extract-sess-facade') as RunnerRow
    expect(row.mode).toBe('agent')
    expect(row.model).toBe('sonnet') // resolved from settings.runner.model
    expect(row.is_error).toBe(0)
  }, 20_000)

  it('rejects (never spawns blind) when userDataDir is not configured', async () => {
    const runner = makeRunner(undefined)
    await expect(runner.runAgentMode({ taskId: 't', brief: 'x', runnerToken: TOKEN })).rejects.toThrow(/userDataDir/)
  }, 15_000)
})
