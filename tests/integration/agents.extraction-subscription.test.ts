/**
 * Phase-18 — the extraction SUBSCRIPTION tier + delegate/continuation flow over
 * the REAL storage engine + kernel stack (offline; scripted subscription/local
 * fakes). Pins:
 *
 *  - a router resolving `extraction.fuzzy` → subscription-claude runs the §2.2
 *    SINGLE tier: no Gate A/B, no local calls, no cloud escalation, and the
 *    committed nodes/edges are stamped `extraction@0.0.1/llm-subscription`;
 *  - DEFAULT == TODAY: a router resolving local runs the two-tier path (tier
 *    'local', `llm-local` provenance) — byte-identical to before;
 *  - the interactive continuation flow: `enqueueExtractionContinuation` → the
 *    handler routes to the DELEGATE → items staged in `runner_submissions`
 *    resolve/verify/write (high-conf commits, low-conf stages, no independent
 *    cloud verifier ⇒ `skipped-subscription-extractor`);
 *  - read_session pages == the delegate's re-chunk (aligned `chunk` indices);
 *  - `extract-cont-*` rows sweep after retention while the §6 `extract-<sid>`
 *    tokens are kept forever.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  chunkTranscript,
  createExtractionAgent,
  extractionProvenance,
  parseTranscriptFile,
  sessionNodeIdOf,
  type ExtractionAgent,
  type ExtractionCloud,
  type ExtractionLlm
} from '../../src/main/agents'
import { EXTRACTION_CLOUD_CHUNK_TOKENS } from '../../src/main/config'
import { LangGraphRunner } from '../../src/main/kernel'
import { ProviderRouter, type OllamaLike, type SubscriptionComplete } from '../../src/main/models'
import { readSession } from '../../src/main/reads'
import { estimatingTokenCounter } from '../../src/main/retrieval'
import type { StorageEngine } from '../../src/main/storage'
import {
  DurableTaskQueue,
  enqueueExtractionContinuation,
  extractionContinuationTaskId,
  extractionTaskId,
  registerExtractionHandler
} from '../../src/main/triggers'
import { runTaskRetentionSweep } from '../../src/main/triggers/jobs'
import { FakeExtractionEmbedder, insertMcpCalls, transcriptJsonl, userRecord } from '../fixtures/extraction-fakes'
import { openKernelStack, type KernelTestStack } from '../fixtures/kernel-helpers'
import { openTestStore, type TestStore } from './helpers'

let store: TestStore
let stack: KernelTestStack
let transcriptDir: string

const throwingLlm: ExtractionLlm = {
  generate: () => Promise.reject(new Error('deps.llm must not be called when the router owns resolution'))
}
const throwingOllama: OllamaLike = {
  generate: () => Promise.reject(new Error('local ollama must not be called on the subscription path'))
}

/** A subscription completion fake: dispatches on the pass/verify/tiebreak markers. */
function fakeSubscription(replies: {
  components?: string
  preferences?: string
  corrections?: string
  verifier?: string
  tiebreak?: string
}): { fn: SubscriptionComplete; calls: { system: string }[] } {
  const calls: { system: string }[] = []
  const fn: SubscriptionComplete = async (req) => {
    const system = req.system ?? ''
    calls.push({ system })
    if (system.includes('extract software components')) return { text: replies.components ?? '{"items": []}' }
    if (system.includes('extract user preferences')) return { text: replies.preferences ?? '{"items": []}' }
    if (system.includes('extract explicit user corrections')) return { text: replies.corrections ?? '{"items": []}' }
    if (system.includes('entity resolution judge')) return { text: replies.tiebreak ?? '{"same": false}' }
    if (system.includes('independent verification judge')) return { text: replies.verifier ?? '{"verdict":"confirm","confidence":0.9}' }
    throw new Error(`fake subscription: unrecognized system prompt: ${system.slice(0, 60)}`)
  }
  return { fn, calls }
}

/** A scripted local OllamaLike (the router's local tier) for the DEFAULT==TODAY path. */
function scriptedOllama(replies: { components?: string; preferences?: string; corrections?: string }): OllamaLike {
  return {
    async generate(_prompt, options) {
      const system = options?.system ?? ''
      if (system.includes('extract software components')) return { text: replies.components ?? '{"items": []}' }
      if (system.includes('extract user preferences')) return { text: replies.preferences ?? '{"items": []}' }
      if (system.includes('extract explicit user corrections')) return { text: replies.corrections ?? '{"items": []}' }
      throw new Error(`scripted ollama: unrecognized system prompt: ${system.slice(0, 60)}`)
    }
  }
}

