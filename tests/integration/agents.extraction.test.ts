/**
 * Phase-08 DoD over the REAL storage engine + kernel stack (offline: scripted
 * local LLM / fake cloud brain / bag-of-words embedder; live gate at the end):
 *
 * - 3 golden fixture sessions (synthetic mcp_calls + JSONL transcripts) →
 *   asserted nodes/edges INCLUDING provenance fields;
 * - entity resolution: near-duplicate Preference merges (cosine + LLM
 *   tiebreak bands), novel one creates;
 * - low-confidence path lands in staged_writes, NOT the graph (no cloud and
 *   verifier-rejected variants);
 * - the workflow resumes after a simulated crash between passes, without
 *   re-running earlier passes' model calls;
 * - all graph writes ride ONE write-lane job per run (§21 rule 1).
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  createExtractionAgent,
  ExtractionUnavailableError,
  sessionNodeIdOf,
  type ExtractionAgent,
  type ExtractionCloud,
  type ExtractionEmbedder,
  type ExtractionLlm
} from '../../src/main/agents'
import { EXTRACTION_PROVENANCE } from '../../src/main/config'
import { rootKeyOf } from '../../src/main/ingest'
import { LangGraphRunner, WorkflowJobError } from '../../src/main/kernel'
import { OllamaClient, SpendMeter } from '../../src/main/models'
import type { StorageEngine } from '../../src/main/storage'
import { DurableTaskQueue, enqueueExtraction, extractionTaskId, registerExtractionHandler } from '../../src/main/triggers'
import {
  FailingOnceEmbedder,
  FakeCloudBrain,
  FakeExtractionEmbedder,
  ScriptedExtractionLlm,
  assistantRecord,
  insertMcpCalls,
  transcriptJsonl,
  userRecord
} from '../fixtures/extraction-fakes'
import { fakeTextEmbedding } from '../fixtures/graph-seed'
import { openKernelStack, type KernelTestStack } from '../fixtures/kernel-helpers'
import { openTestStore, type TestStore } from './helpers'

const T = (minutes: number): string => new Date(Date.parse('2026-07-01T09:00:00.000Z') + minutes * 60_000).toISOString()
const TMS = (minutes: number): number => Date.parse(T(minutes))

let storeA: TestStore
let stackA: KernelTestStack
let transcriptDir: string
const cwdAurora = join(tmpdir(), 'extraction-fixture', 'aurora')
let auroraProjectId: string

function writeTranscript(name: string, records: readonly (Record<string, unknown> | string)[]): string {
  const path = join(transcriptDir, name)
  writeFileSync(path, transcriptJsonl(records), 'utf8')
  return path
}

/** Fresh runner per agent instance (define() is once-per-runner). */
function makeAgent(
  store: TestStore,
  stack: KernelTestStack,
  models: { llm: ExtractionLlm; embedder?: ExtractionEmbedder; cloud?: ExtractionCloud | null }
): ExtractionAgent {
  const runner = new LangGraphRunner({ db: stack.appData.db, telemetry: stack.telemetry, executor: stack.kernel })
  return createExtractionAgent({
    engine: store.engine,
    db: stack.appData.db,
    runner,
    embedder: models.embedder ?? new FakeExtractionEmbedder(),
    llm: models.llm,
    cloud: models.cloud ?? null
  })
}

async function nodeCount(engine: StorageEngine, label: string, where = '', params = {}): Promise<number> {
  const rows = await engine.cypher(`MATCH (n:${label}) ${where} RETURN count(n) AS c`, params)
  return Number(rows[0]?.['c'] ?? 0)
}

async function edgeStamp(
  engine: StorageEngine,
  fromLabel: string,
  fromId: string,
  type: string,
  toLabel: string,
  toId: string
): Promise<{ extracted_by: string; confidence: number } | null> {
  const rows = await engine.cypher(
    `MATCH (a:${fromLabel} {id: $f})-[r:${type}]->(b:${toLabel} {id: $t})
     RETURN r.extracted_by AS eb, r.confidence AS c`,
    { f: fromId, t: toId }
  )
  const row = rows[0]
  if (!row) return null
  return { extracted_by: String(row['eb']), confidence: Number(row['c']) }
}

const stagedRows = (proposedBy: string): { id: string; kind: string; target_label: string; target_id: string; status: string; payload_json: string }[] =>
  stackA.appData.db
    .prepare(`SELECT id, kind, target_label, target_id, status, payload_json FROM staged_writes WHERE proposed_by = ? ORDER BY target_label`)
    .all(proposedBy) as never

beforeAll(async () => {
  storeA = await openTestStore()
  stackA = openKernelStack()
  transcriptDir = mkdtempSync(join(tmpdir(), 'agentic-os-extraction-'))
  auroraProjectId = `proj-${rootKeyOf(cwdAurora)}`

  // Seeds: one Skill the sessions use, and the aurora Project as a phase-07
  // codebase ingest would have left it (path-derived id + embedding).
  await storeA.engine.upsertNode('Skill', {
    id: 's-deploy',
    name: 'deploy-web',
    instructions: 'Deploy web apps safely with preview environments.',
    embedding: fakeTextEmbedding('deploy-web: Deploy web apps safely with preview environments.')
  })
  await storeA.engine.upsertNode('Project', {
    id: auroraProjectId,
    name: 'aurora',
    summary: 'Greenhouse storefront web app.',
    embedding: fakeTextEmbedding('aurora — Greenhouse storefront web app.')
  })
}, 60_000)

afterAll(async () => {
  await storeA.cleanup()
  stackA.cleanup()
  rmSync(transcriptDir, { recursive: true, force: true })
})

// ─────────────────────────────────────────────────────────────────────────────
// Golden 2 — greenfield session: >60k-token transcript escalates to the cloud;
// the Project is created from cwd. Runs FIRST: the graph has no Preference yet,
// which also exercises resolution's empty-vector-index path. (One store for the
// whole file — closing a ryugraph store mid-file trips the 25.9.1 native
// teardown fault, phase-01 finding 3.)
// ─────────────────────────────────────────────────────────────────────────────

