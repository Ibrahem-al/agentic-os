/**
 * Dashboard shell (phase 10; UI redesign): fixed left rail (Home + grouped
 * panels + subsystem status), panel host on the right. Panel switching is local
 * state — this is a single-window app, not a routed site. Labels and grouping
 * are plain-English per the redesign brief; testids are unchanged.
 */
import { useCallback, useEffect, useState } from 'react'
import type { IpcNodeLabel, RunnerStatusDto } from '../../shared/ipc'
import { call, useIpc } from './lib/ipc'
import { plainStatus } from './lib/plain'
import { Badge, Button, ToastProvider } from './ui/kit'
import { Icon } from './ui/icons'
import type { IconName } from './ui/icons'
import TitleBar from './ui/TitleBar'
import HomePanel from './panels/HomePanel'
import MemoryPanel from './panels/MemoryPanel'
import GraphPanel from './panels/GraphPanel'
import ReviewPanel from './panels/ReviewPanel'
import AuditPanel from './panels/AuditPanel'
import SpendPanel from './panels/SpendPanel'
import TasksPanel from './panels/TasksPanel'
import TracesPanel from './panels/TracesPanel'
import SkillsPanel from './panels/SkillsPanel'
import IngestPanel from './panels/IngestPanel'
import SettingsPanel from './panels/SettingsPanel'

/**
 * Panel identity is a fixed union (not derived) so it can be referenced from
 * PanelProps without a type cycle. Every key keeps its historical `nav-<key>`
 * testid; only the visible labels moved to plain English.
 */
type PanelKey =
  | 'home'
  | 'memory'
  | 'graph'
  | 'review'
  | 'audit'
  | 'spend'
  | 'tasks'
  | 'traces'
  | 'skills'
  | 'ingest'
  | 'settings'

/** A cross-panel deep-link target for the Memory inspector (addendum R3). */
export interface InspectTarget {
  readonly label: IpcNodeLabel
  readonly id: string
}

/**
 * Shared panel prop bag. Home needs to route the user to a deeper panel; the
 * other panels may ignore it (their `() => JSX` signatures stay assignable).
 *
 * R3 deep link: `onInspect(target)` routes to Memory AND opens a node's
 * inspector (used by Approvals source chips); `inspect` is the pending one-shot
 * target App hands to MemoryPanel, which consumes it and calls `onInspectConsumed`.
 * All three are optional so every other panel ignores them unchanged.
 */
export interface PanelProps {
  onNavigate: (key: PanelKey) => void
  onInspect?: (target: InspectTarget) => void
  inspect?: InspectTarget | null
  onInspectConsumed?: () => void
}

interface PanelDef {
  readonly label: string
  readonly icon: IconName
  readonly component: (props: PanelProps) => React.JSX.Element
}

const PANELS: Record<PanelKey, PanelDef> = {
  home: { label: 'Home', icon: 'home', component: HomePanel },
  memory: { label: 'Memory', icon: 'memory', component: MemoryPanel },
  graph: { label: 'Knowledge graph', icon: 'graph', component: GraphPanel },
  review: { label: 'Approvals', icon: 'approvals', component: ReviewPanel },
  audit: { label: 'History', icon: 'history', component: AuditPanel },
  spend: { label: 'Usage & spending', icon: 'spending', component: SpendPanel },
  tasks: { label: 'Background work', icon: 'tasks', component: TasksPanel },
  traces: { label: 'Agent runs', icon: 'runs', component: TracesPanel },
  skills: { label: 'Skills', icon: 'skills', component: SkillsPanel },
  ingest: { label: 'Add knowledge', icon: 'ingest', component: IngestPanel },
  settings: { label: 'Settings', icon: 'settings', component: SettingsPanel }
}

