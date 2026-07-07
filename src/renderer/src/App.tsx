/**
 * Dashboard shell (phase 10): fixed left rail (9 panels + subsystem status),
 * panel host on the right. Panel switching is local state — this is a
 * single-window cockpit, not a routed site.
 */
import { useCallback, useEffect, useState } from 'react'
import type { RunnerStatusDto } from '../../shared/ipc'
import { call, useIpc } from './lib/ipc'
import { Badge, Button, ToastProvider } from './ui/kit'
import TitleBar from './ui/TitleBar'
import MemoryPanel from './panels/MemoryPanel'
import ReviewPanel from './panels/ReviewPanel'
import AuditPanel from './panels/AuditPanel'
import SpendPanel from './panels/SpendPanel'
import TasksPanel from './panels/TasksPanel'
import TracesPanel from './panels/TracesPanel'
import SkillsPanel from './panels/SkillsPanel'
import IngestPanel from './panels/IngestPanel'
import SettingsPanel from './panels/SettingsPanel'

const PANELS = [
  { key: 'memory', label: 'memory', component: MemoryPanel },
  { key: 'review', label: 'review queue', component: ReviewPanel },
  { key: 'audit', label: 'audit log', component: AuditPanel },
  { key: 'spend', label: 'spend', component: SpendPanel },
  { key: 'tasks', label: 'tasks & watchers', component: TasksPanel },
  { key: 'traces', label: 'traces', component: TracesPanel },
  { key: 'skills', label: 'skills', component: SkillsPanel },
  { key: 'ingest', label: 'ingestion', component: IngestPanel },
  { key: 'settings', label: 'settings', component: SettingsPanel }
] as const

type PanelKey = (typeof PANELS)[number]['key']

/** Poll a rail count every 20s; failures keep the last value (the owning panel reports the outage). */
function usePolledCount(fetchCount: () => Promise<number>): number {
  const [count, setCount] = useState(0)
  useEffect(() => {
    let cancelled = false
    const refresh = async (): Promise<void> => {
      try {
        const value = await fetchCount()
        if (!cancelled) setCount(value)
      } catch {
        // Subsystem unavailable — the owning panel says so; the rail stays quiet.
      }
    }
    void refresh()
    const timer = setInterval(() => void refresh(), 20_000)
    return () => {
      cancelled = true
      clearInterval(timer)
    }
  }, [fetchCount])
  return count
}

/** Review work waiting on the operator — shown as a count in the rail. */
const fetchPendingCount = async (): Promise<number> => {
  const [staged, approvals] = await Promise.all([
    call('review.staged.list', { status: 'staged' }),
    call('review.approvals.list', { status: 'pending' })
  ])
  return staged.length + approvals.length
}

/** Open drift flags on adopted skill versions (§20 nightly watch) — a warning in the rail. */
const fetchDriftCount = async (): Promise<number> => {
  const summary = await call('skills.driftSummary', undefined)
  return summary.flagged
}

/**
 * Review throughput this week (P1.7) — staged vs decided over the last 7 days,
 * shown in the rail so `stageAll` backlog growth is visible from any panel
 * without opening the review queue. staged > decided ⇒ the queue is growing.
 * Polls every 20s; failures keep the last value (the review panel reports detail).
 */
function useReviewWeek(): { staged: number; decided: number } {
  const [week, setWeek] = useState({ staged: 0, decided: 0 })
  useEffect(() => {
    let cancelled = false
    const refresh = async (): Promise<void> => {
      try {
        const rows = await call('review.staged.list', {})
        const weekAgo = Date.now() - 7 * 24 * 60 * 60 * 1000
        let staged = 0
        let decided = 0
        for (const row of rows) {
          if (Date.parse(row.createdAt) >= weekAgo) staged += 1
          if (row.decidedAt !== null && Date.parse(row.decidedAt) >= weekAgo) decided += 1
        }
        if (!cancelled) setWeek({ staged, decided })
      } catch {
        // Review subsystem unavailable this poll — keep the last value.
      }
    }
    void refresh()
    const timer = setInterval(() => void refresh(), 20_000)
    return () => {
      cancelled = true
      clearInterval(timer)
    }
  }, [])
  return week
}

/**
 * Poll the runner health snapshot (phase 17) every 20s; failures keep the last
 * value (the settings panel reports detail). OFF by default → enabled:false →
 * the banner never shows and a keyless install is unchanged.
 */
function useRunnerStatus(): { status: RunnerStatusDto | null; refresh: () => void } {
  const [status, setStatus] = useState<RunnerStatusDto | null>(null)
  const [generation, setGeneration] = useState(0)
  useEffect(() => {
    let cancelled = false
    const load = async (): Promise<void> => {
      try {
        const next = await call('runner.status', undefined)
        if (!cancelled) setStatus(next)
      } catch {
        // Runner subsystem unavailable this poll — keep the last value.
      }
    }
    void load()
    const timer = setInterval(() => void load(), 20_000)
    return () => {
      cancelled = true
      clearInterval(timer)
    }
  }, [generation])
  const refresh = useCallback(() => setGeneration((g) => g + 1), [])
  return { status, refresh }
}

