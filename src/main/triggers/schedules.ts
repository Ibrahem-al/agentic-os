/**
 * Time schedules (§7) — croner drives the three §20 slots, each fire
 * enqueueing a durable task (triggers *create* tasks; tasks enter the §8
 * scheduler):
 *
 *   - nightly prune, 03:00 local  → kind 'prune'
 *   - nightly skill job, 02:00 local → kind 'skill-improvement' (a no-op
 *     handler until phase 12 — the slot itself is real and observable)
 *   - weekly export, Sunday 03:30 local → kind 'export'
 *
 * Per-fire task ids are stamped with the fire minute (`prune-2026-07-04T0300`)
 * so an overlapping restart in the same minute cannot double-enqueue; the
 * queue's id dedup does the rest. Cron expressions live in config (§20).
 */
import { Cron } from 'croner'
import { EXPORT_JOB_CRON, PRUNE_JOB_CRON, SKILL_JOB_CRON, TASK_PRIORITY } from '../config'
import type { DurableTaskQueue } from './queue'

export interface ScheduleSpec {
  readonly name: string
  readonly cron: string
  readonly taskKind: string
}

/** The §20 schedule table (local time — croner's default timezone). */
export const SCHEDULES: readonly ScheduleSpec[] = [
  { name: 'nightly-skill-job', cron: SKILL_JOB_CRON, taskKind: 'skill-improvement' },
  { name: 'nightly-prune', cron: PRUNE_JOB_CRON, taskKind: 'prune' },
  { name: 'weekly-export', cron: EXPORT_JOB_CRON, taskKind: 'export' }
]

export interface ScheduleStatus {
  readonly name: string
  readonly cron: string
  readonly taskKind: string
  /** ISO timestamp of the next fire (null once stopped). */
  readonly nextRunAt: string | null
}

/** Deterministic per-fire task id: kind + the fire's local minute. */
export function scheduleFireTaskId(taskKind: string, firedAt: Date): string {
  const pad = (n: number): string => String(n).padStart(2, '0')
  const stamp = `${firedAt.getFullYear()}-${pad(firedAt.getMonth() + 1)}-${pad(firedAt.getDate())}T${pad(firedAt.getHours())}${pad(firedAt.getMinutes())}`
  return `${taskKind}-${stamp}`
}

export class TriggerSchedules {
  private readonly queue: DurableTaskQueue
  private readonly jobs: { spec: ScheduleSpec; cron: Cron }[] = []

  constructor(deps: { queue: DurableTaskQueue }) {
    this.queue = deps.queue
  }

  start(): void {
    if (this.jobs.length > 0) throw new Error('schedules already started')
    for (const spec of SCHEDULES) {
      const cron = new Cron(spec.cron, () => {
        const result = this.queue.enqueue({
          id: scheduleFireTaskId(spec.taskKind, new Date()),
          kind: spec.taskKind,
          priority: TASK_PRIORITY.maintenance
        })
        if (!result.deduped) console.log(`[triggers] schedule ${spec.name} fired — enqueued ${result.taskId}`)
      })
      this.jobs.push({ spec, cron })
    }
  }

  stop(): void {
    for (const job of this.jobs) job.cron.stop()
    this.jobs.length = 0
  }

  status(): ScheduleStatus[] {
    if (this.jobs.length > 0) {
      return this.jobs.map(({ spec, cron }) => ({
        name: spec.name,
        cron: spec.cron,
        taskKind: spec.taskKind,
        nextRunAt: cron.nextRun()?.toISOString() ?? null
      }))
    }
    // Not started (or stopped): report the static table with computed nexts.
    return SCHEDULES.map((spec) => {
      const probe = new Cron(spec.cron, { paused: true }, () => undefined)
      const next = probe.nextRun()
      probe.stop()
      return { name: spec.name, cron: spec.cron, taskKind: spec.taskKind, nextRunAt: next?.toISOString() ?? null }
    })
  }
}
