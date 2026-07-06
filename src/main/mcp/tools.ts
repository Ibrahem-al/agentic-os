/**
 * The §12 tool surface — a composable registry assembled from three modules:
 *
 *   read.ts     → get_context, search_memory, list_skills, get_skill
 *   write.ts    → propose_correction  (§21 rule 6: staged, never a direct write)
 *   control.ts  → ingest_document, ingest_codebase  (sanctioned §18 write paths)
 *
 * This file is the stable BARREL: `MCP_TOOLS` (the seven-tool v1 surface, in the
 * original order) plus every shared type/helper re-exported so `server.ts`,
 * `mcp/index.ts`, and the phase-05 tests keep importing from `../mcp/tools`
 * unchanged. Handlers are plain async functions dispatched by the server's
 * single CallTool chokepoint (which owns kernel mediation + the mcp_calls log).
 * Tool failures throw ToolError with a stable code — the server turns any throw
 * into a clean structured MCP error result (§15: the orchestrator decides
 * whether to retry or adapt; no pause-and-notify).
 *
 * Later phases add read/staging/control tools by extending the per-module DEFS.
 */
export {
  ToolError,
  parse,
  jsonSchema,
  type ToolErrorCode,
  type ToolContext,
  type McpReadContext,
  type McpToolDef
} from './tools/shared'
export { READ_TOOL_DEFS } from './tools/read'
export { WRITE_TOOL_DEFS } from './tools/write'
export { CONTROL_TOOL_DEFS } from './tools/control'

import type { McpToolDef } from './tools/shared'
import { READ_TOOL_DEFS } from './tools/read'
import { WRITE_TOOL_DEFS } from './tools/write'
import { CONTROL_TOOL_DEFS } from './tools/control'

/** The registry the server dispatches against — read, then write, then control. */
export const MCP_TOOLS: readonly McpToolDef[] = [...READ_TOOL_DEFS, ...WRITE_TOOL_DEFS, ...CONTROL_TOOL_DEFS]
