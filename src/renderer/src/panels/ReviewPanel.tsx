/**
 * Review queue (phase 10) — the §13 safety surface. Three stacked sections
 * over the security spine: staged writes (approve → commit / reject with the
 * human diff shown first), queued agent approvals (allow / deny), and
 * injection-scanner flags (advisory; content already stored as inert data).
 * Destructive actions always show what will change (PRODUCT.md principle 3).
 *
 * Phase 20 (P1.7) adds batch review UX: staged writes group by source session
 * with a per-group "approve all", and the approve path preflights Ollama —
 * new-Preference extraction creates embed at commit (embedOnCommit), so with
 * Ollama down the approve is disabled with a plain-language reason rather than
 * failing at commit (§9.2: warn, not error).
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
  EmptyState,
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

/**
 * Whether committing this staged write needs a live Ollama at click time
 * (§9.2/P1.7). Mirrors the backend predicate: an extraction that CREATES a new
 * retrievable node with embedOnCommit gets its embedding computed at approval —
 * the statement is in the payload, the vector is not staged. Computed from the
 * DTO payload the backend already ships (kind + op + embedOnCommit) so the
 * preflight needs no extra round-trip.
 */
function requiresEmbedder(row: StagedWriteDto): boolean {
  if (row.kind !== 'extraction') return false
  return asString(row.payload['op']) === 'create' && row.payload['embedOnCommit'] === true
}

/** The source session a staged write came from (extraction payloads stamp it). */
function sourceSessionOf(row: StagedWriteDto): string | null {
  return asString(row.payload['session']) ?? asString(row.payload['sessionId'])
}

/** One-line human handle for a staged write in the batch-confirm list. */
function summaryOf(row: StagedWriteDto): string {
  const node = asObject(row.payload['node'])
  const props = node !== null ? asObject(node['props']) : null
  const statement = props !== null ? asString(props['statement']) : null
  const patch = asObject(row.payload['patch'])
  const patchStatement = patch !== null ? asString(patch['statement']) : null
  return (
    statement ??
    patchStatement ??
    asString(row.payload['evidence']) ??
    asString(row.payload['reason']) ??
    row.targetId ??
    row.id
  )
}

function diffLineClass(line: string): string {
  if (line.startsWith('+ ')) return 'text-ok'
  if (line.startsWith('~ ')) return 'text-warn'
  if (line.startsWith('- ')) return 'text-err'
  return 'text-ink'
}

// ── grouping by source session (P1.7 batch review) ───────────────────────────

interface StagedGroup {
  /** Stable group key: the session id, or `by:<proposer>` when session-less. */
  readonly key: string
  readonly sessionId: string | null
  readonly proposedBy: string
  readonly rows: StagedWriteDto[]
}

/** Group staged rows by source session (session-less rows fall back to proposer),
 * preserving the incoming created_at order both across and within groups. */
function groupBySession(rows: readonly StagedWriteDto[]): StagedGroup[] {
  const groups = new Map<string, StagedGroup>()
  for (const row of rows) {
    const sessionId = sourceSessionOf(row)
    const key = sessionId ?? `by:${row.proposedBy}`
    let group = groups.get(key)
    if (group === undefined) {
      group = { key, sessionId, proposedBy: row.proposedBy, rows: [] }
      groups.set(key, group)
    }
    group.rows.push(row)
  }
  return [...groups.values()]
}

