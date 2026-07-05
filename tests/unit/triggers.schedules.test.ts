/**
 * TriggerSchedules (§7 time triggers, phase 11): the three §20 slots driven
 * by croner in LOCAL time, each fire enqueueing a durable task with a
 * deterministic per-minute id (`prune-YYYY-MM-DDT0300`) so a restart in the
 * same minute dedups through the queue's id mechanism. Fake timers drive the
 * clock across the 03:00 boundary; expected times are built with the LOCAL
 * Date constructor (never Date.UTC) because the §20 crons are local.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EXPORT_JOB_CRON, PRUNE_JOB_CRON, SKILL_JOB_CRON, TASK_PRIORITY } from '../../src/main/config'
import { openAppData, type AppData } from '../../src/main/storage'
import {
  DurableTaskQueue,
  SCHEDULES,
  TriggerSchedules,
  scheduleFireTaskId,
  type ScheduleSpec
} from '../../src/main/triggers'

interface TaskRow {
  id: string
  kind: string
  status: string
  priority: number
}

let dir: string
let appData: AppData

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'agentic-os-schedules-'))
  appData = openAppData(join(dir, 'appdata.db'))
})

afterEach(() => {
  vi.useRealTimers()
  appData.close()
  rmSync(dir, { recursive: true, force: true })
})

const allRows = (): TaskRow[] =>
  appData.db.prepare('SELECT id, kind, status, priority FROM tasks ORDER BY id').all() as TaskRow[]

const specFor = (taskKind: string): ScheduleSpec => {
  const found = SCHEDULES.find((s) => s.taskKind === taskKind)
  if (found === undefined) throw new Error(`no §20 schedule for kind '${taskKind}'`)
  return found
}

/**
 * Fake-timer rig: pin the clock to 02:59:30 LOCAL today, start the schedules
 * over a real (never-started, handler-less) queue, and advance across 03:00
 * so exactly the nightly prune fires. Returns the fire minute as a LOCAL Date.
 */
const fireNightlyPrune = async (): Promise<{
  queue: DurableTaskQueue
  schedules: TriggerSchedules
  fireMinute: Date
}> => {
  vi.useFakeTimers()
  const real = new Date()
  const base = new Date(real.getFullYear(), real.getMonth(), real.getDate(), 2, 59, 30)
  vi.setSystemTime(base)
  const queue = new DurableTaskQueue({ db: appData.db })
  const schedules = new TriggerSchedules({ queue })
  schedules.start()
  // croner sits on a setTimeout for 03:00:00 — cross it in chunks so any
  // internal re-scheduling also gets driven.
  await vi.advanceTimersByTimeAsync(20_000)
  await vi.advanceTimersByTimeAsync(20_000)
  return {
    queue,
    schedules,
    fireMinute: new Date(base.getFullYear(), base.getMonth(), base.getDate(), 3, 0)
  }
}

describe('TriggerSchedules (§20 slots → durable tasks)', () => {
  it('pins the §20 schedule table: three slots with the exact crons', () => {
    expect(SCHEDULES).toHaveLength(3)
    expect(specFor('skill-improvement').cron).toBe(SKILL_JOB_CRON)
    expect(specFor('prune').cron).toBe(PRUNE_JOB_CRON)
    expect(specFor('export').cron).toBe(EXPORT_JOB_CRON)
    // The §20 literals themselves — a config drift is a spec drift.
    expect(SKILL_JOB_CRON).toBe('0 2 * * *')
    expect(PRUNE_JOB_CRON).toBe('0 3 * * *')
    expect(EXPORT_JOB_CRON).toBe('30 3 * * 0')
  })

  it('status() reports sane future next runs without start() (static-table branch)', () => {
    const queue = new DurableTaskQueue({ db: appData.db })
    const schedules = new TriggerSchedules({ queue })
    const status = schedules.status()
    expect(status).toHaveLength(3)
    const now = Date.now()
    const nextFor = (taskKind: string): Date => {
      const entry = status.find((s) => s.taskKind === taskKind)
      expect(entry?.nextRunAt).toMatch(/^\d{4}-\d{2}-\d{2}T/) // ISO
      const next = new Date(entry?.nextRunAt ?? '')
      expect(next.getTime()).toBeGreaterThan(now)
      return next
    }
    // §20 crons are LOCAL time — assert local clock fields.
    const prune = nextFor('prune')
    expect(prune.getHours()).toBe(3)
    expect(prune.getMinutes()).toBe(0)
    const skill = nextFor('skill-improvement')
    expect(skill.getHours()).toBe(2)
    expect(skill.getMinutes()).toBe(0)
    const exportNext = nextFor('export')
    expect(exportNext.getDay()).toBe(0) // Sunday
    expect(exportNext.getHours()).toBe(3)
    expect(exportNext.getMinutes()).toBe(30)
  })

  it('a fire enqueues the task with a deterministic per-minute id', async () => {
    const { schedules, fireMinute } = await fireNightlyPrune()
    const rows = allRows()
    expect(rows).toHaveLength(1)
    const row = rows[0]
    if (row === undefined) throw new Error('unreachable: length asserted above')
    expect(row.kind).toBe('prune')
    expect(row.status).toBe('pending')
    expect(row.priority).toBe(TASK_PRIORITY.maintenance)
    expect(row.id).toMatch(/^prune-\d{4}-\d{2}-\d{2}T\d{4}$/)
    expect(row.id).toBe(scheduleFireTaskId('prune', fireMinute))
    schedules.stop()
  })

  it('a refire in the same minute dedups on the deterministic id (restart guard)', async () => {
    const { queue, schedules, fireMinute } = await fireNightlyPrune()
    const id = scheduleFireTaskId('prune', fireMinute)
    expect(allRows().map((r) => r.id)).toEqual([id])
    // A restarted process firing in the same minute computes the same id —
    // the queue's dedup makes the second enqueue a no-op.
    expect(queue.enqueue({ id, kind: 'prune' })).toEqual({ taskId: id, deduped: true })
    expect(allRows()).toHaveLength(1)
    schedules.stop()
  })

  it('stop() silences future fires; status() still reports next runs', async () => {
    const { schedules } = await fireNightlyPrune()
    expect(allRows()).toHaveLength(1)
    schedules.stop()
    // A full day would otherwise fire skill (02:00) and prune (03:00) again.
    await vi.advanceTimersByTimeAsync(24 * 60 * 60 * 1000)
    expect(allRows()).toHaveLength(1)
    // status() after stop falls back to the static table — still non-null.
    const status = schedules.status()
    expect(status).toHaveLength(3)
    for (const entry of status) {
      expect(entry.nextRunAt).not.toBeNull()
    }
  })
})
