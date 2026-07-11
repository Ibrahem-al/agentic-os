/**
 * Dashboard memory editing (feature B) — the write-side service behind the
 * five `memory.*` mutation IPC channels. IPC-ONLY by design: Claude's write
 * path stays propose_correction → staged → validated (§21 rule 6), so these
 * mutations are never exposed as MCP tools. They exist for the HUMAN at the
 * dashboard and commit directly — but every one rides `audit.graphWrite`
 * (actor `user:dashboard`), so each shows up in the History panel as a
 * reversible action (§13, §21 rule 11) and every response carries its
 * `auditActionId` for a one-click Undo.
 *
 * Everything that can reject does so BEFORE the write lane, so a refused
 * request leaves no trace (no lane job, no audit row, no partial write):
 *  - labels/edge types/endpoint pairs validate against the §18 schema;
 *  - props must be writable for the label MINUS the protected keys — id and
 *    created_at/updated_at are server-owned, `embedding` is computed (never
 *    supplied), and extracted_by/confidence are extraction provenance
 *    (§21 rule 4): a user-authored row carries none — the audit row records
 *    the actor instead. User edges carry NO props for the same reason
 *    (recorded decision, feature brief Stage 2).
 *  - retrievable labels (Project/Skill/Preference/Knowledge) embed pre-lane
 *    via the Ollama embedder; a down embedder fails the request with
 *    OLLAMA_ERROR and the graph is untouched.
 *
 * Deletes use the Stage-1 structured engine deletes (DETACH semantics —
 * incident edges go, far endpoints survive) plus two explicit owned-children
 * cascades: a Document takes its HAS_CHUNK Knowledge chunks, a Skill its
 * HAS_VERSION SkillVersions — children before parent, in ONE audited job, so
 * a single History undo restores the whole subtree (embeddings included).
 */
import { createHash, randomUUID } from 'node:crypto'
import { importSkill, skillEmbedText } from '../agents/skills/lifecycle'
import { OllamaError } from '../models'
import type { AuditLog } from '../security/audit'
import {
  EDGE_TYPES,
  NODE_LABELS,
  RETRIEVABLE_LABELS,
  relTable,
  writableNodeProperties,
  type EdgeType,
  type NodeLabel,
  type NodeRef,
  type PropertyType,
  type RetrievableLabel,
  type StorageEngine
} from '../storage'

export type MemoryEditErrorCode = 'INVALID_INPUT' | 'NOT_FOUND'

export class MemoryEditError extends Error {
  readonly code: MemoryEditErrorCode

  constructor(code: MemoryEditErrorCode, message: string) {
    super(message)
    this.name = 'MemoryEditError'
    this.code = code
  }
}

export interface MemoryEditDeps {
  readonly engine: StorageEngine
  readonly audit: AuditLog
  /**
   * Structural OllamaClient. Optional so non-retrievable labels (Tag,
   * Document, …) stay editable when the model layer did not boot; a
   * retrievable write then fails OLLAMA_ERROR pre-lane with nothing written.
   */
  readonly embedder?: { embed(texts: string[]): Promise<number[][]> }
  /** Recorded as the audit actor (§13) — DASHBOARD_USER in production. */
  readonly actor: string
}

/**
 * Keys a client may NEVER supply: id + timestamps are server-owned,
 * `embedding` is computed pre-lane, and extracted_by/confidence are
 * extraction provenance stamps (§21 rule 4) — meaningless on a user-authored
 * row, immutable on an extracted one.
 */
export const PROTECTED_NODE_KEYS = [
  'id',
  'created_at',
  'updated_at',
  'embedding',
  'extracted_by',
  'confidence'
] as const

export interface NodeMutationResult {
  readonly label: NodeLabel
  readonly id: string
  readonly auditActionId: string
}

export interface DeleteNodeResult {
  readonly auditActionId: string
  readonly deleted: { readonly nodes: number; readonly edges: number }
}

export interface EdgeMutationResult {
  readonly auditActionId: string
}

// ── validation (all pre-lane) ────────────────────────────────────────────────

