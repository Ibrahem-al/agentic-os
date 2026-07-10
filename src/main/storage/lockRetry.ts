/**
 * Boot-time lock-contention retry for the graph store (fix/stack-reconnect).
 *
 * A user relaunching the app while the previous process is still quitting can
 * hit a transient overlap: will-quit checkpoints the graph before it exits, and
 * for that window RyuGraph still holds the exclusive OS lock on
 * `<graphDir>/graph.ryugraph`. Opening then fails with a lock-contention error
 * (isLockContentionError — probe-verified "IO exception: Could not set lock on
 * file"). WITHOUT a retry that single transient loses storage for the whole
 * launch and, via the boot cascade, bricks MCP + agents + triggers.
 *
 * The single-instance lock (main/index.ts) rules out a genuine second live
 * instance, so the only lock we ever contend is a previous process releasing —
 * which a short backoff (~10 s total) reliably outlasts. This lives OUTSIDE the
 * RyuGraphEngine class (kept clean) and above openRyuGraphEngine: any error that
 * is NOT lock contention (corrupt-WAL recovery already ran inside open(); a
 * schema-newer refusal; a missing extension; a corrupt main db) surfaces at once
 * and is never masked by the loop.
 */
import { isLockContentionError, openRyuGraphEngine, type RyuGraphEngine, type RyuGraphEngineOptions } from './ryugraph'

/**
 * Backoff schedule (ms) between lock-contention open retries: 0.5/1/2/3/3.5 s =
 * ~10 s total across 5 retries (6 open attempts). Sized to comfortably outlast a
 * slow checkpoint-on-quit without hanging the reconnect UI.
 */
export const DEFAULT_LOCK_RETRY_DELAYS_MS: readonly number[] = [500, 1000, 2000, 3000, 3500]

export interface LockRetryHooks {
  /** Backoff schedule; one entry per retry (open attempts = delaysMs.length + 1). */
  readonly delaysMs?: readonly number[]
  /** Per-attempt log sink (boot passes console.warn under a [storage] tag). */
  readonly log?: (message: string) => void
  /** Injectable sleep so unit tests run instantly with a no-op. */
  readonly sleep?: (ms: number) => Promise<void>
}

const realSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Run `open` and, ONLY on a lock-contention failure, retry it on the given
 * backoff. The first non-lock error, or a lock error after the last attempt,
 * throws. Generic in the opened value so it is unit-testable with a fake opener
 * (the real path is openRyuGraphEngineWithLockRetry below).
 */
export async function retryOnLockContention<T>(open: () => Promise<T>, hooks: LockRetryHooks = {}): Promise<T> {
  const delays = hooks.delaysMs ?? DEFAULT_LOCK_RETRY_DELAYS_MS
  const log = hooks.log ?? ((): void => undefined)
  const sleep = hooks.sleep ?? realSleep
  const totalAttempts = delays.length + 1
  let lastErr: unknown
  for (let attempt = 1; attempt <= totalAttempts; attempt++) {
    try {
      return await open()
    } catch (err) {
      lastErr = err
      // Corrupt-WAL recovery already ran inside open(); every non-lock error
      // (schema-newer, missing extension, corrupt db, …) must surface untouched.
      if (!isLockContentionError(err)) throw err
      if (attempt === totalAttempts) break
      const waitMs = delays[attempt - 1] as number
      const head = err instanceof Error ? (err.message.split('\n')[0] ?? '') : String(err)
      log(
        `graph.ryugraph is locked by another process (attempt ${attempt}/${totalAttempts}) — retrying in ${waitMs}ms; a previous instance may still be quitting (it checkpoints before exiting). ${head}`
      )
      await sleep(waitMs)
    }
  }
  const budgetS = delays.reduce((a, b) => a + b, 0) / 1000
  log(`graph.ryugraph is still locked after ${totalAttempts} attempts (~${budgetS}s) — giving up this launch`)
  throw lastErr
}

/** openRyuGraphEngine wrapped in the lock-contention backoff (the boot path). */
export function openRyuGraphEngineWithLockRetry(
  options: RyuGraphEngineOptions,
  hooks: LockRetryHooks = {}
): Promise<RyuGraphEngine> {
  return retryOnLockContention(() => openRyuGraphEngine(options), hooks)
}
