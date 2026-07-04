/**
 * MCP client manager (§12: the OS "is also an MCP client, able to consume
 * external MCP servers the user adds"). External servers live in a plain JSON
 * config file (userData/mcp-servers.json); their tools are listed on demand —
 * consumed by agents from phase 08 on, and by the phase-10 dashboard.
 *
 * Secret handling (§21 rule 7): the config file NEVER holds tokens. An http
 * entry may name a keychain secret (`bearerTokenSecret`); the injected
 * `secrets` resolver (the Keychain in production) supplies the value at
 * connect time.
 */
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import * as z from 'zod'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import { MCP_SERVER_VERSION, PRODUCT_NAME } from '../config'

const HttpServerEntry = z.object({
  name: z.string().min(1),
  transport: z.literal('http'),
  url: z.url(),
  /** Keychain secret NAME holding the bearer token (never the token itself). */
  bearerTokenSecret: z.string().min(1).optional()
})

const StdioServerEntry = z.object({
  name: z.string().min(1),
  transport: z.literal('stdio'),
  command: z.string().min(1),
  args: z.array(z.string()).optional()
})

const ExternalMcpServerSchema = z.discriminatedUnion('transport', [HttpServerEntry, StdioServerEntry])
const McpServersConfigSchema = z.object({ servers: z.array(ExternalMcpServerSchema) })

export type ExternalMcpServer = z.output<typeof ExternalMcpServerSchema>

export interface ExternalMcpTool {
  readonly name: string
  readonly description: string | null
  readonly inputSchema: Record<string, unknown>
}

export interface McpClientManagerDeps {
  readonly configPath: string
  /** Resolves keychain secret names for http bearer tokens. */
  readonly secrets?: (name: string) => string | undefined
}

export class McpClientManager {
  private readonly configPath: string
  private readonly secrets: ((name: string) => string | undefined) | undefined

  constructor(deps: McpClientManagerDeps) {
    this.configPath = deps.configPath
    this.secrets = deps.secrets
  }

  list(): ExternalMcpServer[] {
    return this.load().servers
  }

  add(entry: unknown): ExternalMcpServer {
    const parsed = ExternalMcpServerSchema.safeParse(entry)
    if (!parsed.success) {
      const detail = parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ')
      throw new Error(`invalid MCP server entry — ${detail}`)
    }
    const config = this.load()
    if (config.servers.some((s) => s.name === parsed.data.name)) {
      throw new Error(`an MCP server named '${parsed.data.name}' already exists — remove it first`)
    }
    config.servers.push(parsed.data)
    this.save(config)
    return parsed.data
  }

  remove(name: string): boolean {
    const config = this.load()
    const remaining = config.servers.filter((s) => s.name !== name)
    if (remaining.length === config.servers.length) return false
    this.save({ servers: remaining })
    return true
  }

  /** Connect to one configured server, list its tools, disconnect. */
  async listTools(name: string): Promise<ExternalMcpTool[]> {
    const entry = this.load().servers.find((s) => s.name === name)
    if (!entry) throw new Error(`no MCP server named '${name}' is configured`)
    const transport = this.buildTransport(entry)
    const client = new Client({ name: `${PRODUCT_NAME}-client`, version: MCP_SERVER_VERSION })
    await client.connect(transport)
    try {
      const result = await client.listTools()
      return result.tools.map((t) => ({
        name: t.name,
        description: t.description ?? null,
        inputSchema: t.inputSchema as Record<string, unknown>
      }))
    } finally {
      await client.close().catch(() => undefined)
    }
  }

  private buildTransport(entry: ExternalMcpServer): Transport {
    if (entry.transport === 'http') {
      const headers: Record<string, string> = {}
      if (entry.bearerTokenSecret !== undefined) {
        const token = this.secrets?.(entry.bearerTokenSecret)
        if (token === undefined) {
          throw new Error(
            `MCP server '${entry.name}' references keychain secret '${entry.bearerTokenSecret}', which is not set`
          )
        }
        headers['Authorization'] = `Bearer ${token}`
      }
      return new StreamableHTTPClientTransport(new URL(entry.url), { requestInit: { headers } })
    }
    return new StdioClientTransport({ command: entry.command, args: entry.args ?? [] })
  }

  private load(): { servers: ExternalMcpServer[] } {
    let raw: string
    try {
      raw = readFileSync(this.configPath, 'utf8')
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { servers: [] }
      throw err
    }
    const parsed = McpServersConfigSchema.safeParse(JSON.parse(raw))
    if (!parsed.success) {
      const detail = parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ')
      throw new Error(`${this.configPath} is not a valid MCP servers config — ${detail}`)
    }
    return { servers: [...parsed.data.servers] }
  }

  private save(config: { servers: ExternalMcpServer[] }): void {
    mkdirSync(dirname(this.configPath), { recursive: true })
    const tmpPath = `${this.configPath}.tmp`
    try {
      writeFileSync(tmpPath, `${JSON.stringify(config, null, 2)}\n`, 'utf8')
      renameSync(tmpPath, this.configPath)
    } catch (err) {
      rmSync(tmpPath, { force: true })
      throw err
    }
  }
}
