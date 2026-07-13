/**
 * Read tools (§12/§4) — the read-only MCP surface: hybrid retrieval + the §4
 * shared reads. NONE mutate. The phase-05 originals (get_context/search_memory/
 * list_skills/get_skill) query directly; the phase-15 additions are thin
 * adapters over `src/main/reads/*` — the SAME functions behind the dashboard's
 * IPC read handlers — so a tool and its panel can never drift.
 *
 * Each handler zod-parses its input via the shared `parse()` helper, calls the
 * owning read function through `ctx`, and returns the plain DTO. The reads
 * module raises domain errors (IngestError/StagedWriteError); `raiseMapped`
 * re-throws them as the matching clean ToolError so §15 error semantics hold.
 * `get_runner_status` (phase-17) reads the runner health cache + latest run; it
 * never spawns claude and reports the disabled/unknown shape on a default install.
 */
import * as z from 'zod'
import { RETRIEVAL_RECENT_EXAMPLES, RUNNER_LIVE_SESSION_MAX_CALLS, SEARCH_MEMORY_MAX_K } from '../../config'
import { RETRIEVABLE_LABELS } from '../../storage'
import { searchMemory } from '../../retrieval'
import { IngestError } from '../../ingest'
import { StagedWriteError } from '../../security'
import { scanDuplicates, DEDUPE_LABELS } from '../../memory'
import { IPC_NODE_LABELS } from '../../../shared/ipc'
import {
  getAppStatus,
  getLocalUsage,
  getNode,
  getPendingWork,
  getSettingsSummary,
  getSkillFull,
  getSkillSignal,
  getStagedWriteRead,
  getTask,
  getTrace,
  getTriggersStatus,
  getUsage,
  listApprovalsRead,
  listAuditLog,
  listInjectionFlags,
  listNodes,
  listSessions,
  listStagedWritesRead,
  listTasks,
  listTraces,
  listWatchedFolders,
  memoryCounts,
  readSession,
  getRunnerStatus
} from '../../reads'
import { ToolError, parse, jsonSchema, type McpToolDef, type ToolContext, type ToolErrorCode } from './shared'

const iso = (value: unknown): string | null =>
  value instanceof Date ? value.toISOString() : value === null || value === undefined ? null : String(value)

/** Re-raise a reads-module domain error as the matching clean ToolError (§15). */
function raiseMapped(err: unknown): never {
  if (err instanceof IngestError || err instanceof StagedWriteError) {
    const code: ToolErrorCode =
      err.code === 'NOT_FOUND' || err.code === 'INVALID_INPUT' || err.code === 'INVALID_STATE' ? err.code : 'INTERNAL'
    throw new ToolError(code, err.message)
  }
  throw err
}

/** A read-tool dependency that boot wires late (setReadContext) — required here. */
function requireCtx<T>(value: T | null | undefined, what: string): T {
  if (value === null || value === undefined) {
    throw new ToolError('INVALID_STATE', `${what} is unavailable this launch`)
  }
  return value
}

// ── Shared input fragments ─────────────────────────────────────────────────────

/** List cap: default 50, hard max 200 (spec §4 read-tool convention). */
const LIST_LIMIT = z.number().int().min(1).max(200).optional()
const DEFAULT_LIST_LIMIT = 50
const NO_INPUT = z.object({})
const STAGED_STATUSES = ['staged', 'approved', 'rejected', 'committed'] as const
const APPROVAL_STATUSES = ['pending', 'approved', 'denied'] as const
const AUDIT_KINDS = ['action', 'graph-write', 'file-write', 'file-delete', 'undo'] as const

// ── Schemas (zod is the validator; JSON Schema for tools/list derives from it) ──

const GetContextInput = z.object({
  task: z.string().min(1).describe('The task or question to assemble context for.'),
  tags: z.array(z.string()).optional().describe('Tag names to scope preferences (e.g. ["database"]).')
})

const SearchMemoryInput = z.object({
  query: z.string().min(1).describe('Search query.'),
  labels: z
    .array(z.enum(RETRIEVABLE_LABELS))
    .optional()
    .describe('Restrict to these retrievable labels; default all four.'),
  k: z
    .number()
    .int()
    .min(1)
    .max(SEARCH_MEMORY_MAX_K)
    .optional()
    .describe(`Number of results (default 8, max ${SEARCH_MEMORY_MAX_K}).`)
})

