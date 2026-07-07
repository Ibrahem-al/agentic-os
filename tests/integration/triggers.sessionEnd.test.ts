/**
 * Phase-11 DoD, the §6 session-end chain over REAL components:
 *
 *  - a fake SessionEnd POST against the REAL MCP HTTP server's hook endpoint
 *    (dedicated token, timing-safe) enqueues extraction, and the queue runs
 *    the REAL phase-08 workflow end-to-end on a fixture session — Session
 *    node, provenance-stamped edges and the extracted Preference land in the
 *    graph;
 *  - the same session detected via hook AND inactivity is extracted EXACTLY
 *    once (deterministic `extract-<sessionId>` id + queue dedup);
 *  - the spool folder drains on boot (valid files enqueue + delete; malformed
 *    files are quarantined *.bad);
 *  - the inactivity monitor only fires for sessions quiet past the timeout
 *    and never re-enqueues an already-tasked session;
 *  - a session with nothing to extract completes the task with a note
 *    (NOT_FOUND is not a retryable failure).
 */
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createExtractionAgent, type ExtractionAgent } from '../../src/main/agents'
import { LangGraphRunner } from '../../src/main/kernel'
import { AgenticOsMcpServer } from '../../src/main/mcp'
import { createRetriever, type RetrievalDeps, type Retriever, type SmallLlm } from '../../src/main/retrieval'
import {
  drainSessionSpool,
  DurableTaskQueue,
  createSessionEndHookHandler,
  extractionTaskId,
  InactivityMonitor,
  registerExtractionHandler
} from '../../src/main/triggers'
import {
  FakeExtractionEmbedder,
  ScriptedExtractionLlm,
  assistantRecord,
  insertMcpCalls,
  transcriptJsonl,
  userRecord
} from '../fixtures/extraction-fakes'
import { openKernelStack, type KernelTestStack } from '../fixtures/kernel-helpers'
import { FakeEmbedder, FakeReranker } from '../fixtures/retrieval-fakes'
import { openTestStore, type TestStore } from './helpers'

const HOOK_TOKEN = 'test-hook-token-1'

const stubLlm: SmallLlm = {
  generate: () => Promise.resolve({ text: 'SCORE: 9/10' })
}

let store: TestStore
let stack: KernelTestStack
let server: AgenticOsMcpServer
let hookUrl: string
let queue: DurableTaskQueue
let agent: ExtractionAgent
let runner: LangGraphRunner
let inactivity: InactivityMonitor
let baseDir: string

interface TaskRow {
  id: string
  kind: string
  status: string
  attempts: number
  last_error: string | null
}

const taskRow = (id: string): TaskRow | undefined =>
  stack.appData.db
    .prepare('SELECT id, kind, status, attempts, last_error FROM tasks WHERE id = ?')
    .get(id) as TaskRow | undefined

const waitForTask = async (id: string, timeoutMs = 20_000): Promise<TaskRow> => {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const row = taskRow(id)
    if (row !== undefined && (row.status === 'done' || row.status === 'failed' || row.status === 'deferred')) {
      return row
    }
    if (Date.now() > deadline) {
      throw new Error(`task ${id} did not settle in ${timeoutMs}ms (row: ${JSON.stringify(row ?? null)})`)
    }
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
}

const postHook = (body: unknown, token = HOOK_TOKEN): Promise<Response> =>
  fetch(hookUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: typeof body === 'string' ? body : JSON.stringify(body)
  })

const scriptedLlm = (): ScriptedExtractionLlm =>
  new ScriptedExtractionLlm({
    components: '[]',
    preferences:
      '[{"statement": "Always use pnpm for package installs", "tags": ["tooling"], "derived_from": null, "evidence": "always use pnpm", "confidence": 0.9}]',
    corrections: '[]'
  })

