/**
 * Cloud reasoning tier (§4): the hard-reasoning brain behind one interface —
 * Anthropic / OpenAI / Gemini / OpenRouter, plain fetch, bring-your-own key.
 * Used by background agents, never as a session orchestrator.
 *
 * Secrets discipline (§21 rule 7): the API key exists only in the request
 * header. Nothing in this module logs, and every error message is scrubbed
 * of the key before it leaves (defense in depth — some providers echo bad
 * keys back in error bodies).
 *
 * Streaming is listed as optional in the phase doc and is deferred: the only
 * callers are background agents that consume whole completions.
 */
import { CLOUD_DEFAULT_MODELS, CLOUD_MAX_TOKENS_DEFAULT, type CloudProvider } from '../config'
import type { FetchLike } from './ollama'

export type { CloudProvider }

export type ChatRole = 'user' | 'assistant'

export interface ChatMessage {
  role: ChatRole
  content: string
}

export interface CompleteOptions {
  /** Provider-specific model id; defaults to CLOUD_DEFAULT_MODELS[provider]. */
  model?: string
  /** System prompt — top-level on every provider, never a ChatMessage. */
  system?: string
  maxTokens?: number
  stopSequences?: string[]
}

export interface Usage {
  inputTokens: number
  outputTokens: number
}

export interface Completion {
  text: string
  model: string
  usage: Usage
  /** Provider-native stop/finish reason, unmapped. */
  stopReason: string | null
  /** Actual cost in USD when the provider reports it (OpenRouter does). */
  reportedCostUsd?: number
}

/** §4: one interface in front of every cloud provider. */
export interface CloudBrain {
  readonly provider: CloudProvider
  readonly model: string
  complete(messages: ChatMessage[], options?: CompleteOptions): Promise<Completion>
}

export class CloudBrainError extends Error {
  constructor(
    message: string,
    readonly provider: CloudProvider,
    readonly status?: number
  ) {
    super(message)
    this.name = 'CloudBrainError'
  }
}

export interface CloudAdapterOptions {
  apiKey: string
  /** Override the model for every call (settings-driven). */
  model?: string
  /** Override the provider base URL (tests, proxies). */
  baseUrl?: string
  fetch?: FetchLike
}

abstract class BaseAdapter implements CloudBrain {
  abstract readonly provider: CloudProvider
  readonly model: string
  protected readonly apiKey: string
  protected readonly baseUrl: string
  private readonly fetchImpl: FetchLike

  constructor(defaultBaseUrl: string, defaultModel: string, options: CloudAdapterOptions) {
    if (!options.apiKey) throw new Error('cloud adapter requires an API key (store it via the keychain)')
    this.apiKey = options.apiKey
    this.model = options.model ?? defaultModel
    this.baseUrl = (options.baseUrl ?? defaultBaseUrl).replace(/\/$/, '')
    this.fetchImpl = options.fetch ?? ((input, init) => globalThis.fetch(input, init))
  }

  abstract complete(messages: ChatMessage[], options?: CompleteOptions): Promise<Completion>

  /** POST JSON; non-2xx throws a CloudBrainError with the key scrubbed out. */
  protected async post(path: string, headers: Record<string, string>, payload: unknown): Promise<unknown> {
    let response: Response
    try {
      response = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...headers },
        body: JSON.stringify(payload)
      })
    } catch (err) {
      throw new CloudBrainError(`${this.provider} request failed: ${this.scrub(errorText(err))}`, this.provider)
    }
    if (!response.ok) {
      let detail = ''
      try {
        detail = (await response.text()).slice(0, 500)
      } catch {
        /* body unreadable — status alone will have to do */
      }
      throw new CloudBrainError(
        `${this.provider} returned HTTP ${response.status}${detail ? `: ${this.scrub(detail)}` : ''}`,
        this.provider,
        response.status
      )
    }
    return response.json()
  }

  /** Never let the API key appear in an error message or trace (§21 rule 7). */
  protected scrub(text: string): string {
    return this.apiKey ? text.split(this.apiKey).join('[redacted]') : text
  }
}

// ── Anthropic ────────────────────────────────────────────────────────────────

interface AnthropicResponse {
  content?: { type: string; text?: string }[]
  model?: string
  stop_reason?: string | null
  usage?: { input_tokens?: number; output_tokens?: number }
}

export class AnthropicAdapter extends BaseAdapter {
  readonly provider = 'anthropic' as const

  constructor(options: CloudAdapterOptions) {
    super('https://api.anthropic.com', CLOUD_DEFAULT_MODELS.anthropic, options)
  }

  async complete(messages: ChatMessage[], options: CompleteOptions = {}): Promise<Completion> {
    const model = options.model ?? this.model
    const payload: Record<string, unknown> = {
      model,
      max_tokens: options.maxTokens ?? CLOUD_MAX_TOKENS_DEFAULT,
      messages: messages.map((m) => ({ role: m.role, content: m.content }))
    }
    if (options.system !== undefined) payload['system'] = options.system
    if (options.stopSequences !== undefined) payload['stop_sequences'] = options.stopSequences

    const body = (await this.post('/v1/messages', { 'x-api-key': this.apiKey, 'anthropic-version': '2023-06-01' }, payload)) as AnthropicResponse
    const text = (body.content ?? [])
      .filter((block) => block.type === 'text' && typeof block.text === 'string')
      .map((block) => block.text)
      .join('')
    return {
      text,
      model: body.model ?? model,
      usage: { inputTokens: body.usage?.input_tokens ?? 0, outputTokens: body.usage?.output_tokens ?? 0 },
      stopReason: body.stop_reason ?? null
    }
  }
}

// ── OpenAI-compatible chat completions (OpenAI itself + OpenRouter) ─────────

