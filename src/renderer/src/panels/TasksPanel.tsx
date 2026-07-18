/**
 * Background work panel (UI redesign §P5) — the plain-language view of the two
 * things happening behind the scenes: small jobs the assistant runs on its own
 * (the durable §8 queue) and the folders it watches so new files reach memory
 * automatically (§7). A third "Automation" block keeps the §20 schedules and
 * §17 rules (with validation errors verbatim) visible without leading with
 * them. Re-skin only: every IPC call, the scan/add/remove flows, and the
 * `watch-scan-<name>` + "N ingested" contracts are unchanged.
 */
import { useState } from 'react'
import { call, IpcError, useIpc } from '../lib/ipc'
import { tokens, truncate } from '../lib/format'
import {
  Badge,
  Button,
  DataTable,
  Disclosure,
  ErrorState,
  LoadingRows,
  Modal,
  PanelHeader,
  SectionHeader,
  TextInput,
  Timestamp,
  useToast
} from '../ui/kit'
import type { Column } from '../ui/kit'
import { Icon } from '../ui/icons'
import { CompositionBar } from '../ui/viz'
import { plainBytes, plainDuration, plainStatus, plainUsd, plural } from '../lib/plain'
import type {
  TaskDto,
  TaskProcessesDto,
  TaskSummaryDto,
  TriggersStatusDto,
  WatchScanResultDto,
  WatchedFolderDto
} from '../../../shared/ipc'

function errMessage(err: unknown): string {
  return err instanceof IpcError ? err.message : String(err)
}

/** Backend job kinds are slugs ("extract-doc"); show them as plain words. */
function plainKind(kind: string): string {
  return kind.replace(/[_-]+/g, ' ').trim()
}

/** "Run now" applies to a job that is stopped or stuck (not running / not already done). */
function canRunNow(status: TaskDto['status']): boolean {
  return status === 'deferred' || status === 'failed' || status === 'cancelled' || status === 'pending'
}

/** "Cancel" applies to a job that is in progress, queued, or paused. */
function canCancel(status: TaskDto['status']): boolean {
  return status === 'running' || status === 'pending' || status === 'deferred' || status === 'paused'
}

/** "Pause" (hold without ending) applies to a job that is in progress or queued. */
function canPause(status: TaskDto['status']): boolean {
  return status === 'running' || status === 'pending' || status === 'deferred'
}

/** "Resume" applies only to a paused job. */
function canResume(status: TaskDto['status']): boolean {
  return status === 'paused'
}

// ── jobs table ────────────────────────────────────────────────────────────────

const TASK_DISPLAY_COLUMNS: readonly Column<TaskDto>[] = [
  {
    key: 'kind',
    header: 'job',
    // The raw kind + id live in the tooltip so a row leads with the plain word.
    render: (row) => <span title={`${row.kind} · ${row.id}`}>{plainKind(row.kind)}</span>
  },
  {
    key: 'status',
    header: 'status',
    render: (row) => {
      const p = plainStatus(row.status)
      return <Badge status={row.status} label={p.label} title={p.explain} />
    }
  },
  {
    key: 'attempts',
    header: 'tries',
    className: 'font-mono text-[11px] text-ink-mute whitespace-nowrap',
    // A first attempt is unremarkable; only surface the count once it retried.
    render: (row) => (row.attempts > 1 ? `retried ${row.attempts}×` : '—')
  },
  { key: 'updated', header: 'updated', render: (row) => <Timestamp iso={row.updatedAt} /> },
  {
    key: 'error',
    header: 'details',
    className: 'max-w-96',
    render: (row) =>
      row.lastError === null || row.lastError === '' ? (
        <span className="text-ink-mute">—</span>
      ) : (
        <Disclosure summary={<span className="text-err">Why it failed</span>}>
          <p className="font-mono text-[11px] break-words text-err">{row.lastError}</p>
        </Disclosure>
      )
  }
]

