/**
 * Ollama client — the always-on local tier (§4): BGE-M3 embeddings and the
 * small LLM for routing / cheap evaluation / cheap extraction.
 *
 * Setup contract (§4): the app detects the daemon; if missing it links the
 * installer and offers a one-click pull of the required models. This module
 * provides the backend for that flow — `status()` returns the guided-install
 * state the dashboard (phase 10) reads, `ensureRequiredModels()` is the
 * one-click pull.
 *
 * Plain fetch against the local HTTP API; nothing here touches the network
 * beyond OLLAMA_BASE_URL. No secrets are involved and nothing is logged.
 * Model work (embed/generate) runs in the §8 local pool (see Semaphore below).
 */
import {
  EMBEDDING_DIM,
  EMBEDDING_MODEL,
  LOCAL_POOL_CONCURRENCY,
  OLLAMA_BASE_URL,
  OLLAMA_INSTALL_URL,
  OLLAMA_REQUIRED_MODELS,
  SMALL_LLM_MODEL
} from '../config'
import type { LocalLlmUsageEntry, LocalLlmUsageRecorder } from '../storage/localUsage'

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>

/**
 * §8 "cheap local work runs in a parallel pool" — phase-13 scheduler policy:
 * a counting semaphore bounds concurrent Ollama HTTP requests process-wide at
 * LOCAL_POOL_CONCURRENCY. Applied to embed()/generate() ONLY: status()
 * bypasses so the dashboard always gets an answer while the pool is busy, and
 * pull() bypasses so a long model download never starves the pool nor is
 * starved by it.
 */
class Semaphore {
  private available: number
  private readonly waiters: (() => void)[] = []

  constructor(limit: number) {
    this.available = limit
  }

  async run<T>(task: () => Promise<T>): Promise<T> {
    if (this.available > 0) {
      this.available -= 1
    } else {
      await new Promise<void>((resolve) => this.waiters.push(resolve))
    }
    try {
      return await task()
    } finally {
      const next = this.waiters.shift()
      if (next !== undefined) next()
      else this.available += 1
    }
  }
}

const localPool = new Semaphore(LOCAL_POOL_CONCURRENCY)

/**
 * Guided-install state machine (§4). `daemon-not-running` → link
 * OLLAMA_INSTALL_URL (installed-but-stopped and not-installed are
 * indistinguishable from outside; the installer page covers both);
 * `models-missing` → offer the one-click pull; `ready` → nothing to do.
 */
export type OllamaState = 'daemon-not-running' | 'models-missing' | 'ready'

export interface OllamaStatus {
  state: OllamaState
  /** Models from `/api/tags`, empty when the daemon is unreachable. */
  installedModels: string[]
  /** Required models (§20: bge-m3, qwen3:4b) not yet pulled. */
  missingModels: string[]
  /** Installer link for the dashboard's guided-install prompt. */
  installUrl: string
}

export interface PullProgress {
  model: string
  status: string
  /** Bytes completed / total for the current layer, when reported. */
  completed?: number
  total?: number
}

export interface GenerateOptions {
  /** Defaults to SMALL_LLM_MODEL (§20; user-swappable in settings later). */
  model?: string
  system?: string
  /**
   * qwen3 is a thinking model; routing/cheap-eval callers want the plain
   * answer, so thinking is off unless explicitly enabled.
   */
  think?: boolean
  /** Cap on generated tokens (Ollama `num_predict`). */
  maxTokens?: number
  temperature?: number
  stop?: string[]
  /**
   * Ollama structured outputs: 'json' or a JSON Schema object (constrained
   * decoding). Load-bearing for extraction (phase-08 finding): qwen3:4b
   * narrates through its whole output budget on plain prompts, but fills a
   * constrained schema with correct content directly.
   */
  format?: 'json' | Record<string, unknown>
  /**
   * The §2.2 reasoning role this call serves, threaded from the ProviderRouter
   * (router paths know their role; direct deps.llm calls omit it → recorded
   * NULL → surfaced as 'other'). Metadata ONLY — never sent to Ollama; the
   * injected usage recorder stamps it on the local_llm_usage row. Kept a bare
   * string (not RoleKey) so ollama.ts imports no provider types.
   */
  role?: string
}

export interface GenerateResult {
  text: string
  model: string
  /** Token counts as reported by Ollama (prompt_eval_count / eval_count). */
  inputTokens: number
  outputTokens: number
}

/**
 * One currently-loaded model from `/api/ps` — Ollama's live resource snapshot
 * (§4 "see what runs on this computer"). `sizeBytes` is total footprint,
 * `sizeVramBytes` the GPU share (0 on a CPU-only load); `expiresAt` is when the
 * daemon will unload it after idle (ISO-8601, null when not reported).
 */
export interface LoadedModel {
  name: string
  sizeBytes: number
  sizeVramBytes: number
  expiresAt: string | null
}

