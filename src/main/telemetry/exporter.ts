/**
 * SqliteSpanExporter — sinks OpenTelemetry spans into the appdata.db `traces`
 * table (§9 observability). Spans land in SQLite, not the graph, so
 * high-frequency span writes never contend with the graph's single write
 * lane; the dashboard's native trace panel (phase 10) reads this table.
 *
 * Writes are synchronous (better-sqlite3) — paired with a SimpleSpanProcessor
 * a span's row is committed by the time `span.end()` returns, so spans from a
 * process that is later SIGKILLed are already durable (only spans that never
 * ended are lost, which is inherent to tracing).
 */
import type BetterSqlite3 from 'better-sqlite3'
import { SpanKind, SpanStatusCode, type HrTime } from '@opentelemetry/api'
import { ExportResultCode, type ExportResult } from '@opentelemetry/core'
import type { ReadableSpan, SpanExporter } from '@opentelemetry/sdk-trace-base'

const SPAN_KIND_NAMES: Readonly<Record<number, string>> = {
  [SpanKind.INTERNAL]: 'internal',
  [SpanKind.SERVER]: 'server',
  [SpanKind.CLIENT]: 'client',
  [SpanKind.PRODUCER]: 'producer',
  [SpanKind.CONSUMER]: 'consumer'
}

function hrTimeToUnixMs(time: HrTime): number {
  return Math.round(time[0] * 1_000 + time[1] / 1e6)
}

function statusName(code: SpanStatusCode): string {
  if (code === SpanStatusCode.OK) return 'ok'
  if (code === SpanStatusCode.ERROR) return 'error'
  return 'unset'
}

interface TraceRow {
  trace_id: string
  span_id: string
  parent_span_id: string | null
  name: string
  kind: string
  start_unix_ms: number
  end_unix_ms: number
  status: string
  attributes_json: string
}

function toRow(span: ReadableSpan): TraceRow {
  const context = span.spanContext()
  const attributes: Record<string, unknown> = { ...span.attributes }
  if (span.status.message !== undefined) {
    attributes['otel.status_message'] = span.status.message
  }
  return {
    trace_id: context.traceId,
    span_id: context.spanId,
    parent_span_id: span.parentSpanContext?.spanId ?? null,
    name: span.name,
    kind: SPAN_KIND_NAMES[span.kind] ?? 'internal',
    start_unix_ms: hrTimeToUnixMs(span.startTime),
    end_unix_ms: hrTimeToUnixMs(span.endTime),
    status: statusName(span.status.code),
    attributes_json: JSON.stringify(attributes)
  }
}

export class SqliteSpanExporter implements SpanExporter {
  private readonly insertBatch: BetterSqlite3.Transaction<(rows: TraceRow[]) => void>
  private shutdownRequested = false

  constructor(db: BetterSqlite3.Database) {
    const insert = db.prepare(
      `INSERT INTO traces (trace_id, span_id, parent_span_id, name, kind, start_unix_ms, end_unix_ms, status, attributes_json)
       VALUES (@trace_id, @span_id, @parent_span_id, @name, @kind, @start_unix_ms, @end_unix_ms, @status, @attributes_json)`
    )
    this.insertBatch = db.transaction((rows: TraceRow[]) => {
      for (const row of rows) insert.run(row)
    })
  }

  export(spans: ReadableSpan[], resultCallback: (result: ExportResult) => void): void {
    if (this.shutdownRequested) {
      resultCallback({ code: ExportResultCode.FAILED, error: new Error('SqliteSpanExporter is shut down') })
      return
    }
    try {
      this.insertBatch(spans.map(toRow))
      resultCallback({ code: ExportResultCode.SUCCESS })
    } catch (err) {
      resultCallback({ code: ExportResultCode.FAILED, error: err instanceof Error ? err : new Error(String(err)) })
    }
  }

  /** Nothing is buffered — every export() call committed synchronously. */
  forceFlush(): Promise<void> {
    return Promise.resolve()
  }

  /** The db handle is owned by openAppData(); shutdown only stops accepting. */
  shutdown(): Promise<void> {
    this.shutdownRequested = true
    return Promise.resolve()
  }
}
