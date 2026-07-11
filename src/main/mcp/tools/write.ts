/**
 * Write / staging tools (§12 + §8 Phase 2) — Claude's ONLY write path is the
 * `staged_writes` review queue (§21 rule 6). NONE of these touch the graph
 * directly; the §13 review flow validates + commits later, and the §5
 * human-gated spine (approve/reject/decide/undo/grant/…) is NEVER exposed here.
 *
 *   propose_correction       patch an existing node                → staged_writes 'propose_correction'
 *   propose_extraction       record a memory node/edges (§18 shape) → staged_writes 'extraction'
 *   submit_extraction_items  hand extracted items to the extractor  → runner_submissions + a delegate task
 *   propose_skill_revision   offer a rewritten SKILL.md             → benchmarked through the §17 gate
 */
import { createHash, randomUUID } from 'node:crypto'
import * as z from 'zod'
import { EDGE_TYPES, NODE_LABELS, NODE_TABLES } from '../../storage'
import { EXTRACTION_PROVENANCE, TASK_CLASS_BAND, TASK_PRIORITY } from '../../config'
import {
  baselineSkillMdOf,
  candidateVersionIdOf,
  hasPendingReview,
  normalizeComponent,
  normalizeCorrection,
  normalizeItemText,
  normalizePreference,
  parseSkillMd,
  SKILL_IMPROVEMENT_TASK_KIND
} from '../../agents'
import { normalizeMd } from '../../agents/skills/candidate'
import { DEDUPE_MERGE_LABELS, MemoryEditError, planDedupeMerge } from '../../memory'
import {
  extractionStagingErrorMessage,
  stageDedupeMerge,
  validateExtractionStaging,
  type DedupeMergePayload
} from '../../security'
import { enqueueExtractionContinuation, extractionContinuationTaskId } from '../../triggers'
import { stableStringify } from '../callLog'
import { ToolError, parse, jsonSchema, type McpToolDef, type ToolContext } from './shared'

const sha256Hex = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex')

// ── propose_correction ─────────────────────────────────────────────────────────

/** Node properties a correction may never patch (identity + provenance). */
const PROTECTED_PATCH_KEYS = ['id', 'created_at', 'updated_at', 'embedding', 'extracted_by', 'confidence'] as const

const ProposeCorrectionInput = z.object({
  node_id: z.string().min(1).describe('Id of the existing node to correct.'),
  patch: z
    .record(z.string(), z.unknown())
    .describe('Property → corrected value. Identity/provenance fields cannot be patched.'),
  reason: z.string().min(1).describe('Why this correction is certainly right.')
})

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

// ── propose_extraction ─────────────────────────────────────────────────────────

/** §18 labels whose schema carries extracted_by/confidence columns (stamp there). */
const PROVENANCE_STAMPED_LABELS: ReadonlySet<string> = new Set(
  NODE_TABLES.filter((t) => t.provenance).map((t) => t.label)
)
/** The subscription-tier extraction provenance stamp (§18 `<provenance>/<pass>`). */
const SUBSCRIPTION_PROVENANCE = `${EXTRACTION_PROVENANCE}/llm-subscription`

const NodeLabelEnum = z.enum(NODE_LABELS)
const EdgeTypeEnum = z.enum(EDGE_TYPES)
const NodeRefSchema = z.object({ label: NodeLabelEnum, id: z.string().min(1) })

const ProposeExtractionInput = z.object({
  op: z.enum(['create', 'merge']).describe('create a new node, or merge onto an existing one.'),
  node: z
    .object({
      label: NodeLabelEnum,
      id: z.string().min(1),
      props: z.record(z.string(), z.unknown())
    })
    .nullable()
    .optional()
    .describe('The node to create/merge (props are the domain fields; null = an evidence-only merge described by edges).'),
  edges: z
    .array(z.object({ type: EdgeTypeEnum, from: NodeRefSchema, to: NodeRefSchema }))
    .optional()
    .describe('Typed edges among existing/created nodes; provenance is stamped server-side.'),
  tag_creates: z
    .array(z.object({ id: z.string().min(1), name: z.string().min(1) }))
    .optional()
    .describe('Tags created as part of this write.'),
  embed_on_commit: z.boolean().optional().describe('Compute an embedding at commit for a new retrievable node.'),
  confidence: z.number().min(0).max(1).optional().describe('Your certainty 0..1 (default 1).'),
  evidence: z.string().optional().describe('A short quote/citation backing this write.'),
  reason: z.string().min(1).describe('Why this memory is worth recording.'),
  session: z.string().optional().describe('The originating session id, when applicable.')
})

