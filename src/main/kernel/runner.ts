/**
 * LangGraphRunner — the §9 workflow runner. Background agents are plain step
 * lists (WorkflowStep[]); this module is the ONLY place LangGraph is imported
 * (ESLint-enforced, same swap-ability principle as the storage abstraction).
 *
 * Durability (§10): state checkpoints into appdata.db via SqliteCheckpointSaver
 * with durability 'sync' — the post-step checkpoint is committed before the
 * next step starts, so a job killed mid-step resumes from the last completed
 * step. Job records live in the §8 `tasks` table (a workflow job IS a task);
 * a crash leaves the row 'running', and resume() accepts it.
 *
 * Tracing (§9): one root span per run/resume; every step executes through the
 * ActionExecutor chokepoint (span per action + PHASE-09 permission seam). The
 * root span's trace/span ids persist in the job payload, so a resume in a new
 * process continues the original trace (remote parent context).
 *
 * Scheduling (§8): an optional injected yieldPoint is awaited at every step
 * boundary, so a running multi-step job cooperatively yields to live MCP work
 * without any mid-step preemption (see yield.ts / createInflightYield).
 */
import { randomUUID } from 'node:crypto'
import type BetterSqlite3 from 'better-sqlite3'
import {
  Annotation,
  END,
  START,
  StateGraph,
  type CompiledStateGraph,
  type LangGraphRunnableConfig
} from '@langchain/langgraph'
import type { Telemetry } from '../telemetry'
import { SqliteCheckpointSaver } from './checkpointer'
import {
  WorkflowCancelledError,
  WorkflowJobError,
  type ActionExecutor,
  type JsonObject,
  type ResumeWorkflowOptions,
  type RunWorkflowOptions,
  type WorkflowJobStatus,
  type WorkflowRunner,
  type WorkflowStep
} from './types'

/** Whole workflow state rides one channel; step patches shallow-merge. */
const WorkflowAnnotation = Annotation.Root({
  data: Annotation<JsonObject>({
    reducer: (left: JsonObject, right: JsonObject) => ({ ...left, ...right }),
    default: () => ({})
  })
})
type WorkflowGraphState = typeof WorkflowAnnotation.State

/** Compiled graphs are stored behind this loose alias — node-name literal
 * typing does not survive dynamic step lists, and nothing outside this file
 * ever sees the compiled graph. */
type CompiledWorkflow = CompiledStateGraph<WorkflowGraphState, Partial<WorkflowGraphState>, string>

const RESERVED_STEP_NAMES = new Set<string>([START, END])

interface TaskRow {
  id: string
  kind: string
  payload_json: string | null
  status: WorkflowJobStatus['status']
  attempts: number
  last_error: string | null
}

interface JobPayload {
  workflow: string
  agentId: string
  input: JsonObject
  /** Root span of the original run — resumes join this trace. */
  trace?: { traceId: string; spanId: string }
}

export interface LangGraphRunnerDeps {
  db: BetterSqlite3.Database
  telemetry: Telemetry
  executor: ActionExecutor
  /**
   * §8 cooperative yield at step boundaries only — awaited before each step's
   * work (production wires createInflightYield over the live MCP inflight
   * counter). Optional: absent = the runner never waits.
   */
  yieldPoint?: () => Promise<void>
}

export class LangGraphRunner implements WorkflowRunner {
  private readonly definitions = new Map<string, readonly WorkflowStep[]>()
  private readonly compiled = new Map<string, CompiledWorkflow>()
  /**
   * jobId → the live run's cancel signal. Set before invoke, deleted after, and
   * read by the node closure (the compiled graph is shared across runs, so the
   * per-run signal cannot ride the closure). Not persisted — a resume re-supplies it.
   */
  private readonly activeSignals = new Map<string, AbortSignal>()
  private readonly checkpointer: SqliteCheckpointSaver
  private readonly telemetry: Telemetry
  private readonly executor: ActionExecutor
  private readonly yieldPoint: (() => Promise<void>) | undefined
  private readonly insertJob: BetterSqlite3.Statement
  private readonly selectJob: BetterSqlite3.Statement
  private readonly updatePayload: BetterSqlite3.Statement
  private readonly markStatus: BetterSqlite3.Statement
  private readonly bumpAttempts: BetterSqlite3.Statement

  constructor(deps: LangGraphRunnerDeps) {
    this.telemetry = deps.telemetry
    this.executor = deps.executor
    this.yieldPoint = deps.yieldPoint
    this.checkpointer = new SqliteCheckpointSaver(deps.db)
    this.insertJob = deps.db.prepare(
      `INSERT INTO tasks (id, kind, payload_json, status, attempts) VALUES (?, 'workflow', ?, 'running', 1)`
    )
    this.selectJob = deps.db.prepare(
      `SELECT id, kind, payload_json, status, attempts, last_error FROM tasks WHERE id = ?`
    )
    this.updatePayload = deps.db.prepare(
      `UPDATE tasks SET payload_json = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?`
    )
    this.markStatus = deps.db.prepare(
      `UPDATE tasks SET status = ?, last_error = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?`
    )
    this.bumpAttempts = deps.db.prepare(
      `UPDATE tasks SET status = 'running', attempts = attempts + 1,
         updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?`
    )
  }

