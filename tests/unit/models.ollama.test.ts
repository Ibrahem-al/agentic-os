/**
 * Ollama client unit tests — all HTTP mocked. Covers the §4 guided-install
 * state machine, one-click pull (NDJSON progress stream), embed dims
 * validation, generate defaults (think:false, stream:false), and the §8
 * local pool (LOCAL_POOL_CONCURRENCY bound on embed/generate).
 */
import { describe, expect, it, vi } from 'vitest'
import { EMBEDDING_DIM, LOCAL_POOL_CONCURRENCY } from '../../src/main/config'
import { OllamaClient, OllamaError } from '../../src/main/models'

type FetchMock = ReturnType<typeof vi.fn<(input: string, init?: RequestInit) => Promise<Response>>>

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

function requestBody(fetchMock: FetchMock, call = 0): Record<string, unknown> {
  const init = fetchMock.mock.calls[call]?.[1]
  return JSON.parse(String(init?.body)) as Record<string, unknown>
}

describe('ollama status (guided-install state machine)', () => {
  it('reports daemon-not-running with the installer link when fetch fails', async () => {
    const fetchMock = vi.fn(async () => {
      throw new TypeError('fetch failed: ECONNREFUSED')
    })
    const status = await new OllamaClient({ fetch: fetchMock }).status()
    expect(status.state).toBe('daemon-not-running')
    expect(status.missingModels).toEqual(['bge-m3', 'qwen3:4b'])
    expect(status.installUrl).toContain('ollama.com')
  })

  it('reports models-missing when a required model is not pulled', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ models: [{ name: 'bge-m3:latest' }] }))
    const status = await new OllamaClient({ fetch: fetchMock }).status()
    expect(status.state).toBe('models-missing')
    expect(status.missingModels).toEqual(['qwen3:4b'])
    expect(status.installedModels).toEqual(['bge-m3:latest'])
  })

  it('reports ready when both required models are present (":latest" counts)', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ models: [{ name: 'bge-m3:latest' }, { name: 'qwen3:4b' }] }))
    const status = await new OllamaClient({ fetch: fetchMock }).status()
    expect(status.state).toBe('ready')
    expect(status.missingModels).toEqual([])
  })
})

describe('ollama pull (one-click install)', () => {
  it('streams NDJSON progress events', async () => {
    const ndjson =
      JSON.stringify({ status: 'pulling manifest' }) +
      '\n' +
      JSON.stringify({ status: 'downloading', completed: 50, total: 100 }) +
      '\n' +
      JSON.stringify({ status: 'success' }) +
      '\n'
    const fetchMock = vi.fn(async () => new Response(ndjson, { status: 200 }))
    const events: string[] = []
    await new OllamaClient({ fetch: fetchMock }).pull('bge-m3', (p) => events.push(`${p.status}${p.completed ?? ''}`))
    expect(events).toEqual(['pulling manifest', 'downloading50', 'success'])
    expect(fetchMock).toHaveBeenCalledWith('http://127.0.0.1:11434/api/pull', expect.objectContaining({ method: 'POST' }))
    expect(requestBody(fetchMock as FetchMock)).toEqual({ model: 'bge-m3', stream: true })
  })

  it('throws when the stream reports an error', async () => {
    const ndjson = JSON.stringify({ error: 'model not found' }) + '\n'
    const fetchMock = vi.fn(async () => new Response(ndjson, { status: 200 }))
    await expect(new OllamaClient({ fetch: fetchMock }).pull('nope')).rejects.toThrow(/model not found/)
  })

  it('ensureRequiredModels pulls only the missing models', async () => {
    const pulled: string[] = []
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith('/api/tags')) {
        const models = [{ name: 'bge-m3:latest' }, ...pulled.map((name) => ({ name }))]
        return jsonResponse({ models })
      }
      if (url.endsWith('/api/pull')) {
        const body = JSON.parse(String(init?.body)) as { model: string }
        pulled.push(body.model)
        return new Response(JSON.stringify({ status: 'success' }) + '\n', { status: 200 })
      }
      throw new Error(`unexpected url ${url}`)
    })
    const status = await new OllamaClient({ fetch: fetchMock }).ensureRequiredModels()
    expect(pulled).toEqual(['qwen3:4b'])
    expect(status.state).toBe('ready')
  })

  it('ensureRequiredModels refuses when the daemon is down', async () => {
    const fetchMock = vi.fn(async () => {
      throw new TypeError('ECONNREFUSED')
    })
    await expect(new OllamaClient({ fetch: fetchMock }).ensureRequiredModels()).rejects.toThrow(OllamaError)
  })
})

