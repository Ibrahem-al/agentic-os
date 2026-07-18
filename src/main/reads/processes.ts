/**
 * Per-task process + resource read (task-control feature: "what process is running
 * for a task and how much RAM/CPU"). Shared by the `tasks.processes` IPC channel and
 * the `get_task_processes` MCP read tool.
 *
 * Three honest layers, because a background task's compute is not one process:
 *  - host: the app's OWN main process (Electron `app.getAppMetrics`, injected) —
 *    where the in-process tasks (extraction, ingest, skills, maintenance) actually
 *    run. Electron measures its CPU cross-platform, so this is the reliable readout.
 *  - localRuntime: the SHARED Ollama daemon's loaded models (`/api/ps`) — the
 *    local-model work a task drives; `sizeBytes`/`sizeVramBytes` are the memory each
 *    model holds. Shared across tasks, labelled as such.
 *  - children: the task's OWN runner `claude` children (runner_runs by task_id),
 *    sampled by pid. Rare (opt-in runner); RAM always, CPU where the OS gives it.
 *
 * Best-effort throughout: a daemon-down probe, a vanished pid, or a sampler failure
 * degrades to empty/null — a resource read never throws.
 */
import type BetterSqlite3 from 'better-sqlite3'
import type {
  LocalLoadedModelDto,
  TaskChildProcessDto,
  TaskHostProcessDto,
  TaskProcessesDto,
  TaskSummaryDto
} from '../../shared/ipc'
import type { LocalUsageOllama } from './localUsage'
import type { ProcResourceSample } from './processSampler'

export interface TaskProcessesDeps {
  readonly db: BetterSqlite3.Database
  /** The model layer (ps + status); null when it did not boot. */
  readonly ollama?: LocalUsageOllama | null
  /** The app's main-process metrics (Electron app.getAppMetrics), or null in a test/headless rig. */
  readonly hostMetrics: () => TaskHostProcessDto | null
  /** Sample a live child pid; returns null when it does not resolve. */
  readonly sampleProcess: (pid: number) => Promise<ProcResourceSample | null>
  /** The queue's current in-flight task id (for the `running` flag + the id default). */
  readonly runningTaskId: () => string | null
}

export interface TaskProcessesArgs {
  /** The task to inspect; omitted ⇒ the current in-flight task (null host of children when idle). */
  readonly id?: string
}

/** Cap on child rows sampled per read (a task rarely spawns more than a couple). */
const MAX_CHILDREN = 20

/** LIKE-prefix for a task's own workflow/runner children (`<id>-...`), wildcards escaped. */
const childLikePrefix = (taskId: string): string => `${taskId.replace(/[\\%_]/g, '\\$&')}-%`

/** Parse two ISO stamps into a non-negative elapsed-ms, or null when either is unusable. */
function elapsedMs(fromIso: string | null, toMs: number): number | null {
  if (fromIso === null) return null
  const from = Date.parse(fromIso)
  if (Number.isNaN(from)) return null
  const ms = toMs - from
  return Number.isFinite(ms) && ms >= 0 ? ms : null
}

interface TaskSummaryRow {
  status: TaskSummaryDto['status']
  kind: string
  attempts: number
  started_at: string | null
  updated_at: string
  last_error: string | null
}

/**
 * The "averages and time it took" summary for one task — duration (last run),
 * the typical duration for its kind, and any AI usage keyed to it (cloud spend +
 * runner_runs; the local reasoning tier is not attributable per task). Pure DB,
 * fully guarded: a missing row or query hiccup yields null rather than throwing.
 */