/** A router whose global reasoning backend is `backend` (runner enabled + healthy). */
function makeRouter(opts: {
  backend: 'subscription-claude' | 'local-qwen3'
  ollama: OllamaLike
  subscriptionComplete: SubscriptionComplete
}): ProviderRouter {
  return new ProviderRouter({
    loadSnapshot: () => ({
      cloudProvider: 'anthropic',
      cloudModels: {},
      reasoning: { backend: opts.backend },
      runner: { enabled: true, model: 'claude-sub-model', stageAll: true, mode: 'completion', injectionPolicy: 'downgrade' }
    }),
    ollama: opts.ollama,
    makeCloud: () => null,
    subscriptionComplete: opts.subscriptionComplete,
    runnerHealthy: () => true
  })
}

/** Fresh runner per agent (define() is once-per-runner). */
function makeAgent(models: { llm: ExtractionLlm; cloud?: ExtractionCloud | null; router?: ProviderRouter }): {
  agent: ExtractionAgent
  runner: LangGraphRunner
} {
  const runner = new LangGraphRunner({ db: stack.appData.db, telemetry: stack.telemetry, executor: stack.kernel })
  const agent = createExtractionAgent({
    engine: store.engine,
    db: stack.appData.db,
    runner,
    embedder: new FakeExtractionEmbedder(),
    llm: models.llm,
    cloud: models.cloud ?? null,
    ...(models.router !== undefined ? { router: models.router } : {})
  })
  return { agent, runner }
}

function writeTranscript(name: string, records: readonly Record<string, unknown>[]): string {
  const path = join(transcriptDir, name)
  writeFileSync(path, transcriptJsonl(records), 'utf8')
  return path
}

async function componentStamp(engine: StorageEngine, sessionId: string, name: string): Promise<string | null> {
  const rows = await engine.cypher(
    `MATCH (c:Component {name: $name})-[:EXTRACTED_FROM]->(s:Session {id: $sid}) RETURN c.extracted_by AS eb`,
    { name, sid: sessionNodeIdOf(sessionId) }
  )
  return rows[0] ? String(rows[0]['eb']) : null
}

interface TaskRow {
  id: string
  status: string
}
const waitForTask = async (id: string, timeoutMs = 20_000): Promise<TaskRow> => {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const row = stack.appData.db.prepare('SELECT id, status FROM tasks WHERE id = ?').get(id) as TaskRow | undefined
    if (row !== undefined && (row.status === 'done' || row.status === 'failed' || row.status === 'deferred')) return row
    if (Date.now() > deadline) throw new Error(`task ${id} did not settle in ${timeoutMs}ms (row: ${JSON.stringify(row ?? null)})`)
    await new Promise((resolve) => setTimeout(resolve, 40))
  }
}

beforeAll(async () => {
  store = await openTestStore()
  stack = openKernelStack()
  transcriptDir = mkdtempSync(join(tmpdir(), 'agentic-os-sub-'))
}, 60_000)

afterAll(async () => {
  stack.cleanup()
  await store.cleanup()
  rmSync(transcriptDir, { recursive: true, force: true })
})

