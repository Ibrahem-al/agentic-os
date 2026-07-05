/**
 * Cloud adapter unit tests — mocked HTTP for all four providers. Each adapter
 * is checked for wire shape (URL, auth header, body), response parsing
 * (text + usage + stop reason), §21-rule-7 key redaction in errors, and the
 * §8 scheduler policy (one FIFO lane + per-provider spacing + 429 handling).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  CLOUD_LANE_MIN_INTERVAL_MS,
  CLOUD_RATE_LIMIT_DEFAULT_WAIT_MS,
  CLOUD_RATE_LIMIT_MAX_WAIT_MS,
  CLOUD_RATE_LIMIT_RETRIES
} from '../../src/main/config'
import {
  AnthropicAdapter,
  CloudBrainError,
  GeminiAdapter,
  OpenAIAdapter,
  OpenRouterAdapter,
  createCloudBrain,
  resetCloudLaneForTests,
  type ChatMessage
} from '../../src/main/models'

const API_KEY = 'sk-test-key-THIS-MUST-NEVER-LEAK-4242'
const MESSAGES: ChatMessage[] = [
  { role: 'user', content: 'hello' },
  { role: 'assistant', content: 'hi there' },
  { role: 'user', content: 'summarize' }
]

// The lane + spacing state is module-level by design (§8: process-wide);
// isolate tests from each other's spacing bookkeeping.
beforeEach(() => resetCloudLaneForTests())

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

// ── §8 scheduler policy: one cloud lane + per-provider spacing + 429s ────────

/** One macrotask turn — lets queued lane work start (or provably not start). */
const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0))

/** Minimal 200 body every adapter parses without complaint. */
const okResponse = () => new Response(JSON.stringify({ content: [{ type: 'text', text: 'ok' }] }), { status: 200 })

const rateLimited = (retryAfter?: string, body = '{"error":{"message":"rate limited"}}') =>
  new Response(body, { status: 429, headers: retryAfter === undefined ? {} : { 'retry-after': retryAfter } })

/** Sleep spy that records requested waits and never really waits. */
function recordingSleep() {
  const sleeps: number[] = []
  const sleep = async (ms: number) => {
    sleeps.push(ms)
  }
  return { sleeps, sleep }
}

describe('cloud lane (§8: single lane, FIFO, per-provider spacing)', () => {
  it('serializes ALL completions process-wide — the second fetch starts only after the first resolved', async () => {
    const events: string[] = []
    let releaseFirst!: () => void
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve
    })
    const fetchMock = vi.fn(async (url: string) => {
      const who = url.includes('anthropic') ? 'anthropic' : 'openai'
      events.push(`start:${who}`)
      if (who === 'anthropic') {
        await firstGate
        events.push('end:anthropic')
      }
      return okResponse()
    })
    const first = new AnthropicAdapter({ apiKey: API_KEY, fetch: fetchMock })
    const second = new OpenAIAdapter({ apiKey: API_KEY, fetch: fetchMock })

    const p1 = first.complete(MESSAGES)
    const p2 = second.complete(MESSAGES)
    await settle()
    // The lane is held by the first call — the second's fetch has NOT started.
    expect(fetchMock).toHaveBeenCalledTimes(1)
    releaseFirst()
    await Promise.all([p1, p2])
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(events).toEqual(['start:anthropic', 'end:anthropic', 'start:openai'])
  })

  it('spaces consecutive same-provider calls CLOUD_LANE_MIN_INTERVAL_MS apart, start-to-start', async () => {
    const { sleeps, sleep } = recordingSleep()
    let clock = 1_000_000
    const now = () => clock
    const { fetchMock } = capture({ content: [] })
    const brain = new AnthropicAdapter({ apiKey: API_KEY, fetch: fetchMock, sleep, now })

    await brain.complete(MESSAGES) // first call: no predecessor → no wait
    expect(sleeps).toEqual([])
    clock += 40 // 40 ms elapse between the two starts
    await brain.complete(MESSAGES) // second call waits out the remainder
    expect(sleeps).toEqual([CLOUD_LANE_MIN_INTERVAL_MS - 40])
  })

  it('a DIFFERENT provider never waits on another provider spacing — only on the lane', async () => {
    const { sleeps, sleep } = recordingSleep()
    const now = () => 5_000 // frozen clock: same-provider spacing would be the full interval
    const opts = { apiKey: API_KEY, sleep, now }
    await new AnthropicAdapter({ ...opts, fetch: capture({ content: [] }).fetchMock }).complete(MESSAGES)
    await new OpenAIAdapter({ ...opts, fetch: capture({ choices: [] }).fetchMock }).complete(MESSAGES)
    expect(sleeps).toEqual([]) // openai immediately after anthropic: no spacing wait
    await new AnthropicAdapter({ ...opts, fetch: capture({ content: [] }).fetchMock }).complete(MESSAGES)
    expect(sleeps).toEqual([CLOUD_LANE_MIN_INTERVAL_MS]) // anthropic again: full spacing
  })
})

