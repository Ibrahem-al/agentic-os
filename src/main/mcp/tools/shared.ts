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
import type { ProjectSummarizer } from '../../ingest'
import type { AuditLog, InjectionScanner } from '../../security'

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

/** Everything a tool handler may touch, resolved per transport session. */
export interface ToolContext {
  readonly engine: StorageEngine
  readonly retriever: Retriever
  readonly retrieval: RetrievalDeps
  /** The shared LOCAL small LLM (README → Project summary in ingest_codebase). */
  readonly llm: ProjectSummarizer
  /** appdata.db — staged_writes lives here (SQLite, not the graph). */
  readonly db: BetterSqlite3.Database
  /** MCP transport session id (also the §6 correlation key). */
  readonly sessionId: string
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