export class OllamaError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause })
    this.name = 'OllamaError'
  }
}

interface OllamaClientOptions {
  baseUrl?: string
  fetch?: FetchLike
  /**
   * OPTIONAL local-usage recorder (local-LLM visibility feature). When present,
   * generate() records one local_llm_usage row per call. Absent ⇒ today's
   * byte-identical behavior (every test rig omits it; production injects the
   * appdata-backed LocalLlmUsageStore at boot).
   */
  recorder?: LocalLlmUsageRecorder
}

export class OllamaClient {
  private readonly baseUrl: string
  private readonly fetch: FetchLike
  private readonly recorder: LocalLlmUsageRecorder | undefined

  constructor(options: OllamaClientOptions = {}) {
    this.baseUrl = (options.baseUrl ?? OLLAMA_BASE_URL).replace(/\/$/, '')
    this.fetch = options.fetch ?? ((input, init) => globalThis.fetch(input, init))
    this.recorder = options.recorder
  }

  /** Detect the daemon (GET /api/tags) and diff installed vs required models. */
  async status(): Promise<OllamaStatus> {
    let response: Response
    try {
      response = await this.fetch(`${this.baseUrl}/api/tags`)
    } catch {
      return { state: 'daemon-not-running', installedModels: [], missingModels: [...OLLAMA_REQUIRED_MODELS], installUrl: OLLAMA_INSTALL_URL }
    }
    if (!response.ok) {
      throw new OllamaError(`Ollama /api/tags returned HTTP ${response.status}`)
    }
    const body = (await response.json()) as { models?: { name: string }[] }
    const installedModels = (body.models ?? []).map((m) => m.name)
    const missingModels = OLLAMA_REQUIRED_MODELS.filter((required) => !hasModel(installedModels, required))
    return {
      state: missingModels.length > 0 ? 'models-missing' : 'ready',
      installedModels,
      missingModels,
      installUrl: OLLAMA_INSTALL_URL
    }
  }

