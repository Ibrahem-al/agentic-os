/**
 * Phase-11 watchers runtime over REAL components: chokidar watched-folder
 * ingestion (boot catch-up scan + live change → Knowledge chunks with the
 * §13 trust tag), and the DoD demo rule — watch a local file, run a TS
 * action in the REAL Deno lane writing to its allowed dir; the §13 story
 * runs end-to-end: detection through the kernel, the sandbox-run approval
 * gate (user rules have no standing grants), dashboard-style approval, and
 * the out-of-scope write DENIED inside the lane (file provably absent on the
 * host). Plus the url watcher: net-gated polling, baseline-then-change
 * firing, condition filtering.
 *
 * Deno-lane tests skip gracefully when the managed binary cannot be ensured
 * (offline CI) — same policy as the phase-09 conformance suite.
 */
import { createServer, type Server } from 'node:http'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { AUTO_INGEST_TRUST_TAG } from '../../src/main/config'
import { WatchedFolderStore, type KnowledgeEmbedder } from '../../src/main/ingest'
import { DenoLane, ensureDenoBinary } from '../../src/main/security'
import {
  DurableTaskQueue,
  loadRules,
  registerIngestHandlers,
  registerRuleActionHandler,
  registerRuleAgents,
  TriggerWatchers,
  type RuleLoadResult
} from '../../src/main/triggers'
import { fakeTextEmbedding } from '../fixtures/graph-seed'
import { openKernelStack, spanAttributes, spanRows, type KernelTestStack } from '../fixtures/kernel-helpers'
import { openTestStore, type TestStore } from './helpers'

const repoRoot = fileURLToPath(new URL('../..', import.meta.url))
const denoBinDir = join(repoRoot, 'out', 'test-bin')

let baseDir: string
let store: TestStore
let stack: KernelTestStack
let queue: DurableTaskQueue
let watchers: TriggerWatchers
let rules: RuleLoadResult
let denoUnavailable = ''
let feedServer: Server
let feedPort = 0
let feedBody = 'plain news, nothing to see'

// Layout under baseDir.
let docsDir: string // watched folder (knowledge ingestion)
let watchDir: string // demo rule's watched dir (fsRead scope)
let watchedFile: string
let outDir: string // demo rule's ALLOWED write dir (fsWrite scope)
let outsideDir: string // outside every declared scope
let rulesDir: string

const fakeEmbedder: KnowledgeEmbedder = {
  embed: (texts: string[]) => Promise.resolve(texts.map((t) => fakeTextEmbedding(t)))
}

interface TaskRow {
  id: string
  kind: string
  status: string
  last_error: string | null
  payload_json: string
}

const ruleTasks = (ruleId: string): TaskRow[] =>
  (stack.appData.db
    .prepare(`SELECT id, kind, status, last_error, payload_json FROM tasks WHERE kind = 'rule-action' ORDER BY created_at, rowid`)
    .all() as TaskRow[]).filter((row) => (JSON.parse(row.payload_json) as { ruleId?: string }).ruleId === ruleId)

const waitFor = async <T>(probe: () => T | undefined, what: string, timeoutMs = 15_000): Promise<T> => {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = probe()
    if (value !== undefined) return value
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
}

