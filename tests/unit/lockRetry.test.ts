/**
 * Lock-contention classifier + retry policy (fix/stack-reconnect). The exact
 * message is probe-verified (win32, ryugraph 25.9.1): a second process holding
 * graph.ryugraph makes open() reject with
 *   "IO exception: Could not set lock on file : <path>\nSee the docs: ..."
 * These pin (1) isLockContentionError recognising it (and NOT a corrupt-WAL
 * error, so the WAL-recovery path keeps its own errors), and (2) the pure retry
 * loop retrying ONLY lock contention, on the backoff, then giving up.
 */
import { describe, expect, it, vi } from 'vitest'
import { DEFAULT_LOCK_RETRY_DELAYS_MS, isLockContentionError, retryOnLockContention } from '../../src/main/storage'

/** The verbatim string openRyuGraphEngine surfaces when the graph is locked. */
const LOCK_MESSAGE =
  'IO exception: Could not set lock on file : C:\\Users\\x\\AppData\\Roaming\\agentic-os\\graph\\graph.ryugraph\nSee the docs: https://docs.ryugraph.io/concurrency for more information.'

describe('isLockContentionError', () => {
  it('recognises the probe-verified "Could not set lock on file" message', () => {
    expect(isLockContentionError(new Error(LOCK_MESSAGE))).toBe(true)
  })

  it('recognises a raw ERROR_LOCK_VIOLATION phrasing (defensive secondary anchor)', () => {
    expect(isLockContentionError(new Error('open failed: lock violation (os error 33)'))).toBe(true)
  })

  it('accepts a non-Error thrown value by stringifying it', () => {
    expect(isLockContentionError(LOCK_MESSAGE)).toBe(true)
  })

  it('does NOT classify a corrupt-WAL error as lock contention (WAL recovery owns it)', () => {
    expect(isLockContentionError(new Error('Corrupted wal file. Read out invalid WAL record type.'))).toBe(false)
  })

  it('does NOT classify unrelated open failures (missing extension, schema-newer)', () => {
    expect(isLockContentionError(new Error('vendored RyuGraph vector extension missing at ...'))).toBe(false)
    expect(isLockContentionError(new Error('graph schema v9 is newer than this build supports (v6)'))).toBe(false)
  })
})

describe('retryOnLockContention', () => {
  const noSleep = async (_ms: number): Promise<void> => undefined

  it('returns immediately when the first open succeeds (no retry, no sleep)', async () => {
    const open = vi.fn(async () => 'engine')
    const sleep = vi.fn(noSleep)
    const result = await retryOnLockContention(open, { sleep, delaysMs: [10, 20] })
    expect(result).toBe('engine')
    expect(open).toHaveBeenCalledTimes(1)
    expect(sleep).not.toHaveBeenCalled()
  })

  it('retries on lock contention and succeeds once the lock frees', async () => {
    let calls = 0
    const open = vi.fn(async () => {
      calls += 1
      if (calls < 3) throw new Error(LOCK_MESSAGE) // locked for the first two attempts
      return 'engine'
    })
    const sleep = vi.fn(noSleep)
    const log = vi.fn()
    const result = await retryOnLockContention(open, { sleep, log, delaysMs: [500, 1000, 2000] })
    expect(result).toBe('engine')
    expect(open).toHaveBeenCalledTimes(3)
    // Slept before attempt 2 (500) and attempt 3 (1000); attempt 3 succeeded.
    expect(sleep.mock.calls.map((c) => c[0])).toEqual([500, 1000])
    expect(log).toHaveBeenCalledTimes(2)
  })

  it('gives up after the last attempt and throws the final lock error', async () => {
    const open = vi.fn(async () => {
      throw new Error(LOCK_MESSAGE)
    })
    const sleep = vi.fn(noSleep)
    const log = vi.fn()
    await expect(retryOnLockContention(open, { sleep, log, delaysMs: [1, 2] })).rejects.toThrow(
      /could not set lock on file/i
    )
    // delaysMs.length + 1 = 3 attempts; 2 sleeps between them.
    expect(open).toHaveBeenCalledTimes(3)
    expect(sleep).toHaveBeenCalledTimes(2)
    // One log per retry + one "giving up" line.
    expect(log).toHaveBeenCalledTimes(3)
  })

  it('does NOT retry a non-lock error — it surfaces immediately (corrupt-WAL etc.)', async () => {
    const open = vi.fn(async () => {
      throw new Error('Corrupted wal file. Read out invalid WAL record type.')
    })
    const sleep = vi.fn(noSleep)
    await expect(retryOnLockContention(open, { sleep })).rejects.toThrow(/Corrupted wal file/)
    expect(open).toHaveBeenCalledTimes(1)
    expect(sleep).not.toHaveBeenCalled()
  })

  it('the shipped default backoff is ~10s across 5 retries (0.5/1/2/3/3.5s)', () => {
    expect([...DEFAULT_LOCK_RETRY_DELAYS_MS]).toEqual([500, 1000, 2000, 3000, 3500])
    expect(DEFAULT_LOCK_RETRY_DELAYS_MS.reduce((a, b) => a + b, 0)).toBe(10_000)
  })
})