function assertNodeLabel(label: string): NodeLabel {
  if (!(NODE_LABELS as readonly string[]).includes(label)) {
    throw new MemoryEditError('INVALID_INPUT', `unknown node label '${label}'`)
  }
  return label as NodeLabel
}

function assertEdgeType(type: string): EdgeType {
  if (!(EDGE_TYPES as readonly string[]).includes(type)) {
    throw new MemoryEditError('INVALID_INPUT', `unknown edge type '${type}'`)
  }
  return type as EdgeType
}

const retrievableOf = (label: NodeLabel): RetrievableLabel | null =>
  (RETRIEVABLE_LABELS as readonly string[]).includes(label) ? (label as RetrievableLabel) : null

/**
 * Mirrors the engine's own type checks (ryugraph validatePropValue) so a bad
 * value is refused BEFORE the lane instead of failing mid-job (which would
 * leave an outcome:'error' audit row). null is allowed — it clears the column
 * on update and is omitted on create, exactly as upsertNode treats it.
 */
function validateValue(label: NodeLabel, name: string, type: PropertyType, value: unknown): void {
  if (value === null || value === undefined) return
  const fail = (expected: string): never => {
    throw new MemoryEditError('INVALID_INPUT', `${label}.${name}: expected ${expected}`)
  }
  switch (type) {
    case 'STRING':
      if (typeof value !== 'string') fail('a string')
      return
    case 'BOOLEAN':
      if (typeof value !== 'boolean') fail('a boolean')
      return
    case 'INT64':
      if (typeof value !== 'number' || !Number.isSafeInteger(value)) fail('an integer')
      return
    case 'DOUBLE':
      if (typeof value !== 'number' || !Number.isFinite(value)) fail('a finite number')
      return
    case 'TIMESTAMP':
      if (!(value instanceof Date) && (typeof value !== 'string' || Number.isNaN(Date.parse(value)))) {
        fail('an ISO-8601 timestamp')
      }
      return
    case 'EMBEDDING':
      // Unreachable: 'embedding' is a protected key, rejected before this.
      fail('nothing — embeddings are computed server-side')
  }
}

function validateProps(label: NodeLabel, props: Record<string, unknown>, context: string): void {
  const offending = Object.keys(props).filter((key) => (PROTECTED_NODE_KEYS as readonly string[]).includes(key))
  if (offending.length > 0) {
    throw new MemoryEditError(
      'INVALID_INPUT',
      `${context}: ${offending.join(', ')} ${offending.length === 1 ? 'is' : 'are'} protected — ` +
        'ids, timestamps and embeddings are server-managed, and extracted_by/confidence are extraction ' +
        'provenance (§21 rule 4); none can be set from the dashboard'
    )
  }
  const writable = writableNodeProperties(label)
  for (const [name, value] of Object.entries(props)) {
    const type = writable.get(name)
    if (type === undefined) {
      throw new MemoryEditError('INVALID_INPUT', `${context}: '${name}' is not a writable ${label} property (§18 schema)`)
    }
    validateValue(label, name, type, value)
  }
}

// ── embedding preflight ──────────────────────────────────────────────────────

const joinNonEmpty = (parts: string[], sep: string): string => parts.filter((p) => p !== '').join(sep)

interface EmbedTextSpec {
  readonly columns: readonly string[]
  readonly render: (get: (column: string) => string) => string
}

/**
 * What each retrievable label embeds — EXACTLY the text retrieval renders for
 * it (retrieval/render.ts RENDERERS; Skill via skillEmbedText), so the vector
 * index serves back what the read path scores.
 */
const EMBED_TEXT: Readonly<Record<RetrievableLabel, EmbedTextSpec>> = {
  Project: { columns: ['name', 'summary'], render: (get) => joinNonEmpty([get('name'), get('summary')], ' — ') },
  Skill: { columns: ['name', 'instructions'], render: (get) => skillEmbedText(get('name'), get('instructions')) },
  Preference: { columns: ['statement'], render: (get) => get('statement') },
  Knowledge: { columns: ['content'], render: (get) => get('content') }
}

/**
 * The §9.2-style preflight: embed BEFORE the lane so an embedder failure
 * writes nothing. Always surfaces as OllamaError → the IPC envelope's
 * OLLAMA_ERROR code, with a message that says the graph was not touched.
 */
