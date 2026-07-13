/**
 * Local-LLM usage tracking (Stage 1) — the backend of the local-LLM visibility
 * feature. Covers the four seams end to end with HTTP + DB mocked:
 *  - the Ollama generate() recorder seam: one row per call (success AND failure),
 *    the daemon's counts/duration stamped, the role threaded, and — critically —
 *    a recorder that throws NEVER fails the completion;
 *  - OllamaClient.ps(): parse + graceful [] when the daemon is down / non-2xx;
 *  - LocalLlmUsageStore + pruneLocalLlmUsage against a real appdata.db (v9);
 *  - getLocalUsage aggregation math + the live-probe composition (ps + status).
 * The MCP tool def + the IPC channel wiring are in ipc.localUsage.test.ts.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { OllamaClient } from '../../src/main/models'
import { openAppData, type AppData } from '../../src/main/storage/appdata'
import { LocalLlmUsageStore, pruneLocalLlmUsage, type LocalLlmUsageEntry } from '../../src/main/storage/localUsage'
import { getLocalUsage, type LocalUsageOllama } from '../../src/main/reads/localUsage'
import { LOCAL_LLM_USAGE_RECENT_LIMIT } from '../../src/main/config'

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

/** A recording fake recorder that captures every entry. */
function capturingRecorder(): { entries: LocalLlmUsageEntry[]; record: (e: LocalLlmUsageEntry) => void } {
  const entries: LocalLlmUsageEntry[] = []
  return { entries, record: (e) => entries.push(e) }
}

// ── the generate() recorder seam ──────────────────────────────────────────────

describe('OllamaClient.generate — usage recorder seam', () => {
  it('records one row with the daemon counts + total_duration (ns→ms) and the threaded role', async () => {
    const recorder = capturingRecorder()
    const fetchMock = vi.fn<(input: string, init?: RequestInit) => Promise<Response>>(async () =>
      jsonResponse({ response: 'ok', model: 'qwen3:4b', prompt_eval_count: 12, eval_count: 5, total_duration: 2_000_000 })
    )
    const client = new OllamaClient({ fetch: fetchMock, recorder })
    const result = await client.generate('hi', { role: 'context.summarize' })

    expect(result).toEqual({ text: 'ok', model: 'qwen3:4b', inputTokens: 12, outputTokens: 5 })
    expect(recorder.entries).toEqual([
      { role: 'context.summarize', model: 'qwen3:4b', promptTokens: 12, evalTokens: 5, durationMs: 2, ok: true }
    ])
    // The role is metadata only — never sent to Ollama.
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).not.toHaveProperty('role')
  })

  it('records role NULL when the caller threads none (direct deps.llm call → "other")', async () => {
    const recorder = capturingRecorder()
    const client = new OllamaClient({
      fetch: vi.fn(async () => jsonResponse({ response: 'ok', model: 'qwen3:4b', prompt_eval_count: 1, eval_count: 1 })),
      recorder
    })
    await client.generate('hi')
    expect(recorder.entries).toHaveLength(1)
    expect(recorder.entries[0]?.role).toBeNull()
  })

  it('records a FAILED call (ok:false, null tokens, wall-clock duration) and still throws', async () => {
    const recorder = capturingRecorder()
    const client = new OllamaClient({
      fetch: vi.fn(async () => new Response('{"error":"boom"}', { status: 500 })),
      recorder
    })
    await expect(client.generate('x', { role: 'extraction.fuzzy' })).rejects.toThrow(/HTTP 500/)
    expect(recorder.entries).toHaveLength(1)
    const entry = recorder.entries[0]!
    expect(entry).toMatchObject({ role: 'extraction.fuzzy', model: 'qwen3:4b', promptTokens: null, evalTokens: null, ok: false })
    expect(entry.durationMs).toBeGreaterThanOrEqual(0)
  })

  it('records a FAILED call when the daemon is unreachable', async () => {
    const recorder = capturingRecorder()
    const client = new OllamaClient({
      fetch: vi.fn(async () => {
        throw new TypeError('fetch failed: ECONNREFUSED')
      }),
      recorder
    })
    await expect(client.generate('x')).rejects.toThrow(/unreachable/)
    expect(recorder.entries).toHaveLength(1)
    expect(recorder.entries[0]).toMatchObject({ ok: false, model: 'qwen3:4b' })
  })

  it('NEVER fails the completion when the recorder throws (swallow + log)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const throwingRecorder = {
      record: () => {
        throw new Error('db is closed')
      }
    }
    const client = new OllamaClient({
      fetch: vi.fn(async () => jsonResponse({ response: 'ok', model: 'qwen3:4b' })),
      recorder: throwingRecorder
    })
    await expect(client.generate('hi', { role: 'skills.grader' })).resolves.toMatchObject({ text: 'ok' })
    expect(warn).toHaveBeenCalledTimes(1)
    warn.mockRestore()
  })

  it('no recorder ⇒ today’s behavior (no throw, nothing recorded)', async () => {
    const client = new OllamaClient({
      fetch: vi.fn(async () => jsonResponse({ response: 'ok', model: 'qwen3:4b', prompt_eval_count: 3, eval_count: 2 }))
    })
    await expect(client.generate('hi')).resolves.toEqual({ text: 'ok', model: 'qwen3:4b', inputTokens: 3, outputTokens: 2 })
  })
})