function buildTaskSummary(db: BetterSqlite3.Database, taskId: string, running: boolean): TaskSummaryDto | null {
  let row: TaskSummaryRow | undefined
  try {
    row = db
      .prepare(`SELECT status, kind, attempts, started_at, updated_at, last_error FROM tasks WHERE id = ?`)
      .get(taskId) as TaskSummaryRow | undefined
  } catch {
    return null
  }
  if (row === undefined) return null

  // Duration = the last run's execution time. `updated_at` is a reliable run-end
  // ONLY for a genuinely terminal row (done/failed/cancelled) — its timestamp is
  // frozen at settle. A paused/deferred/pending row can have `updated_at` bumped by
  // a LATER transition (a pause, or a restart re-pend) while `started_at` stays put,
  // which would inflate the span across the idle gap — so those report null rather
  // than a fabricated duration. A running task is timed live.
  const terminal = row.status === 'done' || row.status === 'failed' || row.status === 'cancelled'
  const durationMs = running
    ? elapsedMs(row.started_at, Date.now())
    : terminal
      ? elapsedMs(row.started_at, Date.parse(row.updated_at))
      : null
  const finishedAt = terminal && row.started_at !== null ? row.updated_at : null

  // Typical duration for this KIND — mean over recent finished runs (JS avoids
  // any julianday timezone-suffix ambiguity). Under 2 samples there is no "typical".
  let kindAvgDurationMs: number | null = null
  let kindSampleSize = 0
  try {
    const rows = db
      .prepare(
        `SELECT started_at, updated_at FROM tasks
         WHERE kind = ? AND status = 'done' AND started_at IS NOT NULL
         ORDER BY updated_at DESC LIMIT 50`
      )
      .all(row.kind) as { started_at: string; updated_at: string }[]
    const durations = rows
      .map((r) => elapsedMs(r.started_at, Date.parse(r.updated_at)))
      .filter((d): d is number => d !== null)
    kindSampleSize = durations.length
    if (durations.length >= 2) kindAvgDurationMs = durations.reduce((a, b) => a + b, 0) / durations.length
  } catch {
    /* no kind average — leave null */
  }

  // Attributable AI usage: cloud spend (task_id) + runner_runs (task_id + its `<id>-*` children).
  let cloud: TaskSummaryDto['cloud'] = null
  try {
    const c = db
      .prepare(
        `SELECT COUNT(*) AS calls, COALESCE(SUM(input_tokens),0) AS it,
                COALESCE(SUM(output_tokens),0) AS ot, COALESCE(SUM(usd),0) AS usd
         FROM spend WHERE task_id = ?`
      )
      .get(taskId) as { calls: number; it: number; ot: number; usd: number }
    if (c.calls > 0) cloud = { calls: c.calls, inputTokens: c.it, outputTokens: c.ot, usd: c.usd }
  } catch {
    /* leave cloud null */
  }

  let runner: TaskSummaryDto['runner'] = null
  try {
    const r = db
      .prepare(
        `SELECT COUNT(*) AS runs, COALESCE(SUM(input_tokens),0) AS it, COALESCE(SUM(output_tokens),0) AS ot
         FROM runner_runs WHERE task_id = ? OR task_id LIKE ? ESCAPE '\\'`
      )
      .get(taskId, childLikePrefix(taskId)) as { runs: number; it: number; ot: number }
    if (r.runs > 0) runner = { runs: r.runs, inputTokens: r.it, outputTokens: r.ot }
  } catch {
    /* leave runner null */
  }

  return {
    status: row.status,
    kind: row.kind,
    attempts: row.attempts,
    startedAt: row.started_at,
    finishedAt,
    durationMs,
    running,
    kindAvgDurationMs,
    kindSampleSize,
    lastError: row.last_error,
    cloud,
    runner
  }
}

interface RunnerRunRow {
  task_id: string
  pid: number | null
  mode: string
  started_at: string
  is_error: number | null
  exit_code: number | null
}

export async function getTaskProcesses(deps: TaskProcessesDeps, args: TaskProcessesArgs = {}): Promise<TaskProcessesDto> {
  const runningId = deps.runningTaskId()
  const taskId = args.id ?? runningId ?? null
  const running = taskId !== null && runningId === taskId

  // localRuntime — the shared Ollama daemon's loaded models (memory per model).
  let loadedModels: readonly LocalLoadedModelDto[] = []
  let reachable = false
  if (deps.ollama) {
    const ollama = deps.ollama
    loadedModels = await ollama.ps().catch((): LocalLoadedModelDto[] => [])
    reachable = await ollama
      .status()
      .then((s) => s.state !== 'daemon-not-running')
      .catch(() => false)
  }

  // children — the task's own runner child processes (runner_runs by task_id; also
  // its `<taskId>-wf` workflow-job completion calls). Live rows are sampled by pid.
  // Fully guarded: a DB/sampler hiccup degrades to no-children, never a thrown read.
  const children: TaskChildProcessDto[] = []
  if (taskId !== null) {
    try {
      // Escape LIKE wildcards in the id so a `_`/`%` in a task id can't over-match.
      const likePrefix = `${taskId.replace(/[\\%_]/g, '\\$&')}-%`
      const rows = deps.db
        .prepare(
          `SELECT task_id, pid, mode, started_at, is_error, exit_code
           FROM runner_runs WHERE task_id = ? OR task_id LIKE ? ESCAPE '\\'
           ORDER BY started_at DESC LIMIT ?`
        )
        .all(taskId, likePrefix, MAX_CHILDREN) as RunnerRunRow[]
      for (const row of rows) {
        const live = row.is_error === null && row.exit_code === null
        let sample: ProcResourceSample | null = null
        if (live && row.pid !== null) {
          sample = await deps.sampleProcess(row.pid).catch(() => null)
        }
        children.push({
          pid: row.pid,
          role: `runner:${row.mode}`,
          startedAt: row.started_at,
          live,
          cpuPercent: sample?.cpuPercent ?? null,
          memoryBytes: sample?.memoryBytes ?? null
        })
      }
    } catch {
      /* best-effort telemetry — leave children empty rather than fail the read */
    }
  }

  return {
    taskId,
    running,
    summary: taskId !== null ? buildTaskSummary(deps.db, taskId, running) : null,
    host: safeHost(deps),
    localRuntime: { reachable, loadedModels },
    children,
    sampledAt: new Date().toISOString()
  }
}

/** app.getAppMetrics can throw in odd states — a host-metrics failure must not sink the read. */
function safeHost(deps: TaskProcessesDeps): TaskHostProcessDto | null {
  try {
    return deps.hostMetrics()
  } catch {
    return null
  }
}
