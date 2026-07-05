/**
 * Review queue (phase 10) — the §13 safety surface. Three stacked sections
 * over the security spine: staged writes (approve → commit / reject with the
 * human diff shown first), queued agent approvals (allow / deny), and
 * injection-scanner flags (advisory; content already stored as inert data).
 * Destructive actions always show what will change (PRODUCT.md principle 3).
 */
import { useState } from 'react'
import type {
  ApprovalDto,
  InjectionFlagDto,
  JsonObject,
  JsonValue,
  StagedWriteDto,
  StagedWriteStatusDto
} from '../../../shared/ipc'
import { call, useIpc } from '../lib/ipc'
import { truncate, usd } from '../lib/format'
import {
  Badge,
  Button,
  Confidence,
  DataTable,
  ErrorState,
  KV,
  LoadingRows,
  Modal,
  PanelHeader,
  SectionHeader,
  Select,
  Timestamp,
  useToast
} from '../ui/kit'
import type { Column } from '../ui/kit'

// ── JsonValue narrowing (StagedWriteDto.payload is JsonObject) ───────────────

function asObject(value: JsonValue | undefined): JsonObject | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value : null
}

function asString(value: JsonValue | undefined): string | null {
  return typeof value === 'string' && value !== '' ? value : null
}

function asNumber(value: JsonValue | undefined): number | null {
  return typeof value === 'number' ? value : null
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/** Scope facts from an approval's details JSON: paths, host, usd. */
function scopeFacts(details: JsonObject): string {
  const parts: string[] = []
  const paths = details['paths']
  if (Array.isArray(paths)) {
    const strings = paths.filter((p): p is string => typeof p === 'string')
    if (strings.length > 0) parts.push(strings.join(' '))
  }
  const path = asString(details['path'])
  if (path !== null) parts.push(path)
  const host = asString(details['host'])
  if (host !== null) parts.push(`host ${host}`)
  const spend = asNumber(details['usd'])
  if (spend !== null) parts.push(usd(spend))
  return parts.length > 0 ? parts.join(' · ') : '-'
}

function diffLineClass(line: string): string {
  if (line.startsWith('+ ')) return 'text-ok'
  if (line.startsWith('~ ')) return 'text-warn'
  if (line.startsWith('- ')) return 'text-err'
  return 'text-ink'
}

// ── static columns (no closures needed) ───────────────────────────────────────

const STAGED_COLUMNS: readonly Column<StagedWriteDto>[] = [
  {
    key: 'id',
    header: 'id',
    className: 'font-mono whitespace-nowrap',
    render: (row) => <span title={row.id}>{row.id.slice(0, 10)}</span>
  },
  { key: 'kind', header: 'kind', render: (row) => row.kind },
  { key: 'proposedBy', header: 'proposed by', className: 'font-mono', render: (row) => row.proposedBy },
  {
    key: 'target',
    header: 'target',
    render: (row) =>
      row.targetLabel === null && row.targetId === null ? (
        '-'
      ) : (
        <span>
          {row.targetLabel ?? ''}{' '}
          <span className="font-mono text-ink-mute">{row.targetId ?? ''}</span>
        </span>
      )
  },
  { key: 'created', header: 'created', render: (row) => <Timestamp iso={row.createdAt} /> },
  { key: 'status', header: 'status', render: (row) => <Badge status={row.status} /> }
]

const FLAG_COLUMNS: readonly Column<InjectionFlagDto>[] = [
  {
    key: 'source',
    header: 'source',
    className: 'font-mono',
    render: (row) => <span title={row.source}>{truncate(row.source, 48)}</span>
  },
  { key: 'detector', header: 'detector', render: (row) => <Badge status="flagged" label={row.detector} /> },
  { key: 'pattern', header: 'pattern', className: 'font-mono', render: (row) => row.pattern },
  {
    key: 'excerpt',
    header: 'excerpt',
    render: (row) => <span title={row.excerpt}>{truncate(row.excerpt, 100)}</span>
  },
  { key: 'created', header: 'created', render: (row) => <Timestamp iso={row.createdAt} /> }
]

const STAGED_FILTER_OPTIONS = [
  { value: 'staged', label: 'staged' },
  { value: 'approved', label: 'approved' },
  { value: 'rejected', label: 'rejected' },
  { value: 'committed', label: 'committed' },
  { value: 'all', label: 'all' }
] as const

const APPROVAL_FILTER_OPTIONS = [
  { value: 'pending', label: 'pending' },
  { value: 'approved', label: 'approved' },
  { value: 'denied', label: 'denied' },
  { value: 'all', label: 'all' }
] as const

// ── staged write modal ────────────────────────────────────────────────────────

function StagedWriteModal({
  row,
  onClose,
  onChanged
}: {
  row: StagedWriteDto
  onClose: () => void
  onChanged: () => void
}): React.JSX.Element {
  const toast = useToast()
  const diff = useIpc('review.staged.diff', { id: row.id })
  const [busy, setBusy] = useState(false)

  const payload = row.payload
  const provenance = asObject(payload['provenance'])
  const extractedBy =
    (provenance !== null ? asString(provenance['extracted_by']) : null) ?? asString(payload['extracted_by'])
  const confidence =
    (provenance !== null ? asNumber(provenance['confidence']) : null) ?? asNumber(payload['confidence'])
  const evidence = asString(payload['evidence'])
  const session = asString(payload['session']) ?? asString(payload['sessionId'])
  const reason = asString(payload['reason'])
  const commitError = row.validation !== null ? asString(row.validation['commitError']) : null
  const hasProvenance = extractedBy !== null || confidence !== null || evidence !== null || session !== null

  async function approve(): Promise<void> {
    setBusy(true)
    try {
      await call('review.staged.approve', { id: row.id })
      toast.notify('ok', 'committed (undoable in audit log)')
      onClose()
      onChanged()
    } catch (err) {
      // Keep the modal open so the operator can retry or reject.
      toast.notify('err', errText(err))
    } finally {
      setBusy(false)
    }
  }

  async function reject(): Promise<void> {
    setBusy(true)
    try {
      await call('review.staged.reject', { id: row.id })
      toast.notify('ok', 'rejected')
      onClose()
      onChanged()
    } catch (err) {
      toast.notify('err', errText(err))
    } finally {
      setBusy(false)
    }
  }

  const footer =
    row.status === 'staged' ? (
      <>
        <Button variant="danger" testId="staged-reject" disabled={busy} onClick={() => void reject()}>
          reject
        </Button>
        <Button variant="primary" testId="staged-approve" disabled={busy} onClick={() => void approve()}>
          approve
        </Button>
      </>
    ) : row.status === 'approved' ? (
      <Button variant="primary" testId="staged-approve" disabled={busy} onClick={() => void approve()}>
        retry commit
      </Button>
    ) : undefined

  return (
    <Modal title="staged write" onClose={onClose} wide footer={footer}>
      {hasProvenance && (
        <div className="mb-3">
          <KV
            entries={[
              ...(extractedBy !== null
                ? [{ k: 'extracted by', v: <span className="font-mono">{extractedBy}</span> }]
                : []),
              ...(confidence !== null ? [{ k: 'confidence', v: <Confidence value={confidence} /> }] : []),
              ...(session !== null ? [{ k: 'session', v: <span className="font-mono">{session}</span> }] : [])
            ]}
          />
          {evidence !== null && (
            <blockquote className="mt-2 rounded-md bg-raised px-3 py-2 text-[12px] leading-5 text-ink-mute">
              {evidence}
            </blockquote>
          )}
        </div>
      )}
      {!hasProvenance && reason !== null && (
        <div className="mb-3 text-[12px] text-ink-mute">
          reason: <span className="text-ink">{reason}</span>
        </div>
      )}
      {diff.error !== null ? (
        <ErrorState error={diff.error} onRetry={diff.reload} />
      ) : diff.data === null ? (
        <div className="py-2 text-[12px] text-ink-mute">loading diff…</div>
      ) : (
        <pre
          data-testid="staged-diff"
          className="rounded-md border border-line bg-bg px-3 py-2 font-mono text-[12px] leading-5 whitespace-pre-wrap"
        >
          {diff.data.split('\n').map((line, i) => (
            <span key={i} className={diffLineClass(line)}>
              {line}
              {'\n'}
            </span>
          ))}
        </pre>
      )}
      {row.status === 'approved' && commitError !== null && (
        <div className="mt-3 rounded-md border border-err/40 bg-err/10 px-3 py-2" role="alert">
          <div className="font-mono text-[11px] text-err">commit failed</div>
          <div className="mt-1 text-[12px]">{commitError}</div>
        </div>
      )}
    </Modal>
  )
}

// ── panel ─────────────────────────────────────────────────────────────────────

export default function ReviewPanel(): React.JSX.Element {
  const toast = useToast()
  const [stagedFilter, setStagedFilter] = useState<StagedWriteStatusDto | 'all'>('staged')
  const [approvalFilter, setApprovalFilter] = useState<'pending' | 'approved' | 'denied' | 'all'>('pending')
  const [selected, setSelected] = useState<StagedWriteDto | null>(null)
  const [deciding, setDeciding] = useState<string | null>(null)

  const staged = useIpc('review.staged.list', stagedFilter === 'all' ? {} : { status: stagedFilter })
  const approvals = useIpc('review.approvals.list', approvalFilter === 'all' ? {} : { status: approvalFilter })
  const flags = useIpc('review.flags.list', undefined)

  const stagedRows = staged.data ?? []
  const approvalRows = approvals.data ?? []
  const flagRows = flags.data ?? []

  async function decide(row: ApprovalDto, decision: 'approved' | 'denied'): Promise<void> {
    setDeciding(row.id)
    try {
      await call('review.approvals.decide', { id: row.id, decision })
      toast.notify('ok', decision)
      approvals.reload()
    } catch (err) {
      toast.notify('err', errText(err))
    } finally {
      setDeciding(null)
    }
  }

  const approvalColumns: readonly Column<ApprovalDto>[] = [
    { key: 'agent', header: 'agent', className: 'font-mono', render: (row) => row.agentId },
    {
      key: 'action',
      header: 'action',
      render: (row) => (
        <span>
          {row.actionKind} <span className="font-mono">{row.actionName}</span>
        </span>
      )
    },
    { key: 'tier', header: 'tier', className: 'font-mono', render: (row) => row.tier },
    {
      key: 'scope',
      header: 'scope',
      className: 'font-mono',
      render: (row) => {
        const facts = scopeFacts(row.details)
        return <span title={facts}>{truncate(facts, 80)}</span>
      }
    },
    { key: 'requested', header: 'requested', render: (row) => <Timestamp iso={row.requestedAt} /> },
    { key: 'status', header: 'status', render: (row) => <Badge status={row.status} /> },
    {
      key: 'actions',
      header: '',
      render: (row) =>
        row.status === 'pending' ? (
          <div className="flex justify-end gap-1.5" onClick={(e) => e.stopPropagation()}>
            <Button
              variant="danger"
              testId={`approval-deny-${row.id}`}
              disabled={deciding === row.id}
              onClick={() => void decide(row, 'denied')}
            >
              deny
            </Button>
            <Button
              variant="primary"
              testId={`approval-approve-${row.id}`}
              disabled={deciding === row.id}
              onClick={() => void decide(row, 'approved')}
            >
              approve
            </Button>
          </div>
        ) : null
    }
  ]

  return (
    <>
      <PanelHeader
        title="review queue"
        meta={
          <span className="font-mono">
            {stagedRows.length} writes · {approvalRows.length} approvals · {flagRows.length} flags
          </span>
        }
      />
      <div className="min-h-0 flex-1 overflow-y-auto px-5 py-3">
        <section className="mb-6">
          <div className="flex items-center justify-between gap-3">
            <SectionHeader meta={<span className="font-mono">{stagedRows.length}</span>}>
              staged writes
            </SectionHeader>
            <Select
              value={stagedFilter}
              onChange={(value) => setStagedFilter(value as StagedWriteStatusDto | 'all')}
              options={STAGED_FILTER_OPTIONS}
              ariaLabel="staged writes status filter"
              testId="staged-status-filter"
            />
          </div>
          {staged.error !== null ? (
            <ErrorState error={staged.error} onRetry={staged.reload} />
          ) : staged.data === null ? (
            <LoadingRows />
          ) : (
            <DataTable
              testId="staged-table"
              columns={STAGED_COLUMNS}
              rows={stagedRows}
              rowKey={(row) => row.id}
              onRowClick={(row) => setSelected(row)}
              selectedKey={selected?.id ?? null}
              empty={
                stagedFilter === 'staged'
                  ? 'no staged writes - low-confidence extractions and corrections queue here for review'
                  : `no ${stagedFilter === 'all' ? '' : `${stagedFilter} `}staged writes`
              }
            />
          )}
        </section>

        <section className="mb-6">
          <div className="flex items-center justify-between gap-3">
            <SectionHeader meta={<span className="font-mono">{approvalRows.length}</span>}>
              pending approvals
            </SectionHeader>
            <Select
              value={approvalFilter}
              onChange={(value) => setApprovalFilter(value as 'pending' | 'approved' | 'denied' | 'all')}
              options={APPROVAL_FILTER_OPTIONS}
              ariaLabel="approvals status filter"
              testId="approval-status-filter"
            />
          </div>
          {approvals.error !== null ? (
            <ErrorState error={approvals.error} onRetry={approvals.reload} />
          ) : approvals.data === null ? (
            <LoadingRows />
          ) : (
            <DataTable
              testId="approvals-table"
              columns={approvalColumns}
              rows={approvalRows}
              rowKey={(row) => row.id}
              empty="no pending approvals - agent actions that need consent will queue here"
            />
          )}
        </section>

        <section className="mb-6">
          <SectionHeader meta={<span className="font-mono">{flagRows.length}</span>}>
            flagged documents
          </SectionHeader>
          {flags.error !== null ? (
            <ErrorState error={flags.error} onRetry={flags.reload} />
          ) : flags.data === null ? (
            <LoadingRows />
          ) : (
            <DataTable
              testId="flags-table"
              columns={FLAG_COLUMNS}
              rows={flagRows}
              rowKey={(row) => row.id}
              empty="no injection flags - ingested documents that look like instructions land here"
            />
          )}
        </section>
      </div>

      {selected !== null && (
        <StagedWriteModal
          row={selected}
          onClose={() => setSelected(null)}
          onChanged={() => staged.reload()}
        />
      )}
    </>
  )
}