/**
 * Runner-health banner states (phase 17 → broadened phase 21). The banner is a
 * loud, actionable overlay; it fires only for these classified failures and
 * NEVER for 'unknown' (the sticky-failure decay / first-load state — banning it
 * prevents a boot flash) or 'ok'.
 */
const RUNNER_BANNER_STATES = ['auth-expired', 'quota-exhausted', 'not-installed'] as const
type RunnerBannerState = (typeof RUNNER_BANNER_STATES)[number]

function isRunnerBannerState(state: string): state is RunnerBannerState {
  return (RUNNER_BANNER_STATES as readonly string[]).includes(state)
}

/**
 * Per-state banner copy: title + hint + tint. auth/quota keep the exact phase-17
 * wording and tints; not-installed is the phase-21 addition (warn tint — a
 * missing CLI is fixable config, not a hard error). The shared tail sentence and
 * the lastError mono line are rendered once by RunnerBanner, not per state.
 */
const RUNNER_BANNER_COPY: Record<RunnerBannerState, { title: string; hint: React.JSX.Element; tint: string }> = {
  'auth-expired': {
    title: 'subscription runner sign-in expired',
    hint: (
      <>
        run <code className="rounded bg-raised px-1 font-mono text-[11px] text-ink">claude /login</code> in any
        terminal, then retry.
      </>
    ),
    tint: 'border-err/40 bg-err/10'
  },
  'quota-exhausted': {
    title: 'subscription runner usage limit reached',
    hint: <>the subscription hit its usage limit. it resets automatically; retry once it does.</>,
    tint: 'border-warn/40 bg-warn/10'
  },
  'not-installed': {
    title: 'subscription runner cli unavailable',
    hint: (
      <>
        install claude code (
        <code className="rounded bg-raised px-1 font-mono text-[11px] text-ink">
          npm install -g @anthropic-ai/claude-code
        </code>
        ) or point <code className="rounded bg-raised px-1 font-mono text-[11px] text-ink">runner.binaryPath</code> in
        settings.json at the cli, then retry.
      </>
    ),
    tint: 'border-warn/40 bg-warn/10'
  }
}

/**
 * Runner-health banner (phase 17, §9.7; broadened phase 21). Shown only when the
 * runner is enabled AND in a classified failure state; reasoning falls back to
 * the cloud/local tier meanwhile, so this nudges rather than blocks. Retry runs
 * the manual canary (the one live re-check the renderer can trigger) then
 * re-reads the snapshot.
 */
function RunnerBanner({
  state,
  lastError,
  onRetry
}: {
  state: RunnerBannerState
  lastError: string | null
  onRetry: () => void
}): React.JSX.Element {
  const { title, hint, tint } = RUNNER_BANNER_COPY[state]
  return (
    <div role="alert" data-testid="runner-banner" className={`flex items-start gap-3 border-b px-5 py-2.5 ${tint}`}>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <Badge status={state} />
          <span className="text-[13px] font-medium">{title}</span>
        </div>
        <div className="mt-1 text-[12px] text-ink-mute">
          {hint}{' '}
          reasoning falls back to your cloud or local tier until this clears, so nothing is blocked.
        </div>
        {lastError !== null && lastError !== '' && (
          <div className="mt-1 font-mono text-[11px] break-words text-err">{lastError}</div>
        )}
      </div>
      <div className="shrink-0">
        <Button testId="runner-banner-retry" onClick={onRetry}>
          retry
        </Button>
      </div>
    </div>
  )
}

/**
 * Ambient fallback chip (phase 21). When the runner is enabled but the
 * subscription tier is unavailable, a subscription-eligible role is actually
 * landing on cloud/local. This states that fact in the rail with a neutral warn
 * token — degraded but working — without the banner's urgency. The banner (loud,
 * actionable) and this chip (ambient) COEXIST; neither hides the other.
 */
function RunnerFallbackChip({ status }: { status: RunnerStatusDto }): React.JSX.Element {
  const { label, title } =
    status.effectiveBackend === 'cloud-api'
      ? {
          label: 'fallback: cloud',
          title: 'subscription unavailable — reasoning is running on your cloud api tier until it recovers'
        }
      : status.effectiveBackend === 'local-qwen3'
        ? {
            label: 'fallback: local',
            title: 'subscription unavailable — reasoning is running on the local model until it recovers'
          }
        : {
            label: 'fallback active',
            title: 'subscription unavailable — reasoning is running on the fallback tier'
          }
  return (
    <div role="status" data-testid="runner-fallback-chip" title={title} className="border-t border-line px-4 py-2.5">
      <Badge status="fallback" label={label} />
    </div>
  )
}

