/**
 * Task / trigger reads (§4.E) — the shared source for the dashboard's
 * `tasks.list` / `triggers.status` / `watch.list` handlers AND the
 * `list_tasks` / `get_task` / `get_triggers_status` / `list_watched_folders`
 * read tools.
 *
 * listTasks / getTriggersStatus / listWatchedFolders are extracted verbatim
 * from `ipc.ts`; getTask adds the single-row detail (+ payload, + the
 * `<taskId>-wf` workflow job when include_workflow is requested).
 */
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type BetterSqlite3 from 'better-sqlite3'
import type { TaskDto, TriggersStatusDto, WatchedFolderDto } from '../../shared/ipc'
import { HOOK_SESSION_END_URL, SPOOL_DIR } from '../config'
import type { WatchedFolderStore } from '../ingest'
import type { WorkflowJobStatus, WorkflowRunner } from '../kernel'
import type { DurableTaskQueue, RuleLoadError, TriggerSchedules, TriggerWatchers } from '../triggers'
import { jsonObject } from './serialize'
import type { TaskDetailDto, WorkflowStatusDto } from './types'

/** ipc tasks.list: the durable §8 queue mirror, newest first. */
export function listTasks(db: BetterSqlite3.Database): TaskDto[] {
  const rows = db
    .prepare(
      `SELECT id, kind, status, attempts, not_before_unix_ms, last_error, created_at, updated_at
       FROM tasks ORDER BY updated_at DESC LIMIT 200`
    )
    .all() as {
    id: string
    kind: string
    status: TaskDto['status']
    attempts: number
    not_before_unix_ms: number | null
    last_error: string | null
    created_at: string
    updated_at: string
  }[]
  return rows.map(
    (row): TaskDto => ({
      id: row.id,
      kind: row.kind,
      status: row.status,
      attempts: row.attempts,
      notBeforeUnixMs: row.not_before_unix_ms,
      lastError: row.last_error,
      createdAt: row.created_at,
      updatedAt: row.updated_at
    })
  )
}

const workflowStatusDto = (job: WorkflowJobStatus): WorkflowStatusDto => ({
  jobId: job.jobId,
  workflowName: job.workflowName,
  status: job.status,
  attempts: job.attempts,
  lastError: job.lastError,
  state: jsonObject(job.state),
  nextSteps: job.nextSteps
})

export interface GetTaskDeps {
  readonly db: BetterSqlite3.Database
  /** Only needed for include_workflow; the workflow job id is `<taskId>-wf`. */
  readonly runner?: Pick<WorkflowRunner, 'getJob'>
}

export interface GetTaskArgs {
  readonly id: string
  readonly includeWorkflow?: boolean
}

/** get_task: one task row (payload included) + optionally its workflow job. */
export async function getTask(deps: GetTaskDeps, { id, includeWorkflow }: GetTaskArgs): Promise<TaskDetailDto | null> {
  const row = deps.db
    .prepare(
      `SELECT id, kind, status, attempts, not_before_unix_ms, priority, waiting_approval_id, payload_json,
              last_error, created_at, updated_at
       FROM tasks WHERE id = ?`
    )
    .get(id) as
    | {
        id: string
        kind: string
        status: TaskDto['status']
        attempts: number
        not_before_unix_ms: number | null
        priority: number
        waiting_approval_id: string | null
        payload_json: string | null
        last_error: string | null
        created_at: string
        updated_at: string
      }
    | undefined
  if (row === undefined) return null

  let payload: unknown = {}
  try {
    payload = JSON.parse(row.payload_json ?? '{}')
  } catch {
    payload = {}
  }

  let workflow: WorkflowStatusDto | null = null
  if (includeWorkflow === true && deps.runner !== undefined) {
    const job = await deps.runner.getJob(`${id}-wf`)
    workflow = job === undefined ? null : workflowStatusDto(job)
  }

  return {
    id: row.id,
    kind: row.kind,
    status: row.status,
    attempts: row.attempts,
    notBeforeUnixMs: row.not_before_unix_ms,
    lastError: row.last_error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    payload: jsonObject(payload),
    priority: row.priority,
    waitingApprovalId: row.waiting_approval_id,
    workflow
  }
}

/** The phase-11 trigger runtime the status channel reads (mirrors IpcTriggerDeps). */
export interface TriggerStatusDeps {
  readonly queue: DurableTaskQueue
  readonly schedules: TriggerSchedules
  readonly watchers: TriggerWatchers
  readonly ruleErrors: readonly RuleLoadError[]
}

export interface TriggersStatusArgs {
  readonly triggers: TriggerStatusDeps | null
  /** Test seam; defaults to ~/.claude/settings.json (the hook-install probe). */
  readonly claudeSettingsPath?: string
}

/** ipc triggers.status: queue counts + schedules + watchers + hook probe. */
export function getTriggersStatus(args: TriggersStatusArgs): TriggersStatusDto {
  const claudeSettingsPath = args.claudeSettingsPath ?? join(homedir(), '.claude', 'settings.json')
  let installed: boolean | null = null
  try {
    installed = readFileSync(claudeSettingsPath, 'utf8').includes('session-end.')
  } catch (err) {
    installed = (err as NodeJS.ErrnoException).code === 'ENOENT' ? false : null
  }
  const hook = {
    endpoint: HOOK_SESSION_END_URL,
    spoolDir: SPOOL_DIR,
    settingsPath: claudeSettingsPath,
    installed
  }
  const triggers = args.triggers
  if (triggers === null) {
    return {
      available: false,
      queue: { counts: {}, runningTaskId: null },
      schedules: [],
      watchedFolders: [],
      rules: [],
      ruleErrors: [],
      hook
    }
  }
  const watcherStatus = triggers.watchers.status()
  return {
    available: true,
    queue: { counts: triggers.queue.counts(), runningTaskId: triggers.queue.runningTaskId },
    schedules: triggers.schedules.status(),
    watchedFolders: watcherStatus.folders,
    rules: watcherStatus.rules,
    ruleErrors: triggers.ruleErrors.map((e) => ({ file: e.file, error: e.error })),
    hook
  }
}

/** ipc watch.list: the configured watched folders. */
export function listWatchedFolders(store: Pick<WatchedFolderStore, 'list'>): WatchedFolderDto[] {
  return store.list().map(
    (folder): WatchedFolderDto => ({
      name: folder.name,
      path: folder.path,
      tags: folder.tags,
      ...(folder.extensions !== undefined ? { extensions: folder.extensions } : {}),
      enabled: folder.enabled
    })
  )
}
