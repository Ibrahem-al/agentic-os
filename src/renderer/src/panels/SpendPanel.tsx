/**
 * Usage panel (spec §14; UI redesign §P4; local-LLM visibility) — the plain-
 * language view of what the AI has spent AND what runs on this computer. Opens
 * with an "On this computer" section (the local qwen3 reasoning tier: what is
 * loaded right now + how much it has worked), then the cloud budget meter, the
 * daily-spend bars, and the "by task" / "recent charges" tables. Read-only;
 * every number is mono. Fetch-on-mount with a manual refresh.
 */
import { useIpc } from '../lib/ipc'
import { truncate } from '../lib/format'
import { dayKey, lastNDays, lastNUtcDays, plainBytes, plainDuration, plainRoleGroup, plainUsd } from '../lib/plain'
import {
  Button,
  DataTable,
  Disclosure,
  ErrorState,
  LoadingRows,
  PanelHeader,
  SectionHeader,
  Timestamp
} from '../ui/kit'
import type { Column } from '../ui/kit'
import { Icon } from '../ui/icons'
import { BarChart, CompositionBar, MeterBar, StatStrip } from '../ui/viz'
import type {
  LocalUsageCallDto,
  LocalUsageSummaryDto,
  SpendEntryDto,
  SpendSummaryDto,
  SpendTaskAggregateDto
} from '../../../shared/ipc'

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

// ── on this computer (local qwen3 reasoning) ──────────────────────────────────

/**
 * Recent local reasoning calls (newest first). The role shows as its plain group
 * name; the raw dotted role key stays in the tooltip (DESIGN: identifiers behind
 * a hover, never the first thing a row says). Durations use the roomier plain
 * grammar.
 */
const LOCAL_RECENT_COLUMNS: readonly Column<LocalUsageCallDto>[] = [
  { key: 'when', header: 'when', render: (row) => <Timestamp iso={row.ts} /> },
  {
    key: 'role',
    header: 'work',
    render: (row) => <span title={row.role ?? 'other'}>{plainRoleGroup(row.role)}</span>
  },
  { key: 'model', header: 'model', className: 'font-mono', render: (row) => row.model },
  {
    key: 'tokens',
    header: 'tokens in / out',
    className: 'font-mono',
    render: (row) => (
      <span title="units of AI text, roughly ¾ of a word">
        {tokens(row.promptTokens)} / {tokens(row.evalTokens)}
      </span>
    )
  },
  { key: 'duration', header: 'time', className: 'font-mono text-right', render: (row) => plainDuration(row.durationMs) }
]

/** Categorical tint per plain role group (legend labels disambiguate the hues). */
const GROUP_TINT: Readonly<Record<string, 'accent' | 'ok' | 'warn' | 'err' | 'undo' | 'mute'>> = {
  'Understanding your sessions': 'accent',
  'Search & retrieval': 'ok',
  'Improving skills': 'warn',
  'Safety scanning': 'err',
  Summaries: 'undo',
  Other: 'mute'
}
/** Stable render order for the composition bar / legend. */
const GROUP_ORDER: readonly string[] = [
  'Understanding your sessions',
  'Search & retrieval',
  'Improving skills',
  'Safety scanning',
  'Summaries',
  'Other'
]

/** The live "what is loaded right now" line, from Ollama's /api/ps snapshot. */
function LoadedLine({ data }: { data: LocalUsageSummaryDto }): React.JSX.Element {
  if (data.ollamaState === 'daemon-not-running') {
    return (
      <p className="text-[13px] text-ink-mute" data-testid="usage-local-live">
        The local AI helper isn&apos;t running — nothing is loaded.
      </p>
    )
  }
  if (data.loaded.length === 0) {
    return (
      <p className="text-[13px] text-ink-mute" data-testid="usage-local-live">
        The local AI helper is running, but no model is loaded right now.
      </p>
    )
  }
  return (
    <div className="flex flex-col gap-1" data-testid="usage-local-live">
      {data.loaded.map((m) => {
        // GPU load reports size_vram; a CPU load reports only size (Stage 1 gotcha).
        const bytes = m.sizeVramBytes > 0 ? m.sizeVramBytes : m.sizeBytes
        return (
          <p key={m.name} className="text-[13px] text-ink">
            <span className="font-mono">{m.name}</span> is loaded — using {plainBytes(bytes)} of memory (unloads if
            idle).
          </p>
        )
      })}
    </div>
  )
}

/**
 * "On this computer": the local reasoning tier. `window14` drives the 14-day
 * compute bars + today's figures + the live snapshot + recent calls; `window7`
 * drives the 7-day totals and role-group composition (a separate window because
 * the fixed summary shape carries per-day only calls+compute, Stage 1 gotcha 3).
 */