function SubsystemStatus(): React.JSX.Element {
  const status = useIpc('app.status', undefined)
  if (status.data === null) return <div className="px-4 py-3 text-[11px] text-ink-faint">…</div>
  const subs = status.data.subsystems
  const entries: readonly { key: string; label: string; up: boolean }[] = [
    { key: 'storage', label: 'storage', up: subs.storage },
    { key: 'models', label: 'models', up: subs.models },
    { key: 'kernel', label: 'kernel', up: subs.kernel },
    { key: 'mcp', label: 'mcp', up: subs.mcp },
    { key: 'agents', label: 'agents', up: subs.agents }
  ]
  return (
    <div className="border-t border-line px-4 py-3">
      <ul className="flex flex-wrap gap-x-3 gap-y-1">
        {entries.map((entry) => (
          <li key={entry.key} className="flex items-center gap-1.5 font-mono text-[11px]">
            <span
              aria-hidden="true"
              className={`inline-block size-1.5 rounded-full ${entry.up ? 'bg-ok' : 'bg-err'}`}
            />
            <span className={entry.up ? 'text-ink-mute' : 'text-err'}>
              {entry.label}
              <span className="sr-only">{entry.up ? ' up' : ' down'}</span>
            </span>
          </li>
        ))}
      </ul>
      <div className="mt-2 font-mono text-[11px] text-ink-faint">
        v{status.data.version} · {status.data.mcpUrl ?? 'mcp off'}
      </div>
    </div>
  )
}

export default function App(): React.JSX.Element {
  const [active, setActive] = useState<PanelKey>('memory')
  const pending = usePolledCount(fetchPendingCount)
  const drift = usePolledCount(fetchDriftCount)
  const week = useReviewWeek()
  const { status: runnerStatus, refresh: refreshRunner } = useRunnerStatus()
  const ActivePanel = PANELS.find((p) => p.key === active)?.component ?? MemoryPanel

  // Retry = one live re-check (the canary) then re-read the snapshot.
  const retryRunner = useCallback(async (): Promise<void> => {
    try {
      await call('runner.testConnection', undefined)
    } catch {
      // The refreshed snapshot still drives the banner; nothing extra to surface.
    } finally {
      refreshRunner()
    }
  }, [refreshRunner])

  const runnerBanner =
    runnerStatus !== null && runnerStatus.enabled && isRunnerBannerState(runnerStatus.state) ? (
      <RunnerBanner state={runnerStatus.state} lastError={runnerStatus.lastError} onRetry={() => void retryRunner()} />
    ) : null

  // Ambient effective-tier fact in the rail — coexists with the banner (no hide-
  // coupling). The `!== 'unknown'` is renderer-only anti-flicker; the DTO stays
  // factual. Runner OFF ⇒ enabled:false ⇒ not rendered (DEFAULT == TODAY).
  const runnerFallbackChip =
    runnerStatus !== null &&
    runnerStatus.enabled &&
    runnerStatus.fallbackActive &&
    runnerStatus.state !== 'unknown' ? (
      <RunnerFallbackChip status={runnerStatus} />
    ) : null

  return (
    <ToastProvider>
      <div className="flex h-full flex-col">
        <TitleBar />
        <div className="flex min-h-0 flex-1">
          <nav className="z-20 flex w-[216px] shrink-0 flex-col border-r border-line bg-surface" aria-label="panels">
            <ul className="flex-1 overflow-y-auto px-2 pt-3">
              {PANELS.map((panel) => {
                const isActive = panel.key === active
                return (
                  <li key={panel.key}>
                    <button
                      type="button"
                      data-testid={`nav-${panel.key}`}
                      aria-current={isActive ? 'page' : undefined}
                      onClick={() => setActive(panel.key)}
                      className={`flex w-full cursor-pointer items-center justify-between rounded-md px-2.5 py-[7px] text-left text-[13px] transition-colors duration-120 ${
                        isActive ? 'bg-raised text-ink shadow-[inset_2px_0_0_var(--color-accent)]' : 'text-ink-mute hover:bg-raised hover:text-ink'
                      }`}
                    >
                      <span>{panel.label}</span>
                      {panel.key === 'review' && pending > 0 && (
                        <span className="rounded-full bg-warn/15 px-1.5 font-mono text-[11px] text-warn" data-testid="review-pending-count">
                          {pending}
                        </span>
                      )}
                      {panel.key === 'skills' && drift > 0 && (
                        <span className="rounded-full bg-warn/15 px-1.5 font-mono text-[11px] text-warn" data-testid="drift-flagged-count">
                          {drift}
                          <span className="sr-only"> drift-flagged skill versions</span>
                        </span>
                      )}
                    </button>
                  </li>
                )
              })}
            </ul>
            <div className="border-t border-line px-4 py-2.5">
              <div className="font-mono text-[11px] text-ink-faint" data-testid="review-week-counter">
                this week{' '}
                <span className={week.staged > week.decided ? 'text-warn' : 'text-ink-mute'}>staged {week.staged}</span>{' '}
                · <span className="text-ink-mute">decided {week.decided}</span>
              </div>
            </div>
            {runnerFallbackChip}
            <SubsystemStatus />
          </nav>
          <main className="flex min-w-0 flex-1 flex-col overflow-hidden">
            {runnerBanner}
            <ActivePanel />
          </main>
        </div>
      </div>
    </ToastProvider>
  )
}
