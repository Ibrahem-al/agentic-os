/**
 * Reranker unit tests — mocked HTTP (checksum-verified resumable download),
 * a real onnxruntime-node session over the hand-built fixture model (golden
 * order asserted), and the lazy-load / idle-unload lifecycle.
 */
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Reranker, type PairTokenizer, type PinnedFile, type TokenizerFactory } from '../../src/main/models'
import { buildFixtureOnnxModel } from '../fixtures/onnxFixture'

const MODEL_BYTES = buildFixtureOnnxModel()
const MODEL_SHA = createHash('sha256').update(MODEL_BYTES).digest('hex')
const TOKENIZER_BYTES = Buffer.from('{"fixture":"tokenizer"}')
const TOKENIZER_SHA = createHash('sha256').update(TOKENIZER_BYTES).digest('hex')
const TOKENIZER_CONFIG_BYTES = Buffer.from('{"fixture":"tokenizer_config"}')
const TOKENIZER_CONFIG_SHA = createHash('sha256').update(TOKENIZER_CONFIG_BYTES).digest('hex')

const FILES: { model: PinnedFile; tokenizer: PinnedFile; tokenizerConfig: PinnedFile } = {
  model: { url: 'https://models.test/model_int8.onnx', sha256: MODEL_SHA, fileName: 'fixture-model.onnx' },
  tokenizer: { url: 'https://models.test/tokenizer.json', sha256: TOKENIZER_SHA, fileName: 'fixture-tokenizer.json' },
  tokenizerConfig: {
    url: 'https://models.test/tokenizer_config.json',
    sha256: TOKENIZER_CONFIG_SHA,
    fileName: 'fixture-tokenizer_config.json'
  }
}

/**
 * Char-code stub tokenizer: <s>=0, </s>=2, <pad>=1, chars at their codepoint.
 * Pair encoding mimics XLM-R: <s> query </s></s> doc </s>.
 */
const stubTokenizer: PairTokenizer = {
  encodePair: (query, doc) => [0, ...codes(query), 2, 2, ...codes(doc), 2],
  padTokenId: 1,
  eosTokenId: 2
}
const stubTokenizerFactory: TokenizerFactory = async (tokenizerJsonPath, tokenizerConfigPath) => {
  // The factory must only run against the verified downloads.
  expect(readFileSync(tokenizerJsonPath)).toEqual(TOKENIZER_BYTES)
  expect(readFileSync(tokenizerConfigPath)).toEqual(TOKENIZER_CONFIG_BYTES)
  return stubTokenizer
}

function codes(text: string): number[] {
  return [...text].map((c) => c.codePointAt(0) ?? 0)
}

const CONTENT: Record<string, Buffer> = {
  [FILES.model.url]: MODEL_BYTES,
  [FILES.tokenizer.url]: TOKENIZER_BYTES,
  [FILES.tokenizerConfig.url]: TOKENIZER_CONFIG_BYTES
}

interface ServedRequest {
  url: string
  rangeHeader: string | undefined
  status: number
}

/** HTTP mock that honors Range requests like Hugging Face's CDN does. */
function makeFetchMock(options: { corruptModel?: boolean; supportRange?: boolean; log?: ServedRequest[] } = {}) {
  const { corruptModel = false, supportRange = true, log = [] } = options
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    let bytes = CONTENT[url]
    if (!bytes) return new Response('not found', { status: 404 })
    if (corruptModel && url === FILES.model.url) bytes = Buffer.concat([bytes.subarray(0, bytes.length - 1), Buffer.from([0xff])])
    const range = new Headers(init?.headers).get('range') ?? undefined
    let status = 200
    let body = bytes
    if (range && supportRange) {
      const match = /^bytes=(\d+)-$/.exec(range)
      if (!match) throw new Error(`unexpected Range header: ${range}`)
      body = bytes.subarray(Number(match[1]))
      status = 206
    }
    log.push({ url, rangeHeader: range, status })
    return new Response(new Uint8Array(body), { status, headers: { 'content-length': String(body.length) } })
  })
  return { fetchMock, log }
}

let modelsDir: string

beforeEach(() => {
  modelsDir = mkdtempSync(join(tmpdir(), 'agentic-os-reranker-'))
})

