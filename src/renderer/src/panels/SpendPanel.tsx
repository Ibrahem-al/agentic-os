/**
 * Spending panel (spec §14; UI redesign §P4) — the plain-language view of what
 * the AI has spent and how that sits against the budget. A budget meter and a
 * hairline stat strip up top, a 14-day daily-spend bar chart, then the "by task"
 * and "recent charges" tables. Read-only; every number is mono. Fetch-on-mount
 * with a manual refresh, matching the original behavior.
 */
import { useIpc } from '../lib/ipc'
import { truncate } from '../lib/format'
import { dayKey, lastNDays, plainUsd } from '../lib/plain'
import { Button, DataTable, ErrorState, LoadingRows, PanelHeader, SectionHeader, Timestamp } from '../ui/kit'
import type { Column } from '../ui/kit'
import { Icon } from '../ui/icons'
import { BarChart, MeterBar, StatStrip } from '../ui/viz'
import type { SpendEntryDto, SpendSummaryDto, SpendTaskAggregateDto } from '../../../shared/ipc'

/** Token counts collapse to k past 1000 ("1.2k / 340"); null renders '—'. */
function tokens(n: number | null): string {
  if (n == null) return '—'
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n)
}

const BY_TASK_COLUMNS: readonly Column<SpendTaskAggregateDto>[] = [
  {
    key: 'task',
    header: 'task',
    className: 'font-mono',
    render: (row) => <span title={row.taskId}>{truncate(row.taskId, 20)}</span>
  },
  { key: 'usd', header: 'spent', className: 'font-mono text-right', render: (row) => plainUsd(row.usd) },
  { key: 'calls', header: 'calls', className: 'font-mono text-right', render: (row) => row.calls },
  { key: 'last', header: 'last activity', render: (row) => <Timestamp iso={row.lastAt} /> }
]

const RECENT_COLUMNS: readonly Column<SpendEntryDto>[] = [
  { key: 'when', header: 'when', render: (row) => <Timestamp iso={row.createdAt} /> },
  { key: 'provider', header: 'provider', render: (row) => row.provider ?? '—' },
  { key: 'model', header: 'model', className: 'font-mono', render: (row) => row.model ?? '—' },
  {
    key: 'tokens',
    header: 'tokens in / out',
    className: 'font-mono',
    // "tokens" gets its one plain-language tooltip here (redesign dictionary).
    render: (row) => (
      <span title="units of AI text, roughly ¾ of a word">
        {tokens(row.inputTokens)} / {tokens(row.outputTokens)}
      </span>
    )
  },
  { key: 'usd', header: 'cost', className: 'font-mono text-right', render: (row) => plainUsd(row.usd) }
]

/** 14-day daily-spend bars from the recent-charges window, bucketed by local day. */
function DailySpend({ recent }: { recent: readonly SpendEntryDto[] }): React.JSX.Element {
  const days = lastNDays(14)
  const byDay = new Map<string, number>(days.map((d) => [d, 0]))
  for (const entry of recent) {
    const key = dayKey(entry.createdAt)
    if (byDay.has(key)) byDay.set(key, (byDay.get(key) ?? 0) + entry.usd)
  }
  const values = days.map((d) => byDay.get(d) ?? 0)
  const total = values.reduce((sum, v) => sum + v, 0)
  if (total <= 0) {
    return <div className="text-[12px] text-ink-mute">No spending in the last 14 days.</div>
  }
  const bars = days.map((d, i) => ({ label: d.slice(5), value: values[i] ?? 0 }))
  return (
    <BarChart
      bars={bars}
      height={48}
      ariaLabel={`Spending per day over the last 14 days; ${plainUsd(total)} in total.`}
      formatValue={plainUsd}
    />
  )
}

/**
 * Budget meter + the headline stat strip. The ceiling is the PER-TASK limit, so
 * the meter compares the most expensive single task against it (not total spend,
 * which would falsely read "over budget" once several cheap tasks add up).
 */
function Budget({ data }: { data: SpendSummaryDto }): React.JSX.Element {
  const biggestTaskUsd = data.byTask.reduce((max, task) => Math.max(max, task.usd), 0)
  return (
    <div className="flex flex-col gap-4">
      <MeterBar
        value={biggestTaskUsd}
        max={data.ceilingUsd}
        label="Biggest task so far"
        formatValue={plainUsd}
        testId="spend-meter"
      />
      {data.ceilingUsd > 0 && (
        <p className="text-[12px] text-ink-mute">
          Each task may spend up to {plainUsd(data.ceilingUsd)}; the most expensive task so far has used this much.
        </p>
      )}
      <StatStrip
        stats={[
          { label: 'Total spent', value: plainUsd(data.totalUsd) },
          { label: 'Last 24 hours', value: plainUsd(data.last24hUsd) },
          { label: 'Tasks with spending', value: String(data.byTask.length) }
        ]}
      />
    </div>
  )
}

export default function SpendPanel(): React.JSX.Element {
  const summary = useIpc('spend.summary', undefined)

  return (
    <>
      <PanelHeader
        title="Spending"
        subtitle="What the AI has spent, and your budget."
        icon={<Icon name="spending" size={18} />}
        actions={
          <Button variant="ghost" onClick={summary.reload} testId="spend-refresh">
            Refresh
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
            <Budget data={summary.data} />

            <section className="flex flex-col gap-2">
              <SectionHeader>Recent activity by day</SectionHeader>
              <DailySpend recent={summary.data.recent} />
            </section>

            <section>
              <SectionHeader>By task</SectionHeader>
              <DataTable
                columns={BY_TASK_COLUMNS}
                rows={summary.data.byTask}
                rowKey={(row) => row.taskId}
                empty="No spending yet — background agents meter every paid call here, grouped by the task that made it."
                testId="spend-by-task"
              />
            </section>

            <section>
              <SectionHeader>Recent charges</SectionHeader>
              <DataTable
                columns={RECENT_COLUMNS}
                rows={summary.data.recent}
                rowKey={(row) => String(row.id)}
                empty="No spending yet — nothing has called a paid model."
                testId="spend-recent"
              />
            </section>
          </div>
        )}
      </div>
    </>
  )
}
