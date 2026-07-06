/**
 * Fuzzy extraction mechanics (phase-08): JSON-array rescue from narrated
 * replies, tolerant item normalization, transcript chunking, cross-chunk
 * dedup, the confidence accounting that drives the §20 escalation gates, and
 * both gates (transcript size / low local confidence) with and without a
 * cloud tier.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import {
  chunkTranscript,
  ExtractionError,
  ExtractionUnavailableError,
  extractItemsReply,
  extractJsonArray,
  extractJsonObject,
  runFuzzyExtraction,
  type ExtractionLlm,
  type TranscriptDigest
} from '../../src/main/agents'
import { EXTRACTION_MAX_ITEMS_PER_PASS } from '../../src/main/config'
import { SpendMeter } from '../../src/main/models'
import { estimatingTokenCounter } from '../../src/main/retrieval'
import { openAppData } from '../../src/main/storage'
import { FakeCloudBrain } from '../fixtures/extraction-fakes'

const baseDir = mkdtempSync(join(tmpdir(), 'agentic-os-fuzzy-'))
const appData = openAppData(join(baseDir, 'appdata.db'))
const meter = new SpendMeter({ db: appData.db })
afterAll(() => {
  appData.close()
  rmSync(baseDir, { recursive: true, force: true })
})

const digestOf = (text: string, tokenEstimate?: number): TranscriptDigest => ({
  records: 1,
  skippedRecords: 0,
  cwd: null,
  sessionIdSeen: null,
  startedAt: null,
  endedAt: null,
  text,
  tokenEstimate: tokenEstimate ?? estimatingTokenCounter().count(text),
  toolUses: [],
  mcpServers: [],
  pluginNames: [],
  skillNames: [],
  warnings: []
})

/** Inline fake with per-pass reply queues (last entry repeats). */
function queueLlm(replies: Partial<Record<'components' | 'preferences' | 'corrections', string[]>>): ExtractionLlm & {
  calls: Record<'components' | 'preferences' | 'corrections', number>
} {
  const calls = { components: 0, preferences: 0, corrections: 0 }
  return {
    calls,
    async generate(_prompt: string, options?: { system?: string }): Promise<{ text: string }> {
      const system = options?.system ?? ''
      const pass = system.includes('extract software components')
        ? ('components' as const)
        : system.includes('extract user preferences')
          ? ('preferences' as const)
          : system.includes('extract explicit user corrections')
            ? ('corrections' as const)
            : null
      if (pass === null) throw new Error(`unexpected system prompt: ${system.slice(0, 60)}`)
      const queue = replies[pass] ?? ['[]']
      const text = queue[Math.min(calls[pass], queue.length - 1)] ?? '[]'
      calls[pass] += 1
      return { text }
    }
  }
}

const throwingLlm: ExtractionLlm = {
  generate() {
    throw new Error('local tier must not be called on this path')
  }
}

describe('extractJsonArray', () => {
  it('rescues the array from narrated replies (the qwen3 failure mode)', () => {
    const reply =
      'We are looking at the transcript. The user mentioned components. Here is my answer:\n' +
      '[{"name": "checkout page", "type": "page", "confidence": 0.9}]\nThat is all I found.'
    expect(extractJsonArray(reply)).toEqual([{ name: 'checkout page', type: 'page', confidence: 0.9 }])
  })

  it('is string-aware: brackets and braces inside values never break the match', () => {
    const reply = 'ok: [{"name": "weird [x] {y} \\" name", "confidence": 1}] done'
    const parsed = extractJsonArray(reply)
    expect(parsed).toHaveLength(1)
    expect((parsed![0] as { name: string }).name).toBe('weird [x] {y} " name')
  })

  it('returns null when no well-formed array exists, and [] for an explicit empty', () => {
    expect(extractJsonArray('there is nothing here')).toBeNull()
    expect(extractJsonArray('broken [1, 2')).toBeNull()
    expect(extractJsonArray('the answer is []')).toEqual([])
  })

  it('skips earlier malformed brackets and finds a later valid array', () => {
    expect(extractJsonArray('x[oops then ["a", "b"] trailing')).toEqual(['a', 'b'])
  })
})

describe('extractJsonObject', () => {
  it('rescues a JSON object from narration', () => {
    expect(extractJsonObject('I think… {"verdict": "confirm", "confidence": 0.8} — done')).toEqual({
      verdict: 'confirm',
      confidence: 0.8
    })
    expect(extractJsonObject('no object')).toBeNull()
  })
})