afterEach(() => {
  rmSync(modelsDir, { recursive: true, force: true })
})

function makeReranker(fetchMock: ReturnType<typeof makeFetchMock>['fetchMock'], extra: Partial<ConstructorParameters<typeof Reranker>[0]> = {}) {
  return new Reranker({
    modelsDir,
    fetch: fetchMock,
    files: FILES,
    tokenizerFactory: stubTokenizerFactory,
    ...extra
  })
}

describe('reranker download (checksum-verified, resumable)', () => {
  it('downloads all pinned files once and verifies their checksums', async () => {
    const { fetchMock } = makeFetchMock()
    const reranker = makeReranker(fetchMock)
    await reranker.ensureModelFiles()
    expect(readFileSync(join(modelsDir, FILES.model.fileName))).toEqual(MODEL_BYTES)
    expect(readFileSync(join(modelsDir, FILES.tokenizer.fileName))).toEqual(TOKENIZER_BYTES)
    expect(fetchMock).toHaveBeenCalledTimes(3)
    // Second ensure: everything verified in-process — no re-download.
    await reranker.ensureModelFiles()
    expect(fetchMock).toHaveBeenCalledTimes(3)
  })

  it('reports download progress with growing byte counts', async () => {
    const { fetchMock } = makeFetchMock()
    const progress: number[] = []
    const reranker = makeReranker(fetchMock, {
      onDownloadProgress: (p) => {
        if (p.fileName === FILES.model.fileName) progress.push(p.receivedBytes)
      }
    })
    await reranker.ensureModelFiles()
    expect(progress.length).toBeGreaterThan(0)
    expect(progress.at(-1)).toBe(MODEL_BYTES.length)
    expect([...progress]).toEqual([...progress].sort((a, b) => a - b))
  })

  it('resumes an interrupted download with an HTTP Range request', async () => {
    const { fetchMock, log } = makeFetchMock()
    // Simulate a previous crash: half the model already sits in the .part file.
    const half = Math.floor(MODEL_BYTES.length / 2)
    writeFileSync(join(modelsDir, `${FILES.model.fileName}.part`), MODEL_BYTES.subarray(0, half))
    const reranker = makeReranker(fetchMock)
    await reranker.ensureModelFiles()

    const modelRequest = log.find((r) => r.url === FILES.model.url)
    expect(modelRequest?.rangeHeader).toBe(`bytes=${half}-`)
    expect(modelRequest?.status).toBe(206)
    // The stitched file must still hash to the pin.
    expect(readFileSync(join(modelsDir, FILES.model.fileName))).toEqual(MODEL_BYTES)
    expect(existsSync(join(modelsDir, `${FILES.model.fileName}.part`))).toBe(false)
  })

  it('restarts cleanly when the server ignores the Range header', async () => {
    const { fetchMock } = makeFetchMock({ supportRange: false })
    writeFileSync(join(modelsDir, `${FILES.model.fileName}.part`), Buffer.from('stale garbage longer than nothing'))
    const reranker = makeReranker(fetchMock)
    await reranker.ensureModelFiles()
    expect(readFileSync(join(modelsDir, FILES.model.fileName))).toEqual(MODEL_BYTES)
  })

  it('rejects a checksum mismatch and leaves no unverified file behind', async () => {
    const { fetchMock } = makeFetchMock({ corruptModel: true })
    const reranker = makeReranker(fetchMock)
    await expect(reranker.ensureModelFiles()).rejects.toThrow(/sha256/)
    expect(existsSync(join(modelsDir, FILES.model.fileName))).toBe(false)
  })

  it('moves a corrupt pre-existing file aside and re-downloads', async () => {
    const { fetchMock } = makeFetchMock()
    writeFileSync(join(modelsDir, FILES.model.fileName), 'tampered bytes')
    const reranker = makeReranker(fetchMock)
    await reranker.ensureModelFiles()
    expect(readFileSync(join(modelsDir, FILES.model.fileName))).toEqual(MODEL_BYTES)
    expect(readdirSync(modelsDir).some((name) => name.startsWith(`${FILES.model.fileName}.corrupt-`))).toBe(true)
  })

  it('accepts files that are already present and valid without re-downloading', async () => {
    writeFileSync(join(modelsDir, FILES.model.fileName), MODEL_BYTES)
    writeFileSync(join(modelsDir, FILES.tokenizer.fileName), TOKENIZER_BYTES)
    writeFileSync(join(modelsDir, FILES.tokenizerConfig.fileName), TOKENIZER_CONFIG_BYTES)
    const { fetchMock } = makeFetchMock()
    const reranker = makeReranker(fetchMock)
    await reranker.ensureModelFiles()
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

describe('reranker inference (real onnxruntime-node over the fixture model)', () => {
  it('reranks a fixture in golden order', async () => {
    const { fetchMock } = makeFetchMock()
    const reranker = makeReranker(fetchMock)
    // Equal-length docs: the fixture scores by mean token id, so z > m > a.
    const docs = ['aaaa', 'zzzz', 'mmmm']
    const scores = await reranker.rerank('qq', docs)
    expect(scores).toHaveLength(3)
    const ranked = docs.map((doc, i) => ({ doc, score: scores[i]! })).sort((a, b) => b.score - a.score).map((r) => r.doc)
    expect(ranked).toEqual(['zzzz', 'mmmm', 'aaaa'])
  })

  it('handles batches larger than the batch size and empty input', async () => {
    const { fetchMock } = makeFetchMock()
    const reranker = makeReranker(fetchMock, { batchSize: 2 })
    await expect(reranker.rerank('q', [])).resolves.toEqual([])
    const docs = ['bbbb', 'yyyy', 'dddd', 'wwww', 'ffff'] // 5 docs → 3 mini-batches of ≤2
    const scores = await reranker.rerank('qq', docs)
    const ranked = docs.map((doc, i) => ({ doc, score: scores[i]! })).sort((a, b) => b.score - a.score).map((r) => r.doc)
    expect(ranked).toEqual(['yyyy', 'wwww', 'ffff', 'dddd', 'bbbb'])
  })

  it('truncates over-long pairs to the max sequence length, keeping EOS', async () => {
    const { fetchMock } = makeFetchMock()
    const reranker = makeReranker(fetchMock, { maxSequenceTokens: 16 })
    // 100-char docs blow past 16 tokens; must not throw, and order must hold.
    const docs = ['a'.repeat(100), 'z'.repeat(100)]
    const scores = await reranker.rerank('qq', docs)
    expect(scores[1]!).toBeGreaterThan(scores[0]!)
  })

  it('lazy-loads on first rerank and unloads after the idle timeout', async () => {
    const { fetchMock } = makeFetchMock()
    const reranker = makeReranker(fetchMock, { idleUnloadMs: 60 })
    expect(reranker.isLoaded).toBe(false)
    await reranker.rerank('qq', ['aaaa'])
    expect(reranker.isLoaded).toBe(true)
    await vi.waitFor(() => expect(reranker.isLoaded).toBe(false), { timeout: 3_000 })
    // …and the next rerank transparently reloads.
    const scores = await reranker.rerank('qq', ['zzzz'])
    expect(scores).toHaveLength(1)
    expect(reranker.isLoaded).toBe(true)
    await reranker.unload()
    expect(reranker.isLoaded).toBe(false)
  })

  it('concurrent reranks share one session load', async () => {
    const { fetchMock } = makeFetchMock()
    let sessionLoads = 0
    const reranker = makeReranker(fetchMock, {
      sessionFactory: async (modelPath) => {
        sessionLoads += 1
        const ort = await import('onnxruntime-node')
        const session = await ort.InferenceSession.create(modelPath)
        return {
          async run(inputIds, attentionMask, dims) {
            const feeds = {
              input_ids: new ort.Tensor('int64', inputIds, [...dims]),
              attention_mask: new ort.Tensor('int64', attentionMask, [...dims])
            }
            const results = await session.run(feeds)
            return results['logits']!.data as Float32Array
          },
          async release() {
            await session.release()
          }
        }
      }
    })
    const [a, b] = await Promise.all([reranker.rerank('qq', ['aaaa']), reranker.rerank('qq', ['zzzz'])])
    expect(sessionLoads).toBe(1)
    expect(b![0]!).toBeGreaterThan(a![0]!)
  })
})
