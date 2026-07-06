/**
 * Runner agent mode — the PURE half (phase 19; §3.2/§3.5/§10.5/P0.3). No spawn,
 * no filesystem child: the per-task `.mcp.json` writer + the `--` argv builder +
 * the safety constants, all seam-free. Pins the load-bearing invariants a
 * hijacked child is boxed by:
 *   - the on-disk config carries the LITERAL `${AGENTIC_OS_RUNNER_TOKEN}` (never
 *     a real token, §10.5/P0.3) + the `X-Agentic-Os-Runner-Task` binding header;
 *   - the argv mounts ONLY the OS server (`--strict-mcp-config`), allows EXACTLY
 *     the three READ+STAGING tools, disallows the fs/shell/web/subagent set,
 *     disables all hooks, appends the scope guard, and forces the `--session-id`;
 *   - the binding header keeps the RAW task id even when the FILENAME must be
 *     sanitized for the platform.
 * The real spawn / watchdog / cleanup behaviour is covered in the integration
 * test against the fake runner.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { MCP_SERVER_NAME, MCP_URL, RUNNER_MAX_TURNS_AGENT, RUNNER_TASK_HEADER } from '../../src/main/config'
import {
  buildAgentArgv,
  deleteRunnerMcpConfig,
  runnerConfigDir,
  runnerMcpConfigObject,
  runnerMcpConfigPath,
  writeRunnerMcpConfig,
  RUNNER_AGENT_ALLOWED_TOOLS,
  RUNNER_AGENT_SCOPE_GUARD,
  RUNNER_AGENT_SETTINGS,
  RUNNER_DISALLOWED_TOOLS,
  RUNNER_TOKEN_ENV_REF,
  type RunnerMcpConfig
} from '../../src/main/runner'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'agentic-os-agent-'))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

/** The value of the argv token immediately after `flag` (or undefined). */
function valueAfter(argv: readonly string[], flag: string): string | undefined {
  const i = argv.indexOf(flag)
  return i >= 0 ? argv[i + 1] : undefined
}

function readConfig(path: string): RunnerMcpConfig {
  return JSON.parse(readFileSync(path, 'utf8')) as RunnerMcpConfig
}

// ── mcpConfig.ts — the per-task .mcp.json ─────────────────────────────────────

describe('writeRunnerMcpConfig — token hygiene + binding header (§10.5/P0.3)', () => {
  it('writes <userData>/runner/<taskId>.mcp.json and returns that path', () => {
    const taskId = 'extract-cont-sess-abc123'
    const path = writeRunnerMcpConfig(dir, taskId)
    expect(path).toBe(join(runnerConfigDir(dir), `${taskId}.mcp.json`))
    expect(path).toBe(runnerMcpConfigPath(dir, taskId))
    expect(existsSync(path)).toBe(true)
  })

  it('carries the LITERAL ${AGENTIC_OS_RUNNER_TOKEN} — never a real token on disk', () => {
    const path = writeRunnerMcpConfig(dir, 'extract-sess-1')
    const text = readFileSync(path, 'utf8')
    // The exact env-var reference is present; nothing token-like is expanded.
    expect(RUNNER_TOKEN_ENV_REF).toBe('${AGENTIC_OS_RUNNER_TOKEN}')
    expect(text).toContain('${AGENTIC_OS_RUNNER_TOKEN}')

    const cfg = readConfig(path)
    const server = cfg.mcpServers[MCP_SERVER_NAME]!
    expect(MCP_SERVER_NAME).toBe('agentic-os')
    expect(server.type).toBe('http')
    expect(server.url).toBe(MCP_URL)
    expect(server.headers['Authorization']).toBe('Bearer ${AGENTIC_OS_RUNNER_TOKEN}')
  })

  it('binds the RAW task id in the X-Agentic-Os-Runner-Task header', () => {
    const taskId = 'extract-sess-42'
    const cfg = readConfig(writeRunnerMcpConfig(dir, taskId))
    const server = cfg.mcpServers[MCP_SERVER_NAME]!
    expect(RUNNER_TASK_HEADER).toBe('X-Agentic-Os-Runner-Task')
    expect(server.headers[RUNNER_TASK_HEADER]).toBe(taskId)
  })

  it('honors a url override (agent-mode tests point at a fake loopback server)', () => {
    const url = 'http://127.0.0.1:59999/mcp'
    const cfg = readConfig(writeRunnerMcpConfig(dir, 'extract-sess-1', url))
    expect(cfg.mcpServers[MCP_SERVER_NAME]!.url).toBe(url)
    // runnerMcpConfigObject is the same builder, standalone.
    expect(runnerMcpConfigObject('extract-sess-1', url)).toEqual(cfg)
  })

  it('sanitizes an unsafe task id for the FILENAME but keeps it raw in the header', () => {
    const taskId = 'extract-cont-a/b:c*d' // path-hostile on win32
    const path = writeRunnerMcpConfig(dir, taskId)
    expect(existsSync(path)).toBe(true) // the write succeeded on every platform
    expect(path.endsWith('.mcp.json')).toBe(true)
    // The delegate binds on the RAW id — the header MUST be byte-identical.
    expect(readConfig(path).mcpServers[MCP_SERVER_NAME]!.headers[RUNNER_TASK_HEADER]).toBe(taskId)
  })

  it('deleteRunnerMcpConfig removes the file and is a no-op when already gone', () => {
    const path = writeRunnerMcpConfig(dir, 'extract-sess-1')
    expect(existsSync(path)).toBe(true)
    deleteRunnerMcpConfig(path)
    expect(existsSync(path)).toBe(false)
    expect(() => deleteRunnerMcpConfig(path)).not.toThrow() // idempotent backstop
  })
})

