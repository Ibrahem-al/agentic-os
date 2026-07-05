/**
 * Phase-06 DoD over the REAL storage engine (offline, FakeEmbedder):
 * - fixture md file → expected chunk count, headings preserved as chunk
 *   boundaries, embeddings present (HNSW + FTS both find the chunks);
 * - identical re-ingest = ZERO writes (write-lane journal asserted);
 * - changed file = old chunks gone, new chunks present (replace, no
 *   versioning);
 * - tags: TAGGED edges on every chunk, existing Tag reused, missing created;
 * - watched folder: definition store + manual scan trigger.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  IngestError,
  WatchedFolderStore,
  chunkDocument,
  ingestDocument,
  ingestKnowledgeContent,
  ingestKnowledgeFile,
  scanWatchedFolder,
  type KnowledgeIngestDeps
} from '../../src/main/ingest'
import { untrusted } from '../../src/main/security'
import { KNOWLEDGE_INGEST_PROVENANCE } from '../../src/main/config'
import { OllamaClient } from '../../src/main/models'
import { fakeTextEmbedding } from '../fixtures/graph-seed'
import { FakeEmbedder } from '../fixtures/retrieval-fakes'
import { openTestStore, type TestStore } from './helpers'

/**
 * The DoD fixture: 4 headings + an intro paragraph, every section well under
 * the 512-token target → exactly 5 chunks, one per structural boundary.
 */
const HANDBOOK_MD = `Operations handbook for the greenhouse telemetry cluster.

# Irrigation
Watering runs at dawn using the moisture sensor average from the previous night.

## Valves
Valve controllers speak modbus and retry twice before raising an alert.

# Harvest
Harvest batches are weighed on the loading dock scale and logged to the ledger.

## Storage
Cold storage holds the harvest at four degrees until the courier collects it.
`
const EXPECTED_CHUNKS = 5

let store: TestStore
let embedder: FakeEmbedder
let deps: KnowledgeIngestDeps
let fixtureDir: string
let handbookPath: string

beforeAll(async () => {
  store = await openTestStore()
  embedder = new FakeEmbedder()
  deps = { engine: store.engine, embedder }
  fixtureDir = mkdtempSync(join(tmpdir(), 'agentic-os-ingest-'))
  handbookPath = join(fixtureDir, 'handbook.md')
  writeFileSync(handbookPath, HANDBOOK_MD, 'utf8')
})

afterAll(async () => {
  await store.cleanup()
  rmSync(fixtureDir, { recursive: true, force: true })
})

