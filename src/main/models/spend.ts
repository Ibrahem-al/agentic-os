/**
 * SpendMeter (§14): per-call cost from a static price table → the `spend`
 * table in appdata.db; `checkBudget(taskId)` throws once a task's recorded
 * spend reaches its ceiling ($0.50 default, per-task override — §20), which
 * is what halts a runaway loop (§15).
 *
 * Cost precedence per call: provider-reported cost (OpenRouter returns
 * usage.cost in USD) → static price table → conservative fallback. The
 * fallback prices an unknown model at the most expensive known rate so a
 * mispriced model halts the budget EARLIER, never later.
 */
import type BetterSqlite3 from 'better-sqlite3'
import { SPEND_CEILING_USD_DEFAULT, type CloudProvider } from '../config'
import type { ChatMessage, CloudBrain, CompleteOptions, Completion } from './cloud'

export interface ModelPrice {
  /** USD per 1M input tokens. */
  inputUsdPerMTok: number
  /** USD per 1M output tokens. */
  outputUsdPerMTok: number
}

/**
 * Static price table, USD per million tokens, as of 2026-07-04.
 * Anthropic rows come from the Claude API reference (authoritative on that
 * date); OpenAI/Gemini rows from the providers' published pricing pages.
 * OpenRouter is intentionally absent: it reports actual cost per call
 * (usage.cost), which the meter prefers over any table.
 */
export const PRICE_TABLE: Readonly<Partial<Record<CloudProvider, Readonly<Record<string, ModelPrice>>>>> = {
  anthropic: {
    'claude-fable-5': { inputUsdPerMTok: 10, outputUsdPerMTok: 50 },
    'claude-opus-4-8': { inputUsdPerMTok: 5, outputUsdPerMTok: 25 },
    'claude-opus-4-7': { inputUsdPerMTok: 5, outputUsdPerMTok: 25 },
    'claude-opus-4-6': { inputUsdPerMTok: 5, outputUsdPerMTok: 25 },
    'claude-sonnet-5': { inputUsdPerMTok: 3, outputUsdPerMTok: 15 },
    'claude-sonnet-4-6': { inputUsdPerMTok: 3, outputUsdPerMTok: 15 },
    'claude-haiku-4-5': { inputUsdPerMTok: 1, outputUsdPerMTok: 5 }
  },
  openai: {
    'gpt-5.5': { inputUsdPerMTok: 5, outputUsdPerMTok: 30 },
    'gpt-5.4': { inputUsdPerMTok: 2.5, outputUsdPerMTok: 15 },
    'gpt-4.1-nano': { inputUsdPerMTok: 0.1, outputUsdPerMTok: 0.4 }
  },
  gemini: {
    'gemini-2.5-pro': { inputUsdPerMTok: 1.25, outputUsdPerMTok: 10 },
    'gemini-2.5-flash': { inputUsdPerMTok: 0.3, outputUsdPerMTok: 2.5 }
  }
}

/**
 * Unknown model → assume the most expensive rate in the table. Overestimating
 * halts the budget sooner; underestimating would let a task overspend.
 */
export const FALLBACK_PRICE: ModelPrice = { inputUsdPerMTok: 10, outputUsdPerMTok: 50 }

export function priceFor(provider: CloudProvider, model: string): { price: ModelPrice; estimated: boolean } {
  const price = PRICE_TABLE[provider]?.[model]
  return price ? { price, estimated: false } : { price: FALLBACK_PRICE, estimated: true }
}

export interface SpendRecord {
  taskId: string
  provider: CloudProvider
  model: string
  inputTokens: number
  outputTokens: number
  /** Provider-reported actual cost (USD); overrides the price table. */
  reportedCostUsd?: number
}

export class SpendCeilingExceededError extends Error {
  constructor(
    readonly taskId: string,
    readonly spentUsd: number,
    readonly ceilingUsd: number
  ) {
    super(
      `task ${taskId} has spent $${spentUsd.toFixed(4)}, at/over its ceiling of $${ceilingUsd.toFixed(2)} — halting (§14/§15)`
    )
    this.name = 'SpendCeilingExceededError'
  }
}

interface SpendMeterOptions {
  db: BetterSqlite3.Database
  /** Default per-task ceiling; §20 says $0.50 with per-task override. */
  defaultCeilingUsd?: number
}

export class SpendMeter {
  private readonly db: BetterSqlite3.Database
  readonly defaultCeilingUsd: number

  constructor(options: SpendMeterOptions) {
    this.db = options.db
    this.defaultCeilingUsd = options.defaultCeilingUsd ?? SPEND_CEILING_USD_DEFAULT
  }

  /** Compute the call's USD cost and append it to the spend table. */
  record(entry: SpendRecord): { usd: number; estimated: boolean } {
    let usd: number
    let estimated = false
    if (entry.reportedCostUsd !== undefined) {
      usd = entry.reportedCostUsd
    } else {
      const { price, estimated: est } = priceFor(entry.provider, entry.model)
      estimated = est
      usd = (entry.inputTokens * price.inputUsdPerMTok + entry.outputTokens * price.outputUsdPerMTok) / 1_000_000
    }
    this.db
      .prepare(
        `INSERT INTO spend (task_id, provider, model, input_tokens, output_tokens, usd) VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(entry.taskId, entry.provider, entry.model, entry.inputTokens, entry.outputTokens, usd)
    return { usd, estimated }
  }

  /** Total recorded spend for one task (USD). */
  taskSpendUsd(taskId: string): number {
    const row = this.db.prepare(`SELECT COALESCE(SUM(usd), 0) AS total FROM spend WHERE task_id = ?`).get(taskId) as {
      total: number
    }
    return row.total
  }

  /** Running total across all tasks — the dashboard's live spend display (§14). */
  totalSpendUsd(): number {
    const row = this.db.prepare(`SELECT COALESCE(SUM(usd), 0) AS total FROM spend`).get() as { total: number }
    return row.total
  }

  /** Throws SpendCeilingExceededError when the task's spend is at/over its ceiling. */
  checkBudget(taskId: string, ceilingUsdOverride?: number): void {
    const ceiling = ceilingUsdOverride ?? this.defaultCeilingUsd
    const spent = this.taskSpendUsd(taskId)
    if (spent >= ceiling) throw new SpendCeilingExceededError(taskId, spent, ceiling)
  }
}

/**
 * Budget-gated completion: the shape background agents use. Checks the
 * ceiling BEFORE spending, records cost after — so a loop calling this halts
 * with SpendCeilingExceededError on the first call past the ceiling.
 */
export async function meteredComplete(
  brain: CloudBrain,
  meter: SpendMeter,
  taskId: string,
  messages: ChatMessage[],
  options?: CompleteOptions & { ceilingUsd?: number }
): Promise<Completion> {
  meter.checkBudget(taskId, options?.ceilingUsd)
  const completion = await brain.complete(messages, options)
  meter.record({
    taskId,
    provider: brain.provider,
    model: completion.model,
    inputTokens: completion.usage.inputTokens,
    outputTokens: completion.usage.outputTokens,
    reportedCostUsd: completion.reportedCostUsd
  })
  return completion
}