// ── the /api/ps live snapshot ─────────────────────────────────────────────────

describe('OllamaClient.ps — live loaded-model snapshot', () => {
  it('parses loaded models (size, size_vram, expires_at)', async () => {
    const fetchMock = vi.fn<(input: string, init?: RequestInit) => Promise<Response>>(async () =>
      jsonResponse({
        models: [{ name: 'qwen3:4b', size: 3_400_000_000, size_vram: 3_200_000_000, expires_at: '2026-07-13T00:05:00Z' }]
      })
    )
    const loaded = await new OllamaClient({ fetch: fetchMock }).ps()
    expect(loaded).toEqual([
      { name: 'qwen3:4b', sizeBytes: 3_400_000_000, sizeVramBytes: 3_200_000_000, expiresAt: '2026-07-13T00:05:00Z' }
    ])
    expect(String(fetchMock.mock.calls[0]?.[0])).toMatch(/\/api\/ps$/)
  })

  it('defaults missing numeric/date fields', async () => {
    const loaded = await new OllamaClient({ fetch: vi.fn(async () => jsonResponse({ models: [{ name: 'qwen3:4b' }] })) }).ps()
    expect(loaded).toEqual([{ name: 'qwen3:4b', sizeBytes: 0, sizeVramBytes: 0, expiresAt: null }])
  })

  it('returns [] when the daemon is down', async () => {
    const loaded = await new OllamaClient({
      fetch: vi.fn(async () => {
        throw new TypeError('ECONNREFUSED')
      })
    }).ps()
    expect(loaded).toEqual([])
  })

  it('returns [] on a non-2xx response', async () => {
    const loaded = await new OllamaClient({ fetch: vi.fn(async () => new Response('nope', { status: 500 })) }).ps()
    expect(loaded).toEqual([])
  })
})

// ── the appdata-backed store, retention, and aggregation read ─────────────────