describe('fixture md file → Document + Knowledge chunks (DoD)', () => {
  it('ingests with the expected chunk count and heading boundaries', async () => {
    const result = await ingestKnowledgeFile(deps, handbookPath, { tags: ['greenhouse'] })
    expect(result.status).toBe('created')
    expect(result.source).toBe(handbookPath)
    expect(result.contentHash).toMatch(/^sha256:[0-9a-f]{64}$/)
    expect(result.chunkCount).toBe(EXPECTED_CHUNKS)
    expect(result.chunkIds).toHaveLength(EXPECTED_CHUNKS)
    expect(result.deletedChunkCount).toBe(0)

    // Headings preserved as chunk boundaries: chunk texts start at the
    // structural splits, in document order.
    const rows = await store.engine.cypher(
      `MATCH (d:Document {id: $id})-[:HAS_CHUNK]->(k:Knowledge)
       RETURN k.id AS id, k.content AS content, k.extracted_by AS extracted_by, k.confidence AS confidence
       ORDER BY k.id`,
      { id: result.documentId }
    )
    expect(rows).toHaveLength(EXPECTED_CHUNKS)
    const firstLines = rows.map((r) => String(r['content']).split('\n')[0])
    expect(firstLines).toEqual([
      'Operations handbook for the greenhouse telemetry cluster.',
      '# Irrigation',
      '## Valves',
      '# Harvest',
      '## Storage'
    ])
    for (const row of rows) {
      expect(String(row['extracted_by'])).toBe(KNOWLEDGE_INGEST_PROVENANCE)
      expect(Number(row['confidence'])).toBe(1)
    }

    // The Document node carries source, content_hash and ingested_at.
    const doc = await store.engine.cypher(
      'MATCH (d:Document {id: $id}) RETURN d.source AS source, d.content_hash AS hash, d.ingested_at AS at',
      { id: result.documentId }
    )
    expect(doc[0]?.['source']).toBe(handbookPath)
    expect(doc[0]?.['hash']).toBe(result.contentHash)
    expect(doc[0]?.['at']).toBeInstanceOf(Date)
  })

  it('embeddings are present: vector search and FTS both find the chunks', async () => {
    // The FakeEmbedder embeds chunk text with the same bag-of-words hash used
    // for queries, so the harvest chunk must be the nearest neighbor.
    const harvestChunk = chunkDocument(HANDBOOK_MD).find((c) => c.text.startsWith('# Harvest'))
    expect(harvestChunk).toBeDefined()
    const hits = await store.engine.vectorSearch('Knowledge', fakeTextEmbedding(harvestChunk?.text ?? ''), 3)
    expect(hits.length).toBeGreaterThan(0)
    expect(hits[0]?.distance).toBeLessThan(1e-6) // exact same text → distance ~0
    const top = await store.engine.cypher('MATCH (k:Knowledge {id: $id}) RETURN k.content AS content', {
      id: hits[0]?.id ?? ''
    })
    expect(String(top[0]?.['content'])).toContain('# Harvest')

    const fts = await store.engine.textSearch('Knowledge', 'courier collects harvest', 5)
    expect(fts.length).toBeGreaterThan(0)
  })

  it('tags every chunk: TAGGED edges, tag created when missing / reused when present', async () => {
    const tagged = await store.engine.cypher(
      `MATCH (d:Document)-[:HAS_CHUNK]->(k:Knowledge)-[:TAGGED]->(t:Tag)
       WHERE d.source = $source
       RETURN k.id AS chunk, t.id AS tag, t.name AS name, t.is_global AS global`,
      { source: handbookPath }
    )
    expect(tagged).toHaveLength(EXPECTED_CHUNKS) // one tag × five chunks
    for (const row of tagged) {
      expect(row['name']).toBe('greenhouse')
      expect(row['tag']).toBe('tag-greenhouse')
      expect(row['global']).toBe(false)
    }

    // Re-tagging with an existing tag reuses the node (no duplicate Tag).
    const notePath = join(fixtureDir, 'note.md')
    writeFileSync(notePath, '# Note\nGreenhouse fan schedule for summer.', 'utf8')
    const result = await ingestKnowledgeFile(deps, notePath, { tags: ['greenhouse', 'Cooling Systems'] })
    expect(result.tags).toEqual([
      { id: 'tag-greenhouse', name: 'greenhouse', created: false },
      { id: 'tag-cooling-systems', name: 'Cooling Systems', created: true }
    ])
    const tagCount = await store.engine.cypher(
      "MATCH (t:Tag) WHERE t.name = 'greenhouse' RETURN count(t) AS c"
    )
    expect(Number(tagCount[0]?.['c'])).toBe(1)
  })
})

describe('content-hash dedup + replace-on-change (DoD)', () => {
  it('identical re-ingest is a NO-OP: zero write-lane jobs, zero embeds', async () => {
    const writesBefore = store.engine.lane.enqueuedCount
    const embedsBefore = embedder.calls
    const result = await ingestKnowledgeFile(deps, handbookPath, { tags: ['greenhouse'] })
    expect(result.status).toBe('unchanged')
    expect(result.chunkCount).toBe(EXPECTED_CHUNKS)
    expect(store.engine.lane.enqueuedCount).toBe(writesBefore) // ZERO writes
    expect(embedder.calls).toBe(embedsBefore) // not even a model call
  })

  it('changed file: old chunks gone, new chunks present, hash updated', async () => {
    const oldRows = await store.engine.cypher(
      `MATCH (d:Document)-[:HAS_CHUNK]->(k:Knowledge) WHERE d.source = $source RETURN k.id AS id`,
      { source: handbookPath }
    )
    const oldIds = oldRows.map((r) => String(r['id']))
    expect(oldIds).toHaveLength(EXPECTED_CHUNKS)

    const changed = HANDBOOK_MD.replace(
      'Cold storage holds the harvest at four degrees until the courier collects it.',
      'Cold storage now holds produce at three degrees and the drone fleet collects it hourly.'
    )
    writeFileSync(handbookPath, changed, 'utf8')
    const result = await ingestKnowledgeFile(deps, handbookPath, { tags: ['greenhouse'] })
    expect(result.status).toBe('replaced')
    expect(result.deletedChunkCount).toBe(EXPECTED_CHUNKS)
    expect(result.chunkCount).toBe(EXPECTED_CHUNKS)

    // Old chunk ids are gone…
    const survivors = await store.engine.cypher(
      'UNWIND $ids AS cid MATCH (k:Knowledge {id: cid}) RETURN count(k) AS c',
      { ids: oldIds }
    )
    expect(Number(survivors[0]?.['c'])).toBe(0)
    // …the new set is present under the SAME document (no versioning)…
    const now = await store.engine.cypher(
      `MATCH (d:Document {id: $id})-[:HAS_CHUNK]->(k:Knowledge) RETURN k.id AS id, k.content AS content ORDER BY k.id`,
      { id: result.documentId }
    )
    expect(now.map((r) => String(r['id']))).toEqual([...result.chunkIds].sort())
    expect(now.some((r) => String(r['content']).includes('drone fleet'))).toBe(true)
    expect(now.some((r) => String(r['content']).includes('four degrees'))).toBe(false)
    // …the hash moved, and only one Document exists for the source.
    const docs = await store.engine.cypher(
      'MATCH (d:Document) WHERE d.source = $source RETURN d.id AS id, d.content_hash AS hash',
      { source: handbookPath }
    )
    expect(docs).toHaveLength(1)
    expect(docs[0]?.['hash']).toBe(result.contentHash)

    // Freshness is queryable: FTS reflects the replacement.
    const fts = await store.engine.textSearch('Knowledge', 'drone fleet collects produce', 5)
    expect(fts.length).toBeGreaterThan(0)
  })

  it('inline content dedups by content-derived source', async () => {
    const text = '# Meeting notes\nDiscussed the pergola trellis budget for autumn planting.'
    const first = await ingestDocument(deps, text)
    expect(first.status).toBe('created')
    expect(first.source.startsWith('inline:')).toBe(true)
    const again = await ingestDocument(deps, text)
    expect(again.status).toBe('unchanged')
    expect(again.documentId).toBe(first.documentId)
  })
})