describe('extraction on the subscription tier (§2.2 single tier)', () => {
  it('runs ONE subscription tier: no local calls, no Gate A/B, llm-subscription provenance', async () => {
    const sessionId = 'sub-e2e'
    const cwd = join(tmpdir(), 'sub-fixture', 'orchard')
    insertMcpCalls(stack.appData.db, [{ sessionId, tool: 'get_context', startedUnixMs: Date.now() }])
    const transcriptPath = writeTranscript('sub-e2e.jsonl', [
      userRecord('build the watering scheduler. prefer cron for scheduled jobs.', {
        cwd,
        sessionId,
        timestamp: new Date().toISOString()
      })
    ])
    const sub = fakeSubscription({
      components:
        '{"items": [{"name": "watering scheduler", "type": "service", "depends_on": [], "evidence": "build the watering scheduler", "confidence": 0.9}]}',
      preferences:
        '{"items": [{"statement": "Prefer cron for scheduled jobs", "tags": ["scheduling"], "derived_from": null, "evidence": "prefer cron for scheduled jobs", "confidence": 0.9}]}',
      corrections: '{"items": []}'
    })
    const router = makeRouter({ backend: 'subscription-claude', ollama: throwingOllama, subscriptionComplete: sub.fn })
    const { agent } = makeAgent({ llm: throwingLlm, router })

    const result = await agent.runExtraction(sessionId, { transcriptPath, jobId: 'job-sub-e2e' })

    expect(result.tier).toBe('subscription')
    expect(result.escalated).toBe(false)
    // One 30k chunk (short transcript) × 3 passes = exactly 3 subscription calls;
    // the local ollama (throwing) proves no local tier ran.
    const passCalls = sub.calls.filter((c) => /extract (software components|user preferences|explicit user)/.test(c.system))
    expect(passCalls).toHaveLength(3)
    // Committed with the §2.2 subscription provenance on the node AND its edge.
    expect(await componentStamp(store.engine, sessionId, 'watering scheduler')).toBe(extractionProvenance('llm-subscription'))
    const pref = await store.engine.cypher(
      `MATCH (p:Preference)-[r:EXTRACTED_FROM]->(s:Session {id: $sid})
       RETURN p.statement AS st, p.extracted_by AS eb, r.extracted_by AS reb`,
      { sid: sessionNodeIdOf(sessionId) }
    )
    expect(pref).toHaveLength(1)
    expect(String(pref[0]?.['st'])).toContain('cron')
    expect(String(pref[0]?.['eb'])).toBe(extractionProvenance('llm-subscription'))
    expect(String(pref[0]?.['reb'])).toBe(extractionProvenance('llm-subscription'))
  }, 60_000)

  it('DEFAULT == TODAY: a router resolving local runs the two-tier path (tier local, llm-local provenance)', async () => {
    const sessionId = 'sub-default'
    const cwd = join(tmpdir(), 'sub-fixture', 'meadow')
    insertMcpCalls(stack.appData.db, [{ sessionId, tool: 'get_context', startedUnixMs: Date.now() }])
    const transcriptPath = writeTranscript('sub-default.jsonl', [
      userRecord('build the pump controller.', { cwd, sessionId, timestamp: new Date().toISOString() })
    ])
    const ollama = scriptedOllama({
      components: '{"items": [{"name": "pump controller", "type": "service", "confidence": 0.9}]}'
    })
    // Global backend local-qwen3 (today's default): the subscription tier is
    // inert even though the runner is healthy — the fuzzy passes run on ollama.
    const sub = fakeSubscription({}) // must NOT be called
    const router = makeRouter({ backend: 'local-qwen3', ollama, subscriptionComplete: sub.fn })
    const { agent } = makeAgent({ llm: throwingLlm, router })

    const result = await agent.runExtraction(sessionId, { transcriptPath, jobId: 'job-sub-default' })

    expect(result.tier).toBe('local')
    expect(sub.calls).toHaveLength(0)
    expect(await componentStamp(store.engine, sessionId, 'pump controller')).toBe(extractionProvenance('llm-local'))
  }, 60_000)
})

