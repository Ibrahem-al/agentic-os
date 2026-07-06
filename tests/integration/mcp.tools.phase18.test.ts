/**
 * Phase-18 DoD (Stream B — the staged-write + control MCP tools) over a REAL
 * SDK client against the real Streamable HTTP server + a real DurableTaskQueue:
 *
 *  - propose_extraction stages a commitExtraction-VALID payload (server-stamped
 *    provenance) that approves into the graph;
 *  - submit_extraction_items writes runner_submissions (the delegate's exact
 *    camelCase shape) + synthesizes the continuation task, idempotently;
 *  - propose_skill_revision schedules a benchmark (never self-certifies) and
 *    refuses on a pending review / identical revision / wrong name / unknown id;
 *  - each control tool (run_extraction / run_maintenance / retry_task /
 *    scan_watched_folder) maps to its op idempotently;
 *  - propose_skill_revision's providedCandidate BYPASSES the rewrite LLM (no
 *    cloud rewrite call) yet still rides the benchmark + §17 gate to 'staged'.
 *
 * Offline: deterministic fakes for embedder/reranker/critic; the HTTP hop, the
 * queue mirror, the knowledge pipeline and the skill workflow are real.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { AgenticOsMcpServer } from '../../src/main/mcp'
import { createRetriever, type RetrievalDeps, type Retriever, type SmallLlm } from '../../src/main/retrieval'
import { DurableTaskQueue } from '../../src/main/triggers'
import { WatchedFolderStore } from '../../src/main/ingest'
import { LangGraphRunner } from '../../src/main/kernel'
import { SpendMeter } from '../../src/main/models'
import {
  approveStagedWrite,
  AuditLog,
  type StagedWritesDeps
} from '../../src/main/security'
import {
  candidateVersionIdOf,
  createSkillImprovementAgent,
  stagedWriteIdOf,
  type SkillCloud
} from '../../src/main/agents'
import { openKernelStack, type KernelTestStack } from '../fixtures/kernel-helpers'
import { fakeTextEmbedding } from '../fixtures/graph-seed'
import { FakeEmbedder, FakeReranker } from '../fixtures/retrieval-fakes'
import { FakeExtractionEmbedder } from '../fixtures/extraction-fakes'
import { FakeSkillCloudBrain, ScriptedSkillLlm, skillMdOf } from '../fixtures/skill-fakes'
import { openTestStore, type TestStore } from './helpers'

const BEARER_TOKEN = 'phase18-bearer'
const RUNNER_TOKEN = 'phase18-runner'
const passingCritic: SmallLlm = { generate: async () => ({ text: '{"score": 10, "missing": "none"}' }) }
const fakeSummarizer: SmallLlm = { generate: async () => ({ text: 'a summary' }) }

interface ToolReply {
  isError: boolean
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  body: any
}

// ── describe 1: the tools over a real MCP client ─────────────────────────────

describe('phase-18 staging + control tools (real MCP client)', () => {
  let store: TestStore
  let stack: KernelTestStack
  let audit: AuditLog
  let queue: DurableTaskQueue
  let server: AgenticOsMcpServer
  let serverUrl: string
  let client: Client
  let clientTransport: StreamableHTTPClientTransport
  let watchDir: string
  let watchConfigDir: string
  const SKILL_MD = skillMdOf('release-notes', 'Draft release notes.', 'Keep sentences short.')

  const db = (): typeof stack.appData.db => stack.appData.db
  const sid = (): string => clientTransport.sessionId as string

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
    audit = new AuditLog({ db: stack.appData.db, backupsDir: store.backupsDir, engine: store.engine })
    // Seed a Session (edge endpoint) + a skill (propose_skill_revision target).
    await store.engine.upsertNode('Session', { id: 'sess-x' })
    await store.engine.upsertNode('Skill', {
      id: 'sk-notes',
      name: 'release-notes',
      instructions: SKILL_MD,
      current_version: '',
      embedding: fakeTextEmbedding('release-notes')
    })

    const retrieval: RetrievalDeps = { engine: store.engine, embedder: new FakeEmbedder(), reranker: new FakeReranker() }
    const retriever: Retriever = createRetriever({ ...retrieval, llm: passingCritic })
    queue = new DurableTaskQueue({ db: stack.appData.db }) // deliberately NOT started — enqueue just mirrors rows
    queue.registerHandler('test-retry', async () => undefined) // for the retry_task test
    // A deferred task retry_task can re-run.
    stack.appData.db
      .prepare(`INSERT INTO tasks (id, kind, payload_json, status, priority) VALUES ('def-1', 'test-retry', '{}', 'deferred', 0)`)
      .run()

    watchDir = mkdtempSync(join(tmpdir(), 'phase18-watch-'))
    watchConfigDir = mkdtempSync(join(tmpdir(), 'phase18-cfg-'))
    writeFileSync(join(watchDir, 'note.md'), '# Watched note\nIngested by scan_watched_folder.\n', 'utf8')
    const watchStore = new WatchedFolderStore({ configPath: join(watchConfigDir, 'watched.json') })
    watchStore.add({ name: 'docs', path: watchDir, tags: ['watched'] })

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
    server.setReadContext({ queue, watchedFolders: watchStore })
    await server.start()
    serverUrl = server.url
    const transport = new StreamableHTTPClientTransport(new URL(serverUrl), {
      requestInit: { headers: { Authorization: `Bearer ${BEARER_TOKEN}` } }
    })
    client = new Client({ name: 'phase18-client', version: '0.0.1' })
    await client.connect(transport)
    clientTransport = transport
  })

  afterAll(async () => {
    await client.close().catch(() => undefined)
    await server.stop()
    stack.cleanup()
    await store.cleanup()
    rmSync(watchDir, { recursive: true, force: true })
    rmSync(watchConfigDir, { recursive: true, force: true })
  })

  it('propose_extraction stages a provenance-stamped payload that approves into the graph', async () => {
    const reply = await call('propose_extraction', {
      op: 'create',
      node: { label: 'Component', id: 'comp-checkout', props: { name: 'CheckoutForm', type: 'component' } },
      edges: [{ type: 'EXTRACTED_FROM', from: { label: 'Component', id: 'comp-checkout' }, to: { label: 'Session', id: 'sess-x' } }],
      confidence: 0.9,
      evidence: 'built the checkout form',
      reason: 'the session created the checkout component'
    })
    expect(reply.isError).toBe(false)
    expect(reply.body.staged).toBe(true)
    expect(reply.body.targetLabel).toBe('Component')
    expect(reply.body.targetId).toBe('comp-checkout')

    const row = db()
      .prepare('SELECT proposed_by, kind, payload_json FROM staged_writes WHERE id = ?')
      .get(reply.body.stagedWriteId) as { proposed_by: string; kind: string; payload_json: string }
    expect(row.kind).toBe('extraction')
    expect(row.proposed_by).toBe(`claude-mcp:${sid()}`)
    const payload = JSON.parse(row.payload_json) as {
      provenance: { extracted_by: string; confidence: number }
      node: { props: Record<string, unknown> }
      edges: { props: { extracted_by: string } }[]
    }
    // Provenance is stamped SERVER-SIDE (never the caller): top-level, on the
    // Component node props (it carries the §18 columns) and on every edge.
    expect(payload.provenance.extracted_by).toBe('extraction@0.0.1/llm-subscription')
    expect(payload.node.props['extracted_by']).toBe('extraction@0.0.1/llm-subscription')
    expect(payload.node.props['confidence']).toBe(0.9)
    expect(payload.edges[0]?.props.extracted_by).toBe('extraction@0.0.1/llm-subscription')

    // Approving it commits through the audited lane — proof the payload is valid.
    const deps: StagedWritesDeps = { db: db(), engine: store.engine, audit, embedder: new FakeEmbedder() }
    await approveStagedWrite(deps, reply.body.stagedWriteId, { decidedBy: 'user:test' })
    const nodeRows = await store.engine.cypher(
      'MATCH (c:Component {id: $id})-[:EXTRACTED_FROM]->(s:Session {id: "sess-x"}) RETURN c.name AS name, c.extracted_by AS by',
      { id: 'comp-checkout' }
    )
    expect(nodeRows[0]?.['name']).toBe('CheckoutForm')
    expect(nodeRows[0]?.['by']).toBe('extraction@0.0.1/llm-subscription')
  })

  it('propose_extraction rejects an empty proposal (no node, no edges)', async () => {
    const reply = await call('propose_extraction', { op: 'merge', reason: 'nothing here' })
    expect(reply.isError).toBe(true)
    expect(reply.body.error.code).toBe('INVALID_INPUT')
  })

  const SUBMIT = {
    session_id: 'sess-sub',
    components: [{ name: 'PaymentService', type: 'service', depends_on: ['Ledger'], evidence: 'built payments', confidence: 0.8 }],
    preferences: [{ statement: 'prefer pnpm over npm', tags: ['tooling'], confidence: 0.9 }],
    corrections: [{ content: 'do not use var', skill: null, confidence: 0.85 }]
  }

  it('submit_extraction_items writes runner_submissions + synthesizes the continuation task', async () => {
    const reply = await call('submit_extraction_items', SUBMIT)
    expect(reply.isError).toBe(false)
    expect(reply.body.submitted).toBe(3)
    expect(reply.body.inserted).toBe(3)
    expect(reply.body.boundToRunnerTask).toBe(false)
    const taskId: string = reply.body.taskId
    expect(taskId).toMatch(/^extract-cont-sess-sub-[0-9a-f]{8}$/)
    expect(reply.body.continuationTaskId).toBe(taskId)

    const subs = db()
      .prepare('SELECT kind, session_id, task_id, payload_json FROM runner_submissions WHERE task_id = ? ORDER BY kind')
      .all(taskId) as { kind: string; session_id: string; task_id: string; payload_json: string }[]
    expect(subs.map((s) => s.kind)).toEqual(['component', 'correction', 'preference'])
    expect(subs.every((s) => s.session_id === 'sess-sub')).toBe(true)
    // The delegate reads the ALREADY-normalized camelCase ExtractedX shape back.
    const comp = JSON.parse(subs.find((s) => s.kind === 'component')!.payload_json) as Record<string, unknown>
    expect(comp['name']).toBe('PaymentService')
    expect(comp['dependsOn']).toEqual(['Ledger']) // snake_case in → camelCase stored
    expect(comp['confidence']).toBe(0.8)

    // The continuation task the delegate consumes: kind 'extraction', { continuation }.
    const task = db().prepare('SELECT kind, payload_json FROM tasks WHERE id = ?').get(taskId) as {
      kind: string
      payload_json: string
    }
    expect(task.kind).toBe('extraction')
    expect(JSON.parse(task.payload_json)).toMatchObject({ continuation: true, sessionId: 'sess-sub' })
  })

  it('submit_extraction_items is idempotent — re-submitting the same batch dedups', async () => {
    const reply = await call('submit_extraction_items', SUBMIT)
    expect(reply.isError).toBe(false)
    expect(reply.body.inserted).toBe(0) // INSERT OR IGNORE — nothing new
    expect(reply.body.deduped).toBe(true) // the continuation task already exists
    const count = db()
      .prepare('SELECT count(*) AS c FROM runner_submissions WHERE task_id = ?')
      .get(reply.body.taskId) as { c: number }
    expect(count.c).toBe(3) // no duplicate rows
  })

  it('submit_extraction_items rejects a batch with no valid items', async () => {
    const reply = await call('submit_extraction_items', { session_id: 'sess-empty' })
    expect(reply.isError).toBe(true)
    expect(reply.body.error.code).toBe('INVALID_INPUT')
  })

  it('propose_skill_revision schedules a benchmark task (never self-certifies)', async () => {
    const revised = skillMdOf('release-notes', 'Draft release notes.', 'Keep sentences short and friendly.')
    const reply = await call('propose_skill_revision', { skill_id: 'sk-notes', skill_md: revised })
    expect(reply.isError).toBe(false)
    expect(reply.body.scheduled).toBe(true)
    const expectedVersion = candidateVersionIdOf('sk-notes', revised)
    expect(reply.body.candidateVersionId).toBe(expectedVersion)

    const task = db().prepare('SELECT kind, priority, payload_json FROM tasks WHERE id = ?').get(reply.body.taskId) as {
      kind: string
      priority: number
      payload_json: string
    }
    expect(task.kind).toBe('skill-improvement')
    expect(task.priority).toBeGreaterThan(500) // user band, not background
    const payload = JSON.parse(task.payload_json) as { skillId: string; providedCandidate: Record<string, string> }
    expect(payload.skillId).toBe('sk-notes')
    expect(payload.providedCandidate['instructions']).toBe(revised)
    expect(payload.providedCandidate['proposedBy']).toBe(`claude-mcp:${sid()}`)

    // Only SCHEDULED — the graph skill is untouched (adoption is the gate's job).
    const skill = await store.engine.cypher('MATCH (s:Skill {id: "sk-notes"}) RETURN s.instructions AS i')
    expect(skill[0]?.['i']).toBe(SKILL_MD)
  })

  it('propose_skill_revision refuses identical / wrong-name / unknown inputs', async () => {
    const identical = await call('propose_skill_revision', { skill_id: 'sk-notes', skill_md: SKILL_MD })
    expect(identical.body.error.code).toBe('INVALID_INPUT')
    const wrongName = await call('propose_skill_revision', {
      skill_id: 'sk-notes',
      skill_md: skillMdOf('other-name', 'x.', 'Different body.')
    })
    expect(wrongName.body.error.code).toBe('INVALID_INPUT')
    const unknown = await call('propose_skill_revision', { skill_id: 'nope', skill_md: SKILL_MD })
    expect(unknown.body.error.code).toBe('NOT_FOUND')
  })

  it('propose_skill_revision returns INVALID_STATE when a candidate is already awaiting review', async () => {
    await store.engine.upsertNode('Skill', {
      id: 'sk-pending',
      name: 'pending-skill',
      instructions: skillMdOf('pending-skill', 'x.', 'Body.'),
      current_version: '',
      embedding: fakeTextEmbedding('pending')
    })
    db()
      .prepare(
        `INSERT INTO staged_writes (id, proposed_by, kind, target_label, target_id, payload_json)
         VALUES ('sw-pending', 'skill-improvement-agent', 'skill-improvement', 'Skill', 'sk-pending', '{}')`
      )
      .run()
    const reply = await call('propose_skill_revision', {
      skill_id: 'sk-pending',
      skill_md: skillMdOf('pending-skill', 'x.', 'A different body.')
    })
    expect(reply.isError).toBe(true)
    expect(reply.body.error.code).toBe('INVALID_STATE')
  })

  it('run_extraction enqueues (origin mcp) and is exactly-once per session', async () => {
    const first = await call('run_extraction', { session_id: 'sess-run', transcript_path: '/tmp/t.jsonl' })
    expect(first.isError).toBe(false)
    expect(first.body.deduped).toBe(false)
    expect(first.body.taskId).toBe('extract-sess-run')
    const task = db().prepare('SELECT kind, payload_json FROM tasks WHERE id = ?').get('extract-sess-run') as {
      kind: string
      payload_json: string
    }
    expect(task.kind).toBe('extraction')
    expect(JSON.parse(task.payload_json)).toMatchObject({ sessionId: 'sess-run', origin: 'mcp' })
    const second = await call('run_extraction', { session_id: 'sess-run' })
    expect(second.body.deduped).toBe(true) // §6 exactly-once
    expect(second.body.taskId).toBe('extract-sess-run')
  })

  it('improve_skill_now enqueues a skill-improvement task', async () => {
    const reply = await call('improve_skill_now', { skill_id: 'sk-notes' })
    expect(reply.isError).toBe(false)
    expect(reply.body.scheduled).toBe(true)
    const task = db().prepare('SELECT kind FROM tasks WHERE id = ?').get(reply.body.taskId) as { kind: string }
    expect(task.kind).toBe('skill-improvement')
  })

  it('run_maintenance fires a prune job, deduped within the minute', async () => {
    const first = await call('run_maintenance', { job: 'prune' })
    expect(first.isError).toBe(false)
    expect(first.body.deduped).toBe(false)
    const task = db().prepare('SELECT kind FROM tasks WHERE id = ?').get(first.body.taskId) as { kind: string }
    expect(task.kind).toBe('prune')
    const second = await call('run_maintenance', { job: 'prune' })
    expect(second.body.taskId).toBe(first.body.taskId) // same fire-minute id
    expect(second.body.deduped).toBe(true)
    const bad = await call('run_maintenance', { job: 'vacuum' })
    expect(bad.body.error.code).toBe('INVALID_INPUT') // only prune|export
  })

  it('retry_task re-runs a deferred task, then refuses (NOT_FOUND / INVALID_STATE)', async () => {
    const missing = await call('retry_task', { task_id: 'ghost' })
    expect(missing.body.error.code).toBe('NOT_FOUND')
    const ok = await call('retry_task', { task_id: 'def-1' })
    expect(ok.isError).toBe(false)
    expect(ok.body.status).toBe('pending')
    const again = await call('retry_task', { task_id: 'def-1' })
    expect(again.body.error.code).toBe('INVALID_STATE') // already re-queued
  })

  it('scan_watched_folder ingests the folder, then is a zero-write no-op', async () => {
    const first = await call('scan_watched_folder', { name: 'docs' })
    expect(first.isError).toBe(false)
    expect(first.body.folder).toBe('docs')
    expect(first.body.ingested.some((r: { status: string }) => r.status === 'created')).toBe(true)
    const second = await call('scan_watched_folder', { name: 'docs' })
    expect(second.body.ingested.every((r: { status: string }) => r.status === 'unchanged')).toBe(true)
    const missing = await call('scan_watched_folder', { name: 'no-such' })
    expect(missing.body.error.code).toBe('NOT_FOUND')
  })
})

// ── describe 2: propose_skill_revision's providedCandidate bypasses the rewrite ─

describe('propose_skill_revision providedCandidate bypasses the rewrite LLM', () => {
  let store: TestStore
  let stack: KernelTestStack
  let audit: AuditLog

  beforeAll(async () => {
    store = await openTestStore()
    stack = openKernelStack()
    audit = new AuditLog({ db: stack.appData.db, backupsDir: store.backupsDir, engine: store.engine })
  })

  afterAll(async () => {
    stack.cleanup()
    await store.cleanup()
  })

  it('uses the provided candidate (recomputed id), never calls cloud rewrite, and stages via the gate', async () => {
    const v0 = 'Draft release notes.'
    await store.engine.upsertNode('Skill', {
      id: 'sr',
      name: 'release-notes',
      instructions: v0,
      current_version: '',
      embedding: fakeTextEmbedding('sr')
    })
    await store.engine.upsertNode('Correction', { id: 'sr-c1', content: 'use shorter sentences' })
    await store.engine.createEdge('IMPROVED', { label: 'Correction', id: 'sr-c1' }, { label: 'Skill', id: 'sr' })

    const provided = skillMdOf('release-notes', 'Draft release notes.', 'CANDMARK: use short sentences.\nKeep it friendly.')
    // The cloud scripts ONLY testset + comparator. rewriteByName is DELIBERATELY
    // omitted: if the rewrite LLM were called the fake would throw — so a clean
    // run proves the provided candidate bypassed it.
    const brain = new FakeSkillCloudBrain({
      casesByName: { 'release-notes': '[{"prompt": "Notes for v2.", "expectations": ["short"]}]' },
      compare: (a, b) => (a.includes('CANDMARK') ? 'A' : b.includes('CANDMARK') ? 'B' : 'TIE')
    })
    const cloud: SkillCloud = { brain, meter: new SpendMeter({ db: stack.appData.db }) }
    const runner = new LangGraphRunner({ db: stack.appData.db, telemetry: stack.telemetry, executor: stack.kernel })
    const agent = createSkillImprovementAgent({
      engine: store.engine,
      db: stack.appData.db,
      runner,
      embedder: new FakeExtractionEmbedder(),
      llm: new ScriptedSkillLlm({ grade: () => false }),
      cloud,
      audit
    })

    const result = await agent.runImprovement({
      skillId: 'sr',
      jobId: 'job-sr',
      // A deliberately WRONG versionId to prove it is recomputed from content.
      providedCandidate: { skillId: 'sr', versionId: 'sv-bogus', instructions: provided, proposedBy: 'claude-mcp:test' }
    })

    const processed = result.processed[0]!
    // Stylistic default → staged for one-click review, NEVER auto-adopted.
    expect(processed.outcome).toBe('staged')
    const expectedVersion = candidateVersionIdOf('sr', provided)
    expect(processed.candidateVersionId).toBe(expectedVersion) // recomputed, not 'sv-bogus'
    expect(processed.stagedWriteId).toBe(stagedWriteIdOf(expectedVersion))

    // The rewrite LLM was BYPASSED (the whole point): no 'rewrite' cloud call.
    expect(brain.calls.filter((c) => c.kind === 'rewrite')).toHaveLength(0)
    // …but the benchmark still ran the blind comparator on the provided candidate.
    expect(brain.calls.filter((c) => c.kind === 'compare').length).toBeGreaterThan(0)

    // The graph skill is untouched; the candidate carries the provided body.
    const skill = await store.engine.cypher('MATCH (s:Skill {id: "sr"}) RETURN s.instructions AS i, s.current_version AS v')
    expect(skill[0]?.['i']).toBe(v0)
    expect(skill[0]?.['v'] === '' || skill[0]?.['v'] === null).toBe(true)
    const staged = stack.appData.db
      .prepare('SELECT payload_json FROM staged_writes WHERE id = ?')
      .get(processed.stagedWriteId) as { payload_json: string }
    const payload = JSON.parse(staged.payload_json) as Record<string, unknown>
    expect(payload['candidateInstructions']).toBe(provided)
  }, 60_000)
})
