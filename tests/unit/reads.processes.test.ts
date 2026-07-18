/**
 * getTaskProcesses (task-control feature): the host app process, the shared Ollama
 * loaded models, and a task's runner children with RAM/CPU — all best-effort, never
 * throwing into the read (a vanished pid / dead daemon / sampler failure degrades to
 * null/empty).
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { openAppData, type AppData } from '../../src/main/storage'
import { getTaskProcesses, type TaskProcessesDeps } from '../../src/main/reads'
import type { LocalLoadedModelDto, TaskHostProcessDto } from '../../src/shared/ipc'

let dir: string
let appData: AppData

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'agentic-os-proc-'))
  appData = openAppData(join(dir, 'appdata.db'))
})
afterEach(() => {
  appData.close()
  rmSync(dir, { recursive: true, force: true })
})

const HOST: TaskHostProcessDto = { pid: 111, name: 'Agentic OS (app)', cpuPercent: 12.3, memoryBytes: 500_000_000 }
const MODEL: LocalLoadedModelDto = { name: 'bge-m3:latest', sizeBytes: 1_200_000_000, sizeVramBytes: 0, expiresAt: null }

const okOllama = {
  ps: async (): Promise<LocalLoadedModelDto[]> => [MODEL],
  status: async () => ({ state: 'ready' as const, installedModels: [], missingModels: [], installUrl: '' })
}

/** Insert an UNFINISHED (live) runner_runs row with a pid for `taskId`. */
const insertRun = (id: string, taskId: string, pid: number): void => {
  appData.db
    .prepare(`INSERT INTO runner_runs (id, task_id, mode, pid, started_at) VALUES (?, ?, 'agent', ?, ?)`)
    .run(id, taskId, pid, '2026-07-17T00:00:00.000Z')
}

const baseDeps = (over: Partial<TaskProcessesDeps> = {}): TaskProcessesDeps => ({
  db: appData.db,
  ollama: okOllama,
  hostMetrics: () => HOST,
  sampleProcess: async () => ({ cpuPercent: 4.5, memoryBytes: 90_000_000 }),
  runningTaskId: () => null,
  ...over
})

describe('getTaskProcesses', () => {
  it('reports host, loaded models, and a task’s live children', async () => {
    insertRun('run-1', 'extract-x', 999)
    const data = await getTaskProcesses(baseDeps({ runningTaskId: () => 'extract-x' }), { id: 'extract-x' })
    expect(data.taskId).toBe('extract-x')
    expect(data.running).toBe(true)
    expect(data.host).toEqual(HOST)
    expect(data.localRuntime).toEqual({ reachable: true, loadedModels: [MODEL] })
    expect(data.children).toHaveLength(1)
    expect(data.children[0]).toMatchObject({ pid: 999, role: 'runner:agent', live: true, cpuPercent: 4.5, memoryBytes: 90_000_000 })
  })

  it('matches a task’s `<taskId>-wf` completion children too', async () => {
    insertRun('run-2', 'extract-x-wf', 1000)
    const data = await getTaskProcesses(baseDeps(), { id: 'extract-x' })
    expect(data.children.map((c) => c.pid)).toEqual([1000])
  })

  it('a finished child reports its stats without being sampled', async () => {
    appData.db
      .prepare(`INSERT INTO runner_runs (id, task_id, mode, pid, started_at, is_error, exit_code) VALUES (?, ?, 'completion', ?, ?, 0, 0)`)
      .run('run-3', 'extract-y', 5, '2026-07-17T00:00:00.000Z')
    const sample = vi.fn(async () => ({ cpuPercent: 1, memoryBytes: 1 }))
    const data = await getTaskProcesses(baseDeps({ sampleProcess: sample }), { id: 'extract-y' })
    expect(data.children[0]?.live).toBe(false)
    expect(sample).not.toHaveBeenCalled() // a finished row is not re-sampled
  })

  it('degrades cleanly when the daemon is down and a sampler / host probe fails', async () => {
    insertRun('run-4', 'extract-z', 7)
    const data = await getTaskProcesses(
      baseDeps({
        ollama: {
          ps: async () => [],
          status: async () => ({ state: 'daemon-not-running' as const, installedModels: [], missingModels: [], installUrl: '' })
        },
        sampleProcess: async () => {
          throw new Error('sampler blew up')
        },
        hostMetrics: () => {
          throw new Error('metrics blew up')
        }
      }),
      { id: 'extract-z' }
    )
    expect(data.host).toBeNull()
    expect(data.localRuntime).toEqual({ reachable: false, loadedModels: [] })
    // The child is still listed (from the DB row) with null resources — never a throw.
    expect(data.children[0]).toMatchObject({ pid: 7, cpuPercent: null, memoryBytes: null })
  })

  it('defaults to the current in-flight task when no id is given', async () => {
    insertRun('run-5', 'extract-cur', 3)
    const data = await getTaskProcesses(baseDeps({ runningTaskId: () => 'extract-cur' }))
    expect(data.taskId).toBe('extract-cur')
    expect(data.running).toBe(true)
    expect(data.children.map((c) => c.pid)).toEqual([3])
  })

  it('no running task and no id → host + models only, no children', async () => {
    const data = await getTaskProcesses(baseDeps())
    expect(data.taskId).toBeNull()
    expect(data.running).toBe(false)
    expect(data.children).toEqual([])
    expect(data.host).toEqual(HOST)
    expect(data.summary).toBeNull() // no task in view → no summary
  })
})