async function proposeExtraction(args: unknown, ctx: ToolContext): Promise<unknown> {
  const input = parse(ProposeExtractionInput, args, 'propose_extraction')
  const node = input.node ?? null
  const edges = input.edges ?? []
  if (node === null && edges.length === 0) {
    throw new ToolError('INVALID_INPUT', 'propose_extraction: provide a node to create/merge, or at least one edge')
  }
  if (input.op === 'create' && node === null) {
    throw new ToolError('INVALID_INPUT', "propose_extraction: op 'create' requires a node")
  }
  const confidence = input.confidence ?? 1
  // Provenance is stamped SERVER-SIDE (the caller cannot forge it): on the node
  // props for labels that carry the §18 columns, on EVERY edge, and at the
  // payload top level — mirroring the extraction agent's own staged payloads.
  const provenance = { extracted_by: SUBSCRIPTION_PROVENANCE, confidence }
  const stampedNode =
    node === null
      ? null
      : {
          label: node.label,
          id: node.id,
          props: PROVENANCE_STAMPED_LABELS.has(node.label) ? { ...node.props, ...provenance } : { ...node.props }
        }
  const payload = {
    op: input.op,
    node: stampedNode,
    embedOnCommit: input.embed_on_commit ?? false,
    edges: edges.map((e) => ({ type: e.type, from: e.from, to: e.to, props: provenance })),
    tagCreates: input.tag_creates ?? [],
    provenance,
    evidence: input.evidence ?? '',
    reason: input.reason,
    session: input.session ?? ''
  }
  // §18 property validation at the proposal boundary (§13 "staged and
  // validated"): a node's props must be writable for its label and carry the
  // per-label required fields, and every edge must be a schema-legal pair. This
  // is what was missing — staging silently accepted a Skill with props the
  // schema can't write, and the failure only surfaced (raw) at approve time.
  // Returning it as a clean INVALID_INPUT here lets the proposing agent
  // self-correct (§15).
  const issue = validateExtractionStaging({
    node: stampedNode === null ? null : { label: stampedNode.label, props: stampedNode.props },
    edges: payload.edges
  })
  if (issue !== null) {
    throw new ToolError('INVALID_INPUT', extractionStagingErrorMessage('propose_extraction', issue))
  }
  const targetLabel = stampedNode?.label ?? edges[0]?.from.label ?? null
  const targetId = stampedNode?.id ?? edges[0]?.from.id ?? null
  const id = randomUUID()
  // Same 'extraction' staged-write kind the agent uses → the review queue renders
  // it, and approval commits it through the ONE audited write lane (§13).
  ctx.db
    .prepare(
      `INSERT INTO staged_writes (id, proposed_by, kind, target_label, target_id, payload_json)
       VALUES (?, ?, 'extraction', ?, ?, ?)`
    )
    .run(id, `claude-mcp:${ctx.sessionId}`, targetLabel, targetId, stableStringify(payload))
  return {
    staged: true,
    stagedWriteId: id,
    targetLabel,
    targetId,
    status: 'staged',
    note: 'Extraction staged for validation and user review — nothing is committed to the graph until approved.'
  }
}

// ── submit_extraction_items ────────────────────────────────────────────────────

