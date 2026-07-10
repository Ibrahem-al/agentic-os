/**
 * History (phase 10 audit log, plain-language redesign §P3) — the §13 audit/undo
 * timeline retold for less technical users: a 14-day activity chart, entries
 * grouped by day, each row a plain sentence with its kind and outcome. Every
 * kernel action, graph write, and file write lands here with its recorded
 * inverse delta; reversible rows get a working undo (confirm modal, then
 * audit.undo — the undo itself is audited and cannot be re-done). Technical
 * identifiers (agent, id, raw kind, JSON) move behind a per-row "Details"
 * expander so a row leads with what happened.
 */
import { useState } from 'react'
import type { AuditActionDto, AuditKindDto } from '../../../shared/ipc'
import { call, useIpc } from '../lib/ipc'
import { dayKey, lastNDays, plainStatus, plural } from '../lib/plain'
import {
  Badge,
  Button,
  Disclosure,
  EmptyState,
  ErrorState,
  KV,
  LoadingRows,
  Modal,
  PanelHeader,
  Select,
  TextInput,
  Timestamp,
  useToast
} from '../ui/kit'
import { Icon } from '../ui/icons'
import { BarChart } from '../ui/viz'

// Filter options carry plain labels; the `value` stays the RAW kind because it
// is forwarded to the audit.list IPC call.
const KIND_OPTIONS = [
  { value: 'all', label: 'All kinds' },
  { value: 'action', label: 'Agent actions' },
  { value: 'graph-write', label: 'Memory writes' },
  { value: 'file-write', label: 'File changes' },
  { value: 'file-delete', label: 'Files removed' },
  { value: 'undo', label: 'Undos' }
] as const

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/** Undone rows dim to ink-mute (strikethrough-free dimming). */
function dim(row: AuditActionDto): string {
  return row.undoneAt !== null ? 'text-ink-mute' : ''
}

/** "Today" / "Yesterday" / a friendly date for a local day key. */
function dayLabel(key: string, todayKey: string, yesterdayKey: string): string {
  if (key === todayKey) return 'Today'
  if (key === yesterdayKey) return 'Yesterday'
  const [y, m, d] = key.split('-').map(Number)
  if (y === undefined || m === undefined || d === undefined || Number.isNaN(y)) return key
  return new Date(y, m - 1, d).toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric'
  })
}

interface DayGroup {
  readonly key: string
  readonly label: string
  readonly rows: readonly AuditActionDto[]
}

/** Bucket rows into day groups, newest day first and newest row first within. */
function groupByDay(rows: readonly AuditActionDto[], todayKey: string, yesterdayKey: string): readonly DayGroup[] {
  const sorted = [...rows].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
  const buckets = new Map<string, AuditActionDto[]>()
  for (const row of sorted) {
    const key = dayKey(row.createdAt)
    const bucket = buckets.get(key)
    if (bucket !== undefined) bucket.push(row)
    else buckets.set(key, [row])
  }
  return [...buckets.keys()]
    .sort((a, b) => b.localeCompare(a))
    .map((key) => ({ key, label: dayLabel(key, todayKey, yesterdayKey), rows: buckets.get(key) ?? [] }))
}

/** One history entry: a plain sentence, its kind + outcome, and undo state. */
function AuditRow({
  row,
  onUndo
}: {
  row: AuditActionDto
  onUndo: (row: AuditActionDto) => void
}): React.JSX.Element {
  const kind = plainStatus(row.kind)
  const outcome = plainStatus(row.outcome)
  const details = row.details as Record<string, unknown>
  const hasJson = Object.keys(details).length > 0
  return (
    <li className="flex items-start justify-between gap-3 py-2.5">
      <div className="flex min-w-0 flex-1 flex-col gap-1.5">
        <div className={`text-[13px] break-words ${dim(row)}`}>{row.description}</div>
        <div className="flex flex-wrap items-center gap-2">
          <Badge status={row.kind} label={kind.label} title={kind.explain} />
          <Badge status={row.outcome} label={outcome.label} title={outcome.explain} />
          <Timestamp iso={row.createdAt} />
        </div>
        {row.error !== null && <div className="font-mono text-[11px] text-err">{row.error}</div>}
        <Disclosure summary="Details" testId={`audit-details-${row.id}`}>
          <KV
            entries={[
              { k: 'agent', v: <span className="font-mono">{row.agentId}</span> },
              { k: 'id', v: <span className="font-mono">{row.id}</span> },
              { k: 'kind', v: <span className="font-mono">{row.kind}</span> },
              { k: 'undoable', v: row.reversible ? 'yes' : 'no' }
            ]}
          />
          {hasJson && (
            <pre className="mt-2 overflow-x-auto font-mono text-[11px] leading-5 text-ink-mute">
              {JSON.stringify(row.details, null, 2)}
            </pre>
          )}
        </Disclosure>
      </div>
      <div className="shrink-0 pt-0.5">
        {row.reversible && row.undoneAt === null ? (
          <Button testId={`audit-undo-${row.id}`} onClick={() => onUndo(row)}>
            undo
          </Button>
        ) : row.undoneAt !== null ? (
          <Badge status="undone" label="undone" />
        ) : (
          <span className="text-[11px] text-ink-mute">Cannot be undone</span>
        )}
      </div>
    </li>
  )
}

