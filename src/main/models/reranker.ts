/**
 * In-process cross-encoder reranker (§4/§20): bge-reranker-v2-m3 as int8 ONNX
 * via onnxruntime-node. Ollama is NOT involved — its embed API returns
 * embeddings, not the classification-head relevance scores a cross-encoder
 * produces, so it would silently mis-rank.
 *
 * - Weights + tokenizer download to userData/models/ on FIRST USE, pinned by
 *   URL + sha256 in config.ts. Downloads are resumable (`.part` file + HTTP
 *   Range) and checksum-verified before the file is moved into place; an
 *   already-present file is re-verified once per process before first use.
 * - Lazy-load + idle unload (§20: 5 min): the ~600 MB session exists only
 *   between the first rerank and RERANKER_IDLE_UNLOAD_MS of silence.
 * - Tokenization is in-process too: @huggingface/tokenizers (pure JS) loads
 *   the repo's tokenizer.json (XLM-RoBERTa unigram + precompiled charsmap).
 *
 * `rerank(query, docs)` returns one raw logit per doc — higher = more
 * relevant; apply sigmoid for a 0..1 relevance probability. Ordering is what
 * retrieval (phase 03) consumes.
 */
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { mkdir, open, rename, rm, stat, readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { Tokenizer } from '@huggingface/tokenizers'
import type { Tensor as OrtTensor } from 'onnxruntime-node'
import {
  RERANKER_BATCH_SIZE,
  RERANKER_IDLE_UNLOAD_MS,
  RERANKER_MAX_SEQUENCE_TOKENS,
  RERANKER_ONNX_FILENAME,
  RERANKER_ONNX_SHA256,
  RERANKER_ONNX_URL,
  RERANKER_TOKENIZER_CONFIG_FILENAME,
  RERANKER_TOKENIZER_CONFIG_SHA256,
  RERANKER_TOKENIZER_CONFIG_URL,
  RERANKER_TOKENIZER_FILENAME,
  RERANKER_TOKENIZER_SHA256,
  RERANKER_TOKENIZER_URL
} from '../config'
import type { FetchLike } from './ollama'

const require = createRequire(import.meta.url)

export class RerankerError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'RerankerError'
  }
}

/** One pinned artifact: where it comes from, what it must hash to. */
export interface PinnedFile {
  url: string
  sha256: string
  fileName: string
}

/** Batch inference session abstraction (real impl: onnxruntime-node). */
export interface RerankSession {
  run(inputIds: BigInt64Array, attentionMask: BigInt64Array, dims: readonly [number, number]): Promise<Float32Array>
  release(): Promise<void>
}

export type SessionFactory = (modelPath: string) => Promise<RerankSession>

/** Pair tokenizer abstraction (real impl: @huggingface/tokenizers). */
export interface PairTokenizer {
  /** Encode a (query, doc) pair incl. special tokens → token ids. */
  encodePair(query: string, doc: string): number[]
  padTokenId: number
  /** Sequence-end token id, used when truncating an over-long pair. */
  eosTokenId: number
}

export type TokenizerFactory = (tokenizerJsonPath: string, tokenizerConfigPath: string) => Promise<PairTokenizer>

export interface DownloadProgress {
  fileName: string
  receivedBytes: number
  totalBytes?: number
}

interface RerankerOptions {
  /** userData/models — appDataPaths(userData).modelsDir. */
  modelsDir: string
  fetch?: FetchLike
  idleUnloadMs?: number
  maxSequenceTokens?: number
  batchSize?: number
  sessionFactory?: SessionFactory
  tokenizerFactory?: TokenizerFactory
  /** Override the pinned artifacts (tests use tiny fixtures). */
  files?: { model: PinnedFile; tokenizer: PinnedFile; tokenizerConfig: PinnedFile }
  onDownloadProgress?: (progress: DownloadProgress) => void
}

interface LoadedState {
  session: RerankSession
  tokenizer: PairTokenizer
}

export class Reranker {
  private readonly modelsDir: string
  private readonly fetch: FetchLike
  private readonly idleUnloadMs: number
  private readonly maxSequenceTokens: number
  private readonly batchSize: number
  private readonly sessionFactory: SessionFactory
  private readonly tokenizerFactory: TokenizerFactory
  private readonly files: { model: PinnedFile; tokenizer: PinnedFile; tokenizerConfig: PinnedFile }
  private readonly onDownloadProgress?: (progress: DownloadProgress) => void

  private loaded: LoadedState | null = null
  private loading: Promise<LoadedState> | null = null
  private idleTimer: NodeJS.Timeout | null = null
  private inflight = 0
  /** Files whose on-disk checksum has been verified this process. */
  private readonly verified = new Set<string>()