async function embedOrFail(deps: MemoryEditDeps, label: RetrievableLabel, text: string): Promise<number[]> {
  if (deps.embedder === undefined) {
    throw new OllamaError(
      `nothing was saved — embedding the ${label} needs the local model layer, which is unavailable this launch (is Ollama running?)`
    )
  }
  let vectors: number[][]
  try {
    vectors = await deps.embedder.embed([text])
  } catch (err) {
    if (err instanceof OllamaError) throw err
    throw new OllamaError(
      `nothing was saved — embedding the ${label} failed: ${err instanceof Error ? err.message : String(err)}`,
      err
    )
  }
  const embedding = vectors[0]
  if (embedding === undefined) {
    throw new OllamaError(`nothing was saved — the embedder returned no vector for the ${label}`)
  }
  return embedding
}

// ── helpers ──────────────────────────────────────────────────────────────────

/** Server-generated id for a user-created node: usr-<label8>-<hash8>. */
function userNodeId(label: NodeLabel, props: Record<string, unknown>): string {
  const hash8 = createHash('sha256')
    .update(`${label}:${JSON.stringify(props)}:${randomUUID()}`)
    .digest('hex')
    .slice(0, 8)
  return `usr-${label.toLowerCase().slice(0, 8)}-${hash8}`
}

/** A short human handle for the History-panel description line. */
function describeHead(props: Record<string, unknown>): string {
  for (const key of ['name', 'statement', 'content', 'source']) {
    const value = props[key]
    if (typeof value === 'string' && value !== '') {
      return value.length > 60 ? `${value.slice(0, 59)}…` : value
    }
  }
  return ''
}

async function nodeExists(engine: StorageEngine, ref: NodeRef): Promise<boolean> {
  const rows = await engine.cypher(`MATCH (n:${ref.label} {id: $id}) RETURN n.id AS id LIMIT 1`, { id: ref.id })
  return rows.length > 0
}

async function assertNodeExists(engine: StorageEngine, ref: NodeRef): Promise<void> {
  if (!(await nodeExists(engine, ref))) {
    throw new MemoryEditError('NOT_FOUND', `${ref.label} ${ref.id} does not exist`)
  }
}

// ── memory.node.create ───────────────────────────────────────────────────────

export async function createMemoryNode(
  deps: MemoryEditDeps,
  args: { label: string; props: Record<string, unknown> }
): Promise<NodeMutationResult> {
  const label = assertNodeLabel(args.label)
  validateProps(label, args.props, `create ${label}`)

  if (label === 'Skill') {
    if ('current_version' in args.props) {
      throw new MemoryEditError(
        'INVALID_INPUT',
        `create Skill: 'current_version' is server-managed — it is set to the created active version`
      )
    }
    for (const required of ['name', 'instructions'] as const) {
      const value = args.props[required]
      if (typeof value !== 'string' || value === '') {
        throw new MemoryEditError(
          'INVALID_INPUT',
          `create Skill: '${required}' must be a non-empty string — a skill is standing instructions served over get_skill`
        )
      }
    }
  }

  const retrievable = retrievableOf(label)
  let embedding: number[] | undefined
  if (retrievable !== null) {
    const spec = EMBED_TEXT[retrievable]
    const text = spec.render((column) => {
      const value = args.props[column]
      return typeof value === 'string' ? value : ''
    })
    if (text === '') {
      throw new MemoryEditError('INVALID_INPUT', `create ${label}: nothing to embed — provide ${spec.columns.join(' and/or ')}`)
    }
    embedding = await embedOrFail(deps, retrievable, text)
  }

  const id = userNodeId(label, args.props)
  const head = describeHead(args.props)
  const description = `dashboard: create ${label} ${id}${head === '' ? '' : ` — ${head}`}`

  if (label === 'Skill') {
    // A user-created Skill lands complete: Skill + active SkillVersion +
    // HAS_VERSION in ONE audited job, so get_skill / the Skills panel / the
    // phase-12 improvement loop see the same shape. Both base-Skill writers
    // converge on `importSkill` (Stage 3): the dashboard supplies no project
    // link and no provenance (user-authored — the audit row records the actor),
    // and the embedding is the one computed pre-lane above (Skill is
    // retrievable, so it is always present here).
    if (embedding === undefined) {
      throw new MemoryEditError('INVALID_INPUT', `create Skill: nothing to embed — provide name and/or instructions`)
    }
    const { auditActionId } = await importSkill(
      { audit: deps.audit },
      {
        skillId: id,
        name: String(args.props['name']),
        instructions: String(args.props['instructions']),
        embedding,
        agentId: deps.actor,
        description
      }
    )
    return { label, id, auditActionId }
  }

  const { actionId } = await deps.audit.graphWrite(deps.actor, description, async (tx) => {
    await tx.upsertNode(label, { ...args.props, id, ...(embedding !== undefined ? { embedding } : {}) })
  })
  return { label, id, auditActionId: actionId }
}