const ListSkillsInput = z.object({})

const GetSkillInput = z.object({
  name: z.string().min(1).describe('Exact skill name (list_skills shows what exists).')
})

const ListSessionsInput = z.object({
  limit: LIST_LIMIT.describe('Max sessions, newest-active first (default 50, max 200).')
})

const ReadSessionInput = z.object({
  session_id: z.string().min(1).describe('The MCP session id (list_sessions shows them).'),
  page: z.number().int().min(0).optional().describe('0-based transcript page (chunked; default 0).')
})

const GetSkillFullInput = z.object({
  id: z.string().min(1).describe('Skill id (list_skills / search_memory return ids).')
})

const GetSkillSignalInput = z.object({
  skill_id: z.string().min(1).describe('Skill id to read the §17/§20 event-gate signal for.')
})

const ListNodesInput = z.object({
  label: z.enum(IPC_NODE_LABELS).describe('Node label to page (e.g. "Skill", "Preference").'),
  limit: LIST_LIMIT.describe('Page size (default 50, max 200).'),
  offset: z.number().int().min(0).optional().describe('Rows to skip (default 0).')
})

const GetNodeInput = z.object({
  label: z.enum(IPC_NODE_LABELS).describe('The node label.'),
  id: z.string().min(1).describe('The node id.')
})

/** Groups shipped per list_duplicate_memories reply (the rest are counted). */
const DUPLICATE_GROUPS_REPLY_CAP = 50

const ListDuplicateMemoriesInput = z.object({
  labels: z
    .array(z.enum(DEDUPE_LABELS))
    .optional()
    .describe('Restrict to these labels; default all of Project, Skill, Preference, Knowledge, Tag.'),
  threshold: z
    .number()
    .min(0)
    .max(1)
    .optional()
    .describe('Near-duplicate cosine floor (default 0.95); exact-text/name duplicates are always included.')
})

const ListStagedWritesInput = z.object({
  status: z.enum(STAGED_STATUSES).optional().describe('Filter by review status (default all).'),
  proposed_by_me: z.boolean().optional().describe('Only rows THIS MCP session staged.')
})

const GetStagedWriteInput = z.object({
  id: z.string().min(1).describe('Staged-write id (list_staged_writes shows them).'),
  include_diff: z.boolean().optional().describe('Also render the §13 approval diff.')
})

const ListApprovalsInput = z.object({
  status: z.enum(APPROVAL_STATUSES).optional().describe('Filter by decision status (default all).')
})

const ListAuditLogInput = z.object({
  kind: z.enum(AUDIT_KINDS).optional().describe('Filter by action kind.'),
  agent_id: z.string().min(1).optional().describe('Filter by the acting agent id.')
})

const ListTracesInput = z.object({
  limit: LIST_LIMIT.describe('Max traces, newest first (default 50, max 200).')
})

const GetTraceInput = z.object({
  trace_id: z.string().min(1).describe('Trace id (list_traces shows them).')
})

const GetTaskInput = z.object({
  id: z.string().min(1).describe('Task id (list_tasks shows them).'),
  include_workflow: z.boolean().optional().describe('Also fetch the `<taskId>-wf` workflow job state.')
})

const GetLocalUsageInput = z.object({
  since_days: z
    .number()
    .int()
    .min(1)
    .max(365)
    .optional()
    .describe('Window in days for totals/byRole/byDay (default 30; recent + live snapshot ignore it).')
})

// ── Handlers ─────────────────────────────────────────────────────────────────

async function getContext(args: unknown, ctx: ToolContext): Promise<unknown> {
  const input = parse(GetContextInput, args, 'get_context')
  // P0.2 live read-path budget: meter get_context CALLS against the live session
  // ceiling. On a default install `runner_runs` is empty ⇒ CallBudget returns 0
  // ⇒ the guard never trips ⇒ identical to today; it only bites once subscription
  // spawns record runs under this `live:<sid>` task.
  const bundle = await ctx.retriever.retrieve(
    input.task,
    input.tags ?? [],
    ctx.spendMeter
      ? { spendMeter: ctx.spendMeter, taskId: `live:${ctx.sessionId}`, ceilingUsd: RUNNER_LIVE_SESSION_MAX_CALLS }
      : {}
  )
  const item = (i: { id: string; label: string; text: string; rerankScore: number | null }): unknown => ({
    id: i.id,
    label: i.label,
    text: i.text,
    rerankScore: i.rerankScore
  })
  return {
    task: bundle.task,
    confidence: bundle.confidence,
    iterations: bundle.iterations,
    criticScore: bundle.criticScore,
    haltReason: bundle.haltReason,
    totalTokens: bundle.totalTokens,
    globalPreferences: bundle.globalPreferences.map(item),
    items: bundle.items.map(item)
  }
}

