/**
 * DoD 4: p50 retrieval latency on the fixture < 500 ms.
 *
 * This offline variant times the full read-path pass (embed → 4×vector +
 * 4×FTS → graph expansion → fusion → rerank → assembly) with the model calls
 * faked (sub-millisecond), i.e. it measures the graph/pipeline side that this
 * phase owns. retrieval.live.test.ts measures the same pass with the real
 * bge-m3 + int8 cross-encoder for the report.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createRetriever, type Retriever } from '../../src/main/retrieval'
import { seedFixtureGraph } from '../fixtures/graph-seed'
import { FakeEmbedder, FakeReranker } from '../fixtures/retrieval-fakes'
import { openTestStore, type TestStore } from './helpers'

let store: TestStore
let retriever: Retriever

beforeAll(async () => {
  store = await openTestStore()
  await seedFixtureGraph(store.engine)
  retriever = createRetriever({
    engine: store.engine,
    embedder: new FakeEmbedder(),
    reranker: new FakeReranker(),
    llm: { generate: async () => ({ text: '{"score": 10, "missing": "none"}' }) }
  })
  // Seeding 48 embedded nodes + indexes can exceed the global 30s hook budget
  // on a slow, contended CI runner (seen on the windows pool) — the LATENCY
  // assertion below stays honest; only the setup gets headroom.
}, 120_000)
afterAll(async () => {
  await store.cleanup()
})

function percentile(sortedAsc: number[], p: number): number {
  const index = Math.min(sortedAsc.length - 1, Math.ceil((p / 100) * sortedAsc.length) - 1)
  return sortedAsc[Math.max(0, index)] as number
}

describe('retrieval latency (DoD 4)', () => {
  it('p50 of a single read-path pass over the fixture < 500 ms', { timeout: 120_000 }, async () => {
    const query = 'deploy the aurora storefront to vercel and verify the checkout flow'
    for (let i = 0; i < 3; i++) await retriever.singlePass(query) // warm-up

    const runs = 30
    const durations: number[] = []
    for (let i = 0; i < runs; i++) {
      const start = performance.now()
      await retriever.singlePass(query)
      durations.push(performance.now() - start)
    }
    durations.sort((a, b) => a - b)
    const p50 = percentile(durations, 50)
    const p95 = percentile(durations, 95)
    // Logged for the phase report (offline pipeline numbers).
    console.log(
      `[latency offline] singlePass over fixture: p50=${p50.toFixed(1)}ms p95=${p95.toFixed(1)}ms (n=${runs})`
    )
    expect(p50).toBeLessThan(500)
  })
})
