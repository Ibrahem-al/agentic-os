/**
 * Home panel (UI redesign §P0) — the plain-language front door. Answers "what's
 * going on?" in five seconds: are the parts healthy, what is waiting on you,
 * the headline numbers, this week's review throughput, and the last few things
 * that happened. Read-only and navigational; every action routes to a deeper
 * panel via `onNavigate`. Polls every 20s like the rest of the shell; each
 * section keeps its last good value and shows a plain error line on a failed
 * poll, never a blank.
 */
import { useEffect, useState } from 'react'
import type {
  AppStatusDto,
  ApprovalDto,
  AuditActionDto,
  InjectionFlagDto,
  LabelCountDto,
  LocalUsageSummaryDto,
  SkillSummaryDto,
  SpendSummaryDto,
  StagedWriteDto,
  TaskDto
} from '../../../shared/ipc'
import type { PanelProps } from '../App'
import { call } from '../lib/ipc'
import { dayKey, lastNDays, lastNUtcDays, plainDuration, plainStatus, plainUsd, plural } from '../lib/plain'
import { Badge, Button, PanelHeader, SectionHeader, Timestamp } from '../ui/kit'
import { Icon } from '../ui/icons'
import { BarChart, StatStrip } from '../ui/viz'

// ── data plumbing ─────────────────────────────────────────────────────────────

/** One data source's latest value + whether the most recent poll failed. */
interface Slice<T> {
  readonly data: T | null
  readonly errored: boolean
}

interface HomeData {
  readonly status: Slice<AppStatusDto>
  readonly staged: Slice<readonly StagedWriteDto[]>
  readonly approvals: Slice<readonly ApprovalDto[]>
  readonly flags: Slice<readonly InjectionFlagDto[]>
  readonly spend: Slice<SpendSummaryDto>
  readonly counts: Slice<readonly LabelCountDto[]>
  readonly tasks: Slice<readonly TaskDto[]>
  readonly skills: Slice<readonly SkillSummaryDto[]>
  readonly audit: Slice<readonly AuditActionDto[]>
  /** All staged rows (any status) — the week readout counts staged vs decided. */
  readonly week: Slice<readonly StagedWriteDto[]>
  /** Local reasoning usage over a 1-day window — the "Local AI today" stat. */
  readonly localUsage: Slice<LocalUsageSummaryDto>
}

const EMPTY: Slice<never> = { data: null, errored: false }
const INITIAL: HomeData = {
  status: EMPTY,
  staged: EMPTY,
  approvals: EMPTY,
  flags: EMPTY,
  spend: EMPTY,
  counts: EMPTY,
  tasks: EMPTY,
  skills: EMPTY,
  audit: EMPTY,
  week: EMPTY,
  localUsage: EMPTY
}

type Settled<T> = { readonly value: T } | { readonly error: true }

/** Resolve to the value or a plain error marker — never rejects (keeps siblings alive). */
async function settle<T>(promise: Promise<T>): Promise<Settled<T>> {
  try {
    return { value: await promise }
  } catch {
    return { error: true }
  }
}

/** Fold a settled result into a slice, keeping the last good value on failure. */
function fold<T>(prev: Slice<T>, next: Settled<T>): Slice<T> {
  return 'value' in next ? { data: next.value, errored: false } : { data: prev.data, errored: true }
}

