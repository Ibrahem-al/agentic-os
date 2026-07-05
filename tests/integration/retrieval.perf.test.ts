/**
 * Phase-13 perf sanity: retrieval p50 < 500 ms on a 10k-node graph.
 *
 * Methodology mirrors tests/integration/retrieval.latency.test.ts exactly:
 * sub-millisecond deterministic fakes for embed/rerank/critic (bag-of-words
 * embedder / FakeReranker / the same always-satisfied inline critic LLM the
 * latency test uses), 3 warm-up passes, 30 measured passes, and the same
 * percentile computation — i.e. this measures the graph + pipeline side on a
 * production-scale graph, not model inference. The 30 measured `retrieve()`
 * calls rotate across 5 different theme queries (5 × 6) so no single-query
 * caching effect can flatter the numbers; the single-pass (runReadPath) p50
 * is measured and logged as well, mirroring what the latency test times.
 *
 * ONE deliberate deviation from the latency test's fakes: queries are
 * embedded with perfTextEmbedding (perf-seed.ts) instead of FakeEmbedder's
 * fakeTextEmbedding. Same bag-of-words semantics, but its first element is a
 * non-integral sentinel — the ryugraph 25.9.1 NAPI binding infers a list
 * param's type from its FIRST element only and reinterprets fractional
 * doubles in integer-first lists as int64 bit patterns (found while building
 * this fixture; see perf-seed.ts header). Stored and query vectors must both
 * use the binding-safe shape or the vector arm searches corrupted data.
 * FakeReranker is unaffected (it only reads text).
 *
 * GATED: runs only with PERF=1 so the default `npm test` is unaffected. CI
 * runs it as a dedicated step:
 *   PERF=1 npx vitest run tests/integration/retrieval.perf.test.ts --no-file-parallelism
 * (Windows PowerShell: $env:PERF='1'; npx vitest run tests/integration/retrieval.perf.test.ts --no-file-parallelism)
 *
 * ONE store per test file (ryugraph 25.9.1: closing a second store in the
 * same worker segfaults) — the 10k graph is seeded once in beforeAll.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createRetriever, type Embedder, type Retriever } from '../../src/main/retrieval'
import { PERF_QUERIES, perfTextEmbedding, seedPerfGraph, type PerfSeedResult } from '../fixtures/perf-seed'
import { FakeReranker } from '../fixtures/retrieval-fakes'
import { openTestStore, type TestStore } from './helpers'

const PERF = process.env['PERF'] === '1'

const NODES = 10_000
const SEED = 'perf-10k'
const WARMUP_RUNS = 3
const MEASURED_RUNS = 30 // 5 queries × 6 rounds

/** Binding-safe deterministic embedder (see the header + perf-seed.ts). */
class PerfEmbedder implements Embedder {
  async embed(texts: string[]): Promise<number[][]> {
    return texts.map((t) => perfTextEmbedding(t))
  }
}

let store: TestStore
let retriever: Retriever
let seedResult: PerfSeedResult

/** Same percentile computation as retrieval.latency.test.ts. */
function percentile(sortedAsc: number[], p: number): number {
  const index = Math.min(sortedAsc.length - 1, Math.ceil((p / 100) * sortedAsc.length) - 1)
  return sortedAsc[Math.max(0, index)] as number
}

function stats(durations: readonly number[]): { p50: number; p95: number } {
  const sorted = [...durations].sort((a, b) => a - b)
  return { p50: percentile(sorted, 50), p95: percentile(sorted, 95) }
}

const queryFor = (run: number): string => PERF_QUERIES[run % PERF_QUERIES.length] as string

