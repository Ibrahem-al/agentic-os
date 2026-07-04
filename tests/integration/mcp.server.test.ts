/**
 * Phase-05 DoD: a real SDK client against the real Streamable HTTP server —
 * auth rejected without/with a wrong token; get_context returns a bundle from
 * the fixture graph; propose_correction lands in staged_writes with the graph
 * untouched; ingest_document ingests end-to-end (phase-06 DoD: content-hash
 * dedup + one lane job per ingest) while ingest_codebase still refuses
 * cleanly; EVERY tool call leaves an mcp_calls row (count-asserted) and a
 * kernel.mcp-call span; the client manager lists the server's tools through
 * the config file.
 *
 * Offline by construction: deterministic fakes for embedder/reranker/critic
 * (same fixtures as the retrieval golden tests); the HTTP hop is real.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { AgenticOsMcpServer, McpClientManager } from '../../src/main/mcp'
import { createRetriever, searchMemory, type RetrievalDeps, type Retriever, type SmallLlm } from '../../src/main/retrieval'
import { openKernelStack, spanAttributes, spanRows, type KernelTestStack } from '../fixtures/kernel-helpers'
import { GLOBAL_PREFERENCE_IDS, seedFixtureGraph } from '../fixtures/graph-seed'
import { FakeEmbedder, FakeReranker } from '../fixtures/retrieval-fakes'
import { openTestStore, type TestStore } from './helpers'

const BEARER_TOKEN = 'test-bearer-token-abc123'

/** Critic that always passes → each get_context is one read-path pass. */
const passingCritic: SmallLlm = {
  generate: async () => ({ text: '{"score": 10, "missing": "none"}' })
}

let store: TestStore
let stack: KernelTestStack
let retrieval: RetrievalDeps
let retriever: Retriever
let server: AgenticOsMcpServer
let serverUrl: string
let writesAfterSeeding = 0
/** Write-lane jobs legitimately performed by ingest_document calls (phase 06). */
let graphWriteJobsExpected = 0

/** Tool calls made over MCP in this suite — the mcp_calls count must match. */
let callsMade = 0
let errorCallsMade = 0
const sessionIdsUsed = new Set<string>()

let client: Client
let clientTransport: StreamableHTTPClientTransport

async function connect(token?: string): Promise<{ client: Client; transport: StreamableHTTPClientTransport }> {
  const transport = new StreamableHTTPClientTransport(new URL(serverUrl), {
    requestInit: token === undefined ? {} : { headers: { Authorization: `Bearer ${token}` } }
  })
  const c = new Client({ name: 'phase05-test-client', version: '0.0.1' })
  await c.connect(transport)
  return { client: c, transport }
}

interface ToolReply {
  isError: boolean
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  body: any
}

async function call(c: Client, name: string, args: Record<string, unknown>): Promise<ToolReply> {
  callsMade += 1
  const result = (await c.callTool({ name, arguments: args })) as {
    content: { type: string; text: string }[]
    isError?: boolean
  }
  const isError = result.isError === true
  if (isError) errorCallsMade += 1
  const text = result.content[0]?.text ?? ''
  return { isError, body: JSON.parse(text) }
}

beforeAll(async () => {
  store = await openTestStore()
  await seedFixtureGraph(store.engine)
  writesAfterSeeding = store.engine.lane.enqueuedCount
  stack = openKernelStack()
  retrieval = { engine: store.engine, embedder: new FakeEmbedder(), reranker: new FakeReranker() }
  retriever = createRetriever({ ...retrieval, llm: passingCritic })
  server = new AgenticOsMcpServer({
    bearerToken: BEARER_TOKEN,
    engine: store.engine,
    retriever,
    retrieval,
    db: stack.appData.db,
    executor: stack.kernel,
    port: 0 // ephemeral test port
  })
  await server.start()
  serverUrl = server.url
  const first = await connect(BEARER_TOKEN)
  client = first.client
  clientTransport = first.transport
  if (clientTransport.sessionId) sessionIdsUsed.add(clientTransport.sessionId)
})

afterAll(async () => {
  await client.close().catch(() => undefined)
  await server.stop()
  stack.cleanup()
  await store.cleanup()
})