describe('golden session 2 — greenfield + cloud escalation (transcript > 60k tokens)', () => {
  const sessionId = 's2-greenfield'
  const sessionNodeId = sessionNodeIdOf(sessionId)
  const cwdNimbus = join(tmpdir(), 'extraction-fixture', 'nimbus-tracker')
  let cloudBrain: FakeCloudBrain
  let localLlm: ScriptedExtractionLlm
  let result: Awaited<ReturnType<ExtractionAgent['runExtraction']>>

  beforeAll(async () => {
    insertMcpCalls(stackA.appData.db, [
      { sessionId, tool: 'get_context', params: { task: 'build the nimbus tracker' }, startedUnixMs: TMS(0) }
    ])
    const filler = Array.from({ length: 400 }, (_, i) =>
      userRecord(
        `Progress note ${i}: ${'the nimbus flight tracker ingests aviation data and renders live maps for dispatchers '.repeat(8)}`,
        i === 0 ? { cwd: cwdNimbus, timestamp: T(0), sessionId } : { timestamp: T(i % 90) }
      )
    )
    const transcriptPath = writeTranscript('s2.jsonl', [
      ...filler,
      assistantRecord('Building the gateway now.', [{ name: 'mcp__github__create_issue', input: { title: 'gateway' } }], {
        timestamp: T(95)
      })
    ])
    cloudBrain = new FakeCloudBrain({
      components:
        '[{"name": "flight api gateway", "type": "service", "depends_on": [], "evidence": "building the gateway", "confidence": 0.95}]',
      preferences:
        '[{"statement": "Prefer supabase for authentication flows", "tags": ["auth"], "derived_from": null, "evidence": "prefer supabase", "confidence": 0.9}]',
      corrections: '[]'
    })
    // The local tier THROWS on any extraction pass: gate A must bypass it.
    localLlm = new ScriptedExtractionLlm({}, { failExtraction: true })
    const agent = makeAgent(storeA, stackA, {
      llm: localLlm,
      cloud: { brain: cloudBrain, meter: new SpendMeter({ db: stackA.appData.db }) }
    })
    result = await agent.runExtraction(sessionId, { transcriptPath, jobId: 'job-s2' })
  }, 120_000)

  it('escalates to the cloud tier without touching the local extractor', () => {
    expect(result.tier).toBe('cloud')
    expect(result.escalated).toBe(true)
    expect(localLlm.extractionCalls).toHaveLength(0)
    expect(cloudBrain.calls.filter((c) => c.kind !== 'verifier')).toHaveLength(3) // one 100k-token chunk × 3 passes
  })

  it('creates the Project from cwd (deterministic stub summary + real embedding) and PRODUCED', async () => {
    const projectId = `proj-${rootKeyOf(cwdNimbus)}`
    expect(result.committed.project).toBe('created')
    const rows = await storeA.engine.cypher(
      'MATCH (p:Project {id: $id}) RETURN p.name AS name, p.summary AS summary',
      { id: projectId }
    )
    expect(rows[0]!['name']).toBe('nimbus-tracker')
    expect(String(rows[0]!['summary'])).toContain('Project first seen in extraction')
    const hits = await storeA.engine.vectorSearch(
      'Project',
      fakeTextEmbedding(`nimbus-tracker — ${String(rows[0]!['summary'])}`),
      1
    )
    expect(hits[0]?.id).toBe(projectId)
    expect(hits[0]!.distance).toBeLessThan(0.001)
    expect(await edgeStamp(storeA.engine, 'Session', sessionNodeId, 'PRODUCED', 'Project', projectId)).not.toBeNull()
    expect(await edgeStamp(storeA.engine, 'Project', projectId, 'TAGGED', 'Tag', 'tag-nimbus-tracker')).not.toBeNull()
  })

  it('commits the cloud-extracted items with llm-cloud provenance', async () => {
    const compRows = await storeA.engine.cypher(
      'MATCH (c:Component) WHERE c.name = $n RETURN c.extracted_by AS eb, c.confidence AS conf',
      { n: 'flight api gateway' }
    )
    expect(compRows.map((r) => [r['eb'], r['conf']])).toEqual([[`${EXTRACTION_PROVENANCE}/llm-cloud`, 0.95]])
    const prefRows = await storeA.engine.cypher(
      'MATCH (p:Preference) WHERE p.statement = $s RETURN p.id AS id, p.extracted_by AS eb, p.confidence AS conf',
      { s: 'Prefer supabase for authentication flows' }
    )
    expect(prefRows).toHaveLength(1)
    expect(prefRows[0]).toMatchObject({ eb: `${EXTRACTION_PROVENANCE}/llm-cloud`, conf: 0.9 })
    const tagRows = await storeA.engine.cypher(
      'MATCH (p:Preference {id: $id})-[:APPLIES_TO]->(t:Tag) RETURN t.id AS id ORDER BY t.id',
      { id: String(prefRows[0]!['id']) }
    )
    expect(tagRows.map((r) => r['id'])).toEqual(['tag-auth', 'tag-nimbus-tracker'])
    expect(await edgeStamp(storeA.engine, 'Session', sessionNodeId, 'USED', 'MCP', 'mcp-github')).not.toBeNull()
  })

  it('meters every cloud call against the job task id (§14)', () => {
    const rows = stackA.appData.db
      .prepare(`SELECT provider, model, usd FROM spend WHERE task_id = ?`)
      .all('job-s2') as { provider: string; model: string; usd: number }[]
    expect(rows).toHaveLength(3)
    for (const row of rows) {
      expect(row.provider).toBe('anthropic')
      expect(row.model).toBe('claude-fake-cloud')
      expect(row.usd).toBeGreaterThan(0)
    }
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Golden 1 — feature session: deterministic + fuzzy all high-confidence.
// ─────────────────────────────────────────────────────────────────────────────

describe('golden session 1 — feature work (local tier, everything commits)', () => {
  const sessionId = 's1-feature'
  const sessionNodeId = sessionNodeIdOf(sessionId)
  let agent: ExtractionAgent
  let llm: ScriptedExtractionLlm
  let transcriptPath: string
  let laneDelta: number
  let result: Awaited<ReturnType<ExtractionAgent['runExtraction']>>

  beforeAll(async () => {
    insertMcpCalls(stackA.appData.db, [
      { sessionId, tool: 'get_context', params: { task: 'deploy the aurora storefront' }, startedUnixMs: TMS(5) },
      { sessionId, tool: 'get_skill', params: { name: 'deploy-web' }, startedUnixMs: TMS(6) },
      { sessionId, tool: 'get_skill', params: { name: 'ghost-skill' }, ok: false, startedUnixMs: TMS(7) },
      { sessionId, tool: 'search_memory', params: { query: 'vercel checkout' }, startedUnixMs: TMS(10), durationMs: 500 }
    ])
    transcriptPath = writeTranscript('s1.jsonl', [
      userRecord('Deploy the aurora storefront to vercel and then fix the checkout page validation.', {
        cwd: cwdAurora,
        timestamp: T(0),
        sessionId
      }),
      assistantRecord(
        'Deploying, then fixing the checkout page.',
        [
          { name: 'mcp__vercel__deploy', input: { project: 'aurora' } },
          { name: 'mcp__plugin_sentry_sentry__find_issue', input: { q: 'checkout' } },
          { name: 'Skill', input: { skill: 'deploy-web' } }
        ],
        { timestamp: T(8) }
      ),
      userRecord(
        'No — stop committing directly to main, use a feature branch for deploy fixes. Also, always run the checkout smoke test before deploying.',
        { timestamp: T(12) }
      ),
      assistantRecord('Understood: feature branches and the smoke test from now on.', [{ name: 'Bash', input: { command: 'git checkout -b fix' } }], {
        timestamp: T(30)
      }),
      '{"type": "file-history-snapshot", "snapshot": {}}',
      'not json at all {{{'
    ])
    llm = new ScriptedExtractionLlm({
      components:
        'We looked at the excerpt carefully. Here is the JSON:\n' +
        '[{"name": "checkout page", "type": "page", "depends_on": ["payment service"], "evidence": "fix the checkout page validation", "confidence": 0.9},' +
        ' {"name": "payment service", "type": "service", "depends_on": [], "evidence": "checkout smoke test", "confidence": 0.85}]\nDone.',
      preferences:
        '[{"statement": "Use feature branches instead of committing directly to main", "tags": ["git"], "derived_from": "stop committing directly to main", "evidence": "stop committing directly to main, use a feature branch", "confidence": 0.9},' +
        ' {"statement": "Always run the checkout smoke test before deploying", "tags": ["deploy"], "derived_from": null, "evidence": "always run the checkout smoke test before deploying", "confidence": 0.85}]',
      corrections:
        '[{"content": "Stop committing directly to main and use a feature branch for deploy fixes", "skill": "deploy-web", "evidence": "stop committing directly to main, use a feature branch", "confidence": 0.9}]'
    })
    agent = makeAgent(storeA, stackA, { llm })
    const laneBefore = storeA.engine.lane.enqueuedCount
    result = await agent.runExtraction(sessionId, { transcriptPath })
    laneDelta = storeA.engine.lane.enqueuedCount - laneBefore
  }, 60_000)

  it('creates the Session node with call-log + transcript timing and the transcript ref', async () => {
    const rows = await storeA.engine.cypher(
      'MATCH (s:Session {id: $id}) RETURN s.started_at AS sa, s.ended_at AS ea, s.transcript_ref AS tr, s.tier AS tier',
      { id: sessionNodeId }
    )
    expect(rows).toHaveLength(1)
    expect((rows[0]!['sa'] as Date).toISOString()).toBe(T(0)) // transcript start widened the call window
    expect((rows[0]!['ea'] as Date).toISOString()).toBe(T(30))
    expect(rows[0]!['tr']).toBe(transcriptPath)
    expect(rows[0]!['tier']).toBe('daily')
  })

  it('writes USED edges for the skill (deduped across log + transcript), the MCP and the plugin — deterministic provenance', async () => {
    expect(await edgeStamp(storeA.engine, 'Session', sessionNodeId, 'USED', 'Skill', 's-deploy')).toEqual({
      extracted_by: `${EXTRACTION_PROVENANCE}/deterministic`,
      confidence: 1
    })
    const usedSkills = await storeA.engine.cypher(
      'MATCH (s:Session {id: $id})-[r:USED]->(k:Skill) RETURN k.id AS id',
      { id: sessionNodeId }
    )
    expect(usedSkills).toHaveLength(1) // ghost-skill errored; deploy-web deduped

    const mcpRows = await storeA.engine.cypher(
      'MATCH (s:Session {id: $id})-[:USED]->(m:MCP) RETURN m.id AS mid, m.name AS name ORDER BY m.id',
      { id: sessionNodeId }
    )
    expect(mcpRows.map((r) => [r['mid'], r['name']])).toEqual([['mcp-vercel', 'vercel']])
    expect(await edgeStamp(storeA.engine, 'Session', sessionNodeId, 'USED', 'MCP', 'mcp-vercel')).toEqual({
      extracted_by: `${EXTRACTION_PROVENANCE}/deterministic`,
      confidence: 1
    })
    const pluginRows = await storeA.engine.cypher(
      'MATCH (s:Session {id: $id})-[:USED]->(p:Plugin) RETURN p.id AS pid, p.name AS name',
      { id: sessionNodeId }
    )
    expect(pluginRows.map((r) => [r['pid'], r['name']])).toEqual([['plugin-sentry', 'sentry']])
    expect(await edgeStamp(storeA.engine, 'Session', sessionNodeId, 'USED', 'Plugin', 'plugin-sentry')).not.toBeNull()
  })

  it('matches the Project by cwd path identity and links PRODUCED / USES / TAGGED', async () => {
    expect(result.committed.project).toBe('matched')
    expect(await edgeStamp(storeA.engine, 'Session', sessionNodeId, 'PRODUCED', 'Project', auroraProjectId)).toEqual({
      extracted_by: `${EXTRACTION_PROVENANCE}/deterministic`,
      confidence: 1
    })
    for (const [label, id] of [
      ['Skill', 's-deploy'],
      ['MCP', 'mcp-vercel'],
      ['Plugin', 'plugin-sentry']
    ] as const) {
      expect(await edgeStamp(storeA.engine, 'Project', auroraProjectId, 'USES', label, id)).not.toBeNull()
    }
    // The project's name tag was created by extraction (is_global false) and linked.
    const tagRows = await storeA.engine.cypher('MATCH (t:Tag {id: $id}) RETURN t.name AS name, t.is_global AS g', {
      id: 'tag-aurora'
    })
    expect(tagRows[0]).toMatchObject({ name: 'aurora', g: false })
    expect(await edgeStamp(storeA.engine, 'Project', auroraProjectId, 'TAGGED', 'Tag', 'tag-aurora')).not.toBeNull()
  })

  it('commits Components with llm-local provenance, HAS_COMPONENT, EXTRACTED_FROM and DEPENDS_ON', async () => {
    const rows = await storeA.engine.cypher(
      `MATCH (p:Project {id: $pid})-[:HAS_COMPONENT]->(c:Component)
       RETURN c.id AS id, c.name AS name, c.type AS type, c.extracted_by AS eb, c.confidence AS conf ORDER BY c.name`,
      { pid: auroraProjectId }
    )
    expect(rows.map((r) => [r['name'], r['type'], r['eb'], r['conf']])).toEqual([
      ['checkout page', 'page', `${EXTRACTION_PROVENANCE}/llm-local`, 0.9],
      ['payment service', 'service', `${EXTRACTION_PROVENANCE}/llm-local`, 0.85]
    ])
    const checkoutId = String(rows[0]!['id'])
    const paymentId = String(rows[1]!['id'])
    expect(await edgeStamp(storeA.engine, 'Component', checkoutId, 'EXTRACTED_FROM', 'Session', sessionNodeId)).toEqual({
      extracted_by: `${EXTRACTION_PROVENANCE}/llm-local`,
      confidence: 0.9
    })
    expect(await edgeStamp(storeA.engine, 'Project', auroraProjectId, 'HAS_COMPONENT', 'Component', checkoutId)).toEqual({
      extracted_by: `${EXTRACTION_PROVENANCE}/llm-local`,
      confidence: 0.9
    })
    expect(await edgeStamp(storeA.engine, 'Component', checkoutId, 'DEPENDS_ON', 'Component', paymentId)).toEqual({
      extracted_by: `${EXTRACTION_PROVENANCE}/llm-local`,
      confidence: 0.9
    })
  })

  it('commits Preferences with embeddings (vector-searchable), APPLIES_TO tags and EXTRACTED_FROM', async () => {
    const statement = 'Use feature branches instead of committing directly to main'
    const rows = await storeA.engine.cypher(
      'MATCH (p:Preference) WHERE p.statement = $s RETURN p.id AS id, p.extracted_by AS eb, p.confidence AS conf',
      { s: statement }
    )
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ eb: `${EXTRACTION_PROVENANCE}/llm-local`, conf: 0.9 })
    const prefId = String(rows[0]!['id'])

    // Embedding present AND indexed: the HNSW index returns it at ~zero distance.
    const hits = await storeA.engine.vectorSearch('Preference', fakeTextEmbedding(statement), 1)
    expect(hits[0]?.id).toBe(prefId)
    expect(hits[0]!.distance).toBeLessThan(0.001)

    const tagRows = await storeA.engine.cypher(
      'MATCH (p:Preference {id: $id})-[:APPLIES_TO]->(t:Tag) RETURN t.id AS id ORDER BY t.id',
      { id: prefId }
    )
    expect(tagRows.map((r) => r['id'])).toEqual(['tag-aurora', 'tag-git'])
    expect(await edgeStamp(storeA.engine, 'Preference', prefId, 'EXTRACTED_FROM', 'Session', sessionNodeId)).toEqual({
      extracted_by: `${EXTRACTION_PROVENANCE}/llm-local`,
      confidence: 0.9
    })
  })

  it('commits the explicit Correction with OBSERVED_IN, IMPROVED and DERIVED_FROM lineage', async () => {
    const rows = await storeA.engine.cypher('MATCH (c:Correction) RETURN c.id AS id, c.content AS content')
    expect(rows).toHaveLength(1)
    expect(rows[0]!['content']).toBe('Stop committing directly to main and use a feature branch for deploy fixes')
    const corrId = String(rows[0]!['id'])
    expect(await edgeStamp(storeA.engine, 'Correction', corrId, 'OBSERVED_IN', 'Session', sessionNodeId)).toEqual({
      extracted_by: `${EXTRACTION_PROVENANCE}/llm-local`,
      confidence: 0.9
    })
    expect(await edgeStamp(storeA.engine, 'Correction', corrId, 'IMPROVED', 'Skill', 's-deploy')).not.toBeNull()

    const derived = await storeA.engine.cypher(
      `MATCH (p:Preference)-[r:DERIVED_FROM]->(c:Correction {id: $cid}) RETURN p.statement AS s`,
      { cid: corrId }
    )
    expect(derived.map((r) => r['s'])).toEqual(['Use feature branches instead of committing directly to main'])
  })

  it('stages nothing, uses ONE write-lane job, and reports honest counts', () => {
    expect(stagedRows(`extraction-agent:${sessionNodeId}`)).toHaveLength(0)
    expect(laneDelta).toBe(1)
    expect(result.tier).toBe('local')
    expect(result.escalated).toBe(false)
    expect(result.committed).toEqual({
      project: 'matched',
      usedSkills: 1,
      usedMcps: 1,
      usedPlugins: 1,
      components: 2,
      mergedComponents: 0,
      preferences: 2,
      mergedPreferences: 0,
      corrections: 1
    })
    expect(result.staged.count).toBe(0)
  })

  it('re-running the same session is idempotent: merges instead of duplicating', async () => {
    const rerun = await agent.runExtraction(sessionId, { transcriptPath })
    expect(rerun.committed.components).toBe(0)
    expect(rerun.committed.mergedComponents).toBe(2) // stable-key name match
    expect(rerun.committed.preferences).toBe(0)
    expect(rerun.committed.mergedPreferences).toBe(2) // cosine 1.0 against run 1
    expect(rerun.committed.corrections).toBe(1) // deterministic id → same node
    expect(
      await nodeCount(storeA.engine, 'Component', 'WHERE n.name IN $names', { names: ['checkout page', 'payment service'] })
    ).toBe(2)
    expect(
      await nodeCount(storeA.engine, 'Preference', 'WHERE n.statement = $s', {
        s: 'Use feature branches instead of committing directly to main'
      })
    ).toBe(1)
    expect(await nodeCount(storeA.engine, 'Correction')).toBe(1)
    expect(await nodeCount(storeA.engine, 'Session', 'WHERE n.id = $id', { id: sessionNodeId })).toBe(1)
  }, 30_000)
})

// ─────────────────────────────────────────────────────────────────────────────
// Golden 3 — review path: low confidence, no cloud → staged_writes, not graph.
// ─────────────────────────────────────────────────────────────────────────────

describe('golden session 3 — low-confidence extractions land in staged_writes, never the graph', () => {
  const sessionId = 's3-review'
  const sessionNodeId = sessionNodeIdOf(sessionId)
  let result: Awaited<ReturnType<ExtractionAgent['runExtraction']>>

  beforeAll(async () => {
    insertMcpCalls(stackA.appData.db, [
      { sessionId, tool: 'get_context', params: { task: 'poke around' }, startedUnixMs: TMS(60) }
    ])
    const transcriptPath = writeTranscript('s3.jsonl', [
      userRecord('Maybe look at that one module, possibly tabs are nicer? Not sure about the old logger either.', {
        cwd: cwdAurora,
        timestamp: T(60),
        sessionId
      })
    ])
    const llm = new ScriptedExtractionLlm({
      components:
        '[{"name": "mystery module", "type": "module", "depends_on": [], "evidence": "maybe look at that one module", "confidence": 0.4}]',
      preferences:
        '[{"statement": "Possibly use tabs for indentation", "tags": ["style"], "derived_from": null, "evidence": "possibly tabs are nicer", "confidence": 0.3}]',
      corrections:
        '[{"content": "Perhaps stop using the old logger", "skill": null, "evidence": "not sure about the old logger", "confidence": 0.2}]'
    })
    const agent = makeAgent(storeA, stackA, { llm }) // NO cloud tier
    result = await agent.runExtraction(sessionId, { transcriptPath })
  }, 60_000)

  it('stages all three items with full payloads (op, node, edges, provenance, reason)', () => {
    const rows = stagedRows(`extraction-agent:${sessionNodeId}`)
    expect(rows).toHaveLength(3)
    expect(rows.map((r) => r.target_label)).toEqual(['Component', 'Correction', 'Preference'])
    for (const row of rows) {
      expect(row.kind).toBe('extraction')
      expect(row.status).toBe('staged')
      const payload = JSON.parse(row.payload_json) as {
        op: string
        node: { label: string; id: string; props: Record<string, unknown> }
        edges: { type: string }[]
        provenance: { extracted_by: string; confidence: number }
        reason: string
        session: string
      }
      expect(payload.op).toBe('create')
      expect(payload.session).toBe(sessionNodeId)
      expect(payload.provenance.extracted_by).toBe(`${EXTRACTION_PROVENANCE}/llm-local`)
      expect(payload.reason).toContain('below the 0.6 gate')
      if (payload.node.label === 'Preference') {
        expect(payload.node.props['statement']).toBe('Possibly use tabs for indentation')
        expect(payload.edges.map((e) => e.type)).toContain('APPLIES_TO')
        expect(payload.edges.map((e) => e.type)).toContain('EXTRACTED_FROM')
      }
      if (payload.node.label === 'Correction') {
        expect(payload.edges.map((e) => e.type)).toEqual(['OBSERVED_IN'])
      }
    }
    // The style tag is staged-only: its creation rides the payload.
    const prefPayload = JSON.parse(rows.find((r) => r.target_label === 'Preference')!.payload_json) as {
      tagCreates: { id: string; name: string }[]
    }
    expect(prefPayload.tagCreates).toEqual([{ id: 'tag-style', name: 'style' }])
  })

  it('leaves the graph untouched by the low-confidence items (deterministic facts still committed)', async () => {
    expect(await nodeCount(storeA.engine, 'Component', 'WHERE n.name = $n', { n: 'mystery module' })).toBe(0)
    expect(await nodeCount(storeA.engine, 'Preference', 'WHERE n.statement = $s', { s: 'Possibly use tabs for indentation' })).toBe(0)
    expect(await nodeCount(storeA.engine, 'Correction', 'WHERE n.content = $c', { c: 'Perhaps stop using the old logger' })).toBe(0)
    expect(await nodeCount(storeA.engine, 'Tag', 'WHERE n.id = $id', { id: 'tag-style' })).toBe(0)
    // The session itself and its deterministic edges DID commit.
    expect(await nodeCount(storeA.engine, 'Session', 'WHERE n.id = $id', { id: sessionNodeId })).toBe(1)
    expect(await edgeStamp(storeA.engine, 'Session', sessionNodeId, 'PRODUCED', 'Project', auroraProjectId)).not.toBeNull()
    expect(result.staged.count).toBe(3)
    expect(result.committed.components + result.committed.preferences + result.committed.corrections).toBe(0)
    expect(result.warnings.some((w) => w.includes('no cloud tier is configured'))).toBe(true)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Verifier path — low-confidence items go to the cloud verifier; agreement
// commits (different model than the extractor), disagreement stages.
// ─────────────────────────────────────────────────────────────────────────────

describe('cloud verifier — confirm commits with verified provenance, reject stages', () => {
  const sessionId = 's4-verified'
  const sessionNodeId = sessionNodeIdOf(sessionId)
  let cloudBrain: FakeCloudBrain
  let result: Awaited<ReturnType<ExtractionAgent['runExtraction']>>

  beforeAll(async () => {
    insertMcpCalls(stackA.appData.db, [
      { sessionId, tool: 'get_context', params: { task: 'billing work' }, startedUnixMs: TMS(120) }
    ])
    const transcriptPath = writeTranscript('s4.jsonl', [
      userRecord('Work on the billing exporter and the invoice model. Round currency at the API boundary only.', {
        cwd: cwdAurora,
        timestamp: T(120),
        sessionId
      })
    ])
    // Mixed confidences keep the SESSION mean ≥ 0.6 (no escalation), while two
    // ITEMS sit below the write gate → exactly two verifier calls.
    const llm = new ScriptedExtractionLlm({
      components:
        '[{"name": "billing exporter", "type": "service", "depends_on": [], "evidence": "the billing exporter", "confidence": 0.45},' +
        ' {"name": "invoice model", "type": "model", "depends_on": [], "evidence": "the invoice model", "confidence": 0.9}]',
      preferences:
        '[{"statement": "Round currency at the API boundary only", "tags": ["billing"], "derived_from": null, "evidence": "round currency at the API boundary only", "confidence": 0.5}]',
      corrections: '[]'
    })
    cloudBrain = new FakeCloudBrain({
      verifier: [
        '{"verdict": "confirm", "confidence": 0.85, "note": "the transcript names the billing exporter directly"}',
        'Thinking it through… {"verdict": "reject", "confidence": 0.8, "note": "the user stated this as a one-off instruction, not a durable preference"} — final.'
      ]
    })
    const agent = makeAgent(storeA, stackA, {
      llm,
      cloud: { brain: cloudBrain, meter: new SpendMeter({ db: stackA.appData.db }) }
    })
    result = await agent.runExtraction(sessionId, { transcriptPath, jobId: 'job-s4' })
  }, 60_000)

  it('commits the verifier-confirmed component at the verifier confidence with llm-local+verified provenance', async () => {
    const rows = await storeA.engine.cypher(
      'MATCH (c:Component) WHERE c.name = $n RETURN c.id AS id, c.extracted_by AS eb, c.confidence AS conf',
      { n: 'billing exporter' }
    )
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ eb: `${EXTRACTION_PROVENANCE}/llm-local+verified`, conf: 0.85 })
    expect(
      await edgeStamp(storeA.engine, 'Component', String(rows[0]!['id']), 'EXTRACTED_FROM', 'Session', sessionNodeId)
    ).toEqual({ extracted_by: `${EXTRACTION_PROVENANCE}/llm-local+verified`, confidence: 0.85 })
    // The high-confidence sibling committed straight through as llm-local.
    const invoice = await storeA.engine.cypher('MATCH (c:Component) WHERE c.name = $n RETURN c.extracted_by AS eb', {
      n: 'invoice model'
    })
    expect(invoice[0]!['eb']).toBe(`${EXTRACTION_PROVENANCE}/llm-local`)
  })

  it('stages the verifier-rejected preference with the disagreement recorded', async () => {
    const rows = stagedRows(`extraction-agent:${sessionNodeId}`)
    expect(rows).toHaveLength(1)
    expect(rows[0]!.target_label).toBe('Preference')
    const payload = JSON.parse(rows[0]!.payload_json) as { reason: string }
    expect(payload.reason).toContain('verifier rejected')
    expect(payload.reason).toContain('one-off instruction')
    expect(await nodeCount(storeA.engine, 'Preference', 'WHERE n.statement = $s', { s: 'Round currency at the API boundary only' })).toBe(0)
    expect(result.committed.components).toBe(2)
    expect(result.staged.count).toBe(1)
    expect(cloudBrain.calls.filter((c) => c.kind === 'verifier')).toHaveLength(2)
    // Verifier calls were metered against the job (§14).
    const spendRows = stackA.appData.db.prepare(`SELECT COUNT(*) AS c FROM spend WHERE task_id = ?`).get('job-s4') as { c: number }
    expect(spendRows.c).toBe(2)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Entity resolution — §20 bands: ≥0.90 merge / 0.75–0.90 tiebreak / <0.75 new.
// ─────────────────────────────────────────────────────────────────────────────

describe('entity resolution — near-duplicate Preference merges, novel one creates', () => {
  const sessionId = 's5-resolution'
  const sessionNodeId = sessionNodeIdOf(sessionId)
  let llm: ScriptedExtractionLlm
  let result: Awaited<ReturnType<ExtractionAgent['runExtraction']>>
  let preferencesBefore: number

  beforeAll(async () => {
    // Seeds at controlled bag-of-words distances from the extracted statements.
    await storeA.engine.upsertNode('Preference', {
      id: 'pref-seeded-pnpm',
      statement: 'use pnpm for package installs',
      embedding: fakeTextEmbedding('use pnpm for package installs'),
      extracted_by: 'seed',
      confidence: 1
    })
    await storeA.engine.upsertNode('Preference', {
      id: 'pref-seeded-tabs',
      statement: 'prefer tabs over spaces for indentation',
      embedding: fakeTextEmbedding('prefer tabs over spaces for indentation'),
      extracted_by: 'seed',
      confidence: 1
    })
    await storeA.engine.upsertNode('Preference', {
      id: 'pref-seeded-branch',
      statement: 'never push directly to the production branch',
      embedding: fakeTextEmbedding('never push directly to the production branch'),
      extracted_by: 'seed',
      confidence: 1
    })
    preferencesBefore = await nodeCount(storeA.engine, 'Preference')

    insertMcpCalls(stackA.appData.db, [
      { sessionId, tool: 'get_context', params: { task: 'workflow habits' }, startedUnixMs: TMS(180) }
    ])
    const transcriptPath = writeTranscript('s5.jsonl', [
      userRecord('Some workflow ground rules for this repo.', { timestamp: T(180), sessionId })
    ])
    llm = new ScriptedExtractionLlm({
      components: '[]',
      corrections: '[]',
      preferences:
        // 1) identical token set to pref-seeded-pnpm → cosine 1.0 → merge
        // 2) 5/6 token overlap with pref-seeded-tabs (≈0.833) → tiebreak YES → merge
        // 3) 6/7 overlap with pref-seeded-branch (≈0.857) → tiebreak NO → new
        // 4) disjoint from everything → new
        '[{"statement": "Use pnpm for package installs.", "tags": [], "derived_from": null, "evidence": "pnpm", "confidence": 0.9},' +
        ' {"statement": "prefer tabs over spaces for readability", "tags": [], "derived_from": null, "evidence": "tabs", "confidence": 0.9},' +
        ' {"statement": "never push directly to the staging branch", "tags": [], "derived_from": null, "evidence": "staging", "confidence": 0.9},' +
        ' {"statement": "always write integration tests for parsers", "tags": [], "derived_from": null, "evidence": "tests", "confidence": 0.9}]',
      tiebreaks: [
        'YES — both describe preferring tabs over spaces.', // tabs pair
        'These differ: one is about production, one about staging. NO' // branch pair
      ]
    })
    const agent = makeAgent(storeA, stackA, { llm })
    result = await agent.runExtraction(sessionId, { transcriptPath })
  }, 60_000)

  it('merges the near-duplicate onto the existing node (cosine ≥ 0.90) — no new node, evidence edge added', async () => {
    expect(await nodeCount(storeA.engine, 'Preference', 'WHERE n.statement = $s', { s: 'Use pnpm for package installs.' })).toBe(0)
    expect(await edgeStamp(storeA.engine, 'Preference', 'pref-seeded-pnpm', 'EXTRACTED_FROM', 'Session', sessionNodeId)).toEqual({
      extracted_by: `${EXTRACTION_PROVENANCE}/llm-local`,
      confidence: 0.9
    })
    // Merge never rewrites the surviving node's content.
    const rows = await storeA.engine.cypher('MATCH (p:Preference {id: $id}) RETURN p.statement AS s', {
      id: 'pref-seeded-pnpm'
    })
    expect(rows[0]!['s']).toBe('use pnpm for package installs')
  })

  it('resolves the 0.75–0.90 band with the local LLM tiebreak: YES merges, NO creates', async () => {
    // YES → merged onto the tabs seed.
    expect(await nodeCount(storeA.engine, 'Preference', 'WHERE n.statement = $s', { s: 'prefer tabs over spaces for readability' })).toBe(0)
    expect(
      await edgeStamp(storeA.engine, 'Preference', 'pref-seeded-tabs', 'EXTRACTED_FROM', 'Session', sessionNodeId)
    ).not.toBeNull()
    // NO → a distinct new node beside the seed.
    expect(await nodeCount(storeA.engine, 'Preference', 'WHERE n.statement = $s', { s: 'never push directly to the staging branch' })).toBe(1)
    expect(llm.tiebreakCalls).toHaveLength(2)
  })

  it('creates the novel preference (< 0.75 everywhere) and reports merge/create counts', async () => {
    expect(await nodeCount(storeA.engine, 'Preference', 'WHERE n.statement = $s', { s: 'always write integration tests for parsers' })).toBe(1)
    expect(result.committed.preferences).toBe(2) // staging-branch + novel
    expect(result.committed.mergedPreferences).toBe(2) // pnpm + tabs
    expect(await nodeCount(storeA.engine, 'Preference')).toBe(preferencesBefore + 2)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Crash-resume — the DoD "workflow resumes after a simulated crash between
// passes": all pre-crash state comes from checkpoints, no model re-runs.
// ─────────────────────────────────────────────────────────────────────────────

describe('crash between passes — resume completes from checkpoints without re-running earlier passes', () => {
  const sessionId = 's6-crash'
  const sessionNodeId = sessionNodeIdOf(sessionId)
  const jobId = 'job-s6-crash'
  let transcriptPath: string
  let embedder: FailingOnceEmbedder
  let llmA: ScriptedExtractionLlm

  beforeAll(() => {
    insertMcpCalls(stackA.appData.db, [
      { sessionId, tool: 'get_context', params: { task: 'migrations' }, startedUnixMs: TMS(240) }
    ])
    transcriptPath = writeTranscript('s6.jsonl', [
      userRecord('Keep migration scripts idempotent, please — always.', { timestamp: T(240), sessionId })
    ])
    embedder = new FailingOnceEmbedder()
    llmA = new ScriptedExtractionLlm({
      components: '[]',
      corrections: '[]',
      preferences:
        '[{"statement": "Keep migration scripts idempotent", "tags": ["migrations"], "derived_from": null, "evidence": "keep migration scripts idempotent", "confidence": 0.9}]'
    })
  })

  it('fails mid-pipeline (resolve) leaving the graph untouched — all writes live in the final step', async () => {
    const agent = makeAgent(storeA, stackA, { llm: llmA, embedder })
    await expect(agent.runExtraction(sessionId, { transcriptPath, jobId })).rejects.toThrow(WorkflowJobError)
    expect(llmA.extractionCalls).toHaveLength(3) // the fuzzy passes DID run before the crash
    const job = stackA.appData.db.prepare(`SELECT status, attempts FROM tasks WHERE id = ?`).get(jobId) as {
      status: string
      attempts: number
    }
    expect(job).toMatchObject({ status: 'failed', attempts: 1 })
    expect(await nodeCount(storeA.engine, 'Session', 'WHERE n.id = $id', { id: sessionNodeId })).toBe(0)
    expect(await nodeCount(storeA.engine, 'Preference', 'WHERE n.statement = $s', { s: 'Keep migration scripts idempotent' })).toBe(0)
    expect(stagedRows(`extraction-agent:${sessionNodeId}`)).toHaveLength(0)
  }, 30_000)

  it('a fresh agent instance resumes the job to completion without re-running the extract pass', async () => {
    // Re-instantiation = the crash story: new runner, new agent, same appdata.
    // Its local LLM THROWS on any extraction pass — completing anyway proves
    // the fuzzy results came from the checkpoint, not a re-run.
    const llmB = new ScriptedExtractionLlm({}, { failExtraction: true })
    const agentB = makeAgent(storeA, stackA, { llm: llmB, embedder })
    const result = await agentB.resumeExtraction(jobId)

    expect(result.jobId).toBe(jobId)
    expect(result.committed.preferences).toBe(1)
    expect(llmB.extractionCalls).toHaveLength(0)
    const job = stackA.appData.db.prepare(`SELECT status, attempts FROM tasks WHERE id = ?`).get(jobId) as {
      status: string
      attempts: number
    }
    expect(job).toMatchObject({ status: 'done', attempts: 2 })

    expect(await nodeCount(storeA.engine, 'Session', 'WHERE n.id = $id', { id: sessionNodeId })).toBe(1)
    const prefRows = await storeA.engine.cypher(
      'MATCH (p:Preference) WHERE p.statement = $s RETURN p.id AS id, p.extracted_by AS eb, p.confidence AS conf',
      { s: 'Keep migration scripts idempotent' }
    )
    expect(prefRows).toHaveLength(1)
    expect(prefRows[0]).toMatchObject({ eb: `${EXTRACTION_PROVENANCE}/llm-local`, conf: 0.9 })
    expect(
      await edgeStamp(storeA.engine, 'Preference', String(prefRows[0]!['id']), 'EXTRACTED_FROM', 'Session', sessionNodeId)
    ).not.toBeNull()
  }, 30_000)
})

// ─────────────────────────────────────────────────────────────────────────────
// P0.1 (phase 14, MCP-COVERAGE §9.5) — all-model-failure extraction is LOUD:
// the workflow rejects with a retryable error and the queue task RETRIES
// instead of flipping the exactly-once `extract-<sessionId>` token to a
// silent, empty 'done' that would tombstone the session forever.
// ─────────────────────────────────────────────────────────────────────────────

describe('P0.1 — every model call fails: extraction throws instead of committing empty', () => {
  it('runExtraction rejects with ExtractionUnavailableError in the cause chain; the graph stays untouched', async () => {
    const sessionId = 'p01-direct'
    insertMcpCalls(stackA.appData.db, [
      { sessionId, tool: 'get_context', params: { task: 'anything at all' }, startedUnixMs: TMS(360) }
    ])
    const transcriptPath = writeTranscript('p01-a.jsonl', [
      userRecord('Please remember: always run the linter before committing.', { timestamp: T(360), sessionId })
    ])
    const llm = new ScriptedExtractionLlm({}, { failExtraction: true })
    const agent = makeAgent(storeA, stackA, { llm })
    const err: unknown = await agent
      .runExtraction(sessionId, { transcriptPath, jobId: 'job-p01-direct' })
      .catch((e: unknown) => e)
    expect(err).toBeInstanceOf(WorkflowJobError)
    // The retryable class survives the workflow wrap via the cause chain —
    // exactly what the session-end handler's isNothingToExtract walks.
    let found = false
    for (let cause: unknown = err, depth = 0; depth < 6 && cause instanceof Error; depth++, cause = cause.cause) {
      if (cause instanceof ExtractionUnavailableError) {
        found = true
        break
      }
    }
    expect(found).toBe(true)
    // Nothing committed, nothing staged: the session is NOT recorded as extracted.
    expect(await nodeCount(storeA.engine, 'Session', 'WHERE n.id = $id', { id: sessionNodeIdOf(sessionId) })).toBe(0)
    expect(stagedRows(`extraction-agent:${sessionNodeIdOf(sessionId)}`)).toHaveLength(0)
  }, 30_000)

  it('through the REAL queue handler: the task retries (pending + §20 backoff), never a silent done', async () => {
    const sessionId = 'p01-queued'
    const taskId = extractionTaskId(sessionId)
    insertMcpCalls(stackA.appData.db, [
      { sessionId, tool: 'search_memory', params: { query: 'merge policy' }, startedUnixMs: TMS(370) }
    ])
    const transcriptPath = writeTranscript('p01-b.jsonl', [
      userRecord('Always squash-merge feature branches, please.', { timestamp: T(370), sessionId })
    ])
    // The real phase-11 wiring: queue → registerExtractionHandler → the real
    // phase-08 workflow, with every model call failing (no cloud tier).
    const queue = new DurableTaskQueue({ db: stackA.appData.db })
    const runner = new LangGraphRunner({ db: stackA.appData.db, telemetry: stackA.telemetry, executor: stackA.kernel })
    const agent = createExtractionAgent({
      engine: storeA.engine,
      db: stackA.appData.db,
      runner,
      embedder: new FakeExtractionEmbedder(),
      llm: new ScriptedExtractionLlm({}, { failExtraction: true }),
      cloud: null
    })
    registerExtractionHandler(queue, { agent, runner })
    queue.start()
    try {
      expect(enqueueExtraction(queue, { sessionId, transcriptPath }, 'hook').deduped).toBe(false)
      // Wait for attempt 1 to settle (real timers; the §20 backoff is 60s so
      // the settled state is stable once observed).
      const deadline = Date.now() + 20_000
      let settled:
        | { status: string; attempts: number; not_before_unix_ms: number | null; last_error: string | null }
        | undefined
      for (;;) {
        settled = stackA.appData.db
          .prepare('SELECT status, attempts, not_before_unix_ms, last_error FROM tasks WHERE id = ?')
          .get(taskId) as typeof settled
        if (
          settled !== undefined &&
          (settled.status === 'done' ||
            settled.status === 'failed' ||
            settled.status === 'deferred' ||
            (settled.status === 'pending' && settled.attempts >= 1))
        ) {
          break
        }
        if (Date.now() > deadline) throw new Error(`task ${taskId} did not settle: ${JSON.stringify(settled ?? null)}`)
        await new Promise((resolve) => setTimeout(resolve, 50))
      }
      // The P0.1 regression pin: NOT 'done' (silent loss), NOT 'failed'
      // (unretryable), NOT swallowed by the nothing-to-extract path — a live
      // retry with the 1m backoff recorded.
      expect(settled).toMatchObject({ status: 'pending', attempts: 1 })
      expect(settled?.not_before_unix_ms ?? 0).toBeGreaterThan(Date.now())
      expect(settled?.last_error ?? '').toMatch(/fuzzy-pass calls failed/)
      // And still nothing in the graph for this session.
      expect(await nodeCount(storeA.engine, 'Session', 'WHERE n.id = $id', { id: sessionNodeIdOf(sessionId) })).toBe(0)
    } finally {
      await queue.stop(0)
    }
  }, 30_000)
})

// ─────────────────────────────────────────────────────────────────────────────
// Input validation
// ─────────────────────────────────────────────────────────────────────────────

describe('input validation', () => {
  it('a session with no calls and no transcript fails cleanly with NOT_FOUND', async () => {
    const agent = makeAgent(storeA, stackA, { llm: new ScriptedExtractionLlm() })
    await expect(agent.runExtraction('nothing-here')).rejects.toThrow(/nothing to extract/)
  })

  it('a missing transcript degrades to backbone-only extraction with a warning', async () => {
    const sessionId = 's8-no-transcript'
    insertMcpCalls(stackA.appData.db, [
      { sessionId, tool: 'get_context', params: { task: 'quick check' }, startedUnixMs: TMS(300) }
    ])
    const agent = makeAgent(storeA, stackA, { llm: new ScriptedExtractionLlm() })
    const result = await agent.runExtraction(sessionId, {
      transcriptPath: join(transcriptDir, 'does-not-exist.jsonl')
    })
    expect(result.tier).toBe('none')
    expect(result.warnings.some((w) => w.includes('continuing with the MCP-call log only'))).toBe(true)
    expect(await nodeCount(storeA.engine, 'Session', 'WHERE n.id = $id', { id: sessionNodeIdOf(sessionId) })).toBe(1)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Live gate — real qwen3 + bge-m3 over a small realistic session (OLLAMA=1).
// ─────────────────────────────────────────────────────────────────────────────

describe.skipIf(process.env['OLLAMA'] !== '1')('live extraction (OLLAMA=1: real qwen3 + bge-m3)', () => {
  it(
    'extracts a real session end to end: workflow completes, deterministic facts commit, fuzzy content lands in graph or review queue',
    async () => {
      const store = await openTestStore()
      const stack = openKernelStack()
      try {
        const sessionId = 's7-live'
        insertMcpCalls(stack.appData.db, [
          { sessionId, tool: 'get_context', params: { task: 'payments webhook' }, startedUnixMs: TMS(0) },
          { sessionId, tool: 'get_skill', params: { name: 'deploy-web' }, startedUnixMs: TMS(1) }
        ])
        await store.engine.upsertNode('Skill', {
          id: 's-deploy-live',
          name: 'deploy-web',
          instructions: 'Deploy web apps.',
          embedding: fakeTextEmbedding('deploy-web')
        })
        const transcriptPath = writeTranscript('s7-live.jsonl', [
          userRecord(
            'Set up the payments webhook handler route. I prefer pnpm over npm for installing packages in this repo — always use pnpm here.',
            { cwd: join(tmpdir(), 'extraction-fixture', 'live-shop'), timestamp: T(0), sessionId }
          ),
          assistantRecord('Using pnpm. I created the payments webhook handler route and wired it to the payment service.', [
            { name: 'Bash', input: { command: 'pnpm install' } }
          ]),
          userRecord(
            'No, stop putting secrets in the config file — always load secrets from environment variables instead.',
            { timestamp: T(9) }
          ),
          assistantRecord('Understood — secrets move to environment variables.', [], { timestamp: T(10) })
        ])
        const ollama = new OllamaClient()
        const agent = makeAgent(store, stack, { llm: ollama, embedder: ollama })
        const result = await agent.runExtraction(sessionId, { transcriptPath })

        // Deterministic facts always commit.
        const sessionNodeId = sessionNodeIdOf(sessionId)
        expect(await nodeCount(store.engine, 'Session', 'WHERE n.id = $id', { id: sessionNodeId })).toBe(1)
        expect(await edgeStamp(store.engine, 'Session', sessionNodeId, 'USED', 'Skill', 's-deploy-live')).toEqual({
          extracted_by: `${EXTRACTION_PROVENANCE}/deterministic`,
          confidence: 1
        })
        expect(result.committed.project).toBe('created')

        // The fuzzy tier is a real model — accept graph OR review queue, but
        // the session's clearly-stated content must surface somewhere.
        const extracted = result.committed.components + result.committed.preferences + result.committed.corrections + result.staged.count
        expect(extracted).toBeGreaterThan(0)
        const graphTexts = [
          ...(await store.engine.cypher('MATCH (p:Preference) RETURN p.statement AS t')),
          ...(await store.engine.cypher('MATCH (c:Correction) RETURN c.content AS t'))
        ].map((r) => String(r['t']))
        const stagedTexts = (
          stack.appData.db.prepare(`SELECT payload_json FROM staged_writes`).all() as { payload_json: string }[]
        ).map((r) => r.payload_json)
        const everything = [...graphTexts, ...stagedTexts].join('\n').toLowerCase()
        expect(everything).toMatch(/pnpm|secret|environment/)
        console.log(
          `[live extraction] tier=${result.tier} confidence-committed: ${JSON.stringify(result.committed)} staged=${result.staged.count}\n` +
            `[live extraction] graph texts: ${JSON.stringify(graphTexts)}`
        )
      } finally {
        await store.cleanup()
        stack.cleanup()
      }
    },
    600_000
  )
})