/** Composition of task statuses + a one-line summary above the jobs table. */
function JobsBody({
  rows,
  columns
}: {
  rows: readonly TaskDto[]
  columns: readonly Column<TaskDto>[]
}): React.JSX.Element {
  const counts: Record<TaskDto['status'], number> = {
    pending: 0,
    running: 0,
    done: 0,
    failed: 0,
    deferred: 0,
    cancelled: 0,
    paused: 0
  }
  for (const task of rows) counts[task.status] += 1

  // Semantic tints (brief §P5): running = accent, waiting = mute, finished = ok,
  // postponed = warn, paused = undo, cancelled = mute, failed = err. Labels match lib/plain.
  const segments = [
    { label: 'in progress', count: counts.running, tint: 'accent' as const },
    { label: 'waiting', count: counts.pending, tint: 'mute' as const },
    { label: 'finished', count: counts.done, tint: 'ok' as const },
    { label: 'postponed', count: counts.deferred, tint: 'warn' as const },
    { label: 'paused', count: counts.paused, tint: 'undo' as const },
    { label: 'cancelled', count: counts.cancelled, tint: 'mute' as const },
    { label: 'failed', count: counts.failed, tint: 'err' as const }
  ]
  const active = counts.running + counts.pending
  const summary =
    active > 0
      ? `${plural(active, 'job')} running or waiting right now.`
      : counts.failed > 0
        ? `Nothing running right now. ${plural(counts.failed, 'job')} failed recently.`
        : 'Nothing running right now — everything is caught up.'
  const statusPhrase = segments
    .filter((s) => s.count > 0)
    .map((s) => `${s.count} ${s.label}`)
    .join(', ')

  return (
    <>
      {rows.length > 0 && (
        <div className="mb-3 flex flex-col gap-2">
          <p className="text-[13px] text-ink-mute">{summary}</p>
          <CompositionBar segments={segments} ariaLabel={`Background jobs by status: ${statusPhrase}.`} />
        </div>
      )}
      <DataTable
        columns={columns}
        rows={rows}
        rowKey={(row) => row.id}
        empty="No background jobs right now — the assistant's small tasks show up here while they run."
        testId="tasks-table"
      />
    </>
  )
}

// ── resources & summary (per-task modal) ─────────────────────────────────────────

/** One CPU/RAM line — cpu% and memory, each shown only when the OS reported it. */
function ResourceMeter({ cpuPercent, memoryBytes }: { cpuPercent: number | null; memoryBytes: number | null }): React.JSX.Element {
  const parts: string[] = []
  if (cpuPercent !== null) parts.push(`${cpuPercent.toFixed(1)}% CPU`)
  if (memoryBytes !== null) parts.push(plainBytes(memoryBytes))
  return <span className="font-mono text-[11px] text-ink">{parts.length > 0 ? parts.join(' · ') : '—'}</span>
}

/** A hairline-separated label → value row in the summary. */
function StatLine({ label, children }: { label: string; children: React.ReactNode }): React.JSX.Element {
  return (
    <div className="flex items-baseline justify-between gap-4 border-b border-line py-1.5 last:border-0">
      <span className="shrink-0 text-[12px] text-ink-mute">{label}</span>
      <span className="text-right text-[12px] text-ink">{children}</span>
    </div>
  )
}

const TOKENS_TITLE = 'units of AI text, roughly ¾ of a word'

