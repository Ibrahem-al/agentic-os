/**
 * Session-end triggers (§6 three-tier detection, phase 11) — the extraction
 * agent's phase-08 manual entry points finally get their callers:
 *
 *  1. PRIMARY — Claude Code SessionEnd hook: the hook script POSTs its stdin
 *     JSON (`session_id`, `transcript_path`, `cwd`, `reason`) to
 *     POST /hooks/session-end on the MCP HTTP server (same server, §20),
 *     authenticated by the dedicated hook token. The handler validates and
 *     ENQUEUES — extraction runs in the §8 queue, never on the request path.
 *  2. Spool: when the app was closed, the hook script appended its JSON to
 *     ~/.agentic-os/pending-sessions/; drainSessionSpool() enqueues + deletes
 *     each file on boot (malformed files are renamed *.bad, never re-read).
 *  3. FALLBACK — MCP-log inactivity: a session id whose mcp_calls go quiet
 *     for 30 min (§20) is considered ended (any client, no hook needed).
 *
 * Exactly-once (§6/phase DoD): every path enqueues the deterministic task id
 * `extract-<sessionId>` — the queue's id dedup makes hook + spool +
 * inactivity converge on ONE extraction per session, durably.
 */
import { readdirSync, readFileSync, renameSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import type BetterSqlite3 from 'better-sqlite3'
import * as z from 'zod'
import { INACTIVITY_CHECK_INTERVAL_MS, MCP_INACTIVITY_TIMEOUT_MS, TASK_PRIORITY } from '../config'
import type { ExtractionAgent } from '../agents'
import type { JsonObject, WorkflowRunner } from '../kernel'
import { TaskFatalError, type DurableTaskQueue, type EnqueueResult } from './queue'

export const EXTRACTION_TASK_KIND = 'extraction'

/** The §6 dedup key: one extraction task per session id, ever. */
export function extractionTaskId(sessionId: string): string {
  return `extract-${sessionId}`
}

/** The hook's stdin JSON (Claude Code SessionEnd shape); unknown keys stripped. */
const SessionEndPayloadSchema = z.object({
  session_id: z.string().min(1),
  transcript_path: z.string().min(1).optional(),
  cwd: z.string().min(1).optional(),
  reason: z.string().optional()
})

export type SessionEndPayload = z.output<typeof SessionEndPayloadSchema>

export type SessionEndOrigin = 'hook' | 'spool' | 'inactivity'

/** Enqueue the extraction task for a finished session (deterministic id). */
export function enqueueExtraction(
  queue: DurableTaskQueue,
  session: { sessionId: string; transcriptPath?: string; cwd?: string },
  origin: SessionEndOrigin
): EnqueueResult {
  return queue.enqueue({
    id: extractionTaskId(session.sessionId),
    kind: EXTRACTION_TASK_KIND,
    priority: TASK_PRIORITY.extraction,
    payload: {
      sessionId: session.sessionId,
      transcriptPath: session.transcriptPath ?? null,
      cwd: session.cwd ?? null,
      origin
    }
  })
}

export interface HookResponse {
  readonly status: number
  readonly body: JsonObject
}

/**
 * The POST /hooks/session-end request logic (transport-free — the MCP HTTP
 * server routes to this after its own token check). Always fast: validate +
 * enqueue only.
 */
export function createSessionEndHookHandler(queue: DurableTaskQueue): (body: unknown) => HookResponse {
  return (body) => {
    const parsed = SessionEndPayloadSchema.safeParse(body)
    if (!parsed.success) {
      const detail = parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ')
      return { status: 400, body: { error: `invalid session-end payload — ${detail}` } }
    }
    const result = enqueueExtraction(
      queue,
      {
        sessionId: parsed.data.session_id,
        ...(parsed.data.transcript_path !== undefined ? { transcriptPath: parsed.data.transcript_path } : {}),
        ...(parsed.data.cwd !== undefined ? { cwd: parsed.data.cwd } : {})
      },
      'hook'
    )
    return { status: 200, body: { ok: true, taskId: result.taskId, deduped: result.deduped } }
  }
}

export interface SpoolDrainResult {
  /** Fresh extraction tasks enqueued from spool files. */
  readonly enqueued: number
  /** Spool files whose session already had a task (still deleted). */
  readonly deduped: number
  /** Unreadable/invalid files, renamed to *.bad and left behind. */
  readonly malformed: number
}

/**
 * Drain ~/.agentic-os/pending-sessions/ (§6: "no session is lost to timing").
 * Every *.json file either becomes an enqueued (or deduped) extraction task
 * and is deleted, or is renamed *.bad so a poison file cannot loop forever.
 */
export function drainSessionSpool(queue: DurableTaskQueue, spoolDir: string): SpoolDrainResult {
  let entries: string[]
  try {
    entries = readdirSync(spoolDir)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { enqueued: 0, deduped: 0, malformed: 0 }
    throw err
  }
  let enqueued = 0
  let deduped = 0
  let malformed = 0
  for (const name of entries) {
    if (!name.toLowerCase().endsWith('.json')) continue
    const filePath = join(spoolDir, name)
    let payload: SessionEndPayload
    try {
      const parsed = SessionEndPayloadSchema.safeParse(JSON.parse(readFileSync(filePath, 'utf8')))
      if (!parsed.success) throw new Error('payload failed validation')
      payload = parsed.data
    } catch {
      malformed += 1
      try {
        renameSync(filePath, `${filePath}.bad`)
      } catch (renameErr) {
        console.warn(`[triggers] could not quarantine spool file ${filePath}: ${String(renameErr)}`)
      }
      continue
    }
    const result = enqueueExtraction(
      queue,
      {
        sessionId: payload.session_id,
        ...(payload.transcript_path !== undefined ? { transcriptPath: payload.transcript_path } : {}),
        ...(payload.cwd !== undefined ? { cwd: payload.cwd } : {})
      },
      'spool'
    )
    if (result.deduped) deduped += 1
    else enqueued += 1
    unlinkSync(filePath)
  }
  return { enqueued, deduped, malformed }
}

/**
 * The §6 tier-2 fallback: sweep mcp_calls for session ids silent past the
 * §20 30-min timeout that have no extraction task yet, and enqueue them
 * (backbone-only — no hook means no transcript path; §6 tier 3 demoted the
 * file watcher to enrichment, deliberately not implemented as a trigger).
 */
export class InactivityMonitor {
  private readonly queue: DurableTaskQueue
  private readonly selectQuiet: BetterSqlite3.Statement
  private readonly timeoutMs: number
  private readonly intervalMs: number
  private timer: NodeJS.Timeout | null = null

  constructor(deps: {
    db: BetterSqlite3.Database
    queue: DurableTaskQueue
    /** Test seams; default §20 30 min / config 5 min sweep. */
    timeoutMs?: number
    intervalMs?: number
  }) {
    this.queue = deps.queue
    this.timeoutMs = deps.timeoutMs ?? MCP_INACTIVITY_TIMEOUT_MS
    this.intervalMs = deps.intervalMs ?? INACTIVITY_CHECK_INTERVAL_MS
    // The NOT EXISTS keeps the sweep O(new sessions): ids with ANY extraction
    // task (done, failed, pending — the exactly-once key) never re-surface.
    this.selectQuiet = deps.db.prepare(
      `SELECT session_id AS sessionId, MAX(started_unix_ms) AS lastUnixMs
       FROM mcp_calls
       WHERE session_id IS NOT NULL
         AND NOT EXISTS (SELECT 1 FROM tasks WHERE tasks.id = 'extract-' || mcp_calls.session_id)
       GROUP BY session_id
       HAVING MAX(started_unix_ms) <= ?`
    )
  }

  /** One sweep; returns the session ids freshly enqueued. */
  checkOnce(nowUnixMs: number = Date.now()): string[] {
    const rows = this.selectQuiet.all(nowUnixMs - this.timeoutMs) as { sessionId: string; lastUnixMs: number }[]
    const fresh: string[] = []
    for (const row of rows) {
      const result = enqueueExtraction(this.queue, { sessionId: row.sessionId }, 'inactivity')
      if (!result.deduped) fresh.push(row.sessionId)
    }
    if (fresh.length > 0) {
      console.log(`[triggers] inactivity fallback: ${fresh.length} quiet session(s) enqueued for extraction`)
    }
    return fresh
  }

  /** Sweep now, then on the configured interval. */
  start(): void {
    if (this.timer !== null) throw new Error('inactivity monitor already started')
    this.checkOnce()
    this.timer = setInterval(() => this.checkOnce(), this.intervalMs)
  }

  stop(): void {
    if (this.timer !== null) clearInterval(this.timer)
    this.timer = null
  }
}

// ── The 'extraction' task handler ────────────────────────────────────────────

export interface ExtractionHandlerDeps {
  readonly agent: ExtractionAgent
  readonly runner: WorkflowRunner
}

/** Does the error chain end in "this session has nothing to extract"? */
function isNothingToExtract(err: unknown): boolean {
  let current: unknown = err
  for (let depth = 0; depth < 6 && current instanceof Error; depth++) {
    if (current.name === 'ExtractionError' && (current as { code?: string }).code === 'NOT_FOUND') return true
    current = current.cause
  }
  return false
}

/**
 * Register the 'extraction' handler: run the phase-08 workflow for the task's
 * session — resuming the SAME workflow job on retries, so model passes that
 * already checkpointed are never re-run (phase-08 crash-resume design).
 */
export function registerExtractionHandler(queue: DurableTaskQueue, deps: ExtractionHandlerDeps): void {
  queue.registerHandler(EXTRACTION_TASK_KIND, async (payload, ctx) => {
    const sessionId = typeof payload['sessionId'] === 'string' ? payload['sessionId'] : ''
    if (sessionId === '') throw new TaskFatalError(`extraction task ${ctx.taskId} carries no sessionId`)
    const transcriptPath = typeof payload['transcriptPath'] === 'string' ? payload['transcriptPath'] : undefined
    const cwd = typeof payload['cwd'] === 'string' ? payload['cwd'] : undefined
    // Deterministic workflow job id, distinct from the task id (both live in
    // the tasks table): retries resume it instead of starting over.
    const workflowJobId = `${ctx.taskId}-wf`
    try {
      const existing = await deps.runner.getJob(workflowJobId)
      const result =
        existing !== undefined
          ? await deps.agent.resumeExtraction(workflowJobId)
          : await deps.agent.runExtraction(sessionId, {
              jobId: workflowJobId,
              ...(transcriptPath !== undefined ? { transcriptPath } : {}),
              ...(cwd !== undefined ? { cwd } : {})
            })
      const c = result.committed
      const committedTotal =
        c.usedSkills + c.usedMcps + c.usedPlugins + c.components + c.mergedComponents + c.preferences +
        c.mergedPreferences + c.corrections
      return {
        note: `session ${sessionId} extracted (tier ${result.tier}${result.escalated ? ', escalated' : ''}) — ${committedTotal} committed, ${result.staged.count} staged`
      }
    } catch (err) {
      if (isNothingToExtract(err)) {
        // Not a failure: a session with no calls and no transcript has nothing
        // to learn from; retrying cannot change that.
        return { note: `session ${sessionId}: nothing to extract (no mcp_calls, no readable transcript)` }
      }
      throw err
    }
  })
}