  constructor(options: RerankerOptions) {
    this.modelsDir = options.modelsDir
    this.fetch = options.fetch ?? ((input, init) => globalThis.fetch(input, init))
    this.idleUnloadMs = options.idleUnloadMs ?? RERANKER_IDLE_UNLOAD_MS
    this.maxSequenceTokens = options.maxSequenceTokens ?? RERANKER_MAX_SEQUENCE_TOKENS
    this.batchSize = options.batchSize ?? RERANKER_BATCH_SIZE
    this.sessionFactory = options.sessionFactory ?? createOnnxRuntimeSession
    this.tokenizerFactory = options.tokenizerFactory ?? createHfTokenizer
    this.onDownloadProgress = options.onDownloadProgress
    this.files = options.files ?? {
      model: { url: RERANKER_ONNX_URL, sha256: RERANKER_ONNX_SHA256, fileName: RERANKER_ONNX_FILENAME },
      tokenizer: { url: RERANKER_TOKENIZER_URL, sha256: RERANKER_TOKENIZER_SHA256, fileName: RERANKER_TOKENIZER_FILENAME },
      tokenizerConfig: {
        url: RERANKER_TOKENIZER_CONFIG_URL,
        sha256: RERANKER_TOKENIZER_CONFIG_SHA256,
        fileName: RERANKER_TOKENIZER_CONFIG_FILENAME
      }
    }
  }

  get isLoaded(): boolean {
    return this.loaded !== null
  }

  /** Download (or verify) every pinned artifact; safe to call eagerly. */
  async ensureModelFiles(): Promise<void> {
    await mkdir(this.modelsDir, { recursive: true })
    for (const file of [this.files.model, this.files.tokenizer, this.files.tokenizerConfig]) {
      await this.ensureFile(file)
    }
  }

  /** Cross-encode (query, doc) pairs → one raw logit per doc (higher = more relevant). */
  async rerank(query: string, docs: string[]): Promise<number[]> {
    if (docs.length === 0) return []
    const { session, tokenizer } = await this.acquire()
    this.inflight += 1
    try {
      const scores: number[] = []
      for (let start = 0; start < docs.length; start += this.batchSize) {
        const batch = docs.slice(start, start + this.batchSize)
        scores.push(...(await this.scoreBatch(session, tokenizer, query, batch)))
      }
      return scores
    } finally {
      this.inflight -= 1
      this.scheduleIdleUnload()
    }
  }

  /** Drop the ONNX session + tokenizer; the next rerank lazy-loads again. */
  async unload(): Promise<void> {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer)
      this.idleTimer = null
    }
    const current = this.loaded
    this.loaded = null
    this.loading = null
    if (current) await current.session.release()
  }

  // ── lazy load ──────────────────────────────────────────────────────────────

  private async acquire(): Promise<LoadedState> {
    if (this.loaded) return this.loaded
    this.loading ??= this.loadOnce()
    try {
      return await this.loading
    } catch (err) {
      this.loading = null // allow retry after a failed load
      throw err
    }
  }

  private async loadOnce(): Promise<LoadedState> {
    await this.ensureModelFiles()
    const tokenizer = await this.tokenizerFactory(
      join(this.modelsDir, this.files.tokenizer.fileName),
      join(this.modelsDir, this.files.tokenizerConfig.fileName)
    )
    const session = await this.sessionFactory(join(this.modelsDir, this.files.model.fileName))
    this.loaded = { session, tokenizer }
    this.scheduleIdleUnload()
    return this.loaded
  }

  private scheduleIdleUnload(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer)
    if (!this.loaded) return
    this.idleTimer = setTimeout(() => {
      if (this.inflight === 0) {
        void this.unload()
      } else {
        this.scheduleIdleUnload() // still working — check again next interval
      }
    }, this.idleUnloadMs)
    // Never keep the process alive just to unload a model.
    this.idleTimer.unref?.()
  }

  // ── inference ──────────────────────────────────────────────────────────────

  private async scoreBatch(
    session: RerankSession,
    tokenizer: PairTokenizer,
    query: string,
    docs: string[]
  ): Promise<number[]> {
    const encodings = docs.map((doc) => this.truncate(tokenizer, tokenizer.encodePair(query, doc)))
    const seqLen = Math.max(...encodings.map((ids) => ids.length))
    const batch = encodings.length
    const inputIds = new BigInt64Array(batch * seqLen).fill(BigInt(tokenizer.padTokenId))
    const attentionMask = new BigInt64Array(batch * seqLen) // zeros
    encodings.forEach((ids, row) => {
      ids.forEach((id, col) => {
        inputIds[row * seqLen + col] = BigInt(id)
        attentionMask[row * seqLen + col] = 1n
      })
    })
    const logits = await session.run(inputIds, attentionMask, [batch, seqLen])
    if (logits.length !== batch) {
      throw new RerankerError(`reranker model returned ${logits.length} logits for a batch of ${batch}`)
    }
    return Array.from(logits)
  }

  /** Over-long pairs keep their head and the closing EOS (docs truncate from the end). */
  private truncate(tokenizer: PairTokenizer, ids: number[]): number[] {
    if (ids.length <= this.maxSequenceTokens) return ids
    return [...ids.slice(0, this.maxSequenceTokens - 1), tokenizer.eosTokenId]
  }

  // ── checksum-verified resumable download ───────────────────────────────────

  private async ensureFile(file: PinnedFile): Promise<void> {
    const finalPath = join(this.modelsDir, file.fileName)
    if (this.verified.has(finalPath)) return
    if (await exists(finalPath)) {
      const actual = await sha256OfFile(finalPath)
      if (actual === file.sha256) {
        this.verified.add(finalPath)
        return
      }
      // Corrupt/foreign file at the pinned name: move it aside, re-download.
      await rename(finalPath, `${finalPath}.corrupt-${Date.now()}`)
    }
    await this.download(file, finalPath)
    const actual = await sha256OfFile(finalPath)
    if (actual !== file.sha256) {
      await rm(finalPath, { force: true })
      throw new RerankerError(
        `downloaded ${file.fileName} has sha256 ${actual}, expected ${file.sha256} — deleted; refusing to load unverified weights`
      )
    }
    this.verified.add(finalPath)
  }

  private async download(file: PinnedFile, finalPath: string): Promise<void> {
    const partPath = `${finalPath}.part`
    let offset = 0
    if (await exists(partPath)) {
      offset = (await stat(partPath)).size
    }
    const headers: Record<string, string> = {}
    if (offset > 0) headers['range'] = `bytes=${offset}-`

    const response = await this.fetch(file.url, { headers })
    if (response.status === 200) {
      offset = 0 // server ignored the range (or fresh download) — start over
    } else if (response.status === 206) {
      // resuming — append below
    } else {
      throw new RerankerError(`download of ${file.fileName} failed: HTTP ${response.status}`)
    }
    if (!response.body) throw new RerankerError(`download of ${file.fileName} returned no body`)

    const contentLength = Number(response.headers.get('content-length') ?? '') || undefined
    const totalBytes = contentLength !== undefined ? offset + contentLength : undefined
    const handle = await open(partPath, offset > 0 ? 'r+' : 'w')
    try {
      let position = offset
      const reader = response.body.getReader()
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        await handle.write(value, 0, value.length, position)
        position += value.length
        this.onDownloadProgress?.({ fileName: file.fileName, receivedBytes: position, totalBytes })
      }
      await handle.truncate(position)
    } finally {
      await handle.close()
    }
    await rename(partPath, finalPath)
  }
}

