/**
 * Control tools (§12 + §8 Phase 2) — the sanctioned side-effecting actions an
 * external Claude may trigger. Ingestion runs the §18 write paths; the phase-18
 * tools ENQUEUE §8 tasks (they never run agents inline) so the work rides the
 * scheduler, the audit trail and the §13/§17 gates exactly as a trigger would.
 * The §5 human-gated spine (approve/reject/decide/undo/grant/…) is never here.
 *
 *   ingest_document / ingest_codebase   §18 ingestion write paths
 *   run_extraction                       enqueue extraction for a finished session
 *   improve_skill_now                    enqueue the §17 manual improvement
 *   run_maintenance                      fire a prune / export maintenance job
 *   run_graph_cleanup                    enqueue the §8 duplicate-memory cleanup (stages for review)
 *   retry_task                           re-run a deferred §8 task now
 *   scan_watched_folder                  ingest a configured watched folder now
 */
import * as z from 'zod'
import { TASK_PRIORITY } from '../../config'
import { enqueueGraphCleanup, enqueueManualImprovement } from '../../agents'
import {
  IngestError,
  ingestCodebase,
  ingestDocument,
  scanWatchedFolder,
  type KnowledgeIngestDeps
} from '../../ingest'
import {
  enqueueExtraction,
  scheduleFireTaskId,
  TaskRetryError,
  type DurableTaskQueue
} from '../../triggers'
import { ToolError, parse, jsonSchema, type McpToolDef, type ToolContext } from './shared'

/** The §8 queue is late-bound at bootIpc; absent ⇒ triggers did not boot. */
function requireQueue(ctx: ToolContext, tool: string): DurableTaskQueue {
  if (ctx.queue === undefined) {
    throw new ToolError('INVALID_STATE', `${tool}: the task queue is unavailable this launch — triggers did not boot`)
  }
  return ctx.queue
}

// ── ingest_document / ingest_codebase ──────────────────────────────────────────

const IngestDocumentInput = z.object({
  path_or_content: z.string().min(1).describe('Absolute file path, or the document content itself.'),
  tags: z.array(z.string()).optional().describe('Tag names for the ingested chunks.')
})

const IngestCodebaseInput = z.object({
  path: z.string().min(1).describe('Absolute folder path of the codebase.'),
  project: z.string().optional().describe('Project name to attach components to.')
})

async function ingestDocumentTool(args: unknown, ctx: ToolContext): Promise<unknown> {
  const input = parse(IngestDocumentInput, args, 'ingest_document')
  try {
    // The phase-06 pipeline: chunk → embed (the read path's embedder) → one
    // write-lane job. Content-hash dedup means identical re-adds are no-ops.
    // Phase 09: content rides in as UntrustedText, the §13 scanner flags
    // suspicious docs, and the lane job logs an audited delta.
    return await ingestDocument(
      {
        engine: ctx.engine,
        embedder: ctx.retrieval.embedder,
        ...(ctx.scanner !== undefined ? { scanner: ctx.scanner } : {}),
        ...(ctx.audit !== undefined ? { audit: { log: ctx.audit, agentId: `mcp:${ctx.sessionId}` } } : {})
      },
      input.path_or_content,
      input.tags ?? []
    )
  } catch (err) {
    if (err instanceof IngestError) throw new ToolError(err.code, err.message)
    throw err
  }
}

/** Skip-list entries echoed in the reply (full list stays in the function result). */
const INGEST_CODEBASE_SKIPPED_REPLY_CAP = 50