describe('auth (§12 bearer token)', () => {
  it('rejects requests without a token (401, no session, no log row)', async () => {
    await expect(connect()).rejects.toThrow(/Unauthorized/)
    const raw = await fetch(serverUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} })
    })
    expect(raw.status).toBe(401)
    expect(raw.headers.get('www-authenticate')).toBe('Bearer')
    const count = stack.appData.db.prepare('SELECT count(*) AS c FROM mcp_calls').get() as { c: number }
    expect(count.c).toBe(callsMade) // auth rejections never reach a tool
  })

  it('rejects a wrong token', async () => {
    await expect(connect('wrong-token')).rejects.toThrow(/Unauthorized/)
  })

  it('404s off-path requests and 405s unsupported methods', async () => {
    const auth = { Authorization: `Bearer ${BEARER_TOKEN}` }
    const offPath = await fetch(serverUrl.replace('/mcp', '/other'), { method: 'POST', headers: auth })
    expect(offPath.status).toBe(404)
    const put = await fetch(serverUrl, { method: 'PUT', headers: auth })
    expect(put.status).toBe(405)
  })
})

describe('the §12 tool surface', () => {
  it('lists exactly the seven v1 tools, no others', async () => {
    const tools = await client.listTools()
    expect(tools.tools.map((t) => t.name).sort()).toEqual([
      'get_context',
      'get_skill',
      'ingest_codebase',
      'ingest_document',
      'list_skills',
      'propose_correction',
      'search_memory'
    ])
  })

  it('get_context returns a bundle from the fixture graph (DoD)', async () => {
    const reply = await call(client, 'get_context', {
      task: 'deploy the aurora storefront to vercel and verify the checkout flow'
    })
    expect(reply.isError).toBe(false)
    const ids = [...reply.body.items, ...reply.body.globalPreferences].map((i: { id: string }) => i.id)
    for (const expected of ['s-deploy', 'p-aurora', 'k-vercel']) expect(ids).toContain(expected)
    for (const pref of GLOBAL_PREFERENCE_IDS) {
      expect(reply.body.globalPreferences.map((p: { id: string }) => p.id)).toContain(pref)
    }
    expect(reply.body.confidence).toBe('high')
    expect(reply.body.iterations).toBe(1)
    expect(reply.body.items.length).toBeGreaterThan(0)
    expect(reply.body.items[0].text.length).toBeGreaterThan(0)
  })

  it('get_context honors tags (tag-scoped preferences surface)', async () => {
    const reply = await call(client, 'get_context', {
      task: 'what naming convention applies to warehouse database tables',
      tags: ['database']
    })
    const ids = [...reply.body.items, ...reply.body.globalPreferences].map((i: { id: string }) => i.id)
    expect(ids).toContain('pref-naming')
  })

  it('search_memory: direct hybrid search, label filter + k respected', async () => {
    const reply = await call(client, 'search_memory', {
      query: 'postgres autovacuum warehouse ingest spikes',
      labels: ['Knowledge'],
      k: 3
    })
    expect(reply.isError).toBe(false)
    expect(reply.body.hits.length).toBeLessThanOrEqual(3)
    expect(reply.body.hits.length).toBeGreaterThan(0)
    for (const hit of reply.body.hits) expect(hit.label).toBe('Knowledge')
    expect(reply.body.hits[0].id).toBe('k-vacuum')
  })

  it('search_memory rejects unknown labels and out-of-range k with INVALID_INPUT', async () => {
    const badLabel = await call(client, 'search_memory', { query: 'x', labels: ['Session'] })
    expect(badLabel.isError).toBe(true)
    expect(badLabel.body.error.code).toBe('INVALID_INPUT')
    const badK = await call(client, 'search_memory', { query: 'x', k: 31 })
    expect(badK.isError).toBe(true)
    expect(badK.body.error.code).toBe('INVALID_INPUT')
  })

  it('list_skills returns all four fixture skills', async () => {
    const reply = await call(client, 'list_skills', {})
    expect(reply.isError).toBe(false)
    expect(reply.body.skills.map((s: { id: string }) => s.id).sort()).toEqual([
      's-charts',
      's-deploy',
      's-migrate',
      's-review'
    ])
    const deploy = reply.body.skills.find((s: { id: string }) => s.id === 's-deploy')
    expect(deploy.name).toBe('deploy storefront')
    expect(deploy.currentVersion).toBe('sv-deploy-active')
  })

  it('get_skill returns the active SkillVersion body + capped recent examples (§12)', async () => {
    const reply = await call(client, 'get_skill', { name: 'deploy storefront' })
    expect(reply.isError).toBe(false)
    expect(reply.body.id).toBe('s-deploy')
    expect(reply.body.activeVersion.id).toBe('sv-deploy-active')
    expect(reply.body.activeVersion.instructions).toContain('smoke suite')
    expect(reply.body.recentExamples).toHaveLength(3) // 4 exist; cap is 3
    for (const example of reply.body.recentExamples) {
      expect(['success', 'failure']).toContain(example.kind)
      expect(example.content.length).toBeGreaterThan(0)
    }
  })

  it('get_skill: skill without an active version → activeVersion null; unknown → NOT_FOUND', async () => {
    const review = await call(client, 'get_skill', { name: 'review pull request' })
    expect(review.isError).toBe(false)
    expect(review.body.activeVersion).toBeNull()
    const missing = await call(client, 'get_skill', { name: 'no such skill' })
    expect(missing.isError).toBe(true)
    expect(missing.body.error.code).toBe('NOT_FOUND')
  })

  it('ingest_codebase stays registered but NOT_IMPLEMENTED (phase 07)', async () => {
    const code = await call(client, 'ingest_codebase', { path: '/tmp/repo' })
    expect(code.isError).toBe(true)
    expect(code.body.error.code).toBe('NOT_IMPLEMENTED')
    expect(code.body.error.message).toContain('phase 07')
  })

  it('unknown tools come back as a clean structured error (and are still logged)', async () => {
    const reply = await call(client, 'delete_everything', {})
    expect(reply.isError).toBe(true)
    expect(reply.body.error.code).toBe('NOT_FOUND')
    expect(reply.body.error.message).toContain('get_context')
  })
})