// ── default backends ─────────────────────────────────────────────────────────

/** onnxruntime-node session (CJS native module — loaded via require). */
const createOnnxRuntimeSession: SessionFactory = async (modelPath) => {
  const ort = require('onnxruntime-node') as typeof import('onnxruntime-node')
  const session = await ort.InferenceSession.create(modelPath)
  const outputName = session.outputNames[0]
  if (!outputName) throw new RerankerError('reranker ONNX model exposes no outputs')
  const wantsTokenTypeIds = session.inputNames.includes('token_type_ids')
  return {
    async run(inputIds, attentionMask, dims) {
      const feeds: Record<string, OrtTensor> = {
        input_ids: new ort.Tensor('int64', inputIds, [...dims]),
        attention_mask: new ort.Tensor('int64', attentionMask, [...dims])
      }
      if (wantsTokenTypeIds) {
        feeds['token_type_ids'] = new ort.Tensor('int64', new BigInt64Array(inputIds.length), [...dims])
      }
      const results = await session.run(feeds)
      const output = results[outputName]
      if (!output) throw new RerankerError(`reranker ONNX run returned no '${outputName}' output`)
      return output.data as Float32Array
    },
    async release() {
      await session.release()
    }
  }
}

/** @huggingface/tokenizers wrapper for the pinned XLM-R tokenizer.json. */
const createHfTokenizer: TokenizerFactory = async (tokenizerJsonPath, tokenizerConfigPath) => {
  const tokenizerJson = JSON.parse(await readFile(tokenizerJsonPath, 'utf8')) as object
  const tokenizerConfig = JSON.parse(await readFile(tokenizerConfigPath, 'utf8')) as object
  const tokenizer = new Tokenizer(tokenizerJson, tokenizerConfig)
  const padTokenId = tokenizer.token_to_id('<pad>')
  const eosTokenId = tokenizer.token_to_id('</s>')
  if (padTokenId === undefined || eosTokenId === undefined) {
    throw new RerankerError('reranker tokenizer is missing <pad>/</s> tokens — wrong tokenizer.json?')
  }
  return {
    encodePair: (query, doc) => tokenizer.encode(query, { text_pair: doc }).ids,
    padTokenId,
    eosTokenId
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

function sha256OfFile(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256')
    const stream = createReadStream(path)
    stream.on('data', (chunk) => hash.update(chunk))
    stream.on('end', () => resolve(hash.digest('hex')))
    stream.on('error', reject)
  })
}
