/**
 * Runner spawn lanes (phase 17; P0.9/§9.8).
 *
 * `claude -p` spawns are ~150–300 MB Node processes; two populations can want
 * one at once — a background workflow step (skills/extraction) and a live
 * user-facing completion (retrieval critic/rewrite, if ever flipped off their
 * hard-local default). If both rode one FIFO lane, a live `get_context` call
 * could queue behind a 15-minute background run — a user-facing stall in
 * minutes. So there are TWO lanes, each concurrency 1:
 *   - `runnerLiveLane` — live MCP paths (`taskId 'live:<sid>'`);
 *   - `runnerBackgroundLane` — workflow steps + (phase-19) agent mode, which
 *     cooperatively yields: before it runs a task it waits for the live lane to
 *     drain, so live work always preempts background spawns.
 *
 * The lanes only serialize the SPAWN — the durable task queue is already serial
 * (§8 one task at a time), so in the shipped (live-roles-local) config the live
 * lane is idle and the background lane never actually waits.
 */

/** One concurrency-1 FIFO lane, optionally yielding to another lane first. */
export class RunnerLane {
  private tail: Promise<void> = Promise.resolve()
  private activeCount = 0
  private idleWaiters: Array<() => void> = []

  constructor(
    readonly name: 'live' | 'background',
    private readonly yieldTo?: RunnerLane
  ) {}

  /** True while a task is actually executing in this lane (not merely queued). */
  get busy(): boolean {
    return this.activeCount > 0
  }

  /** Resolves the moment the lane is idle (immediately if it already is). */
  whenIdle(): Promise<void> {
    if (!this.busy) return Promise.resolve()
    return new Promise((resolve) => this.idleWaiters.push(resolve))
  }

  /**
   * Serialize `task` behind everything already queued in this lane. If this lane
   * yields to another (background → live), it first drains that lane so a live
   * spawn always wins the machine over a background one.
   */
  async run<T>(task: () => Promise<T>): Promise<T> {
    const turn = this.tail
    let release!: () => void
    this.tail = new Promise<void>((resolve) => {
      release = resolve
    })
    await turn // FIFO within the lane
    try {
      if (this.yieldTo !== undefined) {
        // Cooperative yield: hold until the higher-priority lane is idle.
        while (this.yieldTo.busy) await this.yieldTo.whenIdle()
      }
      this.activeCount++
      return await task()
    } finally {
      this.activeCount--
      if (this.activeCount === 0) {
        const waiters = this.idleWaiters
        this.idleWaiters = []
        for (const resolve of waiters) resolve()
      }
      release()
    }
  }

  /** Test seam: drop queued/idle bookkeeping (in-flight holders keep their closures). */
  reset(): void {
    this.tail = Promise.resolve()
    this.activeCount = 0
    const waiters = this.idleWaiters
    this.idleWaiters = []
    for (const resolve of waiters) resolve()
  }
}

/** The single live lane (user-facing completions). */
export const runnerLiveLane = new RunnerLane('live')

/** The single background lane (workflow steps + agent mode); yields to live. */
export const runnerBackgroundLane = new RunnerLane('background', runnerLiveLane)

/** Pick the lane for a taskId: `live:<sid>` → live, everything else background. */
export function laneForTask(taskId: string): RunnerLane {
  return taskId.startsWith('live:') ? runnerLiveLane : runnerBackgroundLane
}

/** Test seam: reset both module-level lanes. */
export function resetRunnerLanesForTests(): void {
  runnerLiveLane.reset()
  runnerBackgroundLane.reset()
}
