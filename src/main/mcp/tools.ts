/**
 * The §12 v1 tool surface — exactly these seven, no others:
 *
 *   get_context, search_memory, list_skills, get_skill, propose_correction,
 *   ingest_document, ingest_codebase
 *
 * Handlers are plain async functions dispatched by the server's single
 * CallTool chokepoint (which owns kernel mediation + the mcp_calls log).
 * Tool failures throw ToolError with a stable code — the server turns any
 * throw into a clean structured MCP error result (§15: the orchestrator
 * decides whether to retry or adapt; no pause-and-notify).
 *
 * Write policy: propose_correction stages a `staged_writes` row (§21 rule 6 —
 * staged → validated → commit is Claude's ONLY path for correcting memory);
 * ingest_document runs the sanctioned §18 knowledge-ingestion write path
 * (every mutation through the single write lane); everything else is
 * read-only. ingest_codebase stays NOT_IMPLEMENTED until phase 07.
 */
import { randomUUID } from 'node:crypto'
import * as z from 'zod'
import type BetterSqlite3 from 'better-sqlite3'
import { RETRIEVAL_RECENT_EXAMPLES, SEARCH_MEMORY_MAX_K } from '../config'
import { NODE_LABELS, RETRIEVABLE_LABELS, type StorageEngine } from '../storage'
import { searchMemory, type RetrievalDeps, type Retriever } from '../retrieval'
import { IngestError, ingestDocument } from '../ingest'
import { stableStringify } from './callLog'

export type ToolErrorCode = 'INVALID_INPUT' | 'NOT_FOUND' | 'NOT_IMPLEMENTED'

/** A tool-level failure with a stable, machine-readable code. */
export class ToolError extends Error {
  readonly code: ToolErrorCode

  constructor(code: ToolErrorCode, message: string) {
    super(message)
    this.name = 'ToolError'
    this.code = code
  }
}

/** Everything a tool handler may touch, resolved per transport session. */
export interface ToolContext {
  readonly engine: StorageEngine
  readonly retriever: Retriever
  readonly retrieval: RetrievalDeps
  /** appdata.db — staged_writes lives here (SQLite, not the graph). */
  readonly db: BetterSqlite3.Database
  /** MCP transport session id (also the §6 correlation key). */
  readonly sessionId: string
}

export interface McpToolDef {
  readonly name: string
  readonly description: string
  /** JSON Schema advertised over tools/list (derived from the zod schema). */
  readonly inputSchema: Record<string, unknown>
  handle(args: unknown, ctx: ToolContext): Promise<unknown>
}

/** Node properties a correction may never patch (identity + provenance). */
const PROTECTED_PATCH_KEYS = ['id', 'created_at', 'updated_at', 'embedding', 'extracted_by', 'confidence'] as const

function parse<T extends z.ZodType>(schema: T, args: unknown, tool: string): z.output<T> {
  const result = schema.safeParse(args ?? {})
  if (!result.success) {
    const detail = result.error.issues
      .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('; ')
    throw new ToolError('INVALID_INPUT', `invalid arguments for ${tool} — ${detail}`)
  }
  return result.data
}

const iso = (value: unknown): string | null =>
  value instanceof Date ? value.toISOString() : value === null || value === undefined ? null : String(value)

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

const ProposeCorrectionInput = z.object({
  node_id: z.string().min(1).describe('Id of the existing node to correct.'),
  patch: z
    .record(z.string(), z.unknown())
    .describe('Property → corrected value. Identity/provenance fields cannot be patched.'),
  reason: z.string().min(1).describe('Why this correction is certainly right.')
})

const IngestDocumentInput = z.object({
  path_or_content: z.string().min(1).describe('Absolute file path, or the document content itself.'),
  tags: z.array(z.string()).optional().describe('Tag names for the ingested chunks.')
})

const IngestCodebaseInput = z.object({
  path: z.string().min(1).describe('Absolute folder path of the codebase.'),
  project: z.string().optional().describe('Project name to attach components to.')
})

// ── Handlers ─────────────────────────────────────────────────────────────────

