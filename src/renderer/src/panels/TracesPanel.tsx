/**
 * Traces panel (phase 10, spec §3): observability viewer over the local trace
 * store. Master-detail: recent traces left, span waterfall right (24px rows,
 * 8px bars, offset+width as % of trace wall-clock per DESIGN.md). Clicking a
 * span toggles its attributes; permission.* rows render bold — they are the
 * §13 decision trail.
 */
import { useMemo, useState } from 'react'
import { useIpc } from '../lib/ipc'
import { duration, truncate } from '../lib/format'
import { DataTable, EmptyState, ErrorState, LoadingRows, PanelHeader, Timestamp } from '../ui/kit'
import type { Column } from '../ui/kit'
import type { JsonValue, TraceSpanDto, TraceSummaryDto } from '../../../shared/ipc'

const TRACE_COLUMNS: readonly Column<TraceSummaryDto>[] = [
  {
    key: 'root',
    header: 'root',
    render: (row) => <span title={row.rootName}>{truncate(row.rootName, 40)}</span>
  },
  { key: 'started', header: 'started', render: (row) => <Timestamp ms={row.startUnixMs} /> },
  {
    key: 'duration',
    header: 'duration',
    className: 'font-mono text-right',
    render: (row) => duration(row.durationMs)
  },
  { key: 'spans', header: 'spans', className: 'font-mono text-right', render: (row) => row.spanCount },
  {
    key: 'errors',
    header: 'errors',
    className: 'font-mono text-right',
    render: (row) => <span className={row.errorCount > 0 ? 'text-err' : ''}>{row.errorCount}</span>
  }
]

interface WaterfallRow {
  readonly span: TraceSpanDto
  readonly depth: number
  readonly leftPct: number
  readonly widthPct: number
  readonly durMs: number
}

/** Depth = ancestor count via parentSpanId chain (cap 8; orphan parent = 0). */
function buildWaterfall(spans: readonly TraceSpanDto[]): readonly WaterfallRow[] {
  if (spans.length === 0) return []
  const byId = new Map(spans.map((span) => [span.spanId, span]))
  const depthOf = (span: TraceSpanDto): number => {
    let depth = 0
    let current = span
    while (current.parentSpanId !== null && depth < 8) {
      const parent = byId.get(current.parentSpanId)
      if (parent === undefined) break
      depth++
      current = parent
    }
    return depth
  }
  const traceStart = spans.reduce((min, span) => Math.min(min, span.startUnixMs), Number.POSITIVE_INFINITY)
  const traceEnd = spans.reduce(
    (max, span) => Math.max(max, span.endUnixMs ?? span.startUnixMs),
    Number.NEGATIVE_INFINITY
  )
  const range = traceEnd - traceStart
  return [...spans]
    .sort((a, b) => a.startUnixMs - b.startUnixMs)
    .map((span) => {
      const end = span.endUnixMs ?? span.startUnixMs
      return {
        span,
        depth: depthOf(span),
        leftPct: range <= 0 ? 0 : ((span.startUnixMs - traceStart) / range) * 100,
        widthPct: range <= 0 ? 100 : Math.max(0.5, ((end - span.startUnixMs) / range) * 100),
        durMs: end - span.startUnixMs
      }
    })
}

function attrValue(value: JsonValue): string {
  return typeof value === 'string' ? value : JSON.stringify(value)
}

