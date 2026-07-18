/**
 * Observability reads (§4.D) — the shared source for the dashboard's
 * `audit.list` / `traces.recent` / `traces.spans` / `spend.summary` handlers
 * AND the `list_audit_log` / `list_traces` / `get_trace` / `get_usage` read
 * tools. `audit.undo` is deliberately NOT here — reads never mutate.
 *
 * audit/traces/spend are extracted verbatim from `ipc.ts`; getUsage composes
 * the spend summary with a `runner_runs` rollup (shadow cost labeled an
 * estimate — subscription runs create no spend rows; empty until runs exist).
 */
import type BetterSqlite3 from 'better-sqlite3'
import type {
  AuditActionDto,
  AuditKindDto,
  SpendEntryDto,
  SpendSummaryDto,
  TraceSpanDto,
  TraceSummaryDto
} from '../../shared/ipc'
import { SPEND_CEILING_USD_DEFAULT } from '../config'
import type { AuditLog } from '../security'
import { jsonObject } from './serialize'
import type { RunnerRunDto, RunnerUsageDto, UsageDto } from './types'

/** ipc audit.list: the audit/undo timeline, newest first (never audit.undo). */
export function listAuditLog(
  audit: Pick<AuditLog, 'listActions'>,
  args: { kind?: AuditKindDto; agentId?: string } = {}
): AuditActionDto[] {
  const rows = audit.listActions({
    ...(args.kind !== undefined ? { kind: args.kind } : {}),
    ...(args.agentId !== undefined ? { agentId: args.agentId } : {})
  })
  // Newest first for the timeline (listActions returns oldest-first).
  return rows
    .slice()
    .reverse()
    .map(
      (row): AuditActionDto => ({
        id: row.id,
        agentId: row.agentId,
        kind: row.kind,
        description: row.description,
        reversible: row.reversible,
        outcome: row.outcome,
        error: row.error,
        details: jsonObject(row.details),
        undoneAt: row.undoneAt,
        undoActionId: row.undoActionId,
        createdAt: row.createdAt
      })
    )
}

/** ipc traces.recent: per-trace rollups (root span name, duration, error count). */
export function listTraces(db: BetterSqlite3.Database, args: { limit?: number } = {}): TraceSummaryDto[] {
  const safeLimit = Math.min(Math.max(Math.trunc(args.limit ?? 50) || 50, 1), 200)
  const rows = db
    .prepare(
      `SELECT trace_id,
              MIN(start_unix_ms) AS start_ms,
              MAX(COALESCE(end_unix_ms, start_unix_ms)) AS end_ms,
              COUNT(*) AS span_count,
              SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END) AS error_count
       FROM traces GROUP BY trace_id ORDER BY start_ms DESC LIMIT ?`
    )
    .all(safeLimit) as { trace_id: string; start_ms: number; end_ms: number; span_count: number; error_count: number }[]
  const rootStmt = db.prepare(
    `SELECT name FROM traces WHERE trace_id = ?
     ORDER BY (parent_span_id IS NOT NULL AND parent_span_id != ''), start_unix_ms, id LIMIT 1`
  )
  return rows.map((row): TraceSummaryDto => {
    const root = rootStmt.get(row.trace_id) as { name: string } | undefined
    return {
      traceId: row.trace_id,
      rootName: root?.name ?? '(unknown)',
      startUnixMs: row.start_ms,
      durationMs: row.end_ms > row.start_ms ? row.end_ms - row.start_ms : null,
      spanCount: row.span_count,
      errorCount: row.error_count
    }
  })
}

/** ipc traces.spans: every span in one trace, ordered for the waterfall. */
export function getTrace(db: BetterSqlite3.Database, { traceId }: { traceId: string }): TraceSpanDto[] {
  const rows = db
    .prepare(
      `SELECT span_id, parent_span_id, name, kind, start_unix_ms, end_unix_ms, status, attributes_json
       FROM traces WHERE trace_id = ? ORDER BY start_unix_ms, id`
    )
    .all(traceId) as {
    span_id: string
    parent_span_id: string | null
    name: string
    kind: string | null
    start_unix_ms: number
    end_unix_ms: number | null
    status: string | null
    attributes_json: string | null
  }[]
  return rows.map(
    (row): TraceSpanDto => ({
      spanId: row.span_id,
      parentSpanId: row.parent_span_id === '' ? null : row.parent_span_id,
      name: row.name,
      kind: row.kind,
      startUnixMs: row.start_unix_ms,
      endUnixMs: row.end_unix_ms,
      status: row.status,
      attributes: row.attributes_json === null ? {} : jsonObject(JSON.parse(row.attributes_json))
    })
  )
}

