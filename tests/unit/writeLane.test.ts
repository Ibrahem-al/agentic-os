import { describe, expect, it } from 'vitest'
import { WriteLane } from '../../src/main/storage/writeLane'

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

describe('WriteLane (single write lane, §21 rule 1)', () => {
  it('serializes 50 concurrent writers FIFO with none lost (ordering journal)', async () => {
    const lane = new WriteLane()
    let active = 0
    let maxActive = 0
    const completed: number[] = []

    const results = await Promise.all(
      Array.from({ length: 50 }, (_, i) =>
        lane.enqueue(`job:${i}`, async () => {
          active += 1
          maxActive = Math.max(maxActive, active)
          await sleep(Math.floor(Math.random() * 5))
          completed.push(i)
          active -= 1
          return i
        })
      )
    )

    // None lost, each job's own result delivered.
    expect(results).toEqual(Array.from({ length: 50 }, (_, i) => i))
    expect(completed).toEqual(Array.from({ length: 50 }, (_, i) => i))
    // Never more than one job in flight — both our probe and the lane's own.
    expect(maxActive).toBe(1)
    expect(lane.maxConcurrencyObserved).toBe(1)

    // Journal: 50 records, FIFO (start order === enqueue order), serialized
    // (finish order === start order), all done.
    const journal = lane.journal()
    expect(journal).toHaveLength(50)
    for (const record of journal) {
      expect(record.status).toBe('done')
      expect(record.startOrder).toBe(record.seq)
      expect(record.finishOrder).toBe(record.startOrder)
    }
    expect(lane.enqueuedCount).toBe(50)
  })

  it('isolates failures: a rejected job rejects its caller but the lane advances', async () => {
    const lane = new WriteLane()
    const first = lane.enqueue('ok-1', async () => 'a')
    const failing = lane.enqueue('boom', async () => {
      throw new Error('deliberate')
    })
    const last = lane.enqueue('ok-2', async () => 'b')

    await expect(first).resolves.toBe('a')
    await expect(failing).rejects.toThrow('deliberate')
    await expect(last).resolves.toBe('b')

    const journal = lane.journal()
    expect(journal.map((r) => r.status)).toEqual(['done', 'failed', 'done'])
    expect(journal[1]?.error).toBe('deliberate')
  })

  it('rejects reentrant enqueues (they would deadlock behind themselves)', async () => {
    const lane = new WriteLane()
    await expect(
      lane.enqueue('outer', async () => {
        await Promise.resolve()
        lane.enqueue('inner', async () => 'never')
      })
    ).rejects.toThrow(/reentrancy/)
  })

  it('onIdle waits for everything enqueued so far, including failures', async () => {
    const lane = new WriteLane()
    const seen: string[] = []
    void lane.enqueue('slow', async () => {
      await sleep(20)
      seen.push('slow')
    })
    void lane
      .enqueue('fails', async () => {
        seen.push('fails')
        throw new Error('x')
      })
      .catch(() => undefined)
    await lane.onIdle()
    expect(seen).toEqual(['slow', 'fails'])
  })

  it('bounds the journal ring while keeping the global counters', async () => {
    const lane = new WriteLane(10)
    await Promise.all(Array.from({ length: 25 }, (_, i) => lane.enqueue(`j${i}`, async () => i)))
    const journal = lane.journal()
    expect(journal).toHaveLength(10)
    expect(journal[0]?.seq).toBe(15)
    expect(lane.enqueuedCount).toBe(25)
  })
})