  define(name: string, steps: readonly WorkflowStep[]): void {
    if (name.trim() === '') throw new Error('workflow name must be non-empty')
    if (this.definitions.has(name)) {
      throw new Error(`workflow '${name}' is already defined — redefinition is a programming error`)
    }
    if (steps.length === 0) throw new Error(`workflow '${name}' must have at least one step`)
    const seen = new Set<string>()
    for (const step of steps) {
      if (step.name.trim() === '') throw new Error(`workflow '${name}' has a step with an empty name`)
      if (RESERVED_STEP_NAMES.has(step.name)) {
        throw new Error(`workflow '${name}' step name '${step.name}' is reserved`)
      }
      if (seen.has(step.name)) throw new Error(`workflow '${name}' has duplicate step name '${step.name}'`)
      seen.add(step.name)
    }
    this.definitions.set(name, [...steps])
  }

  /** Build (once) the linear LangGraph state machine for a defined workflow. */
  private compiledFor(name: string): CompiledWorkflow {
    const cached = this.compiled.get(name)
    if (cached !== undefined) return cached
    const steps = this.definitions.get(name)
    if (steps === undefined) {
      throw new Error(
        `workflow '${name}' is not defined in this process — call define() first (definitions are code; only state is durable)`
      )
    }

    // Dynamic step lists defeat LangGraph's literal node-name typing; the
    // builder is validated at runtime by define() instead.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let builder: any = new StateGraph(WorkflowAnnotation)
    for (const [index, step] of steps.entries()) {
      const node = async (state: WorkflowGraphState, config: LangGraphRunnableConfig): Promise<Partial<WorkflowGraphState>> => {
        const jobId = (config.configurable?.['thread_id'] as string | undefined) ?? 'unknown'
        const agentId = (config.configurable?.['agent_id'] as string | undefined) ?? 'system'
        const signal = this.activeSignals.get(jobId)
        // §8 cooperative CANCEL at step boundaries: if the run's signal fired, stop
        // HERE (before this step's work) with a WorkflowCancelledError. The previous
        // step's checkpoint is already durable, so a cancelled run resumes cleanly
        // from it. A step may also thread `signal` into a blocking model call so an
        // in-flight embed/generate aborts immediately rather than at this boundary.
        if (signal?.aborted === true) throw new WorkflowCancelledError(jobId, name)
        // §8 cooperative yield at step boundaries only: this runs after the
        // previous step's checkpoint is durable (durability 'sync') and
        // before this step does any work, so it cannot corrupt or reorder
        // checkpoints; both run() and resume() flow through this same node
        // closure. Awaited BEFORE kernel.execute so the step span's timing
        // stays honest — the wait is never billed to the step.
        if (this.yieldPoint !== undefined) await this.yieldPoint()
        const patch = await this.executor.execute(
          agentId,
          {
            kind: 'workflow-step',
            name: step.name,
            attributes: {
              'workflow.name': name,
              'workflow.job_id': jobId,
              'workflow.step_index': index
            }
          },
          () =>
            step.run(state.data, {
              jobId,
              workflowName: name,
              stepName: step.name,
              stepIndex: index,
              ...(signal !== undefined ? { signal } : {})
            })
        )
        return { data: patch ?? {} }
      }
      builder = builder.addNode(step.name, node)
      builder = builder.addEdge(index === 0 ? START : steps[index - 1]!.name, step.name)
    }
    builder = builder.addEdge(steps[steps.length - 1]!.name, END)
    const graph = (builder as { compile(options: { checkpointer: SqliteCheckpointSaver }): CompiledWorkflow }).compile({
      checkpointer: this.checkpointer
    })
    this.compiled.set(name, graph)
    return graph
  }

  private readJob(jobId: string): { row: TaskRow; payload: JobPayload } | undefined {
    const row = this.selectJob.get(jobId) as TaskRow | undefined
    if (row === undefined) return undefined
    if (row.kind !== 'workflow') {
      throw new Error(`task ${jobId} has kind '${row.kind}', not 'workflow'`)
    }
    const payload = JSON.parse(row.payload_json ?? '{}') as JobPayload
    return { row, payload }
  }