/** The "averages and time it took" summary — meaningful even for a finished job. */
function TaskSummaryView({ summary }: { summary: TaskSummaryDto }): React.JSX.Element {
  const { durationMs, running, kindAvgDurationMs, kindSampleSize, attempts, cloud, runner } = summary
  const durationText =
    durationMs === null
      ? summary.status === 'pending'
        ? "Hasn't run yet."
        : 'Not recorded.'
      : running
        ? `${plainDuration(durationMs)} so far`
        : plainDuration(durationMs)
  return (
    <div className="flex flex-col" data-testid="task-summary">
      <StatLine label={running ? 'Running for' : 'Time it took'}>{durationText}</StatLine>
      {kindAvgDurationMs !== null && (
        <StatLine label={`Similar jobs (${plural(kindSampleSize, 'run')})`}>
          typically {plainDuration(kindAvgDurationMs)}
        </StatLine>
      )}
      <StatLine label="Tries">{attempts > 1 ? `${attempts} (retried)` : '1'}</StatLine>
      {cloud !== null && (
        <StatLine label="Cloud AI">
          <span title={TOKENS_TITLE} className="font-mono">
            {tokens(cloud.inputTokens)} / {tokens(cloud.outputTokens)}
          </span>{' '}
          · {plainUsd(cloud.usd)} · {plural(cloud.calls, 'call')}
        </StatLine>
      )}
      {runner !== null && (
        <StatLine label="Subscription AI">
          <span title={TOKENS_TITLE} className="font-mono">
            {tokens(runner.inputTokens)} / {tokens(runner.outputTokens)}
          </span>{' '}
          · {plural(runner.runs, 'run')}
        </StatLine>
      )}
      {cloud === null && runner === null && (
        <StatLine label="AI used">on‑device model (not itemized per job)</StatLine>
      )}
      {summary.lastError !== null && summary.lastError !== '' && (
        <div className="mt-2 rounded-md border border-err/40 bg-err/10 px-3 py-2 font-mono text-[11px] break-words text-err">
          {summary.lastError}
        </div>
      )}
    </div>
  )
}

/**
 * Live OS processes for a RUNNING task: the app's own process (where in-process
 * jobs run), the shared Ollama models the local tier holds, and any child
 * processes the task spawned. Shown only while the task is in flight.
 */
