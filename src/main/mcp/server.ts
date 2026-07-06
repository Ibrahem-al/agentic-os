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
  MCP_SERVER_VERSION,
  RUNNER_SESSION_MAX_TOOL_CALLS,
  RUNNER_TASK_HEADER
} from '../config'
import type { ProjectSummarizer } from '../ingest'
import type { ProviderRouter } from '../models'
import { KernelPermissionError, type ActionExecutor } from '../kernel'
import type { BudgetGuard, RetrievalDeps, Retriever } from '../retrieval'
import { READ_TOOLS, STAGING_TOOLS, type AuditLog, type InjectionScanner } from '../security'
import type { StorageEngine } from '../storage'
import { McpCallLog } from './callLog'
import { MCP_TOOLS, ToolError, type McpReadContext, type ToolContext } from './tools'

/**
 * Runner MCP sessions are scoped SERVER-SIDE to READ + STAGING tools (§14b B3),
 * independent of the client's `--allowedTools`: even a tampered runner client
 * cannot widen its own surface. Mirrors the `mcp-runner:` permission profile so
 * the dispatch allowlist and the §13 engine agree by construction. (Agent-mode
 * per-task templates that narrow this further land at FP-5.)
 */
const RUNNER_SESSION_ALLOWLIST: ReadonlySet<string> = new Set<string>([...READ_TOOLS, ...STAGING_TOOLS])

/** Node lowercases incoming header names; match RUNNER_TASK_HEADER accordingly. */
const RUNNER_TASK_HEADER_LC = RUNNER_TASK_HEADER.toLowerCase()

export interface AgenticOsMcpServerDeps {
  /** The keychain-held interactive token (§14); every request presents a bearer. */
  readonly bearerToken: string
  /**
   * The keychain-held RUNNER token (§10.1/P0.3, phase-14) — the SECOND accepted
   * bearer. Headless subscription-runner MCP sessions present this instead of
   * the interactive one; whichever token authed a session's `initialize` fixes
   * that session's kind for life. Boot rotates it each launch so a zombie
   * runner's leaked token is already dead.
   */
  readonly runnerToken: string
  readonly engine: StorageEngine
  readonly retriever: Retriever
  readonly retrieval: RetrievalDeps
  /** The shared LOCAL small LLM (ingest_codebase README summaries). */
  readonly llm: ProjectSummarizer
  /**
   * Phase-16b: the ReasoningProvider router. When present, ingest_codebase's
   * README → Project summary binds `forRole('ingest.projectSummary', …)` off it
   * (local-by-default ⇒ identical to `llm`); absent ⇒ today's `llm`.
   */
  readonly router?: ProviderRouter
  /** appdata.db — mcp_calls + staged_writes. */
  readonly db: BetterSqlite3.Database
  /** The kernel chokepoint (§9/§13); every tool call runs through it. */
  readonly executor: ActionExecutor
  /** §13 injection scanner for the ingest tools (phase 09). */
  readonly scanner?: InjectionScanner
  /** §13 audit log — ingest lane jobs record reversible deltas (phase 09). */
  readonly audit?: AuditLog
  /**
   * P0.2 — the durable call/spend guard threaded into every tool's ToolContext
   * (the live read-path budget). Optional: rigs and boots predating the runner
   * path omit it, and every tool then runs without a ceiling exactly as before;
   * the read-path consumer wiring lands at FP-1.
   */
  readonly spendMeter?: BudgetGuard
  readonly host?: string
  /** Default MCP_PORT; tests pass 0 for an ephemeral port. */
  readonly port?: number
}

type McpSessionKind = 'interactive' | 'runner'

