/**
 * The single write lane (spec §5, §21 rule 1): an async FIFO through which
 * every graph mutation flows. Reads never queue here.
 *
 * Lives in storage/ for now; the kernel (phase 04) will own scheduling around
 * it. Deliberately dependency-free apart from node:async_hooks.
 *
 * Guarantees:
 * - strict FIFO: jobs run in enqueue order, one at a time, never overlapping;
 * - failure isolation: a rejected job rejects its caller but the lane advances;
 * - an ordering journal (bounded ring) records every job for tests/telemetry;
 * - reentrancy protection: enqueueing from inside a lane job would deadlock
 *   behind itself, so it throws instead (use the WriteTx passed to withWrite).
 */
import { AsyncLocalStorage } from 'node:async_hooks'

export interface WriteJobRecord {
  /** Enqueue order, 0-based, monotonically increasing. */
  readonly seq: number
  /** Short human-readable job label, e.g. `upsertNode:Project`. */
  readonly label: string
  /** Execution-start order. FIFO holds iff startOrder === seq for every job. */
  startOrder: number
  /** Execution-finish order. Serialized execution ⇒ finishOrder === startOrder. */
  finishOrder: number
  status: 'pending' | 'running' | 'done' | 'failed'
  error?: string
}

export class WriteLane {
  private tail: Promise<unknown> = Promise.resolve()
  private readonly ring: WriteJobRecord[] = []
  private readonly capacity: number
  private nextSeq = 0
  private nextStartOrder = 0
  private nextFinishOrder = 0
  private active = 0
  private maxObservedActive = 0
  private readonly context = new AsyncLocalStorage<true>()

  constructor(journalCapacity = 1000) {
    if (!Number.isSafeInteger(journalCapacity) || journalCapacity < 1) {
      throw new Error(`invalid write-lane journal capacity: ${journalCapacity}`)
    }
    this.capacity = journalCapacity
  }

  /** True while executing inside a lane job (used to reject nested enqueues). */
  get inLane(): boolean {
    return this.context.getStore() === true
  }

  /**
   * Enqueue a mutation job. Resolves/rejects with the job's own outcome once
   * every previously enqueued job has finished.
   */
  enqueue<T>(label: string, job: () => Promise<T> | T): Promise<T> {
    if (this.inLane) {
      throw new Error(
        `write-lane reentrancy: "${label}" enqueued from inside a lane job would deadlock — ` +
          'use the WriteTx handed to withWrite() instead of the engine-level write methods'
      )
    }
    const record: WriteJobRecord = {
      seq: this.nextSeq++,
      label,
      startOrder: -1,
      finishOrder: -1,
      status: 'pending'
    }
    this.ring.push(record)
    if (this.ring.length > this.capacity) this.ring.splice(0, this.ring.length - this.capacity)

    const run = async (): Promise<T> => {
      record.startOrder = this.nextStartOrder++
      record.status = 'running'
      this.active += 1
      this.maxObservedActive = Math.max(this.maxObservedActive, this.active)
      try {
        const result = await this.context.run(true, () => job())
        record.status = 'done'
        return result
      } catch (err) {
        record.status = 'failed'
        record.error = err instanceof Error ? err.message : String(err)
        throw err
      } finally {
        record.finishOrder = this.nextFinishOrder++
        this.active -= 1
      }
    }

    // Chain onto the tail; swallow the previous job's rejection so one failure
    // never stalls the lane, while this job's promise carries its own outcome.
    const result = this.tail.then(run, run)
    this.tail = result.then(
      () => undefined,
      () => undefined
    )
    return result
  }

  /** Snapshot of the (bounded) ordering journal, oldest first. */
  journal(): readonly Readonly<WriteJobRecord>[] {
    return this.ring.map((r) => ({ ...r }))
  }

  /** Total jobs ever enqueued (journal may have evicted the oldest). */
  get enqueuedCount(): number {
    return this.nextSeq
  }

  /** Highest number of concurrently running jobs ever observed (must stay 1). */
  get maxConcurrencyObserved(): number {
    return this.maxObservedActive
  }

  /** Resolves once every job enqueued so far has finished. */
  async onIdle(): Promise<void> {
    let tail
    do {
      tail = this.tail
      await tail.catch(() => undefined)
    } while (tail !== this.tail)
  }
}