/** Poll every dashboard summary the Home panel reads, on the shared 20s cadence. */
function useHomeData(): HomeData {
  const [state, setState] = useState<HomeData>(INITIAL)
  useEffect(() => {
    let cancelled = false
    const refresh = async (): Promise<void> => {
      const [status, staged, approvals, flags, spend, counts, tasks, skills, audit, week, localUsage] =
        await Promise.all([
          settle(call('app.status', undefined)),
          settle(call('review.staged.list', { status: 'staged' })),
          settle(call('review.approvals.list', { status: 'pending' })),
          settle(call('review.flags.list', undefined)),
          settle(call('spend.summary', undefined)),
          settle(call('memory.counts', undefined)),
          settle(call('tasks.list', undefined)),
          settle(call('skills.list', undefined)),
          settle(call('audit.list', {})),
          settle(call('review.staged.list', {})),
          settle(call('usage.local.summary', { sinceDays: 1 }))
        ])
      if (cancelled) return
      setState((prev) => ({
        status: fold(prev.status, status),
        staged: fold(prev.staged, staged),
        approvals: fold(prev.approvals, approvals),
        flags: fold(prev.flags, flags),
        spend: fold(prev.spend, spend),
        counts: fold(prev.counts, counts),
        tasks: fold(prev.tasks, tasks),
        skills: fold(prev.skills, skills),
        audit: fold(prev.audit, audit),
        week: fold(prev.week, week),
        localUsage: fold(prev.localUsage, localUsage)
      }))
    }
    void refresh()
    const timer = setInterval(() => void refresh(), 20_000)
    return () => {
      cancelled = true
      clearInterval(timer)
    }
  }, [])
  return state
}

// ── plain-language helpers ────────────────────────────────────────────────────

/** Boot subsystems in plain words (brief dictionary). */
const SUBSYSTEMS: readonly { readonly key: keyof AppStatusDto['subsystems']; readonly label: string }[] = [
  { key: 'storage', label: 'Storage' },
  { key: 'models', label: 'AI models' },
  { key: 'kernel', label: 'Core engine' },
  { key: 'mcp', label: 'Claude connection' },
  { key: 'agents', label: 'Background agents' }
]

const WEEK_MS = 7 * 24 * 60 * 60 * 1000

/** A plain, muted line for a section whose poll failed and has no prior value. */
function SectionError({ children }: { children: React.ReactNode }): React.JSX.Element {
  return <div className="text-[13px] text-ink-mute">{children}</div>
}

// ── sections ──────────────────────────────────────────────────────────────────

/** Health line: one calm sentence, or the parts that need attention + a Fix link. */
function HealthLine({ status, onNavigate }: { status: Slice<AppStatusDto>; onNavigate: PanelProps['onNavigate'] }): React.JSX.Element {
  if (status.data === null) {
    return status.errored ? (
      <SectionError>Could not check system health right now.</SectionError>
    ) : (
      <SectionError>Checking system health…</SectionError>
    )
  }
  const subs = status.data.subsystems
  const down = SUBSYSTEMS.filter((s) => !subs[s.key])
  if (down.length === 0) {
    return (
      <div className="flex items-center gap-2 text-[13px] text-ink-mute">
        <span aria-hidden="true" className="inline-block size-2 rounded-full bg-ok" />
        <span>All systems running.</span>
      </div>
    )
  }
  return (
    <div className="flex items-center gap-2 text-[13px]">
      <Icon name="alert" size={16} className="shrink-0 text-warn" />
      <span className="text-ink">
        {down.length === 1 ? '1 part needs' : `${down.length} parts need`} attention:{' '}
        <span className="text-warn">{down.map((s) => s.label).join(', ')}</span>
      </span>
      <Button variant="ghost" onClick={() => onNavigate('settings')}>
        Fix
      </Button>
    </div>
  )
}

/** Needs your attention: the three review sources as plain sentences with a Review button. */
function NeedsAttention({
  staged,
  approvals,
  flags,
  onNavigate
}: {
  staged: Slice<readonly StagedWriteDto[]>
  approvals: Slice<readonly ApprovalDto[]>
  flags: Slice<readonly InjectionFlagDto[]>
  onNavigate: PanelProps['onNavigate']
}): React.JSX.Element {
  const allErrored = staged.data === null && approvals.data === null && flags.data === null
  if (allErrored && (staged.errored || approvals.errored || flags.errored)) {
    return <SectionError>Could not load what&apos;s waiting for you right now.</SectionError>
  }
  const items: readonly { readonly key: string; readonly text: string }[] = [
    staged.data !== null && staged.data.length > 0
      ? { key: 'staged', text: `${plural(staged.data.length, 'proposed memory change')} waiting for review` }
      : null,
    approvals.data !== null && approvals.data.length > 0
      ? { key: 'approvals', text: plural(approvals.data.length, 'permission request') }
      : null,
    flags.data !== null && flags.data.length > 0
      ? { key: 'flags', text: plural(flags.data.length, 'safety flag') }
      : null
  ].filter((item): item is { key: string; text: string } => item !== null)

  if (items.length === 0) {
    return (
      <div className="flex items-center gap-2 text-[13px] text-ink-mute">
        <Icon name="check" size={16} className="shrink-0 text-ok" />
        <span>Nothing is waiting on you.</span>
      </div>
    )
  }
  return (
    <ul className="flex flex-col divide-y divide-line rounded-md border border-line">
      {items.map((item) => (
        <li key={item.key} className="flex items-center justify-between gap-3 px-3 py-2.5">
          <span className="text-[13px] text-ink">{item.text}</span>
          <Button variant="primary" onClick={() => onNavigate('review')}>
            Review
          </Button>
        </li>
      ))}
    </ul>
  )
}

