/**
 * Phase-07 DoD over the REAL storage engine (offline: FakeEmbedder /
 * FakeReranker / fake summarizer; the Tree-sitter WASM grammars are local):
 * - fixture mini-repo (TS + Python) → GOLDEN Components + DEPENDS_ON edges;
 * - .gitignore / node_modules / binaries / >1 MB respected;
 * - Project matched-by-path / created with a README summary (small LLM),
 *   README/markdown/docstrings → Knowledge tagged to the Project;
 * - identical re-ingest = ZERO writes (lane journal + model-call counters);
 * - touching ONE file changes only that file's units (per-unit content hash);
 * - deleting a file prunes its components and its docstring document;
 * - retrieve() over the ingested graph surfaces relevant Components.
 */
import { createHash } from 'node:crypto'
import { cpSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { CODEBASE_DOCS_SOURCE_PREFIX, CODEBASE_INGEST_PROVENANCE, INGEST_MAX_FILE_BYTES } from '../../src/main/config'
import {
  IngestError,
  ingestCodebase,
  type CodebaseIngestDeps,
  type CodebaseIngestProgress,
  type IngestCodebaseResult,
  type ProjectSummarizer
} from '../../src/main/ingest'
import { ProviderRouter, defaultModelSettings, type OllamaLike } from '../../src/main/models'
import { createRetriever, type SmallLlm } from '../../src/main/retrieval'
import { FakeEmbedder, FakeReranker } from '../fixtures/retrieval-fakes'
import { openTestStore, type TestStore } from './helpers'

const FIXTURE_DIR = fileURLToPath(new URL('../fixtures/mini-repo', import.meta.url))

const PROJECT_SUMMARY =
  'Sprout panel computes greenhouse watering schedules from smoothed sensor readings and serves them over HTTP.'

/** Fake local summarizer: counts calls, echoes a deterministic summary. */
class FakeSummarizer {
  calls: string[] = []

  async generate(prompt: string): Promise<{ text: string }> {
    this.calls.push(prompt)
    return { text: PROJECT_SUMMARY }
  }
}

/** The golden Component list for the mini-repo: name → §18 type. */
const GOLDEN_COMPONENTS: ReadonlyMap<string, string> = new Map([
  ['src/schedule.ts:WateringSchedule', 'model'],
  ['src/schedule.ts:computeSchedule', 'function'],
  ['src/schedule.ts:toMinutes', 'function'],
  ['src/util.ts:clamp', 'function'],
  ['src/util.ts:formatLabel', 'function'],
  ['src/server.ts:GET /schedule', 'route'],
  ['src/legacy.js:legacyThing', 'function'],
  ['py/pipeline.py:SensorReading', 'model'],
  ['py/pipeline.py:Batch', 'model'],
  ['py/pipeline.py:run_pipeline', 'function'],
  ['py/filters.py:smooth', 'function'],
  ['py/api.py:GET /readings', 'route']
])

/** The golden DEPENDS_ON list (from-name → to-name), incl. barrel + __init__ hops. */
const GOLDEN_DEPENDS_ON: readonly (readonly [string, string])[] = [
  ['py/api.py:GET /readings', 'py/pipeline.py:run_pipeline'],
  ['py/pipeline.py:run_pipeline', 'py/filters.py:smooth'],
  ['src/schedule.ts:computeSchedule', 'src/util.ts:clamp'],
  ['src/server.ts:GET /schedule', 'src/schedule.ts:computeSchedule']
]

let store: TestStore
let embedder: FakeEmbedder
let summarizer: FakeSummarizer
let deps: CodebaseIngestDeps
let repoDir: string
let expectedProjectId: string
let firstResult: IngestCodebaseResult
const progressEvents: CodebaseIngestProgress[] = []

const sha16 = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 16)

function writeInRepo(relPath: string, content: string | Buffer): void {
  const path = join(repoDir, ...relPath.split('/'))
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, content)
}

async function componentRows(): Promise<Map<string, { id: string; type: string }>> {
  const rows = await store.engine.cypher(
    `MATCH (p:Project {id: $pid})-[:HAS_COMPONENT]->(c:Component)
     RETURN c.id AS id, c.name AS name, c.type AS type`,
    { pid: expectedProjectId }
  )
  return new Map(rows.map((r) => [String(r['name']), { id: String(r['id']), type: String(r['type']) }]))
}

