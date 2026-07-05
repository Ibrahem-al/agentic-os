/**
 * The OS's MCP server (§12): Streamable HTTP on 127.0.0.1:4517 behind the
 * keychain bearer token, exposing exactly the seven v1 tools.
 *
 * Request flow: bearer auth (every request, timing-safe) → per-session
 * StreamableHTTPServerTransport (stateful; the transport's session id is the
 * §6 correlation key) → ONE CallTool handler — the chokepoint. That handler
 * runs every tool through kernel.execute (span + PHASE-09 permission seam)
 * and writes the mcp_calls row in a `finally`, so a tool cannot be invoked —
 * success, tool error, bad args, or unknown name — without a log row.
 *
 * Tool failures return a clean structured error result over MCP (§15 live
 * failure policy); protocol-level junk (bad session, bad JSON) is handled by
 * the transport/HTTP layer and never reaches a tool.
 */
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto'
import { createServer, type IncomingMessage, type Server as HttpServer, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { performance } from 'node:perf_hooks'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { CallToolRequestSchema, ListToolsRequestSchema, isInitializeRequest } from '@modelcontextprotocol/sdk/types.js'
import type BetterSqlite3 from 'better-sqlite3'
import {
  HOOK_MAX_BODY_BYTES,
  HOOK_SESSION_END_PATH,
  MCP_ENDPOINT_PATH,
  MCP_HOST,
  MCP_MAX_BODY_BYTES,
  MCP_PORT,
  MCP_SERVER_NAME,
  MCP_SERVER_VERSION
} from '../config'
import type { ProjectSummarizer } from '../ingest'
import { KernelPermissionError, type ActionExecutor } from '../kernel'
import type { RetrievalDeps, Retriever } from '../retrieval'
import type { AuditLog, InjectionScanner } from '../security'
import type { StorageEngine } from '../storage'
import { McpCallLog } from './callLog'
import { MCP_TOOLS, ToolError, type ToolContext } from './tools'

export interface AgenticOsMcpServerDeps {
  /** The keychain-held token (§14); every request must present it. */
  readonly bearerToken: string
  readonly engine: StorageEngine
  readonly retriever: Retriever
  readonly retrieval: RetrievalDeps
  /** The shared LOCAL small LLM (ingest_codebase README summaries). */
  readonly llm: ProjectSummarizer
  /** appdata.db — mcp_calls + staged_writes. */
  readonly db: BetterSqlite3.Database
  /** The kernel chokepoint (§9/§13); every tool call runs through it. */
  readonly executor: ActionExecutor
  /** §13 injection scanner for the ingest tools (phase 09). */
  readonly scanner?: InjectionScanner
  /** §13 audit log — ingest lane jobs record reversible deltas (phase 09). */
  readonly audit?: AuditLog
  readonly host?: string
  /** Default MCP_PORT; tests pass 0 for an ephemeral port. */
  readonly port?: number
}

interface McpSession {
  readonly transport: StreamableHTTPServerTransport
  readonly server: Server
}

/**
 * The §6/§20 session-end hook endpoint, mounted on this same HTTP server.
 * Configured post-construction (the queue boots after the MCP server); until
 * then POSTs get 503 and the hook script spools — no session lost to timing.
 */
export interface SessionEndHook {
  /** The dedicated hook token (NOT the MCP bearer token — phase-11 decision). */
  readonly token: string
  /** Validate + enqueue; returns the HTTP status and JSON body to send. */
  readonly handle: (body: unknown) => { status: number; body: unknown }
}

function unauthorized(res: ServerResponse): void {
  res.writeHead(401, { 'Content-Type': 'application/json', 'WWW-Authenticate': 'Bearer' })
  res.end(
    JSON.stringify({
      jsonrpc: '2.0',
      error: { code: -32001, message: 'Unauthorized: missing or invalid bearer token' },
      id: null
    })
  )
}

function jsonRpcHttpError(res: ServerResponse, httpStatus: number, code: number, message: string): void {
  res.writeHead(httpStatus, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify({ jsonrpc: '2.0', error: { code, message }, id: null }))
}

/** Constant-time bearer comparison (hash first: inputs differ in length). */
function tokenMatches(provided: string, expected: string): boolean {
  const a = createHash('sha256').update(provided, 'utf8').digest()
  const b = createHash('sha256').update(expected, 'utf8').digest()
  return timingSafeEqual(a, b)
}

function readBody(req: IncomingMessage, maxBytes: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let total = 0
    req.on('data', (chunk: Buffer) => {
      total += chunk.length
      if (total > maxBytes) {
        reject(new Error('body too large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

export class AgenticOsMcpServer {
  private readonly deps: AgenticOsMcpServerDeps
  private readonly callLog: McpCallLog
  private readonly sessions = new Map<string, McpSession>()
  private http: HttpServer | null = null
  private sessionEndHook: SessionEndHook | null = null
  private inflight = 0

  constructor(deps: AgenticOsMcpServerDeps) {
    this.deps = deps
    this.callLog = new McpCallLog(deps.db)
  }

  /** Arm the session-end hook endpoint (phase-11 boot, after the queue exists). */
  setSessionEndHook(hook: SessionEndHook): void {
    this.sessionEndHook = hook
  }

  /** Live tool calls in flight — the §8 queue yields while this is > 0. */
  get inflightCalls(): number {
    return this.inflight
  }

  /** The bound port (useful when constructed with port 0). */
  get port(): number {
    const address = this.http?.address() as AddressInfo | null
    return address?.port ?? this.deps.port ?? MCP_PORT
  }

  get url(): string {
    return `http://${this.deps.host ?? MCP_HOST}:${this.port}${MCP_ENDPOINT_PATH}`
  }

  async start(): Promise<void> {
    if (this.http) throw new Error('MCP server already started')
    const http = createServer((req, res) => {
      void this.handleHttp(req, res).catch((err) => {
        console.error('[mcp] request handling failed', err)
        if (!res.headersSent) jsonRpcHttpError(res, 500, -32603, 'Internal server error')
        else res.end()
      })
    })
    this.http = http
    await new Promise<void>((resolve, reject) => {
      const onError = (err: Error): void => {
        this.http = null
        reject(err)
      }
      http.once('error', onError)
      http.listen(this.deps.port ?? MCP_PORT, this.deps.host ?? MCP_HOST, () => {
        http.off('error', onError)
        resolve()
      })
    })
  }

  async stop(): Promise<void> {
    // Sever sockets synchronously first — no new request can arrive (or touch
    // the db) after this line; SDK session teardown then finishes calmly.
    const http = this.http
    this.http = null
    http?.closeAllConnections()
    for (const [sid, session] of [...this.sessions]) {
      this.sessions.delete(sid)
      await session.server.close().catch(() => undefined)
    }
    if (http) await new Promise<void>((resolve) => http.close(() => resolve()))
  }

  private async handleHttp(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`)
    if (url.pathname === HOOK_SESSION_END_PATH) {
      await this.handleSessionEndPost(req, res)
      return
    }
    if (url.pathname !== MCP_ENDPOINT_PATH) {
      jsonRpcHttpError(res, 404, -32000, 'Not found — the MCP endpoint is ' + MCP_ENDPOINT_PATH)
      return
    }

    // Bearer auth gates EVERY request, initialize included. The token never
    // appears in logs or errors (§21 rule 7).
    const auth = req.headers.authorization ?? ''
    const token = auth.startsWith('Bearer ') ? auth.slice('Bearer '.length) : ''
    if (token === '' || !tokenMatches(token, this.deps.bearerToken)) {
      unauthorized(res)
      return
    }

    const sessionId = req.headers['mcp-session-id']
    const existing = typeof sessionId === 'string' ? this.sessions.get(sessionId) : undefined

    if (req.method === 'POST') {
      let body: unknown
      try {
        body = JSON.parse(await readBody(req, MCP_MAX_BODY_BYTES))
      } catch (err) {
        const tooLarge = err instanceof Error && err.message === 'body too large'
        jsonRpcHttpError(res, tooLarge ? 413 : 400, -32700, tooLarge ? 'Request body too large' : 'Parse error')
        return
      }
      if (existing) {
        await existing.transport.handleRequest(req, res, body)
        return
      }
      if (typeof sessionId === 'string') {
        // Stale or foreign session id → 404 so the client re-initializes.
        jsonRpcHttpError(res, 404, -32001, 'Session not found — re-initialize')
        return
      }
      if (!isInitializeRequest(body)) {
        jsonRpcHttpError(res, 400, -32000, 'Bad request: no session id and not an initialize request')
        return
      }
      const session = await this.createSession()
      await session.transport.handleRequest(req, res, body)
      return
    }

    if (req.method === 'GET' || req.method === 'DELETE') {
      if (!existing) {
        jsonRpcHttpError(res, typeof sessionId === 'string' ? 404 : 400, -32001, 'Session not found')
        return
      }
      await existing.transport.handleRequest(req, res)
      return
    }

    res.writeHead(405, { Allow: 'GET, POST, DELETE' })
    res.end()
  }

  /**
   * POST /hooks/session-end (§6 tier 1). Auth = the DEDICATED hook token
   * (timing-safe); the §12 MCP surface stays behind its own bearer token.
   * Anything but a valid authenticated POST answers with an error status —
   * the hook script treats every non-2xx as "spool it".
   */
  private async handleSessionEndPost(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const respond = (status: number, body: unknown): void => {
      res.writeHead(status, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(body))
    }
    if (req.method !== 'POST') {
      res.writeHead(405, { Allow: 'POST' })
      res.end()
      return
    }
    const hook = this.sessionEndHook
    if (hook === null) {
      respond(503, { error: 'session-end triggers are not armed this launch — the hook script will spool' })
      return
    }
    const auth = req.headers.authorization ?? ''
    const token = auth.startsWith('Bearer ') ? auth.slice('Bearer '.length) : ''
    if (token === '' || !tokenMatches(token, hook.token)) {
      unauthorized(res)
      return
    }
    let body: unknown
    try {
      body = JSON.parse(await readBody(req, HOOK_MAX_BODY_BYTES))
    } catch (err) {
      const tooLarge = err instanceof Error && err.message === 'body too large'
      respond(tooLarge ? 413 : 400, { error: tooLarge ? 'payload too large' : 'payload is not valid JSON' })
      return
    }
    const result = hook.handle(body)
    respond(result.status, result.body)
  }

  private async createSession(): Promise<McpSession> {
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (sid) => {
        this.sessions.set(sid, session)
      },
      onsessionclosed: (sid) => {
        this.sessions.delete(sid)
      }
    })
    const server = this.buildSessionServer(() => transport.sessionId ?? 'uninitialized')
    const session: McpSession = { transport, server }
    transport.onclose = (): void => {
      if (transport.sessionId) this.sessions.delete(transport.sessionId)
    }
    await server.connect(transport)
    return session
  }

  private buildSessionServer(getSessionId: () => string): Server {
    const server = new Server(
      { name: MCP_SERVER_NAME, version: MCP_SERVER_VERSION },
      { capabilities: { tools: {} } }
    )
    server.setRequestHandler(ListToolsRequestSchema, () => ({
      tools: MCP_TOOLS.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema }))
    }))
    server.setRequestHandler(CallToolRequestSchema, (request) =>
      this.dispatchTool(getSessionId(), request.params.name, request.params.arguments ?? {})
    )
    return server
  }

  /**
   * THE chokepoint: kernel mediation around the handler, mcp_calls row in the
   * finally. Unknown tools and invalid args take the same path — logged, and
   * returned as a structured tool error (§15: Claude decides what to do next).
   */
  private async dispatchTool(
    sessionId: string,
    name: string,
    args: unknown
  ): Promise<{ content: { type: 'text'; text: string }[]; isError?: boolean }> {
    const startedUnixMs = Date.now()
    const t0 = performance.now()
    let resultStatus: 'ok' | 'error' = 'ok'
    let errorText: string | undefined
    this.inflight += 1
    try {
      const result = await this.deps.executor.execute(
        `mcp:${sessionId}`,
        { kind: 'mcp-call', name, attributes: { 'mcp.session_id': sessionId } },
        async () => {
          const tool = MCP_TOOLS.find((t) => t.name === name)
          if (!tool) {
            throw new ToolError(
              'NOT_FOUND',
              `unknown tool '${name}' — available: ${MCP_TOOLS.map((t) => t.name).join(', ')}`
            )
          }
          const ctx: ToolContext = {
            engine: this.deps.engine,
            retriever: this.deps.retriever,
            retrieval: this.deps.retrieval,
            llm: this.deps.llm,
            db: this.deps.db,
            sessionId,
            ...(this.deps.scanner !== undefined ? { scanner: this.deps.scanner } : {}),
            ...(this.deps.audit !== undefined ? { audit: this.deps.audit } : {})
          }
          return tool.handle(args, ctx)
        }
      )
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] }
    } catch (err) {
      resultStatus = 'error'
      // §13 denials surface as clean structured errors (§15: the orchestrator
      // decides what to do next — never pause-and-notify).
      const code =
        err instanceof ToolError ? err.code : err instanceof KernelPermissionError ? 'PERMISSION_DENIED' : 'INTERNAL'
      const message = err instanceof Error ? err.message : String(err)
      errorText = `${code}: ${message}`
      return {
        content: [{ type: 'text', text: JSON.stringify({ error: { code, message } }, null, 2) }],
        isError: true
      }
    } finally {
      this.inflight -= 1
      this.callLog.record({
        sessionId,
        tool: name,
        args,
        resultStatus,
        ...(errorText !== undefined ? { error: errorText } : {}),
        startedUnixMs,
        durationMs: performance.now() - t0
      })
    }
  }
}