/** Headline numbers as a hairline strip (no hero cards). */
function HeadlineStats({
  spend,
  counts,
  tasks,
  skills,
  localUsage
}: {
  spend: Slice<SpendSummaryDto>
  counts: Slice<readonly LabelCountDto[]>
  tasks: Slice<readonly TaskDto[]>
  skills: Slice<readonly SkillSummaryDto[]>
  localUsage: Slice<LocalUsageSummaryDto>
}): React.JSX.Element {
  // Daily spend for the sparkline: bucket the recent-charges window by local day.
  const spendDays = lastNDays(14)
  const spendByDay = new Map<string, number>(spendDays.map((d) => [d, 0]))
  for (const entry of spend.data?.recent ?? []) {
    const key = dayKey(entry.createdAt)
    if (spendByDay.has(key)) spendByDay.set(key, (spendByDay.get(key) ?? 0) + entry.usd)
  }
  const spark = spendDays.map((d) => spendByDay.get(d) ?? 0)

  const memoryTotal = (counts.data ?? []).reduce((sum, c) => sum + c.count, 0)

  const taskRows = tasks.data ?? []
  const active = taskRows.filter((t) => t.status === 'running' || t.status === 'pending').length
  const failed = taskRows.filter((t) => t.status === 'failed').length

  const skillRows = skills.data ?? []
  const scored = skillRows.map((s) => s.activeBenchmarkScore).filter((v): v is number => v !== null)
  const avgScore = scored.length > 0 ? scored.reduce((sum, v) => sum + v, 0) / scored.length : null

  // "Local AI today": today's bucket from the 1-day window (byDay keys are UTC).
  const todayKey = lastNUtcDays(1)[0] ?? ''
  const localToday = (localUsage.data?.byDay ?? []).find((d) => d.day === todayKey)
  const localCalls = localToday?.calls ?? 0
  const localComputeMs = localToday?.computeMs ?? 0

  return (
    <StatStrip
      stats={[
        {
          label: 'Spending, last 24 h',
          value: spend.data !== null ? plainUsd(spend.data.last24hUsd) : '—',
          spark
        },
        {
          label: 'Things remembered',
          value: counts.data !== null ? memoryTotal.toLocaleString() : '—'
        },
        {
          label: 'Background work',
          value: tasks.data !== null ? String(active) : '—',
          ...(failed > 0 ? { tone: 'warn' as const, hint: plural(failed, 'failed job') } : {})
        },
        {
          label: 'Skills',
          value: skills.data !== null ? String(skillRows.length) : '—',
          ...(avgScore !== null ? { hint: `avg quality ${avgScore.toFixed(2)}` } : {})
        },
        {
          label: 'Local AI today',
          value: localUsage.data !== null ? String(localCalls) : '—',
          ...(localUsage.data !== null && localComputeMs > 0
            ? { hint: `${plainDuration(localComputeMs)} compute` }
            : {})
        }
      ]}
    />
  )
}

