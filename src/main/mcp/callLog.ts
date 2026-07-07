/**
 * The MCP call log (§6 "reliable backbone", §12): one `mcp_calls` row per tool
 * invocation — tool, args hash (+ the args JSON when small enough), transport
 * session id, timestamp, duration, ok/err. The server's single CallTool
 * chokepoint writes here in a `finally`, so a tool cannot run — succeed, fail,
 * or refuse validation — without leaving a row (phase-05 DoD).
 *
 * better-sqlite3 writes are synchronous: the row is committed before the tool
 * result leaves the process.
 */
import { createHash } from 'node:crypto'
import type BetterSqlite3 from 'better-sqlite3'
import { MCP_CALL_ARGS_JSON_MAX_BYTES } from '../config'

/**
 * Deterministic JSON: object keys sorted recursively so the same args always
 * hash the same regardless of client-side key order.
 */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null'
  if (Array.isArray(value)) return `[${value.map((v) => stableStringify(v)).join(',')}]`
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`)
  return `{${entries.join(',')}}`
}

/** `sha256:<hex>` of the stable-stringified args. */
export function hashArgs(args: unknown): string {
  return `sha256:${createHash('sha256').update(stableStringify(args), 'utf8').digest('hex')}`
}

export interface McpCallRecord {
  readonly sessionId: string
  readonly tool: string
  readonly args: unknown
  readonly resultStatus: 'ok' | 'error'
  /** Present when resultStatus is 'error'. */
  readonly error?: string
  readonly startedUnixMs: number
  readonly durationMs: number
  /**
   * Which kind of MCP session made the call — 'runner' rows let the §6
   * inactivity sweep skip a headless runner's own session (phase 14,
   * MCP-COVERAGE §10.2/P0.5). Interactive callers pass nothing ⇒ NULL.
   */
  readonly sessionKind?: string | null
}

export class McpCallLog {
  private readonly insert: BetterSqlite3.Statement

  constructor(db: BetterSqlite3.Database) {
    this.insert = db.prepare(
      `INSERT INTO mcp_calls (session_id, session_kind, tool, params_json, args_hash, result_status, error, started_unix_ms, duration_ms)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
  }

  record(call: McpCallRecord): void {
    const json = stableStringify(call.args)
    // The hash is always stored; the args JSON only when small (§6 wants the
    // args for extraction, but ingest_document can carry whole documents).
    const paramsJson = Buffer.byteLength(json, 'utf8') <= MCP_CALL_ARGS_JSON_MAX_BYTES ? json : null
    this.insert.run(
      call.sessionId,
      call.sessionKind ?? null,
      call.tool,
      paramsJson,
      hashArgs(call.args),
      call.resultStatus,
      call.error ?? null,
      call.startedUnixMs,
      Math.round(call.durationMs)
    )
  }
}
