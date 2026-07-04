/**
 * Cloud adapter unit tests — mocked HTTP for all four providers. Each adapter
 * is checked for wire shape (URL, auth header, body), response parsing
 * (text + usage + stop reason), and §21-rule-7 key redaction in errors.
 */
import { describe, expect, it, vi } from 'vitest'
import {
  AnthropicAdapter,
  CloudBrainError,
  GeminiAdapter,
  OpenAIAdapter,
  OpenRouterAdapter,
  createCloudBrain,
  type ChatMessage
} from '../../src/main/models'

const API_KEY = 'sk-test-key-THIS-MUST-NEVER-LEAK-4242'
const MESSAGES: ChatMessage[] = [
  { role: 'user', content: 'hello' },
  { role: 'assistant', content: 'hi there' },
  { role: 'user', content: 'summarize' }
]

type Call = { url: string; headers: Headers; body: Record<string, unknown> }

function capture(response: unknown, status = 200) {
  const calls: Call[] = []
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, headers: new Headers(init?.headers), body: JSON.parse(String(init?.body)) as Record<string, unknown> })
    return new Response(typeof response === 'string' ? response : JSON.stringify(response), { status })
  })
  return { fetchMock, calls }
}

describe('AnthropicAdapter', () => {
  const response = {
    content: [
      { type: 'thinking', text: 'hmm' },
      { type: 'text', text: 'The answer' },
      { type: 'text', text: ' is 42.' }
    ],
    model: 'claude-opus-4-8',
    stop_reason: 'end_turn',
    usage: { input_tokens: 100, output_tokens: 25 }
  }

  it('posts to /v1/messages with x-api-key + anthropic-version and parses the reply', async () => {
    const { fetchMock, calls } = capture(response)
    const brain = new AnthropicAdapter({ apiKey: API_KEY, fetch: fetchMock })
    const completion = await brain.complete(MESSAGES, { system: 'be helpful', maxTokens: 512, stopSequences: ['END'] })

    const call = calls[0]!
    expect(call.url).toBe('https://api.anthropic.com/v1/messages')
    expect(call.headers.get('x-api-key')).toBe(API_KEY)
    expect(call.headers.get('anthropic-version')).toBe('2023-06-01')
    expect(call.body).toEqual({
      model: 'claude-opus-4-8',
      max_tokens: 512,
      system: 'be helpful',
      stop_sequences: ['END'],
      messages: [
        { role: 'user', content: 'hello' },
        { role: 'assistant', content: 'hi there' },
        { role: 'user', content: 'summarize' }
      ]
    })
    // Non-text blocks are ignored; text blocks concatenate.
    expect(completion.text).toBe('The answer is 42.')
    expect(completion.usage).toEqual({ inputTokens: 100, outputTokens: 25 })
    expect(completion.stopReason).toBe('end_turn')
    expect(completion.reportedCostUsd).toBeUndefined()
  })

  it('defaults model and max_tokens from config', async () => {
    const { fetchMock, calls } = capture(response)
    await new AnthropicAdapter({ apiKey: API_KEY, fetch: fetchMock }).complete(MESSAGES)
    expect(calls[0]!.body['model']).toBe('claude-opus-4-8')
    expect(calls[0]!.body['max_tokens']).toBe(4096)
    expect(calls[0]!.body).not.toHaveProperty('system')
  })
})

describe('OpenAIAdapter', () => {
  const response = {
    choices: [{ message: { content: 'result text' }, finish_reason: 'stop' }],
    model: 'gpt-5.5',
    usage: { prompt_tokens: 80, completion_tokens: 20 }
  }

  it('posts chat completions with Bearer auth, system message, max_completion_tokens', async () => {
    const { fetchMock, calls } = capture(response)
    const completion = await new OpenAIAdapter({ apiKey: API_KEY, fetch: fetchMock }).complete(MESSAGES, {
      system: 'sys prompt',
      maxTokens: 256
    })
    const call = calls[0]!
    expect(call.url).toBe('https://api.openai.com/v1/chat/completions')
    expect(call.headers.get('authorization')).toBe(`Bearer ${API_KEY}`)
    expect(call.body['max_completion_tokens']).toBe(256)
    expect(call.body).not.toHaveProperty('max_tokens')
    expect(call.body['messages']).toEqual([
      { role: 'system', content: 'sys prompt' },
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'hi there' },
      { role: 'user', content: 'summarize' }
    ])
    expect(completion.text).toBe('result text')
    expect(completion.usage).toEqual({ inputTokens: 80, outputTokens: 20 })
    expect(completion.stopReason).toBe('stop')
  })
})