/** ipc spend.summary: the metered cloud spend (real dollars, `spend` table). */
export function getSpendSummary(db: BetterSqlite3.Database): SpendSummaryDto {
  const total = db
    .prepare(
      `SELECT COALESCE(SUM(usd), 0) AS t,
              COALESCE(SUM(input_tokens), 0) AS in_t,
              COALESCE(SUM(output_tokens), 0) AS out_t
       FROM spend`
    )
    .get() as { t: number; in_t: number; out_t: number }
  const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()
  const last24h = db
    .prepare(
      `SELECT COALESCE(SUM(usd), 0) AS t,
              COALESCE(SUM(input_tokens), 0) AS in_t,
              COALESCE(SUM(output_tokens), 0) AS out_t
       FROM spend WHERE created_at >= ?`
    )
    .get(cutoff) as { t: number; in_t: number; out_t: number }
  const byTask = db
    .prepare(
      `SELECT task_id, SUM(usd) AS usd,
              COALESCE(SUM(input_tokens), 0) AS in_t,
              COALESCE(SUM(output_tokens), 0) AS out_t,
              COUNT(*) AS calls, MAX(created_at) AS last_at
       FROM spend WHERE task_id IS NOT NULL GROUP BY task_id ORDER BY usd DESC LIMIT 20`
    )
    .all() as { task_id: string; usd: number; in_t: number; out_t: number; calls: number; last_at: string }[]
  const recent = db
    .prepare(
      `SELECT id, task_id, provider, model, input_tokens, output_tokens, usd, created_at
       FROM spend ORDER BY created_at DESC, id DESC LIMIT 50`
    )
    .all() as {
    id: number
    task_id: string | null
    provider: string | null
    model: string | null
    input_tokens: number | null
    output_tokens: number | null
    usd: number
    created_at: string
  }[]
  return {
    totalUsd: total.t,
    last24hUsd: last24h.t,
    ceilingUsd: SPEND_CEILING_USD_DEFAULT,
    totalInputTokens: total.in_t,
    totalOutputTokens: total.out_t,
    last24hInputTokens: last24h.in_t,
    last24hOutputTokens: last24h.out_t,
    byTask: byTask.map((row) => ({
      taskId: row.task_id,
      usd: row.usd,
      inputTokens: row.in_t,
      outputTokens: row.out_t,
      calls: row.calls,
      lastAt: row.last_at
    })),
    recent: recent.map(
      (row): SpendEntryDto => ({
        id: row.id,
        taskId: row.task_id,
        provider: row.provider,
        model: row.model,
        inputTokens: row.input_tokens,
        outputTokens: row.output_tokens,
        usd: row.usd,
        createdAt: row.created_at
      })
    )
  }
}

/** The headless-runner usage rollup — subscription runs create NO spend rows. */
export function runnerUsage(db: BetterSqlite3.Database): RunnerUsageDto {
  const totals = db
    .prepare(
      `SELECT COUNT(*) AS runs,
              COALESCE(SUM(input_tokens), 0) AS input_tokens,
              COALESCE(SUM(output_tokens), 0) AS output_tokens,
              COALESCE(SUM(shadow_cost_usd), 0) AS shadow_cost
       FROM runner_runs`
    )
    .get() as { runs: number; input_tokens: number; output_tokens: number; shadow_cost: number }
  const recent = db
    .prepare(
      `SELECT id, task_id, mode, model, started_at, duration_ms, num_turns, input_tokens, output_tokens,
              shadow_cost_usd, is_error, exit_code
       FROM runner_runs ORDER BY started_at DESC, id DESC LIMIT 50`
    )
    .all() as {
    id: string
    task_id: string
    mode: string
    model: string | null
    started_at: string
    duration_ms: number | null
    num_turns: number | null
    input_tokens: number | null
    output_tokens: number | null
    shadow_cost_usd: number | null
    is_error: number | null
    exit_code: number | null
  }[]
  return {
    totalRuns: totals.runs,
    inputTokens: totals.input_tokens,
    outputTokens: totals.output_tokens,
    shadowCostUsdEstimate: totals.shadow_cost,
    recent: recent.map(
      (row): RunnerRunDto => ({
        id: row.id,
        taskId: row.task_id,
        mode: row.mode,
        model: row.model,
        startedAt: row.started_at,
        durationMs: row.duration_ms,
        numTurns: row.num_turns,
        inputTokens: row.input_tokens,
        outputTokens: row.output_tokens,
        shadowCostUsdEstimate: row.shadow_cost_usd,
        isError: row.is_error === null ? null : row.is_error === 1,
        exitCode: row.exit_code
      })
    )
  }
}

/** get_usage: the metered spend summary plus the runner_runs rollup. */
export function getUsage(db: BetterSqlite3.Database): UsageDto {
  return { ...getSpendSummary(db), runner: runnerUsage(db) }
}
