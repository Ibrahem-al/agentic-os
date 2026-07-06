/**
 * Session / extraction reads (§4.A) — the three genuinely new §4 query
 * sources, none of which has a dashboard equivalent:
 *
 *  - listSessions: the mcp_calls rollup (InactivityMonitor.selectQuiet shape
 *    minus the quiet filter) LEFT JOIN the `extract-<sid>` task + a graph check
 *    for the extracted Session node. Runner-only sessions never count "pending".
 *  - readSession: the transcript path is resolved SERVER-SIDE from the
 *    `extract-<sid>` task payload — NEVER from caller input (no arbitrary-file
 *    read). The rendered transcript is wrapped `{ untrusted: true, ... }`
 *    (§21 rule 5: it is DATA); tool_result bodies stay unrendered (the parser
 *    already skips them); a regex injection scan runs over the text.
 *  - getPendingWork: everything awaiting attention — quiet sessions, skills
 *    with new event-gate signal, open drift watches, staged writes, approvals.
 */
import type BetterSqlite3 from 'better-sqlite3'
import { EXTRACTION_CLOUD_CHUNK_TOKENS, MCP_INACTIVITY_TIMEOUT_MS } from '../config'
import {
  chunkTranscript,
  collectSignal,
  getSkillSettings,
  hasPendingReview,
  listOpenDriftWatches,
  parseTranscriptFile,
  sessionNodeIdOf
} from '../agents'
import { estimatingTokenCounter } from '../retrieval'
import { INJECTION_PATTERNS } from '../security'
import type { StorageEngine } from '../storage'
import { improvementEntryDto } from './skills'
import { listApprovalsRead, listStagedWritesRead, type ApprovalLister } from './review'
import { jsonObject } from './serialize'
import type {
  InjectionFindingDto,
  PendingSkillSignalDto,
  PendingWorkDto,
  SessionCallDto,
  SessionReadDto,
  SessionSummaryDto,
  SessionTranscriptDto
} from './types'

export interface SessionReadsDeps {
  readonly db: BetterSqlite3.Database
  readonly engine: StorageEngine
}

// ── list_sessions ─────────────────────────────────────────────────────────────

interface SessionAggRow {
  sessionId: string
  calls: number
  runnerCalls: number
  firstUnixMs: number | null
  lastUnixMs: number | null
  taskId: string | null
  taskStatus: string | null
}

/** list_sessions: every MCP session's call rollup + extraction disposition. */
export async function listSessions(deps: SessionReadsDeps, args: { limit?: number } = {}): Promise<SessionSummaryDto[]> {
  const safeLimit = Math.min(Math.max(Math.trunc(args.limit ?? 100) || 100, 1), 500)
  const rows = deps.db
    .prepare(
      `SELECT c.session_id AS sessionId,
              COUNT(*) AS calls,
              SUM(CASE WHEN c.session_kind = 'runner' THEN 1 ELSE 0 END) AS runnerCalls,
              MIN(c.started_unix_ms) AS firstUnixMs,
              MAX(c.started_unix_ms) AS lastUnixMs,
              t.id AS taskId,
              t.status AS taskStatus
       FROM mcp_calls c
       LEFT JOIN tasks t ON t.id = 'extract-' || c.session_id
       WHERE c.session_id IS NOT NULL
       GROUP BY c.session_id
       ORDER BY lastUnixMs DESC
       LIMIT ?`
    )
    .all(safeLimit) as SessionAggRow[]

  // Which of these sessions already have an extracted Session node in the graph.
  const nodeRows = await deps.engine.cypher('MATCH (s:Session) RETURN s.id AS id')
  const sessionNodeIds = new Set(nodeRows.map((r) => String(r['id'])))

  return rows.map((row): SessionSummaryDto => {
    const runnerCalls = Number(row.runnerCalls ?? 0)
    const calls = Number(row.calls ?? 0)
    const isRunnerSession = calls > 0 && runnerCalls === calls
    return {
      sessionId: row.sessionId,
      calls,
      runnerCalls,
      isRunnerSession,
      firstCallUnixMs: row.firstUnixMs,
      lastCallUnixMs: row.lastUnixMs,
      extraction: row.taskId !== null ? { taskId: row.taskId, status: String(row.taskStatus ?? 'unknown') } : null,
      extracted: sessionNodeIds.has(sessionNodeIdOf(row.sessionId)),
      // §6 sweep semantics: a session needs extraction when no task exists yet
      // AND it is not a headless runner's own MCP session.
      pending: row.taskId === null && !isRunnerSession
    }
  })
}

// ── read_session ──────────────────────────────────────────────────────────────

const EXCERPT_CONTEXT_CHARS = 60

/** Regex injection scan over the rendered transcript (scanner's INJECTION_PATTERNS). */
function scanInjection(text: string): InjectionFindingDto[] {
  const findings: InjectionFindingDto[] = []
  for (const { name, re } of INJECTION_PATTERNS) {
    const match = re.exec(text)
    if (match === null) continue
    const start = Math.max(0, match.index - EXCERPT_CONTEXT_CHARS)
    const end = Math.min(text.length, match.index + match[0].length + EXCERPT_CONTEXT_CHARS)
    findings.push({ pattern: name, excerpt: text.slice(start, end) })
  }
  return findings
}

/** The transcript path recorded for a session — from the extract-<sid> task ONLY. */
function resolveTranscriptPath(db: BetterSqlite3.Database, sessionId: string): string | null {
  const row = db.prepare('SELECT payload_json FROM tasks WHERE id = ?').get(`extract-${sessionId}`) as
    | { payload_json: string | null }
    | undefined
  if (row?.payload_json == null) return null
  try {
    const payload = JSON.parse(row.payload_json) as { transcriptPath?: unknown }
    return typeof payload.transcriptPath === 'string' && payload.transcriptPath !== '' ? payload.transcriptPath : null
  } catch {
    return null
  }
}

