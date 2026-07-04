/**
 * Connection helper (§12): the exact `claude mcp add` command and the sample
 * .mcp.json — placeholder token by default (§21 rule 7: no secrets on disk).
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { MCP_URL } from '../../src/main/config'
import { claudeMcpAddCommand, MCP_TOKEN_PLACEHOLDER, sampleMcpJson, writeSampleMcpJson } from '../../src/main/mcp'

describe('connection helper', () => {
  let dir: string | undefined
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true })
    dir = undefined
  })

  it('prints the exact §12 claude mcp add command', () => {
    expect(claudeMcpAddCommand('SECRET')).toBe(
      'claude mcp add --transport http agentic-os http://127.0.0.1:4517/mcp --header "Authorization: Bearer SECRET"'
    )
    // Default: placeholder, never a real secret.
    expect(claudeMcpAddCommand()).toContain(`Bearer ${MCP_TOKEN_PLACEHOLDER}`)
  })

  it('renders a valid sample .mcp.json with the placeholder token', () => {
    const parsed = JSON.parse(sampleMcpJson()) as {
      mcpServers: Record<string, { type: string; url: string; headers: Record<string, string> }>
    }
    const entry = parsed.mcpServers['agentic-os']
    expect(entry).toBeDefined()
    expect(entry?.type).toBe('http')
    expect(entry?.url).toBe(MCP_URL)
    expect(entry?.headers['Authorization']).toBe(`Bearer ${MCP_TOKEN_PLACEHOLDER}`)
  })

  it('writes the sample file (placeholder by default, real token only when passed)', () => {
    dir = mkdtempSync(join(tmpdir(), 'mcp-conn-'))
    const samplePath = join(dir, 'nested', '.mcp.json')
    writeSampleMcpJson(samplePath)
    expect(readFileSync(samplePath, 'utf8')).toContain(MCP_TOKEN_PLACEHOLDER)
    writeSampleMcpJson(samplePath, { token: 'REAL', url: 'http://127.0.0.1:9999/mcp' })
    const raw = readFileSync(samplePath, 'utf8')
    expect(raw).toContain('Bearer REAL')
    expect(raw).toContain('http://127.0.0.1:9999/mcp')
  })
})