beforeAll(async () => {
  baseDir = mkdtempSync(join(tmpdir(), 'agentic-os-sessend-'))
  store = await openTestStore()
  stack = openKernelStack()

  const retrieval: RetrievalDeps = { engine: store.engine, embedder: new FakeEmbedder(), reranker: new FakeReranker() }
  const retriever: Retriever = createRetriever({ ...retrieval, llm: stubLlm })
  server = new AgenticOsMcpServer({
    bearerToken: 'unrelated-mcp-token',
    runnerToken: 'unrelated-runner-token',
    engine: store.engine,
    retriever,
    retrieval,
    llm: stubLlm,
    db: stack.appData.db,
    executor: stack.kernel,
    port: 0
  })
  await server.start()
  hookUrl = `http://127.0.0.1:${server.port}/hooks/session-end`

  queue = new DurableTaskQueue({ db: stack.appData.db })
  runner = new LangGraphRunner({ db: stack.appData.db, telemetry: stack.telemetry, executor: stack.kernel })
  agent = createExtractionAgent({
    engine: store.engine,
    db: stack.appData.db,
    runner,
    embedder: new FakeExtractionEmbedder(),
    llm: scriptedLlm(),
    cloud: null
  })
  registerExtractionHandler(queue, { agent, runner })
  inactivity = new InactivityMonitor({ db: stack.appData.db, queue })
}, 60_000)

afterAll(async () => {
  inactivity.stop()
  await queue.stop(0)
  await server.stop()
  stack.cleanup()
  await store.cleanup()
  rmSync(baseDir, { recursive: true, force: true })
})

describe('hook endpoint (POST /hooks/session-end on the MCP server)', () => {
  it('answers 503 before the trigger runtime arms it (hook script spools)', async () => {
    const res = await postHook({ session_id: 'early' })
    expect(res.status).toBe(503)
    // Now arm it for the rest of the file (boot order: setSessionEndHook then drain + start).
    server.setSessionEndHook({ token: HOOK_TOKEN, handle: createSessionEndHookHandler(queue) })
  })

  it('rejects a missing or wrong token (401), never enqueuing', async () => {
    expect((await fetch(hookUrl, { method: 'POST', body: '{}' })).status).toBe(401)
    expect((await postHook({ session_id: 's-unauth' }, 'wrong-token')).status).toBe(401)
    expect(taskRow(extractionTaskId('s-unauth'))).toBeUndefined()
  })

  it('rejects non-POST (405) and junk payloads (400)', async () => {
    expect((await fetch(hookUrl, { headers: { Authorization: `Bearer ${HOOK_TOKEN}` } })).status).toBe(405)
    expect((await postHook('{not json')).status).toBe(400)
    const missingId = await postHook({ transcript_path: '/tmp/x.jsonl' })
    expect(missingId.status).toBe(400)
    expect(await missingId.text()).toContain('session_id')
  })

  it('enqueues extraction with the deterministic id; a repeat POST dedups', async () => {
    const first = await postHook({ session_id: 'sess-dup', reason: 'clear' })
    expect(first.status).toBe(200)
    expect(await first.json()).toMatchObject({ ok: true, taskId: 'extract-sess-dup', deduped: false })
    const second = await postHook({ session_id: 'sess-dup' })
    expect(await second.json()).toMatchObject({ taskId: 'extract-sess-dup', deduped: true })
    const rows = stack.appData.db
      .prepare(`SELECT count(*) AS c FROM tasks WHERE id = 'extract-sess-dup'`)
      .get() as { c: number }
    expect(rows.c).toBe(1)
  })
})