describe('ollama embed', () => {
  it('embeds texts via bge-m3 and returns 1024-dim vectors', async () => {
    const embedding = () => Array.from({ length: EMBEDDING_DIM }, (_, i) => i / EMBEDDING_DIM)
    const fetchMock = vi.fn(async () => jsonResponse({ embeddings: [embedding(), embedding()] }))
    const result = await new OllamaClient({ fetch: fetchMock }).embed(['first text', 'second text'])
    expect(result).toHaveLength(2)
    expect(result[0]).toHaveLength(EMBEDDING_DIM)
    expect(fetchMock).toHaveBeenCalledWith('http://127.0.0.1:11434/api/embed', expect.anything())
    expect(requestBody(fetchMock as FetchMock)).toEqual({ model: 'bge-m3', input: ['first text', 'second text'] })
  })

  it('returns [] for no inputs without calling the daemon', async () => {
    const fetchMock = vi.fn<(input: string, init?: RequestInit) => Promise<Response>>()
    await expect(new OllamaClient({ fetch: fetchMock }).embed([])).resolves.toEqual([])
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('rejects wrong-dimension embeddings loudly', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ embeddings: [[0.1, 0.2, 0.3]] }))
    await expect(new OllamaClient({ fetch: fetchMock }).embed(['text'])).rejects.toThrow(/3 dims.*1024/)
  })

  it('rejects a count mismatch between inputs and embeddings', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ embeddings: [] }))
    await expect(new OllamaClient({ fetch: fetchMock }).embed(['text'])).rejects.toThrow(/0 embeddings for 1 inputs/)
  })
})

describe('ollama generate', () => {
  it('generates with the small LLM, thinking off and stream off by default', async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({ response: 'pong', model: 'qwen3:4b', prompt_eval_count: 12, eval_count: 3 })
    )
    const result = await new OllamaClient({ fetch: fetchMock }).generate('ping?')
    expect(result).toEqual({ text: 'pong', model: 'qwen3:4b', inputTokens: 12, outputTokens: 3 })
    const body = requestBody(fetchMock as FetchMock)
    expect(body).toMatchObject({ model: 'qwen3:4b', prompt: 'ping?', stream: false, think: false })
    expect(body).not.toHaveProperty('options')
  })

  it('maps maxTokens/temperature/stop into Ollama options and system through', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ response: 'ok' }))
    await new OllamaClient({ fetch: fetchMock }).generate('prompt', {
      system: 'be terse',
      maxTokens: 64,
      temperature: 0,
      stop: ['\n'],
      think: true,
      model: 'qwen3:8b'
    })
    expect(requestBody(fetchMock as FetchMock)).toEqual({
      model: 'qwen3:8b',
      prompt: 'prompt',
      stream: false,
      think: true,
      system: 'be terse',
      options: { num_predict: 64, temperature: 0, stop: ['\n'] }
    })
  })

  it('surfaces HTTP errors with status and detail', async () => {
    const fetchMock = vi.fn(async () => new Response('{"error":"boom"}', { status: 500 }))
    await expect(new OllamaClient({ fetch: fetchMock }).generate('x')).rejects.toThrow(/HTTP 500.*boom/)
  })
})

describe('ollama local pool (§8: cheap local work runs in a parallel pool)', () => {
  const embedding = () => Array.from({ length: EMBEDDING_DIM }, () => 0.5)
  /** One macrotask turn — lets queued pool work start (or provably not start). */
  const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0))

  it('bounds concurrent embed() requests at LOCAL_POOL_CONCURRENCY and completes all 8', async () => {
    let inFlight = 0
    let maxInFlight = 0
    const gates: (() => void)[] = []
    const fetchMock = vi.fn(async () => {
      inFlight += 1
      maxInFlight = Math.max(maxInFlight, inFlight)
      await new Promise<void>((resolve) => gates.push(resolve))
      inFlight -= 1
      return jsonResponse({ embeddings: [embedding()] })
    })
    const client = new OllamaClient({ fetch: fetchMock })
    const jobs = Array.from({ length: 8 }, (_, i) => client.embed([`text ${i}`]))

    await settle()
    // First wave only — the other 4 are queued on the semaphore, not in HTTP.
    expect(fetchMock).toHaveBeenCalledTimes(LOCAL_POOL_CONCURRENCY)
    expect(inFlight).toBe(LOCAL_POOL_CONCURRENCY)

    // Release every request as it arrives; queued work flows in behind.
    let released = 0
    while (released < 8) {
      const gate = gates.shift()
      if (gate !== undefined) {
        gate()
        released += 1
      }
      await settle()
    }
    const results = await Promise.all(jobs)
    expect(results).toHaveLength(8)
    expect(fetchMock).toHaveBeenCalledTimes(8)
    expect(maxInFlight).toBe(LOCAL_POOL_CONCURRENCY)
  })

  it('status() bypasses the pool — the dashboard gets an answer while it is saturated', async () => {
    const gates: (() => void)[] = []
    const fetchMock = vi.fn(async (url: string) => {
      if (url.endsWith('/api/tags')) {
        return jsonResponse({ models: [{ name: 'bge-m3' }, { name: 'qwen3:4b' }] })
      }
      await new Promise<void>((resolve) => gates.push(resolve))
      return jsonResponse({ embeddings: [embedding()] })
    })
    const client = new OllamaClient({ fetch: fetchMock })
    const jobs = Array.from({ length: LOCAL_POOL_CONCURRENCY }, () => client.embed(['x']))
    await settle()
    expect(gates).toHaveLength(LOCAL_POOL_CONCURRENCY) // every permit held

    const status = await client.status() // resolves NOW — it never queues
    expect(status.state).toBe('ready')

    for (const gate of gates) gate()
    await expect(Promise.all(jobs)).resolves.toHaveLength(LOCAL_POOL_CONCURRENCY)
  })
})
