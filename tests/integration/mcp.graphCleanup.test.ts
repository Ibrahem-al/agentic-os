/**
 * The run_graph_cleanup control tool (phase-41) over a REAL SDK client against
 * the real Streamable HTTP server + a real DurableTaskQueue — mirrors the
 * phase-18 run_maintenance/retry_task shape:
 *
 *  - an interactive session's run_graph_cleanup ENQUEUES the §8 'graph-cleanup'
 *    task (B's kind), carrying the scan options in the payload, with the right
 *    { scheduled, taskId, deduped, note } response, and dedups a same-minute
 *    burst onto the same deterministic per-minute id;
 *  - the call leaves an mcp_calls row (the §6 backbone — the server's chokepoint
 *    logs every tool call in a finally);
 *  - tiering pins: run_graph_cleanup is registered + dashboard-tier, and is
 *    deliberately absent from the runner allowlist (a headless runner can never
 *    trigger a memory-cleanup pass).
 *
 * The tool only ENQUEUES (never runs the agent inline), so the queue is left
 * UNSTARTED and no graph-cleanup handler is registered — enqueue just mirrors the
 * tasks row. Offline throughout: deterministic retrieval fakes; the HTTP hop, the
 * queue mirror and the appdata staging are real.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { AgenticOsMcpServer, MCP_TOOLS, RUNNER_SESSION_ALLOWLIST } from '../../src/main/mcp'
import { createRetriever, type RetrievalDeps, type Retriever, type SmallLlm } from '../../src/main/retrieval'
import { DurableTaskQueue } from '../../src/main/triggers'
import { DASHBOARD_TOOLS } from '../../src/main/security'
import { openKernelStack, type KernelTestStack } from '../fixtures/kernel-helpers'
import { FakeEmbedder, FakeReranker } from '../fixtures/retrieval-fakes'
import { openTestStore, type TestStore } from './helpers'

const BEARER_TOKEN = 'phase41-bearer'
const RUNNER_TOKEN = 'phase41-runner'
const passingCritic: SmallLlm = { generate: async () => ({ text: '{"score": 10, "missing": "none"}' }) }
const fakeSummarizer: SmallLlm = { generate: async () => ({ text: 'a summary' }) }

interface ToolReply {
  isError: boolean
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  body: any
}

describe('run_graph_cleanup control tool (real MCP client)', () => {
  let store: TestStore
  let stack: KernelTestStack
  let queue: DurableTaskQueue
  let server: AgenticOsMcpServer
  let client: Client
  let clientTransport: StreamableHTTPClientTransport

  const db = (): typeof stack.appData.db => stack.appData.db

  async function call(name: string, args: Record<string, unknown>): Promise<ToolReply> {
    const result = (await client.callTool({ name, arguments: args })) as {
      content: { type: string; text: string }[]
      isError?: boolean
    }
    return { isError: result.isError === true, body: JSON.parse(result.content[0]?.text ?? '') }
  }

  beforeAll(async () => {
    store = await openTestStore()
    stack = openKernelStack()

    const retrieval: RetrievalDeps = { engine: store.engine, embedder: new FakeEmbedder(), reranker: new FakeReranker() }
    const retriever: Retriever = createRetriever({ ...retrieval, llm: passingCritic })
    queue = new DurableTaskQueue({ db: stack.appData.db }) // NOT started — enqueue just mirrors rows

    server = new AgenticOsMcpServer({
      bearerToken: BEARER_TOKEN,
      runnerToken: RUNNER_TOKEN,
      engine: store.engine,
      retriever,
      retrieval,
      llm: fakeSummarizer,
      db: stack.appData.db,
      executor: stack.kernel,
      port: 0
    })
    server.setReadContext({ queue })
    await server.start()
    const transport = new StreamableHTTPClientTransport(new URL(server.url), {
      requestInit: { headers: { Authorization: `Bearer ${BEARER_TOKEN}` } }
    })
    client = new Client({ name: 'phase41-client', version: '0.0.1' })
    await client.connect(transport)
    clientTransport = transport
    void clientTransport
  })

  afterAll(async () => {
    await client.close().catch(() => undefined)
    await server.stop()
    stack.cleanup()
    await store.cleanup()
  })

  // Per-test isolation: the deterministic per-minute id collides across tests in the
  // same real minute, so clear the mirror between them (enqueue dedup is DB-based).
  afterEach(() => {
    db().prepare('DELETE FROM tasks').run()
    db().prepare('DELETE FROM mcp_calls').run()
  })

  it('enqueues a graph-cleanup task carrying the scan options, deduped per minute', async () => {
    const first = await call('run_graph_cleanup', { scope: 'count', count: 25, threshold: 0.9, labels: ['Preference'] })
    expect(first.isError).toBe(false)
    expect(first.body.scheduled).toBe(true)
    expect(first.body.deduped).toBe(false)
    expect(first.body.taskId).toMatch(/^graph-cleanup-\d{4}-\d{2}-\d{2}T\d{4}$/)
    // The description promise: stages for review, never merges directly (§21 rule 6).
    expect(String(first.body.note)).toContain('STAGES merge proposals')
    expect(String(first.body.note)).toContain('nothing merges without approval')

    const task = db().prepare('SELECT kind, priority, payload_json FROM tasks WHERE id = ?').get(first.body.taskId) as {
      kind: string
      priority: number
      payload_json: string
    }
    expect(task.kind).toBe('graph-cleanup')
    expect(JSON.parse(task.payload_json)).toEqual({ scope: 'count', count: 25, threshold: 0.9, labels: ['Preference'] })

    // A second "clean up now" in the same minute collapses onto the same task id.
    const second = await call('run_graph_cleanup', { scope: 'recent' })
    expect(second.body.taskId).toBe(first.body.taskId)
    expect(second.body.deduped).toBe(true)
  })

  it('defaults to an empty payload when no options are given (handler applies scope recent)', async () => {
    const reply = await call('run_graph_cleanup', {})
    expect(reply.isError).toBe(false)
    const task = db().prepare('SELECT kind, payload_json FROM tasks WHERE id = ?').get(reply.body.taskId) as {
      kind: string
      payload_json: string
    }
    expect(task.kind).toBe('graph-cleanup')
    expect(JSON.parse(task.payload_json)).toEqual({})
  })

  it('rejects an out-of-range threshold (INVALID_INPUT) and stages nothing', async () => {
    const reply = await call('run_graph_cleanup', { threshold: 2 })
    expect(reply.isError).toBe(true)
    expect(reply.body.error.code).toBe('INVALID_INPUT')
    expect(db().prepare('SELECT count(*) AS c FROM tasks').get()).toEqual({ c: 0 })
  })

  it('logs an mcp_calls row for the tool (the §6 backbone)', async () => {
    await call('run_graph_cleanup', { scope: 'all' })
    const row = db()
      .prepare('SELECT tool, result_status, session_kind FROM mcp_calls WHERE tool = ? ORDER BY id DESC LIMIT 1')
      .get('run_graph_cleanup') as { tool: string; result_status: string; session_kind: string | null }
    expect(row.tool).toBe('run_graph_cleanup')
    expect(row.result_status).toBe('ok')
    expect(row.session_kind).toBeNull() // interactive caller
  })

  it('is tiered dashboard-only: registered + in DASHBOARD_TOOLS, never in the runner allowlist', () => {
    expect(MCP_TOOLS.some((t) => t.name === 'run_graph_cleanup')).toBe(true)
    expect(DASHBOARD_TOOLS.has('run_graph_cleanup')).toBe(true)
    // Deliberately absent from the read/staging tiers the runner surface derives from.
    expect(RUNNER_SESSION_ALLOWLIST.has('run_graph_cleanup')).toBe(false)
  })
})