  /** Pull one model (POST /api/pull), streaming NDJSON progress. */
  async pull(model: string, onProgress?: (progress: PullProgress) => void): Promise<void> {
    const response = await this.request('/api/pull', { model, stream: true })
    if (!response.body) {
      // Non-streaming fallback (some proxies buffer): a 200 with no body
      // stream still means the pull completed.
      return
    }
    const decoder = new TextDecoder()
    const reader = response.body.getReader()
    let buffered = ''
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      buffered += decoder.decode(value, { stream: true })
      const lines = buffered.split('\n')
      buffered = lines.pop() ?? ''
      for (const line of lines) {
        if (!line.trim()) continue
        const event = JSON.parse(line) as { status?: string; error?: string; completed?: number; total?: number }
        if (event.error) throw new OllamaError(`pull ${model} failed: ${event.error}`)
        onProgress?.({ model, status: event.status ?? '', completed: event.completed, total: event.total })
      }
    }
  }

  /** One-click pull (§4): fetch whichever of bge-m3 / qwen3:4b are missing. */
  async ensureRequiredModels(onProgress?: (progress: PullProgress) => void): Promise<OllamaStatus> {
    const before = await this.status()
    if (before.state === 'daemon-not-running') {
      throw new OllamaError(`Ollama daemon is not running — install/start it first (${OLLAMA_INSTALL_URL})`)
    }
    for (const model of before.missingModels) {
      await this.pull(model, onProgress)
    }
    return this.status()
  }

  /**
   * Embed texts with bge-m3 (POST /api/embed) → number[EMBEDDING_DIM][].
   * Rides the §8 local pool: bursts of background embeds queue here instead
   * of monopolizing the daemon.
   */
  async embed(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return []
    return localPool.run(async () => {
      const response = await this.request('/api/embed', { model: EMBEDDING_MODEL, input: texts })
      const body = (await response.json()) as { embeddings?: number[][] }
      const embeddings = body.embeddings
      if (!embeddings || embeddings.length !== texts.length) {
        throw new OllamaError(`Ollama /api/embed returned ${embeddings?.length ?? 0} embeddings for ${texts.length} inputs`)
      }
      for (const [i, embedding] of embeddings.entries()) {
        if (embedding.length !== EMBEDDING_DIM) {
          throw new OllamaError(`embedding ${i} has ${embedding.length} dims, expected ${EMBEDDING_DIM} (${EMBEDDING_MODEL})`)
        }
      }
      return embeddings
    })
  }

  /**
   * One-shot completion with the small local LLM (POST /api/generate).
   * Rides the §8 local pool alongside embed().
   */
  async generate(prompt: string, options: GenerateOptions = {}): Promise<GenerateResult> {
    const model = options.model ?? SMALL_LLM_MODEL
    const payload: Record<string, unknown> = {
      model,
      prompt,
      stream: false,
      think: options.think ?? false
    }
    if (options.system !== undefined) payload['system'] = options.system
    if (options.format !== undefined) payload['format'] = options.format
    const ollamaOptions: Record<string, unknown> = {}
    if (options.maxTokens !== undefined) ollamaOptions['num_predict'] = options.maxTokens
    if (options.temperature !== undefined) ollamaOptions['temperature'] = options.temperature
    if (options.stop !== undefined) ollamaOptions['stop'] = options.stop
    if (Object.keys(ollamaOptions).length > 0) payload['options'] = ollamaOptions

    const role = options.role ?? null
    const startedAt = Date.now()
    return localPool.run(async () => {
      // Record EXACTLY ONE usage row per call (success or failure) in the finally,
      // stamping whatever the daemon reported before the row is written. Recording
      // never fails the call — recordUsage swallows any recorder error.
      let resolvedModel = model
      let promptTokens: number | null = null
      let evalTokens: number | null = null
      let totalDurationNs: number | undefined
      let ok = false
      try {
        const response = await this.request('/api/generate', payload)
        const body = (await response.json()) as {
          response?: string
          model?: string
          prompt_eval_count?: number
          eval_count?: number
          total_duration?: number
          error?: string
        }
        resolvedModel = body.model ?? model
        promptTokens = body.prompt_eval_count ?? null
        evalTokens = body.eval_count ?? null
        totalDurationNs = body.total_duration
        if (typeof body.response !== 'string') {
          throw new OllamaError(`Ollama /api/generate returned no response text${body.error ? `: ${body.error}` : ''}`)
        }
        ok = true
        return {
          text: body.response,
          model: resolvedModel,
          inputTokens: promptTokens ?? 0,
          outputTokens: evalTokens ?? 0
        }
      } finally {
        this.recordUsage({
          role,
          model: resolvedModel,
          promptTokens,
          evalTokens,
          // Ollama's own total_duration (ns → ms) when the daemon answered; else
          // wall-clock elapsed (an unreachable-daemon / HTTP error path).
          durationMs: totalDurationNs !== undefined ? Math.round(totalDurationNs / 1e6) : Date.now() - startedAt,
          ok
        })
      }
    })
  }

  /**
   * Live resource snapshot (§4 "see what runs on this computer"): GET /api/ps →
   * the models the daemon currently holds in memory. Bypasses the §8 local pool
   * (like status()) so the dashboard always gets an answer, and degrades to `[]`
   * whenever the daemon is unreachable or answers non-2xx — a resource probe must
   * never throw into a usage read. NOTE: `[]` means "daemon up, nothing loaded"
   * OR "daemon down"; pair with status() to distinguish (the summary does).
   */
  async ps(): Promise<LoadedModel[]> {
    let response: Response
    try {
      response = await this.fetch(`${this.baseUrl}/api/ps`)
    } catch {
      return []
    }
    if (!response.ok) return []
    let body: { models?: { name?: string; size?: number; size_vram?: number; expires_at?: string }[] }
    try {
      body = (await response.json()) as typeof body
    } catch {
      return []
    }
    return (body.models ?? []).map((m) => ({
      name: typeof m.name === 'string' ? m.name : '',
      sizeBytes: typeof m.size === 'number' ? m.size : 0,
      sizeVramBytes: typeof m.size_vram === 'number' ? m.size_vram : 0,
      expiresAt: typeof m.expires_at === 'string' ? m.expires_at : null
    }))
  }

  /** Best-effort usage record — NEVER throws into the caller (§ recording must not fail the call). */
  private recordUsage(entry: LocalLlmUsageEntry): void {
    if (this.recorder === undefined) return
    try {
      this.recorder.record(entry)
    } catch (err) {
      console.warn('[models] local-usage record failed (ignored — the completion is unaffected)', err)
    }
  }

  private async request(path: string, payload: unknown): Promise<Response> {
    let response: Response
    try {
      response = await this.fetch(`${this.baseUrl}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload)
      })
    } catch (err) {
      throw new OllamaError(`Ollama daemon unreachable at ${this.baseUrl} — is it running? (${OLLAMA_INSTALL_URL})`, err)
    }
    if (!response.ok) {
      const detail = await safeErrorDetail(response)
      throw new OllamaError(`Ollama ${path} returned HTTP ${response.status}${detail ? `: ${detail}` : ''}`)
    }
    return response
  }
}

/** `bge-m3` matches installed `bge-m3:latest`; exact tags match exactly. */
function hasModel(installed: string[], required: string): boolean {
  return installed.some((name) => name === required || name === `${required}:latest`)
}

async function safeErrorDetail(response: Response): Promise<string> {
  try {
    const text = await response.text()
    return text.slice(0, 300)
  } catch {
    return ''
  }
}