/** Grouped nav (brief IA): Home stands alone; the rest fall under plain group headings. */
const NAV_GROUPS: readonly { readonly label: string | null; readonly keys: readonly PanelKey[] }[] = [
  { label: null, keys: ['home'] },
  { label: 'Decisions', keys: ['review', 'audit'] },
  { label: 'Knowledge', keys: ['memory', 'graph', 'ingest', 'skills'] },
  { label: 'Activity', keys: ['tasks', 'traces', 'spend'] }
]

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
    title: 'Your Claude sign-in has expired',
    hint: (
      <>
        Run <code className="rounded bg-raised px-1 font-mono text-[11px] text-ink">claude /login</code> in any
        terminal, then retry.
      </>
    ),
    tint: 'border-err/40 bg-err/10'
  },
  'quota-exhausted': {
    title: 'Claude usage limit reached',
    hint: <>Your Claude subscription hit its usage limit. It resets on its own — retry once it does.</>,
    tint: 'border-warn/40 bg-warn/10'
  },
  'not-installed': {
    title: 'The Claude command-line tool isn’t set up',
    hint: (
      <>
        Install Claude Code (
        <code className="rounded bg-raised px-1 font-mono text-[11px] text-ink">
          npm install -g @anthropic-ai/claude-code
        </code>
        ) or point <code className="rounded bg-raised px-1 font-mono text-[11px] text-ink">runner.binaryPath</code> in
        settings.json at the tool, then retry.
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
  const plain = plainStatus(state)
  return (
    <div role="alert" data-testid="runner-banner" className={`flex items-start gap-3 border-b px-5 py-2.5 ${tint}`}>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <Badge status={state} label={plain.label} title={plain.explain} />
          <span className="text-[13px] font-medium">{title}</span>
        </div>
        <div className="mt-1 text-[12px] text-ink-mute">
          {hint}{' '}
          Meanwhile your work keeps running on your cloud or local AI, so nothing is blocked.
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
  const { reload } = status
  const [reconnecting, setReconnecting] = useState(false)
  // Full-stack reconnect: re-run every down subsystem's boot step, then refetch
  // app.status so the strip + diagnostics reflect the recovery. app.reconnect is
  // no-throw main-side (failures ride the refreshed diagnostics), so the catch is
  // just belt-and-braces for a transport error.
  const onReconnect = useCallback(async (): Promise<void> => {
    setReconnecting(true)
    try {
      await call('app.reconnect', undefined)
    } catch {
      // The refetched status still drives the strip; nothing extra to surface.
    } finally {
      setReconnecting(false)
      reload()
    }
  }, [reload])
  if (status.data === null) return <div className="px-4 py-3 text-[11px] text-ink-faint">…</div>
  const subs = status.data.subsystems
  // Boot subsystems in plain words (brief dictionary). `up` is whether the boot
  // stage produced a live singleton this launch.
  const entries: readonly { key: string; label: string; up: boolean }[] = [
    { key: 'storage', label: 'Storage', up: subs.storage },
    { key: 'models', label: 'AI models', up: subs.models },
    { key: 'kernel', label: 'Core engine', up: subs.kernel },
    { key: 'mcp', label: 'Claude connection', up: subs.mcp },
    { key: 'agents', label: 'Background agents', up: subs.agents }
  ]
  const plainSubsystem = (key: string): string => entries.find((e) => e.key === key)?.label ?? key
  // Any subsystem that failed or came up degraded, with its human-readable
  // reason (a corrupt WAL, a decrypt failure, a port in use, …). Shown only when
  // something is wrong — a healthy launch renders just the calm "all running" row.
  const problems = (status.data.diagnostics ?? []).filter((d) => d.level !== 'ok')
  // What to name in the "needs attention" line: down subsystems plus any that
  // came up but reported a warn/error diagnostic (up-but-degraded).
  const attention = new Set<string>()
  for (const entry of entries) if (!entry.up) attention.add(entry.label)
  for (const problem of problems) attention.add(plainSubsystem(problem.subsystem))
  const healthy = attention.size === 0
  return (
    <div className="border-t border-line px-4 py-3">
      {healthy ? (
        <div className="flex items-center gap-1.5 text-[12px] text-ink-mute">
          <span aria-hidden="true" className="inline-block size-1.5 rounded-full bg-ok" />
          <span>All systems running</span>
        </div>
      ) : (
        <>
          <div className="flex items-start justify-between gap-2">
            <div className="flex items-start gap-1.5 text-[12px] text-warn">
              <span aria-hidden="true" className="mt-1.5 inline-block size-1.5 shrink-0 rounded-full bg-err" />
              <span>
                {attention.size === 1 ? '1 part needs' : `${attention.size} parts need`} attention:{' '}
                {[...attention].join(', ')}
              </span>
            </div>
            {problems.length > 0 && (
              <Button
                testId="subsystem-reconnect"
                onClick={() => void onReconnect()}
                disabled={reconnecting}
                title="Try starting the parts that didn’t come up again"
              >
                {reconnecting ? 'reconnecting…' : 'reconnect'}
              </Button>
            )}
          </div>
          {problems.length > 0 && (
            <ul
              role="status"
              data-testid="subsystem-diagnostics"
              className="mt-2 max-h-44 space-y-1.5 overflow-y-auto"
            >
              {problems.map((d) => (
                <li key={d.subsystem} className="text-[11px] leading-snug">
                  <span className={`font-medium ${d.level === 'error' ? 'text-err' : 'text-warn'}`}>
                    {plainSubsystem(d.subsystem)}
                  </span>{' '}
                  <span className="break-words text-ink-mute">{d.detail}</span>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
      <div className="mt-2 font-mono text-[11px] text-ink-faint">
        v{status.data.version} · {status.data.mcpUrl ?? 'mcp off'}
      </div>
    </div>
  )
}

/**
 * One nav-rail item: icon + plain label, 32px tall, the grandfathered 2px accent
 * inset when active. Carries the review pending-count and skills drift badges
 * (unchanged testids). Keeps its historical `nav-<key>` testid.
 */
function NavItem({
  panelKey,
  active,
  pending,
  drift,
  onSelect
}: {
  panelKey: PanelKey
  active: PanelKey
  pending: number
  drift: number
  onSelect: (key: PanelKey) => void
}): React.JSX.Element {
  const def = PANELS[panelKey]
  const isActive = panelKey === active
  return (
    <button
      type="button"
      data-testid={`nav-${panelKey}`}
      aria-current={isActive ? 'page' : undefined}
      onClick={() => onSelect(panelKey)}
      className={`flex h-8 w-full cursor-pointer items-center gap-2.5 rounded-md px-2.5 text-left text-[13px] transition-colors duration-120 ${
        isActive
          ? 'bg-raised text-ink shadow-[inset_2px_0_0_var(--color-accent)]'
          : 'text-ink-mute hover:bg-raised hover:text-ink'
      }`}
    >
      <Icon name={def.icon} size={16} className="shrink-0" />
      <span className="min-w-0 flex-1 truncate">{def.label}</span>
      {panelKey === 'review' && pending > 0 && (
        <span
          className="rounded-full bg-warn/15 px-1.5 font-mono text-[11px] text-warn"
          data-testid="review-pending-count"
        >
          {pending}
        </span>
      )}
      {panelKey === 'skills' && drift > 0 && (
        <span
          className="rounded-full bg-warn/15 px-1.5 font-mono text-[11px] text-warn"
          data-testid="drift-flagged-count"
        >
          {drift}
          <span className="sr-only"> drift-flagged skill versions</span>
        </span>
      )}
    </button>
  )
}

export default function App(): React.JSX.Element {
  const [active, setActive] = useState<PanelKey>('home')
  // R3 one-shot deep-link target: set by onInspect, consumed + cleared by MemoryPanel.
  const [inspectTarget, setInspectTarget] = useState<InspectTarget | null>(null)
  const pending = usePolledCount(fetchPendingCount)
  const drift = usePolledCount(fetchDriftCount)
  const { status: runnerStatus, refresh: refreshRunner } = useRunnerStatus()
  const ActivePanel = PANELS[active].component

  // Route to Memory and open a node's inspector (Approvals source chips, etc.).
  const onInspect = useCallback((target: InspectTarget) => {
    setInspectTarget(target)
    setActive('memory')
  }, [])
  const onInspectConsumed = useCallback(() => setInspectTarget(null), [])

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
            <div className="flex-1 overflow-y-auto px-2 pt-3">
              {NAV_GROUPS.map((group, i) => (
                <div key={group.label ?? 'top'} className={i > 0 ? 'mt-3' : ''}>
                  {group.label !== null && (
                    <div className="px-2.5 pb-1 text-[11px] font-medium text-ink-mute">{group.label}</div>
                  )}
                  <div className="flex flex-col gap-0.5">
                    {group.keys.map((key) => (
                      <NavItem
                        key={key}
                        panelKey={key}
                        active={active}
                        pending={pending}
                        drift={drift}
                        onSelect={setActive}
                      />
                    ))}
                  </div>
                </div>
              ))}
            </div>
            <div className="border-t border-line px-2 py-2">
              <NavItem panelKey="settings" active={active} pending={pending} drift={drift} onSelect={setActive} />
            </div>
            {runnerFallbackChip}
            <SubsystemStatus />
          </nav>
          <main className="flex min-w-0 flex-1 flex-col overflow-hidden">
            {runnerBanner}
            <ActivePanel
              onNavigate={setActive}
              onInspect={onInspect}
              inspect={active === 'memory' ? inspectTarget : null}
              onInspectConsumed={onInspectConsumed}
            />
          </main>
        </div>
      </div>
    </ToastProvider>
  )
}
