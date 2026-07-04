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
 */
import {
  EMBEDDING_DIM,
  EMBEDDING_MODEL,
  OLLAMA_BASE_URL,
  OLLAMA_INSTALL_URL,
  OLLAMA_REQUIRED_MODELS,
  SMALL_LLM_MODEL
} from '../config'

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>

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
}

export interface GenerateResult {
  text: string
  model: string
  /** Token counts as reported by Ollama (prompt_eval_count / eval_count). */
  inputTokens: number
  outputTokens: number
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
}

export class OllamaClient {
  private readonly baseUrl: string
  private readonly fetch: FetchLike

  constructor(options: OllamaClientOptions = {}) {
    this.baseUrl = (options.baseUrl ?? OLLAMA_BASE_URL).replace(/\/$/, '')
    this.fetch = options.fetch ?? ((input, init) => globalThis.fetch(input, init))
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

  /** Embed texts with bge-m3 (POST /api/embed) → number[EMBEDDING_DIM][]. */
  async embed(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return []
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
  }

  /** One-shot completion with the small local LLM (POST /api/generate). */
  async generate(prompt: string, options: GenerateOptions = {}): Promise<GenerateResult> {
    const model = options.model ?? SMALL_LLM_MODEL
    const payload: Record<string, unknown> = {
      model,
      prompt,
      stream: false,
      think: options.think ?? false
    }
    if (options.system !== undefined) payload['system'] = options.system
    const ollamaOptions: Record<string, unknown> = {}
    if (options.maxTokens !== undefined) ollamaOptions['num_predict'] = options.maxTokens
    if (options.temperature !== undefined) ollamaOptions['temperature'] = options.temperature
    if (options.stop !== undefined) ollamaOptions['stop'] = options.stop
    if (Object.keys(ollamaOptions).length > 0) payload['options'] = ollamaOptions

    const response = await this.request('/api/generate', payload)
    const body = (await response.json()) as {
      response?: string
      model?: string
      prompt_eval_count?: number
      eval_count?: number
      error?: string
    }
    if (typeof body.response !== 'string') {
      throw new OllamaError(`Ollama /api/generate returned no response text${body.error ? `: ${body.error}` : ''}`)
    }
    return {
      text: body.response,
      model: body.model ?? model,
      inputTokens: body.prompt_eval_count ?? 0,
      outputTokens: body.eval_count ?? 0
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
