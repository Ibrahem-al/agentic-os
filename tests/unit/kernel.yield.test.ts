/**
 * createInflightYield unit tests (§8 cooperative yield at step boundaries):
 * immediate pass when nothing is in flight, re-checks while live MCP work is
 * in flight, and the TASK_YIELD_MAX_MS cap — §8 aging applied to the yield,
 * background work never starves. Sleep is injected, so no real timers.
 */
import { describe, expect, it } from 'vitest'
import { TASK_YIELD_MAX_MS, TASK_YIELD_RECHECK_MS } from '../../src/main/config'
import { createInflightYield } from '../../src/main/kernel'

/** Instant sleep that records every requested duration. */
function recordingSleep(onSleep?: (count: number) => void): { sleeps: number[]; sleep: (ms: number) => Promise<void> } {
  const sleeps: number[] = []
  return {
    sleeps,
    sleep: (ms) => {
      sleeps.push(ms)
      onSleep?.(sleeps.length)
      return Promise.resolve()
    }
  }
}

describe('createInflightYield (§8)', () => {
  it('resolves immediately at 0 inflight — sleep never consulted', async () => {
    const { sleeps, sleep } = recordingSleep()
    const yieldPoint = createInflightYield(() => 0, { sleep })
    await yieldPoint()
    expect(sleeps).toEqual([])
  })

  it('re-checks every recheckMs while inflight > 0, then proceeds when it drops', async () => {
    let inflight = 2
    const { sleeps, sleep } = recordingSleep((count) => {
      if (count === 3) inflight = 0 // live session drains during the 3rd wait
    })
    const yieldPoint = createInflightYield(() => inflight, { recheckMs: 10, maxWaitMs: 1000, sleep })
    await yieldPoint()
    expect(sleeps).toEqual([10, 10, 10]) // resolved on the drain, well under the cap
  })

  it('gives up after maxWaitMs total even if live work never drains (aging cap)', async () => {
    const { sleeps, sleep } = recordingSleep()
    const yieldPoint = createInflightYield(() => 1, { recheckMs: 10, maxWaitMs: 30, sleep })
    await yieldPoint()
    expect(sleeps).toEqual([10, 10, 10]) // 3 × 10 ms = the cap, then proceed anyway
  })

  it('applies the cap per invocation — every step boundary gets a fresh wait budget', async () => {
    const { sleeps, sleep } = recordingSleep()
    const yieldPoint = createInflightYield(() => 1, { recheckMs: 10, maxWaitMs: 20, sleep })
    await yieldPoint()
    await yieldPoint()
    expect(sleeps).toEqual([10, 10, 10, 10]) // 2 waits each, not one shared budget
  })

  it('defaults to the queue constants: TASK_YIELD_RECHECK_MS cadence, TASK_YIELD_MAX_MS cap', async () => {
    const { sleeps, sleep } = recordingSleep()
    const yieldPoint = createInflightYield(() => 1, { sleep })
    await yieldPoint()
    expect(sleeps).toHaveLength(TASK_YIELD_MAX_MS / TASK_YIELD_RECHECK_MS)
    expect(sleeps.every((ms) => ms === TASK_YIELD_RECHECK_MS)).toBe(true)
  })
})
