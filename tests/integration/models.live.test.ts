/**
 * Live gated model tests.
 *
 * `OLLAMA=1 npm test` (DoD): embeds 2 texts via bge-m3 and generates one
 * short completion with qwen3:4b against the real local daemon. Skipped
 * (not failed) when OLLAMA is unset so plain `npm test` stays offline.
 *
 * `RERANKER=1 npm test`: cross-encodes with the REAL int8 bge-reranker
 * weights. Requires the pinned files to already exist in the real app
 * models dir (%APPDATA%/agentic-os/models) or in
 * AGENTIC_OS_RERANKER_MODELS_DIR — checksums are still verified; nothing is
 * downloaded by the test.
 */
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { EMBEDDING_DIM, RERANKER_ONNX_FILENAME, appDataPaths } from '../../src/main/config'
import { OllamaClient, Reranker } from '../../src/main/models'

const LIVE_OLLAMA = process.env['OLLAMA'] === '1'
const LIVE_RERANKER = process.env['RERANKER'] === '1'

function defaultUserData(): string {
  // Electron's userData for `agentic-os` on Windows is %APPDATA%/agentic-os.
  return join(process.env['APPDATA'] ?? join(process.env['HOME'] ?? '.', '.config'), 'agentic-os')
}

describe.skipIf(!LIVE_OLLAMA)('ollama live (OLLAMA=1)', () => {
  const client = new OllamaClient()

  it('daemon is up with the required models', { timeout: 30_000 }, async () => {
    const status = await client.status()
    expect(status.state).toBe('ready')
  })

  it('embeds 2 texts via bge-m3 into 1024-dim vectors', { timeout: 120_000 }, async () => {
    const embeddings = await client.embed([
      'RyuGraph is an embedded graph database with vector search.',
      'The weather in Lisbon is sunny today.'
    ])
    expect(embeddings).toHaveLength(2)
    for (const embedding of embeddings) {
      expect(embedding).toHaveLength(EMBEDDING_DIM)
      expect(embedding.every((x) => Number.isFinite(x))).toBe(true)
      const norm = Math.hypot(...embedding)
      expect(norm).toBeGreaterThan(0)
    }
    // Semantic sanity: paraphrase pairs are closer than unrelated pairs.
    const [graphDoc, weatherDoc] = embeddings
    const [paraphrase] = await client.embed(['An embedded graph database supporting vector similarity search.'])
    expect(cosine(paraphrase!, graphDoc!)).toBeGreaterThan(cosine(paraphrase!, weatherDoc!))
  })

  it('generates 1 short completion with qwen3:4b', { timeout: 120_000 }, async () => {
    const result = await client.generate('Reply with a single short greeting word.', { maxTokens: 64 })
    expect(result.text.trim().length).toBeGreaterThan(0)
    expect(result.outputTokens).toBeGreaterThan(0)
    expect(result.model).toContain('qwen3')
  })
})

describe.skipIf(!LIVE_RERANKER)('reranker live (RERANKER=1, real int8 weights)', () => {
  const modelsDir = process.env['AGENTIC_OS_RERANKER_MODELS_DIR'] ?? appDataPaths(defaultUserData()).modelsDir

  it('reranks with the real cross-encoder in golden order', { timeout: 300_000 }, async () => {
    expect(
      existsSync(join(modelsDir, RERANKER_ONNX_FILENAME)),
      `pinned reranker weights not found in ${modelsDir} — run the app once or place the files there`
    ).toBe(true)
    const reranker = new Reranker({ modelsDir })
    try {
      const query = 'What is the capital of France?'
      const docs = [
        'The Eiffel Tower is made of iron and stands in a European city.',
        'Paris is the capital and largest city of France.',
        'Bananas are rich in potassium and grow in tropical climates.'
      ]
      const scores = await reranker.rerank(query, docs)
      expect(scores).toHaveLength(3)
      const bestIndex = scores.indexOf(Math.max(...scores))
      expect(bestIndex).toBe(1)
      expect(scores[1]!).toBeGreaterThan(scores[2]!)
    } finally {
      await reranker.unload()
    }
  })
})

function cosine(a: number[], b: number[]): number {
  let dot = 0
  let na = 0
  let nb = 0
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!
    na += a[i]! * a[i]!
    nb += b[i]! * b[i]!
  }
  return dot / (Math.sqrt(na) * Math.sqrt(nb))
}
