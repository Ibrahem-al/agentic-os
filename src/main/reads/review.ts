/**
 * Review-queue reads (§4.D) — the shared source for the dashboard's
 * `review.staged.list` / `review.staged.diff` / `review.approvals.list` /
 * `review.flags.list` handlers AND the `list_staged_writes` /
 * `get_staged_write` / `list_approvals` / `list_injection_flags` read tools.
 *
 * Each wraps the existing owning-module fn (listStagedWrites, getStagedWrite,
 * renderStagedWriteDiff, PermissionEngine.listApprovals) — no query is
 * reimplemented — and maps to the shipped DTO verbatim.
 */
import type BetterSqlite3 from 'better-sqlite3'
import type { ApprovalDto, InjectionFlagDto, StagedWriteDto, StagedWriteStatusDto } from '../../shared/ipc'
import {
  StagedWriteError,
  getStagedWrite,
  listStagedWrites,
  renderStagedWriteDiff,
  type ApprovalRow,
  type StagedWriteRow
} from '../security'
import type { StorageEngine } from '../storage'
import { jsonObject } from './serialize'
import type { StagedWriteDetailDto } from './types'

/** Any object exposing the §13 approval listing (PermissionEngine satisfies it). */
export interface ApprovalLister {
  listApprovals(filter?: { status?: 'pending' | 'approved' | 'denied' }): ApprovalRow[]
}

const stagedWriteDto = (row: StagedWriteRow): StagedWriteDto => ({
  id: row.id,
  proposedBy: row.proposedBy,
  kind: row.kind,
  targetLabel: row.targetLabel,
  targetId: row.targetId,
  payload: jsonObject(row.payload),
  status: row.status,
  validation: row.validation === null ? null : jsonObject(row.validation),
  createdAt: row.createdAt,
  decidedAt: row.decidedAt,
  committedAt: row.committedAt
})

export interface ListStagedWritesArgs {
  readonly status?: StagedWriteStatusDto
  /** Restrict to rows this proposer staged (the tool's `proposed_by_me`). */
  readonly proposedBy?: string
}

export function listStagedWritesRead(db: BetterSqlite3.Database, args: ListStagedWritesArgs = {}): StagedWriteDto[] {
  const rows = listStagedWrites(db, args.status !== undefined ? { status: args.status } : undefined)
  const filtered = args.proposedBy !== undefined ? rows.filter((r) => r.proposedBy === args.proposedBy) : rows
  return filtered.map(stagedWriteDto)
}

export interface GetStagedWriteDeps {
  readonly db: BetterSqlite3.Database
  readonly engine: StorageEngine
}

export interface GetStagedWriteArgs {
  readonly id: string
  readonly includeDiff?: boolean
}

/** One staged row, optionally with the rendered §13 diff (NOT_FOUND if absent). */
export async function getStagedWriteRead(
  deps: GetStagedWriteDeps,
  { id, includeDiff }: GetStagedWriteArgs
): Promise<StagedWriteDetailDto> {
  const row = getStagedWrite(deps.db, id)
  if (row === undefined) throw new StagedWriteError('NOT_FOUND', `staged write ${id} does not exist`)
  const diff = includeDiff === true ? await renderStagedWriteDiff({ db: deps.db, engine: deps.engine }, id) : null
  return { ...stagedWriteDto(row), diff }
}

export function listApprovalsRead(
  permissions: ApprovalLister,
  args: { status?: 'pending' | 'approved' | 'denied' } = {}
): ApprovalDto[] {
  const rows = permissions.listApprovals(args.status !== undefined ? { status: args.status } : undefined)
  return rows.map(
    (row): ApprovalDto => ({
      id: row.id,
      agentId: row.agentId,
      actionKind: row.actionKind,
      actionName: row.actionName,
      tier: row.tier,
      details: jsonObject(row.details),
      status: row.status,
      requestedAt: row.requestedAt,
      decidedAt: row.decidedAt,
      decidedBy: row.decidedBy
    })
  )
}

/** ipc review.flags.list: the injection-scan findings, newest first. */
export function listInjectionFlags(db: BetterSqlite3.Database): InjectionFlagDto[] {
  const rows = db
    .prepare('SELECT id, source, detector, pattern, excerpt, created_at FROM injection_flags ORDER BY created_at DESC, id LIMIT 500')
    .all() as { id: string; source: string; detector: 'regex' | 'llm'; pattern: string; excerpt: string; created_at: string }[]
  return rows.map((row) => ({
    id: row.id,
    source: row.source,
    detector: row.detector,
    pattern: row.pattern,
    excerpt: row.excerpt,
    createdAt: row.created_at
  }))
}