describe('local_llm_usage store + retention + summary (appdata v9)', () => {
  let dir: string
  let app: AppData
  const insert = (
    db: AppData['db'],
    ts: string,
    role: string | null,
    model: string,
    prompt: number | null,
    evalT: number | null,
    duration: number,
    ok: number
  ): void => {
    db.prepare(
      `INSERT INTO local_llm_usage (ts, role, model, prompt_tokens, eval_tokens, duration_ms, ok)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(ts, role, model, prompt, evalT, duration, ok)
  }
  /** ISO at `offsetDays` before now, at a fixed UTC hour (keeps day-buckets deterministic). */
  const isoDaysAgo = (offsetDays: number, hour: number): string => {
    const d = new Date(Date.now() - offsetDays * 24 * 60 * 60 * 1000)
    d.setUTCHours(hour, 0, 0, 0)
    return d.toISOString()
  }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'local-usage-'))
    app = openAppData(join(dir, 'appdata.db'))
  })
  afterEach(() => {
    app.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('LocalLlmUsageStore.record writes the entry fields (ok → 1)', () => {
    new LocalLlmUsageStore(app.db).record({
      role: 'skills.grader',
      model: 'qwen3:4b',
      promptTokens: 50,
      evalTokens: 10,
      durationMs: 300,
      ok: true
    })
    const row = app.db
      .prepare('SELECT role, model, prompt_tokens, eval_tokens, duration_ms, ok FROM local_llm_usage')
      .get() as Record<string, unknown>
    expect(row).toEqual({ role: 'skills.grader', model: 'qwen3:4b', prompt_tokens: 50, eval_tokens: 10, duration_ms: 300, ok: 1 })
    // ts default populated.
    const ts = (app.db.prepare('SELECT ts FROM local_llm_usage').get() as { ts: string }).ts
    expect(Number.isNaN(Date.parse(ts))).toBe(false)
  })

  it('record(ok:false) persists ok → 0 and null token columns', () => {
    new LocalLlmUsageStore(app.db).record({ role: null, model: 'qwen3:4b', promptTokens: null, evalTokens: null, durationMs: 12, ok: false })
    const row = app.db.prepare('SELECT role, ok, prompt_tokens FROM local_llm_usage').get() as { role: null; ok: number; prompt_tokens: null }
    expect(row).toEqual({ role: null, ok: 0, prompt_tokens: null })
  })

  it('pruneLocalLlmUsage deletes rows older than retention and keeps recent ones', () => {
    insert(app.db, isoDaysAgo(40, 9), 'context.summarize', 'qwen3:4b', 10, 5, 100, 1) // past 30d
    insert(app.db, isoDaysAgo(31, 9), null, 'qwen3:4b', 10, 5, 100, 1) // past 30d
    insert(app.db, isoDaysAgo(2, 9), 'extraction.fuzzy', 'qwen3:4b', 10, 5, 100, 1) // kept
    const pruned = pruneLocalLlmUsage(app.db)
    expect(pruned).toBe(2)
    expect((app.db.prepare('SELECT count(*) AS c FROM local_llm_usage').get() as { c: number }).c).toBe(1)
  })

  it('pruneLocalLlmUsage honors a custom window', () => {
    insert(app.db, isoDaysAgo(5, 9), 'r', 'qwen3:4b', 1, 1, 1, 1)
    insert(app.db, isoDaysAgo(1, 9), 'r', 'qwen3:4b', 1, 1, 1, 1)
    expect(pruneLocalLlmUsage(app.db, 3)).toBe(1)
    expect((app.db.prepare('SELECT count(*) AS c FROM local_llm_usage').get() as { c: number }).c).toBe(1)
  })

  it('getLocalUsage aggregates totals / byRole / byDay / recent (NULL role → "other")', async () => {
    insert(app.db, isoDaysAgo(2, 9), 'extraction.fuzzy', 'qwen3:4b', 100, 20, 500, 1)
    insert(app.db, isoDaysAgo(2, 10), 'extraction.fuzzy', 'qwen3:4b', 200, 40, 700, 1)
    insert(app.db, isoDaysAgo(1, 11), 'context.summarize', 'qwen3:4b', 50, 10, 300, 1)
    insert(app.db, isoDaysAgo(1, 12), null, 'qwen3:4b', 10, 0, 100, 0) // NULL role, failed call

    const summary = await getLocalUsage({ db: app.db })

    expect(summary.sinceDays).toBe(30)
    expect(summary.totals).toEqual({ calls: 4, promptTokens: 360, evalTokens: 70, computeMs: 1600 })
    // byRole ordered by computeMs desc.
    expect(summary.byRole).toEqual([
      { role: 'extraction.fuzzy', calls: 2, computeMs: 1200 },
      { role: 'context.summarize', calls: 1, computeMs: 300 },
      { role: 'other', calls: 1, computeMs: 100 }
    ])
    // byDay: two UTC-date buckets, ascending.
    const dayOlder = isoDaysAgo(2, 9).slice(0, 10)
    const dayNewer = isoDaysAgo(1, 11).slice(0, 10)
    expect(summary.byDay).toEqual([
      { day: dayOlder, calls: 2, computeMs: 1200 },
      { day: dayNewer, calls: 2, computeMs: 400 }
    ])
    // recent: newest first; the failed NULL-role row was inserted last.
    expect(summary.recent).toHaveLength(4)
    expect(summary.recent[0]).toMatchObject({ role: null, ok: false, model: 'qwen3:4b' })
    // no ollama supplied → empty live snapshot.
    expect(summary.loaded).toEqual([])
    expect(summary.ollamaState).toBe('daemon-not-running')
  })

  it('getLocalUsage windows totals by sinceDays and clamps the range', async () => {
    insert(app.db, isoDaysAgo(5, 9), 'r', 'qwen3:4b', 10, 10, 10, 1)
    insert(app.db, isoDaysAgo(0, 9), 'r', 'qwen3:4b', 20, 20, 20, 1)

    expect((await getLocalUsage({ db: app.db }, { sinceDays: 3 })).totals.calls).toBe(1) // only the 0-day row
    expect((await getLocalUsage({ db: app.db }, { sinceDays: 30 })).totals.calls).toBe(2)
    // clamp: 0 → 1, huge → 365, absent → default 30.
    expect((await getLocalUsage({ db: app.db }, { sinceDays: 0 })).sinceDays).toBe(1)
    expect((await getLocalUsage({ db: app.db }, { sinceDays: 9999 })).sinceDays).toBe(365)
    expect((await getLocalUsage({ db: app.db })).sinceDays).toBe(30)
  })

  it('recent is capped at LOCAL_LLM_USAGE_RECENT_LIMIT regardless of the window', async () => {
    for (let i = 0; i < LOCAL_LLM_USAGE_RECENT_LIMIT + 5; i++) {
      insert(app.db, isoDaysAgo(0, 9), 'r', 'qwen3:4b', 1, 1, 1, 1)
    }
    const summary = await getLocalUsage({ db: app.db })
    expect(summary.recent).toHaveLength(LOCAL_LLM_USAGE_RECENT_LIMIT)
    expect(summary.totals.calls).toBe(LOCAL_LLM_USAGE_RECENT_LIMIT + 5)
  })

  it('getLocalUsage composes the live snapshot (ps + status) when an Ollama client is supplied', async () => {
    const ollama: LocalUsageOllama = {
      ps: async () => [{ name: 'qwen3:4b', sizeBytes: 3_200_000_000, sizeVramBytes: 0, expiresAt: '2026-07-13T00:05:00Z' }],
      status: async () => ({ state: 'ready', installedModels: ['qwen3:4b'], missingModels: [], installUrl: 'x' })
    }
    const summary = await getLocalUsage({ db: app.db, ollama })
    expect(summary.loaded).toEqual([
      { name: 'qwen3:4b', sizeBytes: 3_200_000_000, sizeVramBytes: 0, expiresAt: '2026-07-13T00:05:00Z' }
    ])
    expect(summary.ollamaState).toBe('ready')
  })

  it('getLocalUsage degrades gracefully when the live probe throws', async () => {
    const ollama: LocalUsageOllama = {
      ps: async () => {
        throw new Error('ps down')
      },
      status: async () => {
        throw new Error('status down')
      }
    }
    const summary = await getLocalUsage({ db: app.db, ollama })
    expect(summary.loaded).toEqual([])
    expect(summary.ollamaState).toBe('daemon-not-running')
  })
})