async function dependsOnPairs(): Promise<[string, string][]> {
  const rows = await store.engine.cypher(
    'MATCH (a:Component)-[r:DEPENDS_ON]->(b:Component) RETURN a.name AS f, b.name AS t ORDER BY a.name, b.name'
  )
  return rows.map((r) => [String(r['f']), String(r['t'])])
}

beforeAll(async () => {
  store = await openTestStore()
  embedder = new FakeEmbedder()
  summarizer = new FakeSummarizer()
  deps = { engine: store.engine, embedder, llm: summarizer }

  // Work on a COPY: the touch/delete tests mutate files, and the junk the
  // walk must skip (node_modules, dist, binaries, >1 MB) is created here
  // rather than checked into the repo.
  repoDir = join(mkdtempSync(join(tmpdir(), 'agentic-os-minirepo-')), 'sprout')
  cpSync(FIXTURE_DIR, repoDir, { recursive: true })
  renameSync(join(repoDir, 'gitignore'), join(repoDir, '.gitignore'))
  writeInRepo('node_modules/leftpad/index.js', 'export function leftpad(s) { return s }\n')
  writeInRepo('dist/junk.ts', 'export function bundledJunk() { return 1 }\n')
  writeInRepo('binary.py', Buffer.from([0x64, 0x65, 0x66, 0x00, 0x01]))
  writeInRepo('huge.md', `# big\n${'x'.repeat(INGEST_MAX_FILE_BYTES)}\n`)
  writeInRepo('src/.gitignore', 'scratch.ts\n')
  writeInRepo('src/scratch.ts', 'export function scratchFn() { return 0 }\n')

  expectedProjectId = `proj-${sha16(process.platform === 'win32' ? repoDir.toLowerCase() : repoDir)}`
  firstResult = await ingestCodebase(deps, repoDir, { onProgress: (p) => progressEvents.push(p) })
})

afterAll(async () => {
  await store.cleanup()
  rmSync(join(repoDir, '..'), { recursive: true, force: true })
})

describe('fixture mini-repo → golden Components + DEPENDS_ON (DoD)', () => {
  it('creates the Project and exactly the golden component set', async () => {
    expect(firstResult.status).toBe('created')
    expect(firstResult.projectCreated).toBe(true)
    expect(firstResult.projectId).toBe(expectedProjectId)
    expect(firstResult.projectName).toBe('sprout-panel') // from package.json
    expect(firstResult.components.total).toBe(GOLDEN_COMPONENTS.size)
    expect(firstResult.components.created).toBe(GOLDEN_COMPONENTS.size)

    const components = await componentRows()
    expect(new Map([...components.entries()].map(([name, c]) => [name, c.type]))).toEqual(GOLDEN_COMPONENTS)
    // gitignored / pruned / junk units never became components.
    const allNames = [...components.keys()].join('\n')
    for (const forbidden of ['shouldNotAppear', 'scratchFn', 'bundledJunk', 'leftpad', '_internal_helper']) {
      expect(allNames).not.toContain(forbidden)
    }
  })

  it('stamps provenance on every component node (§21 rule 4)', async () => {
    const rows = await store.engine.cypher(
      'MATCH (c:Component) RETURN c.extracted_by AS by, c.confidence AS conf'
    )
    expect(rows.length).toBe(GOLDEN_COMPONENTS.size)
    for (const row of rows) {
      expect(String(row['by'])).toBe(CODEBASE_INGEST_PROVENANCE)
      expect(Number(row['conf'])).toBe(1)
    }
  })

  it('creates exactly the golden DEPENDS_ON edges, provenance-stamped', async () => {
    expect(firstResult.dependsOn.total).toBe(GOLDEN_DEPENDS_ON.length)
    expect(await dependsOnPairs()).toEqual(GOLDEN_DEPENDS_ON.map((p) => [...p]))
    const stamped = await store.engine.cypher(
      'MATCH (:Component)-[r:DEPENDS_ON]->(:Component) RETURN r.extracted_by AS by, r.confidence AS conf'
    )
    for (const row of stamped) {
      expect(String(row['by'])).toBe(CODEBASE_INGEST_PROVENANCE)
      expect(Number(row['conf'])).toBe(1)
    }
  })

  it('skip list carries reasons for binaries and oversized files', () => {
    const reasons = new Map(firstResult.skipped.map((s) => [s.relPath, s.reason]))
    expect(reasons.get('binary.py')).toContain('binary')
    expect(reasons.get('huge.md')).toContain('exceeds')
    // gitignored entries are invisible, not "skipped".
    expect(reasons.has('ignored.ts')).toBe(false)
  })

  it('reports progress events (n files / n components) for the UI', () => {
    const phases = new Set(progressEvents.map((p) => p.phase))
    for (const phase of ['walking', 'parsing', 'writing', 'knowledge']) expect(phases.has(phase as never)).toBe(true)
    const last = progressEvents[progressEvents.length - 1]
    expect(last?.componentsFound).toBe(GOLDEN_COMPONENTS.size)
    expect(last?.filesWalked).toBe(firstResult.filesWalked)
  })
})