describe('extractItemsReply', () => {
  it('accepts both a bare array and the schema-constrained {"items": [...]} object', () => {
    expect(extractItemsReply('[{"name": "a"}]')).toEqual([{ name: 'a' }])
    expect(extractItemsReply('{"items": [{"name": "a"}]}')).toEqual([{ name: 'a' }])
    expect(extractItemsReply('{"items": []}')).toEqual([])
    // An object reply is read object-first: a bracket inside a string value
    // never wins the scan.
    expect(extractItemsReply('{"note": "see [1]", "items": [{"name": "b"}]}')).toEqual([{ name: 'b' }])
    expect(extractItemsReply('nothing structured')).toBeNull()
  })
})

describe('chunkTranscript', () => {
  const counter = estimatingTokenCounter()

  it('packs lines up to the token target and never loses content', () => {
    const lines = Array.from({ length: 200 }, (_, i) => `User: message number ${i} with a few extra words`)
    const text = lines.join('\n')
    const chunks = chunkTranscript(text, 256, counter)
    expect(chunks.length).toBeGreaterThan(1)
    for (const chunk of chunks) expect(counter.count(chunk)).toBeLessThanOrEqual(256)
    expect(chunks.join('\n')).toBe(text)
  })

  it('hard-splits a single pathological line larger than the budget', () => {
    const text = 'x'.repeat(10_000)
    const chunks = chunkTranscript(text, 128, counter)
    expect(chunks.length).toBeGreaterThan(1)
    expect(chunks.join('')).toBe(text)
  })
})

describe('runFuzzyExtraction — parsing, dedup, confidence accounting', () => {
  it('normalizes items tolerantly: drops garbage, clamps confidence, caps runaway arrays', async () => {
    const oversized = JSON.stringify([
      { name: 'good one', type: 'SERVICE', confidence: 1.7 },
      { name: '   ', type: 'page' },
      'not an object',
      { type: 'page', confidence: 0.9 },
      { name: 'no confidence item' },
      ...Array.from({ length: 30 }, (_, i) => ({ name: `filler ${i}`, type: 'module', confidence: 0.8 }))
    ])
    const llm = queueLlm({ components: [oversized] })
    const result = await runFuzzyExtraction({ llm, transcript: digestOf('User: hi') })
    expect(result.tier).toBe('local')
    const names = result.components.map((c) => c.name)
    expect(names).toContain('good one')
    expect(names).toContain('no confidence item')
    expect(names).not.toContain('not an object')
    // Cap applies to the raw array before normalization.
    expect(result.components.length).toBeLessThanOrEqual(EXTRACTION_MAX_ITEMS_PER_PASS)
    const goodOne = result.components.find((c) => c.name === 'good one')!
    expect(goodOne.confidence).toBe(1) // clamped
    expect(goodOne.type).toBe('service') // lowercased
    const defaulted = result.components.find((c) => c.name === 'no confidence item')!
    expect(defaulted.confidence).toBe(0.5) // borderline default → review path
  })

  it('dedupes items across chunks by normalized key, keeping the max confidence', async () => {
    // ~2 local chunks of transcript so every pass runs twice.
    const text = Array.from({ length: 400 }, (_, i) => `User: filler line ${i} about the greenhouse project`).join('\n')
    const llm = queueLlm({
      components: [
        '[{"name": "Watering  Schedule", "type": "model", "confidence": 0.6, "depends_on": ["pump"]}]',
        '[{"name": "watering schedule", "type": "model", "confidence": 0.9, "depends_on": ["valve"]}]'
      ]
    })
    const result = await runFuzzyExtraction({ llm, transcript: digestOf(text) })
    expect(llm.calls.components).toBeGreaterThanOrEqual(2)
    const matches = result.components.filter((c) => c.name.toLowerCase().replace(/\s+/g, ' ') === 'watering schedule')
    expect(matches).toHaveLength(1)
    expect(matches[0]!.confidence).toBe(0.9)
    expect([...matches[0]!.dependsOn].sort()).toEqual(['pump', 'valve'])
  })

  it('scores calls (unparseable 0, empty 1, items mean) into sessionConfidence and warns without a cloud tier', async () => {
    const llm = queueLlm({
      components: ['no json array in this reply at all'],
      preferences: ['[]'],
      corrections: ['[{"content": "stop doing x", "confidence": 0.8}, {"content": "use y", "confidence": 0.6}]']
    })
    const result = await runFuzzyExtraction({ llm, transcript: digestOf('User: hello') })
    // (0 + 1 + 0.7) / 3 ≈ 0.5667 < 0.6 → gate B fires, but no cloud exists.
    expect(result.sessionConfidence).toBeCloseTo(0.5667, 3)
    expect(result.tier).toBe('local')
    expect(result.escalated).toBe(false)
    expect(result.warnings.some((w) => w.includes('no cloud tier is configured'))).toBe(true)
  })

  it('returns tier none for a missing transcript', async () => {
    const result = await runFuzzyExtraction({ llm: throwingLlm, transcript: null })
    expect(result.tier).toBe('none')
    expect(result.sessionConfidence).toBeNull()
  })
})

