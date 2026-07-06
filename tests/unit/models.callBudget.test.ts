/**
 * CallBudget (phase 14; MCP-COVERAGE §9.3 / P0.2) — the $-ceiling replacement
 * for subscription runs: counts DURABLE runner_runs rows per task (resume
 * keeps consumed budget), throws a SpendCeilingExceededError-compatible
 * error at the ceiling (the extraction verifier's `instanceof` seam works
 * with zero edits), satisfies retrieval's BudgetGuard structurally, and sums
 * the trailing 5-hour token window for the P0.8 quota self-throttle.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { RUNNER_TASK_MAX_CALLS, RUNNER_WINDOW_MS } from '../../src/main/config'
import {
  CallBudget,
  CallBudgetExceededError,
  RunnerQuotaError,
  SpendCeilingExceededError
} from '../../src/main/models'
import type { BudgetGuard } from '../../src/main/retrieval'
import { openAppData, type AppData } from '../../src/main/storage'

let dir: string
let appData: AppData
let runSeq = 0

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'agentic-os-callbudget-'))
  appData = openAppData(join(dir, 'appdata.db'))
})

afterEach(() => {
  appData.close()
  rmSync(dir, { recursive: true, force: true })
})

/** One runner_runs row — mode/text values are arbitrary valid shapes. */
function insertRun(taskId: string, startedAtMs: number, tokens: { input?: number; output?: number } = {}): void {
  appData.db
    .prepare(
      `INSERT INTO runner_runs (id, task_id, mode, started_at, input_tokens, output_tokens)
       VALUES (?, ?, 'completion', ?, ?, ?)`
    )
    .run(
      `run-${runSeq++}`,
      taskId,
      new Date(startedAtMs).toISOString(),
      tokens.input ?? null,
      tokens.output ?? null
    )
}

describe('CallBudget (the durable call ledger over runner_runs)', () => {
  it('callsUsed counts rows per task — zero for unknown tasks, isolated between tasks', () => {
    const budget = new CallBudget({ db: appData.db })
    expect(budget.callsUsed('task-a')).toBe(0)
    insertRun('task-a', Date.now())
    insertRun('task-a', Date.now())
    insertRun('task-b', Date.now())
    expect(budget.callsUsed('task-a')).toBe(2)
    expect(budget.callsUsed('task-b')).toBe(1)
    expect(budget.callsUsed('never-ran')).toBe(0)
  })

  it('checkBudget passes under the ceiling and throws AT it (>= semantics, like SpendMeter)', () => {
    const budget = new CallBudget({ db: appData.db })
    insertRun('task-c', Date.now())
    expect(() => budget.checkBudget('task-c', 2)).not.toThrow()
    insertRun('task-c', Date.now())
    expect(() => budget.checkBudget('task-c', 2)).toThrow(CallBudgetExceededError)
    expect(() => budget.checkBudget('task-c', 2)).toThrow(/2 runner calls, at\/over its ceiling of 2/)
  })

  it('defaults the ceiling to RUNNER_TASK_MAX_CALLS', () => {
    const budget = new CallBudget({ db: appData.db })
    for (let i = 0; i < RUNNER_TASK_MAX_CALLS - 1; i++) insertRun('task-d', Date.now())
    expect(() => budget.checkBudget('task-d')).not.toThrow()
    insertRun('task-d', Date.now())
    expect(() => budget.checkBudget('task-d')).toThrow(CallBudgetExceededError)
  })

  it('the error IS a SpendCeilingExceededError — existing catch sites (verify.ts) work unchanged', () => {
    const budget = new CallBudget({ db: appData.db })
    insertRun('task-e', Date.now())
    let caught: unknown
    try {
      budget.checkBudget('task-e', 1)
    } catch (err) {
      caught = err
    }
    expect(caught).toBeInstanceOf(CallBudgetExceededError)
    expect(caught).toBeInstanceOf(SpendCeilingExceededError) // the load-bearing seam
    expect(caught).toBeInstanceOf(Error)
    const err = caught as CallBudgetExceededError
    expect(err.name).toBe('CallBudgetExceededError')
    // Honest named fields alongside the parent's positional slots.
    expect(err.taskId).toBe('task-e')
    expect(err.calls).toBe(1)
    expect(err.ceilingCalls).toBe(1)
    expect(err.message).toContain('runner call')
    expect(err.message).not.toContain('$') // it talks calls, not dollars
  })

  it('structurally satisfies BudgetGuard (drops into RetrieveOptions.spendMeter)', () => {
    // Compile-time pin: assignment fails typecheck if the shape drifts.
    const guard: BudgetGuard = new CallBudget({ db: appData.db })
    expect(() => guard.checkBudget('anything')).not.toThrow()
    insertRun('task-guard', Date.now())
    expect(() => guard.checkBudget('task-guard', 1)).toThrow(SpendCeilingExceededError)
  })

  it('is durable by construction: a fresh instance over the same db sees the consumed budget (resume story)', () => {
    insertRun('task-resume', Date.now())
    insertRun('task-resume', Date.now())
    const before = new CallBudget({ db: appData.db })
    expect(before.callsUsed('task-resume')).toBe(2)
    // "Crash": throw the instance away; a resumed workflow builds a new one.
    const after = new CallBudget({ db: appData.db })
    expect(after.callsUsed('task-resume')).toBe(2)
    expect(() => after.checkBudget('task-resume', 2)).toThrow(CallBudgetExceededError)
  })

  it('windowUsage sums tokens over the trailing RUNNER_WINDOW_MS only', () => {
    const budget = new CallBudget({ db: appData.db })
    const now = Date.parse('2026-07-05T12:00:00.000Z')
    // An empty ledger reads zeros, not NULLs (COALESCE).
    expect(budget.windowUsage(now)).toEqual({ inputTokens: 0, outputTokens: 0 })
    insertRun('w1', now - 60 * 60_000, { input: 100, output: 20 }) // 1h ago — in window
    insertRun('w2', now - 2 * 60 * 60_000, { input: 30, output: 5 }) // 2h ago — in window
    insertRun('w3', now - RUNNER_WINDOW_MS, { input: 7, output: 3 }) // exactly at the cutoff — included (>=)
    insertRun('w4', now - RUNNER_WINDOW_MS - 1000, { input: 999, output: 999 }) // outside — excluded
    insertRun('w5', now - 30 * 60_000) // in window, NULL tokens — contributes nothing
    expect(budget.windowUsage(now)).toEqual({ inputTokens: 137, outputTokens: 28 })
  })

  it('RunnerQuotaError is an ordinary named Error (shared import for FP-3)', () => {
    const err = new RunnerQuotaError('window exhausted; resets at 14:00')
    expect(err).toBeInstanceOf(Error)
    expect(err.name).toBe('RunnerQuotaError')
    expect(err.message).toContain('window exhausted')
  })
})