describe('Project + Knowledge (§18: README summary via small LLM, tagged docs)', () => {
  it('created the Project with the small-LLM summary and a real embedding', async () => {
    expect(summarizer.calls.length).toBe(1) // one README summary call
    expect(summarizer.calls[0]).toContain('Sprout is a greenhouse control panel')
    const rows = await store.engine.cypher(
      'MATCH (p:Project {id: $id}) RETURN p.name AS name, p.summary AS summary',
      { id: expectedProjectId }
    )
    expect(rows[0]?.['name']).toBe('sprout-panel')
    expect(rows[0]?.['summary']).toBe(PROJECT_SUMMARY)
    // The embedding is indexed: searching what retrieval renders finds it at ~0.
    const { fakeTextEmbedding } = await import('../fixtures/graph-seed')
    const hits = await store.engine.vectorSearch(
      'Project',
      fakeTextEmbedding(`sprout-panel — ${PROJECT_SUMMARY}`),
      1
    )
    expect(hits[0]?.id).toBe(expectedProjectId)
    expect(hits[0]?.distance).toBeLessThan(1e-6)
  })

  it('tags the Project and every ingested chunk with the project tag', async () => {
    const tagged = await store.engine.cypher(
      'MATCH (p:Project {id: $id})-[:TAGGED]->(t:Tag) RETURN t.id AS id, t.name AS name, t.is_global AS g',
      { id: expectedProjectId }
    )
    expect(tagged).toEqual([{ id: 'tag-sprout-panel', name: 'sprout-panel', g: false }])
    const untaggedChunks = await store.engine.cypher(
      'MATCH (k:Knowledge) WHERE NOT (k)-[:TAGGED]->(:Tag {id: $tag}) RETURN count(k) AS c',
      { tag: 'tag-sprout-panel' }
    )
    expect(Number(untaggedChunks[0]?.['c'])).toBe(0)
  })

  it('ingested README + negated-markdown + docstring digests as Documents', async () => {
    const sources = firstResult.knowledge.documents.map((d) => d.source)
    expect(sources).toContain(join(repoDir, 'README.md'))
    expect(sources).toContain(join(repoDir, 'secretpublic.md'))
    for (const relPath of ['src/schedule.ts', 'src/util.ts', 'py/pipeline.py', 'py/filters.py', 'py/api.py']) {
      expect(sources).toContain(`${CODEBASE_DOCS_SOURCE_PREFIX}${join(repoDir, ...relPath.split('/'))}`)
    }
    expect(sources).toHaveLength(7) // nothing else has doc text
    expect(firstResult.knowledge.failed).toEqual([])
    // Docstring content is searchable knowledge.
    const fts = await store.engine.textSearch('Knowledge', 'moving average sensor jitter', 3)
    expect(fts.length).toBeGreaterThan(0)
  })
})

