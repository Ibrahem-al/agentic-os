/**
 * Live full-stack retrieval, gated on BOTH OLLAMA=1 and RERANKER=1: the
 * fixture graph re-embedded with REAL bge-m3 vectors, queried through the real
 * OllamaClient (embeddings + qwen3 critic/rewriter) and the real int8
 * cross-encoder. Also measures real-model retrieval latency for the report.
 *
 * Skipped (not failed) otherwise so plain `npm test` stays offline.
 */
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { RERANKER_ONNX_FILENAME, appDataPaths } from '../../src/main/config'
import { OllamaClient, Reranker } from '../../src/main/models'
import { createRetriever, type Retriever } from '../../src/main/retrieval'
import { GLOBAL_PREFERENCE_IDS, seedFixtureGraph } from '../fixtures/graph-seed'
import { openTestStore, type TestStore } from './helpers'

const LIVE = process.env['OLLAMA'] === '1' && process.env['RERANKER'] === '1'

function defaultUserData(): string {
  return join(process.env['APPDATA'] ?? join(process.env['HOME'] ?? '.', '.config'), 'agentic-os')
}

function percentile(sortedAsc: number[], p: number): number {
  const index = Math.min(sortedAsc.length - 1, Math.ceil((p / 100) * sortedAsc.length) - 1)
  return sortedAsc[Math.max(0, index)] as number
}

describe.skipIf(!LIVE)('retrieval live (OLLAMA=1 RERANKER=1)', () => {
  let store: TestStore
  let retriever: Retriever
  let reranker: Reranker

  beforeAll(async () => {
    const modelsDir = process.env['AGENTIC_OS_RERANKER_MODELS_DIR'] ?? appDataPaths(defaultUserData()).modelsDir
    expect(
      existsSync(join(modelsDir, RERANKER_ONNX_FILENAME)),
      `pinned reranker weights not found in ${modelsDir} — run the app once or place the files there`
    ).toBe(true)
    const client = new OllamaClient()
    reranker = new Reranker({ modelsDir })
    store = await openTestStore()
    await seedFixtureGraph(store.engine, client) // REAL bge-m3 node embeddings
    retriever = createRetriever({ engine: store.engine, embedder: client, reranker, llm: client })
  }, 300_000)

  afterAll(async () => {
    await reranker?.unload()
    await store?.cleanup()
  })

  it('retrieves the deploy world for the deploy task through the full loop', { timeout: 300_000 }, async () => {
    const bundle = await retriever.retrieve(
      'deploy the aurora storefront to vercel and verify the checkout flow'
    )
    const ids = [...bundle.items, ...bundle.globalPreferences].map((i) => i.id)
    expect(ids).toContain('s-deploy')
    expect(ids).toContain('p-aurora')
    for (const globalId of GLOBAL_PREFERENCE_IDS) expect(ids).toContain(globalId)
    expect(bundle.iterations).toBeLessThanOrEqual(5)
    expect(bundle.items.length).toBeLessThanOrEqual(8)
    console.log(
      `[live loop] confidence=${bundle.confidence} criticScore=${bundle.criticScore?.toFixed(2)} ` +
        `iterations=${bundle.iterations} halt=${bundle.haltReason}`
    )
  })

  it('real-model read-path latency (logged for the report)', { timeout: 300_000 }, async () => {
    const query = 'tune postgres autovacuum for the telemetry warehouse ingest spikes'
    await retriever.singlePass(query) // warm-up (reranker session load)
    const durations: number[] = []
    for (let i = 0; i < 11; i++) {
      const start = performance.now()
      const pass = await retriever.singlePass(query)
      durations.push(performance.now() - start)
      expect(pass.items.length).toBeGreaterThan(0)
    }
    durations.sort((a, b) => a - b)
    console.log(
      `[latency live] singlePass real bge-m3 + int8 reranker: p50=${percentile(durations, 50).toFixed(1)}ms ` +
        `p95=${percentile(durations, 95).toFixed(1)}ms (n=${durations.length})`
    )
  })
})