async function getContext(args: unknown, ctx: ToolContext): Promise<unknown> {
  const input = parse(GetContextInput, args, 'get_context')
  const bundle = await ctx.retriever.retrieve(input.task, input.tags ?? [])
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

async function proposeCorrection(args: unknown, ctx: ToolContext): Promise<unknown> {
  const input = parse(ProposeCorrectionInput, args, 'propose_correction')
  const patchKeys = Object.keys(input.patch)
  if (patchKeys.length === 0) {
    throw new ToolError('INVALID_INPUT', 'propose_correction: patch must set at least one property')
  }
  const protectedKeys = patchKeys.filter((k) => (PROTECTED_PATCH_KEYS as readonly string[]).includes(k))
  if (protectedKeys.length > 0) {
    throw new ToolError(
      'INVALID_INPUT',
      `propose_correction: patch may not touch identity/provenance fields (${protectedKeys.join(', ')})`
    )
  }

  // Claude's writes target existing nodes only (§18): resolve the id across
  // all labels with direct reads before staging anything.
  const matches = (
    await Promise.all(
      NODE_LABELS.map(async (label) => {
        const rows = await ctx.engine.cypher(`MATCH (n:${label} {id: $id}) RETURN n.id AS id LIMIT 1`, {
          id: input.node_id
        })
        return rows.length > 0 ? label : null
      })
    )
  ).filter((label): label is (typeof NODE_LABELS)[number] => label !== null)
  if (matches.length === 0) {
    throw new ToolError('NOT_FOUND', `node '${input.node_id}' does not exist — corrections target existing nodes only`)
  }
  if (matches.length > 1) {
    throw new ToolError(
      'INVALID_INPUT',
      `node id '${input.node_id}' is ambiguous across labels ${matches.join(', ')} — cannot stage a correction`
    )
  }
  const targetLabel = matches[0] as string

  const id = randomUUID()
  // The ONLY write this tool performs, and it is to SQLite staging — never the
  // graph (§21 rule 6). The §13 review flow validates + commits later.
  ctx.db
    .prepare(
      `INSERT INTO staged_writes (id, proposed_by, kind, target_label, target_id, payload_json)
       VALUES (?, ?, 'propose_correction', ?, ?, ?)`
    )
    .run(
      id,
      `claude-mcp:${ctx.sessionId}`,
      targetLabel,
      input.node_id,
      stableStringify({ patch: input.patch, reason: input.reason })
    )
  return {
    staged: true,
    stagedWriteId: id,
    targetLabel,
    targetId: input.node_id,
    status: 'staged',
    note: 'Correction staged for validation and user review — nothing is committed to the graph until approved.'
  }
}

async function ingestDocumentTool(args: unknown, ctx: ToolContext): Promise<unknown> {
  const input = parse(IngestDocumentInput, args, 'ingest_document')
  try {
    // The phase-06 pipeline: chunk → embed (the read path's embedder) → one
    // write-lane job. Content-hash dedup means identical re-adds are no-ops.
    return await ingestDocument(
      { engine: ctx.engine, embedder: ctx.retrieval.embedder },
      input.path_or_content,
      input.tags ?? []
    )
  } catch (err) {
    if (err instanceof IngestError) throw new ToolError(err.code, err.message)
    throw err
  }
}

async function ingestCodebase(args: unknown, _ctx: ToolContext): Promise<unknown> {
  parse(IngestCodebaseInput, args, 'ingest_codebase')
  throw new ToolError(
    'NOT_IMPLEMENTED',
    'ingest_codebase is registered but not implemented yet (codebase ingestion arrives in phase 07) — nothing was ingested'
  )
}

// ── The registry the server dispatches against ───────────────────────────────

const jsonSchema = (schema: z.ZodType): Record<string, unknown> =>
  z.toJSONSchema(schema) as Record<string, unknown>

export const MCP_TOOLS: readonly McpToolDef[] = [
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
    name: 'propose_correction',
    description:
      'Propose a correction to an EXISTING node when something is certainly wrong. The correction is staged for validation and user review — it is never written to the graph directly.',
    inputSchema: jsonSchema(ProposeCorrectionInput),
    handle: proposeCorrection
  },
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
    description: 'Ingest a codebase into component memory. NOT IMPLEMENTED YET (phase 07).',
    inputSchema: jsonSchema(IngestCodebaseInput),
    handle: ingestCodebase
  }
]