async function searchMemoryTool(args: unknown, ctx: ToolContext): Promise<unknown> {
  const input = parse(SearchMemoryInput, args, 'search_memory')
  const hits = await searchMemory(ctx.retrieval, input.query, {
    ...(input.labels !== undefined ? { labels: input.labels } : {}),
    ...(input.k !== undefined ? { k: input.k } : {})
  })
  return {
    query: input.query,
    hits: hits.map((h) => ({ id: h.id, label: h.label, text: h.text, rerankScore: h.rerankScore }))
  }
}

async function listSkills(args: unknown, ctx: ToolContext): Promise<unknown> {
  parse(ListSkillsInput, args, 'list_skills')
  const rows = await ctx.engine.cypher(
    'MATCH (s:Skill) RETURN s.id AS id, s.name AS name, s.current_version AS current_version ORDER BY s.name'
  )
  return {
    skills: rows.map((r) => ({
      id: String(r['id']),
      name: String(r['name']),
      currentVersion: r['current_version'] === null || r['current_version'] === undefined ? null : String(r['current_version'])
    }))
  }
}

async function getSkill(args: unknown, ctx: ToolContext): Promise<unknown> {
  const input = parse(GetSkillInput, args, 'get_skill')
  const skillRows = await ctx.engine.cypher(
    'MATCH (s:Skill) WHERE s.name = $name RETURN s.id AS id, s.name AS name, s.instructions AS instructions',
    { name: input.name }
  )
  const skill = skillRows[0]
  if (!skill) {
    throw new ToolError('NOT_FOUND', `skill '${input.name}' not found — call list_skills to see available skills`)
  }
  const skillId = String(skill['id'])
  const [versionRows, exampleRows] = await Promise.all([
    ctx.engine.cypher(
      `MATCH (s:Skill {id: $id})-[:HAS_VERSION]->(v:SkillVersion) WHERE v.status = 'active'
       RETURN v.id AS id, v.instructions AS instructions, v.benchmark_score AS benchmark_score, v.created_at AS created_at
       ORDER BY v.created_at DESC, v.id LIMIT 1`,
      { id: skillId }
    ),
    ctx.engine.cypher(
      `MATCH (s:Skill {id: $id})-[:HAS_EXAMPLE]->(e:Example)
       RETURN e.id AS id, e.kind AS kind, e.content AS content, e.created_at AS created_at
       ORDER BY e.created_at DESC, e.id LIMIT ${RETRIEVAL_RECENT_EXAMPLES}`,
      { id: skillId }
    )
  ])
  const version = versionRows[0]
  return {
    id: skillId,
    name: String(skill['name']),
    instructions: skill['instructions'] === null || skill['instructions'] === undefined ? null : String(skill['instructions']),
    activeVersion: version
      ? {
          id: String(version['id']),
          instructions: String(version['instructions'] ?? ''),
          benchmarkScore: typeof version['benchmark_score'] === 'number' ? version['benchmark_score'] : null
        }
      : null,
    recentExamples: exampleRows.map((r) => ({
      id: String(r['id']),
      kind: String(r['kind'] ?? ''),
      content: String(r['content'] ?? ''),
      createdAt: iso(r['created_at'])
    }))
  }
}

// ── §4.A session / extraction ──────────────────────────────────────────────────

async function listSessionsTool(args: unknown, ctx: ToolContext): Promise<unknown> {
  const input = parse(ListSessionsInput, args, 'list_sessions')
  const sessions = await listSessions({ db: ctx.db, engine: ctx.engine }, { limit: input.limit ?? DEFAULT_LIST_LIMIT })
  return { sessions }
}

