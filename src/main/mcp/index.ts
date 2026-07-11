/**
 * MCP barrel (§12) — the rest of the app imports from here. The MCP SDK never
 * leaks past this boundary (ESLint-enforced, like ryugraph and LangGraph).
 */
export { hashArgs, McpCallLog, stableStringify, type McpCallRecord } from './callLog'
export { McpClientManager, type ExternalMcpServer, type ExternalMcpTool, type McpClientManagerDeps } from './clients'
export {
  claudeMcpAddCommand,
  MCP_TOKEN_PLACEHOLDER,
  sampleMcpJson,
  writeSampleMcpJson
} from './connection'
export { AgenticOsMcpServer, RUNNER_SESSION_ALLOWLIST, type AgenticOsMcpServerDeps, type SessionEndHook } from './server'
export { MCP_TOOLS, ToolError, type McpToolDef, type ToolContext, type ToolErrorCode } from './tools'