  async run(name: string, input: JsonObject, options: RunWorkflowOptions = {}): Promise<string> {
    const graph = this.compiledFor(name)
    if (input === null || typeof input !== 'object' || Array.isArray(input)) {
      throw new Error(`workflow input must be a plain JSON object`)
    }
    JSON.stringify(input) // throws early on circular/unserializable input
    const jobId = options.jobId ?? randomUUID()
    const agentId = options.agentId ?? 'system'
    const payload: JobPayload = { workflow: name, agentId, input }
    try {
      this.insertJob.run(jobId, JSON.stringify(payload))
    } catch (err) {
      if (err instanceof Error && err.message.includes('UNIQUE')) {
        throw new Error(`job id '${jobId}' already exists in the tasks table`)
      }
      throw err
    }

    if (options.signal !== undefined) this.activeSignals.set(jobId, options.signal)
    try {
      await this.telemetry.withSpan(
        'workflow.run',
        { 'workflow.name': name, 'workflow.job_id': jobId, 'agent.id': agentId },
        async (span) => {
          // Persist the root span BEFORE running: a killed process must leave
          // enough behind for resume() to continue this trace.
          const spanContext = span.spanContext()
          payload.trace = { traceId: spanContext.traceId, spanId: spanContext.spanId }
          this.updatePayload.run(JSON.stringify(payload), jobId)
          await graph.invoke(
            { data: input },
            { configurable: { thread_id: jobId, agent_id: agentId }, durability: 'sync' }
          )
        }
      )
    } catch (err) {
      this.settleFailure(jobId, err, options.signal)
      throw new WorkflowJobError(jobId, name, err)
    } finally {
      this.activeSignals.delete(jobId)
    }
    this.markStatus.run('done', null, jobId)
    return jobId
  }

  async resume(jobId: string, options: ResumeWorkflowOptions = {}): Promise<string> {
    const job = this.readJob(jobId)
    if (job === undefined) throw new Error(`no job '${jobId}' in the tasks table`)
    const { row, payload } = job
    if (row.status === 'done') return jobId // completed jobs resume as a no-op
    const graph = this.compiledFor(payload.workflow)
    this.bumpAttempts.run(jobId)
    if (options.signal !== undefined) this.activeSignals.set(jobId, options.signal)

    const parent = payload.trace !== undefined
      ? { parent: this.telemetry.remoteParentContext(payload.trace.traceId, payload.trace.spanId) }
      : {}
    try {
      await this.telemetry.withSpan(
        'workflow.resume',
        { 'workflow.name': payload.workflow, 'workflow.job_id': jobId, 'agent.id': payload.agentId },
        async () => {
          // null input = continue from the latest checkpoint (§10).
          await graph.invoke(null, {
            configurable: { thread_id: jobId, agent_id: payload.agentId },
            durability: 'sync'
          })
        },
        parent
      )
    } catch (err) {
      this.settleFailure(jobId, err, options.signal)
      throw new WorkflowJobError(jobId, payload.workflow, err)
    } finally {
      this.activeSignals.delete(jobId)
    }
    this.markStatus.run('done', null, jobId)
    return jobId
  }

  /**
   * Mark the job's row terminal after a run/resume threw: 'cancelled' when the
   * failure was the §8 cooperative cancel (a WorkflowCancelledError from the
   * boundary check, OR a lower-level abort that fired because the run's signal
   * aborted — e.g. an aborted Ollama fetch), else 'failed'. This is the ONLY
   * writer of the terminal status on the failure path.
   */
  private settleFailure(jobId: string, err: unknown, signal?: AbortSignal): void {
    const cancelled = err instanceof WorkflowCancelledError || signal?.aborted === true
    this.markStatus.run(cancelled ? 'cancelled' : 'failed', err instanceof Error ? err.message : String(err), jobId)
  }

  /**
   * Settle a job's row to 'done' without running it — a workflow that legitimately
   * had nothing to do (e.g. an extraction whose session has no calls and no
   * transcript, whose collect step threw NOT_FOUND). Keeps a benign no-op from
   * lingering as a 'failed' row. Idempotent; a no-op if the row is absent.
   */
  resolveNoop(jobId: string): void {
    const job = this.readJob(jobId)
    if (job === undefined) return
    // Defensive: only settle a job that has already stopped (its caller is a
    // post-failure path); never flip a live 'running' job or re-touch a 'done' one.
    if (job.row.status === 'running' || job.row.status === 'done') return
    this.markStatus.run('done', null, jobId)
  }

  async getJob(jobId: string): Promise<WorkflowJobStatus | undefined> {
    const job = this.readJob(jobId)
    if (job === undefined) return undefined
    const { row, payload } = job

    let state: JsonObject = {}
    let nextSteps: readonly string[] = []
    if (this.definitions.has(payload.workflow)) {
      const snapshot = await this.compiledFor(payload.workflow).getState({ configurable: { thread_id: jobId } })
      state = (snapshot.values as WorkflowGraphState | undefined)?.data ?? {}
      nextSteps = snapshot.next
    } else {
      // Definition not registered in this process: read the raw checkpoint.
      const tuple = await this.checkpointer.getTuple({ configurable: { thread_id: jobId } })
      state = (tuple?.checkpoint.channel_values['data'] as JsonObject | undefined) ?? {}
    }
    return {
      jobId,
      workflowName: payload.workflow,
      status: row.status,
      attempts: row.attempts,
      lastError: row.last_error,
      state,
      nextSteps
    }
  }
}