export interface ReadSessionArgs {
  readonly sessionId: string
  /** 0-based transcript page (chunked at EXTRACTION_CLOUD_CHUNK_TOKENS). */
  readonly page?: number
}

/** read_session: the server-resolved transcript + call log for one session. */
export function readSession(deps: Pick<SessionReadsDeps, 'db'>, { sessionId, page }: ReadSessionArgs): SessionReadDto {
  const warnings: string[] = []

  const callRows = deps.db
    .prepare(
      `SELECT tool, params_json, result_status, started_unix_ms, duration_ms
       FROM mcp_calls WHERE session_id = ? ORDER BY started_unix_ms, id`
    )
    .all(sessionId) as {
    tool: string
    params_json: string | null
    result_status: string | null
    started_unix_ms: number
    duration_ms: number | null
  }[]
  const calls: SessionCallDto[] = callRows.map((row) => {
    let params: Record<string, unknown> | null = null
    if (row.params_json !== null) {
      try {
        const parsed: unknown = JSON.parse(row.params_json)
        if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
          params = parsed as Record<string, unknown>
        }
      } catch {
        params = null
      }
    }
    return {
      tool: row.tool,
      ok: row.result_status === 'ok',
      params: params === null ? null : jsonObject(params),
      startedUnixMs: row.started_unix_ms,
      durationMs: row.duration_ms
    }
  })

  const transcriptPath = resolveTranscriptPath(deps.db, sessionId)
  let transcript: SessionTranscriptDto | null = null
  let injectionFindings: InjectionFindingDto[] = []

  if (transcriptPath === null) {
    warnings.push('no transcript path recorded for this session (hook carried none, or no extraction task exists)')
  } else {
    try {
      const digest = parseTranscriptFile(transcriptPath)
      const pages = chunkTranscript(digest.text, EXTRACTION_CLOUD_CHUNK_TOKENS, estimatingTokenCounter())
      const pageCount = Math.max(pages.length, 1)
      const safePage = Math.min(Math.max(Math.trunc(page ?? 0) || 0, 0), pageCount - 1)
      transcript = {
        untrusted: true,
        available: true,
        page: safePage,
        pageCount,
        records: digest.records,
        tokenEstimate: digest.tokenEstimate,
        text: pages[safePage] ?? '',
        warnings: digest.warnings
      }
      injectionFindings = scanInjection(digest.text)
    } catch (err) {
      warnings.push(`transcript unavailable: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  return {
    sessionId,
    transcriptResolved: transcript !== null,
    transcriptPath,
    calls,
    transcript,
    injectionFindings,
    warnings
  }
}

// ── get_pending_work ──────────────────────────────────────────────────────────

export interface PendingWorkDeps {
  readonly db: BetterSqlite3.Database
  readonly engine: StorageEngine
  readonly permissions: ApprovalLister
}

export interface PendingWorkArgs {
  readonly now?: Date
  readonly inactivityTimeoutMs?: number
}

/** get_pending_work: quiet sessions + skills-with-signal + drift + staged + approvals. */
export async function getPendingWork(deps: PendingWorkDeps, args: PendingWorkArgs = {}): Promise<PendingWorkDto> {
  const now = args.now ?? new Date()
  const timeoutMs = args.inactivityTimeoutMs ?? MCP_INACTIVITY_TIMEOUT_MS

  // The §6 inactivity query (InactivityMonitor.selectQuiet): quiet past the
  // timeout with no extraction task yet.
  const quietRows = deps.db
    .prepare(
      `SELECT session_id AS sessionId, MAX(started_unix_ms) AS lastUnixMs
       FROM mcp_calls
       WHERE session_id IS NOT NULL
         AND NOT EXISTS (SELECT 1 FROM tasks WHERE tasks.id = 'extract-' || mcp_calls.session_id)
       GROUP BY session_id
       HAVING MAX(started_unix_ms) <= ?`
    )
    .all(now.getTime() - timeoutMs) as { sessionId: string; lastUnixMs: number }[]
  const quietSessions = quietRows.map((row) => ({ sessionId: row.sessionId, lastCallUnixMs: row.lastUnixMs }))

  // Skills that accrued new corrections/failure examples since their cursor.
  const skillRows = await deps.engine.cypher('MATCH (s:Skill) RETURN s.id AS id, s.name AS name ORDER BY s.id')
  const skillsWithSignal: PendingSkillSignalDto[] = []
  for (const skillRow of skillRows) {
    const skillId = String(skillRow['id'])
    const settings = getSkillSettings(deps.db, skillId)
    const signal = await collectSignal(deps.engine, skillId, settings.lastRunAt)
    const newCorrections = signal.corrections.filter((c) => c.isNew).length
    const newFailureExamples = signal.failureExamples.filter((e) => e.isNew).length
    if (newCorrections + newFailureExamples === 0) continue
    skillsWithSignal.push({
      skillId,
      skillName: String(skillRow['name'] ?? skillId),
      newCorrections,
      newFailureExamples,
      lastRunAt: settings.lastRunAt,
      hasPendingReview: hasPendingReview(deps.db, skillId)
    })
  }

  return {
    quietSessions,
    skillsWithSignal,
    openDriftWatches: listOpenDriftWatches(deps.db).map(improvementEntryDto),
    stagedWrites: listStagedWritesRead(deps.db, { status: 'staged' }),
    pendingApprovals: listApprovalsRead(deps.permissions, { status: 'pending' })
  }
}
