/**
 * Periodic checkpoint (root-cause hardening for the corrupt-WAL failure): the
 * engine flushes the WAL into the main db on an interval so a hard kill loses at
 * most one interval of writes, and the WAL stays small (less torn-WAL exposure).
 * Dirty-gated: an idle store never checkpoints. Migrations count as dirty — the
 * boot-time migration burst flushes on the first tick.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openRyuGraphEngine } from '../../src/main/storage'
import { EXTENSIONS_DIR } from './helpers'

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

let baseDir: string
beforeEach(() => {
  baseDir = mkdtempSync(join(tmpdir(), 'agentic-os-ckpt-'))
})
afterEach(() => {
  rmSync(baseDir, { recursive: true, force: true })
})

const open = (checkpointIntervalMs: number) =>
  openRyuGraphEngine({
    graphDir: join(baseDir, 'graph'),
    backupsDir: join(baseDir, 'backups'),
    extensionsDir: EXTENSIONS_DIR,
    checkpointIntervalMs
  })

describe('periodic WAL checkpoint', () => {
  it('checkpoints after a write and stays idle otherwise (dirty-gated)', async () => {
    // Seed so the assertions run on a REOPENED store: a fresh open applies
    // migrations, which (deliberately) mark the store dirty — the reopen has
    // no pending migrations, so the gate starts closed.
    await (await open(0)).close()

    const engine = await open(60)
    try {
      // No user writes yet → the dirty gate holds the timer: zero checkpoints.
      await wait(220)
      expect(engine.periodicCheckpoints).toBe(0)

      // A write marks the store dirty → the next tick flushes exactly once.
      await engine.upsertNode('Tag', { id: 'a', name: 'first', is_global: true })
      await wait(260)
      const afterWrite = engine.periodicCheckpoints
      expect(afterWrite).toBeGreaterThanOrEqual(1)

      // No further writes → the gate re-closes; the count does not keep climbing.
      await wait(260)
      expect(engine.periodicCheckpoints).toBe(afterWrite)
    } finally {
      await engine.close()
    }
  })

  it('a fresh open flushes its migration burst on the first tick (migrations mark dirty)', async () => {
    const engine = await open(60)
    try {
      await wait(260)
      expect(engine.periodicCheckpoints).toBeGreaterThanOrEqual(1)
    } finally {
      await engine.close()
    }
  })

  it('checkpointIntervalMs: 0 disables the timer entirely', async () => {
    const engine = await open(0)
    try {
      await engine.upsertNode('Tag', { id: 'b', name: 'second', is_global: true })
      await wait(200)
      expect(engine.periodicCheckpoints).toBe(0)
    } finally {
      await engine.close()
    }
  })
})