async function ingestCodebaseTool(args: unknown, ctx: ToolContext): Promise<unknown> {
  const input = parse(IngestCodebaseInput, args, 'ingest_codebase')
  try {
    // The phase-07 pipeline: gitignore walk → Tree-sitter units → Component
    // diff in one write-lane job → README/markdown/docstrings through the
    // phase-06 knowledge pipeline. Per-unit content hashes make re-ingests of
    // unchanged code zero-write no-ops.
    const result = await ingestCodebase(
      {
        engine: ctx.engine,
        embedder: ctx.retrieval.embedder,
        llm: ctx.llm,
        // appdata.db ⇒ the Stage-3 skill-extraction pass stages `skill-import`
        // rows (still human-gated; NO new MCP tool, the runner allowlist is
        // unchanged). The skills block rides through on the spread below.
        db: ctx.db,
        ...(ctx.router !== undefined ? { router: ctx.router } : {}),
        ...(ctx.scanner !== undefined ? { scanner: ctx.scanner } : {}),
        ...(ctx.audit !== undefined ? { audit: { log: ctx.audit, agentId: `mcp:${ctx.sessionId}` } } : {})
      },
      input.path,
      input.project !== undefined ? { project: input.project } : {}
    )
    return {
      ...result,
      skipped: result.skipped.slice(0, INGEST_CODEBASE_SKIPPED_REPLY_CAP),
      skippedTotal: result.skipped.length
    }
  } catch (err) {
    if (err instanceof IngestError) throw new ToolError(err.code, err.message)
    throw err
  }
}

// ── run_extraction ─────────────────────────────────────────────────────────────

const RunExtractionInput = z.object({
  session_id: z.string().min(1).describe('The finished session to extract from.'),
  transcript_path: z.string().min(1).optional().describe('Absolute transcript path, when known.'),
  cwd: z.string().min(1).optional().describe('The session working directory, when known.')
})

async function runExtractionTool(args: unknown, ctx: ToolContext): Promise<unknown> {
  const input = parse(RunExtractionInput, args, 'run_extraction')
  const queue = requireQueue(ctx, 'run_extraction')
  // §6 exactly-once: the deterministic `extract-<sid>` id means a hook/inactivity
  // task already queued for this session dedups (nothing re-run).
  const result = enqueueExtraction(
    queue,
    {
      sessionId: input.session_id,
      ...(input.transcript_path !== undefined ? { transcriptPath: input.transcript_path } : {}),
      ...(input.cwd !== undefined ? { cwd: input.cwd } : {})
    },
    'mcp'
  )
  return {
    scheduled: true,
    taskId: result.taskId,
    deduped: result.deduped,
    note: result.deduped
      ? 'This session is already queued for extraction (exactly-once).'
      : 'Extraction scheduled — it runs through the local/cloud tiers and stages low-confidence items for review.'
  }
}

// ── improve_skill_now ──────────────────────────────────────────────────────────

const ImproveSkillNowInput = z.object({
  skill_id: z.string().min(1).describe('Id of the skill to improve now (bypasses the nightly recency gate).')
})

async function improveSkillNowTool(args: unknown, ctx: ToolContext): Promise<unknown> {
  const input = parse(ImproveSkillNowInput, args, 'improve_skill_now')
  const queue = requireQueue(ctx, 'improve_skill_now')
  // The §17 manual trigger: bypasses recency but still needs SOME signal, and
  // the candidate adopts only through the gate (verifiable) or review (stylistic).
  const result = enqueueManualImprovement(queue, input.skill_id)
  return {
    scheduled: true,
    taskId: result.taskId,
    deduped: result.deduped,
    note: 'Improvement scheduled — the candidate is benchmarked and adopted only through the §17 gate.'
  }
}

// ── run_maintenance ────────────────────────────────────────────────────────────

const RunMaintenanceInput = z.object({
  job: z.enum(['prune', 'export']).describe('Which maintenance job to run: nightly prune or the memory export.')
})

async function runMaintenanceTool(args: unknown, ctx: ToolContext): Promise<unknown> {
  const input = parse(RunMaintenanceInput, args, 'run_maintenance')
  const queue = requireQueue(ctx, 'run_maintenance')
  // The same fire path the §7 schedules use: a per-minute deterministic id so a
  // double-fire in the same minute dedups; the registered maintenance handler runs it.
  const result = queue.enqueue({
    id: scheduleFireTaskId(input.job, new Date()),
    kind: input.job,
    priority: TASK_PRIORITY.maintenance
  })
  return {
    scheduled: true,
    taskId: result.taskId,
    deduped: result.deduped,
    note: `Maintenance job '${input.job}' scheduled (audited, reversible where applicable).`
  }
}

// ── run_graph_cleanup ────────────────────────────────────────────────────────