interface McpSession {
  readonly transport: StreamableHTTPServerTransport
  readonly server: Server
  /**
   * Which bearer authed this session's `initialize`, fixed for its life. Every
   * later request addressing this session id must re-present the token whose
   * kind matches (closes the token-blind gap — a runner token must not ride a
   * user session, nor vice-versa); it also selects the agent-id family
   * (`mcp:` | `mcp-runner:`) and, for runners, the server-side READ+STAGING
   * allowlist.
   */
  readonly kind: McpSessionKind
  /**
   * Runner sessions only: the task id from X-Agentic-Os-Runner-Task at
   * initialize (§14b P0.6 #3). Stored now; the runner module (FP-3) consumes it.
   */
  readonly boundTaskId?: string
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
  // The §4 read tools' late-bound deps (permissions/runner/triggers/watched
  // folders/ollama/keychain/app-status). Empty until bootIpc calls
  // setReadContext; spread into every ToolContext so an un-wired server keeps
  // today's exact behavior and the read tools that need a dep degrade cleanly.
  private readContext: McpReadContext = {}
  // Gauge split (§3.6a/P0.9): interactive calls drive the §8 yield; runner calls
  // are observed but never stall live work.
  private inflightInteractive = 0
  private inflightRunner = 0
  private readonly runnerSessionCalls: BetterSqlite3.Statement

  constructor(deps: AgenticOsMcpServerDeps) {
    this.deps = deps
    this.callLog = new McpCallLog(deps.db)
    // Per-session runner tool-call ceiling (§14b B3): count THIS session's own
    // already-logged runner calls (dispatch writes the mcp_calls row in its
    // finally, so the current call is not yet counted when the guard reads).
    this.runnerSessionCalls = deps.db.prepare(
      "SELECT count(*) AS c FROM mcp_calls WHERE session_id = ? AND session_kind = 'runner'"
    )
  }

  /** Arm the session-end hook endpoint (phase-11 boot, after the queue exists). */
  setSessionEndHook(hook: SessionEndHook): void {
    this.sessionEndHook = hook
  }

  /**
   * Supply the §4 read tools' late-bound dependencies. Called once from bootIpc
   * — the last boot step, where every subsystem singleton exists and the
   * subsystem snapshot is accurate. Mirrors setSessionEndHook: purely additive.
   * Until it runs, read tools needing a missing dep return a clean structured
   * error, so an un-wired server behaves exactly as before.
   */
  setReadContext(readContext: McpReadContext): void {
    this.readContext = readContext
  }

  /**
   * INTERACTIVE tool calls in flight — THE §8 queue/workflow yield signal
   * (P0.9). A headless runner's calls deliberately do not count here so a
   * background subscription run never stalls live interactive work.
   */
  get inflightInteractiveCalls(): number {
    return this.inflightInteractive
  }

  /** Runner tool calls in flight — observability only (never drives a yield). */
  get inflightRunnerCalls(): number {
    return this.inflightRunner
  }