describe('OpenRouterAdapter', () => {
  it('opts into usage accounting and surfaces the reported USD cost', async () => {
    const response = {
      choices: [{ message: { content: 'routed' }, finish_reason: 'stop' }],
      model: 'openai/gpt-5.5',
      usage: { prompt_tokens: 10, completion_tokens: 5, cost: 0.00042 }
    }
    const { fetchMock, calls } = capture(response)
    const completion = await new OpenRouterAdapter({ apiKey: API_KEY, fetch: fetchMock }).complete(MESSAGES)
    const call = calls[0]!
    expect(call.url).toBe('https://openrouter.ai/api/v1/chat/completions')
    expect(call.headers.get('authorization')).toBe(`Bearer ${API_KEY}`)
    expect(call.body['usage']).toEqual({ include: true })
    expect(call.body['max_tokens']).toBe(4096) // OpenRouter keeps max_tokens
    expect(completion.reportedCostUsd).toBe(0.00042)
  })
})

describe('GeminiAdapter', () => {
  const response = {
    candidates: [{ content: { parts: [{ text: 'gemini says ' }, { text: 'hello' }] }, finishReason: 'STOP' }],
    modelVersion: 'gemini-2.5-pro',
    usageMetadata: { promptTokenCount: 50, candidatesTokenCount: 7, thoughtsTokenCount: 3 }
  }

  it('posts generateContent with x-goog-api-key, mapping roles and system instruction', async () => {
    const { fetchMock, calls } = capture(response)
    const completion = await new GeminiAdapter({ apiKey: API_KEY, fetch: fetchMock }).complete(MESSAGES, {
      system: 'sys',
      maxTokens: 128,
      stopSequences: ['##']
    })
    const call = calls[0]!
    expect(call.url).toBe('https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-pro:generateContent')
    expect(call.headers.get('x-goog-api-key')).toBe(API_KEY)
    expect(call.body['systemInstruction']).toEqual({ parts: [{ text: 'sys' }] })
    expect(call.body['generationConfig']).toEqual({ maxOutputTokens: 128, stopSequences: ['##'] })
    expect(call.body['contents']).toEqual([
      { role: 'user', parts: [{ text: 'hello' }] },
      { role: 'model', parts: [{ text: 'hi there' }] },
      { role: 'user', parts: [{ text: 'summarize' }] }
    ])
    expect(completion.text).toBe('gemini says hello')
    // Thinking tokens are billed as output — folded into outputTokens.
    expect(completion.usage).toEqual({ inputTokens: 50, outputTokens: 10 })
    expect(completion.stopReason).toBe('STOP')
  })
})

describe('shared adapter behavior', () => {
  it('createCloudBrain returns the right adapter per provider', () => {
    const fetchMock = vi.fn<(input: string, init?: RequestInit) => Promise<Response>>()
    expect(createCloudBrain('anthropic', { apiKey: 'k', fetch: fetchMock }).provider).toBe('anthropic')
    expect(createCloudBrain('openai', { apiKey: 'k', fetch: fetchMock }).provider).toBe('openai')
    expect(createCloudBrain('gemini', { apiKey: 'k', fetch: fetchMock }).provider).toBe('gemini')
    expect(createCloudBrain('openrouter', { apiKey: 'k', fetch: fetchMock }).provider).toBe('openrouter')
  })

  it('refuses to construct without an API key', () => {
    expect(() => new AnthropicAdapter({ apiKey: '' })).toThrow(/API key/)
  })

  it('HTTP errors carry status + detail but NEVER the API key (§21 rule 7)', async () => {
    // Hostile case: the provider echoes the bad key back in the error body.
    const { fetchMock } = capture({ error: { message: `invalid key: ${API_KEY}` } }, 401)
    const brain = new AnthropicAdapter({ apiKey: API_KEY, fetch: fetchMock })
    const error = await brain.complete(MESSAGES).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(CloudBrainError)
    const { message, status } = error as CloudBrainError
    expect(status).toBe(401)
    expect(message).toContain('HTTP 401')
    expect(message).toContain('[redacted]')
    expect(message).not.toContain(API_KEY)
  })

  it('network failures are wrapped and scrubbed too', async () => {
    const fetchMock = vi.fn(async () => {
      throw new TypeError(`fetch failed for key ${API_KEY}`)
    })
    const brain = new OpenAIAdapter({ apiKey: API_KEY, fetch: fetchMock })
    const error = (await brain.complete(MESSAGES).catch((e: unknown) => e)) as CloudBrainError
    expect(error).toBeInstanceOf(CloudBrainError)
    expect(error.message).not.toContain(API_KEY)
    expect(error.message).toContain('[redacted]')
  })

  it('per-call model override wins over the adapter default', async () => {
    const { fetchMock, calls } = capture({ content: [], usage: {} })
    await new AnthropicAdapter({ apiKey: API_KEY, model: 'claude-sonnet-5', fetch: fetchMock }).complete(MESSAGES, {
      model: 'claude-haiku-4-5'
    })
    expect(calls[0]!.body['model']).toBe('claude-haiku-4-5')
  })
})
