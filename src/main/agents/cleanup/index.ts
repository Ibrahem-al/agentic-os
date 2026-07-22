/**
 * Graph-cleanup agent (§8 background task kind 'graph-cleanup' — user-directed
 * spec extension). v1 scope = DUPLICATES: run the existing duplicate scan
 * (memory/dedupe), stage EXACT groups directly, and have the LOCAL LLM judge the
 * NEAR groups. Every proposal is a staged 'dedupe-merge' row for human review in
 * Approvals — the agent NEVER writes the graph (§21 rule 6: an internal/AI
 * proposer's only write path is the staged_writes table; approval runs the same
 * audited mergeDuplicates the dashboard uses).
 *
 * Only Preference / Knowledge / Tag groups are stageable (DEDUPE_MERGE_LABELS);
 * a Skill / Project duplicate group is REPORT-ONLY (its versions, improvement
 * ledger and ownership edges make an automatic merge unsafe — the same decision
 * memory/dedupe.ts records) and is only counted in the result note.
 *
 * Structure mirrors agents/skills/handler.ts: a pure core (`runGraphCleanup`,
 * testable with a fake router) plus thin `enqueueGraphCleanup` /
 * `registerGraphCleanupHandler` wrappers. It imports triggers/queue directly
 * (TaskFatalError + the queue types) exactly like the skills handler — never the
 * triggers barrel — so there is no import cycle with src/main/triggers.
 */
import type BetterSqlite3 from 'better-sqlite3'
import {
  DEDUPE_COUNT_DEFAULT,
  DEDUPE_RECENT_DEFAULT_WINDOW_MS,
  GRAPH_CLEANUP_JUDGE_MAX_TOKENS,
  GRAPH_CLEANUP_MAX_LLM_JUDGMENTS,
  TASK_PRIORITY
} from '../../config'
import type { JsonObject } from '../../kernel'
import {
  DEDUPE_MERGE_LABELS,
  DedupeScanAbortedError,
  MemoryEditError,
  planDedupeMerge,
  scanDuplicates,
  type DedupeMergePlan,
  type DedupeScope,
  type DuplicateGroup,
  type ScanDuplicatesOptions
} from '../../memory'
import type { ProviderRouter } from '../../models'
import {
  DEDUPE_MERGE_STAGED_KIND,
  decodeDedupeMergePayload,
  stageDedupeMerge,
  type DedupeMergePayload
} from '../../security/stagedWrites'
import type { StorageEngine } from '../../storage'
import { TaskFatalError, type DurableTaskQueue, type EnqueueResult } from '../../triggers/queue'
import { extractJsonObject } from '../extraction/fuzzy'

/** The §8 background task kind this agent handles. */
export const GRAPH_CLEANUP_TASK_KIND = 'graph-cleanup'

/** The proposer stamped on every staged dedupe-merge row this agent creates. */
export const GRAPH_CLEANUP_PROPOSER = 'agent:graph-cleanup'

/** The §2.2 role the near-duplicate judge routes through. */
const JUDGE_ROLE = 'cleanup.dedupeJudge' as const

/**
 * The one ProviderRouter capability the near judge needs — structural (Pick),
 * the same idiom reads/reasoningRoles.ts uses for its resolve-only dep. Boot
 * passes the real ProviderRouter (assignable); a test passes a plain
 * `{ complete }` fake. Faithful to the "router?: ProviderRouter" contract since
 * a ProviderRouter satisfies it.
 */
export type DedupeJudgeRouter = Pick<ProviderRouter, 'complete'>

export interface GraphCleanupDeps {
  readonly engine: StorageEngine
  readonly db: BetterSqlite3.Database
  /** Absent ⇒ near groups are not judged (only exact duplicates are staged). */
  readonly router?: DedupeJudgeRouter
}

/** What a graph-cleanup enqueue / payload carries (all optional — see scanDuplicates). */
export interface GraphCleanupOptions {
  /** Which slice of memory to scan (default 'recent'). */
  readonly scope?: DedupeScope
  /** scope==='count': newest-N budget (default DEDUPE_COUNT_DEFAULT). */
  readonly count?: number
  /** Near-duplicate cosine floor (default DEDUPE_SIMILARITY_DEFAULT, inside scanDuplicates). */
  readonly threshold?: number
  /** Restrict the scan to these labels (default: every DEDUPE_LABELS). */
  readonly labels?: readonly string[]
}

