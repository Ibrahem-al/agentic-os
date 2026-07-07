/**
 * CallBudget — the per-task budget guard for the subscription-runner path
 * (phase 14; MCP-COVERAGE §9.3 / P0.2). Subscription completions produce no
 * `spend` rows (there is no per-call dollar price), so every existing
 * §14 $-ceiling seam is silently dead on that path; the replacement meters
 * CALLS instead. It reads `runner_runs` — the durable ledger with one row per
 * spawned `claude -p` — NOT an in-memory counter: a resumed workflow keeps
 * its consumed budget across crashes exactly the way SpendMeter.taskSpendUsd
 * reads the durable `spend` table, where a memory counter would reset on
 * every resume and quietly double the real ceiling.
 *
 * `CallBudgetExceededError extends SpendCeilingExceededError` deliberately
 * (rule-12 decision, recorded in the phase-14 report): every existing
 * `instanceof SpendCeilingExceededError` catch site — e.g. the extraction
 * verifier's budget halt (extraction/verify.ts) — then handles the
 * call-ceiling halt with zero edits. The parent's positional numeric slots
 * carry callsUsed/ceilingCalls (their only consumer is the message, which is
 * overridden to say "calls"); the honest named fields live alongside.
 */
import type BetterSqlite3 from 'better-sqlite3'
import { RUNNER_TASK_MAX_CALLS, RUNNER_WINDOW_MS } from '../config'
import { SpendCeilingExceededError } from './spend'

export class CallBudgetExceededError extends SpendCeilingExceededError {
  /** Honest names for the values riding the parent's numeric slots. */
  readonly calls: number
  readonly ceilingCalls: number

  constructor(taskId: string, callsUsed: number, ceilingCalls: number) {
    super(taskId, callsUsed, ceilingCalls)
    this.name = 'CallBudgetExceededError'
    this.message = `task ${taskId} has used ${callsUsed} runner call${callsUsed === 1 ? '' : 's'}, at/over its ceiling of ${ceilingCalls} — halting (§14/§15; MCP-COVERAGE §9.3)`
    this.calls = callsUsed
    this.ceilingCalls = ceilingCalls
  }
}

/**
 * The subscription's rolling-window quota refused new work (P0.8). Thrown by
 * the FP-3 runner health module; the class lives here so callers and the
 * queue's failure taxonomy share one import before that module exists.
 */
export class RunnerQuotaError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'RunnerQuotaError'
  }
}

interface CallBudgetOptions {
  db: BetterSqlite3.Database
}

export class CallBudget {
  private readonly countCalls: BetterSqlite3.Statement
  private readonly sumWindow: BetterSqlite3.Statement

  constructor(options: CallBudgetOptions) {
    this.countCalls = options.db.prepare(`SELECT count(*) AS c FROM runner_runs WHERE task_id = ?`)
    this.sumWindow = options.db.prepare(
      `SELECT COALESCE(SUM(input_tokens), 0) AS i, COALESCE(SUM(output_tokens), 0) AS o
       FROM runner_runs
       WHERE started_at >= ?`
    )
  }

  /** Runner calls recorded for one task — durable across crash/resume by construction. */
  callsUsed(taskId: string): number {
    const row = this.countCalls.get(taskId) as { c: number }
    return row.c
  }

  /**
   * Throws CallBudgetExceededError once the task's recorded calls reach the
   * ceiling. Structurally satisfies retrieval's BudgetGuard
   * (`checkBudget(taskId, ceilingOverride?)`), so a CallBudget drops into
   * `RetrieveOptions.spendMeter` and the meteredComplete seam unchanged —
   * with the override meaning a CALL count here, not USD.
   */
  checkBudget(taskId: string, ceilingCalls: number = RUNNER_TASK_MAX_CALLS): void {
    const used = this.callsUsed(taskId)
    if (used >= ceilingCalls) throw new CallBudgetExceededError(taskId, used, ceilingCalls)
  }

  /**
   * Token totals over the trailing RUNNER_WINDOW_MS (the subscription's
   * 5-hour rolling window) — the FP-3 quota self-throttle (P0.8) compares
   * this against RUNNER_WINDOW_TOKEN_BUDGET × RUNNER_QUOTA_FRACTION.
   * `started_at` values are ISO-8601 UTC stamps (Date.toISOString — what the
   * runner writes), so the lexicographic >= is a real time comparison.
   */
  windowUsage(nowMs: number): { inputTokens: number; outputTokens: number } {
    const cutoff = new Date(nowMs - RUNNER_WINDOW_MS).toISOString()
    const row = this.sumWindow.get(cutoff) as { i: number; o: number }
    return { inputTokens: row.i, outputTokens: row.o }
  }
}