function LiveProcessesView({ data }: { data: TaskProcessesDto }): React.JSX.Element {
  const models = data.localRuntime.loadedModels
  return (
    <div className="flex flex-col gap-3" data-testid="task-processes">
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="rounded-md border border-line px-4 py-3">
          <div className="mb-1 text-[12px] font-medium text-ink">This app</div>
          <p className="mb-2 text-[12px] text-ink-mute">Where the assistant runs its own small jobs.</p>
          {data.host === null ? (
            <span className="text-[12px] text-ink-mute">Not available.</span>
          ) : (
            <div className="flex items-center justify-between">
              <span className="text-[12px] text-ink-mute" title={`pid ${data.host.pid ?? '—'}`}>
                {data.host.name}
              </span>
              <ResourceMeter cpuPercent={data.host.cpuPercent} memoryBytes={data.host.memoryBytes} />
            </div>
          )}
        </div>

        <div className="rounded-md border border-line px-4 py-3">
          <div className="mb-1 text-[12px] font-medium text-ink">Local AI models</div>
          <p className="mb-2 text-[12px] text-ink-mute">Shared across jobs (the Ollama models held in memory).</p>
          {!data.localRuntime.reachable ? (
            <span className="text-[12px] text-ink-mute">The local model service isn&apos;t running.</span>
          ) : models.length === 0 ? (
            <span className="text-[12px] text-ink-mute">No models loaded right now.</span>
          ) : (
            <ul className="flex flex-col gap-1">
              {models.map((m) => (
                <li key={m.name} className="flex items-center justify-between">
                  <span className="font-mono text-[11px] text-ink">{m.name}</span>
                  <span className="font-mono text-[11px] text-ink" title={m.sizeVramBytes > 0 ? `${plainBytes(m.sizeVramBytes)} on GPU` : 'CPU only'}>
                    {plainBytes(m.sizeBytes)}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>

      {data.children.length > 0 && (
        <div className="rounded-md border border-line px-4 py-3">
          <div className="mb-2 text-[12px] font-medium text-ink">Child processes for this job</div>
          <ul className="flex flex-col gap-1">
            {data.children.map((c, i) => (
              <li key={`${c.pid ?? 'x'}-${i}`} className="flex items-center justify-between">
                <span className="font-mono text-[11px] text-ink-mute">
                  {c.role} {c.pid !== null ? `· pid ${c.pid}` : ''} {c.live ? '' : '(finished)'}
                </span>
                <ResourceMeter cpuPercent={c.cpuPercent} memoryBytes={c.memoryBytes} />
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}

/** Per-task "Resources" modal: the summary always, plus live processes while it runs. */
function TaskResourcesModal({ taskId, kind, onClose }: { taskId: string; kind: string; onClose: () => void }): React.JSX.Element {
  const proc = useIpc('tasks.processes', { id: taskId })
  return (
    <Modal
      title={`Resources — ${plainKind(kind)}`}
      onClose={onClose}
      wide
      footer={
        <>
          <Button onClick={() => proc.reload()}>Refresh</Button>
          <Button variant="primary" onClick={onClose}>
            Close
          </Button>
        </>
      }
    >
      {proc.error !== null ? (
        <ErrorState error={proc.error} onRetry={proc.reload} />
      ) : proc.data === null ? (
        <LoadingRows rows={3} />
      ) : (
        <div className="flex flex-col gap-4" data-testid="task-resources">
          <div className="font-mono text-[11px] break-all text-ink-mute">{taskId}</div>
          {proc.data.summary !== null ? (
            <TaskSummaryView summary={proc.data.summary} />
          ) : (
            <p className="text-[12px] text-ink-mute">No summary available for this job.</p>
          )}
          {proc.data.running && (
            <div className="flex flex-col gap-2">
              <SectionHeader>Running now — processes &amp; resources</SectionHeader>
              <LiveProcessesView data={proc.data} />
            </div>
          )}
        </div>
      )}
    </Modal>
  )
}

/** Confirm the destructive cancel, offering Pause as the non-destructive alternative. */
function CancelConfirmModal({
  task,
  busy,
  onPause,
  onConfirm,
  onClose
}: {
  task: TaskDto
  busy: boolean
  onPause: () => void
  onConfirm: () => void
  onClose: () => void
}): React.JSX.Element {
  const pausable = canPause(task.status)
  return (
    <Modal
      title="Stop this job?"
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose} disabled={busy}>
            Keep it
          </Button>
          {pausable && (
            <Button variant="primary" testId="task-cancel-pause-instead" disabled={busy} onClick={onPause}>
              Pause instead
            </Button>
          )}
          <Button variant="danger" testId="task-cancel-confirm" disabled={busy} onClick={onConfirm}>
            Cancel job
          </Button>
        </>
      }
    >
      <p className="text-[13px]">
        Cancelling stops <span className="font-mono text-[11px]">{plainKind(task.kind)}</span> and discards its
        progress. You can revive it later with Run now, but it starts over.
      </p>
      {pausable && (
        <p className="mt-2 text-[12px] leading-5 text-ink-mute">
          To hold it without losing your place, <strong className="text-ink">Pause</strong> it instead — a paused job
          waits until you resume it.
        </p>
      )}
    </Modal>
  )
}

// ── automation (schedules & rules) ──────────────────────────────────────────────

/** The §20 schedules and §17 rules, in plain words; rule errors stay verbatim. */
function AutomationBody({ data }: { data: TriggersStatusDto }): React.JSX.Element {
  const queuePhrase = Object.entries(data.queue.counts)
    .map(([status, count]) => `${count} ${plainStatus(status).label}`)
    .join(', ')
  const installed = data.hook.installed
  const hookLine =
    installed === true
      ? 'The session-end hook is installed.'
      : installed === false
        ? 'The session-end hook is not installed — you can install it from Settings.'
        : 'The session-end hook status is unknown — settings.json could not be read.'

  return (
    <div className="flex flex-col gap-3" data-testid="triggers-status">
      <div className="flex flex-col gap-1 text-[13px]">
        <div className="text-ink">{queuePhrase === '' ? 'The job queue is empty right now.' : `In the queue: ${queuePhrase}.`}</div>
        <div className="text-ink-mute">
          {data.queue.runningTaskId !== null ? (
            <>
              Running now: <span className="font-mono text-[11px]">{data.queue.runningTaskId}</span>
            </>
          ) : (
            'Nothing is running right now.'
          )}
        </div>
        <div className="text-ink-mute">{hookLine}</div>
      </div>

      {data.schedules.length > 0 && (
        <div className="flex flex-col gap-1">
          <div className="text-[12px] font-medium text-ink">Schedules</div>
          {data.schedules.map((schedule) => (
            <div key={schedule.name} className="text-[12px] text-ink-mute">
              {schedule.name} runs on <span className="font-mono text-[11px]">{schedule.cron}</span> — next{' '}
              {schedule.nextRunAt !== null ? <Timestamp iso={schedule.nextRunAt} /> : 'not scheduled'}
            </div>
          ))}
        </div>
      )}

      {data.rules.length > 0 && (
        <Disclosure summary={plural(data.rules.length, 'loaded rule')}>
          <ul className="flex flex-col gap-1 font-mono text-[11px] text-ink-mute">
            {data.rules.map((rule) => (
              <li key={rule.id}>
                {rule.id}: {rule.trigger}
              </li>
            ))}
          </ul>
        </Disclosure>
      )}

      {data.ruleErrors.map((failure) => (
        <div key={failure.file} className="text-[12px] text-err" title={failure.file}>
          A rule file couldn&apos;t be loaded ({truncate(failure.file, 60)}): {failure.error}
        </div>
      ))}
    </div>
  )
}

// ── panel ───────────────────────────────────────────────────────────────────────

export default function TasksPanel(): React.JSX.Element {
  const tasks = useIpc('tasks.list', undefined)
  const watchers = useIpc('watch.list', undefined)
  const triggers = useIpc('triggers.status', undefined)
  const toast = useToast()

  const [scanningName, setScanningName] = useState<string | null>(null)
  const [removingName, setRemovingName] = useState<string | null>(null)
  const [scanResult, setScanResult] = useState<WatchScanResultDto | null>(null)

  const [name, setName] = useState('')
  const [path, setPath] = useState('')
  const [tags, setTags] = useState('')
  const [adding, setAdding] = useState(false)

  // Job controls. busyTaskId guards a row's buttons during a call; the two modals
  // hold the target task for the Resources view and the cancel confirmation.
  const [busyTaskId, setBusyTaskId] = useState<string | null>(null)
  const [resourcesTask, setResourcesTask] = useState<{ id: string; kind: string } | null>(null)
  const [cancelTask, setCancelTask] = useState<TaskDto | null>(null)

  const runNowJob = async (id: string): Promise<void> => {
    setBusyTaskId(id)
    try {
      await call('tasks.runNow', { id })
      toast.notify('ok', 'Job queued to run now')
      tasks.reload()
    } catch (err) {
      toast.notify('err', errMessage(err))
    } finally {
      setBusyTaskId(null)
    }
  }

  const cancelJob = async (id: string): Promise<void> => {
    setBusyTaskId(id)
    try {
      const result = await call('tasks.cancel', { id })
      // A running job cancels cooperatively (it stops at its next step boundary),
      // so report a REQUEST; a queued job is dropped outright, so report done.
      const stopped = result.killedChildren > 0 ? ` (${plural(result.killedChildren, 'process', 'processes')} stopped)` : ''
      toast.notify('ok', result.wasRunning ? `Cancelling…${stopped}` : `Job cancelled${stopped}`)
      tasks.reload()
    } catch (err) {
      toast.notify('err', errMessage(err))
    } finally {
      setBusyTaskId(null)
    }
  }

  const pauseJob = async (id: string): Promise<void> => {
    setBusyTaskId(id)
    try {
      const result = await call('tasks.pause', { id })
      const stopped =
        result.killedChildren > 0 ? ` (${plural(result.killedChildren, 'process', 'processes')} stopped)` : ''
      toast.notify('ok', result.wasRunning ? `Pausing…${stopped}` : `Job paused${stopped}`)
      tasks.reload()
    } catch (err) {
      toast.notify('err', errMessage(err))
    } finally {
      setBusyTaskId(null)
    }
  }

  const resumeJob = async (id: string): Promise<void> => {
    setBusyTaskId(id)
    try {
      await call('tasks.resume', { id })
      toast.notify('ok', 'Job resumed')
      tasks.reload()
    } catch (err) {
      toast.notify('err', errMessage(err))
    } finally {
      setBusyTaskId(null)
    }
  }

  const scanNow = async (folderName: string): Promise<void> => {
    setScanningName(folderName)
    try {
      const result = await call('watch.scan', { name: folderName })
      setScanResult(result)
      // Keep the "N ingested" phrasing — a scan-result e2e asserts /2 ingested/i.
      toast.notify(
        'ok',
        `Scanned ${result.scannedFiles} files — ${result.ingested.length} ingested, ${result.skipped.length} skipped, ${result.failed.length} failed`
      )
    } catch (err) {
      toast.notify('err', errMessage(err))
    } finally {
      setScanningName(null)
    }
  }

  const removeFolder = async (folderName: string): Promise<void> => {
    setRemovingName(folderName)
    try {
      await call('watch.remove', { name: folderName })
      toast.notify('ok', `Removed ${folderName}`)
      watchers.reload()
    } catch (err) {
      toast.notify('err', errMessage(err))
    } finally {
      setRemovingName(null)
    }
  }

  const browse = async (): Promise<void> => {
    try {
      const picked = await call('ingest.pick', { kind: 'folder' })
      if (picked.path !== null) setPath(picked.path)
    } catch (err) {
      toast.notify('err', errMessage(err))
    }
  }

  const addFolder = async (): Promise<void> => {
    setAdding(true)
    try {
      const folderName = name.trim()
      await call('watch.add', {
        name: folderName,
        path: path.trim(),
        tags: tags
          .split(',')
          .map((tag) => tag.trim())
          .filter((tag) => tag !== '')
      })
      toast.notify('ok', `Added ${folderName}`)
      setName('')
      setPath('')
      setTags('')
      watchers.reload()
    } catch (err) {
      toast.notify('err', errMessage(err))
    } finally {
      setAdding(false)
    }
  }

  const taskColumns: readonly Column<TaskDto>[] = [
    ...TASK_DISPLAY_COLUMNS,
    {
      key: 'actions',
      header: '',
      render: (row) => {
        const busy = busyTaskId === row.id
        const isWorkflow = row.kind === 'workflow'
        return (
          <span className="flex items-center justify-end gap-1.5">
            {!isWorkflow && canRunNow(row.status) && (
              <Button
                variant="ghost"
                disabled={busy}
                onClick={() => void runNowJob(row.id)}
                testId={`task-run-${row.id}`}
              >
                {busy ? '…' : 'Run now'}
              </Button>
            )}
            {!isWorkflow && canResume(row.status) && (
              <Button
                variant="primary"
                disabled={busy}
                onClick={() => void resumeJob(row.id)}
                testId={`task-resume-${row.id}`}
              >
                {busy ? '…' : 'Resume'}
              </Button>
            )}
            {!isWorkflow && canPause(row.status) && (
              <Button
                variant="ghost"
                disabled={busy}
                onClick={() => void pauseJob(row.id)}
                testId={`task-pause-${row.id}`}
              >
                Pause
              </Button>
            )}
            {!isWorkflow && canCancel(row.status) && (
              <Button
                variant="danger-ghost"
                disabled={busy}
                onClick={() => setCancelTask(row)}
                testId={`task-cancel-${row.id}`}
              >
                Cancel
              </Button>
            )}
            <Button
              variant="ghost"
              onClick={() => setResourcesTask({ id: row.id, kind: row.kind })}
              testId={`task-resources-${row.id}`}
            >
              Resources
            </Button>
          </span>
        )
      }
    }
  ]

  const watcherColumns: readonly Column<WatchedFolderDto>[] = [
    { key: 'name', header: 'name', render: (row) => row.name },
    {
      key: 'path',
      header: 'location',
      className: 'font-mono max-w-64',
      render: (row) => (
        <span className="block truncate" title={row.path}>
          {row.path}
        </span>
      )
    },
    { key: 'tags', header: 'tags', render: (row) => (row.tags.length > 0 ? row.tags.join(', ') : '—') },
    {
      key: 'extensions',
      header: 'file types',
      render: (row) =>
        row.extensions !== undefined && row.extensions.length > 0 ? row.extensions.join(', ') : 'all supported'
    },
    {
      key: 'enabled',
      header: 'watching',
      render: (row) => <span className={row.enabled ? 'text-ink' : 'text-ink-mute'}>{row.enabled ? 'on' : 'off'}</span>
    },
    {
      key: 'actions',
      header: '',
      render: (row) => (
        <span className="flex items-center gap-1.5">
          <Button
            variant="ghost"
            disabled={scanningName !== null}
            onClick={() => void scanNow(row.name)}
            testId={`watch-scan-${row.name}`}
          >
            {scanningName === row.name ? 'Scanning…' : 'Scan now'}
          </Button>
          <Button
            variant="danger-ghost"
            disabled={removingName !== null}
            onClick={() => void removeFolder(row.name)}
            testId={`watch-remove-${row.name}`}
          >
            Remove
          </Button>
        </span>
      )
    }
  ]

  return (
    <>
      <PanelHeader
        title="Background work"
        subtitle="Jobs running behind the scenes, and folders being watched."
        icon={<Icon name="tasks" size={18} />}
      />
      <div className="flex min-h-0 flex-1 flex-col gap-6 overflow-y-auto px-5 py-4">
        <section>
          <SectionHeader meta="Small tasks the assistant runs on its own — run one now, or cancel it">Jobs</SectionHeader>
          {tasks.error !== null ? (
            <ErrorState error={tasks.error} onRetry={tasks.reload} />
          ) : tasks.data === null ? (
            <LoadingRows rows={3} />
          ) : (
            <JobsBody rows={tasks.data} columns={taskColumns} />
          )}
        </section>

        <section>
          <SectionHeader meta="Files added to memory automatically as they change">Watched folders</SectionHeader>
          {watchers.error !== null ? (
            <ErrorState error={watchers.error} onRetry={watchers.reload} />
          ) : watchers.data === null ? (
            <LoadingRows rows={3} />
          ) : (
            <DataTable
              columns={watcherColumns}
              rows={watchers.data}
              rowKey={(row) => row.name}
              empty="No watched folders yet — add one below and supported files will be added to memory automatically."
              testId="watchers-table"
            />
          )}

          {scanResult !== null && (
            <div className="mt-3 flex flex-col gap-2 rounded-md border border-line px-4 py-3" data-testid="scan-result">
              <div className="text-[13px] text-ink">
                {/* "N ingested" stays contiguous here — a scan-result e2e asserts /2 ingested/i. */}
                {`Scanned ${scanResult.scannedFiles} files from ${scanResult.folder} — ${scanResult.ingested.length} ingested, ${scanResult.skipped.length} skipped, ${scanResult.failed.length} failed.`}
              </div>
              <div className="font-mono text-[11px] text-ink-mute" title={scanResult.path}>
                {truncate(scanResult.path, 80)}
              </div>
              {scanResult.ingested.length > 0 && (
                <Disclosure summary={`Files added (${scanResult.ingested.length})`}>
                  <ul className="flex max-h-48 flex-col gap-1 overflow-y-auto font-mono text-[11px]">
                    {scanResult.ingested.map((entry) => (
                      <li key={`ok-${entry.file}`}>
                        <span className="text-ok">{entry.file}</span>{' '}
                        <span className="text-ink-mute">({entry.chunkCount} chunks)</span>
                      </li>
                    ))}
                  </ul>
                </Disclosure>
              )}
              {scanResult.skipped.length > 0 && (
                <Disclosure summary={`Files skipped (${scanResult.skipped.length})`}>
                  <ul className="flex max-h-48 flex-col gap-1 overflow-y-auto font-mono text-[11px] text-ink-mute">
                    {scanResult.skipped.map((entry) => (
                      <li key={`skip-${entry.file}`}>
                        {entry.file} <span className="text-ink-mute">({entry.reason})</span>
                      </li>
                    ))}
                  </ul>
                </Disclosure>
              )}
              {scanResult.failed.length > 0 && (
                <Disclosure
                  defaultOpen
                  summary={<span className="text-err">{`Files that failed (${scanResult.failed.length})`}</span>}
                >
                  <ul className="flex max-h-48 flex-col gap-1 overflow-y-auto font-mono text-[11px] text-err">
                    {scanResult.failed.map((entry) => (
                      <li key={`fail-${entry.file}`}>
                        {entry.file}: {entry.error}
                      </li>
                    ))}
                  </ul>
                </Disclosure>
              )}
            </div>
          )}

          <div className="mt-4 rounded-md border border-line p-4">
            <div className="mb-3">
              <h3 className="text-[13px] font-semibold">Watch a new folder</h3>
              <p className="mt-0.5 text-[12px] text-ink-mute">
                Point the assistant at a folder and it adds supported files to memory as they change.
              </p>
            </div>
            <div className="flex flex-wrap items-start gap-4">
              <div className="flex flex-col gap-1">
                <TextInput label="Name" value={name} onChange={setName} testId="watch-name-input" width="w-44" />
                <span className="text-[12px] text-ink-mute">A short label to recognize it by.</span>
              </div>
              <div className="flex flex-col gap-1">
                <span className="text-[12px] text-ink-mute">Folder</span>
                <div className="flex items-center gap-2">
                  <TextInput
                    value={path}
                    onChange={setPath}
                    mono
                    ariaLabel="Folder"
                    testId="watch-path-input"
                    width="w-72"
                  />
                  <Button variant="ghost" onClick={() => void browse()}>
                    Browse
                  </Button>
                </div>
                <span className="text-[12px] text-ink-mute">The folder on your computer to watch.</span>
              </div>
              <div className="flex flex-col gap-1">
                <TextInput
                  label="Tags (optional)"
                  value={tags}
                  onChange={setTags}
                  placeholder="comma separated"
                  width="w-56"
                />
                <span className="text-[12px] text-ink-mute">Labels added to everything found here.</span>
              </div>
            </div>
            <div className="mt-3">
              <Button
                variant="primary"
                disabled={adding || name.trim() === '' || path.trim() === ''}
                onClick={() => void addFolder()}
                testId="watch-add"
              >
                {adding ? 'Adding…' : 'Add folder'}
              </Button>
            </div>
          </div>
        </section>

        <section>
          <SectionHeader meta="Schedules and rules running in the background">Automation</SectionHeader>
          {triggers.error !== null ? (
            <ErrorState error={triggers.error} onRetry={triggers.reload} />
          ) : triggers.data === null ? (
            <LoadingRows rows={2} />
          ) : !triggers.data.available ? (
            <div className="text-[13px] text-warn" data-testid="triggers-unavailable">
              Automation didn&apos;t start this time — check the startup log for [triggers] lines.
            </div>
          ) : (
            <AutomationBody data={triggers.data} />
          )}
        </section>
      </div>

      {resourcesTask !== null && (
        <TaskResourcesModal
          taskId={resourcesTask.id}
          kind={resourcesTask.kind}
          onClose={() => setResourcesTask(null)}
        />
      )}
      {cancelTask !== null && (
        <CancelConfirmModal
          task={cancelTask}
          busy={busyTaskId === cancelTask.id}
          onPause={() => {
            const id = cancelTask.id
            setCancelTask(null)
            void pauseJob(id)
          }}
          onConfirm={() => {
            const id = cancelTask.id
            setCancelTask(null)
            void cancelJob(id)
          }}
          onClose={() => setCancelTask(null)}
        />
      )}
    </>
  )
}