beforeAll(async () => {
  baseDir = mkdtempSync(join(tmpdir(), 'agentic-os-watchers-'))
  docsDir = join(baseDir, 'docs')
  watchDir = join(baseDir, 'watch')
  outDir = join(baseDir, 'agentic-out')
  outsideDir = join(baseDir, 'outside')
  rulesDir = join(baseDir, 'rules')
  for (const dir of [docsDir, watchDir, outDir, outsideDir, rulesDir]) mkdirSync(dir, { recursive: true })
  watchedFile = join(watchDir, 'trigger.txt')
  writeFileSync(watchedFile, 'baseline content', 'utf8')
  writeFileSync(join(docsDir, 'preexisting.md'), '# Runbook\n\nRestart the ingest daemon with `systemctl restart ingestd`.\n', 'utf8')

  store = await openTestStore()
  stack = openKernelStack()

  try {
    await ensureDenoBinary({ binDir: denoBinDir })
  } catch (err) {
    denoUnavailable = err instanceof Error ? err.message : String(err)
  }

  feedServer = createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' })
    res.end(feedBody)
  })
  await new Promise<void>((resolve) => feedServer.listen(0, '127.0.0.1', resolve))
  feedPort = (feedServer.address() as { port: number }).port

  // The DoD demo action: write into the ALLOWED dir, attempt a write OUTSIDE
  // it, report both. Paths are baked in; the lane's --allow-* flags decide.
  const actionPath = join(rulesDir, 'demo-action.ts')
  writeFileSync(
    actionPath,
    `async function readStdin(): Promise<string> {
  const chunks: Uint8Array[] = []
  for await (const chunk of Deno.stdin.readable) chunks.push(chunk)
  return new TextDecoder().decode(Uint8Array.from(chunks.flatMap((c) => [...c])))
}
const input = JSON.parse(await readStdin())
let wrote = false
let outsideDenied = false
let outsideDetail = ''
try {
  Deno.writeTextFileSync(${JSON.stringify(join(outDir, 'result.txt'))}, 'fired by ' + input.rule.id + ': ' + (input.trigger.contentHash ?? 'no-hash'))
  wrote = true
} catch (err) {
  outsideDetail = 'allowed write failed: ' + String(err)
}
try {
  Deno.writeTextFileSync(${JSON.stringify(join(outsideDir, 'evil.txt'))}, 'escaped')
} catch (err) {
  outsideDenied = (err as Error)?.name === 'NotCapable' || String(err).includes('NotCapable')
  if (!outsideDenied) outsideDetail += ' unexpected outside-write error: ' + String(err)
}
console.log(JSON.stringify({ wrote, outsideDenied, outsideDetail }))
`,
    'utf8'
  )

  writeFileSync(
    join(rulesDir, 'demo.rule.json'),
    JSON.stringify({
      id: 'demo-file-rule',
      trigger: { type: 'watch', path: watchedFile },
      condition: "content contains 'deploy'",
      action: { kind: 'code', lang: 'ts', entry: 'demo-action.ts' },
      capabilities: { fsRead: [watchDir], fsWrite: [outDir] }
    }),
    'utf8'
  )
  writeFileSync(
    join(rulesDir, 'feed.rule.json'),
    JSON.stringify({
      id: 'url-feed-rule',
      trigger: { type: 'watch', url: `http://127.0.0.1:${feedPort}/feed`, intervalMin: 0.005 },
      condition: "content contains 'AI'",
      action: { kind: 'code', lang: 'ts', entry: 'demo-action.ts' },
      capabilities: { fsRead: [watchDir], fsWrite: [outDir], netDomains: [`127.0.0.1:${feedPort}`] }
    }),
    'utf8'
  )

  rules = loadRules(rulesDir)
  expect(rules.errors).toEqual([])
  registerRuleAgents(stack.permissions, rules.rules)

  const folderStore = new WatchedFolderStore({ configPath: join(baseDir, 'watched-folders.json') })
  folderStore.add({ name: 'docs', path: docsDir, tags: ['runbook'] })

  queue = new DurableTaskQueue({ db: stack.appData.db })
  registerIngestHandlers(queue, {
    knowledge: { engine: store.engine, embedder: fakeEmbedder },
    folderStore,
    kernel: stack.kernel
  })
  registerRuleActionHandler(queue, {
    kernel: stack.kernel,
    rules: () => new Map(rules.rules.map((rule) => [rule.id, rule])),
    denoLane: new DenoLane({ binDir: denoBinDir }),
    dockerLane: null
  })
  queue.start()

  watchers = new TriggerWatchers({
    queue,
    kernel: stack.kernel,
    rules: rules.rules,
    folderStore,
    stateFile: join(baseDir, 'trigger-state.json'),
    debounceMs: 200,
    urlMinIntervalMs: 300
  })
  await watchers.start()
}, 600_000) // first-ever run may download the pinned Deno zip

afterAll(async () => {
  await watchers.stop()
  await queue.stop(0)
  await new Promise<void>((resolve) => feedServer.close(() => resolve()))
  stack.cleanup()
  await store.cleanup()
  rmSync(baseDir, { recursive: true, force: true })
})

describe('watched folders (§7 knowledge ingestion, autonomous)', () => {
  it('the boot catch-up scan ingests pre-existing files with the trust tag', async () => {
    await waitFor(() => {
      const rows = stack.appData.db
        .prepare(`SELECT status FROM tasks WHERE kind = 'watch-scan'`)
        .all() as { status: string }[]
      return rows.length > 0 && rows.every((r) => r.status === 'done') ? true : undefined
    }, 'boot watch-scan to finish')
    const docs = await store.engine.cypher(
      `MATCH (d:Document) WHERE d.source ENDS WITH 'preexisting.md' RETURN d.id AS id`
    )
    expect(docs).toHaveLength(1)
    const tagged = await store.engine.cypher(
      `MATCH (k:Knowledge)-[:TAGGED]->(t:Tag {name: '${AUTO_INGEST_TRUST_TAG}'}) RETURN count(k) AS c`
    )
    expect(Number(tagged[0]?.['c'])).toBeGreaterThan(0)
    const runbookTag = await store.engine.cypher(
      `MATCH (k:Knowledge)-[:TAGGED]->(t:Tag {name: 'runbook'}) RETURN count(k) AS c`
    )
    expect(Number(runbookTag[0]?.['c'])).toBeGreaterThan(0)
  }, 30_000)

  it('a file dropped into the folder while running is ingested automatically', async () => {
    writeFileSync(join(docsDir, 'dropped.md'), '# Oncall\n\nPage the storage owner for lane stalls.\n', 'utf8')
    await waitFor(
      () => {
        const rows = stack.appData.db
          .prepare(`SELECT status, payload_json FROM tasks WHERE kind = 'ingest-file'`)
          .all() as { status: string; payload_json: string }[]
        const mine = rows.filter((r) => (JSON.parse(r.payload_json) as { path?: string }).path?.endsWith('dropped.md'))
        return mine.length > 0 && mine.every((r) => r.status === 'done') ? true : undefined
      },
      'live ingest-file task to finish'
    )
    const docs = await store.engine.cypher(
      `MATCH (d:Document) WHERE d.source ENDS WITH 'dropped.md' RETURN d.id AS id`
    )
    expect(docs).toHaveLength(1)
  }, 30_000)
})