const ComponentSubmissionSchema = z.object({
  name: z.string().min(1),
  type: z.string().optional(),
  depends_on: z.array(z.string()).optional(),
  evidence: z.string().optional(),
  confidence: z.number().optional(),
  chunk: z.number().int().min(0).optional()
})
const PreferenceSubmissionSchema = z.object({
  statement: z.string().min(1),
  tags: z.array(z.string()).optional(),
  derived_from: z.string().nullable().optional(),
  evidence: z.string().optional(),
  confidence: z.number().optional(),
  chunk: z.number().int().min(0).optional()
})
const CorrectionSubmissionSchema = z.object({
  content: z.string().min(1),
  skill: z.string().nullable().optional(),
  evidence: z.string().optional(),
  confidence: z.number().optional(),
  chunk: z.number().int().min(0).optional()
})
const SubmitExtractionItemsInput = z.object({
  session_id: z.string().min(1).describe('The session the items were extracted from.'),
  components: z.array(ComponentSubmissionSchema).max(60).optional(),
  preferences: z.array(PreferenceSubmissionSchema).max(60).optional(),
  corrections: z.array(CorrectionSubmissionSchema).max(60).optional()
})

interface NormalizedSubmission {
  readonly kind: 'component' | 'preference' | 'correction'
  /** The item's identifying text (name / statement / content) for the row id. */
  readonly text: string
  /** The camelCase ExtractedX object the delegate reads back verbatim. */
  readonly payload: unknown
}

async function submitExtractionItems(args: unknown, ctx: ToolContext): Promise<unknown> {
  const input = parse(SubmitExtractionItemsInput, args, 'submit_extraction_items')
  const sessionId = input.session_id
  // Normalize each item exactly as the local fuzzy passes would, so the delegate
  // loads them back (via *FromSubmission) through the SAME resolve/verify/write.
  const normalized: NormalizedSubmission[] = []
  for (const raw of input.components ?? []) {
    const item = normalizeComponent(raw, raw.chunk ?? 0)
    if (item !== null) normalized.push({ kind: 'component', text: item.name, payload: item })
  }
  for (const raw of input.preferences ?? []) {
    const item = normalizePreference(raw, raw.chunk ?? 0)
    if (item !== null) normalized.push({ kind: 'preference', text: item.statement, payload: item })
  }
  for (const raw of input.corrections ?? []) {
    const item = normalizeCorrection(raw, raw.chunk ?? 0)
    if (item !== null) normalized.push({ kind: 'correction', text: item.content, payload: item })
  }
  if (normalized.length === 0) {
    throw new ToolError('INVALID_INPUT', 'submit_extraction_items: no valid items (each needs a name / statement / content)')
  }
  // The task these submissions belong to: a bound runner's OWN delegate task
  // (§14b, agent mode), else — interactive — a fresh continuation keyed to this
  // batch. `runner_submissions.task_id` MUST equal the delegate task id so the
  // delegate's `WHERE task_id = ?` load finds exactly these rows.
  const boundTaskId = ctx.boundTaskId
  const batchKey = normalized.map((n) => `${n.kind}:${normalizeItemText(n.text)}`).sort().join('\n')
  const taskId = boundTaskId ?? extractionContinuationTaskId(sessionId, batchKey)
  const insert = ctx.db.prepare(
    `INSERT OR IGNORE INTO runner_submissions (id, task_id, session_id, kind, payload_json) VALUES (?, ?, ?, ?, ?)`
  )
  let inserted = 0
  for (const n of normalized) {
    const rowId = sha256Hex(`${taskId}\n${n.kind}\n${normalizeItemText(n.text)}`)
    const res = insert.run(rowId, taskId, sessionId, n.kind, stableStringify(n.payload))
    if (res.changes > 0) inserted += 1
  }
  // Interactive (no runner task bound): synthesize the delegate continuation so
  // the items get resolved → verified → written through the §17 gates. A bound
  // runner already has its delegate task running — nothing to enqueue here.
  let continuationTaskId: string | null = null
  let deduped = false
  if (boundTaskId === undefined) {
    if (ctx.queue === undefined) {
      throw new ToolError(
        'INVALID_STATE',
        'submit_extraction_items: the task queue is unavailable this launch — cannot schedule the extraction continuation'
      )
    }
    const result = enqueueExtractionContinuation(ctx.queue, sessionId, batchKey)
    continuationTaskId = result.taskId
    deduped = result.deduped
  }
  return {
    staged: true,
    sessionId,
    submitted: normalized.length,
    inserted,
    taskId,
    continuationTaskId,
    deduped,
    boundToRunnerTask: boundTaskId !== undefined,
    note:
      boundTaskId !== undefined
        ? 'Items recorded for the bound runner extraction task.'
        : 'Items recorded; a delegate extraction was scheduled to resolve, verify and stage/commit them through the review gates.'
  }
}