function LocalUsageSection({
  window14,
  window7
}: {
  window14: LocalUsageSummaryDto
  window7: LocalUsageSummaryDto
}): React.JSX.Element {
  // Compute-per-day bars over 14 UTC days (byDay keys are UTC — Stage 1 gotcha 2).
  const days = lastNUtcDays(14)
  const byDay = new Map(window14.byDay.map((d) => [d.day, d]))
  const todayKey = days[days.length - 1] ?? ''
  const today = byDay.get(todayKey)
  const callsToday = today?.calls ?? 0
  const computeToday = today?.computeMs ?? 0

  const bars = days.map((d) => ({ label: d.slice(5), value: byDay.get(d)?.computeMs ?? 0 }))
  const totalComputeMs = bars.reduce((sum, b) => sum + b.value, 0)

  // 7-day figures: total tokens processed + the busiest work area.
  const tokens7d = window7.totals.promptTokens + window7.totals.evalTokens
  const busiest = window7.byRole.reduce<{ role: string; calls: number } | null>(
    (top, r) => (top === null || r.calls > top.calls ? { role: r.role, calls: r.calls } : top),
    null
  )

  // Calls by plain role group over 7 days, in stable order.
  const groupCalls = new Map<string, number>()
  for (const r of window7.byRole) {
    const group = plainRoleGroup(r.role)
    groupCalls.set(group, (groupCalls.get(group) ?? 0) + r.calls)
  }
  const segments = GROUP_ORDER.map((group) => ({
    label: group,
    count: groupCalls.get(group) ?? 0,
    tint: GROUP_TINT[group] ?? 'mute'
  }))

  return (
    <section className="flex flex-col gap-4" data-testid="usage-local">
      <SectionHeader>On this computer</SectionHeader>
      <p className="-mt-2 text-[12px] text-ink-mute">
        The local AI helper (Ollama) that reasons on your machine — private and free. Search indexing (embeddings)
        also always runs here.
      </p>

      <LoadedLine data={window14} />

      <StatStrip
        stats={[
          { label: 'Calls today', value: String(callsToday), testId: 'usage-local-calls-today' },
          { label: 'Compute time today', value: plainDuration(computeToday) },
          { label: 'Tokens processed, last 7 days', value: tokens(tokens7d) },
          { label: 'Busiest work, last 7 days', value: busiest !== null ? plainRoleGroup(busiest.role) : '—' }
        ]}
      />

      <div className="flex flex-col gap-2">
        <SectionHeader>Compute time per day</SectionHeader>
        {totalComputeMs <= 0 ? (
          <div className="text-[12px] text-ink-mute" data-testid="usage-local-bars">
            No local reasoning in the last 14 days.
          </div>
        ) : (
          <div data-testid="usage-local-bars">
            <BarChart
              bars={bars}
              height={48}
              ariaLabel={`Local compute time per day over the last 14 days; ${plainDuration(totalComputeMs)} in total.`}
              formatValue={plainDuration}
            />
          </div>
        )}
      </div>

      <div className="flex flex-col gap-2">
        <SectionHeader>Work by area, last 7 days</SectionHeader>
        <div data-testid="usage-local-composition">
          <CompositionBar segments={segments} ariaLabel="Local reasoning calls by work area over the last 7 days." />
        </div>
      </div>

      <Disclosure summary="Recent local calls" testId="usage-local-recent">
        <DataTable
          columns={LOCAL_RECENT_COLUMNS}
          rows={window14.recent}
          rowKey={(row) => String(row.id)}
          empty="No local reasoning yet — calls the local AI helper handles show up here."
        />
      </Disclosure>
    </section>
  )
}

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
  // Two windows: 14 days drives the compute bars/today/live snapshot/recent list;
  // 7 days drives the token total + role-group composition (Stage 1 gotcha 3).
  const local14 = useIpc('usage.local.summary', { sinceDays: 14 })
  const local7 = useIpc('usage.local.summary', { sinceDays: 7 })

  const reloadAll = (): void => {
    summary.reload()
    local14.reload()
    local7.reload()
  }

  return (
    <>
      <PanelHeader
        title="Usage"
        subtitle="What the AI has spent — and what runs on this computer."
        icon={<Icon name="spending" size={18} />}
        actions={
          <Button variant="ghost" onClick={reloadAll} testId="spend-refresh">
            Refresh
          </Button>
        }
      />
      <div className="min-h-0 flex-1 overflow-y-auto">
        {summary.error !== null ? (
          <ErrorState error={summary.error} onRetry={reloadAll} />
        ) : summary.data === null ? (
          <LoadingRows />
        ) : (
          <div className="flex flex-col gap-6 px-5 py-4">
            {local14.error !== null ? (
              <ErrorState error={local14.error} onRetry={reloadAll} />
            ) : local14.data === null || local7.data === null ? (
              <div className="text-[12px] text-ink-mute" data-testid="usage-local">
                Loading what runs on this computer…
              </div>
            ) : (
              <LocalUsageSection window14={local14.data} window7={local7.data} />
            )}

            <section className="flex flex-col gap-4 border-t border-line pt-6">
              <SectionHeader>Cloud spending</SectionHeader>
              <Budget data={summary.data} />
            </section>

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