const RunGraphCleanupInput = z.object({
  scope: z
    .enum(['recent', 'count', 'all'])
    .optional()
    .describe("Which slice of memory to scan (default 'recent' — memories changed in the last 7 days)."),
  count: z
    .number()
    .int()
    .min(1)
    .optional()
    .describe("Only with scope 'count': how many of the newest memories to compare."),
  threshold: z.number().min(0).max(1).optional().describe('Near-duplicate cosine floor (0..1); higher = stricter.'),
  labels: z
    .array(z.string())
    .optional()
    .describe('Restrict the scan to these memory kinds (default: every de-duplicated label).')
})

async function runGraphCleanupTool(args: unknown, ctx: ToolContext): Promise<unknown> {
  const input = parse(RunGraphCleanupInput, args, 'run_graph_cleanup')
  const queue = requireQueue(ctx, 'run_graph_cleanup')
  // Deterministic per-minute id (a same-minute burst dedups); the registered
  // 'graph-cleanup' handler runs the duplicate scan and STAGES merge proposals for
  // review — it never merges directly (§21 rule 6). The scan options ride the payload.
  const result = enqueueGraphCleanup(queue, {
    ...(input.scope !== undefined ? { scope: input.scope } : {}),
    ...(input.count !== undefined ? { count: input.count } : {}),
    ...(input.threshold !== undefined ? { threshold: input.threshold } : {}),
    ...(input.labels !== undefined ? { labels: input.labels } : {})
  })
  return {
    scheduled: true,
    taskId: result.taskId,
    deduped: result.deduped,
    note: 'AI cleanup scheduled — it scans for duplicate memories and STAGES merge proposals for user review (list_staged_writes shows them); nothing merges without approval (§21 rule 6).'
  }
}

// ── retry_task ─────────────────────────────────────────────────────────────────

const RetryTaskInput = z.object({
  task_id: z.string().min(1).describe('Id of a deferred task to re-run now (list_tasks shows statuses).')
})

async function retryTaskTool(args: unknown, ctx: ToolContext): Promise<unknown> {
  const input = parse(RetryTaskInput, args, 'retry_task')
  const queue = requireQueue(ctx, 'retry_task')
  try {
    const result = queue.retryDeferred(input.task_id)
    return { retried: true, taskId: result.taskId, status: result.status, note: 'Task re-queued with a fresh retry round.' }
  } catch (err) {
    // TaskRetryError.code is already the MCP vocabulary (NOT_FOUND / INVALID_STATE).
    if (err instanceof TaskRetryError) throw new ToolError(err.code, err.message)
    throw err
  }
}

// ── scan_watched_folder ────────────────────────────────────────────────────────

const ScanWatchedFolderInput = z.object({
  name: z.string().min(1).describe('The configured watched-folder name (list_watched_folders shows them).')
})

async function scanWatchedFolderTool(args: unknown, ctx: ToolContext): Promise<unknown> {
  const input = parse(ScanWatchedFolderInput, args, 'scan_watched_folder')
  if (ctx.watchedFolders === undefined) {
    throw new ToolError('INVALID_STATE', 'scan_watched_folder: the watched-folder store is unavailable this launch')
  }
  const folder = ctx.watchedFolders.list().find((f) => f.name === input.name)
  if (folder === undefined) {
    throw new ToolError('NOT_FOUND', `watched folder '${input.name}' does not exist — call list_watched_folders`)
  }
  const deps: KnowledgeIngestDeps = {
    engine: ctx.engine,
    embedder: ctx.retrieval.embedder,
    ...(ctx.scanner !== undefined ? { scanner: ctx.scanner } : {}),
    ...(ctx.audit !== undefined ? { audit: { log: ctx.audit, agentId: `mcp:${ctx.sessionId}` } } : {})
  }
  try {
    // Content-hash dedup: re-scanning an unchanged folder ingests nothing.
    const result = await scanWatchedFolder(deps, folder)
    return {
      folder: result.folder,
      path: result.path,
      scannedFiles: result.scannedFiles,
      ingested: result.ingested.map((r) => ({ file: r.file, status: r.status, chunkCount: r.chunkCount })),
      skipped: result.skipped.map((r) => ({ file: r.file, reason: r.reason })),
      failed: result.failed.map((r) => ({ file: r.file, error: r.error }))
    }
  } catch (err) {
    if (err instanceof IngestError) throw new ToolError(err.code, err.message)
    throw err
  }
}