describe('runFuzzyExtraction — §20 escalation gates', () => {
  it('gate A: an oversized transcript escalates wholesale — the local tier never runs', async () => {
    const cloud = new FakeCloudBrain({
      components: '[{"name": "flight api gateway", "type": "service", "confidence": 0.95}]',
      preferences: '[]',
      corrections: '[]'
    })
    const result = await runFuzzyExtraction({
      llm: throwingLlm,
      cloud: { brain: cloud, meter, taskId: 'task-gate-a' },
      transcript: digestOf('User: short text standing in for a huge session', 70_000)
    })
    expect(result.tier).toBe('cloud')
    expect(result.escalated).toBe(true)
    expect(result.escalationReason).toBe('transcript-tokens')
    expect(result.sessionConfidence).toBeNull() // local never ran
    expect(result.components[0]?.name).toBe('flight api gateway')
    expect(meter.taskSpendUsd('task-gate-a')).toBeGreaterThan(0)
  })

  it('gate A without a cloud tier: extracts locally in chunks with a warning', async () => {
    const llm = queueLlm({ components: ['[{"name": "solo unit", "type": "module", "confidence": 0.9}]'] })
    const result = await runFuzzyExtraction({
      llm,
      transcript: digestOf('User: pretend this is enormous', 70_000)
    })
    expect(result.tier).toBe('local')
    expect(result.components[0]?.name).toBe('solo unit')
    expect(result.warnings.some((w) => w.includes('no cloud tier is configured'))).toBe(true)
  })

  it('gate B: low local confidence escalates the whole session and the cloud result replaces the local one', async () => {
    const llm = queueLlm({
      components: ['[{"name": "hazy thing", "type": "module", "confidence": 0.3}]'],
      preferences: ['[{"statement": "maybe tabs", "confidence": 0.3}]'],
      corrections: ['[{"content": "perhaps stop", "confidence": 0.3}]']
    })
    const cloud = new FakeCloudBrain({
      components: '[{"name": "billing pipeline", "type": "service", "confidence": 0.92}]',
      preferences: '[]',
      corrections: '[]'
    })
    const result = await runFuzzyExtraction({
      llm,
      cloud: { brain: cloud, meter, taskId: 'task-gate-b' },
      transcript: digestOf('User: something ambiguous happened')
    })
    expect(result.escalated).toBe(true)
    expect(result.escalationReason).toBe('low-local-confidence')
    expect(result.tier).toBe('cloud')
    expect(result.sessionConfidence).toBeCloseTo(0.3, 5)
    expect(result.components.map((c) => c.name)).toEqual(['billing pipeline'])
    expect(result.preferences).toHaveLength(0)
  })

  it('degrades to the local extraction when every cloud escalation call fails', async () => {
    const llm = queueLlm({
      components: ['[{"name": "kept local unit", "type": "module", "confidence": 0.4}]'],
      preferences: ['[{"statement": "kept local pref", "confidence": 0.4}]'],
      corrections: ['[{"content": "kept local correction", "confidence": 0.4}]']
    })
    const cloud = new FakeCloudBrain({}, { failAll: true })
    const result = await runFuzzyExtraction({
      llm,
      cloud: { brain: cloud, meter, taskId: 'task-cloud-down' },
      transcript: digestOf('User: cloud is down today')
    })
    expect(result.tier).toBe('local')
    expect(result.escalated).toBe(false)
    expect(result.components[0]?.name).toBe('kept local unit')
    expect(result.warnings.some((w) => w.includes('cloud escalation failed on every call'))).toBe(true)
  })
})