describe('re-ingest semantics (per-unit content hash, §18)', () => {
  it('identical re-ingest performs ZERO writes and ZERO model calls', async () => {
    const lanesBefore = store.engine.lane.enqueuedCount
    const embedsBefore = embedder.calls
    const llmBefore = summarizer.calls.length
    const result = await ingestCodebase(deps, repoDir)
    expect(result.status).toBe('unchanged')
    expect(result.projectCreated).toBe(false)
    expect(result.components).toEqual({ total: 12, created: 0, deleted: 0, unchanged: 12 })
    expect(result.knowledge.documents.every((d) => d.status === 'unchanged')).toBe(true)
    expect(result.knowledge.pruned).toEqual([])
    expect(store.engine.lane.enqueuedCount).toBe(lanesBefore)
    expect(embedder.calls).toBe(embedsBefore)
    expect(summarizer.calls.length).toBe(llmBefore)
  })

  it('touching ONE file changes only that file\'s units (DoD)', async () => {
    const before = await componentRows()
    const updatedAtBefore = new Map<string, string>()
    for (const [name, c] of before) {
      const row = await store.engine.cypher('MATCH (c:Component {id: $id}) RETURN c.updated_at AS at', { id: c.id })
      updatedAtBefore.set(name, String(row[0]?.['at']))
    }

    // Change clamp's BODY only — its JSDoc (and every other unit) untouched.
    writeInRepo(
      'src/util.ts',
      [
        '/** Clamp a value into the inclusive range. */',
        'export function clamp(value: number, low: number, high: number): number {',
        '  if (value < low) return low',
        '  return value > high ? high : value',
        '}',
        '',
        'export function formatLabel(name: string): string {',
        '  return name.trim().toUpperCase()',
        '}'
      ].join('\n')
    )

    const lanesBefore = store.engine.lane.enqueuedCount
    const result = await ingestCodebase(deps, repoDir)
    expect(result.status).toBe('updated')
    // Exactly one unit replaced: old clamp id out, new clamp id in.
    expect(result.components).toEqual({ total: 12, created: 1, deleted: 1, unchanged: 11 })
    // The docstring digest did not change → the ONLY lane job is the diff job.
    expect(store.engine.lane.enqueuedCount).toBe(lanesBefore + 1)

    const after = await componentRows()
    expect(after.size).toBe(12)
    for (const [name, c] of after) {
      if (name === 'src/util.ts:clamp') {
        expect(c.id).not.toBe(before.get(name)?.id) // content hash moved
        continue
      }
      // Every other unit: same node, untouched (id AND updated_at stable).
      expect(c.id).toBe(before.get(name)?.id)
      const row = await store.engine.cypher('MATCH (c:Component {id: $id}) RETURN c.updated_at AS at', { id: c.id })
      expect(String(row[0]?.['at'])).toBe(updatedAtBefore.get(name))
    }
    // The dependency edge followed the replacement.
    expect(result.dependsOn.created).toBe(1)
    expect(await dependsOnPairs()).toEqual(GOLDEN_DEPENDS_ON.map((p) => [...p]))
  })

  it('deleting a file prunes its components and its docstring document', async () => {
    rmSync(join(repoDir, 'py', 'filters.py'))
    const result = await ingestCodebase(deps, repoDir)
    expect(result.status).toBe('updated')
    expect(result.components).toEqual({ total: 11, created: 0, deleted: 1, unchanged: 11 })
    const prunedSource = `${CODEBASE_DOCS_SOURCE_PREFIX}${join(repoDir, 'py', 'filters.py')}`
    expect(result.knowledge.pruned).toEqual([prunedSource])

    const components = await componentRows()
    expect(components.has('py/filters.py:smooth')).toBe(false)
    expect(components.has('py/pipeline.py:run_pipeline')).toBe(true) // its unit did not change
    expect(await dependsOnPairs()).toEqual(
      GOLDEN_DEPENDS_ON.filter(([, to]) => to !== 'py/filters.py:smooth').map((p) => [...p])
    )
    const doc = await store.engine.cypher('MATCH (d:Document) WHERE d.source = $s RETURN d.id AS id', {
      s: prunedSource
    })
    expect(doc).toHaveLength(0)
  })
})