async function readSessionTool(args: unknown, ctx: ToolContext): Promise<unknown> {
  const input = parse(ReadSessionInput, args, 'read_session')
  // The transcript path is resolved SERVER-SIDE from the extract-<sid> task —
  // never from caller input (no arbitrary-file read; §21 rule 5).
  return readSession(
    { db: ctx.db },
    { sessionId: input.session_id, ...(input.page !== undefined ? { page: input.page } : {}) }
  )
}

async function getPendingWorkTool(args: unknown, ctx: ToolContext): Promise<unknown> {
  parse(NO_INPUT, args, 'get_pending_work')
  const permissions = requireCtx(ctx.permissions, 'the permission engine')
  return getPendingWork({ db: ctx.db, engine: ctx.engine, permissions })
}

// ── §4.B skills ─────────────────────────────────────────────────────────────────

async function getSkillFullTool(args: unknown, ctx: ToolContext): Promise<unknown> {
  const input = parse(GetSkillFullInput, args, 'get_skill_full')
  try {
    return await getSkillFull({ engine: ctx.engine, db: ctx.db }, { id: input.id })
  } catch (err) {
    return raiseMapped(err)
  }
}

async function getSkillSignalTool(args: unknown, ctx: ToolContext): Promise<unknown> {
  const input = parse(GetSkillSignalInput, args, 'get_skill_signal')
  return getSkillSignal({ engine: ctx.engine, db: ctx.db }, { skillId: input.skill_id })
}

// ── §4.C memory ─────────────────────────────────────────────────────────────────

async function memoryCountsTool(args: unknown, ctx: ToolContext): Promise<unknown> {
  parse(NO_INPUT, args, 'memory_counts')
  return { counts: await memoryCounts(ctx.engine) }
}

async function listNodesTool(args: unknown, ctx: ToolContext): Promise<unknown> {
  const input = parse(ListNodesInput, args, 'list_nodes')
  const { rows, total } = await listNodes(ctx.engine, {
    label: input.label,
    limit: input.limit ?? DEFAULT_LIST_LIMIT,
    offset: input.offset ?? 0
  })
  return { nodes: rows, total }
}

async function getNodeTool(args: unknown, ctx: ToolContext): Promise<unknown> {
  const input = parse(GetNodeInput, args, 'get_node')
  try {
    return await getNode(ctx.engine, { label: input.label, id: input.id })
  } catch (err) {
    return raiseMapped(err)
  }
}

async function listDuplicateMemoriesTool(args: unknown, ctx: ToolContext): Promise<unknown> {
  const input = parse(ListDuplicateMemoriesInput, args, 'list_duplicate_memories')
  const { groups, truncated } = await scanDuplicates(
    { engine: ctx.engine },
    {
      ...(input.labels !== undefined ? { labels: input.labels } : {}),
      ...(input.threshold !== undefined ? { threshold: input.threshold } : {})
    }
  )
  // Cap the shipped groups like the other list tools; the full count rides along.
  return { groups: groups.slice(0, DUPLICATE_GROUPS_REPLY_CAP), groupsTotal: groups.length, truncated }
}

// ── §4.D review / observability ─────────────────────────────────────────────────

async function listStagedWritesTool(args: unknown, ctx: ToolContext): Promise<unknown> {
  const input = parse(ListStagedWritesInput, args, 'list_staged_writes')
  const proposedBy = input.proposed_by_me === true ? `claude-mcp:${ctx.sessionId}` : undefined
  return {
    stagedWrites: listStagedWritesRead(ctx.db, {
      ...(input.status !== undefined ? { status: input.status } : {}),
      ...(proposedBy !== undefined ? { proposedBy } : {})
    })
  }
}

async function getStagedWriteTool(args: unknown, ctx: ToolContext): Promise<unknown> {
  const input = parse(GetStagedWriteInput, args, 'get_staged_write')
  try {
    return await getStagedWriteRead(
      { db: ctx.db, engine: ctx.engine },
      { id: input.id, ...(input.include_diff !== undefined ? { includeDiff: input.include_diff } : {}) }
    )
  } catch (err) {
    return raiseMapped(err)
  }
}

async function listApprovalsTool(args: unknown, ctx: ToolContext): Promise<unknown> {
  const input = parse(ListApprovalsInput, args, 'list_approvals')
  const permissions = requireCtx(ctx.permissions, 'the permission engine')
  return { approvals: listApprovalsRead(permissions, input.status !== undefined ? { status: input.status } : {}) }
}

