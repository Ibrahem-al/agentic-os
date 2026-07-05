/**
 * Spend panel (phase 10, spec §14): live cloud-spend display over the metered
 * ledger — totals strip, per-task aggregates, recent call rows. Read-only;
 * every number is mono per DESIGN.md.
 */
import { useIpc } from '../lib/ipc'
import { truncate, usd } from '../lib/format'
import { Button, DataTable, ErrorState, LoadingRows, PanelHeader, SectionHeader, Timestamp } from '../ui/kit'
import type { Column } from '../ui/kit'
import type { SpendEntryDto, SpendTaskAggregateDto } from '../../../shared/ipc'

/** Token counts collapse to k past 1000 ("1.2k / 340"); null renders '-'. */
function tokens(n: number | null): string {
  if (n == null) return '-'
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n)
}

const BY_TASK_COLUMNS: readonly Column<SpendTaskAggregateDto>[] = [
  {
    key: 'task',
    header: 'task',
    className: 'font-mono',
    render: (row) => <span title={row.taskId}>{truncate(row.taskId, 20)}</span>
  },
  { key: 'calls', header: 'calls', className: 'font-mono text-right', render: (row) => row.calls },
  { key: 'usd', header: 'usd', className: 'font-mono text-right', render: (row) => usd(row.usd) },
  { key: 'last', header: 'last', render: (row) => <Timestamp iso={row.lastAt} /> }
]

const RECENT_COLUMNS: readonly Column<SpendEntryDto>[] = [
  { key: 'when', header: 'when', render: (row) => <Timestamp iso={row.createdAt} /> },
  { key: 'provider', header: 'provider', render: (row) => row.provider ?? '-' },
  { key: 'model', header: 'model', className: 'font-mono', render: (row) => row.model ?? '-' },
  {
    key: 'tokens',
    header: 'tokens in/out',
    className: 'font-mono',
    render: (row) => `${tokens(row.inputTokens)} / ${tokens(row.outputTokens)}`
  },
  { key: 'usd', header: 'usd', className: 'font-mono text-right', render: (row) => usd(row.usd) }
]

export default function SpendPanel(): React.JSX.Element {
  const summary = useIpc('spend.summary', undefined)

  return (
    <>
      <PanelHeader
        title="spend"
        actions={
          <Button variant="ghost" onClick={summary.reload} testId="spend-refresh">
            refresh
          </Button>
        }
      />
      <div className="min-h-0 flex-1 overflow-y-auto">
        {summary.error !== null ? (
          <ErrorState error={summary.error} onRetry={summary.reload} />
        ) : summary.data === null ? (
          <LoadingRows />
        ) : (
          <div className="flex flex-col gap-6 px-5 py-4">
            <div className="flex items-baseline gap-8 border border-line px-4 py-3">
              <div>
                <div className="text-[11px] text-ink-mute">total</div>
                <div className="font-mono text-[16px]">{usd(summary.data.totalUsd)}</div>
              </div>
              <div>
                <div className="text-[11px] text-ink-mute">last 24h</div>
                <div className="font-mono text-[13px]">{usd(summary.data.last24hUsd)}</div>
              </div>
              <div>
                <div className="text-[11px] text-ink-mute">per-task ceiling</div>
                <div className="font-mono text-[13px]">
                  {usd(summary.data.ceilingUsd)}{' '}
                  <span className="font-sans text-[11px] text-ink-faint">(default, per-task override)</span>
                </div>
              </div>
            </div>

            <section>
              <SectionHeader>by task</SectionHeader>
              <DataTable
                columns={BY_TASK_COLUMNS}
                rows={summary.data.byTask}
                rowKey={(row) => row.taskId}
                empty="no cloud spend recorded - background agents meter every cloud call here"
                testId="spend-by-task"
              />
            </section>

            <section>
              <SectionHeader>recent calls</SectionHeader>
              <DataTable
                columns={RECENT_COLUMNS}
                rows={summary.data.recent}
                rowKey={(row) => String(row.id)}
                empty="no cloud calls yet - metered calls land here as they happen"
                testId="spend-recent"
              />
            </section>
          </div>
        )}
      </div>
    </>
  )
}