export interface RunGraphCleanupOptions extends GraphCleanupOptions {
  /** Spend/usage key for the judge's router.complete (defaults to the task kind). */
  readonly taskId?: string
  /** Cooperative cancel — threaded to scanDuplicates and checked between judgments. */
  readonly signal?: AbortSignal
  /**
   * Test seam: cap the LLM judgments below GRAPH_CLEANUP_MAX_LLM_JUDGMENTS (the
   * production default) — the same override-a-config-default idiom scanDuplicates
   * exposes for its per-label caps. Never set in normal operation.
   */
  readonly maxJudgments?: number
}

export interface GraphCleanupResult {
  /** Exact-duplicate groups staged as dedupe-merge proposals. */
  readonly stagedExact: number
  /** Near groups the LLM judged the SAME, staged as dedupe-merge proposals. */
  readonly stagedAiConfirmed: number
  /** Near groups the LLM judged DISTINCT — not staged. */
  readonly aiRejected: number
  /** Groups already covered by a pending dedupe-merge row — skipped (no duplicate). */
  readonly skippedAlreadyStaged: number
  /** Groups a member of which vanished before staging (NOT_FOUND) — skipped. */
  readonly vanished: number
  /** Skill / Project duplicate groups — report-only, never staged. */
  readonly reportOnly: number
  /** Near groups whose judge call threw — counted, run continues. */
  readonly judgeErrors: number
  /** True when a near group was skipped because no router was injected. */
  readonly judgeUnavailable: boolean
  /** True when the LLM-judgment cap bit — some near groups were left for next run. */
  readonly judgmentsTruncated: boolean
  /** True when the underlying scan itself hit a per-label / ceiling cap. */
  readonly scanTruncated: boolean
  /** Honest one-line summary (the queue's { note } convention). */
  readonly note: string
}

// ── near-judge full-text render (a deliberate MIRROR of memory/dedupe.ts) ─────
//
// DEDUPE_RENDER (memory/dedupe.ts, owned by another agent this stage) governs the
// scan's exact-key/display; the scan's `display` is TRUNCATED (~140 chars) for the
// UI, but the judge needs the WHOLE text to decide sameness, so we re-fetch the
// source columns here. This tiny per-label map duplicates that file's column
// choices on purpose (recorded as a deviation — the module is not being edited
// this stage). Only Preference/Knowledge ever reach the judge (Skill/Project near
// groups are report-only and filtered before judging), but all four retrievable
// labels are mapped so the mirror stays faithful and total.
const CLEANUP_FULLTEXT: Readonly<
  Record<string, { readonly columns: readonly string[]; readonly render: (get: (column: string) => string) => string }>
> = {
  Project: { columns: ['name', 'summary'], render: (g) => [g('name'), g('summary')].filter((s) => s !== '').join(' — ') },
  Skill: { columns: ['name', 'instructions'], render: (g) => [g('name'), g('instructions')].filter((s) => s !== '').join('\n\n') },
  Preference: { columns: ['statement'], render: (g) => g('statement') },
  Knowledge: { columns: ['content'], render: (g) => g('content') }
}

/** Constrained-decoding schema for the judge (schema-bound output is load-bearing for qwen3 — phase-08 finding). */
const JUDGE_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    same: { type: 'boolean' },
    keep_id: { type: 'string' },
    reason: { type: 'string' }
  },
  required: ['same', 'reason']
}

const JUDGE_SYSTEM_PROMPT =
  'You are a memory de-duplication judge for a personal knowledge graph. You are given two or more stored ' +
  'memory items of the same kind that were flagged as near-duplicates. Decide whether they are TRULY THE SAME ' +
  'memory — duplicates that should be merged into one — or DISTINCT memories that must be kept separate. Merge ' +
  'ONLY when they clearly say the same thing; when in doubt, keep them separate. Respond with ONLY JSON: ' +
  '{"same": boolean, "keep_id": string, "reason": string} — keep_id is the id of the item to keep, reason a short phrase.'

