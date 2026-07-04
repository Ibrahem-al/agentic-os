/**
 * DoD: 50 concurrent writers through the real engine — all serialized on the
 * single write lane, none lost, ordering journal asserted (§21 rule 1).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { openTestStore, type TestStore } from './helpers'

let store: TestStore

beforeAll(async () => {
  store = await openTestStore()
})
afterAll(async () => {
  await store.cleanup()
})

describe('single write lane over the real graph', () => {
  it('serializes 50 concurrent writers — none lost, FIFO ordering journal', async () => {
    const ids = Array.from({ length: 50 }, (_, i) => `k-${String(i).padStart(2, '0')}`)
    const results = await Promise.all(
      ids.map((id, i) =>
        store.engine.upsertNode('Knowledge', { id, content: `concurrent write number ${i}` })
      )
    )
    expect(results.every((r) => r.created)).toBe(true)

    // None lost.
    const rows = await store.engine.cypher('MATCH (n:Knowledge) RETURN count(*) AS c')
    expect(Number(rows[0]?.['c'])).toBe(50)

    // Ordering journal: the 50 upsert jobs ran FIFO (start order === enqueue
    // order), strictly serialized (finish order === start order), all done,
    // and the lane never observed two jobs in flight.
    const journal = store.engine.lane.journal().filter((r) => r.label === 'upsertNode:Knowledge')
    expect(journal).toHaveLength(50)
    const seqOffsets = journal.map((r) => r.seq - (journal[0]?.seq ?? 0))
    const startOffsets = journal.map((r) => r.startOrder - (journal[0]?.startOrder ?? 0))
    expect(startOffsets).toEqual(seqOffsets) // FIFO: execution order === enqueue order
    for (const record of journal) {
      expect(record.status).toBe('done')
      expect(record.finishOrder).toBe(record.startOrder)
    }
    expect(store.engine.lane.maxConcurrencyObserved).toBe(1)
  })

  it('routes mutating cypher() through the lane; reads stay off it', async () => {
    const before = store.engine.lane.enqueuedCount
    await store.engine.cypher("CREATE (:Tag {id: 'lane-route', name: 'route', is_global: false})")
    expect(store.engine.lane.enqueuedCount).toBe(before + 1)
    expect(store.engine.lane.journal().at(-1)?.label).toBe('cypher')

    const afterWrite = store.engine.lane.enqueuedCount
    const rows = await store.engine.cypher("MATCH (t:Tag {id: 'lane-route'}) RETURN t.name AS name")
    expect(rows[0]?.['name']).toBe('route')
    expect(store.engine.lane.enqueuedCount).toBe(afterWrite) // read did not enqueue
  })

  it('withWrite reserves the lane once for a multi-statement job', async () => {
    const before = store.engine.lane.enqueuedCount
    await store.engine.withWrite(async (tx) => {
      await tx.upsertNode('Document', { id: 'doc-lane', source: 's', content_hash: 'h' })
      await tx.upsertNode('Knowledge', { id: 'k-lane', content: 'chunk written in one reservation' })
      await tx.createEdge('HAS_CHUNK', { label: 'Document', id: 'doc-lane' }, { label: 'Knowledge', id: 'k-lane' })
      const inside = await tx.cypher("MATCH (d:Document {id: 'doc-lane'})-[:HAS_CHUNK]->(k:Knowledge) RETURN k.id AS id")
      expect(inside[0]?.['id']).toBe('k-lane')
    })
    // Exactly one lane job for the whole block.
    expect(store.engine.lane.enqueuedCount).toBe(before + 1)
    expect(store.engine.lane.journal().at(-1)?.label).toBe('withWrite')
  })

  it('rejects engine-level writes from inside withWrite (would deadlock)', async () => {
    await expect(
      store.engine.withWrite(async () => {
        await store.engine.upsertNode('Tag', { id: 'nested', name: 'nested', is_global: false })
      })
    ).rejects.toThrow(/reentrancy/)
  })

  it('a failing lane job does not stall subsequent writes', async () => {
    await expect(
      store.engine.withWrite(async () => {
        throw new Error('deliberate failure inside the lane')
      })
    ).rejects.toThrow('deliberate failure inside the lane')
    const result = await store.engine.upsertNode('Tag', { id: 'after-failure', name: 'ok', is_global: false })
    expect(result.created).toBe(true)
    const failed = store.engine.lane.journal().find((r) => r.error?.includes('deliberate failure'))
    expect(failed?.status).toBe('failed')
  })
})