describe('input validation (clear errors, nothing ingested)', () => {
  it('rejects deferred rich-document formats (PDF etc.)', async () => {
    const pdfPath = join(fixtureDir, 'report.pdf')
    writeFileSync(pdfPath, '%PDF-1.7 fake', 'utf8')
    await expect(ingestKnowledgeFile(deps, pdfPath)).rejects.toThrow(/deferred/)
    await expect(ingestKnowledgeFile(deps, pdfPath)).rejects.toBeInstanceOf(IngestError)
  })

  it('rejects unknown extensions, directories, oversized and missing files', async () => {
    const weird = join(fixtureDir, 'blob.xyz')
    writeFileSync(weird, 'data', 'utf8')
    await expect(ingestKnowledgeFile(deps, weird)).rejects.toThrow(/unsupported file extension/)
    await expect(ingestKnowledgeFile(deps, fixtureDir)).rejects.toThrow(/unsupported file extension|directory/)
    await expect(ingestKnowledgeFile(deps, join(fixtureDir, 'missing.md'))).rejects.toThrow(/not found/)
    const big = join(fixtureDir, 'big.txt')
    writeFileSync(big, 'a'.repeat(1024 * 1024 + 1), 'utf8')
    await expect(ingestKnowledgeFile(deps, big)).rejects.toThrow(/bytes/)
  })

  it('rejects empty content and a path-looking string that does not exist', async () => {
    await expect(ingestDocument(deps, '   \n  ')).rejects.toThrow(/no content/)
    await expect(ingestDocument(deps, join(fixtureDir, 'ghost.md'))).rejects.toThrow(/not found/)
  })

  it('validation failures leave the write lane untouched', async () => {
    const writes = store.engine.lane.enqueuedCount
    await expect(ingestDocument(deps, join(fixtureDir, 'ghost.md'))).rejects.toThrow()
    expect(store.engine.lane.enqueuedCount).toBe(writes)
  })
})