async function fetchFullText(engine: StorageEngine, label: string, id: string): Promise<string | null> {
  const spec = CLEANUP_FULLTEXT[label]
  if (spec === undefined) return null
  const cols = spec.columns.map((c) => `n.${c} AS ${c}`).join(', ')
  const rows = await engine.cypher(`MATCH (n:${label} {id: $id}) RETURN ${cols} LIMIT 1`, { id })
  const row = rows[0]
  if (row === undefined) return null
  const get = (c: string): string => {
    const v = row[c]
    return typeof v === 'string' ? v : ''
  }
  return spec.render(get)
}

/** The judge's verdict for a near group, or null when it declined to merge. */
interface JudgeVerdict {
  readonly keepId: string
  readonly reason: string
}

/**
 * Ask the local LLM whether a near group is truly one memory. Returns the keeper
 * + a short reason when SAME (keep_id honored only when it is one of the group's
 * ids, else falls back to suggestedKeepId), or null when DISTINCT. Throws on a
 * transport failure or an unparseable/malformed verdict — the caller counts it as
 * a judge error and moves on.
 */
async function judgeNearGroup(
  router: DedupeJudgeRouter,
  engine: StorageEngine,
  group: DuplicateGroup,
  taskId: string
): Promise<JudgeVerdict | null> {
  const lines: string[] = []
  for (const node of group.nodes) {
    const text = (await fetchFullText(engine, group.label, node.id)) ?? node.display
    lines.push(`[${node.id}] ${text.replace(/\s+/g, ' ').trim()}`)
  }
  const pct = group.similarity !== undefined ? Math.round(group.similarity * 100) : null
  const prompt =
    `These ${group.label} memory items were flagged as near-duplicates${pct !== null ? ` (about ${pct}% similar)` : ''}:\n` +
    `${lines.join('\n')}\n\n` +
    'Are they the same memory? If so, which id should be kept?'

  const result = await router.complete(JUDGE_ROLE, {
    prompt,
    system: JUDGE_SYSTEM_PROMPT,
    maxTokens: GRAPH_CLEANUP_JUDGE_MAX_TOKENS,
    temperature: 0,
    schema: JUDGE_SCHEMA,
    taskId
  })

  const parsed = extractJsonObject(result.text)
  if (parsed === null || typeof parsed['same'] !== 'boolean') {
    throw new Error(`unparseable dedupe-judge verdict for ${group.label} group`)
  }
  if (!parsed['same']) return null

  const ids = new Set(group.nodes.map((n) => n.id))
  const keepIdRaw = parsed['keep_id']
  const keepId = typeof keepIdRaw === 'string' && ids.has(keepIdRaw) ? keepIdRaw : group.suggestedKeepId
  const reasonRaw = parsed['reason']
  const reason = typeof reasonRaw === 'string' && reasonRaw.trim() !== '' ? reasonRaw.trim() : 'similar wording'
  return { keepId, reason }
}

/**
 * Validate a proposed merge (planDedupeMerge — resolves keeper/removal displays
 * pre-lane) and stage a 'dedupe-merge' row. Returns 'staged' or 'vanished' (a
 * member disappeared since the scan → NOT_FOUND). An unsupported label / keeper
 * ∈ removeIds is structurally impossible here (labels are pre-filtered, removeIds
 * excludes the keeper), so an INVALID_INPUT surfaces as a real bug.
 */
async function stageMerge(
  deps: GraphCleanupDeps,
  label: string,
  keepId: string,
  removeIds: readonly string[],
  rationale: string
): Promise<'staged' | 'vanished'> {
  let plan: DedupeMergePlan
  try {
    plan = await planDedupeMerge({ engine: deps.engine }, { label, keepId, removeIds })
  } catch (err) {
    if (err instanceof MemoryEditError && err.code === 'NOT_FOUND') return 'vanished'
    throw err
  }
  const payload: DedupeMergePayload = {
    label: plan.label,
    keepId: plan.keepId,
    removeIds: plan.removals.map((r) => r.id),
    keepDisplay: plan.keepDisplay,
    displays: plan.removals.map((r) => ({ id: r.id, display: r.display })),
    rationale
  }
  stageDedupeMerge(deps.db, GRAPH_CLEANUP_PROPOSER, payload)
  return 'staged'
}