describe('propose_correction (§21 rule 6: staged, never a direct write)', () => {
  it('stages a staged_writes row and leaves the graph untouched (DoD)', async () => {
    const writesBefore = store.engine.lane.enqueuedCount
    const reply = await call(client, 'propose_correction', {
      node_id: 'pref-naming',
      patch: { statement: 'database tables use singular snake case names in the warehouse' },
      reason: 'the team switched to singular table names last sprint'
    })
    expect(reply.isError).toBe(false)
    expect(reply.body.staged).toBe(true)
    expect(reply.body.targetLabel).toBe('Preference')
    expect(reply.body.status).toBe('staged')

    const row = stack.appData.db
      .prepare('SELECT * FROM staged_writes WHERE id = ?')
      .get(reply.body.stagedWriteId) as {
      proposed_by: string
      kind: string
      target_label: string
      target_id: string
      payload_json: string
      status: string
    }
    expect(row.kind).toBe('propose_correction')
    expect(row.target_label).toBe('Preference')
    expect(row.target_id).toBe('pref-naming')
    expect(row.status).toBe('staged')
    expect(row.proposed_by).toBe(`claude-mcp:${clientTransport.sessionId}`)
    const payload = JSON.parse(row.payload_json) as { patch: Record<string, string>; reason: string }
    expect(payload.patch['statement']).toContain('singular snake case')
    expect(payload.reason).toContain('last sprint')

    // The graph is untouched: zero write-lane jobs and the node is unchanged.
    expect(store.engine.lane.enqueuedCount).toBe(writesBefore)
    const node = await store.engine.cypher('MATCH (p:Preference {id: $id}) RETURN p.statement AS s', {
      id: 'pref-naming'
    })
    expect(node[0]?.['s']).toBe('database tables use snake case plural names in the warehouse')
  })

  it('rejects unknown nodes (NOT_FOUND) without staging anything', async () => {
    const before = (stack.appData.db.prepare('SELECT count(*) AS c FROM staged_writes').get() as { c: number }).c
    const reply = await call(client, 'propose_correction', {
      node_id: 'ghost-node',
      patch: { statement: 'x' },
      reason: 'y'
    })
    expect(reply.isError).toBe(true)
    expect(reply.body.error.code).toBe('NOT_FOUND')
    const after = (stack.appData.db.prepare('SELECT count(*) AS c FROM staged_writes').get() as { c: number }).c
    expect(after).toBe(before)
  })

  it('rejects patches on identity/provenance fields (INVALID_INPUT)', async () => {
    const reply = await call(client, 'propose_correction', {
      node_id: 'pref-naming',
      patch: { id: 'evil-rename', statement: 'x' },
      reason: 'y'
    })
    expect(reply.isError).toBe(true)
    expect(reply.body.error.code).toBe('INVALID_INPUT')
    expect(reply.body.error.message).toContain('id')
  })
})

