/**
 * Approvals (phase 10, plain-language redesign §P2) — the §13 safety surface,
 * re-presented for less technical people. Three plain sections over the same
 * security spine: memory changes an agent proposed (approve → commit / decline,
 * with the human diff shown first), permission requests an agent is waiting on
 * (allow / decline), and safety flags (advisory; the content is already stored
 * as inert data). Destructive actions always show what will change first
 * (PRODUCT.md principle 3).
 *
 * The register shifted (approachability over density) but the honesty did not:
 * rows lead with a plain sentence, the RAW status words stay visible on memory-
 * change rows (constraint 5), and every technical identifier moves behind a
 * "Details" disclosure — visible on demand, never the first thing a row says.
 *
 * Phase 20 (P1.7) batch review is preserved: staged writes group by source
 * session with a per-group "approve all", and the approve path preflights Ollama
 * — a new-preference extraction embeds at commit (embedOnCommit), so with the
 * local AI helper down the approve is disabled with a plain reason rather than
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
import type { InspectTarget, PanelProps } from '../App'
import { call, useIpc } from '../lib/ipc'
import { truncate, usd } from '../lib/format'
import { dayKey, lastNDays, plainStatus, plural } from '../lib/plain'
import { plainProposerTitle, summarizeStagedWrite } from '../lib/stagedSummary'
import type { SourceRef } from '../lib/stagedSummary'
import {
  Badge,
  Button,
  Confidence,
  DataTable,
  Disclosure,
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
import { Icon } from '../ui/icons'
import { BarChart } from '../ui/viz'

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
 * (§9.2/P1.7). The backend already computes this on the DTO
 * (`stagedWriteRequiresEmbedder`) and it generalizes across kinds: an extraction
 * CREATE that embeds on commit, AND a `skill-import` create (a fresh Skill whose
 * embedding is computed at commit). We trust the DTO flag rather than re-deriving
 * a kind-specific heuristic here.
 */
function requiresEmbedder(row: StagedWriteDto): boolean {
  return row.requiresEmbedder
}

/** The source session a staged write came from (extraction payloads stamp it). */
function sourceSessionOf(row: StagedWriteDto): string | null {
  return asString(row.payload['session']) ?? asString(row.payload['sessionId'])
}

/** staged_writes.kind for a project skill discovered during codebase ingest (Stage 3). */
const SKILL_IMPORT_KIND = 'skill-import'

function isSkillImport(row: StagedWriteDto): boolean {
  return row.kind === SKILL_IMPORT_KIND
}

// The row primary line, the diff-modal headline, and the batch-approve list all
// read from ONE sentence engine (readability addendum R1): summarizeStagedWrite.

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

/** Staged writes per day over the last week, for the small trend chart. */
function stagedPerDay(rows: readonly StagedWriteDto[]): { label: string; value: number }[] {
  const days = lastNDays(7)
  const byDay = new Map<string, number>(days.map((d) => [d, 0]))
  for (const row of rows) {
    const key = dayKey(row.createdAt)
    if (byDay.has(key)) byDay.set(key, (byDay.get(key) ?? 0) + 1)
  }
  return days.map((d) => ({ label: d.slice(5), value: byDay.get(d) ?? 0 }))
}

// ── memory-change columns (raw kind + raw status stay visible) ────────────────

// The `change` cell leads with a plain sentence; its second line keeps the raw
// `kind` word (golden-path asserts a row toContainText('extraction')) and the
// proposer. The status Badge keeps the RAW word visible per constraint 5, with
// the plain explanation in its tooltip.
const STAGED_COLUMNS: readonly Column<StagedWriteDto>[] = [
  {
    key: 'change',
    header: 'change',
    render: (row) => (
      <div className="flex flex-col gap-0.5">
        <span className="text-[13px] leading-5 text-ink">{summarizeStagedWrite(row).what}</span>
        {/* Keep the raw kind visible (golden-path asserts a row toContainText('extraction')). */}
        <span className="font-mono text-[11px] text-ink-mute">
          {row.kind} · proposed by {row.proposedBy}
        </span>
      </div>
    )
  },
  {
    key: 'status',
    header: 'status',
    render: (row) => <Badge status={row.status} title={plainStatus(row.status).explain} />
  },
  { key: 'created', header: 'created', render: (row) => <Timestamp iso={row.createdAt} /> }
]

