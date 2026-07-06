/**
 * Per-task runner `.mcp.json` (phase 19; §10.5/P0.3).
 *
 * Agent mode spawns a headless `claude -p` that CONNECTS BACK to the loopback
 * MCP server with the runner token. Claude Code reads its server list from a
 * `--mcp-config <file>`; this module writes that file, one per spawned task, to
 * `<userData>/runner/<taskId>.mcp.json` and removes it after the run
 * (`deleteRunnerMcpConfig`). A crash that strands one is cleaned by the boot
 * sweep in `index.ts` (it deletes every `<userData>/runner/*.mcp.json`).
 *
 * TOKEN HYGIENE (§10.5/P0.3 — the load-bearing invariant): the Authorization
 * header value on disk is the LITERAL string `${AGENTIC_OS_RUNNER_TOKEN}`, never
 * the real token. Claude Code expands `${VAR}` references in `.mcp.json` from the
 * CHILD process's environment at connect time, and `agent.ts` passes the real
 * token only in that env. So the secret never touches disk (rule 7), yet the
 * child still authenticates as a runner session (14b dual-auth + the
 * `X-Agentic-Os-Runner-Task` binding header).
 *
 * The header carries the RAW `taskId` — `submit_extraction_items` keys its
 * `runner_submissions` rows to the bound task id, and the delegate loads them
 * back with `WHERE task_id = ?` (18), so it must be byte-identical. The on-disk
 * FILENAME is cosmetic (it round-trips through the returned path and the
 * boot-sweep globs `*.mcp.json`), so it is sanitized to stay valid on every
 * platform (win32 forbids `:` `/` etc. in names) without ever altering the id
 * the server binds on.
 */
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { MCP_SERVER_NAME, MCP_URL, RUNNER_TASK_HEADER, RUNNER_TOKEN_ENV } from '../config'

/**
 * The literal env-var reference Claude Code expands from the child's env — this
 * exact text is what lands on disk in place of the token (§10.5/P0.3). Built so
 * it is `${AGENTIC_OS_RUNNER_TOKEN}` even though `RUNNER_TOKEN_ENV` is a const.
 */
export const RUNNER_TOKEN_ENV_REF = `\${${RUNNER_TOKEN_ENV}}`

/** The `.mcp.json` shape Claude Code consumes (Streamable-HTTP server entry). */
export interface RunnerMcpConfig {
  readonly mcpServers: {
    readonly [name: string]: {
      readonly type: 'http'
      readonly url: string
      readonly headers: Readonly<Record<string, string>>
    }
  }
}

/** The directory holding per-task runner configs (boot-swept in `index.ts`). */
export function runnerConfigDir(userDataDir: string): string {
  return join(userDataDir, 'runner')
}

/** Filesystem-safe basename for a task id (the binding header keeps the raw id). */
function safeSegment(taskId: string): string {
  const cleaned = taskId.replace(/[^A-Za-z0-9._-]/g, '_')
  return cleaned === '' ? 'task' : cleaned
}

/** Absolute path of a task's `.mcp.json` under `<userData>/runner/`. */
export function runnerMcpConfigPath(userDataDir: string, taskId: string): string {
  return join(runnerConfigDir(userDataDir), `${safeSegment(taskId)}.mcp.json`)
}

/**
 * The config object for `taskId`. `url` defaults to the loopback MCP URL; a
 * caller (e.g. an agent-mode test against a fake loopback server) may override
 * it. The token is the LITERAL `${AGENTIC_OS_RUNNER_TOKEN}` — never a real one.
 */
export function runnerMcpConfigObject(taskId: string, url: string = MCP_URL): RunnerMcpConfig {
  return {
    mcpServers: {
      [MCP_SERVER_NAME]: {
        type: 'http',
        url,
        headers: {
          Authorization: `Bearer ${RUNNER_TOKEN_ENV_REF}`,
          [RUNNER_TASK_HEADER]: taskId
        }
      }
    }
  }
}

/**
 * Write `<userData>/runner/<taskId>.mcp.json` (creating the dir) and return its
 * absolute path. The token is the literal env-var reference (§10.5/P0.3) — the
 * REAL token is passed only in the spawned child's env by `agent.ts`.
 */
export function writeRunnerMcpConfig(userDataDir: string, taskId: string, url: string = MCP_URL): string {
  const path = runnerMcpConfigPath(userDataDir, taskId)
  mkdirSync(runnerConfigDir(userDataDir), { recursive: true })
  writeFileSync(path, `${JSON.stringify(runnerMcpConfigObject(taskId, url), null, 2)}\n`, 'utf8')
  return path
}

/** Remove a per-task config after the run. Best-effort — the boot-sweep backstops it. */
export function deleteRunnerMcpConfig(path: string): void {
  try {
    rmSync(path, { force: true })
  } catch {
    /* already gone / unlink race — the boot-sweep cleans any stray */
  }
}
