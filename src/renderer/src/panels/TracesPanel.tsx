/**
 * Agent runs panel (UI redesign §P6; was "traces", phase 10 spec §3): the
 * plain-language observability viewer over the local trace store. Master-detail:
 * recent runs left as plain sentences, span waterfall right — the waterfall IS
 * the visualization (28px rows, 8px bars, offset+width as % of run wall-clock
 * per DESIGN.md). Clicking a step toggles its recorded details; permission.*
 * rows render bold — they are the §13 decision trail. Read-only.
 */
import { useMemo, useState } from 'react'
import { useIpc } from '../lib/ipc'
import { duration, truncate } from '../lib/format'
import { plainDuration, plainStatus, plural } from '../lib/plain'
import {
  Badge,
  DataTable,
  EmptyState,
  ErrorState,
  LoadingRows,
  PanelHeader,
  Timestamp
} from '../ui/kit'
import type { Column } from '../ui/kit'
import { Icon } from '../ui/icons'
import type { JsonValue, TraceSpanDto, TraceSummaryDto } from '../../../shared/ipc'

/** One-line plain summary of a run: how long, how many steps, error state. */
function runSummary(trace: TraceSummaryDto): React.JSX.Element {
  const steps = plural(trace.spanCount, 'step')
  // A null duration means the run has not finished recording.
  if (trace.durationMs === null) return <>In progress · {steps}</>
  const lead = `Finished in ${plainDuration(trace.durationMs)} · ${steps} · `
  return trace.errorCount > 0 ? (
    <>
      {lead}
      <span className="text-err">{plural(trace.errorCount, 'error')}</span>
    </>
  ) : (
    <>{lead}no errors</>
  )
}

const RUN_COLUMNS: readonly Column<TraceSummaryDto>[] = [
  {
    key: 'run',
    header: 'run',
    render: (row) => (
      <div className="flex flex-col gap-0.5">
        <span className="truncate font-mono text-ok" title={row.rootName}>
          {truncate(row.rootName, 40)}
        </span>
        <span className="text-[12px] text-ink-mute">{runSummary(row)}</span>
      </div>
    )
  },
  {
    key: 'when',
    header: 'when',
    className: 'text-right whitespace-nowrap',
    render: (row) => <Timestamp ms={row.startUnixMs} />
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
        <span className="shrink-0 text-[12px] text-ink-mute">{runSummary(trace)}</span>
      </div>
      {spans.error !== null ? (
        <ErrorState error={spans.error} onRetry={spans.reload} />
      ) : spans.data === null ? (
        <LoadingRows />
      ) : rows.length === 0 ? (
        <EmptyState>This run recorded no steps.</EmptyState>
      ) : (
        <div className="px-4 py-2" data-testid="trace-waterfall">
          <p className="mb-2 text-[12px] text-ink-mute">
            Each bar is one step; longer bars took longer. Select a step to see its details.
          </p>
          {rows.map(({ span, depth, leftPct, widthPct, durMs }) => {
            const expanded = expandedSpanId === span.spanId
            const attributes = Object.entries(span.attributes)
            const hasPermission = attributes.some(([key]) => key.startsWith('permission.'))
            const plain = span.status !== null ? plainStatus(span.status) : null
            return (
              <div key={span.spanId}>
                <button
                  type="button"
                  onClick={() => setExpandedSpanId(expanded ? null : span.spanId)}
                  aria-expanded={expanded}
                  className="flex h-7 w-full cursor-pointer items-center border-b border-line text-left transition-colors duration-120 hover:bg-raised"
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
                  <div className="flex flex-col gap-2 border-b border-line bg-surface px-3 py-2.5">
                    <div className="flex items-center gap-2 text-[12px] text-ink-mute">
                      {plain !== null && (
                        <Badge status={span.status ?? ''} label={plain.label} title={plain.explain} />
                      )}
                      <span>took {plainDuration(durMs)}</span>
                    </div>
                    {attributes.length === 0 ? (
                      <div className="text-[12px] text-ink-mute">No extra details were recorded for this step.</div>
                    ) : (
                      <>
                        {hasPermission && (
                          <div className="text-[11px] text-ink-mute">
                            Highlighted rows are permission decisions — the record of what the agent was allowed to do.
                          </div>
                        )}
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
                      </>
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
      <PanelHeader
        title="Agent runs"
        subtitle="A step-by-step record of each thing the agent did."
        icon={<Icon name="runs" size={18} />}
      />
      <div className="grid min-h-0 flex-1 grid-cols-[2fr_3fr]">
        <div className="min-h-0 overflow-y-auto border-r border-line">
          {traces.error !== null ? (
            <ErrorState error={traces.error} onRetry={traces.reload} />
          ) : traces.data === null ? (
            <LoadingRows />
          ) : (
            <DataTable
              columns={RUN_COLUMNS}
              rows={traces.data}
              rowKey={(row) => row.traceId}
              onRowClick={(row) => setSelectedId(row.traceId)}
              selectedKey={selectedId}
              empty="No agent runs yet — each time the assistant does something, its step-by-step record shows up here."
              testId="traces-table"
            />
          )}
        </div>
        <div className="min-h-0 overflow-y-auto">
          {selected !== null ? (
            <TraceDetail key={selected.traceId} trace={selected} />
          ) : (
            <EmptyState icon={<Icon name="runs" size={20} />}>
              Select a run on the left to see each step it took.
            </EmptyState>
          )}
        </div>
      </div>
    </>
  )
}