// ── agent.ts — the argv contract (the §3.2 spawn shape) ───────────────────────

describe('buildAgentArgv — the exact `claude -p` agent-mode flags', () => {
  const argv = buildAgentArgv({
    model: 'sonnet',
    configPath: '/u/runner/extract-sess-1.mcp.json',
    maxTurns: RUNNER_MAX_TURNS_AGENT,
    sessionId: 'child-uuid-1'
  })

  it('mounts only the OS server and forces strict + the session id', () => {
    expect(argv).toContain('-p')
    expect(argv).toContain('--strict-mcp-config')
    expect(valueAfter(argv, '--output-format')).toBe('json')
    expect(valueAfter(argv, '--model')).toBe('sonnet')
    expect(valueAfter(argv, '--max-turns')).toBe(String(RUNNER_MAX_TURNS_AGENT))
    expect(valueAfter(argv, '--mcp-config')).toBe('/u/runner/extract-sess-1.mcp.json')
    expect(valueAfter(argv, '--session-id')).toBe('child-uuid-1')
  })

  it('allows EXACTLY the three READ+STAGING tools, prefixed to the OS server', () => {
    expect(valueAfter(argv, '--allowedTools')).toBe(RUNNER_AGENT_ALLOWED_TOOLS)
    expect(RUNNER_AGENT_ALLOWED_TOOLS).toBe(
      'mcp__agentic-os__read_session,mcp__agentic-os__get_pending_work,mcp__agentic-os__submit_extraction_items'
    )
    const tools = RUNNER_AGENT_ALLOWED_TOOLS.split(',')
    expect(tools).toHaveLength(3)
    for (const t of tools) expect(t.startsWith(`mcp__${MCP_SERVER_NAME}__`)).toBe(true)
  })

  it('disallows the fs/shell/web/subagent set (same strip as completion mode)', () => {
    expect(valueAfter(argv, '--disallowedTools')).toBe(RUNNER_DISALLOWED_TOOLS)
    expect(RUNNER_DISALLOWED_TOOLS).toBe('Bash,Edit,Write,NotebookEdit,WebFetch,WebSearch,Task')
  })

  it('disables all hooks and appends the DATA-not-instructions scope guard', () => {
    expect(valueAfter(argv, '--settings')).toBe('{"disableAllHooks":true}')
    expect(RUNNER_AGENT_SETTINGS).toBe('{"disableAllHooks":true}')
    expect(valueAfter(argv, '--append-system-prompt')).toBe(RUNNER_AGENT_SCOPE_GUARD)
    expect(RUNNER_AGENT_SCOPE_GUARD).toContain('DATA')
    expect(RUNNER_AGENT_SCOPE_GUARD).toContain('only output channel is the staging tools')
  })

  it('is the exact ordered argv (full contract)', () => {
    expect(argv).toEqual([
      '-p',
      '--output-format',
      'json',
      '--model',
      'sonnet',
      '--max-turns',
      String(RUNNER_MAX_TURNS_AGENT),
      '--mcp-config',
      '/u/runner/extract-sess-1.mcp.json',
      '--strict-mcp-config',
      '--allowedTools',
      RUNNER_AGENT_ALLOWED_TOOLS,
      '--disallowedTools',
      RUNNER_DISALLOWED_TOOLS,
      '--append-system-prompt',
      RUNNER_AGENT_SCOPE_GUARD,
      '--settings',
      '{"disableAllHooks":true}',
      '--session-id',
      'child-uuid-1'
    ])
  })
})