// ── memory.node.update ───────────────────────────────────────────────────────

export async function updateMemoryNode(
  deps: MemoryEditDeps,
  args: { label: string; id: string; props: Record<string, unknown> }
): Promise<NodeMutationResult> {
  const label = assertNodeLabel(args.label)
  if (Object.keys(args.props).length === 0) {
    throw new MemoryEditError('INVALID_INPUT', `update ${label} ${args.id}: no properties supplied`)
  }
  validateProps(label, args.props, `update ${label}`)

  const retrievable = retrievableOf(label)
  const embedColumns = retrievable !== null ? EMBED_TEXT[retrievable].columns : []
  const touchesText = embedColumns.some((column) => column in args.props)

  // Existence check + the current text columns for the re-embed merge (direct read).
  const select = ['n.id AS id', ...embedColumns.map((c) => `n.${c} AS ${c}`)].join(', ')
  const rows = await deps.engine.cypher(`MATCH (n:${label} {id: $id}) RETURN ${select} LIMIT 1`, { id: args.id })
  const current = rows[0]
  if (current === undefined) {
    throw new MemoryEditError('NOT_FOUND', `${label} ${args.id} does not exist`)
  }

  let embedding: number[] | undefined
  if (retrievable !== null && touchesText) {
    const spec = EMBED_TEXT[retrievable]
    const text = spec.render((column) => {
      const value = column in args.props ? args.props[column] : current[column]
      return typeof value === 'string' ? value : ''
    })
    if (text === '') {
      throw new MemoryEditError(
        'INVALID_INPUT',
        `update ${label} ${args.id}: the edit would leave nothing to embed — ${spec.columns.join(' / ')} cannot all be empty`
      )
    }
    embedding = await embedOrFail(deps, retrievable, text)
  }

  const description = `dashboard: update ${label} ${args.id} (${Object.keys(args.props).join(', ')})`
  const { actionId } = await deps.audit.graphWrite(deps.actor, description, async (tx) => {
    await tx.upsertNode(label, { ...args.props, id: args.id, ...(embedding !== undefined ? { embedding } : {}) })
  })
  return { label, id: args.id, auditActionId: actionId }
}

// ── memory.node.delete ───────────────────────────────────────────────────────

/**
 * The two owned-children cascades. The engine's deleteNode is DETACH (edges
 * go, neighbors survive) — NOT cascade — so children the parent exclusively
 * owns are deleted explicitly, children before parent, in the same job.
 */
const CASCADE: Partial<Record<NodeLabel, { readonly edge: EdgeType; readonly childLabel: NodeLabel }>> = {
  Document: { edge: 'HAS_CHUNK', childLabel: 'Knowledge' },
  Skill: { edge: 'HAS_VERSION', childLabel: 'SkillVersion' }
}