/**
 * Ids already covered by a PENDING dedupe-merge row (kind 'dedupe-merge', status
 * 'staged'), bucketed per label. A scan group any member of which appears here is
 * already awaiting review, so the agent skips it rather than stacking a duplicate
 * proposal. Node ids are unique only within a label table, so this is keyed by label.
 */
function pendingCoverageByLabel(db: BetterSqlite3.Database): Map<string, Set<string>> {
  const rows = db
    .prepare(`SELECT payload_json FROM staged_writes WHERE kind = ? AND status = 'staged'`)
    .all(DEDUPE_MERGE_STAGED_KIND) as { payload_json: string }[]
  const byLabel = new Map<string, Set<string>>()
  for (const row of rows) {
    try {
      const payload = decodeDedupeMergePayload(JSON.parse(row.payload_json) as Record<string, unknown>, 'pending coverage')
      const set = byLabel.get(payload.label) ?? new Set<string>()
      set.add(payload.keepId)
      for (const id of payload.removeIds) set.add(id)
      byLabel.set(payload.label, set)
    } catch {
      // A malformed pending row cannot cover a fresh group — ignore it.
    }
  }
  return byLabel
}

/**
 * Run one graph-cleanup pass over the duplicate scan: stage exact groups, judge
 * near groups with the local LLM (when a router is present), and skip anything
 * already awaiting review. Read-of-the-graph + write-to-staging only — the graph
 * is never mutated here (§21 rule 6). Returns honest counts + a one-line note.
 */
