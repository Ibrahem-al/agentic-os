/**
 * Connection helper (§12): the exact `claude mcp add` command and a sample
 * `.mcp.json` for connecting Claude Code (or any Streamable-HTTP MCP client)
 * to the OS.
 *
 * Secret handling (§21 rule 7 — never plaintext on disk, never in logs): the
 * default token placeholder is `<token>`; boot prints the redacted command
 * and writes the sample .mcp.json with the placeholder. The REAL token is
 * shown only where the user explicitly asks for it (dashboard, phase 10; or
 * the AGENTIC_OS_PRINT_MCP_TOKEN=1 dev flag handled in index.ts).
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { MCP_SERVER_NAME, MCP_URL } from '../config'

export const MCP_TOKEN_PLACEHOLDER = '<token>'

/** The exact §12 connection command; pass the real token to make it runnable. */
export function claudeMcpAddCommand(token: string = MCP_TOKEN_PLACEHOLDER, url: string = MCP_URL): string {
  return `claude mcp add --transport http ${MCP_SERVER_NAME} ${url} --header "Authorization: Bearer ${token}"`
}

/** Sample `.mcp.json` (Claude Code project-scope MCP config). */
export function sampleMcpJson(token: string = MCP_TOKEN_PLACEHOLDER, url: string = MCP_URL): string {
  return `${JSON.stringify(
    {
      mcpServers: {
        [MCP_SERVER_NAME]: {
          type: 'http',
          url,
          headers: { Authorization: `Bearer ${token}` }
        }
      }
    },
    null,
    2
  )}\n`
}

/**
 * Write the sample `.mcp.json` (placeholder token unless one is passed —
 * callers passing a real token take rule-7 responsibility for the location).
 */
export function writeSampleMcpJson(
  filePath: string,
  options: { token?: string; url?: string } = {}
): void {
  mkdirSync(dirname(filePath), { recursive: true })
  writeFileSync(filePath, sampleMcpJson(options.token, options.url), 'utf8')
}
