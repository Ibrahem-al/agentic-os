/**
 * Shared spine for the composable MCP tool registry (§12).
 *
 * The tool surface is split across read/write/control modules; this file holds
 * the pieces every one of them needs — the error type, the per-session tool
 * context, the tool-def shape, and the two validation/schema helpers. `tools.ts`
 * re-exports everything here so external importers (`server.ts`, `mcp/index.ts`,
 * the phase-05 tests) keep importing from `../mcp/tools` unchanged.
 *
 * Handlers are plain async functions dispatched by the server's single CallTool
 * chokepoint (which owns kernel mediation + the mcp_calls log). Tool failures
 * throw ToolError with a stable code — the server turns any throw into a clean
 * structured MCP error result (§15: the orchestrator decides whether to retry
 * or adapt; no pause-and-notify).
 */
import * as z from 'zod'
import type BetterSqlite3 from 'better-sqlite3'
import type { StorageEngine } from '../../storage'
import type { RetrievalDeps, Retriever, BudgetGuard } from '../../retrieval'
import type { ProjectSummarizer, WatchedFolderStore } from '../../ingest'
import type { AuditLog, InjectionScanner } from '../../security'
import type { WorkflowRunner } from '../../kernel'
import type { Keychain, OllamaClient, ProviderRouter } from '../../models'
import type { DurableTaskQueue } from '../../triggers'
import type { ApprovalLister, RunnerStatusSource, TriggerStatusDeps } from '../../reads'
import type { AppStatusDto } from '../../../shared/ipc'

export type ToolErrorCode =
  | 'INVALID_INPUT'
  | 'NOT_FOUND'
  | 'NOT_IMPLEMENTED'
  | 'PERMISSION_DENIED'
  | 'INVALID_STATE'
  | 'INTERNAL'

/** A tool-level failure with a stable, machine-readable code. */
export class ToolError extends Error {
  readonly code: ToolErrorCode

  constructor(code: ToolErrorCode, message: string) {
    super(message)
    this.name = 'ToolError'
    this.code = code
  }
}

/**
 * The §4 read tools' late-bound dependencies — supplied via
 * `AgenticOsMcpServer.setReadContext` at the LAST boot step (bootIpc), once
 * every subsystem singleton exists and the subsystem snapshot is accurate.
 * Every field is optional: an un-wired server (or a pre-14b rig that never
 * calls the setter) keeps today's exact behavior, and a read tool whose dep is
 * missing returns a clean structured error instead of crashing. Additive by
 * construction — a default install is unchanged; the tools are merely newly
 * available.
 */
export interface McpReadContext {
  /** §13 approval lister (PermissionEngine) — list_approvals / get_pending_work. */
  readonly permissions?: ApprovalLister
  /** Workflow-job lookup for get_task's include_workflow (`<taskId>-wf`). */
  readonly runner?: Pick<WorkflowRunner, 'getJob'>
  /**
   * The phase-17 subscription-runner health source for get_runner_status
   * (distinct from `runner` above — that is the workflow runner). Absent = the
   * runner did not boot ⇒ get_runner_status reports the disabled/unknown shape.
   */
  readonly runnerStatus?: RunnerStatusSource
  /** Phase-11 trigger runtime for get_triggers_status (null = not armed this launch). */
  readonly triggers?: TriggerStatusDeps | null
  /** Watched-folder store for list_watched_folders + scan_watched_folder. */
  readonly watchedFolders?: Pick<WatchedFolderStore, 'list'>
  /**
   * The §8 durable task queue (phase-18 control/staging tools). Late-bound at
   * bootIpc (triggers boot before it). Absent ⇒ triggers did not boot ⇒ the
   * tools that enqueue (run_extraction / improve_skill_now / run_maintenance /
   * retry_task / propose_skill_revision / submit_extraction_items continuation)
   * return a clean INVALID_STATE rather than crashing.
   */
  readonly queue?: DurableTaskQueue
  /** Live Ollama health for get_app_status (null = model layer absent this launch). */
  readonly ollama?: Pick<OllamaClient, 'status'> | null
  /** Keychain — PRESENCE reads only — for get_settings_summary (null = absent). */
  readonly keychain?: Pick<Keychain, 'getApiKey'> | null
  /** Static app-status facts (version/platform/userDataDir/subsystems/mcpUrl). */
  readonly appStatus?: AppStatusDto
}

/** Everything a tool handler may touch, resolved per transport session. */
export interface ToolContext extends McpReadContext {
  readonly engine: StorageEngine
  readonly retriever: Retriever
  readonly retrieval: RetrievalDeps
  /** The shared LOCAL small LLM (README → Project summary in ingest_codebase). */
  readonly llm: ProjectSummarizer
  /**
   * Phase-16b: the ReasoningProvider router. ingest_codebase binds
   * `forRole('ingest.projectSummary', …)` off it (local-by-default ⇒ identical
   * to `llm`); absent ⇒ today's `llm`.
   */
  readonly router?: ProviderRouter
  /** appdata.db — staged_writes lives here (SQLite, not the graph). */
  readonly db: BetterSqlite3.Database
  /** MCP transport session id (also the §6 correlation key). */
  readonly sessionId: string
  /**
   * Runner sessions only (§14b P0.6 #3): the task id bound at initialize via
   * X-Agentic-Os-Runner-Task. submit_extraction_items keys its runner_submissions
   * rows to this already-running delegate task instead of synthesizing a
   * continuation. Undefined on interactive sessions ⇒ the continuation path.
   */
  readonly boundTaskId?: string
  /** §13 injection scanner for the ingest tools (phase 09; absent = no scan). */
  readonly scanner?: InjectionScanner
  /** §13 audit log — ingest writes record reversible deltas (phase 09). */
  readonly audit?: AuditLog
  /** P0.2 spend/call ceiling for live read-path budget (populated at boot). */
  readonly spendMeter?: BudgetGuard
}

export interface McpToolDef {
  readonly name: string
  readonly description: string
  /** JSON Schema advertised over tools/list (derived from the zod schema). */
  readonly inputSchema: Record<string, unknown>
  handle(args: unknown, ctx: ToolContext): Promise<unknown>
}

export function parse<T extends z.ZodType>(schema: T, args: unknown, tool: string): z.output<T> {
  const result = schema.safeParse(args ?? {})
  if (!result.success) {
    const detail = result.error.issues
      .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('; ')
    throw new ToolError('INVALID_INPUT', `invalid arguments for ${tool} — ${detail}`)
  }
  return result.data
}

/** JSON Schema for tools/list derives from the zod schema (zod is the validator). */
export const jsonSchema = (schema: z.ZodType): Record<string, unknown> =>
  z.toJSONSchema(schema) as Record<string, unknown>