async function listInjectionFlagsTool(args: unknown, ctx: ToolContext): Promise<unknown> {
  parse(NO_INPUT, args, 'list_injection_flags')
  return { flags: listInjectionFlags(ctx.db) }
}

async function listAuditLogTool(args: unknown, ctx: ToolContext): Promise<unknown> {
  const input = parse(ListAuditLogInput, args, 'list_audit_log')
  const audit = requireCtx(ctx.audit, 'the audit log')
  return {
    actions: listAuditLog(audit, {
      ...(input.kind !== undefined ? { kind: input.kind } : {}),
      ...(input.agent_id !== undefined ? { agentId: input.agent_id } : {})
    })
  }
}

async function listTracesTool(args: unknown, ctx: ToolContext): Promise<unknown> {
  const input = parse(ListTracesInput, args, 'list_traces')
  return { traces: listTraces(ctx.db, { limit: input.limit ?? DEFAULT_LIST_LIMIT }) }
}

async function getTraceTool(args: unknown, ctx: ToolContext): Promise<unknown> {
  const input = parse(GetTraceInput, args, 'get_trace')
  return { spans: getTrace(ctx.db, { traceId: input.trace_id }) }
}

async function getUsageTool(args: unknown, ctx: ToolContext): Promise<unknown> {
  parse(NO_INPUT, args, 'get_usage')
  return getUsage(ctx.db)
}

async function getLocalUsageTool(args: unknown, ctx: ToolContext): Promise<unknown> {
  const input = parse(GetLocalUsageInput, args, 'get_local_usage')
  // ctx.ollama (status + ps) is present only once the model layer is wired; absent
  // ⇒ the DB-only aggregation still returns, with an empty live snapshot.
  return getLocalUsage(
    { db: ctx.db, ollama: ctx.ollama ?? null },
    input.since_days !== undefined ? { sinceDays: input.since_days } : {}
  )
}

// ── §4.E tasks / triggers ────────────────────────────────────────────────────────

async function listTasksTool(args: unknown, ctx: ToolContext): Promise<unknown> {
  parse(NO_INPUT, args, 'list_tasks')
  return { tasks: listTasks(ctx.db) }
}

async function getTaskTool(args: unknown, ctx: ToolContext): Promise<unknown> {
  const input = parse(GetTaskInput, args, 'get_task')
  const task = await getTask(
    { db: ctx.db, ...(ctx.runner !== undefined ? { runner: ctx.runner } : {}) },
    { id: input.id, ...(input.include_workflow !== undefined ? { includeWorkflow: input.include_workflow } : {}) }
  )
  if (task === null) throw new ToolError('NOT_FOUND', `task '${input.id}' not found — call list_tasks to see what exists`)
  return task
}

async function getTriggersStatusTool(args: unknown, ctx: ToolContext): Promise<unknown> {
  parse(NO_INPUT, args, 'get_triggers_status')
  return getTriggersStatus({ triggers: ctx.triggers ?? null })
}

async function listWatchedFoldersTool(args: unknown, ctx: ToolContext): Promise<unknown> {
  parse(NO_INPUT, args, 'list_watched_folders')
  const store = requireCtx(ctx.watchedFolders, 'the watched-folder store')
  return { folders: listWatchedFolders(store) }
}

// ── §4.F status ──────────────────────────────────────────────────────────────────

async function getAppStatusTool(args: unknown, ctx: ToolContext): Promise<unknown> {
  parse(NO_INPUT, args, 'get_app_status')
  const appStatus = requireCtx(ctx.appStatus, 'app status')
  return getAppStatus({ ...appStatus, ollama: ctx.ollama ?? null })
}

async function getSettingsSummaryTool(args: unknown, ctx: ToolContext): Promise<unknown> {
  parse(NO_INPUT, args, 'get_settings_summary')
  const appStatus = requireCtx(ctx.appStatus, 'app status')
  return getSettingsSummary({ userDataDir: appStatus.userDataDir, keychain: ctx.keychain ?? null })
}