describe('delegate / continuation flow (interactive submit_extraction_items)', () => {
  it('a continuation task routes to the delegate: submissions resolve → verify → write (tier subscription)', async () => {
    const sessionId = 'sub-delegate'
    const cwd = join(tmpdir(), 'sub-fixture', 'grove')
    const transcriptPath = writeTranscript('sub-delegate.jsonl', [
      userRecord('worked on the harvest planner and the irrigation map.', {
        cwd,
        sessionId,
        timestamp: new Date().toISOString()
      })
    ])
    insertMcpCalls(stack.appData.db, [{ sessionId, tool: 'get_context', startedUnixMs: Date.now() }])
    // A session-end hook would have left the extract-<sid> task; the delegate
    // resolves the transcript path from it SERVER-SIDE (never caller input).
    stack.appData.db
      .prepare(`INSERT OR REPLACE INTO tasks (id, kind, payload_json, status, priority) VALUES (?, 'extraction', ?, 'done', 0)`)
      .run(extractionTaskId(sessionId), JSON.stringify({ sessionId, transcriptPath, cwd, origin: 'hook' }))

    // Stage the submitted items keyed by the continuation task id (what
    // submit_extraction_items does): one high-conf component, one low-conf pref.
    const batchId = 'batch-1'
    const contTaskId = extractionContinuationTaskId(sessionId, batchId)
    const insSub = stack.appData.db.prepare(
      `INSERT OR IGNORE INTO runner_submissions (id, task_id, session_id, kind, payload_json) VALUES (?, ?, ?, ?, ?)`
    )
    insSub.run(
      's1',
      contTaskId,
      sessionId,
      'component',
      JSON.stringify({ name: 'harvest planner', type: 'service', dependsOn: [], confidence: 0.9, evidence: 'harvest planner', chunk: 0 })
    )
    insSub.run(
      's2',
      contTaskId,
      sessionId,
      'preference',
      JSON.stringify({ statement: 'Prefer metric units in reports', tags: ['reporting'], derivedFrom: null, confidence: 0.4, evidence: 'metric units', chunk: 0 })
    )

    const queue = new DurableTaskQueue({ db: stack.appData.db })
    // No router + no cloud: the delegate forces tier 'subscription', and with no
    // independent cloud verifier the low-conf item hits skipped-subscription-extractor.
    // throwingLlm proves the delegate runs ZERO local reasoning calls.
    const { agent, runner } = makeAgent({ llm: throwingLlm, cloud: null })
    registerExtractionHandler(queue, { agent, runner })
    queue.start()

    const enq = enqueueExtractionContinuation(queue, sessionId, batchId)
    expect(enq.taskId).toBe(contTaskId)
    expect(enq.deduped).toBe(false)

    const settled = await waitForTask(contTaskId)
    expect(settled.status).toBe('done')

    // High-conf component committed with llm-subscription provenance…
    expect(await componentStamp(store.engine, sessionId, 'harvest planner')).toBe(extractionProvenance('llm-subscription'))
    // …low-conf preference stayed OUT of the graph and was staged for review.
    const prefNodes = await store.engine.cypher(
      `MATCH (p:Preference)-[:EXTRACTED_FROM]->(s:Session {id: $sid}) RETURN p.statement AS st`,
      { sid: sessionNodeIdOf(sessionId) }
    )
    expect(prefNodes).toHaveLength(0)
    const staged = stack.appData.db
      .prepare(`SELECT target_label, status FROM staged_writes WHERE proposed_by = ?`)
      .all(`extraction-agent:${sessionNodeIdOf(sessionId)}`) as { target_label: string; status: string }[]
    expect(staged.some((r) => r.target_label === 'Preference' && r.status === 'staged')).toBe(true)
    // The delegate ran the -wf job (a distinct extraction-delegate workflow).
    const wf = await runner.getJob(`${contTaskId}-wf`)
    expect(wf?.status).toBe('done')

    await queue.stop(0)
  }, 60_000)

  it('read_session pages == the delegate re-chunk (identical chunking → aligned chunk indices)', () => {
    const sessionId = 'sub-chunkeq'
    // A transcript large enough to force MULTIPLE 100k pages, so a drift in
    // read_session's chunk size (or the delegate's) would break equality.
    const line = `${'the greenhouse irrigation controller schedules watering cycles and logs sensor telemetry hourly '.repeat(7)}`
    const records = Array.from({ length: 700 }, (_, i) =>
      userRecord(`note ${i}: ${line}`, i === 0 ? { sessionId } : {})
    )
    const transcriptPath = writeTranscript('sub-chunkeq.jsonl', records)
    stack.appData.db
      .prepare(`INSERT OR REPLACE INTO tasks (id, kind, payload_json, status, priority) VALUES (?, 'extraction', ?, 'done', 0)`)
      .run(extractionTaskId(sessionId), JSON.stringify({ sessionId, transcriptPath }))

    const dto = readSession({ db: stack.appData.db }, { sessionId })
    const pageCount = dto.transcript?.pageCount ?? 0
    expect(pageCount).toBeGreaterThanOrEqual(2) // multi-page → a meaningful pin
    const pages: string[] = []
    for (let p = 0; p < pageCount; p++) {
      pages.push(readSession({ db: stack.appData.db }, { sessionId, page: p }).transcript?.text ?? '')
    }
    // Exactly how loadSubmissions re-chunks the transcript in the delegate.
    const digestText = parseTranscriptFile(transcriptPath).text
    const reChunk = chunkTranscript(digestText, EXTRACTION_CLOUD_CHUNK_TOKENS, estimatingTokenCounter())
    expect(pages).toEqual(reChunk)
  })
})

describe('retention sweep — extract-cont-* exemption (phase-18)', () => {
  it('sweeps extract-cont-* rows but keeps the §6 extract-<sid> tokens forever', () => {
    const db = stack.appData.db
    const old = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000).toISOString() // 60d ≫ 14d retention
    const ins = db.prepare(
      `INSERT OR REPLACE INTO tasks (id, kind, payload_json, status, priority, updated_at) VALUES (?, ?, '{}', 'done', 0, ?)`
    )
    ins.run('extract-sweepkeep', 'extraction', old) // §6 dedup token — kept
    ins.run('extract-sweepkeep-wf', 'workflow', old) // §6 workflow row — kept
    ins.run('extract-cont-sweepkeep-abcd1234', 'extraction', old) // continuation task — swept
    ins.run('extract-cont-sweepkeep-abcd1234-wf', 'workflow', old) // continuation wf job — swept

    runTaskRetentionSweep(db, new Date())

    const exists = (id: string): boolean => db.prepare('SELECT 1 AS x FROM tasks WHERE id = ?').get(id) !== undefined
    expect(exists('extract-sweepkeep')).toBe(true)
    expect(exists('extract-sweepkeep-wf')).toBe(true)
    expect(exists('extract-cont-sweepkeep-abcd1234')).toBe(false)
    expect(exists('extract-cont-sweepkeep-abcd1234-wf')).toBe(false)
  })
})