export const CONTROL_TOOL_DEFS: readonly McpToolDef[] = [
  {
    name: 'ingest_document',
    description:
      'Ingest a document into knowledge memory: structure-aware chunking (headings/code fences, ~512 tokens), ' +
      'local embeddings, content-hash dedup (identical re-adds are no-ops; changed documents replace their old chunks). ' +
      'Pass an absolute file path (markdown/plain text/source; PDF is not supported) or the document content itself; ' +
      'optional tags attach to every chunk.',
    inputSchema: jsonSchema(IngestDocumentInput),
    handle: ingestDocumentTool
  },
  {
    name: 'ingest_codebase',
    description:
      'Ingest a codebase folder into component memory: gitignore-respecting walk, Tree-sitter parsing ' +
      '(TypeScript/JavaScript/Python) into meaningful units (exported functions/classes, routes, data models) ' +
      'as Component nodes with DEPENDS_ON edges, attached to a Project matched by path or created with a ' +
      'README-derived summary. READMEs, markdown and docstrings become Knowledge chunks tagged to the Project. ' +
      'Per-unit content hashes: re-ingesting unchanged code is a no-op.',
    inputSchema: jsonSchema(IngestCodebaseInput),
    handle: ingestCodebaseTool
  },
  {
    name: 'run_extraction',
    description:
      'Schedule memory extraction for a finished session (deterministic facts + fuzzy components/preferences/corrections through the local/cloud tiers). Exactly-once per session id; low-confidence items stage for review. Runs on the §8 queue, not inline.',
    inputSchema: jsonSchema(RunExtractionInput),
    handle: runExtractionTool
  },
  {
    name: 'improve_skill_now',
    description:
      'Schedule the §17 improvement workflow for one skill now (bypasses the nightly recency gate but still needs accrued corrections/failures). The candidate is benchmarked and adopted only through the gate — verifiable skills on a net-positive, zero-regression result; stylistic skills via one-click user approval.',
    inputSchema: jsonSchema(ImproveSkillNowInput),
    handle: improveSkillNowTool
  },
  {
    name: 'run_maintenance',
    description:
      'Fire a maintenance job now: "prune" (the nightly retention sweep — an audited, reversible transcript-ref drop + task/checkpoint cleanup) or "export" (write the CSV + Cypher memory export). Deduped per minute; runs on the §8 queue.',
    inputSchema: jsonSchema(RunMaintenanceInput),
    handle: runMaintenanceTool
  },
  {
    name: 'run_graph_cleanup',
    description:
      'Schedule an AI memory-cleanup pass now: it scans for duplicate memories (exact matches plus near-duplicates the local LLM judges) and STAGES merge proposals for your review — it never merges anything directly (§21 rule 6; approve them in the review queue, list_staged_writes shows them). Optional scope (default "recent" = memories changed in the last 7 days; "count" the newest N; "all" everything), count (only with scope "count"), threshold (near-duplicate cosine floor 0..1), and labels (restrict to certain memory kinds). Deduped per minute; runs on the §8 queue.',
    inputSchema: jsonSchema(RunGraphCleanupInput),
    handle: runGraphCleanupTool
  },
  {
    name: 'retry_task',
    description:
      'Re-run a DEFERRED §8 task now with a fresh retry round (NOT_FOUND if it does not exist; INVALID_STATE if it is not deferred, already queued/running, or parked behind a human approval — decide the approval instead).',
    inputSchema: jsonSchema(RetryTaskInput),
    handle: retryTaskTool
  },
  {
    name: 'scan_watched_folder',
    description:
      'Ingest a configured watched folder now: every supported file goes through the knowledge pipeline with content-hash dedup (re-scanning unchanged files is a no-op). Returns per-file ingested/skipped/failed results.',
    inputSchema: jsonSchema(ScanWatchedFolderInput),
    handle: scanWatchedFolderTool
  }
]