describe('watched folders (definition + manual trigger; chokidar lands in phase 11)', () => {
  it('store: add / list / remove, duplicate + invalid rejected', () => {
    const configPath = join(fixtureDir, 'watched-folders.json')
    const storeW = new WatchedFolderStore({ configPath })
    expect(storeW.list()).toEqual([])
    const def = storeW.add({ name: 'docs', path: join(fixtureDir, 'watched'), tags: ['greenhouse'] })
    expect(def.enabled).toBe(true)
    expect(storeW.list()).toHaveLength(1)
    expect(() => storeW.add({ name: 'docs', path: 'x' })).toThrow(/already exists/)
    expect(() => storeW.add({ name: 'bad', path: '' })).toThrow(/invalid watched-folder/)
    expect(() => storeW.add({ name: 'bad', path: 'p', extensions: ['md'] })).toThrow(/dot/)
    expect(storeW.remove('docs')).toBe(true)
    expect(storeW.remove('docs')).toBe(false)
  })

  it('manual scan ingests supported files, prunes junk dirs, reports skips + failures', async () => {
    const watchDir = join(fixtureDir, 'watched')
    mkdirSync(join(watchDir, 'sub'), { recursive: true })
    mkdirSync(join(watchDir, 'node_modules'), { recursive: true })
    writeFileSync(join(watchDir, 'alpha.md'), '# Alpha\nSprinkler zones map for the west field.', 'utf8')
    writeFileSync(join(watchDir, 'beta.txt'), 'Fertilizer ratios for tomato rows in spring.', 'utf8')
    writeFileSync(join(watchDir, 'sub', 'gamma.md'), '# Gamma\nBee hive inspection checklist for the orchard.', 'utf8')
    writeFileSync(join(watchDir, 'report.pdf'), '%PDF fake', 'utf8')
    writeFileSync(join(watchDir, 'empty.md'), '   ', 'utf8')
    writeFileSync(join(watchDir, 'node_modules', 'ignored.md'), '# Ignored\nnever read', 'utf8')

    const result = await scanWatchedFolder(deps, {
      name: 'docs',
      path: watchDir,
      tags: ['greenhouse'],
      enabled: true
    })
    expect(result.scannedFiles).toBe(5) // node_modules pruned before counting
    expect(result.ingested.map((r) => r.status)).toEqual(['created', 'created', 'created'])
    expect(result.skipped).toHaveLength(1)
    expect(result.skipped[0]?.reason).toContain('deferred')
    expect(result.failed).toHaveLength(1) // empty.md → no content
    expect(result.failed[0]?.error).toContain('no content')

    // TAGGED flows through the scan's tags.
    const tagged = await store.engine.cypher(
      `MATCH (d:Document)-[:HAS_CHUNK]->(k:Knowledge)-[:TAGGED]->(t:Tag {id: 'tag-greenhouse'})
       WHERE d.source = $source RETURN count(k) AS c`,
      { source: join(watchDir, 'alpha.md') }
    )
    expect(Number(tagged[0]?.['c'])).toBeGreaterThan(0)

    // Re-scan: everything unchanged, ZERO write-lane jobs.
    const writesBefore = store.engine.lane.enqueuedCount
    const rescan = await scanWatchedFolder(deps, { name: 'docs', path: watchDir, tags: ['greenhouse'], enabled: true })
    expect(rescan.ingested.map((r) => r.status)).toEqual(['unchanged', 'unchanged', 'unchanged'])
    expect(store.engine.lane.enqueuedCount).toBe(writesBefore)
  })

  it('scan of a missing or non-directory path fails loudly', async () => {
    await expect(
      scanWatchedFolder(deps, { name: 'x', path: join(fixtureDir, 'nope'), tags: [], enabled: true })
    ).rejects.toThrow(/not found/)
    await expect(
      scanWatchedFolder(deps, { name: 'x', path: handbookPath, tags: [], enabled: true })
    ).rejects.toThrow(/not a directory/)
  })
})

describe.skipIf(process.env['OLLAMA'] !== '1')('live ingestion (OLLAMA=1): real bge-m3 embeddings', () => {
  it('ingested chunks are semantically retrievable via a paraphrased query', { timeout: 300_000 }, async () => {
    // Separate store: real 1024-dim bge-m3 vectors must not share an HNSW
    // index with the offline bag-of-words fakes.
    const liveStore = await openTestStore()
    try {
      const client = new OllamaClient()
      const md = [
        '# Release checklist',
        'Run the smoke suite and verify the checkout flow before shipping a storefront release.',
        '',
        '# Espresso machine',
        'Descale the office espresso machine every month with the citric solution.'
      ].join('\n')
      const result = await ingestKnowledgeContent(
        { engine: liveStore.engine, embedder: client },
        untrusted(md),
        { source: 'live-fixture.md', tags: ['ops'] }
      )
      expect(result.status).toBe('created')
      expect(result.chunkCount).toBe(2)

      const [query] = await client.embed(['how do we safely ship a new version of the shop'])
      const hits = await liveStore.engine.vectorSearch('Knowledge', query as number[], 2)
      expect(hits).toHaveLength(2)
      const top = await liveStore.engine.cypher('MATCH (k:Knowledge {id: $id}) RETURN k.content AS content', {
        id: hits[0]?.id ?? ''
      })
      // Real semantics: the release chunk beats the espresso chunk.
      expect(String(top[0]?.['content'])).toContain('Release checklist')
    } finally {
      await liveStore.cleanup()
    }
  })
})