export async function runGraphCleanup(
  deps: GraphCleanupDeps,
  options: RunGraphCleanupOptions = {}
): Promise<GraphCleanupResult> {
  const taskId = options.taskId ?? GRAPH_CLEANUP_TASK_KIND
  const maxJudgments = Math.max(0, Math.trunc(options.maxJudgments ?? GRAPH_CLEANUP_MAX_LLM_JUDGMENTS))
  const scope: DedupeScope = options.scope ?? 'recent'

  const scanOptions: ScanDuplicatesOptions = {
    scope,
    near: true,
    ...(options.labels !== undefined ? { labels: options.labels } : {}),
    ...(options.threshold !== undefined ? { threshold: options.threshold } : {}),
    // 'recent' is deliberately SELF-CONTAINED: a fresh cutoff of now −
    // DEDUPE_RECENT_DEFAULT_WINDOW_MS, NOT the dashboard scan controller's stored
    // watermark (recorded decision — the two schedulers must not fight over one
    // watermark; the background cleanup owns its own window).
    ...(scope === 'recent'
      ? { sinceUpdatedAtIso: new Date(Date.now() - DEDUPE_RECENT_DEFAULT_WINDOW_MS).toISOString() }
      : {}),
    ...(scope === 'count' ? { count: options.count ?? DEDUPE_COUNT_DEFAULT } : {}),
    ...(options.signal !== undefined ? { signal: options.signal } : {})
  }

  const scan = await scanDuplicates({ engine: deps.engine }, scanOptions)
  const coverage = pendingCoverageByLabel(deps.db)
  const mergeable = new Set<string>(DEDUPE_MERGE_LABELS)

  let stagedExact = 0
  let stagedAiConfirmed = 0
  let aiRejected = 0
  let skippedAlreadyStaged = 0
  let vanished = 0
  let reportOnly = 0
  let judgeErrors = 0
  let judgeUnavailable = false
  let judgmentsTruncated = false
  let judgmentsUsed = 0

  const markStaged = (label: string, ids: readonly string[]): void => {
    const set = coverage.get(label) ?? new Set<string>()
    for (const id of ids) set.add(id)
    coverage.set(label, set)
  }

  for (const group of scan.groups) {
    if (options.signal?.aborted === true) throw new DedupeScanAbortedError()

    // Skill / Project → report-only (unsafe to auto-merge); never staged.
    if (!mergeable.has(group.label)) {
      reportOnly += 1
      continue
    }

    const memberIds = group.nodes.map((n) => n.id)
    const covered = coverage.get(group.label)
    if (covered !== undefined && memberIds.some((id) => covered.has(id))) {
      skippedAlreadyStaged += 1
      continue
    }

    const keepId = group.suggestedKeepId
    const removeIds = memberIds.filter((id) => id !== keepId)
    if (removeIds.length === 0) continue // a degenerate one-node group — nothing to merge

    if (group.reason === 'exact') {
      const outcome = await stageMerge(deps, group.label, keepId, removeIds, 'identical wording (exact duplicate)')
      if (outcome === 'staged') {
        stagedExact += 1
        markStaged(group.label, memberIds)
      } else {
        vanished += 1
      }
      continue
    }

    // ── near group: local LLM judge ─────────────────────────────────────────
    if (deps.router === undefined) {
      judgeUnavailable = true
      continue
    }
    if (judgmentsUsed >= maxJudgments) {
      judgmentsTruncated = true
      continue
    }
    judgmentsUsed += 1

    let verdict: JudgeVerdict | null
    try {
      verdict = await judgeNearGroup(deps.router, deps.engine, group, taskId)
    } catch {
      judgeErrors += 1
      continue
    }
    if (verdict === null) {
      aiRejected += 1
      continue
    }

    const pct = group.similarity !== undefined ? Math.round(group.similarity * 100) : null
    const rationale = `AI cleanup: ${verdict.reason}${pct !== null ? ` (~${pct}% similar)` : ''}`
    const judgeRemoveIds = memberIds.filter((id) => id !== verdict.keepId)
    const outcome = await stageMerge(deps, group.label, verdict.keepId, judgeRemoveIds, rationale)
    if (outcome === 'staged') {
      stagedAiConfirmed += 1
      markStaged(group.label, memberIds)
    } else {
      vanished += 1
    }
  }

  const note = buildNote({
    stagedExact,
    stagedAiConfirmed,
    aiRejected,
    skippedAlreadyStaged,
    vanished,
    reportOnly,
    judgeErrors,
    judgeUnavailable,
    judgmentsTruncated,
    scanTruncated: scan.truncated,
    maxJudgments
  })

  return {
    stagedExact,
    stagedAiConfirmed,
    aiRejected,
    skippedAlreadyStaged,
    vanished,
    reportOnly,
    judgeErrors,
    judgeUnavailable,
    judgmentsTruncated,
    scanTruncated: scan.truncated,
    note
  }
}

interface NoteParts {
  readonly stagedExact: number
  readonly stagedAiConfirmed: number
  readonly aiRejected: number
  readonly skippedAlreadyStaged: number
  readonly vanished: number
  readonly reportOnly: number
  readonly judgeErrors: number
  readonly judgeUnavailable: boolean
  readonly judgmentsTruncated: boolean
  readonly scanTruncated: boolean
  readonly maxJudgments: number
}

/** The queue's { note } summary — same honest-reporting convention as registerMaintenanceHandlers. */
function buildNote(p: NoteParts): string {
  const staged = p.stagedExact + p.stagedAiConfirmed
  const parts: string[] = [
    `staged ${staged} proposal${staged === 1 ? '' : 's'} (${p.stagedExact} exact + ${p.stagedAiConfirmed} AI-confirmed)`
  ]
  if (p.aiRejected > 0) parts.push(`${p.aiRejected} judged different`)
  const skips: string[] = []
  if (p.skippedAlreadyStaged > 0) skips.push(`already-staged ${p.skippedAlreadyStaged}`)
  if (p.vanished > 0) skips.push(`vanished ${p.vanished}`)
  if (skips.length > 0) parts.push(`skipped: ${skips.join(', ')}`)
  if (p.reportOnly > 0) parts.push(`${p.reportOnly} report-only (Skill/Project)`)
  if (p.judgeErrors > 0) parts.push(`judge errors ${p.judgeErrors}`)
  if (p.judgeUnavailable) parts.push('AI judge unavailable — staged exact duplicates only')
  if (p.judgmentsTruncated) parts.push(`judgments capped at ${p.maxJudgments} — some near groups left for next run`)
  if (p.scanTruncated) parts.push('scan partial (some nodes exceeded the scan caps)')
  return parts.join('; ')
}

