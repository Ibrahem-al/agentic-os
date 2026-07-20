/**
 * Background duplicate-scan controller (memory/dedupeController.ts) over the REAL
 * engine + appdata.db:
 *
 *  - a scan runs DETACHED from any caller; `start()` returns immediately and the
 *    completed result is persisted to `dedupe_scans`, so a fresh controller on
 *    the same db (a restart / modal reopen) reads it back via `snapshot()`;
 *  - the `recent` watermark advances only on recent/all scans, and the first-ever
 *    `recent` scan falls back to the DEDUPE_RECENT_DEFAULT_WINDOW_MS window;
 *  - a second `start()` while one is in flight is rejected.
 *
 * The clock is injected so completed_at / watermark are deterministic; node
 * updated_at is set explicitly to sit inside the fallback window of that clock.
 */
import { join } from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { DEDUPE_RECENT_DEFAULT_WINDOW_MS, EMBEDDING_DIM } from '../../src/main/config'
import { DedupeScanController } from '../../src/main/memory'
import { MemoryEditError } from '../../src/main/memory'
import { openAppData, type AppData } from '../../src/main/storage'
import type { DedupeScanStatusDto } from '../../src/shared/ipc'
import { basisEmbedding, openTestStore, type TestStore } from './helpers'

let store: TestStore
let appData: AppData

const CLOCK0 = Date.parse('2025-01-15T00:00:00.000Z')
const NODE_TS = '2025-01-14T00:00:00.000Z' // 1 day before CLOCK0 → inside the 7-day fallback window

let clock = CLOCK0
let events: DedupeScanStatusDto[] = []
let resolveTerminal: ((s: DedupeScanStatusDto) => void) | null = null
let controller: DedupeScanController

/** Start a scan and resolve when it reaches a terminal (non-running) status. */
const runScan = (options: Parameters<DedupeScanController['start']>[0]): Promise<DedupeScanStatusDto> =>
  new Promise((resolve) => {
    resolveTerminal = resolve
    controller.start(options)
  })

const newController = (): DedupeScanController =>
  new DedupeScanController({
    engine: store.engine,
    db: appData.db,
    now: () => clock,
    broadcast: (s) => {
      events.push(s)
      if (s.phase !== 'running' && resolveTerminal !== null) {
        const r = resolveTerminal
        resolveTerminal = null
        r(s)
      }
    }
  })

beforeAll(async () => {
  store = await openTestStore()
  appData = openAppData(join(store.baseDir, 'appdata.db'))
  const e = store.engine
  // One exact Knowledge duplicate pair so every scope finds a group.
  await e.upsertNode('Knowledge', { id: 'dc-1', content: 'shared note', embedding: basisEmbedding(EMBEDDING_DIM, 80) })
  await e.upsertNode('Knowledge', { id: 'dc-2', content: 'shared note', embedding: basisEmbedding(EMBEDDING_DIM, 80) })
  for (const id of ['dc-1', 'dc-2']) {
    await e.cypher('MATCH (n:Knowledge {id: $id}) SET n.updated_at = timestamp($ts)', { id, ts: NODE_TS })
  }
})

afterAll(async () => {
  appData.close()
  await store.cleanup()
})

beforeEach(() => {
  clock = CLOCK0
  events = []
  resolveTerminal = null
  appData.db.prepare('DELETE FROM dedupe_scans').run()
  controller = newController()
})

describe('DedupeScanController', () => {
  it('runs detached, persists the completed result, and a fresh controller reads it back', async () => {
    const done = await runScan({ scope: 'all', labels: ['Knowledge'] })
    expect(done.phase).toBe('done')
    expect(done.lastScope).toBe('all')
    expect(done.lastResult?.groups.some((g) => g.nodes.some((n) => n.id === 'dc-1'))).toBe(true)
    expect(done.watermarkAt).toBe(new Date(CLOCK0).toISOString())

    // A brand-new controller (simulating a restart / reopen) surfaces the row.
    const reopened = newController().snapshot()
    expect(reopened.phase).toBe('idle')
    expect(reopened.lastResult?.groups.some((g) => g.nodes.some((n) => n.id === 'dc-1'))).toBe(true)
    expect(reopened.lastScope).toBe('all')
  })

  it('advances the watermark on recent/all scans but NOT on a count scan', async () => {
    await runScan({ scope: 'all', labels: ['Knowledge'] }) // watermark → CLOCK0
    expect(controller.snapshot().watermarkAt).toBe(new Date(CLOCK0).toISOString())

    clock = CLOCK0 + 60_000
    await runScan({ scope: 'count', count: 10, labels: ['Knowledge'] }) // count must NOT move it
    expect(controller.snapshot().watermarkAt).toBe(new Date(CLOCK0).toISOString())

    clock = CLOCK0 + 120_000
    const recent = await runScan({ scope: 'recent', labels: ['Knowledge'] })
    // The recent scan compared since the PRIOR watermark (CLOCK0) …
    expect(recent.effectiveCutoff).toBe(new Date(CLOCK0).toISOString())
    // … and advanced it to this scan's start.
    expect(controller.snapshot().watermarkAt).toBe(new Date(CLOCK0 + 120_000).toISOString())
  })

  it('first-ever recent scan (no watermark) falls back to the default window', async () => {
    const done = await runScan({ scope: 'recent', labels: ['Knowledge'] })
    expect(done.effectiveCutoff).toBe(new Date(CLOCK0 - DEDUPE_RECENT_DEFAULT_WINDOW_MS).toISOString())
    // It still found the dup (NODE_TS sits inside the fallback window).
    expect(done.lastResult?.groups.some((g) => g.nodes.some((n) => n.id === 'dc-1'))).toBe(true)
  })

  it('rejects a second start while a scan is in flight', async () => {
    const first = runScan({ scope: 'all', labels: ['Knowledge'] })
    // Synchronously after start(), the scan is still running (its awaits are pending).
    expect(controller.snapshot().phase).toBe('running')
    expect(() => controller.start({ scope: 'all', labels: ['Knowledge'] })).toThrow(MemoryEditError)
    await first // let it finish so the afterEach/next test starts clean
  })
})