describe.skipIf(!PERF)('retrieval perf sanity on a 10k-node graph (phase-13, PERF=1)', () => {
  beforeAll(async () => {
    store = await openTestStore()
    seedResult = await seedPerfGraph(store.engine, { nodes: NODES, seed: SEED })
    retriever = createRetriever({
      engine: store.engine,
      embedder: new PerfEmbedder(),
      reranker: new FakeReranker(),
      llm: { generate: async () => ({ text: '{"score": 10, "missing": "none"}' }) }
    })
  }, 900_000) // seeding a 10k graph may take minutes
  afterAll(async () => {
    if (store) await store.cleanup()
  })

  it('retrieve() p50 across 5 rotating queries < 500 ms (singlePass logged too)', { timeout: 600_000 }, async () => {
    expect(seedResult.nodeCount).toBe(NODES)

    // The graph must give retrieval real work: bundles are non-empty and the
    // deliberately theme-relevant nodes are actually found for the theme
    // queries (otherwise a fast run would prove nothing).
    const themed = new Set(seedResult.themedIds)
    let themedHits = 0
    let bundledItems = 0
    for (const query of PERF_QUERIES) {
      const bundle = await retriever.retrieve(query)
      expect(bundle.items.length).toBeGreaterThan(0)
      bundledItems += bundle.items.length
      themedHits += bundle.items.filter((item) => themed.has(item.id)).length
    }
    expect(themedHits).toBeGreaterThan(0)

    // ── retrieve() — the asserted number ─────────────────────────────────────
    for (let i = 0; i < WARMUP_RUNS; i++) await retriever.retrieve(queryFor(i))
    const retrieveDurations: number[] = []
    const byQuery = new Map<string, number[]>()
    for (let i = 0; i < MEASURED_RUNS; i++) {
      const query = queryFor(i)
      const start = performance.now()
      await retriever.retrieve(query)
      const elapsed = performance.now() - start
      retrieveDurations.push(elapsed)
      const list = byQuery.get(query) ?? []
      list.push(elapsed)
      byQuery.set(query, list)
    }
    const retrieveStats = stats(retrieveDurations)

    // ── singlePass (runReadPath) — logged, mirroring the latency test ────────
    for (let i = 0; i < WARMUP_RUNS; i++) await retriever.singlePass(queryFor(i))
    const passDurations: number[] = []
    for (let i = 0; i < MEASURED_RUNS; i++) {
      const start = performance.now()
      await retriever.singlePass(queryFor(i))
      passDurations.push(performance.now() - start)
    }
    const passStats = stats(passDurations)

    const lines = [
      '─'.repeat(72),
      `[perf 10k] graph: ${seedResult.nodeCount} nodes / ${seedResult.edgeCount} edges (seed "${SEED}")`,
      `[perf 10k] nodes by label: ${Object.entries(seedResult.nodesByLabel)
        .map(([l, n]) => `${l} ${n}`)
        .join(', ')}`,
      `[perf 10k] edges by type: ${Object.entries(seedResult.edgesByType)
        .map(([t, n]) => `${t} ${n}`)
        .join(', ')}`,
      `[perf 10k] seed time: ${(seedResult.seedMs / 1000).toFixed(1)} s ` +
        `(nodes: ${seedResult.nodeStrategy}, edges: ${seedResult.edgeStrategy}, ` +
        `vector-index sanity distance: ${seedResult.sanityVectorDistance.toExponential(2)})`,
      `[perf 10k] retrieve():  p50=${retrieveStats.p50.toFixed(1)}ms  p95=${retrieveStats.p95.toFixed(1)}ms  ` +
        `(n=${MEASURED_RUNS}, ${PERF_QUERIES.length} queries × ${MEASURED_RUNS / PERF_QUERIES.length})`,
      `[perf 10k] singlePass:  p50=${passStats.p50.toFixed(1)}ms  p95=${passStats.p95.toFixed(1)}ms  (n=${MEASURED_RUNS})`,
      `[perf 10k] work check: ${bundledItems} bundle items over the 5 queries, ${themedHits} theme-relevant`,
      '[perf 10k] per-query retrieve() breakdown:'
    ]
    for (const [query, durations] of byQuery) {
      const q = stats(durations)
      lines.push(
        `[perf 10k]   p50=${q.p50.toFixed(1)}ms p95=${q.p95.toFixed(1)}ms (n=${durations.length})  "${query}"`
      )
    }
    lines.push('─'.repeat(72))
    console.log(lines.join('\n'))

    expect(retrieveStats.p50).toBeLessThan(500)
  })
})