export async function deleteMemoryNode(
  deps: MemoryEditDeps,
  args: { label: string; id: string }
): Promise<DeleteNodeResult> {
  const label = assertNodeLabel(args.label)
  await assertNodeExists(deps.engine, { label, id: args.id })

  const cascade = CASCADE[label]
  let childIds: string[] = []
  if (cascade !== undefined) {
    const rows = await deps.engine.cypher(
      `MATCH (n:${label} {id: $id})-[:${cascade.edge}]->(c:${cascade.childLabel}) RETURN c.id AS id ORDER BY c.id`,
      { id: args.id }
    )
    childIds = rows.map((row) => String(row['id']))
  }

  const cascadeNote = cascade !== undefined && childIds.length > 0 ? ` (+ ${childIds.length} ${cascade.childLabel})` : ''
  const { actionId } = await deps.audit.graphWrite(
    deps.actor,
    `dashboard: delete ${label} ${args.id}${cascadeNote}`,
    async (tx) => {
      if (cascade !== undefined) {
        for (const childId of childIds) await tx.deleteNode(cascade.childLabel, childId)
      }
      await tx.deleteNode(label, args.id)
    }
  )

  // Deleted-edge count, derived from the recorded inverse delta: the audit
  // recorder logged exactly one restore-node per deleted node and one
  // restore-edge per removed edge — children are deleted first, so the
  // parent→child edge is captured (and counted) exactly once.
  const ops = Number(deps.audit.getAction(actionId)?.details['ops'] ?? 0)
  const nodes = childIds.length + 1
  return { auditActionId: actionId, deleted: { nodes, edges: Math.max(0, ops - nodes) } }
}

// ── memory.edge.create / memory.edge.delete ──────────────────────────────────

function assertEdgePair(type: EdgeType, from: NodeRef, to: NodeRef): void {
  const spec = relTable(type)
  const ok = spec.pairs.some(([f, t]) => f === from.label && t === to.label)
  if (!ok) {
    const allowed = spec.pairs.map(([f, t]) => `${f}→${t}`).join(', ')
    throw new MemoryEditError(
      'INVALID_INPUT',
      `${type} does not connect ${from.label}→${to.label} — the §18 schema allows: ${allowed}`
    )
  }
}

export async function createMemoryEdge(
  deps: MemoryEditDeps,
  args: { type: string; from: { label: string; id: string }; to: { label: string; id: string } }
): Promise<EdgeMutationResult> {
  const type = assertEdgeType(args.type)
  const from: NodeRef = { label: assertNodeLabel(args.from.label), id: args.from.id }
  const to: NodeRef = { label: assertNodeLabel(args.to.label), id: args.to.id }
  assertEdgePair(type, from, to)
  await assertNodeExists(deps.engine, from)
  await assertNodeExists(deps.engine, to)

  // User edges are stamped with NO props: extracted_by/confidence are
  // extraction provenance (§21 rule 4) and this edge is user-authored — the
  // audit row already records the actor (recorded decision, brief Stage 2).
  const { actionId } = await deps.audit.graphWrite(
    deps.actor,
    `dashboard: connect ${from.label} ${from.id} -[${type}]-> ${to.label} ${to.id}`,
    async (tx) => {
      await tx.createEdge(type, from, to)
    }
  )
  return { auditActionId: actionId }
}

export async function deleteMemoryEdge(
  deps: MemoryEditDeps,
  args: { type: string; from: { label: string; id: string }; to: { label: string; id: string } }
): Promise<EdgeMutationResult> {
  const type = assertEdgeType(args.type)
  const from: NodeRef = { label: assertNodeLabel(args.from.label), id: args.from.id }
  const to: NodeRef = { label: assertNodeLabel(args.to.label), id: args.to.id }
  assertEdgePair(type, from, to)
  const rows = await deps.engine.cypher(
    `MATCH (a:${from.label} {id: $from})-[r:${type}]->(b:${to.label} {id: $to}) RETURN count(r) AS c`,
    { from: from.id, to: to.id }
  )
  if (Number(rows[0]?.['c'] ?? 0) === 0) {
    throw new MemoryEditError('NOT_FOUND', `no ${type} edge from ${from.label} ${from.id} to ${to.label} ${to.id}`)
  }

  const { actionId } = await deps.audit.graphWrite(
    deps.actor,
    `dashboard: disconnect ${from.label} ${from.id} -[${type}]-> ${to.label} ${to.id}`,
    async (tx) => {
      await tx.deleteEdge(type, from, to)
    }
  )
  return { auditActionId: actionId }
}