describe('cloud 429 handling (§8: provider rate limits, in-lane retries)', () => {
  it('honors Retry-After seconds: one retry, success, exactly 2 fetches', async () => {
    const { sleeps, sleep } = recordingSleep()
    let call = 0
    const fetchMock = vi.fn(async () => (++call === 1 ? rateLimited('1') : okResponse()))
    const completion = await new AnthropicAdapter({ apiKey: API_KEY, fetch: fetchMock, sleep }).complete(MESSAGES)
    expect(completion.text).toBe('ok')
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(sleeps).toEqual([1000])
  })

  it('429 forever: default wait per retry, then the normal scrubbed CloudBrainError', async () => {
    const { sleeps, sleep } = recordingSleep()
    // Hostile case: the provider echoes the key back in the 429 body.
    const fetchMock = vi.fn(async () => rateLimited(undefined, `{"error":"slow down, ${API_KEY}"}`))
    const brain = new OpenAIAdapter({ apiKey: API_KEY, fetch: fetchMock, sleep })
    const error = (await brain.complete(MESSAGES).catch((e: unknown) => e)) as CloudBrainError
    expect(error).toBeInstanceOf(CloudBrainError)
    expect(error.status).toBe(429)
    expect(error.message).toContain('HTTP 429')
    expect(error.message).not.toContain(API_KEY)
    expect(error.message).toContain('[redacted]')
    expect(fetchMock).toHaveBeenCalledTimes(CLOUD_RATE_LIMIT_RETRIES + 1)
    expect(sleeps).toEqual(Array.from({ length: CLOUD_RATE_LIMIT_RETRIES }, () => CLOUD_RATE_LIMIT_DEFAULT_WAIT_MS))
  })

  it('caps a huge Retry-After at CLOUD_RATE_LIMIT_MAX_WAIT_MS', async () => {
    const { sleeps, sleep } = recordingSleep()
    let call = 0
    const fetchMock = vi.fn(async () => (++call === 1 ? rateLimited('3600') : okResponse()))
    await new AnthropicAdapter({ apiKey: API_KEY, fetch: fetchMock, sleep }).complete(MESSAGES)
    expect(sleeps).toEqual([CLOUD_RATE_LIMIT_MAX_WAIT_MS])
  })

  it('parses an HTTP-date Retry-After relative to now', async () => {
    const { sleeps, sleep } = recordingSleep()
    const base = Date.parse('2026-07-05T12:00:00Z')
    const now = () => base
    let call = 0
    const fetchMock = vi.fn(async () => (++call === 1 ? rateLimited(new Date(base + 5000).toUTCString()) : okResponse()))
    await new AnthropicAdapter({ apiKey: API_KEY, fetch: fetchMock, sleep, now }).complete(MESSAGES)
    expect(sleeps).toEqual([5000])
  })

  it('HOLDS the lane across the 429 wait — a parallel caller cannot stampede the provider', async () => {
    let releaseWait!: () => void
    const waitGate = new Promise<void>((resolve) => {
      releaseWait = resolve
    })
    const sleep = vi.fn(() => waitGate) // the retry wait, under test control
    let call = 0
    const fetchMock = vi.fn(async () => (++call === 1 ? rateLimited('1') : okResponse()))
    const limited = new AnthropicAdapter({ apiKey: API_KEY, fetch: fetchMock, sleep })
    const bystander = new OpenAIAdapter({ apiKey: API_KEY, fetch: fetchMock, sleep })

    const p1 = limited.complete(MESSAGES)
    const p2 = bystander.complete(MESSAGES)
    await settle()
    // p1 got its 429 and is waiting IN-lane; p2's fetch must not have started.
    expect(fetchMock).toHaveBeenCalledTimes(1)
    releaseWait()
    await Promise.all([p1, p2])
    expect(fetchMock).toHaveBeenCalledTimes(3) // 429 + retry + bystander
  })

  it('non-429 HTTP errors are never retried here (the task queue owns coarse retries, §20)', async () => {
    const { sleeps, sleep } = recordingSleep()
    const fetchMock = vi.fn(async () => new Response('{"error":"boom"}', { status: 500 }))
    const brain = new GeminiAdapter({ apiKey: API_KEY, fetch: fetchMock, sleep })
    await expect(brain.complete(MESSAGES)).rejects.toThrow(/HTTP 500/)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(sleeps).toEqual([])
  })
})