describe('runFuzzyExtraction — P0.1: all-calls-failed is LOUD (MCP-COVERAGE §9.5, phase 14)', () => {
  /** Every model call rejects — the "Ollama daemon died / auth expired" shape. */
  const deadLlm: ExtractionLlm = {
    generate: () => Promise.reject(new Error('ollama daemon unreachable'))
  }

  it('throws ExtractionUnavailableError when every local call fails and no cloud tier exists', async () => {
    await expect(runFuzzyExtraction({ llm: deadLlm, transcript: digestOf('User: hello') })).rejects.toThrow(
      ExtractionUnavailableError
    )
    await expect(runFuzzyExtraction({ llm: deadLlm, transcript: digestOf('User: hello') })).rejects.toThrow(
      /all 3 local fuzzy-pass calls failed and no cloud tier is configured/
    )
  })

  it('throws when the cloud escalation ALSO fails on every call (both tiers down)', async () => {
    const cloud = new FakeCloudBrain({}, { failAll: true })
    const promise = runFuzzyExtraction({
      llm: deadLlm,
      cloud: { brain: cloud, meter, taskId: 'task-p01-both-down' },
      transcript: digestOf('User: everything is down')
    })
    await expect(promise).rejects.toThrow(ExtractionUnavailableError)
    await expect(
      runFuzzyExtraction({
        llm: deadLlm,
        cloud: { brain: new FakeCloudBrain({}, { failAll: true }), meter, taskId: 'task-p01-both-down' },
        transcript: digestOf('User: everything is down')
      })
    ).rejects.toThrow(/cloud escalation failed on every call/)
  })

  it('does NOT throw when the cloud rescue works — the throw sits AFTER gate B (placement guard)', async () => {
    const cloud = new FakeCloudBrain({
      components: '[{"name": "rescued unit", "type": "module", "confidence": 0.9}]',
      preferences: '[]',
      corrections: '[]'
    })
    const result = await runFuzzyExtraction({
      llm: deadLlm,
      cloud: { brain: cloud, meter, taskId: 'task-p01-rescued' },
      transcript: digestOf('User: local model is down, cloud is fine')
    })
    expect(result.tier).toBe('cloud')
    expect(result.escalated).toBe(true)
    expect(result.escalationReason).toBe('low-local-confidence')
    expect(result.components[0]?.name).toBe('rescued unit')
  })

  it('an empty transcript still skips quietly — totalCalls === 0 means nothing was asked of a model', async () => {
    const blank = await runFuzzyExtraction({ llm: deadLlm, transcript: digestOf('   ') })
    expect(blank.tier).toBe('none')
    const missing = await runFuzzyExtraction({ llm: deadLlm, transcript: null })
    expect(missing.tier).toBe('none')
  })

  it('partial local success never throws: some calls surviving means the run learned something', async () => {
    let call = 0
    const flaky: ExtractionLlm = {
      generate: (_prompt, options) => {
        call += 1
        // The components pass succeeds; preferences/corrections passes die.
        if ((options?.system ?? '').includes('extract software components')) {
          return Promise.resolve({ text: '[{"name": "survivor", "type": "module", "confidence": 0.9}]' })
        }
        return Promise.reject(new Error(`daemon flaked on call ${call}`))
      }
    }
    const result = await runFuzzyExtraction({ llm: flaky, transcript: digestOf('User: partial outage') })
    expect(result.tier).toBe('local')
    expect(result.components[0]?.name).toBe('survivor')
    expect(result.warnings.length).toBeGreaterThan(0)
  })

  it('is an ExtractionError subclass whose name/code can NEVER match the NOT_FOUND quiet path', async () => {
    // isNothingToExtract (triggers/sessionEnd.ts) swallows only
    // name === 'ExtractionError' && code === 'NOT_FOUND' — both differ here,
    // so the session-end handler rethrows and the queue retries.
    const err: unknown = await runFuzzyExtraction({ llm: deadLlm, transcript: digestOf('User: hi') }).catch(
      (e: unknown) => e
    )
    expect(err).toBeInstanceOf(ExtractionUnavailableError)
    expect(err).toBeInstanceOf(ExtractionError)
    expect((err as ExtractionUnavailableError).name).toBe('ExtractionUnavailableError')
    expect((err as ExtractionUnavailableError).code).toBe('UNAVAILABLE')
  })
})
