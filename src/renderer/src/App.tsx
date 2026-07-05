/**
 * Dashboard shell (phase 10): fixed left rail (9 panels + subsystem status),
 * panel host on the right. Panel switching is local state — this is a
 * single-window cockpit, not a routed site.
 */
import { useEffect, useState } from 'react'
import { call, useIpc } from './lib/ipc'
import { ToastProvider } from './ui/kit'
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

/** Review work waiting on the operator — shown as a count in the rail. */
function usePendingCount(): number {
  const [pending, setPending] = useState(0)
  useEffect(() => {
    let cancelled = false
    const refresh = async (): Promise<void> => {
      try {
        const [staged, approvals] = await Promise.all([
          call('review.staged.list', { status: 'staged' }),
          call('review.approvals.list', { status: 'pending' })
        ])
        if (!cancelled) setPending(staged.length + approvals.length)
      } catch {
        // Subsystem unavailable — the review panel says so; the rail stays quiet.
      }
    }
    void refresh()
    const timer = setInterval(() => void refresh(), 20_000)
    return () => {
      cancelled = true
      clearInterval(timer)
    }
  }, [])
  return pending
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
  const pending = usePendingCount()
  const ActivePanel = PANELS.find((p) => p.key === active)?.component ?? MemoryPanel

  return (
    <ToastProvider>
      <div className="flex h-full">
        <nav className="z-20 flex w-[216px] shrink-0 flex-col border-r border-line bg-surface" aria-label="panels">
          <div className="px-4 pt-4 pb-3">
            <div className="text-[14px] font-semibold tracking-tight">agentic-os</div>
            <div className="font-mono text-[11px] text-ink-faint">operations console</div>
          </div>
          <ul className="flex-1 overflow-y-auto px-2">
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
                  </button>
                </li>
              )
            })}
          </ul>
          <SubsystemStatus />
        </nav>
        <main className="flex min-w-0 flex-1 flex-col overflow-hidden">
          <ActivePanel />
        </main>
      </div>
    </ToastProvider>
  )
}
