/**
 * Audit log (phase 10) — the §13 audit/undo timeline. Every kernel action,
 * graph write, and file write lands here with its recorded inverse delta;
 * reversible rows get a working undo (confirm modal, then audit.undo — the
 * undo itself is audited and cannot be re-done).
 */
import { useState } from 'react'
import type { AuditActionDto, AuditKindDto } from '../../../shared/ipc'
import { call, useIpc } from '../lib/ipc'
import {
  Badge,
  Button,
  DataTable,
  ErrorState,
  LoadingRows,
  Modal,
  PanelHeader,
  Select,
  TextInput,
  Timestamp,
  useToast
} from '../ui/kit'
import type { Column } from '../ui/kit'

const KIND_OPTIONS = [
  { value: 'all', label: 'all kinds' },
  { value: 'action', label: 'action' },
  { value: 'graph-write', label: 'graph-write' },
  { value: 'file-write', label: 'file-write' },
  { value: 'file-delete', label: 'file-delete' },
  { value: 'undo', label: 'undo' }
] as const

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/** Undone rows dim to ink-mute (DESIGN.md: strikethrough-free dimming). */
function dim(row: AuditActionDto): string {
  return row.undoneAt !== null ? 'text-ink-mute' : ''
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

  const columns: readonly Column<AuditActionDto>[] = [
    {
      key: 'square',
      header: '',
      className: 'w-6',
      render: (row) => (
        <span
          aria-hidden="true"
          className={`mt-1 inline-block size-2 rounded-[2px] ${
            row.undoneAt !== null ? 'bg-undo' : row.outcome === 'ok' ? 'bg-ok' : 'bg-err'
          }`}
        />
      )
    },
    { key: 'when', header: 'when', render: (row) => <Timestamp iso={row.createdAt} /> },
    {
      key: 'agent',
      header: 'agent',
      render: (row) => <span className={`font-mono ${dim(row)}`}>{row.agentId}</span>
    },
    {
      key: 'kind',
      header: 'kind',
      render: (row) => (
        <span className="inline-flex items-center gap-1 whitespace-nowrap">
          <Badge status={row.kind} label={row.kind} />
          <Badge status={row.outcome} />
        </span>
      )
    },
    {
      key: 'description',
      header: 'description',
      className: 'w-full',
      render: (row) => (
        <div className={dim(row)}>
          <div className="break-words">{row.description}</div>
          {row.error !== null && <div className="mt-0.5 font-mono text-[11px] text-err">{row.error}</div>}
        </div>
      )
    },
    {
      key: 'delta',
      header: 'delta',
      render: (row) => (
        <span className="font-mono text-[11px] text-ink-faint whitespace-nowrap">
          {row.reversible ? 'reversible' : 'irreversible'}
        </span>
      )
    },
    {
      key: 'actions',
      header: '',
      render: (row) =>
        row.reversible && row.undoneAt === null ? (
          <div onClick={(e) => e.stopPropagation()}>
            <Button testId={`audit-undo-${row.id}`} onClick={() => setUndoTarget(row)}>
              undo
            </Button>
          </div>
        ) : row.undoneAt !== null ? (
          <Badge status="undone" label="undone" />
        ) : null
    }
  ]

  return (
    <>
      <PanelHeader
        title="audit log"
        meta={<span className="font-mono">{rows.length} actions</span>}
        actions={
          <>
            <Select
              value={kindFilter}
              onChange={(value) => setKindFilter(value as AuditKindDto | 'all')}
              options={KIND_OPTIONS}
              ariaLabel="audit kind filter"
              testId="audit-kind-filter"
            />
            <TextInput
              value={agentFilter}
              onChange={setAgentFilter}
              placeholder="filter agent"
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
        ) : (
          <DataTable
            testId="audit-table"
            columns={columns}
            rows={rows}
            rowKey={(row) => row.id}
            empty={
              needle !== '' || kindFilter !== 'all'
                ? 'no audit entries match the current filters'
                : 'no audit entries yet - agent actions, graph writes, and file writes land here'
            }
          />
        )}
      </div>

      {undoTarget !== null && (
        <Modal
          title="undo action"
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
            applies the recorded inverse delta through the write lane. the undo itself is audited and
            cannot be re-done.
          </p>
        </Modal>
      )}
    </>
  )
}
