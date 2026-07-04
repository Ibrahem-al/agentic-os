/**
 * SpendMeter unit tests over the REAL appdata.db spend table (temp file):
 * price-table math, provider-reported cost, conservative unknown-model
 * fallback, and the §14/§15 ceiling halting a simulated task loop.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { SPEND_CEILING_USD_DEFAULT } from '../../src/main/config'
import { openAppData, type AppData } from '../../src/main/storage'
import {
  FALLBACK_PRICE,
  SpendCeilingExceededError,
  SpendMeter,
  meteredComplete,
  priceFor,
  type ChatMessage,
  type CloudBrain,
  type Completion
} from '../../src/main/models'

let dir: string
let appData: AppData

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'agentic-os-spend-'))
  appData = openAppData(join(dir, 'appdata.db'))
})

afterEach(() => {
  appData.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('price table', () => {
  it('prices known models exactly', () => {
    expect(priceFor('anthropic', 'claude-opus-4-8')).toEqual({
      price: { inputUsdPerMTok: 5, outputUsdPerMTok: 25 },
      estimated: false
    })
    expect(priceFor('openai', 'gpt-5.5').price.outputUsdPerMTok).toBe(30)
  })

  it('falls back to the MOST EXPENSIVE rate for unknown models (halt early, never late)', () => {
    const { price, estimated } = priceFor('anthropic', 'claude-totally-new-model')
    expect(estimated).toBe(true)
    expect(price).toEqual(FALLBACK_PRICE)
    expect(price.inputUsdPerMTok).toBe(10)
    expect(price.outputUsdPerMTok).toBe(50)
  })
})

describe('SpendMeter.record', () => {
  it('computes cost from the table and writes a spend row', () => {
    const meter = new SpendMeter({ db: appData.db })
    // 1M in + 1M out on opus-4-8 = $5 + $25 = $30
    const { usd, estimated } = meter.record({
      taskId: 'task-1',
      provider: 'anthropic',
      model: 'claude-opus-4-8',
      inputTokens: 1_000_000,
      outputTokens: 1_000_000
    })
    expect(usd).toBe(30)
    expect(estimated).toBe(false)

    const row = appData.db.prepare('SELECT * FROM spend WHERE task_id = ?').get('task-1') as Record<string, unknown>
    expect(row).toMatchObject({
      task_id: 'task-1',
      provider: 'anthropic',
      model: 'claude-opus-4-8',
      input_tokens: 1_000_000,
      output_tokens: 1_000_000,
      usd: 30
    })
  })

  it('prefers the provider-reported cost (OpenRouter) over the table', () => {
    const meter = new SpendMeter({ db: appData.db })
    const { usd, estimated } = meter.record({
      taskId: 'task-or',
      provider: 'openrouter',
      model: 'openai/gpt-5.5',
      inputTokens: 1000,
      outputTokens: 100,
      reportedCostUsd: 0.0123
    })
    expect(usd).toBe(0.0123)
    expect(estimated).toBe(false)
  })

  it('flags unknown-model costs as estimated (conservative fallback rate)', () => {
    const meter = new SpendMeter({ db: appData.db })
    const { usd, estimated } = meter.record({
      taskId: 'task-x',
      provider: 'gemini',
      model: 'gemini-99-ultra',
      inputTokens: 100_000,
      outputTokens: 10_000
    })
    expect(estimated).toBe(true)
    expect(usd).toBeCloseTo((100_000 * 10 + 10_000 * 50) / 1_000_000, 10) // $1.50
  })

  it('sums per-task and total spend independently', () => {
    const meter = new SpendMeter({ db: appData.db })
    meter.record({ taskId: 'a', provider: 'anthropic', model: 'claude-haiku-4-5', inputTokens: 1_000_000, outputTokens: 0 }) // $1
    meter.record({ taskId: 'a', provider: 'anthropic', model: 'claude-haiku-4-5', inputTokens: 0, outputTokens: 1_000_000 }) // $5
    meter.record({ taskId: 'b', provider: 'anthropic', model: 'claude-haiku-4-5', inputTokens: 2_000_000, outputTokens: 0 }) // $2
    expect(meter.taskSpendUsd('a')).toBeCloseTo(6, 10)
    expect(meter.taskSpendUsd('b')).toBeCloseTo(2, 10)
    expect(meter.taskSpendUsd('missing')).toBe(0)
    expect(meter.totalSpendUsd()).toBeCloseTo(8, 10)
  })
})

describe('checkBudget — the §14/§15 halt', () => {
  it('passes under the ceiling, throws at/over it', () => {
    const meter = new SpendMeter({ db: appData.db })
    meter.record({ taskId: 't', provider: 'anthropic', model: 'claude-opus-4-8', inputTokens: 40_000, outputTokens: 8_000 }) // $0.40
    expect(() => meter.checkBudget('t')).not.toThrow()
    meter.record({ taskId: 't', provider: 'anthropic', model: 'claude-opus-4-8', inputTokens: 20_000, outputTokens: 0 }) // +$0.10 → $0.50
    expect(() => meter.checkBudget('t')).toThrow(SpendCeilingExceededError)
  })

  it('honors the per-task ceiling override (§20)', () => {
    const meter = new SpendMeter({ db: appData.db })
    meter.record({ taskId: 't', provider: 'anthropic', model: 'claude-opus-4-8', inputTokens: 40_000, outputTokens: 8_000 }) // $0.40
    expect(() => meter.checkBudget('t', 0.25)).toThrow(SpendCeilingExceededError)
    expect(() => meter.checkBudget('t', 2.0)).not.toThrow()
  })

  it('defaults to the §20 ceiling of $0.50', () => {
    expect(new SpendMeter({ db: appData.db }).defaultCeilingUsd).toBe(SPEND_CEILING_USD_DEFAULT)
    expect(SPEND_CEILING_USD_DEFAULT).toBe(0.5)
  })
})

describe('meteredComplete — ceiling halts a simulated task', () => {
  /** Fake brain: every call "costs" $0.15 on the price table (opus-4-8). */
  const fakeBrain: CloudBrain = {
    provider: 'anthropic',
    model: 'claude-opus-4-8',
    async complete(): Promise<Completion> {
      return {
        text: 'step done',
        model: 'claude-opus-4-8',
        usage: { inputTokens: 10_000, outputTokens: 4_000 }, // $0.05 + $0.10
        stopReason: 'end_turn'
      }
    }
  }
  const messages: ChatMessage[] = [{ role: 'user', content: 'work' }]

  it('halts the loop with SpendCeilingExceededError once spend reaches $0.50', async () => {
    const meter = new SpendMeter({ db: appData.db })
    let completions = 0
    let halted: unknown = null
    // A runaway background task: would loop 100 times without the meter.
    for (let i = 0; i < 100; i++) {
      try {
        await meteredComplete(fakeBrain, meter, 'runaway-task', messages)
        completions += 1
      } catch (err) {
        halted = err
        break
      }
    }
    // $0.15/call: 3 calls = $0.45 < $0.50 → 4th call allowed ($0.60), 5th blocked.
    expect(completions).toBe(4)
    expect(halted).toBeInstanceOf(SpendCeilingExceededError)
    expect((halted as SpendCeilingExceededError).spentUsd).toBeCloseTo(0.6, 10)
    // Every completed call left an audit row; the blocked one did not.
    const rows = appData.db.prepare('SELECT COUNT(*) AS n FROM spend').get() as { n: number }
    expect(rows.n).toBe(4)
  })

  it('checks the budget BEFORE spending (no call once over)', async () => {
    const meter = new SpendMeter({ db: appData.db })
    meter.record({ taskId: 't', provider: 'anthropic', model: 'claude-opus-4-8', inputTokens: 200_000, outputTokens: 0 }) // $1
    let brainCalled = false
    const spyBrain: CloudBrain = {
      ...fakeBrain,
      async complete() {
        brainCalled = true
        return fakeBrain.complete([], {})
      }
    }
    await expect(meteredComplete(spyBrain, meter, 't', messages)).rejects.toThrow(SpendCeilingExceededError)
    expect(brainCalled).toBe(false)
  })

  it('records OpenRouter-reported costs verbatim', async () => {
    const meter = new SpendMeter({ db: appData.db })
    const orBrain: CloudBrain = {
      provider: 'openrouter',
      model: 'openai/gpt-5.5',
      async complete(): Promise<Completion> {
        return {
          text: 'ok',
          model: 'openai/gpt-5.5',
          usage: { inputTokens: 100, outputTokens: 10 },
          stopReason: 'stop',
          reportedCostUsd: 0.002
        }
      }
    }
    await meteredComplete(orBrain, meter, 'or-task', messages)
    expect(meter.taskSpendUsd('or-task')).toBe(0.002)
  })
})