  /**
   * Combined in-flight gauge (interactive + runner), kept for back-compat with
   * callers predating the P0.9 split. Boot's yield now reads
   * `inflightInteractiveCalls`; this stays so nothing silently breaks.
   */
  get inflightCalls(): number {
    return this.inflightInteractive + this.inflightRunner
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

    // Bearer auth gates EVERY request, initialize included (§21 rule 7 — the
    // token never appears in logs or errors). TWO tokens are accepted: the
    // interactive bearer and the headless RUNNER token (§14b). Both are compared
    // timing-safe; whichever matches fixes this request's kind.
    const auth = req.headers.authorization ?? ''
    const token = auth.startsWith('Bearer ') ? auth.slice('Bearer '.length) : ''
    let presentedKind: McpSessionKind | null = null
    if (token !== '') {
      if (tokenMatches(token, this.deps.bearerToken)) presentedKind = 'interactive'
      else if (tokenMatches(token, this.deps.runnerToken)) presentedKind = 'runner'
    }
    if (presentedKind === null) {
      unauthorized(res)
      return
    }

    const sessionId = req.headers['mcp-session-id']
    const existing = typeof sessionId === 'string' ? this.sessions.get(sessionId) : undefined
    // Per-request kind re-check (§14b, closes the token-blind gap): a request
    // addressing an existing session must present the token whose kind that
    // session was initialized with. A runner token may not ride an interactive
    // session, nor vice-versa — same 401 as a bad token (no information leak).
    if (existing !== undefined && existing.kind !== presentedKind) {
      unauthorized(res)
      return
    }

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
      // X-Agentic-Os-Runner-Task binds a runner session to its spawning task
      // (§14b P0.6 #3). Honored ONLY when a runner token authed this initialize;
      // an interactive initialize carrying it is a misconfigured client → 400 (a
      // default interactive client never sends this header, so today's behavior
      // is untouched).
      const taskHeader = req.headers[RUNNER_TASK_HEADER_LC]
      const boundTaskId = typeof taskHeader === 'string' && taskHeader !== '' ? taskHeader : undefined
      if (boundTaskId !== undefined && presentedKind !== 'runner') {
        jsonRpcHttpError(res, 400, -32000, `${RUNNER_TASK_HEADER} is only valid on a runner-token session`)
        return
      }
      const session = await this.createSession(presentedKind, boundTaskId)
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

  private async createSession(kind: McpSessionKind, boundTaskId?: string): Promise<McpSession> {
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
    const session: McpSession = {
      transport,
      server,
      kind,
      ...(boundTaskId !== undefined ? { boundTaskId } : {})
    }
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
    // The session's kind (fixed at initialize) selects the agent-id family, the
    // gauge, and the runner-only guards. An unknown session ⇒ interactive: the
    // only way to reach dispatch is a live, mapped session, so this is a
    // defensive default that preserves the exact pre-14b interactive path.
    const session = this.sessions.get(sessionId)
    const isRunner = session?.kind === 'runner'
    const agentId = isRunner ? `mcp-runner:${sessionId}` : `mcp:${sessionId}`

    const startedUnixMs = Date.now()
    const t0 = performance.now()
    let resultStatus: 'ok' | 'error' = 'ok'
    let errorText: string | undefined
    if (isRunner) this.inflightRunner += 1
    else this.inflightInteractive += 1
    try {
      // Runner sessions face two server-side guards BEFORE the kernel runs the
      // tool — enforced here, not by the client's --allowedTools, so a tampered
      // runner client cannot widen its own surface. Both throw inside the try,
      // so the finally still writes the mcp_calls row: the refusal is audited
      // and counts toward the session's own call budget.
      if (isRunner) {
        // (1) Server-side template allowlist — READ + STAGING only (FP-5 tightens
        // per task template). Independent of the §13 engine (which also blocks
        // it via the mcp-runner profile) — two layers, one source of truth.
        if (!RUNNER_SESSION_ALLOWLIST.has(name)) {
          throw new ToolError(
            'PERMISSION_DENIED',
            `tool '${name}' is not permitted for a runner MCP session (server-side allowlist: read + staging only)`
          )
        }
        // (2) Per-session tool-call ceiling (RUNNER_SESSION_MAX_TOOL_CALLS). The
        // count excludes the current call (logged in the finally), so used >=
        // ceiling refuses the (ceiling+1)th call onward.
        const used = (this.runnerSessionCalls.get(sessionId) as { c: number }).c
        if (used >= RUNNER_SESSION_MAX_TOOL_CALLS) {
          throw new ToolError(
            'INVALID_STATE',
            `runner MCP session ${sessionId} has reached its ${RUNNER_SESSION_MAX_TOOL_CALLS}-call ceiling (§14b) — halting`
          )
        }
      }
      const result = await this.deps.executor.execute(
        agentId,
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
            ...(this.deps.router !== undefined ? { router: this.deps.router } : {}),
            db: this.deps.db,
            sessionId,
            ...(this.deps.scanner !== undefined ? { scanner: this.deps.scanner } : {}),
            ...(this.deps.audit !== undefined ? { audit: this.deps.audit } : {}),
            ...(this.deps.spendMeter !== undefined ? { spendMeter: this.deps.spendMeter } : {}),
            // §4 read tools' late-bound deps (empty on an un-wired server).
            ...this.readContext,
            // Runner sessions carry their spawning task id (§14b P0.6 #3):
            // submit_extraction_items keys its rows to it instead of a continuation.
            ...(session?.boundTaskId !== undefined ? { boundTaskId: session.boundTaskId } : {})
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
      if (isRunner) this.inflightRunner -= 1
      else this.inflightInteractive -= 1
      this.callLog.record({
        sessionId,
        tool: name,
        args,
        resultStatus,
        ...(errorText !== undefined ? { error: errorText } : {}),
        startedUnixMs,
        durationMs: performance.now() - t0,
        // 'runner' rows let the §6 inactivity sweep skip a headless runner's own
        // session; interactive rows stay NULL exactly as before (A3/P0.5).
        sessionKind: isRunner ? 'runner' : null
      })
    }
  }
}
