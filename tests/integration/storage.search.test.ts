/**
 * DoD: vector + FTS — 3 embedded nodes inserted AFTER index creation (v1
 * migration builds the indexes on empty tables), nearest-neighbor and keyword
 * search return correctly. Offline by construction; CI re-runs this suite
 * under real network denial.
 *
 * Token choice matters: the default FTS analyzer drops some tokens ('hello')
 * and strips digits ('zebra7' ≡ 'zebra') — fixtures use distinct alphabetic
 * words (phase-00 finding 4 + phase-01 probes).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { EMBEDDING_DIM } from '../../src/main/config'
import { basisEmbedding, blendEmbedding, EXTENSIONS_DIR, openTestStore, type TestStore } from './helpers'

let store: TestStore

beforeAll(async () => {
  store = await openTestStore()
  await store.engine.upsertNode('Knowledge', {
    id: 'k-waterfall',
    content: 'alpha waterfall document',
    embedding: basisEmbedding(EMBEDDING_DIM, 0)
  })
  await store.engine.upsertNode('Knowledge', {
    id: 'k-mountain',
    content: 'bravo mountain document',
    embedding: basisEmbedding(EMBEDDING_DIM, 1)
  })
  await store.engine.upsertNode('Knowledge', {
    id: 'k-glacier',
    content: 'charlie glacier document',
    embedding: blendEmbedding(EMBEDDING_DIM, 0, 1, 0.9)
  })
})
afterAll(async () => {
  await store.cleanup()
})

describe('vector search (HNSW, cosine)', () => {
  it('returns nearest neighbors in distance order', async () => {
    const hits = await store.engine.vectorSearch('Knowledge', basisEmbedding(EMBEDDING_DIM, 0), 3)
    expect(hits.map((h) => h.id)).toEqual(['k-waterfall', 'k-glacier', 'k-mountain'])
    expect(hits[0]?.distance).toBeCloseTo(0, 5)
    expect(hits[0]!.distance).toBeLessThan(hits[1]!.distance)
    expect(hits[1]!.distance).toBeLessThan(hits[2]!.distance)
  })

  it('respects k', async () => {
    const hits = await store.engine.vectorSearch('Knowledge', basisEmbedding(EMBEDDING_DIM, 1), 1)
    expect(hits.map((h) => h.id)).toEqual(['k-mountain'])
  })

  it('reflects an embedding update (drop→set→recreate dance)', async () => {
    // Move k-mountain from axis 1 to axis 0: it must become a near neighbor
    // of the axis-0 query.
    const result = await store.engine.upsertNode('Knowledge', {
      id: 'k-mountain',
      embedding: blendEmbedding(EMBEDDING_DIM, 0, 1, 0.95)
    })
    expect(result.created).toBe(false)
    expect(result.embeddingRebuilt).toBe(true)

    const hits = await store.engine.vectorSearch('Knowledge', basisEmbedding(EMBEDDING_DIM, 0), 3)
    expect(hits[0]?.id).toBe('k-waterfall')
    expect(hits.map((h) => h.id)).toContain('k-mountain')
    const mountain = hits.find((h) => h.id === 'k-mountain')
    const glacier = hits.find((h) => h.id === 'k-glacier')
    expect(mountain!.distance).toBeLessThan(glacier!.distance)

    const unchanged = await store.engine.upsertNode('Knowledge', {
      id: 'k-mountain',
      embedding: blendEmbedding(EMBEDDING_DIM, 0, 1, 0.95)
    })
    expect(unchanged.embeddingRebuilt).toBe(false) // identical embedding → no rebuild
  })

  it('validates label, dimension and k', async () => {
    await expect(store.engine.vectorSearch('Knowledge', [0.1, 0.2], 3)).rejects.toThrow(/1024-dim/)
    await expect(store.engine.vectorSearch('Knowledge', basisEmbedding(EMBEDDING_DIM, 0), 0)).rejects.toThrow(/k must/)
    await expect(
      store.engine.vectorSearch('Session' as never, basisEmbedding(EMBEDDING_DIM, 0), 3)
    ).rejects.toThrow(/not a retrievable label/)
  })
})

describe('full-text search (FTS)', () => {
  it('finds a node by a distinctive keyword', async () => {
    const hits = await store.engine.textSearch('Knowledge', 'waterfall', 5)
    expect(hits.map((h) => h.id)).toEqual(['k-waterfall'])
    expect(hits[0]!.score).toBeGreaterThan(0)
  })

  it('finds all nodes sharing a keyword, score-ordered, k-capped', async () => {
    const all = await store.engine.textSearch('Knowledge', 'document', 5)
    expect(new Set(all.map((h) => h.id))).toEqual(new Set(['k-waterfall', 'k-mountain', 'k-glacier']))
    const capped = await store.engine.textSearch('Knowledge', 'document', 2)
    expect(capped).toHaveLength(2)
  })

  it('sees writes made after index creation, including updates', async () => {
    await store.engine.upsertNode('Knowledge', { id: 'k-late', content: 'delta pyramid document' })
    expect((await store.engine.textSearch('Knowledge', 'pyramid', 5)).map((h) => h.id)).toEqual(['k-late'])

    await store.engine.upsertNode('Knowledge', { id: 'k-late', content: 'delta canyon document' })
    expect(await store.engine.textSearch('Knowledge', 'pyramid', 5)).toEqual([])
    expect((await store.engine.textSearch('Knowledge', 'canyon', 5)).map((h) => h.id)).toEqual(['k-late'])
  })

  it('returns [] for blank queries and validates the label', async () => {
    expect(await store.engine.textSearch('Knowledge', '   ', 5)).toEqual([])
    await expect(store.engine.textSearch('Example' as never, 'x', 5)).rejects.toThrow(/not a retrievable label/)
  })
})

describe('search over an empty retrievable label', () => {
  it('vector + text search on Project (no rows) return empty, not errors', async () => {
    expect(await store.engine.vectorSearch('Project', basisEmbedding(EMBEDDING_DIM, 5), 3)).toEqual([])
    expect(await store.engine.textSearch('Project', 'anything', 3)).toEqual([])
  })
})

describe('extension provenance (§21 rule 2)', () => {
  it('vector + FTS were loaded from the vendored binaries by absolute path, not fetched', async () => {
    const loaded = await store.engine.cypher('CALL SHOW_LOADED_EXTENSIONS() RETURN *')
    expect(loaded.length).toBeGreaterThanOrEqual(2)
    const norm = (p: unknown): string => String(p).replaceAll('\\', '/').toLowerCase()
    const vendorRoot = norm(EXTENSIONS_DIR)
    for (const row of loaded) {
      expect(row['extension source']).toBe('USER')
      expect(norm(row['extension path']).startsWith(vendorRoot)).toBe(true)
    }
  })
})