// ── propose_skill_revision ─────────────────────────────────────────────────────

const ProposeSkillRevisionInput = z.object({
  skill_id: z.string().min(1).describe('Id of the skill to revise (list_skills / search_memory return ids).'),
  skill_md: z.string().min(1).describe('The complete revised SKILL.md file content (frontmatter + instructions).')
})

async function proposeSkillRevision(args: unknown, ctx: ToolContext): Promise<unknown> {
  const input = parse(ProposeSkillRevisionInput, args, 'propose_skill_revision')
  if (ctx.queue === undefined) {
    throw new ToolError(
      'INVALID_STATE',
      'propose_skill_revision: the task queue is unavailable this launch — cannot schedule a benchmark'
    )
  }
  const skillRows = await ctx.engine.cypher(
    'MATCH (s:Skill {id: $id}) RETURN s.id AS id, s.name AS name, s.instructions AS instructions LIMIT 1',
    { id: input.skill_id }
  )
  const skill = skillRows[0]
  if (skill === undefined) {
    throw new ToolError('NOT_FOUND', `skill '${input.skill_id}' does not exist — call list_skills to see what exists`)
  }
  const skillName = String(skill['name'] ?? skill['id'])
  // Active-version instructions (get_skill semantics) with Skill fallback — the
  // SAME baseline the improvement gate computes, so this differs-check matches.
  const activeRows = await ctx.engine.cypher(
    `MATCH (s:Skill {id: $id})-[:HAS_VERSION]->(v:SkillVersion) WHERE v.status = 'active'
     RETURN v.instructions AS instructions ORDER BY v.created_at DESC, v.id LIMIT 1`,
    { id: input.skill_id }
  )
  const versionInstructions = activeRows[0] !== undefined ? String(activeRows[0]['instructions'] ?? '') : ''
  const activeInstructions = versionInstructions !== '' ? versionInstructions : String(skill['instructions'] ?? '')
  const baseline = baselineSkillMdOf({ skillName, activeInstructions })
  // Validate the revised SKILL.md at the boundary (mirrors the candidate step).
  let parsed
  try {
    parsed = parseSkillMd(input.skill_md)
  } catch (err) {
    throw new ToolError(
      'INVALID_INPUT',
      `propose_skill_revision: invalid SKILL.md — ${err instanceof Error ? err.message : String(err)}`
    )
  }
  if (parsed.name !== baseline.name) {
    throw new ToolError(
      'INVALID_INPUT',
      `propose_skill_revision: frontmatter name '${parsed.name}' must stay exactly '${baseline.name}'`
    )
  }
  if (normalizeMd(input.skill_md) === normalizeMd(baseline.md)) {
    throw new ToolError('INVALID_INPUT', 'propose_skill_revision: the revision is identical to the active skill')
  }
  if (hasPendingReview(ctx.db, input.skill_id)) {
    throw new ToolError(
      'INVALID_STATE',
      'propose_skill_revision: a candidate for this skill is already awaiting review — decide it before proposing another'
    )
  }
  const versionId = candidateVersionIdOf(input.skill_id, input.skill_md)
  const result = ctx.queue.enqueue({
    // Deterministic id: re-proposing the same content dedups to one benchmark.
    id: `skill-revision-${versionId}`,
    kind: SKILL_IMPROVEMENT_TASK_KIND,
    priority: TASK_CLASS_BAND.user + TASK_PRIORITY.skillImprove,
    payload: {
      skillId: input.skill_id,
      providedCandidate: { versionId, instructions: input.skill_md, proposedBy: `claude-mcp:${ctx.sessionId}` }
    }
  })
  return {
    scheduled: true,
    taskId: result.taskId,
    deduped: result.deduped,
    skillId: input.skill_id,
    candidateVersionId: versionId,
    note: 'Revision scheduled for benchmarking against the held-out split — it is adopted ONLY through the §17 gate (stylistic skills need your one-click approval; verifiable skills need a net-positive, zero-regression result), never directly.'
  }
}

// ── propose_dedupe_merge ────────────────────────────────────────────────────────