/** Compact columns for the batch-approve confirm list (what will commit). */
const APPROVE_ALL_COLUMNS: readonly Column<StagedWriteDto>[] = [
  { key: 'kind', header: 'kind', className: 'font-mono', render: (row) => row.kind },
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
    render: (row) => {
      const what = summarizeStagedWrite(row).what
      return <span title={what}>{truncate(what, 64)}</span>
    }
  }
]

const STAGED_FILTER_OPTIONS = [
  { value: 'staged', label: 'waiting for review' },
  { value: 'approved', label: 'approved' },
  { value: 'rejected', label: 'declined' },
  { value: 'committed', label: 'saved' },
  { value: 'all', label: 'all' }
] as const

const APPROVAL_FILTER_OPTIONS = [
  { value: 'pending', label: 'waiting' },
  { value: 'approved', label: 'approved' },
  { value: 'denied', label: 'declined' },
  { value: 'all', label: 'all' }
] as const

// Button tooltip when a new-preference commit needs the local AI helper.
const OLLAMA_BLOCKED_TITLE = 'Needs the local AI helper (Ollama), which looks offline right now.'

// ── "where it came from" chips (R1 + R3 deep link) ───────────────────────────

/**
 * One source chip. Session/Project/node chips deep-link into the Memory inspector
 * (R3); a file chip is inert mono text (the renderer is sandboxed — path text and
 * "found in" phrasing is as far as it goes, no filesystem opening).
 */
function SourceChip({
  refItem,
  onInspect
}: {
  refItem: SourceRef
  onInspect?: (target: InspectTarget) => void
}): React.JSX.Element {
  const prefix =
    refItem.kind === 'project' ? 'project' : refItem.kind === 'session' ? 'session' : (refItem.label ?? 'node')
  if (refItem.kind === 'file') {
    return (
      <span
        className="inline-flex max-w-full items-center rounded-md bg-raised px-2 py-0.5 font-mono text-[11px] break-all text-ink-mute"
        {...(refItem.path !== undefined ? { title: refItem.path } : {})}
      >
        {truncate(refItem.display, 52)}
      </span>
    )
  }
  const { label, id } = refItem
  if (onInspect !== undefined && label !== undefined && id !== undefined) {
    return (
      <button
        type="button"
        data-testid={`review-source-${refItem.kind}`}
        onClick={() => onInspect({ label, id })}
        title={`Open in Memory (${id})`}
        className="inline-flex max-w-full items-center gap-1 rounded-md border border-line px-2 py-0.5 text-[11px] text-accent transition-colors duration-120 hover:bg-raised focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
      >
        <span className="text-ink-mute">{prefix}</span>
        <span className="min-w-0 truncate">{truncate(refItem.display, 44)}</span>
      </button>
    )
  }
  return (
    <span className="inline-flex max-w-full items-center gap-1 rounded-md bg-raised px-2 py-0.5 text-[11px] text-ink-mute">
      <span>{prefix}</span>
      <span className="min-w-0 truncate">{truncate(refItem.display, 44)}</span>
    </span>
  )
}

// ── memory-change modal ───────────────────────────────────────────────────────