describe('extraction end-to-end from a fake SessionEnd POST (phase DoD)', () => {
  it('runs the real phase-08 workflow: Session + provenance-stamped Preference in the graph', async () => {
    const sessionId = 'sess-e2e-1'
    const cwd = join(baseDir, 'proj-hook-e2e')
    mkdirSync(cwd, { recursive: true })
    const transcriptPath = join(baseDir, 'sess-e2e-1.jsonl')
    writeFileSync(
      transcriptPath,
      transcriptJsonl([
        userRecord('please set up the project. always use pnpm for package installs.', {
          cwd,
          sessionId,
          timestamp: new Date().toISOString()
        }),
        assistantRecord('done — using pnpm.', [], { cwd, sessionId, timestamp: new Date().toISOString() })
      ]),
      'utf8'
    )
    insertMcpCalls(stack.appData.db, [
      { sessionId, tool: 'search_memory', startedUnixMs: Date.now() - 60_000 },
      { sessionId, tool: 'get_context', startedUnixMs: Date.now() - 50_000 }
    ])

    queue.start() // boot order: handlers registered above; reload finds nothing yet queued... the POSTs above enqueued rows pre-start, so they reload here.
    const res = await postHook({ session_id: sessionId, transcript_path: transcriptPath, cwd })
    expect(res.status).toBe(200)

    const settled = await waitForTask(extractionTaskId(sessionId))
    expect(settled.status).toBe('done')
    expect(settled.last_error).toBeNull()

    // The graph really changed: Session node + committed Preference with §21-4 provenance.
    const session = await store.engine.cypher(`MATCH (s:Session {id: 'session-${sessionId}'}) RETURN s.id AS id`)
    expect(session).toHaveLength(1)
    const preference = await store.engine.cypher(
      `MATCH (p:Preference)-[r:EXTRACTED_FROM]->(s:Session {id: 'session-${sessionId}'})
       RETURN p.statement AS statement, p.extracted_by AS eb, p.confidence AS conf, r.extracted_by AS reb`
    )
    expect(preference).toHaveLength(1)
    expect(String(preference[0]?.['statement'])).toContain('pnpm')
    expect(String(preference[0]?.['eb'])).toContain('extraction@')
    expect(Number(preference[0]?.['conf'])).toBeCloseTo(0.9)
    expect(String(preference[0]?.['reb'])).toContain('extraction@')
    // The workflow job row exists beside the queue task (deterministic -wf id).
    const wf = await runner.getJob(`${extractionTaskId(sessionId)}-wf`)
    expect(wf?.status).toBe('done')
  }, 60_000)

  it('a session with no calls and no transcript completes with a note, never retries', async () => {
    const res = await postHook({ session_id: 'sess-empty' })
    expect(res.status).toBe(200)
    const settled = await waitForTask(extractionTaskId('sess-empty'))
    expect(settled.status).toBe('done')
    expect(settled.attempts).toBe(1)
  }, 30_000)
})

describe('inactivity fallback + exactly-once (§6, phase DoD)', () => {
  it('enqueues only sessions quiet past the timeout, once, backbone-only', async () => {
    const now = Date.now()
    insertMcpCalls(stack.appData.db, [
      { sessionId: 'sess-quiet', tool: 'get_context', startedUnixMs: now - 31 * 60_000 },
      { sessionId: 'sess-active', tool: 'get_context', startedUnixMs: now - 5 * 60_000 }
    ])
    const fresh = inactivity.checkOnce(now)
    expect(fresh).toEqual(['sess-quiet'])
    expect(taskRow(extractionTaskId('sess-active'))).toBeUndefined()
    // The sweep is idempotent: the NOT EXISTS filter hides tasked sessions.
    expect(inactivity.checkOnce(now)).toEqual([])
    const settled = await waitForTask(extractionTaskId('sess-quiet'))
    expect(settled.status).toBe('done') // backbone-only extraction (no transcript)
    const session = await store.engine.cypher(`MATCH (s:Session {id: 'session-sess-quiet'}) RETURN s.id AS id`)
    expect(session).toHaveLength(1)
  }, 30_000)

  it('the same session via hook AND inactivity is extracted exactly once (DoD)', async () => {
    const sessionId = 'sess-both'
    const now = Date.now()
    insertMcpCalls(stack.appData.db, [
      { sessionId, tool: 'get_context', startedUnixMs: now - 45 * 60_000 }
    ])
    // Hook first…
    const res = await postHook({ session_id: sessionId })
    expect(((await res.json()) as { deduped: boolean }).deduped).toBe(false)
    // …then the inactivity sweep sees the same quiet session: deduped.
    expect(inactivity.checkOnce(now)).toEqual([])
    await waitForTask(extractionTaskId(sessionId))

    const taskCount = stack.appData.db
      .prepare(`SELECT count(*) AS c FROM tasks WHERE id = ?`)
      .get(extractionTaskId(sessionId)) as { c: number }
    expect(taskCount.c).toBe(1)
    const wfCount = stack.appData.db
      .prepare(`SELECT count(*) AS c FROM tasks WHERE id = ?`)
      .get(`${extractionTaskId(sessionId)}-wf`) as { c: number }
    expect(wfCount.c).toBe(1)
    const sessions = await store.engine.cypher(`MATCH (s:Session {id: 'session-${sessionId}'}) RETURN s.id AS id`)
    expect(sessions).toHaveLength(1)
  }, 30_000)
})

