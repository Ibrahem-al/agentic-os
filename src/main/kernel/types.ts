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

// ── Kernel actions (§13 chokepoint shape; enforced by the phase-09 engine) ──

/**
 * The §13 capability declaration — the single source of truth for both the
 * kernel's permission gates AND the sandbox lanes (§11: Deno permission flags
 * and Docker mounts/network policy derive from this same object). The zod
 * schema that validates untrusted declarations (user rule files) lives in
 * security/capabilities.ts; this interface is the dependency-free contract.
 * Empty arrays / zero = default-deny.
 */
export interface CapabilityDeclaration {
  /** Absolute folder/file paths the agent may read. */
  readonly fsRead: readonly string[]
  /** Absolute folder/file paths the agent may create/modify files under. */
  readonly fsWrite: readonly string[]
  /** Network hosts (`host` or `host:port`, Deno --allow-net grammar). */
  readonly netDomains: readonly string[]
  /** Tool names the agent may invoke through the tool manager. */
  readonly tools: readonly string[]
  /** Cloud-spend ceiling for the agent's tasks (USD). */
  readonly maxSpendUSD: number
}

export type KernelActionKind =
  | 'workflow-step'
  | 'model-call'
  | 'tool-call'
  | 'storage-read'
  | 'storage-write'
  | 'retrieval'
  | 'mcp-call'
  // phase-09 scope-checked kinds (§13 tiered gates):
  | 'fs-read'
  | 'fs-write'
  | 'net'
  | 'spend'
  | 'sandbox-run'

export interface KernelAction {
  readonly kind: KernelActionKind
  readonly name: string
  /** Extra span attributes (string/number/boolean only). */
  readonly attributes?: Readonly<Record<string, string | number | boolean>>
  // ── §13 scope facts (checked against the agent's CapabilityDeclaration) ──
  /** Filesystem paths touched (fs-read / fs-write actions). */
  readonly paths?: readonly string[]
  /** Network host (`host` or `host:port`) contacted (net actions). */
  readonly host?: string
  /** Cloud spend requested in USD (spend actions). */
  readonly usd?: number
  /** The capabilities a sandbox run is requesting (sandbox-run actions). */
  readonly sandbox?: { readonly capabilities: CapabilityDeclaration }
}

export interface PermissionDecision {
  readonly allowed: boolean
  readonly reason: string
  /**
   * Set when the action is queued behind a §13 pending-approval row (the
   * dashboard surfaces it; headless it stays queued). `allowed` is false —
   * the caller may retry the same action after approval.
   */
  readonly pendingApprovalId?: string
}

/**
 * The §13 permission engine contract the Kernel consults before every action.
 * Implemented by security/PermissionEngine (capability-based, default-deny,
 * tiered gates); tests may use allow-all stand-ins where permissions are not
 * under test.
 */
export interface PermissionChecker {
  check(agentId: string, action: KernelAction): PermissionDecision
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