describe('getTaskProcesses summary (the Resources "averages and time it took")', () => {
  const insertTaskRow = (
    id: string,
    kind: string,
    status: string,
    startedAt: string | null,
    updatedAt: string,
    attempts = 1
  ): void => {
    appData.db
      .prepare(
        `INSERT INTO tasks (id, kind, status, attempts, started_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(id, kind, status, attempts, startedAt, updatedAt)
  }

  it('summarizes a finished task: duration, kind average, cloud + runner usage', async () => {
    // Two prior done extraction runs (10s, 30s) plus the one under inspection (20s).
    insertTaskRow('e-old1', 'extraction', 'done', '2026-07-17T00:00:00.000Z', '2026-07-17T00:00:10.000Z')
    insertTaskRow('e-old2', 'extraction', 'done', '2026-07-17T00:00:00.000Z', '2026-07-17T00:00:30.000Z')
    insertTaskRow('e-x', 'extraction', 'done', '2026-07-17T01:00:00.000Z', '2026-07-17T01:00:20.000Z', 2)
    appData.db
      .prepare(
        `INSERT INTO spend (task_id, provider, model, input_tokens, output_tokens, usd) VALUES ('e-x','anthropic','claude',800,200,0.05)`
      )
      .run()
    appData.db
      .prepare(
        `INSERT INTO runner_runs (id, task_id, mode, started_at, input_tokens, output_tokens, is_error, exit_code)
         VALUES ('rr','e-x','completion','2026-07-17T01:00:00.000Z',1000,300,0,0)`
      )
      .run()

    const s = (await getTaskProcesses(baseDeps(), { id: 'e-x' })).summary
    expect(s).not.toBeNull()
    expect(s?.status).toBe('done')
    expect(s?.running).toBe(false)
    expect(s?.durationMs).toBe(20_000)
    expect(s?.finishedAt).toBe('2026-07-17T01:00:20.000Z')
    expect(s?.attempts).toBe(2)
    expect(s?.kindSampleSize).toBe(3)
    expect(s?.kindAvgDurationMs).toBe((10_000 + 30_000 + 20_000) / 3)
    expect(s?.cloud).toEqual({ calls: 1, inputTokens: 800, outputTokens: 200, usd: 0.05 })
    expect(s?.runner).toEqual({ runs: 1, inputTokens: 1000, outputTokens: 300 })
  })

  it('a running task reports live duration and no finishedAt', async () => {
    insertTaskRow('r-run', 'skill', 'running', '2026-07-17T00:00:00.000Z', '2026-07-17T00:00:00.000Z')
    const s = (await getTaskProcesses(baseDeps({ runningTaskId: () => 'r-run' }), { id: 'r-run' })).summary
    expect(s?.running).toBe(true)
    expect(s?.finishedAt).toBeNull()
    expect(s?.durationMs).not.toBeNull() // now − started_at
  })

  it('does not report a duration for a paused/deferred task (updated_at is not a reliable run-end)', async () => {
    // Ran (started 00:00), then paused later at 00:05 — updated_at moved past the run-end,
    // so a naive updated−started would span the idle gap. Must report null instead.
    insertTaskRow('p-x', 'skill', 'paused', '2026-07-17T00:00:00.000Z', '2026-07-17T00:05:00.000Z')
    const s = (await getTaskProcesses(baseDeps(), { id: 'p-x' })).summary
    expect(s?.status).toBe('paused')
    expect(s?.durationMs).toBeNull()
    expect(s?.finishedAt).toBeNull()
  })

  it('a never-run task reports null duration and no attributable usage', async () => {
    insertTaskRow('r-pending', 'skill', 'pending', null, '2026-07-17T00:00:00.000Z')
    const s = (await getTaskProcesses(baseDeps(), { id: 'r-pending' })).summary
    expect(s?.durationMs).toBeNull()
    expect(s?.cloud).toBeNull()
    expect(s?.runner).toBeNull()
    expect(s?.kindAvgDurationMs).toBeNull() // no finished 'skill' runs to average
  })
})