// ── queue wiring (thin — mirrors agents/skills/handler.ts) ────────────────────

/** Read the scan options a graph-cleanup task carries in its payload. */
function decodeGraphCleanupPayload(payload: JsonObject): GraphCleanupOptions {
  const scopeRaw = payload['scope']
  const scope: DedupeScope | undefined =
    scopeRaw === 'recent' || scopeRaw === 'count' || scopeRaw === 'all' ? scopeRaw : undefined
  const count = typeof payload['count'] === 'number' ? payload['count'] : undefined
  const threshold = typeof payload['threshold'] === 'number' ? payload['threshold'] : undefined
  const labelsRaw = payload['labels']
  const labels = Array.isArray(labelsRaw) ? labelsRaw.filter((l): l is string => typeof l === 'string') : undefined
  return {
    ...(scope !== undefined ? { scope } : {}),
    ...(count !== undefined ? { count } : {}),
    ...(threshold !== undefined ? { threshold } : {}),
    ...(labels !== undefined ? { labels } : {})
  }
}

/**
 * Deterministic per-minute task id — the exact shape scheduleFireTaskId
 * (src/main/triggers/schedules.ts) stamps for the §20 schedule slots, replicated
 * locally so this module keeps NO runtime dependency on triggers/schedules
 * (import-cycle hygiene — recorded as a deviation). An overlapping enqueue in the
 * same local minute dedups on this id (the queue's id-dedup), so a burst of "clean
 * up now" requests collapses to one run per minute.
 */
function graphCleanupTaskId(firedAt: Date): string {
  const pad = (n: number): string => String(n).padStart(2, '0')
  const stamp = `${firedAt.getFullYear()}-${pad(firedAt.getMonth() + 1)}-${pad(firedAt.getDate())}T${pad(firedAt.getHours())}${pad(firedAt.getMinutes())}`
  return `${GRAPH_CLEANUP_TASK_KIND}-${stamp}`
}

/**
 * Enqueue a graph-cleanup task (background/maintenance tier). The scan options
 * ride the payload; the per-minute id dedups a burst into one run.
 */
export function enqueueGraphCleanup(queue: DurableTaskQueue, options: GraphCleanupOptions = {}): EnqueueResult {
  const payload: JsonObject = {
    ...(options.scope !== undefined ? { scope: options.scope } : {}),
    ...(options.count !== undefined ? { count: options.count } : {}),
    ...(options.threshold !== undefined ? { threshold: options.threshold } : {}),
    ...(options.labels !== undefined ? { labels: [...options.labels] } : {})
  }
  return queue.enqueue({
    id: graphCleanupTaskId(new Date()),
    kind: GRAPH_CLEANUP_TASK_KIND,
    priority: TASK_PRIORITY.maintenance,
    payload
  })
}

/**
 * Register the 'graph-cleanup' handler on the queue. Decodes the payload, threads
 * the task's cancel signal + taskId, and runs the cleanup pass. A bad `labels`
 * payload (scanDuplicates INVALID_INPUT) can never succeed on retry → surfaced as
 * a TaskFatalError so the queue fails it fast instead of burning the retry round
 * (the agents/skills/handler.ts fatalCode pattern).
 */
export function registerGraphCleanupHandler(queue: DurableTaskQueue, deps: GraphCleanupDeps): void {
  queue.registerHandler(GRAPH_CLEANUP_TASK_KIND, async (payload, ctx) => {
    const options = decodeGraphCleanupPayload(payload)
    try {
      const result = await runGraphCleanup(
        { engine: deps.engine, db: deps.db, ...(deps.router !== undefined ? { router: deps.router } : {}) },
        { ...options, taskId: ctx.taskId, signal: ctx.signal }
      )
      return { note: result.note }
    } catch (err) {
      if (err instanceof MemoryEditError && err.code === 'INVALID_INPUT') {
        throw new TaskFatalError(`graph-cleanup task ${ctx.taskId} cannot succeed: ${err.message}`, { cause: err })
      }
      throw err
    }
  })
}