describe('validation failures leave the store untouched', () => {
  it('nonexistent folder → NOT_FOUND; a file path → INVALID_INPUT', async () => {
    const lanesBefore = store.engine.lane.enqueuedCount
    await expect(ingestCodebase(deps, join(repoDir, 'no-such-dir'))).rejects.toMatchObject({
      name: 'IngestError',
      code: 'NOT_FOUND'
    })
    await expect(ingestCodebase(deps, join(repoDir, 'README.md'))).rejects.toMatchObject({
      name: 'IngestError',
      code: 'INVALID_INPUT'
    })
    await expect(ingestCodebase(deps, '')).rejects.toBeInstanceOf(IngestError)
    expect(store.engine.lane.enqueuedCount).toBe(lanesBefore)
  })
})

describe('retrieve() over the ingested graph surfaces Components (DoD)', () => {
  it('a task about the codebase pulls Component items into the bundle', async () => {
    const passingCritic: SmallLlm = { generate: async () => ({ text: '{"score": 10, "missing": "none"}' }) }
    const retriever = createRetriever({
      engine: store.engine,
      embedder,
      reranker: new FakeReranker(),
      llm: passingCritic
    })
    const bundle = await retriever.retrieve('how are watering schedules computed for a greenhouse zone', [])
    const components = bundle.items.filter((i) => i.label === 'Component')
    expect(components.length).toBeGreaterThan(0)
    expect(components.map((c) => c.text).join('\n')).toContain('schedule')
  })
})

describe('README summary hardening (phase-04 finding: qwen3 narrates)', () => {
  it('rejects a narrated LLM reply and falls back to the README first paragraph', async () => {
    const narrator = {
      generate: async () => ({
        text: "We are summarizing the README for a project. Let's try: it flips widgets."
      })
    }
    const dir = join(mkdtempSync(join(tmpdir(), 'agentic-os-narrated-')), 'workshop')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'README.md'), '# Workshop\n\nA tiny tool that flips widget bits for the workshop.\n', 'utf8')
    writeFileSync(join(dir, 'main.py'), 'def flip():\n    return 1\n', 'utf8')
    try {
      const result = await ingestCodebase({ engine: store.engine, embedder, llm: narrator }, dir)
      const rows = await store.engine.cypher('MATCH (p:Project {id: $id}) RETURN p.summary AS s', {
        id: result.projectId
      })
      expect(String(rows[0]?.['s'])).toBe('A tiny tool that flips widget bits for the workshop.')
    } finally {
      rmSync(join(dir, '..'), { recursive: true, force: true })
    }
  })
})

describe('Project summary via ProviderRouter (phase-16b)', () => {
  const ROUTER_SUMMARY = 'Widgetworks flips widget bits and serves them over a tiny HTTP endpoint for the workshop.'

  /** A keyless local-only router over a recording fake Ollama. */
  function localRouter(reply: string): { router: ProviderRouter; calls: string[] } {
    const calls: string[] = []
    const ollama: OllamaLike = {
      generate: async (prompt) => {
        calls.push(prompt)
        return { text: reply }
      }
    }
    return { router: new ProviderRouter({ loadSnapshot: () => defaultModelSettings(), ollama, makeCloud: () => null }), calls }
  }

  /** An injected summarizer that must never fire when a router is wired. */
  const poison: ProjectSummarizer = {
    generate: async () => {
      throw new Error('injected llm must not be called when a router is wired')
    }
  }

  it('generates the Project summary through forRole to the LOCAL tier (poison llm untouched)', async () => {
    const { router, calls } = localRouter(ROUTER_SUMMARY)
    const dir = join(mkdtempSync(join(tmpdir(), 'agentic-os-router-ingest-')), 'widgetworks')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'README.md'), '# Widgetworks\n\nA tiny tool that flips widget bits for the workshop.\n', 'utf8')
    writeFileSync(join(dir, 'main.py'), 'def flip():\n    return 1\n', 'utf8')
    try {
      const result = await ingestCodebase({ engine: store.engine, embedder, llm: poison, router }, dir)
      const rows = await store.engine.cypher('MATCH (p:Project {id: $id}) RETURN p.summary AS s', { id: result.projectId })
      expect(String(rows[0]?.['s'])).toBe(ROUTER_SUMMARY)
      // The router carried the README-summary call to the local tier.
      expect(calls).toHaveLength(1)
      expect(calls[0]).toContain('Widgetworks')
    } finally {
      rmSync(join(dir, '..'), { recursive: true, force: true })
    }
  })
})