describe('spool drain (§6: no session lost to timing)', () => {
  it('enqueues valid files, dedups tasked sessions, quarantines malformed ones', async () => {
    const spoolDir = join(baseDir, 'pending-sessions')
    mkdirSync(spoolDir, { recursive: true })
    writeFileSync(join(spoolDir, 'a.json'), JSON.stringify({ session_id: 'sess-spooled' }), 'utf8')
    writeFileSync(join(spoolDir, 'b.json'), JSON.stringify({ session_id: 'sess-dup' }), 'utf8') // already tasked above
    writeFileSync(join(spoolDir, 'c.json'), '{broken', 'utf8')
    writeFileSync(join(spoolDir, 'notes.txt'), 'not a spool file', 'utf8')

    const result = drainSessionSpool(queue, spoolDir)
    expect(result).toEqual({ enqueued: 1, deduped: 1, malformed: 1 })
    const left = readdirSync(spoolDir).sort()
    expect(left).toEqual(['c.json.bad', 'notes.txt'])
    expect(existsSync(join(spoolDir, 'a.json'))).toBe(false)
    expect(taskRow(extractionTaskId('sess-spooled'))).toBeDefined()
    await waitForTask(extractionTaskId('sess-spooled'))
  })

  it('a missing spool dir is a clean zero', () => {
    expect(drainSessionSpool(queue, join(baseDir, 'no-such-dir'))).toEqual({
      enqueued: 0,
      deduped: 0,
      malformed: 0
    })
  })
})

describe('the REAL hook script (scripts/hooks/session-end.*)', () => {
  const repoRoot = fileURLToPath(new URL('../..', import.meta.url))
  const fakeHome = (): string => {
    const home = join(baseDir, `fake-home-${randomUUID().slice(0, 8)}`)
    mkdirSync(home, { recursive: true })
    return home
  }

  /** Run the platform's hook script with `payload` on stdin and HOME redirected. */
  const runScript = (payload: string, url: string, home: string): Promise<number> =>
    new Promise((resolve, reject) => {
      const isWin = process.platform === 'win32'
      const script = join(repoRoot, 'scripts', 'hooks', isWin ? 'session-end.ps1' : 'session-end.sh')
      const child = isWin
        ? spawn('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, '-Token', HOOK_TOKEN, '-Url', url], {
            env: { ...process.env, USERPROFILE: home },
            stdio: ['pipe', 'ignore', 'pipe']
          })
        : spawn('sh', [script, HOOK_TOKEN, url], {
            env: { ...process.env, HOME: home },
            stdio: ['pipe', 'ignore', 'pipe']
          })
      child.on('error', reject)
      child.on('exit', (code) => resolve(code ?? -1))
      child.stdin.on('error', () => undefined) // a fast-exiting script may close stdin first
      child.stdin.end(payload)
    })

  it('POSTs to a live endpoint (task enqueued, nothing spooled) and always exits 0', async () => {
    const home = fakeHome()
    const code = await runScript(JSON.stringify({ session_id: 'sess-script-live' }), hookUrl, home)
    expect(code).toBe(0)
    expect(taskRow(extractionTaskId('sess-script-live'))).toBeDefined()
    expect(existsSync(join(home, '.agentic-os', 'pending-sessions'))).toBe(false)
    await waitForTask(extractionTaskId('sess-script-live'))
  }, 60_000)

  it('spools the exact payload when the endpoint is unreachable (app closed), exit 0', async () => {
    const home = fakeHome()
    const payload = JSON.stringify({ session_id: 'sess-script-spool', cwd: 'C:/somewhere' })
    // Port 9 (discard) on localhost: nothing listens; connection fails fast.
    const code = await runScript(payload, 'http://127.0.0.1:9/hooks/session-end', home)
    expect(code).toBe(0)
    const spoolDir = join(home, '.agentic-os', 'pending-sessions')
    const files = readdirSync(spoolDir).filter((f) => f.endsWith('.json'))
    expect(files).toHaveLength(1)
    expect(readFileSync(join(spoolDir, files[0]!), 'utf8')).toBe(payload)
    // …and the drain picks it up on the next boot (§6: no session lost).
    const drained = drainSessionSpool(queue, spoolDir)
    expect(drained).toEqual({ enqueued: 1, deduped: 0, malformed: 0 })
    await waitForTask(extractionTaskId('sess-script-spool'))
  }, 60_000)
})