/** A DOM-safe slug for group-scoped test ids. */
function slug(key: string): string {
  return key.replace(/[^a-z0-9]+/gi, '-').replace(/^-+|-+$/g, '')
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

/** Compact columns for the batch-approve confirm list (what will commit). */
const APPROVE_ALL_COLUMNS: readonly Column<StagedWriteDto>[] = [
  { key: 'kind', header: 'kind', render: (row) => row.kind },
  {
    key: 'target',
    header: 'target',
    render: (row) => (
      <span>
        {row.targetLabel ?? ''} <span className="font-mono text-ink-mute">{row.targetId ?? ''}</span>
      </span>
    )
  },
  {
    key: 'summary',
    header: 'summary',
    render: (row) => <span title={summaryOf(row)}>{truncate(summaryOf(row), 64)}</span>
  }
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

const OLLAMA_REQUIRED_MSG = 'Ollama required to commit this item'

// ── staged write modal ────────────────────────────────────────────────────────

function StagedWriteModal({
  row,
  ollamaReady,
  onClose,
  onChanged
}: {
  row: StagedWriteDto
  /** null while the Ollama status is still loading (fail-open: never block). */
  ollamaReady: boolean | null
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

  // Ollama preflight (P1.7): a new-Preference extraction embeds at commit, so a
  // known-down Ollama blocks the commit up front. Unknown status fails open.
  const blocked = requiresEmbedder(row) && ollamaReady === false

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
        <Button
          variant="primary"
          testId="staged-approve"
          disabled={busy || blocked}
          {...(blocked ? { title: OLLAMA_REQUIRED_MSG } : {})}
          onClick={() => void approve()}
        >
          approve
        </Button>
      </>
    ) : row.status === 'approved' ? (
      <Button
        variant="primary"
        testId="staged-approve"
        disabled={busy || blocked}
        {...(blocked ? { title: OLLAMA_REQUIRED_MSG } : {})}
        onClick={() => void approve()}
      >
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
      {blocked && (
        <div
          role="note"
          data-testid="staged-approve-blocked"
          className="mt-3 rounded-md border border-warn/40 bg-warn/10 px-3 py-2 text-[12px]"
        >
          {OLLAMA_REQUIRED_MSG} — this new preference is embedded at commit and Ollama is not ready. Start Ollama, then
          approve.
        </div>
      )}
    </Modal>
  )
}

// ── batch approve-all confirm (P1.7) ──────────────────────────────────────────

function ApproveAllModal({
  group,
  ollamaReady,
  onClose,
  onDone
}: {
  group: StagedGroup
  ollamaReady: boolean | null
  onClose: () => void
  onDone: () => void
}): React.JSX.Element {
  const toast = useToast()
  const [busy, setBusy] = useState(false)

  const approvable = group.rows.filter((r) => r.status === 'staged')
  const blocked = approvable.filter((r) => requiresEmbedder(r) && ollamaReady === false)
  const eligible = approvable.filter((r) => !(requiresEmbedder(r) && ollamaReady === false))

  async function approveAll(): Promise<void> {
    setBusy(true)
    let approved = 0
    const failures: string[] = []
    // Sequential: the write lane is single, and a clear per-item failure beats a
    // stampede. Each approve is an audited, undoable commit.
    for (const row of eligible) {
      try {
        await call('review.staged.approve', { id: row.id })
        approved += 1
      } catch (err) {
        failures.push(errText(err))
      }
    }
    setBusy(false)
    const skipped = blocked.length > 0 ? `, ${blocked.length} need Ollama` : ''
    if (failures.length === 0) toast.notify('ok', `approved ${approved}${skipped} (undoable in audit log)`)
    else toast.notify('err', `approved ${approved}, ${failures.length} failed: ${failures[0]}`)
    onClose()
    onDone()
  }

  const footer = (
    <>
      <Button disabled={busy} onClick={onClose}>
        cancel
      </Button>
      <Button
        variant="primary"
        testId="staged-approve-all-confirm"
        disabled={busy || eligible.length === 0}
        onClick={() => void approveAll()}
      >
        approve {eligible.length}
      </Button>
    </>
  )

  return (
    <Modal title="approve all in group" onClose={onClose} wide footer={footer}>
      <div className="mb-2 text-[12px] text-ink-mute">
        {group.sessionId !== null ? (
          <>
            session <span className="font-mono text-ink">{group.sessionId}</span>
          </>
        ) : (
          <>
            proposed by <span className="font-mono text-ink">{group.proposedBy}</span>
          </>
        )}
        . each row below becomes an undoable committed write. open any row first to see its full diff.
      </div>
      <DataTable
        testId="staged-approve-all-list"
        columns={APPROVE_ALL_COLUMNS}
        rows={eligible}
        rowKey={(row) => row.id}
        empty="nothing eligible to approve"
      />
      {blocked.length > 0 && (
        <div
          role="note"
          data-testid="staged-approve-all-blocked"
          className="mt-2 rounded-md border border-warn/40 bg-warn/10 px-3 py-2 text-[12px]"
        >
          {blocked.length} item{blocked.length === 1 ? '' : 's'} embed a new preference at commit and need a live
          Ollama — skipped until it is ready.
        </div>
      )}
    </Modal>
  )
}

// ── one session group in the staged section ───────────────────────────────────

function StagedGroupBlock({
  group,
  ollamaReady,
  selectedId,
  onSelect,
  onApproveAll
}: {
  group: StagedGroup
  ollamaReady: boolean | null
  selectedId: string | null
  onSelect: (row: StagedWriteDto) => void
  onApproveAll: (group: StagedGroup) => void
}): React.JSX.Element {
  const approvable = group.rows.filter((r) => r.status === 'staged')
  const eligible = approvable.filter((r) => !(requiresEmbedder(r) && ollamaReady === false))
  const allBlocked = approvable.length > 0 && eligible.length === 0

  return (
    <div className="mb-4 rounded-md border border-line" data-testid={`staged-group-${slug(group.key)}`}>
      <div className="flex items-center justify-between gap-3 border-b border-line bg-surface px-3 py-2">
        <div className="flex min-w-0 items-center gap-2">
          <span className="text-[11px] text-ink-faint">{group.sessionId !== null ? 'session' : 'proposed by'}</span>
          <span className="truncate font-mono text-[12px] text-ink" title={group.sessionId ?? group.proposedBy}>
            {truncate(group.sessionId ?? group.proposedBy, 44)}
          </span>
          <span className="font-mono text-[11px] text-ink-faint">{group.rows.length}</span>
        </div>
        {approvable.length > 0 && (
          <Button
            variant="primary"
            testId={`staged-approve-all-${slug(group.key)}`}
            disabled={allBlocked}
            {...(allBlocked ? { title: OLLAMA_REQUIRED_MSG } : {})}
            onClick={() => onApproveAll(group)}
          >
            approve all ({approvable.length})
          </Button>
        )}
      </div>
      <DataTable
        columns={STAGED_COLUMNS}
        rows={group.rows}
        rowKey={(row) => row.id}
        onRowClick={onSelect}
        selectedKey={selectedId}
        empty=""
      />
    </div>
  )
}

// ── panel ─────────────────────────────────────────────────────────────────────

export default function ReviewPanel(): React.JSX.Element {
  const toast = useToast()
  const [stagedFilter, setStagedFilter] = useState<StagedWriteStatusDto | 'all'>('staged')
  const [approvalFilter, setApprovalFilter] = useState<'pending' | 'approved' | 'denied' | 'all'>('pending')
  const [selected, setSelected] = useState<StagedWriteDto | null>(null)
  const [approveAllGroup, setApproveAllGroup] = useState<StagedGroup | null>(null)
  const [deciding, setDeciding] = useState<string | null>(null)

  const staged = useIpc('review.staged.list', stagedFilter === 'all' ? {} : { status: stagedFilter })
  const approvals = useIpc('review.approvals.list', approvalFilter === 'all' ? {} : { status: approvalFilter })
  const flags = useIpc('review.flags.list', undefined)
  // The Ollama status the settings panel already surfaces (§9.2 approve preflight).
  const ollama = useIpc('settings.ollamaStatus', undefined)

  const stagedRows = staged.data ?? []
  const approvalRows = approvals.data ?? []
  const flagRows = flags.data ?? []
  const groups = groupBySession(stagedRows)
  // null while loading → preflight fails open (never a false block).
  const ollamaReady = ollama.data === null ? null : ollama.data.state === 'ready'

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
          {ollamaReady === false && (
            <div className="mb-2 text-[11px] text-ink-faint">
              ollama is {ollama.data?.state ?? 'unavailable'} — approving a new-preference extraction is disabled until
              it is ready (its embedding is computed at commit).
            </div>
          )}
          {staged.error !== null ? (
            <ErrorState error={staged.error} onRetry={staged.reload} />
          ) : staged.data === null ? (
            <LoadingRows />
          ) : stagedRows.length === 0 ? (
            <EmptyState>
              {stagedFilter === 'staged'
                ? 'no staged writes - low-confidence extractions and corrections queue here for review'
                : `no ${stagedFilter === 'all' ? '' : `${stagedFilter} `}staged writes`}
            </EmptyState>
          ) : (
            // Wrapper keeps the golden-path `[data-testid="staged-table"] [data-rowkey]`
            // selector working across the per-session group tables nested inside.
            <div data-testid="staged-table">
              {groups.map((group) => (
                <StagedGroupBlock
                  key={group.key}
                  group={group}
                  ollamaReady={ollamaReady}
                  selectedId={selected?.id ?? null}
                  onSelect={setSelected}
                  onApproveAll={setApproveAllGroup}
                />
              ))}
            </div>
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
          ollamaReady={ollamaReady}
          onClose={() => setSelected(null)}
          onChanged={() => staged.reload()}
        />
      )}

      {approveAllGroup !== null && (
        <ApproveAllModal
          group={approveAllGroup}
          ollamaReady={ollamaReady}
          onClose={() => setApproveAllGroup(null)}
          onDone={() => staged.reload()}
        />
      )}
    </>
  )
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