async function getRunnerStatusTool(args: unknown, ctx: ToolContext): Promise<unknown> {
  parse(NO_INPUT, args, 'get_runner_status')
  // Read-only + always answerable: an absent runner (didn't boot / off) yields
  // the disabled/unknown shape rather than an error — the runner being off is
  // the normal default, not a fault. The router (when wired) resolves the
  // effective backend a subscription-eligible role lands on while falling back.
  return getRunnerStatus({ runner: ctx.runnerStatus ?? null, db: ctx.db, router: ctx.router ?? null })
}

export const READ_TOOL_DEFS: readonly McpToolDef[] = [
  {
    name: 'get_context',
    description:
      'Assemble the best context bundle for a task: full hybrid retrieval (vector + keyword + graph expansion, reranked) wrapped in the bounded self-correcting loop. Returns bundle items plus always-included global preferences and loop provenance (confidence, iterations, halt reason).',
    inputSchema: jsonSchema(GetContextInput),
    handle: getContext
  },
  {
    name: 'search_memory',
    description:
      'Direct hybrid search (vector + keyword, fused, reranked) over the retrievable memory nodes (Project, Skill, Preference, Knowledge). No graph expansion, no loop — fast lookups.',
    inputSchema: jsonSchema(SearchMemoryInput),
    handle: searchMemoryTool
  },
  {
    name: 'list_skills',
    description: 'List all saved skills (id, name, current version pointer).',
    inputSchema: jsonSchema(ListSkillsInput),
    handle: listSkills
  },
  {
    name: 'get_skill',
    description:
      'Fetch one skill by exact name: its instructions, the active SkillVersion body, and the most recent examples.',
    inputSchema: jsonSchema(GetSkillInput),
    handle: getSkill
  },
  {
    name: 'list_sessions',
    description:
      'List MCP sessions with their call rollup and extraction disposition (extracted / pending); runner-only sessions never count as pending.',
    inputSchema: jsonSchema(ListSessionsInput),
    handle: listSessionsTool
  },
  {
    name: 'read_session',
    description:
      'Read one session: its call log plus the untrusted transcript (path resolved SERVER-SIDE from the extraction task, never caller input) with a regex injection scan, paged.',
    inputSchema: jsonSchema(ReadSessionInput),
    handle: readSessionTool
  },
  {
    name: 'get_pending_work',
    description:
      'Everything awaiting attention in one read: quiet sessions, skills with new event-gate signal, open drift watches, staged writes, and pending approvals.',
    inputSchema: jsonSchema(NO_INPUT),
    handle: getPendingWorkTool
  },
  {
    name: 'get_skill_full',
    description:
      'Full detail for one skill by id: versions, examples, corrections, plus the improvement ledger (settings, history, rollback availability).',
    inputSchema: jsonSchema(GetSkillFullInput),
    handle: getSkillFullTool
  },
  {
    name: 'get_skill_signal',
    description:
      'The read-only §17/§20 event-gate signal for one skill: new corrections / failure examples since its cursor, and whether a stylistic candidate is already pending review.',
    inputSchema: jsonSchema(GetSkillSignalInput),
    handle: getSkillSignalTool
  },
  {
    name: 'memory_counts',
    description: 'Per-label node counts across the whole graph (the memory browser rail totals).',
    inputSchema: jsonSchema(NO_INPUT),
    handle: memoryCountsTool
  },
  {
    name: 'list_nodes',
    description: 'Page the nodes of one label (display projection + total); the embedding vector is never shipped.',
    inputSchema: jsonSchema(ListNodesInput),
    handle: listNodesTool
  },
  {
    name: 'get_node',
    description: 'Inspector detail for one node: its properties (no embedding) plus the typed incoming/outgoing neighborhood.',
    inputSchema: jsonSchema(GetNodeInput),
    handle: getNodeTool
  },
  {
    name: 'list_duplicate_memories',
    description:
      'Find duplicate memory GROUPS across Project/Skill/Preference/Knowledge/Tag: exact (normalized text/name equality) and near (embedding cosine ≥ threshold, default 0.95). Read-only — each group reports its members (with edge counts) and a suggested keeper (most-connected, tie → newest). Merge with propose_dedupe_merge (staged for review).',
    inputSchema: jsonSchema(ListDuplicateMemoriesInput),
    handle: listDuplicateMemoriesTool
  },
  {
    name: 'list_staged_writes',
    description:
      'List review-queue staged writes (optionally by status, or only rows this session proposed).',
    inputSchema: jsonSchema(ListStagedWritesInput),
    handle: listStagedWritesTool
  },
  {
    name: 'get_staged_write',
    description: 'One staged write by id, optionally with the rendered §13 approval diff.',
    inputSchema: jsonSchema(GetStagedWriteInput),
    handle: getStagedWriteTool
  },
  {
    name: 'list_approvals',
    description: 'List §13 approval requests (optionally by decision status).',
    inputSchema: jsonSchema(ListApprovalsInput),
    handle: listApprovalsTool
  },
  {
    name: 'list_injection_flags',
    description: 'List the injection-scan findings (prompt-injection detections over ingested/transcript content), newest first.',
    inputSchema: jsonSchema(NO_INPUT),
    handle: listInjectionFlagsTool
  },
  {
    name: 'list_audit_log',
    description: 'The audit/undo timeline of reversible agent actions, newest first (optionally by kind or agent).',
    inputSchema: jsonSchema(ListAuditLogInput),
    handle: listAuditLogTool
  },
  {
    name: 'list_traces',
    description: 'Recent execution traces (per-trace rollups: root span, duration, error count), newest first.',
    inputSchema: jsonSchema(ListTracesInput),
    handle: listTracesTool
  },
  {
    name: 'get_trace',
    description: 'Every span in one trace, ordered for the waterfall view.',
    inputSchema: jsonSchema(GetTraceInput),
    handle: getTraceTool
  },
  {
    name: 'get_usage',
    description:
      'Usage summary: metered cloud spend (real dollars) plus the runner_runs rollup (shadow cost is an estimate; empty until subscription runs exist).',
    inputSchema: jsonSchema(NO_INPUT),
    handle: getUsageTool
  },
  {
    name: 'get_local_usage',
    description:
      'What the LOCAL qwen3 reasoning tier has done (aggregated over since_days, default 30): totals (calls, prompt/eval tokens, compute ms), per-role and per-day breakdowns, the newest 20 calls, plus a live resource snapshot (currently loaded models + daemon state). Search indexing (embeddings) is NOT counted — that tier always runs locally and is out of scope.',
    inputSchema: jsonSchema(GetLocalUsageInput),
    handle: getLocalUsageTool
  },
  {
    name: 'list_tasks',
    description: 'The durable §8 task-queue mirror, newest first.',
    inputSchema: jsonSchema(NO_INPUT),
    handle: listTasksTool
  },
  {
    name: 'get_task',
    description: 'One task by id (payload included), optionally with its `<taskId>-wf` workflow job state.',
    inputSchema: jsonSchema(GetTaskInput),
    handle: getTaskTool
  },
  {
    name: 'get_triggers_status',
    description: 'The phase-11 trigger runtime status: queue counts, schedules, watchers, rule errors, and the session-end hook probe.',
    inputSchema: jsonSchema(NO_INPUT),
    handle: getTriggersStatusTool
  },
  {
    name: 'list_watched_folders',
    description: 'The configured watched folders (name, path, tags, enabled).',
    inputSchema: jsonSchema(NO_INPUT),
    handle: listWatchedFoldersTool
  },
  {
    name: 'get_app_status',
    description: 'App status: version, platform, which subsystems booted, the MCP url, and live Ollama health.',
    inputSchema: jsonSchema(NO_INPUT),
    handle: getAppStatusTool
  },
  {
    name: 'get_settings_summary',
    description:
      'Sanitized model settings: cloud provider, model names, and API-key PRESENCE booleans only — key material never crosses this boundary.',
    inputSchema: jsonSchema(NO_INPUT),
    handle: getSettingsSummaryTool
  },
  {
    name: 'get_runner_status',
    description:
      'Headless subscription-runner status: enabled flag, resolved claude binary path + version, health state (ok / not-installed / auth-expired / quota-exhausted / unknown), last auth-ok time, whether the subscription tier is currently unavailable and falling back (fallbackActive) plus the effective backend reasoning lands on while it does (effectiveBackend: cloud-api / local-qwen3 / null), the latest runner run, and the agent-mode tombstone count. OFF by default — a default install reports enabled:false, fallbackActive:false and never spawns claude.',
    inputSchema: jsonSchema(NO_INPUT),
    handle: getRunnerStatusTool
  }
]