const ProposeDedupeMergeInput = z.object({
  label: z.enum(DEDUPE_MERGE_LABELS).describe('Node label to merge — one of Preference, Knowledge, Tag.'),
  keep_id: z.string().min(1).describe('The surviving node id (list_duplicate_memories suggests one).'),
  remove_ids: z.array(z.string().min(1)).min(1).describe('Duplicate node ids to fold into the keeper.'),
  rationale: z.string().optional().describe('Why these are the same memory (shown in the review diff).')
})

async function proposeDedupeMerge(args: unknown, ctx: ToolContext): Promise<unknown> {
  const input = parse(ProposeDedupeMergeInput, args, 'propose_dedupe_merge')
  // Validate exactly as mergeDuplicates would (label supported, keeper ∉ removals,
  // every id exists) and resolve the displays for the review diff — all pre-lane.
  let plan
  try {
    plan = await planDedupeMerge(
      { engine: ctx.engine },
      { label: input.label, keepId: input.keep_id, removeIds: input.remove_ids }
    )
  } catch (err) {
    if (err instanceof MemoryEditError) throw new ToolError(err.code, err.message)
    throw err
  }
  const payload: DedupeMergePayload = {
    label: plan.label,
    keepId: plan.keepId,
    removeIds: plan.removals.map((r) => r.id),
    keepDisplay: plan.keepDisplay,
    displays: plan.removals.map((r) => ({ id: r.id, display: r.display })),
    rationale: input.rationale ?? ''
  }
  // The ONLY write this tool performs is to SQLite staging — never the graph
  // (§21 rule 6). Approval runs the SAME audited mergeDuplicates the dashboard does.
  const id = stageDedupeMerge(ctx.db, `claude-mcp:${ctx.sessionId}`, payload)
  return {
    staged: true,
    stagedWriteId: id,
    label: plan.label,
    keepId: plan.keepId,
    removeIds: payload.removeIds,
    status: 'staged',
    note: 'Merge staged for user review — nothing is merged in the graph until approved.'
  }
}

export const WRITE_TOOL_DEFS: readonly McpToolDef[] = [
  {
    name: 'propose_correction',
    description:
      'Propose a correction to an EXISTING node when something is certainly wrong. The correction is staged for validation and user review — it is never written to the graph directly.',
    inputSchema: jsonSchema(ProposeCorrectionInput),
    handle: proposeCorrection
  },
  {
    name: 'propose_extraction',
    description:
      'Propose a new memory item (a node and/or typed edges, in the §18 extraction shape) worth remembering from this session. Provenance is stamped server-side; the whole proposal is staged for user review and only commits — through the audited write lane — on approval.',
    inputSchema: jsonSchema(ProposeExtractionInput),
    handle: proposeExtraction
  },
  {
    name: 'submit_extraction_items',
    description:
      'Hand already-extracted components / preferences / corrections (≤60 each) to the extraction agent for a finished session. They are recorded verbatim and a delegate extraction runs them through the same entity-resolution, verification and review gates — items commit or stage exactly as the agent would decide, never directly.',
    inputSchema: jsonSchema(SubmitExtractionItemsInput),
    handle: submitExtractionItems
  },
  {
    name: 'propose_skill_revision',
    description:
      'Propose a rewritten SKILL.md for an existing skill. It is benchmarked against a held-out split and adopted ONLY through the §17 gate (stylistic skills need one-click user approval; verifiable skills need a net-positive, zero-regression result) — never self-certified. Rejected if a candidate for the skill is already awaiting review.',
    inputSchema: jsonSchema(ProposeSkillRevisionInput),
    handle: proposeSkillRevision
  },
  {
    name: 'propose_dedupe_merge',
    description:
      'Propose merging duplicate memory nodes (Preference | Knowledge | Tag) onto a keeper — validated and STAGED for user review, never merged directly (§21 rule 6). On approval the removed nodes’ edges move onto the keeper and the duplicates are deleted, in one audited, undoable step. Use list_duplicate_memories to find groups and a suggested keeper.',
    inputSchema: jsonSchema(ProposeDedupeMergeInput),
    handle: proposeDedupeMerge
  }
]
