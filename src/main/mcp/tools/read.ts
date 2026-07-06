/**
 * Read tools (§12) — get_context, search_memory, list_skills, get_skill.
 * All read-only: hybrid retrieval + direct graph reads, no mutation.
 */
import * as z from 'zod'
import { RETRIEVAL_RECENT_EXAMPLES, SEARCH_MEMORY_MAX_K } from '../../config'
import { RETRIEVABLE_LABELS } from '../../storage'
import { searchMemory } from '../../retrieval'
import { ToolError, parse, jsonSchema, type McpToolDef, type ToolContext } from './shared'

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
  }
]
