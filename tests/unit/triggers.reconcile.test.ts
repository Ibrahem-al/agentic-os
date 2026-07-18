/**
 * reconcileWorkflowJobs (boot fix): orphaned kind='workflow' rows stuck 'running'
 * with no live driver → 'failed' (they would otherwise linger 'running' forever —
 * the "stuck workflow for days" symptom), and benign "nothing to extract" workflow
 * rows left 'failed' with a completed driver → settled to 'done'. Rows a live driver
 * WILL resume, and non-task workflow ids, are never touched.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { openAppData, type AppData } from '../../src/main/storage'
import { reconcileWorkflowJobs } from '../../src/main/triggers'

let dir: string
let appData: AppData

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'agentic-os-reconcile-'))
  appData = openAppData(join(dir, 'appdata.db'))
})
afterEach(() => {
  appData.close()
  rmSync(dir, { recursive: true, force: true })
})

const insert = (id: string, kind: string, status: string, lastError: string | null = null): void => {
  appData.db
    .prepare(`INSERT INTO tasks (id, kind, status, last_error) VALUES (?, ?, ?, ?)`)
    .run(id, kind, status, lastError)
}
const statusOf = (id: string): string =>
  (appData.db.prepare('SELECT status FROM tasks WHERE id = ?').get(id) as { status: string }).status

describe('reconcileWorkflowJobs (boot workflow reconciliation)', () => {
  it('flips an orphaned running workflow whose driver is terminal or absent', () => {
    insert('extract-a', 'extraction', 'done')
    insert('extract-a-wf', 'workflow', 'running') // driver done → orphan
    insert('extract-b-wf', 'workflow', 'running') // driver absent → orphan

    const result = reconcileWorkflowJobs(appData.db)
    expect(result.orphanedRunningFixed).toBe(2)
    expect(statusOf('extract-a-wf')).toBe('failed')
    expect(statusOf('extract-b-wf')).toBe('failed')
  })

  it('leaves a running workflow whose driver WILL resume it (pending/deferred/running)', () => {
    insert('extract-p', 'extraction', 'pending')
    insert('extract-p-wf', 'workflow', 'running')
    insert('extract-d', 'extraction', 'deferred')
    insert('extract-d-wf', 'workflow', 'running')

    const result = reconcileWorkflowJobs(appData.db)
    expect(result.orphanedRunningFixed).toBe(0)
    expect(statusOf('extract-p-wf')).toBe('running')
    expect(statusOf('extract-d-wf')).toBe('running')
  })

  it('never touches a non-task ("-wf"-less) workflow row', () => {
    insert('some-uuid-job', 'workflow', 'running')
    reconcileWorkflowJobs(appData.db)
    expect(statusOf('some-uuid-job')).toBe('running')
  })

  it('settles a benign "nothing to extract" failed workflow with a done driver', () => {
    insert('extract-n', 'extraction', 'done')
    insert('extract-n-wf', 'workflow', 'failed', "extraction: session 'n' has no mcp_calls rows and no readable transcript — nothing to extract")

    const result = reconcileWorkflowJobs(appData.db)
    expect(result.benignResolved).toBe(1)
    expect(statusOf('extract-n-wf')).toBe('done')
    expect(
      (appData.db.prepare('SELECT last_error FROM tasks WHERE id = ?').get('extract-n-wf') as { last_error: string | null })
        .last_error
    ).toBeNull()
  })

  it('leaves a real failure (not "nothing to extract") even with a done driver', () => {
    insert('extract-r', 'extraction', 'done')
    insert('extract-r-wf', 'workflow', 'failed', 'Ollama /api/embed returned HTTP 400: boom')
    reconcileWorkflowJobs(appData.db)
    expect(statusOf('extract-r-wf')).toBe('failed')
  })

  it('leaves a benign failed workflow whose driver has not completed', () => {
    insert('extract-u', 'extraction', 'deferred')
    insert('extract-u-wf', 'workflow', 'failed', 'nothing to extract')
    reconcileWorkflowJobs(appData.db)
    expect(statusOf('extract-u-wf')).toBe('failed')
  })

  it('is idempotent — a second run finds nothing to fix', () => {
    insert('extract-a', 'extraction', 'done')
    insert('extract-a-wf', 'workflow', 'running')
    reconcileWorkflowJobs(appData.db)
    const second = reconcileWorkflowJobs(appData.db)
    expect(second).toEqual({ orphanedRunningFixed: 0, benignResolved: 0 })
  })
})
