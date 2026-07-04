/**
 * Kernel types (§9, §10, §13-shape) — the thin interfaces every background
 * agent codes against. Agent code never imports LangGraph directly (§9); it
 * sees WorkflowRunner / WorkflowStep / ActionExecutor only, so the runner
 * implementation stays swappable exactly like the storage engine (§5).
 */

/** Workflow state: a JSON-serializable plain object (checkpointed as-is). */
export type JsonObject = Record<string, unknown>

export interface WorkflowStepContext {
  readonly jobId: string
  readonly workflowName: string
  readonly stepName: string
  /** 0-based position of this step in the defined step list. */
  readonly stepIndex: number
}

/**
 * One step of a background agent's plain step list (§9). `run` receives the
 * accumulated state and returns a patch that is shallow-merged into it (or
 * void for a pure side-effect step).
 */
export interface WorkflowStep {
  readonly name: string
  run(state: JsonObject, ctx: WorkflowStepContext): Promise<JsonObject | void> | JsonObject | void
}

export interface RunWorkflowOptions {
  /**
   * Caller-supplied job id (e.g. the phase-11 scheduler pre-creating task
   * rows, or tests that must know the id before completion). Defaults to a
   * random UUID.
   */
  jobId?: string
  /** Attributed agent for permission checks / spans. Default 'system'. */
  agentId?: string
}

/** Durable job record + live graph state, for the dashboard and scheduler. */
export interface WorkflowJobStatus {
  readonly jobId: string
  readonly workflowName: string
  readonly status: 'pending' | 'running' | 'done' | 'failed' | 'deferred'
  readonly attempts: number
  readonly lastError: string | null
  /** Latest checkpointed workflow state (empty object before any step ran). */
  readonly state: JsonObject
  /** Step names the graph would execute next; empty when complete. */
  readonly nextSteps: readonly string[]
}

/**
 * The workflow-runner interface (§9). `run`/`resume` resolve with the job id
 * once the job finishes; failures reject with WorkflowJobError after the
 * durable job record is marked failed (retry/backoff policy is the phase-11
 * scheduler's job, §15).
 */
export interface WorkflowRunner {
  define(name: string, steps: readonly WorkflowStep[]): void
  run(name: string, input: JsonObject, options?: RunWorkflowOptions): Promise<string>
  /**
   * Continue a job from its last checkpoint (crash, kill, or failure). The
   * workflow must have been define()d in this process first — definitions are
   * code, only state is durable.
   */
  resume(jobId: string): Promise<string>
  getJob(jobId: string): Promise<WorkflowJobStatus | undefined>
}

/** A workflow step failed; the job record is already marked 'failed'. */
export class WorkflowJobError extends Error {
  readonly jobId: string
  readonly workflowName: string

  constructor(jobId: string, workflowName: string, cause: unknown) {
    const detail = cause instanceof Error ? cause.message : String(cause)
    super(`workflow '${workflowName}' job ${jobId} failed: ${detail}`, cause === undefined ? undefined : { cause })
    this.name = 'WorkflowJobError'
    this.jobId = jobId
    this.workflowName = workflowName
  }
}

// ── Kernel actions (§13 chokepoint shape; enforcement lands in PHASE-09) ────

export type KernelActionKind =
  | 'workflow-step'
  | 'model-call'
  | 'tool-call'
  | 'storage-read'
  | 'storage-write'
  | 'retrieval'
  | 'mcp-call'

export interface KernelAction {
  readonly kind: KernelActionKind
  readonly name: string
  /** Extra span attributes (string/number/boolean only). */
  readonly attributes?: Readonly<Record<string, string | number | boolean>>
}

export interface PermissionDecision {
  readonly allowed: boolean
  readonly reason: string
}

export interface AuditEvent {
  /** ISO-8601 timestamp. */
  readonly at: string
  readonly agentId: string
  readonly action: KernelAction
  readonly decision: PermissionDecision
  readonly outcome: 'ok' | 'error'
  readonly durationMs: number
  readonly error?: string
}

// PHASE-09: the real audit log records reversible deltas (§13 undo). This
// hook is the seam it will plug into; phase 04 ships an in-memory stub.
export interface AuditHook {
  record(event: AuditEvent): void
}

/**
 * The one chokepoint every agent action goes through (§13 "enforced at the
 * kernel boundary"). Kernel implements it; the runner and later phases depend
 * on this interface, never on Kernel directly.
 */
export interface ActionExecutor {
  execute<T>(agentId: string, action: KernelAction, fn: () => Promise<T> | T): Promise<T>
}

/** Satisfied by OllamaClient — the LOCAL tier the summarizer must use (§10). */
export interface SummarizerLlm {
  generate(
    prompt: string,
    options?: { system?: string; maxTokens?: number; temperature?: number }
  ): Promise<{ text: string }>
}
