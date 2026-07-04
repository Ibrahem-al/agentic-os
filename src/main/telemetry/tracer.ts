/**
 * Telemetry setup (§9): OpenTelemetry SDK with spans sinking to the appdata.db
 * `traces` table via SqliteSpanExporter. One Telemetry instance per app (or
 * per test database); the provider is intentionally NOT registered as the
 * OTel global so test instances stay isolated.
 *
 * Span nesting rides the ambient OTel context (AsyncLocalStorage): whatever
 * runs inside `withSpan` — kernel actions, workflow steps, model calls —
 * parents its own spans automatically. Trace ids propagate through workflows;
 * `remoteParentContext` lets a resumed job continue the original run's trace
 * across a process restart (§10 checkpoint/resume).
 */
import type BetterSqlite3 from 'better-sqlite3'
import {
  context,
  trace,
  ROOT_CONTEXT,
  SpanStatusCode,
  TraceFlags,
  type Attributes,
  type Context,
  type Span,
  type Tracer
} from '@opentelemetry/api'
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks'
import { resourceFromAttributes } from '@opentelemetry/resources'
import { BasicTracerProvider, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base'
import { PRODUCT_NAME } from '../config'
import { SqliteSpanExporter } from './exporter'

/** Options for one `withSpan` call. */
export interface WithSpanOptions {
  /** Explicit parent context; defaults to the ambient active context. */
  parent?: Context
}

export interface Telemetry {
  readonly tracer: Tracer
  /**
   * Run `fn` inside a new span: the span is active (ambient context) for the
   * duration, status is OK on return / ERROR + recorded exception on throw,
   * and it is always ended (exported synchronously to the traces table).
   */
  withSpan<T>(name: string, attributes: Attributes, fn: (span: Span) => Promise<T> | T, options?: WithSpanOptions): Promise<T>
  /**
   * A context whose "current span" is a remote handle to a span from an
   * earlier process (trace id + span id, e.g. persisted in a job record).
   * Spans started under it join that original trace as children.
   */
  remoteParentContext(traceId: string, spanId: string): Context
  forceFlush(): Promise<void>
  shutdown(): Promise<void>
}

// The global context manager is process-wide by design (it is just the
// AsyncLocalStorage mechanics); register it once, first Telemetry wins.
let contextManagerRegistered = false
function ensureContextManager(): void {
  if (contextManagerRegistered) return
  context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable())
  contextManagerRegistered = true
}

export function createTelemetry(db: BetterSqlite3.Database): Telemetry {
  ensureContextManager()
  const provider = new BasicTracerProvider({
    resource: resourceFromAttributes({ 'service.name': PRODUCT_NAME }),
    spanProcessors: [new SimpleSpanProcessor(new SqliteSpanExporter(db))]
  })
  const tracer = provider.getTracer(`${PRODUCT_NAME}-kernel`)

  return {
    tracer,
    async withSpan<T>(
      name: string,
      attributes: Attributes,
      fn: (span: Span) => Promise<T> | T,
      options: WithSpanOptions = {}
    ): Promise<T> {
      const parentContext = options.parent ?? context.active()
      const span = tracer.startSpan(name, { attributes }, parentContext)
      try {
        const result = await context.with(trace.setSpan(parentContext, span), () => fn(span))
        span.setStatus({ code: SpanStatusCode.OK })
        return result
      } catch (err) {
        span.recordException(err instanceof Error ? err : new Error(String(err)))
        span.setStatus({ code: SpanStatusCode.ERROR, message: err instanceof Error ? err.message : String(err) })
        throw err
      } finally {
        span.end()
      }
    },
    remoteParentContext(traceId: string, spanId: string): Context {
      return trace.setSpanContext(ROOT_CONTEXT, {
        traceId,
        spanId,
        traceFlags: TraceFlags.SAMPLED,
        isRemote: true
      })
    },
    forceFlush: () => provider.forceFlush(),
    shutdown: () => provider.shutdown()
  }
}