export default function AuditPanel(): React.JSX.Element {
  const toast = useToast()
  const [kindFilter, setKindFilter] = useState<AuditKindDto | 'all'>('all')
  const [agentFilter, setAgentFilter] = useState('')
  const [undoTarget, setUndoTarget] = useState<AuditActionDto | null>(null)
  const [busy, setBusy] = useState(false)

  const query = useIpc('audit.list', kindFilter === 'all' ? {} : { kind: kindFilter })

  const needle = agentFilter.trim().toLowerCase()
  const rows = (query.data ?? []).filter(
    (row) => needle === '' || row.agentId.toLowerCase().includes(needle)
  )

  async function confirmUndo(): Promise<void> {
    if (undoTarget === null) return
    setBusy(true)
    try {
      await call('audit.undo', { id: undoTarget.id })
      toast.notify('ok', 'undone')
      setUndoTarget(null)
      query.reload()
    } catch (err) {
      // Backend message verbatim (NOT_FOUND / IRREVERSIBLE / ALREADY_UNDONE /
      // UNDO_FAILED are written for operators); reload to show current state.
      toast.notify('err', errText(err))
      setUndoTarget(null)
      query.reload()
    } finally {
      setBusy(false)
    }
  }

  // 14-day activity bars from the visible rows; a day with any failure tints err.
  const chartDays = lastNDays(14)
  const countByDay = new Map<string, number>(chartDays.map((d) => [d, 0]))
  const failByDay = new Map<string, boolean>(chartDays.map((d) => [d, false]))
  for (const row of rows) {
    const key = dayKey(row.createdAt)
    if (countByDay.has(key)) {
      countByDay.set(key, (countByDay.get(key) ?? 0) + 1)
      if (row.outcome === 'error') failByDay.set(key, true)
    }
  }
  const bars = chartDays.map((d) => ({
    label: d.slice(5),
    value: countByDay.get(d) ?? 0,
    tint: (failByDay.get(d) === true ? 'err' : 'accent') as 'err' | 'accent'
  }))
  const chartTotal = bars.reduce((sum, b) => sum + b.value, 0)
  const failDays = bars.filter((b) => b.tint === 'err').length

  const [yesterdayKey, todayKey] = lastNDays(2)
  const groups = groupByDay(rows, todayKey ?? '', yesterdayKey ?? '')

  return (
    <>
      <PanelHeader
        title="History"
        subtitle="Everything that happened — most of it can be undone."
        icon={<Icon name="history" size={18} />}
        meta={<span className="font-mono">{plural(rows.length, 'action')}</span>}
        actions={
          <>
            <Select
              value={kindFilter}
              onChange={(value) => setKindFilter(value as AuditKindDto | 'all')}
              options={KIND_OPTIONS}
              ariaLabel="filter history by kind"
              testId="audit-kind-filter"
            />
            <TextInput
              value={agentFilter}
              onChange={setAgentFilter}
              placeholder="filter by agent"
              mono
              width="w-44"
              ariaLabel="filter by agent"
              testId="audit-agent-filter"
            />
          </>
        }
      />
      <div className="min-h-0 flex-1 overflow-y-auto px-5 py-3">
        {query.error !== null ? (
          <ErrorState error={query.error} onRetry={query.reload} />
        ) : query.data === null ? (
          <LoadingRows />
        ) : rows.length === 0 ? (
          <EmptyState icon={<Icon name="history" size={24} />}>
            {needle !== '' || kindFilter !== 'all'
              ? 'Nothing matches the current filters.'
              : 'Nothing has happened yet — agent actions, memory writes, and file changes show up here.'}
          </EmptyState>
        ) : (
          <>
            <section className="mb-5">
              <div className="mb-2 text-[12px] text-ink-mute">Activity over the last 14 days</div>
              <BarChart
                bars={bars}
                height={48}
                ariaLabel={`${plural(chartTotal, 'action')} in the last 14 days${
                  failDays > 0 ? `, with ${plural(failDays, 'day')} that had a failure` : ''
                }.`}
                formatValue={(v) => plural(v, 'action')}
              />
            </section>

            <div data-testid="audit-table" className="flex flex-col gap-4">
              {groups.map((group) => (
                <section key={group.key}>
                  <h2 className="mb-1 text-[12px] font-medium text-ink-mute">{group.label}</h2>
                  <ul className="flex flex-col divide-y divide-line">
                    {group.rows.map((row) => (
                      <AuditRow key={row.id} row={row} onUndo={setUndoTarget} />
                    ))}
                  </ul>
                </section>
              ))}
            </div>
          </>
        )}
      </div>

      {undoTarget !== null && (
        <Modal
          title="Undo this action?"
          onClose={() => setUndoTarget(null)}
          footer={
            <>
              <Button disabled={busy} onClick={() => setUndoTarget(null)}>
                cancel
              </Button>
              <Button
                variant="danger"
                testId="audit-undo-confirm"
                disabled={busy}
                onClick={() => void confirmUndo()}
              >
                undo
              </Button>
            </>
          }
        >
          <div className="text-[13px]">{undoTarget.description}</div>
          <p className="mt-2 text-[12px] leading-5 text-ink-mute">
            This reverses the change and records the undo in your history. An undo cannot itself be
            undone.
          </p>
        </Modal>
      )}
    </>
  )
}