function StagedWriteModal({
  row,
  ollamaReady,
  onInspect,
  onClose,
  onChanged
}: {
  row: StagedWriteDto
  /** null while the Ollama status is still loading (fail-open: never block). */
  ollamaReady: boolean | null
  onInspect?: (target: InspectTarget) => void
  onClose: () => void
  onChanged: () => void
}): React.JSX.Element {
  const toast = useToast()
  const diff = useIpc('review.staged.diff', { id: row.id })
  const [busy, setBusy] = useState(false)

  const payload = row.payload
  // ONE sentence engine (R1): plain what / why / where-from for every kind.
  const summary = summarizeStagedWrite(row)
  const provenance = asObject(payload['provenance'])
  const extractedBy =
    (provenance !== null ? asString(provenance['extracted_by']) : null) ?? asString(payload['extracted_by'])
  const confidence =
    (provenance !== null ? asNumber(provenance['confidence']) : null) ?? asNumber(payload['confidence'])
  const session = asString(payload['session']) ?? asString(payload['sessionId'])
  const commitError = row.validation !== null ? asString(row.validation['commitError']) : null
  const hasProvenance = extractedBy !== null || confidence !== null || session !== null

  // Skill-import specifics (feature A): a proposed skill was written by AI from
  // the docs (confidence 0.6); an artifact was found verbatim in the repo.
  const skillImport = isSkillImport(row)
  const skillProposal = skillImport && payload['proposal'] === true
  const skillSource = skillImport ? asString(payload['source']) : null
  const skillConfidence = skillImport ? asNumber(payload['confidence']) : null

  // Ollama preflight (P1.7): a new-Preference extraction embeds at commit, so a
  // known-down Ollama blocks the commit up front. Unknown status fails open.
  const blocked = requiresEmbedder(row) && ollamaReady === false
  const plain = plainStatus(row.status)

  async function approve(): Promise<void> {
    setBusy(true)
    try {
      await call('review.staged.approve', { id: row.id })
      toast.notify('ok', 'committed (undoable in audit log)')
      onClose()
      onChanged()
    } catch (err) {
      // Keep the modal open so the operator can retry or decline.
      toast.notify('err', errText(err))
    } finally {
      setBusy(false)
    }
  }

  async function reject(): Promise<void> {
    setBusy(true)
    try {
      await call('review.staged.reject', { id: row.id })
      toast.notify('ok', 'Change declined.')
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
        <Button variant="danger-ghost" testId="staged-reject" disabled={busy} onClick={() => void reject()}>
          Decline
        </Button>
        <Button
          variant="primary"
          testId="staged-approve"
          disabled={busy || blocked}
          {...(blocked ? { title: OLLAMA_BLOCKED_TITLE } : {})}
          onClick={() => void approve()}
        >
          Approve
        </Button>
      </>
    ) : row.status === 'approved' ? (
      // An 'approved' row was decided but hasn't finished committing (a crash
      // between the audited commit and the status flip, or an earlier commit
      // error). Approve is re-drivable, so the same button finishes it.
      <Button
        variant="primary"
        testId="staged-approve"
        disabled={busy || blocked}
        {...(blocked ? { title: OLLAMA_BLOCKED_TITLE } : {})}
        onClick={() => void approve()}
      >
        Finish committing
      </Button>
    ) : undefined

  return (
    <Modal title="Proposed memory change" onClose={onClose} wide footer={footer}>
      <div className="mb-3 flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="mb-0.5 text-[12px] text-ink-mute">What happens if you approve</div>
          <div className="text-[14px] leading-5 text-ink">{summary.what}</div>
        </div>
        <Badge status={row.status} title={plain.explain} />
      </div>

      {row.status === 'approved' && (
        <div
          role="note"
          data-testid="staged-approved-hint"
          className="mb-3 rounded-md border border-warn/40 bg-warn/10 px-3 py-2 text-[12px] leading-5"
        >
          This change was approved but hasn’t finished saving yet. Use “Finish committing” below to complete it.
        </div>
      )}

      {summary.why !== undefined && (
        <div className="mb-3">
          <div className="mb-1 text-[12px] text-ink-mute">Why the agent proposed it</div>
          <blockquote className="rounded-md bg-raised px-3 py-2 text-[12px] leading-5 text-ink-mute">
            {summary.why}
          </blockquote>
        </div>
      )}

      {summary.source !== undefined && summary.source.length > 0 && (
        <div className="mb-3">
          <div className="mb-1 text-[12px] text-ink-mute">Where it came from</div>
          <div className="flex flex-wrap gap-1.5">
            {summary.source.map((refItem, i) => (
              <SourceChip key={i} refItem={refItem} onInspect={onInspect} />
            ))}
          </div>
        </div>
      )}

      {skillImport && (
        <div className="mb-3 flex flex-col gap-1.5 rounded-md bg-raised px-3 py-2 text-[12px] leading-5 text-ink-mute">
          <span>
            {skillProposal
              ? 'This skill was proposed by AI from the project’s documentation — it is stored as inert data until you approve it. Review it first.'
              : 'This skill was found in the project’s files. It becomes standing instructions the assistant follows once approved — review it first.'}
          </span>
          <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
            {skillSource !== null && (
              <span>
                Source: <span className="font-mono text-ink break-all">{skillSource}</span>
              </span>
            )}
            {skillConfidence !== null && (
              <span className="inline-flex items-center gap-1.5">
                confidence <Confidence value={skillConfidence} />
              </span>
            )}
          </span>
        </div>
      )}

      {/* The exact op-by-op change (ids, edges, cypher-level detail) is technical:
          it moves behind a disclosure, but stays open by default so the raw diff
          is visible on open (the summary above is the plain lead). */}
      <Disclosure summary="Technical changes" defaultOpen>
        <div className="mb-1 text-[12px] text-ink-mute">What will change if you approve:</div>
        {diff.error !== null ? (
          <ErrorState error={diff.error} onRetry={diff.reload} />
        ) : diff.data === null ? (
          <div className="py-2 text-[12px] text-ink-mute">Loading the change…</div>
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
      </Disclosure>

      {row.status === 'approved' && commitError !== null && (
        <div className="mt-3 rounded-md border border-err/40 bg-err/10 px-3 py-2" role="alert">
          <div className="text-[12px] font-medium text-err">Saving failed</div>
          <div className="mt-1 text-[12px]">{commitError}</div>
        </div>
      )}
      {blocked && (
        <div
          role="note"
          data-testid="staged-approve-blocked"
          className="mt-3 rounded-md border border-warn/40 bg-warn/10 px-3 py-2 text-[12px]"
        >
          Saving this needs the local AI helper (Ollama), which looks offline right now. Start Ollama, then approve.
        </div>
      )}

      {hasProvenance && (
        <div className="mt-3">
          <Disclosure summary="Technical provenance">
            <KV
              entries={[
                ...(extractedBy !== null
                  ? [{ k: 'extracted by', v: <span className="font-mono">{extractedBy}</span> }]
                  : []),
                ...(confidence !== null ? [{ k: 'confidence', v: <Confidence value={confidence} /> }] : []),
                ...(session !== null ? [{ k: 'session', v: <span className="font-mono">{session}</span> }] : [])
              ]}
            />
          </Disclosure>
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
    const skipped = blocked.length > 0 ? `, ${blocked.length} still need the local AI helper` : ''
    if (failures.length === 0) toast.notify('ok', `Saved ${approved}${skipped} — undoable in History.`)
    else toast.notify('err', `Saved ${approved}, ${failures.length} failed: ${failures[0]}`)
    onClose()
    onDone()
  }

  const footer = (
    <>
      <Button disabled={busy} onClick={onClose}>
        Cancel
      </Button>
      <Button
        variant="primary"
        testId="staged-approve-all-confirm"
        disabled={busy || eligible.length === 0}
        onClick={() => void approveAll()}
      >
        Approve {eligible.length}
      </Button>
    </>
  )

  return (
    <Modal title="Approve all in this group" onClose={onClose} wide footer={footer}>
      <div className="mb-2 text-[12px] text-ink-mute">
        {group.sessionId !== null ? (
          <>
            From session <span className="font-mono text-ink">{group.sessionId}</span>
          </>
        ) : (
          <>
            Proposed by <span className="font-mono text-ink">{group.proposedBy}</span>
          </>
        )}
        . Each row below becomes a saved change you can undo later. Open any row first to see its full diff.
      </div>
      <DataTable
        testId="staged-approve-all-list"
        columns={APPROVE_ALL_COLUMNS}
        rows={eligible}
        rowKey={(row) => row.id}
        empty="Nothing here can be approved."
      />
      {blocked.length > 0 && (
        <div
          role="note"
          data-testid="staged-approve-all-blocked"
          className="mt-2 rounded-md border border-warn/40 bg-warn/10 px-3 py-2 text-[12px]"
        >
          {blocked.length} {blocked.length === 1 ? 'change saves' : 'changes save'} a new preference or skill with the
          local AI helper (Ollama), which looks offline — skipped until it is running.
        </div>
      )}
    </Modal>
  )
}

// ── one session group in the memory-changes section ───────────────────────────

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
          {/* Plain proposer title; the raw agent id stays in the tooltip. */}
          <span className="truncate text-[12px] text-ink" title={group.proposedBy}>
            {plainProposerTitle(group.proposedBy)}
            {group.sessionId !== null && (
              <span className="text-ink-mute"> (session {truncate(group.sessionId, 12)})</span>
            )}
          </span>
          <span className="font-mono text-[11px] text-ink-mute">{plural(group.rows.length, 'change')}</span>
        </div>
        {approvable.length > 0 && (
          <Button
            variant="primary"
            testId={`staged-approve-all-${slug(group.key)}`}
            disabled={allBlocked}
            {...(allBlocked ? { title: OLLAMA_BLOCKED_TITLE } : {})}
            onClick={() => onApproveAll(group)}
          >
            Approve all ({approvable.length})
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

// ── permission-request row ─────────────────────────────────────────────────────

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

function ApprovalRow({
  row,
  deciding,
  onDecide
}: {
  row: ApprovalDto
  deciding: boolean
  onDecide: (row: ApprovalDto, decision: 'approved' | 'denied') => void
}): React.JSX.Element {
  const scope = scopeFacts(row.details)
  const plain = plainStatus(row.status)
  return (
    <li className="flex flex-col gap-2 px-3 py-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="text-[13px] leading-5 text-ink">
            Agent <span className="font-mono">{row.agentId}</span> wants to{' '}
            <span className="font-mono">{row.actionName}</span>
          </div>
          <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-[12px] text-ink-mute">
            <Badge status={row.tier} title="How sensitive this action is — higher levels need a closer look." />
            {scope !== '-' && <span className="font-mono">Affects: {scope}</span>}
            <Timestamp iso={row.requestedAt} />
          </div>
        </div>
        {row.status === 'pending' ? (
          <div className="flex shrink-0 gap-1.5">
            <Button
              variant="danger-ghost"
              testId={`approval-deny-${row.id}`}
              disabled={deciding}
              onClick={() => onDecide(row, 'denied')}
            >
              Decline
            </Button>
            <Button
              variant="primary"
              testId={`approval-approve-${row.id}`}
              disabled={deciding}
              onClick={() => onDecide(row, 'approved')}
            >
              Allow
            </Button>
          </div>
        ) : (
          <Badge status={row.status} label={plain.label} title={plain.explain} />
        )}
      </div>
      <Disclosure summary="Technical details">
        <pre className="overflow-x-auto font-mono text-[11px] leading-5 whitespace-pre-wrap text-ink-mute">
          {JSON.stringify(row.details, null, 2)}
        </pre>
      </Disclosure>
    </li>
  )
}

// ── safety-flag row ────────────────────────────────────────────────────────────

function FlagRow({ row }: { row: InjectionFlagDto }): React.JSX.Element {
  const detector = plainStatus(row.detector).label
  return (
    <li className="flex flex-col gap-1.5 px-3 py-3">
      <blockquote className="rounded-md bg-raised px-3 py-2 text-[12px] leading-5 text-ink">{row.excerpt}</blockquote>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[12px] text-ink-mute">
        <Badge status="flagged" label={detector} title={plainStatus(row.detector).explain} />
        <Timestamp iso={row.createdAt} />
      </div>
      <Disclosure summary="Why this was flagged">
        <div className="flex flex-col gap-1.5 text-[12px] text-ink-mute">
          <div>
            Flagged by the {detector} check because it matched the pattern{' '}
            <span className="font-mono text-ink">{row.pattern}</span>.
          </div>
          <div className="break-all">
            Source: <span className="font-mono text-ink">{row.source}</span>
          </div>
        </div>
      </Disclosure>
    </li>
  )
}

// ── panel ─────────────────────────────────────────────────────────────────────

export default function ReviewPanel({ onInspect }: PanelProps): React.JSX.Element {
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
  const stagedBars = stagedPerDay(stagedRows)

  async function decide(row: ApprovalDto, decision: 'approved' | 'denied'): Promise<void> {
    setDeciding(row.id)
    try {
      await call('review.approvals.decide', { id: row.id, decision })
      toast.notify('ok', decision === 'approved' ? 'Request allowed.' : 'Request declined.')
      approvals.reload()
    } catch (err) {
      toast.notify('err', errText(err))
    } finally {
      setDeciding(null)
    }
  }

  return (
    <>
      <PanelHeader
        title="Approvals"
        subtitle="Changes and actions waiting for your decision."
        icon={<Icon name="approvals" size={18} />}
        meta={
          <span>
            {plural(stagedRows.length, 'memory change')} · {plural(approvalRows.length, 'permission request')} ·{' '}
            {plural(flagRows.length, 'safety flag')}
          </span>
        }
      />
      <div className="min-h-0 flex-1 overflow-y-auto px-5 py-3">
        <section className="mb-6">
          <div className="flex items-center justify-between gap-3">
            <SectionHeader meta={<span className="font-mono">{stagedRows.length}</span>}>Memory changes</SectionHeader>
            <Select
              value={stagedFilter}
              onChange={(value) => setStagedFilter(value as StagedWriteStatusDto | 'all')}
              options={STAGED_FILTER_OPTIONS}
              ariaLabel="filter memory changes by status"
              testId="staged-status-filter"
            />
          </div>
          <p className="mb-2 text-[12px] text-ink-mute">
            Things an agent proposed remembering. Open one to see exactly what changes before you approve it.
          </p>
          {ollamaReady === false && (
            <div className="mb-2 flex items-start gap-1.5 text-[12px] text-ink-mute">
              <Icon name="info" size={14} className="mt-0.5 shrink-0" />
              <span>
                The local AI helper (Ollama) looks offline. A change that saves a new preference or skill can&apos;t be
                approved until it is running again.
              </span>
            </div>
          )}
          {stagedRows.length > 1 && (
            <div className="mb-3 flex flex-col gap-1">
              <span className="text-[12px] text-ink-mute">Proposed changes per day — last 7 days</span>
              <BarChart
                bars={stagedBars}
                height={36}
                ariaLabel={`Proposed memory changes per day over the last week: ${stagedRows.length} in this view.`}
              />
            </div>
          )}
          {staged.error !== null ? (
            <ErrorState error={staged.error} onRetry={staged.reload} />
          ) : staged.data === null ? (
            <LoadingRows />
          ) : stagedRows.length === 0 ? (
            <EmptyState icon={<Icon name="approvals" size={20} />}>
              {stagedFilter === 'staged'
                ? 'No memory changes waiting — when an agent proposes something, it appears here.'
                : stagedFilter === 'all'
                  ? 'No memory changes.'
                  : `No ${plainStatus(stagedFilter).label} memory changes.`}
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
              Permission requests
            </SectionHeader>
            <Select
              value={approvalFilter}
              onChange={(value) => setApprovalFilter(value as 'pending' | 'approved' | 'denied' | 'all')}
              options={APPROVAL_FILTER_OPTIONS}
              ariaLabel="filter permission requests by status"
              testId="approval-status-filter"
            />
          </div>
          <p className="mb-2 text-[12px] text-ink-mute">
            Actions an agent needs your OK for before it can do something sensitive.
          </p>
          {approvals.error !== null ? (
            <ErrorState error={approvals.error} onRetry={approvals.reload} />
          ) : approvals.data === null ? (
            <LoadingRows />
          ) : approvalRows.length === 0 ? (
            <EmptyState icon={<Icon name="check" size={20} />}>
              No permission requests — when an agent needs your OK for something sensitive, it appears here.
            </EmptyState>
          ) : (
            <ul data-testid="approvals-table" className="flex flex-col divide-y divide-line rounded-md border border-line">
              {approvalRows.map((row) => (
                <ApprovalRow key={row.id} row={row} deciding={deciding === row.id} onDecide={(r, d) => void decide(r, d)} />
              ))}
            </ul>
          )}
        </section>

        <section className="mb-6">
          <SectionHeader meta={<span className="font-mono">{flagRows.length}</span>}>Safety flags</SectionHeader>
          <p className="mb-2 text-[12px] text-ink-mute">
            Added content that looked like an attempt to manipulate the assistant. It is stored as plain data, not
            instructions — this is just a heads-up.
          </p>
          {flags.error !== null ? (
            <ErrorState error={flags.error} onRetry={flags.reload} />
          ) : flags.data === null ? (
            <LoadingRows />
          ) : flagRows.length === 0 ? (
            <EmptyState icon={<Icon name="check" size={20} />}>
              No safety flags — content that looks like an attempt to manipulate the assistant would show up here.
            </EmptyState>
          ) : (
            <ul data-testid="flags-table" className="flex flex-col divide-y divide-line rounded-md border border-line">
              {flagRows.map((row) => (
                <FlagRow key={row.id} row={row} />
              ))}
            </ul>
          )}
        </section>
      </div>

      {selected !== null && (
        <StagedWriteModal
          row={selected}
          ollamaReady={ollamaReady}
          onInspect={onInspect}
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