function TraceDetail({ trace }: { trace: TraceSummaryDto }): React.JSX.Element {
  const spans = useIpc('traces.spans', { traceId: trace.traceId })
  const [expandedSpanId, setExpandedSpanId] = useState<string | null>(null)
  const rows = useMemo(() => buildWaterfall(spans.data ?? []), [spans.data])

  return (
    <div className="flex min-h-0 flex-col">
      <div className="flex items-baseline gap-3 border-b border-line px-4 py-2.5">
        <span className="min-w-0 truncate text-[13px] font-semibold" title={trace.rootName}>
          {trace.rootName}
        </span>
        <span className="shrink-0 font-mono text-[11px] text-ink-mute">
          {duration(trace.durationMs)} · {trace.spanCount} spans
        </span>
      </div>
      {spans.error !== null ? (
        <ErrorState error={spans.error} onRetry={spans.reload} />
      ) : spans.data === null ? (
        <LoadingRows />
      ) : rows.length === 0 ? (
        <EmptyState>no spans recorded for this trace</EmptyState>
      ) : (
        <div className="px-4 py-2" data-testid="trace-waterfall">
          {rows.map(({ span, depth, leftPct, widthPct, durMs }) => {
            const expanded = expandedSpanId === span.spanId
            const attributes = Object.entries(span.attributes)
            return (
              <div key={span.spanId}>
                <button
                  type="button"
                  onClick={() => setExpandedSpanId(expanded ? null : span.spanId)}
                  aria-expanded={expanded}
                  className="flex h-6 w-full cursor-pointer items-center border-b border-line text-left transition-colors duration-120 hover:bg-raised"
                >
                  <span
                    className="w-[40%] shrink-0 truncate pr-2 text-[11px]"
                    style={{ paddingLeft: depth * 12 }}
                    title={span.name}
                  >
                    {span.name}
                  </span>
                  <span className="relative h-full min-w-0 flex-1">
                    <span
                      aria-hidden="true"
                      className={`absolute top-1/2 h-2 -translate-y-1/2 rounded-[2px] ${
                        span.status === 'error' ? 'bg-err' : 'bg-accent'
                      }`}
                      style={{ left: `${leftPct}%`, width: `${widthPct}%` }}
                    />
                  </span>
                  <span className="w-16 shrink-0 pl-2 text-right font-mono text-[11px] text-ink-mute">
                    {duration(durMs)}
                  </span>
                </button>
                {expanded && (
                  <div className="border-b border-line bg-surface px-3 py-2">
                    {attributes.length === 0 ? (
                      <div className="text-[11px] text-ink-mute">no attributes</div>
                    ) : (
                      <dl className="grid grid-cols-[minmax(96px,max-content)_1fr] gap-x-4 gap-y-1">
                        {attributes.map(([key, value]) => {
                          const permission = key.startsWith('permission.')
                          return (
                            <div key={key} className="contents">
                              <dt
                                className={`font-mono text-[11px] leading-5 ${
                                  permission ? 'font-semibold text-ink' : 'text-ink-mute'
                                }`}
                              >
                                {key}
                              </dt>
                              <dd
                                className={`min-w-0 font-mono text-[11px] leading-5 break-words ${
                                  permission ? 'font-semibold' : ''
                                }`}
                              >
                                {attrValue(value)}
                              </dd>
                            </div>
                          )
                        })}
                      </dl>
                    )}
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

export default function TracesPanel(): React.JSX.Element {
  const traces = useIpc('traces.recent', { limit: 50 })
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const selected = traces.data?.find((trace) => trace.traceId === selectedId) ?? null

  return (
    <>
      <PanelHeader title="traces" />
      <div className="grid min-h-0 flex-1 grid-cols-[2fr_3fr]">
        <div className="min-h-0 overflow-y-auto border-r border-line">
          {traces.error !== null ? (
            <ErrorState error={traces.error} onRetry={traces.reload} />
          ) : traces.data === null ? (
            <LoadingRows />
          ) : (
            <DataTable
              columns={TRACE_COLUMNS}
              rows={traces.data}
              rowKey={(row) => row.traceId}
              onRowClick={(row) => setSelectedId(row.traceId)}
              selectedKey={selectedId}
              empty="no traces yet - every kernel action and workflow step records spans here"
              testId="traces-table"
            />
          )}
        </div>
        <div className="min-h-0 overflow-y-auto">
          {selected !== null ? (
            <TraceDetail key={selected.traceId} trace={selected} />
          ) : (
            <EmptyState>select a trace to see its span waterfall</EmptyState>
          )}
        </div>
      </div>
    </>
  )
}