/** This week's reviews: staged vs decided over the last 7 days + a per-day bar. */
function WeekReviews({ week }: { week: Slice<readonly StagedWriteDto[]> }): React.JSX.Element {
  if (week.data === null) {
    return week.errored ? (
      <SectionError>Could not load this week&apos;s reviews.</SectionError>
    ) : (
      <SectionError>Loading this week&apos;s reviews…</SectionError>
    )
  }
  const since = Date.now() - WEEK_MS
  let staged = 0
  let decided = 0
  const days = lastNDays(7)
  const stagedByDay = new Map<string, number>(days.map((d) => [d, 0]))
  for (const row of week.data) {
    if (Date.parse(row.createdAt) >= since) staged += 1
    if (row.decidedAt !== null && Date.parse(row.decidedAt) >= since) decided += 1
    const key = dayKey(row.createdAt)
    if (stagedByDay.has(key)) stagedByDay.set(key, (stagedByDay.get(key) ?? 0) + 1)
  }
  const growing = staged > decided
  const bars = days.map((d) => ({ label: d.slice(5), value: stagedByDay.get(d) ?? 0 }))
  return (
    <div className="flex flex-col gap-3">
      <div className="text-[13px]" data-testid="review-week-counter">
        <span className={`font-mono ${growing ? 'text-warn' : 'text-ink'}`}>{staged}</span> proposed this week ·{' '}
        <span className="font-mono text-ink">{decided}</span> decided
      </div>
      <BarChart
        bars={bars}
        height={40}
        ariaLabel={`Proposed memory changes per day this week: ${staged} in total, ${decided} decided.`}
      />
    </div>
  )
}

/** Recent activity: the last handful of audit entries as plain sentences. */
function RecentActivity({
  audit,
  onNavigate
}: {
  audit: Slice<readonly AuditActionDto[]>
  onNavigate: PanelProps['onNavigate']
}): React.JSX.Element {
  if (audit.data === null) {
    return audit.errored ? (
      <SectionError>Could not load recent activity.</SectionError>
    ) : (
      <SectionError>Loading recent activity…</SectionError>
    )
  }
  const rows = audit.data.slice(0, 6)
  if (rows.length === 0) {
    return <SectionError>Nothing has happened yet — actions the assistant takes show up here.</SectionError>
  }
  return (
    <div className="flex flex-col gap-3">
      <ul className="flex flex-col divide-y divide-line">
        {rows.map((row) => {
          const plain = plainStatus(row.outcome)
          return (
            <li key={row.id} className="flex items-start justify-between gap-3 py-2">
              <span className={`min-w-0 flex-1 text-[13px] ${row.undoneAt !== null ? 'text-ink-mute' : 'text-ink'}`}>
                {row.description}
              </span>
              <div className="flex shrink-0 items-center gap-2">
                <Badge status={row.outcome} label={plain.label} title={plain.explain} />
                <Timestamp iso={row.createdAt} />
              </div>
            </li>
          )
        })}
      </ul>
      <div>
        <Button variant="ghost" onClick={() => onNavigate('audit')}>
          See all history
        </Button>
      </div>
    </div>
  )
}

// ── panel ─────────────────────────────────────────────────────────────────────

export default function HomePanel({ onNavigate }: PanelProps): React.JSX.Element {
  const data = useHomeData()
  return (
    <>
      <PanelHeader
        title="Home"
        subtitle="A quick look at what your assistant is doing."
        icon={<Icon name="home" size={18} />}
      />
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="flex flex-col gap-6 px-5 py-4">
          <section>
            <HealthLine status={data.status} onNavigate={onNavigate} />
          </section>

          <section>
            <SectionHeader>Needs your attention</SectionHeader>
            <NeedsAttention
              staged={data.staged}
              approvals={data.approvals}
              flags={data.flags}
              onNavigate={onNavigate}
            />
          </section>

          <section>
            <HeadlineStats
              spend={data.spend}
              counts={data.counts}
              tasks={data.tasks}
              skills={data.skills}
              localUsage={data.localUsage}
            />
          </section>

          <section>
            <SectionHeader>This week&apos;s reviews</SectionHeader>
            <WeekReviews week={data.week} />
          </section>

          <section>
            <SectionHeader>Recent activity</SectionHeader>
            <RecentActivity audit={data.audit} onNavigate={onNavigate} />
          </section>
        </div>
      </div>
    </>
  )
}
