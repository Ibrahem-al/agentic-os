/**
 * §8 cooperative yield — "live MCP session (user waiting) is prioritized;
 * background work yields; no mid-generation preemption — scheduling at step
 * boundaries". The task queue applies this BETWEEN tasks (pre-dispatch, see
 * triggers/queue.ts); this factory produces the yield point the
 * LangGraphRunner awaits BETWEEN workflow steps, so a running multi-step job
 * (extraction = 6 steps, skill-improvement = 5) also gives way to a live
 * session instead of holding the machine for the whole run.
 *
 * Same constants and cap semantics as the queue's pre-dispatch yield:
 * re-check every TASK_YIELD_RECHECK_MS while live work is in flight, and give
 * up waiting after TASK_YIELD_MAX_MS total (§8 aging applied to the yield —
 * background work must never starve outright).
 */
import { TASK_YIELD_MAX_MS, TASK_YIELD_RECHECK_MS } from '../config'

export interface InflightYieldOptions {
  /** Re-check cadence while live work is in flight (default TASK_YIELD_RECHECK_MS). */
  readonly recheckMs?: number
  /** Max total wait per yield point before proceeding anyway (default TASK_YIELD_MAX_MS). */
  readonly maxWaitMs?: number
  /** Injectable sleep for tests (default real setTimeout). */
  readonly sleep?: (ms: number) => Promise<void>
}

const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Build a yield point over a live-work gauge (in production the MCP server's
 * `inflightCalls` counter). The returned function resolves immediately when
 * nothing is in flight; otherwise it polls until the live work drains or the
 * cap elapses — it never throws and never blocks forever.
 */
export function createInflightYield(
  getInflight: () => number,
  opts: InflightYieldOptions = {}
): () => Promise<void> {
  const recheckMs = opts.recheckMs ?? TASK_YIELD_RECHECK_MS
  const maxWaitMs = opts.maxWaitMs ?? TASK_YIELD_MAX_MS
  const sleep = opts.sleep ?? defaultSleep
  return async (): Promise<void> => {
    // Counted wait, same accounting as the queue's yieldedMs: accumulate one
    // recheck interval per sleep and proceed once the cap is reached.
    let waitedMs = 0
    while (getInflight() > 0 && waitedMs < maxWaitMs) {
      await sleep(recheckMs)
      waitedMs += recheckMs
    }
  }
}
