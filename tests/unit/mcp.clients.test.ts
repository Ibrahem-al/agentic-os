/**
 * MCP client manager config handling: add/remove/list over the JSON config
 * file, zod validation, atomic persistence, and the rule-7 secret indirection
 * (config names a keychain secret, never a token). Live listTools against a
 * real server is covered in tests/integration/mcp.server.test.ts.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { McpClientManager } from '../../src/main/mcp'

describe('McpClientManager (config file)', () => {
  let dir: string
  let configPath: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'mcp-clients-'))
    configPath = join(dir, 'mcp-servers.json')
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('starts empty when no config file exists (and does not create one)', () => {
    const manager = new McpClientManager({ configPath })
    expect(manager.list()).toEqual([])
    expect(existsSync(configPath)).toBe(false)
  })

  it('adds http and stdio entries and persists them for a fresh manager', () => {
    const manager = new McpClientManager({ configPath })
    manager.add({ name: 'github', transport: 'http', url: 'https://mcp.example.com/mcp', bearerTokenSecret: 'mcp.github' })
    manager.add({ name: 'local-tool', transport: 'stdio', command: 'node', args: ['server.js'] })

    const reloaded = new McpClientManager({ configPath })
    const names = reloaded.list().map((s) => s.name)
    expect(names).toEqual(['github', 'local-tool'])
    // Rule 7: the config file holds a secret NAME, never a token value.
    expect(readFileSync(configPath, 'utf8')).toContain('mcp.github')
  })

  it('rejects duplicates and invalid entries with clean errors', () => {
    const manager = new McpClientManager({ configPath })
    manager.add({ name: 'github', transport: 'http', url: 'https://mcp.example.com/mcp' })
    expect(() => manager.add({ name: 'github', transport: 'http', url: 'https://other.example.com/mcp' })).toThrow(
      /already exists/
    )
    expect(() => manager.add({ name: 'bad', transport: 'http', url: 'not a url' })).toThrow(/invalid MCP server entry/)
    expect(() => manager.add({ name: 'bad', transport: 'carrier-pigeon' })).toThrow(/invalid MCP server entry/)
    expect(manager.list()).toHaveLength(1)
  })

  it('removes entries by name; removing an unknown name is a no-op returning false', () => {
    const manager = new McpClientManager({ configPath })
    manager.add({ name: 'github', transport: 'http', url: 'https://mcp.example.com/mcp' })
    expect(manager.remove('github')).toBe(true)
    expect(manager.remove('github')).toBe(false)
    expect(manager.list()).toEqual([])
  })

  it('throws a clean error for a corrupt config file', () => {
    writeFileSync(configPath, JSON.stringify({ servers: [{ name: 'x' }] }), 'utf8')
    expect(() => new McpClientManager({ configPath }).list()).toThrow(/not a valid MCP servers config/)
  })

  it('listTools: unknown server name and unresolvable secret fail before any connection', async () => {
    const manager = new McpClientManager({ configPath, secrets: () => undefined })
    await expect(manager.listTools('nope')).rejects.toThrow(/no MCP server named 'nope'/)
    manager.add({
      name: 'needs-secret',
      transport: 'http',
      url: 'http://127.0.0.1:1/mcp',
      bearerTokenSecret: 'missing.secret'
    })
    await expect(manager.listTools('needs-secret')).rejects.toThrow(/keychain secret 'missing.secret'/)
  })
})