interface ChatCompletionsResponse {
  choices?: { message?: { content?: string | null }; finish_reason?: string | null }[]
  model?: string
  usage?: { prompt_tokens?: number; completion_tokens?: number; cost?: number }
}

abstract class ChatCompletionsAdapter extends BaseAdapter {
  protected abstract requestHeaders(): Record<string, string>
  /** Extra body fields (OpenRouter's usage accounting opt-in). */
  protected extraPayload(): Record<string, unknown> {
    return {}
  }
  /** OpenAI deprecated max_tokens in favor of max_completion_tokens. */
  protected abstract maxTokensField(): 'max_tokens' | 'max_completion_tokens'

  async complete(messages: ChatMessage[], options: CompleteOptions = {}): Promise<Completion> {
    const model = options.model ?? this.model
    const wireMessages: { role: string; content: string }[] = []
    if (options.system !== undefined) wireMessages.push({ role: 'system', content: options.system })
    wireMessages.push(...messages.map((m) => ({ role: m.role, content: m.content })))

    const payload: Record<string, unknown> = { model, messages: wireMessages, ...this.extraPayload() }
    payload[this.maxTokensField()] = options.maxTokens ?? CLOUD_MAX_TOKENS_DEFAULT
    if (options.stopSequences !== undefined) payload['stop'] = options.stopSequences

    const body = (await this.post('/v1/chat/completions', this.requestHeaders(), payload)) as ChatCompletionsResponse
    const choice = body.choices?.[0]
    const completion: Completion = {
      text: choice?.message?.content ?? '',
      model: body.model ?? model,
      usage: { inputTokens: body.usage?.prompt_tokens ?? 0, outputTokens: body.usage?.completion_tokens ?? 0 },
      stopReason: choice?.finish_reason ?? null
    }
    if (typeof body.usage?.cost === 'number') completion.reportedCostUsd = body.usage.cost
    return completion
  }
}

export class OpenAIAdapter extends ChatCompletionsAdapter {
  readonly provider = 'openai' as const

  constructor(options: CloudAdapterOptions) {
    super('https://api.openai.com', CLOUD_DEFAULT_MODELS.openai, options)
  }

  protected requestHeaders(): Record<string, string> {
    return { authorization: `Bearer ${this.apiKey}` }
  }

  protected maxTokensField(): 'max_completion_tokens' {
    return 'max_completion_tokens'
  }
}

export class OpenRouterAdapter extends ChatCompletionsAdapter {
  readonly provider = 'openrouter' as const

  constructor(options: CloudAdapterOptions) {
    super('https://openrouter.ai/api', CLOUD_DEFAULT_MODELS.openrouter, options)
  }

  protected requestHeaders(): Record<string, string> {
    return { authorization: `Bearer ${this.apiKey}`, 'x-title': 'agentic-os' }
  }

  protected maxTokensField(): 'max_tokens' {
    return 'max_tokens'
  }

  protected override extraPayload(): Record<string, unknown> {
    // Opt into OpenRouter's usage accounting: the response then carries
    // usage.cost in USD, which the SpendMeter prefers over the price table.
    return { usage: { include: true } }
  }
}

// ── Gemini ───────────────────────────────────────────────────────────────────

interface GeminiResponse {
  candidates?: { content?: { parts?: { text?: string }[] }; finishReason?: string | null }[]
  modelVersion?: string
  usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number; thoughtsTokenCount?: number }
}

export class GeminiAdapter extends BaseAdapter {
  readonly provider = 'gemini' as const

  constructor(options: CloudAdapterOptions) {
    super('https://generativelanguage.googleapis.com', CLOUD_DEFAULT_MODELS.gemini, options)
  }

  async complete(messages: ChatMessage[], options: CompleteOptions = {}): Promise<Completion> {
    const model = options.model ?? this.model
    const payload: Record<string, unknown> = {
      contents: messages.map((m) => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] }))
    }
    if (options.system !== undefined) payload['systemInstruction'] = { parts: [{ text: options.system }] }
    const generationConfig: Record<string, unknown> = { maxOutputTokens: options.maxTokens ?? CLOUD_MAX_TOKENS_DEFAULT }
    if (options.stopSequences !== undefined) generationConfig['stopSequences'] = options.stopSequences
    payload['generationConfig'] = generationConfig

    const body = (await this.post(
      `/v1beta/models/${encodeURIComponent(model)}:generateContent`,
      { 'x-goog-api-key': this.apiKey },
      payload
    )) as GeminiResponse
    const candidate = body.candidates?.[0]
    const text = (candidate?.content?.parts ?? []).map((part) => part.text ?? '').join('')
    const usage = body.usageMetadata
    return {
      text,
      model: body.modelVersion ?? model,
      usage: {
        inputTokens: usage?.promptTokenCount ?? 0,
        // Gemini bills thinking tokens as output; fold them in so spend is honest.
        outputTokens: (usage?.candidatesTokenCount ?? 0) + (usage?.thoughtsTokenCount ?? 0)
      },
      stopReason: candidate?.finishReason ?? null
    }
  }
}

// ── Factory ──────────────────────────────────────────────────────────────────

export function createCloudBrain(provider: CloudProvider, options: CloudAdapterOptions): CloudBrain {
  switch (provider) {
    case 'anthropic':
      return new AnthropicAdapter(options)
    case 'openai':
      return new OpenAIAdapter(options)
    case 'gemini':
      return new GeminiAdapter(options)
    case 'openrouter':
      return new OpenRouterAdapter(options)
  }
}

function errorText(err: unknown): string {
  return err instanceof Error ? `${err.message}${err.cause ? ` (${String(err.cause)})` : ''}` : String(err)
}