describe('ingest_document over MCP end-to-end (phase-06 DoD)', () => {
  const NOTE = [
    '# Rollout runbook',
    'Blue green rollout for the kiosk fleet happens after the smoke checks pass.',
    '',
    '## Rollback',
    'Rollback flips the traffic weight back to the previous kiosk release.'
  ].join('\n')

  it('ingests inline content: Document + chunks + tags land in the graph', async () => {
    const writesBefore = store.engine.lane.enqueuedCount
    const reply = await call(client, 'ingest_document', { path_or_content: NOTE, tags: ['kiosk'] })
    expect(reply.isError).toBe(false)
    expect(reply.body.status).toBe('created')
    // Two headings → two chunks; each paragraph joins its heading's chunk.
    expect(reply.body.chunkCount).toBe(2)
    graphWriteJobsExpected += 1 // the whole ingest is ONE write-lane job
    expect(store.engine.lane.enqueuedCount).toBe(writesBefore + 1)

    const rows = await store.engine.cypher(
      `MATCH (d:Document {id: $id})-[:HAS_CHUNK]->(k:Knowledge)-[:TAGGED]->(t:Tag)
       RETURN k.content AS content, t.name AS tag ORDER BY k.id`,
      { id: reply.body.documentId }
    )
    expect(rows).toHaveLength(reply.body.chunkCount)
    expect(rows.every((r) => r['tag'] === 'kiosk')).toBe(true)
    expect(String(rows[0]?.['content'])).toContain('# Rollout runbook')
  })

  it('identical re-add over MCP is a no-op (content-hash dedup, zero writes)', async () => {
    const writesBefore = store.engine.lane.enqueuedCount
    const reply = await call(client, 'ingest_document', { path_or_content: NOTE, tags: ['kiosk'] })
    expect(reply.isError).toBe(false)
    expect(reply.body.status).toBe('unchanged')
    expect(store.engine.lane.enqueuedCount).toBe(writesBefore)
  })

  it('deferred formats come back as a clean INVALID_INPUT error (and are logged)', async () => {
    const reply = await call(client, 'ingest_document', { path_or_content: 'C:\\docs\\quarterly.pdf' })
    expect(reply.isError).toBe(true)
    expect(reply.body.error.code).toBe('INVALID_INPUT')
    expect(reply.body.error.message).toContain('deferred')
  })

  it('its mcp_calls rows exist: ok ingests + the error, hash always present', () => {
    const rows = stack.appData.db
      .prepare("SELECT result_status, args_hash, params_json FROM mcp_calls WHERE tool = 'ingest_document' ORDER BY id")
      .all() as { result_status: string; args_hash: string; params_json: string | null }[]
    expect(rows.map((r) => r.result_status)).toEqual(['ok', 'ok', 'error'])
    for (const row of rows) {
      expect(row.args_hash).toMatch(/^sha256:[0-9a-f]{64}$/)
      expect(row.params_json).toContain('path_or_content')
    }
  })
})

