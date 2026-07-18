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
import type { LocalLoadedModelDto, TaskChildProcessDto, TaskHostProcessDto, TaskProcessesDto } from '../../shared/ipc'
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