describe('demo rule: file watch → Deno lane action (phase DoD)', () => {
  it('a non-matching change does not fire (condition filter)', async () => {
    writeFileSync(watchedFile, 'nothing interesting here', 'utf8')
    await new Promise((resolve) => setTimeout(resolve, 1_500))
    expect(ruleTasks('demo-file-rule')).toHaveLength(0)
  }, 20_000)

  it('fires on a matching change; the §13 approval gates the side-effecting sandbox run; the allowed write lands and the out-of-scope write is DENIED', async (ctx) => {
    if (denoUnavailable !== '') return ctx.skip(`deno lane unavailable: ${denoUnavailable}`)

    writeFileSync(watchedFile, 'deploy the new watcher build please', 'utf8')
    // The rule fires (kernel-mediated detection) and the queued action hits
    // the sandbox-run gate: user rules have NO standing grants → deferred
    // behind a pending approval (headless it would stay queued forever).
    const deferred = await waitFor(
      () => ruleTasks('demo-file-rule').find((row) => row.status === 'deferred'),
      'rule-action task to park behind the approval'
    )
    expect(deferred.last_error).toContain('waiting on approval')
    expect(existsSync(join(outDir, 'result.txt'))).toBe(false) // nothing ran yet

    const approval = stack.permissions
      .listApprovals({ status: 'pending' })
      .find((row) => row.agentId === 'rule:demo-file-rule' && row.tier === 'sandbox')
    expect(approval).toBeDefined()
    expect(approval?.details['fsWrite']).toEqual([outDir])

    // The dashboard decision (phase-10 surface): approve → the queue retries.
    stack.permissions.approve(approval!.id, 'user:test')
    queue.onApprovalDecided(approval!.id, 'approved')

    const done = await waitFor(
      () => ruleTasks('demo-file-rule').find((row) => row.status === 'done'),
      'rule action to run after approval',
      60_000 // may include first-run deno.exe extraction
    )
    expect(done.last_error).toBeNull()

    // The REAL outcome on the host: allowed write landed, escape did not.
    const result = readFileSync(join(outDir, 'result.txt'), 'utf8')
    expect(result).toContain('fired by demo-file-rule')
    expect(existsSync(join(outsideDir, 'evil.txt'))).toBe(false)

    // §13 span evidence: the same action first 'pending', then 'allow'.
    const decisions = spanRows(stack.appData, 'kernel.sandbox-run')
      .map((row) => spanAttributes(row))
      .filter((attrs) => attrs['rule.id'] === 'demo-file-rule')
      .map((attrs) => attrs['permission.decision'])
    expect(decisions).toContain('pending')
    expect(decisions[decisions.length - 1]).toBe('allow')
    // Detection itself was kernel-mediated fs-read within the rule's scope.
    const detects = spanRows(stack.appData, 'kernel.fs-read')
      .map((row) => spanAttributes(row))
      .filter((attrs) => attrs['rule.id'] === 'demo-file-rule')
    expect(detects.length).toBeGreaterThan(0)
    expect(detects.every((attrs) => attrs['permission.decision'] === 'allow')).toBe(true)
  }, 120_000)
})

describe('url watcher: net-gated polling, baseline, condition (§7)', () => {
  it('polls stay dark behind the §13 net approval; after approval a CHANGE (matching the condition) fires', async () => {
    // The first poll queued a net approval during watchers.start().
    const approval = await waitFor(
      () =>
        stack.permissions
          .listApprovals()
          .find((row) => row.agentId === 'rule:url-feed-rule' && row.actionKind === 'net'),
      'the url watch net approval'
    )
    expect(approval.details['host']).toBe(`127.0.0.1:${feedPort}`)
    expect(ruleTasks('url-feed-rule')).toHaveLength(0) // dark while pending

    stack.permissions.approve(approval.id, 'user:test')
    // Next poll (≤300ms) sets the BASELINE — no fire on first observation.
    await new Promise((resolve) => setTimeout(resolve, 1_200))
    expect(ruleTasks('url-feed-rule')).toHaveLength(0)

    // Content changes but the condition ("contains 'AI'") does not match.
    feedBody = 'sports results, weather, tides'
    await new Promise((resolve) => setTimeout(resolve, 1_200))
    expect(ruleTasks('url-feed-rule')).toHaveLength(0)

    // A matching change fires the rule.
    feedBody = 'breaking: AI system ships its own triggers phase'
    await waitFor(() => (ruleTasks('url-feed-rule').length > 0 ? true : undefined), 'url rule to fire')
    const task = ruleTasks('url-feed-rule')[0]!
    const payload = JSON.parse(task.payload_json) as { event: { kind: string; url: string } }
    expect(payload.event.kind).toBe('url')
    expect(payload.event.url).toContain(`127.0.0.1:${feedPort}`)
  }, 30_000)
})