describe('the MCP client manager consumes this server (§12 client side)', () => {
  it('lists the seven tools through a config entry + keychain secret indirection', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mcp-manager-'))
    try {
      const manager = new McpClientManager({
        configPath: join(dir, 'mcp-servers.json'),
        secrets: (name) => (name === 'mcp.bearerToken' ? BEARER_TOKEN : undefined)
      })
      manager.add({
        name: 'agentic-os-self',
        transport: 'http',
        url: serverUrl,
        bearerTokenSecret: 'mcp.bearerToken'
      })
      const tools = await manager.listTools('agentic-os-self')
      expect(tools.map((t) => t.name).sort()).toEqual([
        'get_context',
        'get_skill',
        'ingest_codebase',
        'ingest_document',
        'list_skills',
        'propose_correction',
        'search_memory'
      ])
      expect(tools.every((t) => typeof t.inputSchema === 'object')).toBe(true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('call log + kernel mediation (the experience backbone, §6/§12)', () => {
  interface CallRow {
    session_id: string
    tool: string
    params_json: string | null
    args_hash: string
    result_status: string
    error: string | null
    started_unix_ms: number
    duration_ms: number
  }

  it('a second session gets its own transport session id in the log', async () => {
    const second = await connect(BEARER_TOKEN)
    const reply = await call(second.client, 'list_skills', {})
    expect(reply.isError).toBe(false)
    const sid = second.transport.sessionId as string
    expect(sid).toBeTruthy()
    expect(sid).not.toBe(clientTransport.sessionId)
    sessionIdsUsed.add(sid)
    const rows = stack.appData.db
      .prepare('SELECT tool FROM mcp_calls WHERE session_id = ?')
      .all(sid) as { tool: string }[]
    expect(rows).toEqual([{ tool: 'list_skills' }])
    await second.client.close()
  })

  it('EVERY tool call in this suite has an mcp_calls row (DoD count assert)', () => {
    if (clientTransport.sessionId) sessionIdsUsed.add(clientTransport.sessionId)
    const rows = stack.appData.db.prepare('SELECT * FROM mcp_calls ORDER BY id').all() as CallRow[]
    expect(rows).toHaveLength(callsMade)
    expect(rows.filter((r) => r.result_status === 'error')).toHaveLength(errorCallsMade)
    for (const row of rows) {
      expect(sessionIdsUsed.has(row.session_id)).toBe(true)
      expect(row.tool.length).toBeGreaterThan(0)
      expect(row.args_hash).toMatch(/^sha256:[0-9a-f]{64}$/)
      expect(row.started_unix_ms).toBeGreaterThan(0)
      expect(row.duration_ms).not.toBeNull()
      expect(['ok', 'error']).toContain(row.result_status)
      if (row.result_status === 'error') expect(row.error).toBeTruthy()
      else expect(row.error).toBeNull()
    }
  })

  it('every tool call also ran through kernel.execute (span per call)', () => {
    const spans = spanRows(stack.appData, 'kernel.mcp-call')
    expect(spans).toHaveLength(callsMade)
    for (const span of spans) {
      const attrs = spanAttributes(span)
      expect(String(attrs['agent.id'])).toMatch(/^mcp:/)
      expect(sessionIdsUsed.has(String(attrs['mcp.session_id']))).toBe(true)
      expect(typeof attrs['action.name']).toBe('string')
    }
    const errorSpans = spans.filter((s) => s.status === 'error')
    expect(errorSpans).toHaveLength(errorCallsMade)
  })

  it('graph writes came ONLY from ingest_document lane jobs (§21 rules 1+6)', () => {
    // propose_correction and every read tool wrote nothing; the sanctioned
    // §18 ingestion path accounts for every lane job after seeding.
    expect(store.engine.lane.enqueuedCount).toBe(writesAfterSeeding + graphWriteJobsExpected)
  })
})

describe('searchMemory (module surface behind search_memory)', () => {
  it('defaults to all four retrievable labels and k=8', async () => {
    const hits = await searchMemory(retrieval, 'deploy the aurora storefront checkout')
    expect(hits.length).toBeGreaterThan(0)
    expect(hits.length).toBeLessThanOrEqual(8)
    expect(hits.map((h) => h.id)).toContain('s-deploy')
    for (const hit of hits) {
      expect(['Project', 'Skill', 'Preference', 'Knowledge']).toContain(hit.label)
      expect(hit.text.length).toBeGreaterThan(0)
      expect(hit.signals.graph).toBe(0) // no expansion in direct search
    }
  })

  it('validates inputs loudly', async () => {
    await expect(searchMemory(retrieval, '  ')).rejects.toThrow(/non-empty/)
    await expect(searchMemory(retrieval, 'x', { labels: ['Component'] })).rejects.toThrow(/unknown label/)
    await expect(searchMemory(retrieval, 'x', { k: 0 })).rejects.toThrow(/k must be/)
    await expect(searchMemory(retrieval, 'x', { k: 31 })).rejects.toThrow(/k must be/)
  })

  it('orders by rerank score descending', async () => {
    const hits = await searchMemory(retrieval, 'postgres autovacuum warehouse ingest spikes', { k: 5 })
    const scores = hits.map((h) => h.rerankScore)
    expect([...scores].sort((a, b) => b - a)).toEqual(scores)
    expect(hits[0]?.id).toBe('k-vacuum')
  })
})
