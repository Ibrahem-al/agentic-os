/**
 * Deterministic 10k-node synthetic graph for the phase-13 perf sanity item
 * ("retrieval p50 < 500 ms on a 10k-node graph").
 *
 * Shape (10k reference, scaled proportionally for other sizes):
 *   retrievable w/ 1024-dim embeddings — Knowledge 4000, Preference 1500,
 *   Skill 300, Project 200; structural — Component 2500, Session 600,
 *   Document 400, SkillVersion 300, Example 100, Correction 50, Tag 30,
 *   MCP 12, Plugin 8. ~16-17k edges of the real §18 types (REL_TABLES-valid
 *   endpoint pairs only).
 *
 * Everything derives from a mulberry32 PRNG seeded by the `seed` string — no
 * Math.random anywhere, so two runs with the same options build the identical
 * graph. Content is drawn from a word pool (alphabetic only — the FTS
 * tokenizer strips digits, phase-01 finding 8). ~40 nodes are deliberately
 * written around PERF_THEME ('ingestion pipeline chunking') so the rotating
 * perf queries have real targets.
 *
 * ── Embeddings: perfTextEmbedding + the ryugraph LIST-binding fault ─────────
 * Embeddings are a bag-of-words hash (cosine ≈ lexical overlap, the same idea
 * as graph-seed's fakeTextEmbedding) BUT with dim 0 reserved as a small
 * non-integral sentinel (0.001) and tokens hashed into dims 1..1023. Reason,
 * found while building this fixture (ryugraph 25.9.1, node_util.cpp
 * TransformNapiValue): a JS array parameter's LIST type is inferred from its
 * FIRST element only, and each integral JS number becomes an INT64 child — so
 * a sparse vector starting with 0 binds as LIST[INT64] and every fractional
 * element's float64 bytes are REINTERPRETED as int64 (values ~4.6e18, i.e.
 * the double's bit pattern), silently corrupting the stored vector and any
 * query vector bound the same way. A vector whose first element is
 * non-integral binds as LIST[DOUBLE] and every element round-trips exactly
 * (integral elements are INT64 children whose bit patterns only alias 0.0 —
 * and bag-of-words vectors only contain 0 or fractional values anyway).
 * fakeTextEmbedding has hash-dependent (usually zero → integral) first
 * elements, so it cannot be used at this scale; the sentinel makes the first
 * element non-integral BY CONSTRUCTION for every text. The shared-sentinel
 * cosine distortion is ~1e-6 — irrelevant. The retrieval side of the perf
 * test must embed queries with THIS function so query vectors survive the
 * same binding path.
 *
 * ── Write strategy ───────────────────────────────────────────────────────────
 * One engine.withWrite job (§21 rule 1 — everything rides the write lane).
 * Nodes go in as multi-pattern parameterized CREATE batches (100 rows per
 * statement for embedded labels, 300 otherwise); edges as UNWIND +
 * list_element(...) batches, one statement per 400 edges of a
 * (type, fromLabel, toLabel) group. If the first batch of either strategy
 * throws (driver capability), the seeder falls back to per-row
 * upsertNode / createEdge and records which strategy ran.
 *
 * ── Verification (nothing is assumed written) ────────────────────────────────
 * After seeding: per-label node counts and the total edge count are read back
 * and must match; ~10 sampled rows per label are read back and compared
 * property-by-property against the generated values (embeddings elementwise
 * at float32 tolerance — this is what caught the LIST-binding fault); ~40
 * sampled edges are MATCHed by exact endpoints; and — because of the
 * insert-after-index-creation suspicion on some prebuilt binaries — a vector
 * search with a seeded node's EXACT embedding must return that node at
 * distance ≈ 0 for both Knowledge and Preference, proving the HNSW indexes
 * serve the freshly inserted vectors.
 */
import { EMBEDDING_DIM } from '../../src/main/config'
import type {
  EdgeType,
  NodeLabel,
  RetrievableLabel,
  StorageEngine,
  WriteTx
} from '../../src/main/storage'
import { tokenizeForFake } from './graph-seed'

// ── Deterministic PRNG (mulberry32) ──────────────────────────────────────────

function fnv1a(text: string): number {
  let hash = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash >>> 0
}

/** mulberry32 — tiny deterministic PRNG, uniform in [0, 1). */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

type Rng = () => number

const int = (rng: Rng, min: number, max: number): number => min + Math.floor(rng() * (max - min + 1))
const pick = <T>(rng: Rng, items: readonly T[]): T => items[Math.floor(rng() * items.length)] as T
const chance = (rng: Rng, p: number): boolean => rng() < p

// ── Embedding (see the header for why this exists) ───────────────────────────

/** Non-integral first element — pins the driver's LIST type to DOUBLE. */
const TYPE_TAG_SENTINEL = 0.001

/**
 * Bag-of-words hash embedding over dims 1..EMBEDDING_DIM-1 with a constant
 * non-integral sentinel at dim 0 (binding-safe: see header). Cosine similarity
 * ≈ word overlap, exactly like fakeTextEmbedding, shifted by ~1e-6.
 */
export function perfTextEmbedding(text: string): number[] {
  const v = new Array<number>(EMBEDDING_DIM).fill(0)
  v[0] = TYPE_TAG_SENTINEL
  for (const token of tokenizeForFake(text)) {
    v[1 + (fnv1a(token) % (EMBEDDING_DIM - 1))]! += 1
  }
  let norm = 0
  for (const x of v) norm += x * x
  norm = Math.sqrt(norm)
  return v.map((x) => x / norm)
}

// ── Vocabulary ───────────────────────────────────────────────────────────────

/** Generic word pool (alphabetic only — FTS-safe). */
const WORD_POOL = [
  'agent', 'alert', 'analytics', 'api', 'archive', 'audit', 'backend', 'backup', 'badge', 'batch',
  'binary', 'branch', 'browser', 'budget', 'buffer', 'build', 'bundle', 'cache', 'canvas', 'catalog',
  'channel', 'chart', 'checkout', 'client', 'cluster', 'compiler', 'config', 'console', 'container',
  'contract', 'cursor', 'daemon', 'dashboard', 'database', 'dataset', 'debugger', 'deploy', 'diagram',
  'diff', 'docker', 'domain', 'driver', 'endpoint', 'engine', 'export', 'fallback', 'feature', 'filter',
  'fixture', 'flag', 'formatter', 'frontend', 'gateway', 'graph', 'handler', 'hook', 'host', 'image',
  'inbox', 'invoice', 'journal', 'kernel', 'keyboard', 'lambda', 'latency', 'layout', 'ledger',
  'library', 'linter', 'listener', 'login', 'manifest', 'metric', 'migration', 'mirror', 'monitor',
  'network', 'notebook', 'orchestrator', 'palette', 'parser', 'partition', 'payment', 'planner',
  'plugin', 'pointer', 'policy', 'pool', 'portal', 'postgres', 'preview', 'profile', 'protocol',
  'proxy', 'queue', 'quota', 'registry', 'release', 'renderer', 'replica', 'report', 'resolver',
  'retry', 'roadmap', 'rollback', 'router', 'runtime', 'sandbox', 'scanner', 'schema', 'scheduler',
  'secret', 'sensor', 'server', 'session', 'shard', 'shell', 'signal', 'snapshot', 'socket', 'storage',
  'stream', 'summary', 'sync', 'telemetry', 'template', 'terminal', 'testing', 'theme', 'thread',
  'timeline', 'token', 'trace', 'tracker', 'transaction', 'trigger', 'upload', 'vault', 'vector',
  'wallet', 'warehouse', 'webhook', 'widget', 'worker', 'workflow'
] as const

/** The fixed relevance theme the perf queries target. */
export const PERF_THEME = 'ingestion pipeline chunking'

/** Theme vocabulary shared by the ~40 relevant nodes and the queries. */
const THEME_WORDS = [
  'ingestion', 'pipeline', 'chunking', 'chunk', 'document', 'embedding', 'tokenizer', 'overlap',
  'splitter', 'markdown', 'heading', 'digest', 'paragraph', 'boundary', 'window', 'segment'
] as const

/** Rotating perf queries — all on the theme, differently phrased. */
export const PERF_QUERIES = [
  'ingestion pipeline chunking strategy for large documents',
  'how the document ingestion pipeline splits markdown into chunks',
  'chunk overlap and tokenizer window limits in the ingestion pipeline',
  'embedding chunked document segments during ingestion',
  'tune the chunking splitter of the document ingestion pipeline'
] as const

const sentence = (rng: Rng, minWords: number, maxWords: number): string => {
  const n = int(rng, minWords, maxWords)
  const words: string[] = []
  for (let i = 0; i < n; i++) words.push(pick(rng, WORD_POOL))
  return words.join(' ')
}

/** Themed content: the core theme plus theme words plus a little noise. */
const themedSentence = (rng: Rng): string => {
  const parts: string[] = [PERF_THEME]
  const extras = int(rng, 3, 6)
  for (let i = 0; i < extras; i++) parts.push(pick(rng, THEME_WORDS))
  const noise = int(rng, 2, 4)
  for (let i = 0; i < noise; i++) parts.push(pick(rng, WORD_POOL))
  return parts.join(' ')
}

// ── Shape ────────────────────────────────────────────────────────────────────

/** 10k-node reference shape; other sizes scale proportionally. */
const REFERENCE_SHAPE: readonly (readonly [NodeLabel, number])[] = [
  ['Knowledge', 4000],
  ['Preference', 1500],
  ['Skill', 300],
  ['Project', 200],
  ['Component', 2500],
  ['Session', 600],
  ['Document', 400],
  ['SkillVersion', 300],
  ['Example', 100],
  ['Correction', 50],
  ['Tag', 30],
  ['MCP', 12],
  ['Plugin', 8]
]
const REFERENCE_TOTAL = REFERENCE_SHAPE.reduce((sum, [, n]) => sum + n, 0)

function shapeFor(totalNodes: number): Map<NodeLabel, number> {
  const shape = new Map<NodeLabel, number>()
  for (const [label, ref] of REFERENCE_SHAPE) {
    shape.set(label, Math.max(1, Math.round((ref * totalNodes) / REFERENCE_TOTAL)))
  }
  // Absorb rounding drift into Knowledge so the total is exact.
  const sum = [...shape.values()].reduce((a, b) => a + b, 0)
  const knowledge = (shape.get('Knowledge') as number) + (totalNodes - sum)
  if (knowledge < 1) throw new Error(`seedPerfGraph: ${totalNodes} nodes is too small for the reference shape`)
  shape.set('Knowledge', knowledge)
  return shape
}

// ── Row / edge bookkeeping ───────────────────────────────────────────────────

type ColType = 'STRING' | 'DOUBLE' | 'BOOLEAN' | 'TIMESTAMP' | 'EMBEDDING'

/** Column types per prop name (only the props this seeder writes). */
const COLUMN_TYPES: Readonly<Record<string, ColType>> = {
  id: 'STRING',
  content: 'STRING',
  statement: 'STRING',
  name: 'STRING',
  summary: 'STRING',
  instructions: 'STRING',
  current_version: 'STRING',
  type: 'STRING',
  transcript_ref: 'STRING',
  tier: 'STRING',
  source: 'STRING',
  content_hash: 'STRING',
  status: 'STRING',
  kind: 'STRING',
  config_ref: 'STRING',
  extracted_by: 'STRING',
  benchmark_score: 'DOUBLE',
  confidence: 'DOUBLE',
  is_global: 'BOOLEAN',
  started_at: 'TIMESTAMP',
  ended_at: 'TIMESTAMP',
  ingested_at: 'TIMESTAMP',
  embedding: 'EMBEDDING'
}

interface NodeRow {
  readonly label: NodeLabel
  readonly props: Record<string, unknown>
}

interface EdgeRow {
  readonly type: EdgeType
  readonly fromLabel: NodeLabel
  readonly fromId: string
  readonly toLabel: NodeLabel
  readonly toId: string
}

interface SanityProbe {
  readonly label: RetrievableLabel
  readonly id: string
  /** The exact text embedded for this node at generation time. */
  readonly text: string
}

/** Fixed timestamp for engine bookkeeping columns — keeps runs identical. */
const BASE_TIME_MS = Date.parse('2026-06-01T00:00:00.000Z')
const NOW_ISO = new Date(BASE_TIME_MS).toISOString()

const NODE_BATCH_EMBEDDED = 100
const NODE_BATCH_PLAIN = 300
const EDGE_BATCH = 400

export interface SeedPerfGraphOptions {
  readonly nodes: number
  readonly seed: string
}

export interface PerfSeedResult {
  /** Total §18 nodes actually in the graph (verified against the DB). */
  readonly nodeCount: number
  /** Total edges actually in the graph (verified against the DB). */
  readonly edgeCount: number
  /** Wall-clock seeding time, ms (generation + writes + verification). */
  readonly seedMs: number
  readonly nodesByLabel: Readonly<Record<string, number>>
  readonly edgesByType: Readonly<Record<string, number>>
  /** ids of the ~40 deliberately theme-relevant nodes. */
  readonly themedIds: readonly string[]
  /** Which write path actually ran (fallbacks are recorded, not hidden). */
  readonly nodeStrategy: 'batched-create' | 'per-node-upsert'
  readonly edgeStrategy: 'batched-unwind' | 'per-edge-merge'
  /** Worst distance any exact-vector sanity probe returned (should be ~0). */
  readonly sanityVectorDistance: number
}

// ── Generation ───────────────────────────────────────────────────────────────

interface GeneratedGraph {
  readonly nodes: NodeRow[]
  readonly edges: EdgeRow[]
  readonly themedIds: string[]
  /** Exact-embedding probes for the post-seed vector-index sanity check. */
  readonly sanityProbes: SanityProbe[]
}

function generateGraph(options: SeedPerfGraphOptions): GeneratedGraph {
  const rng = mulberry32(fnv1a(options.seed))
  const shape = shapeFor(options.nodes)
  const count = (label: NodeLabel): number => shape.get(label) as number

  const nodes: NodeRow[] = []
  const themedIds: string[] = []
  const sanityProbes: SanityProbe[] = []
  const add = (label: NodeLabel, props: Record<string, unknown>): void => {
    nodes.push({ label, props })
  }

  // Theme allocation (≈40 at the 10k shape, capped by the scaled counts).
  const themedKnowledge = Math.min(25, count('Knowledge'))
  const themedPreferences = Math.min(8, Math.max(0, count('Preference') - 3))
  const themedSkills = Math.min(5, count('Skill'))
  const themedProjects = Math.min(2, count('Project'))

  // Knowledge — retrievable; render text IS the content.
  for (let i = 0; i < count('Knowledge'); i++) {
    const id = `perf-k-${i}`
    const themed = i < themedKnowledge
    const content = themed ? themedSentence(rng) : sentence(rng, 8, 20)
    if (themed) themedIds.push(id)
    if (i === 0) sanityProbes.push({ label: 'Knowledge', id, text: content })
    const props: Record<string, unknown> = { id, content, embedding: perfTextEmbedding(content) }
    if (chance(rng, 0.3)) {
      props['extracted_by'] = 'extraction@0.0.1/llm-local'
      props['confidence'] = Math.round((0.6 + rng() * 0.39) * 100) / 100
    }
    add('Knowledge', props)
  }

  // Preferences — first 3 are the global-tag preferences; then themed; rest noise.
  const extractedPreferences: string[] = []
  for (let i = 0; i < count('Preference'); i++) {
    const id = `perf-pref-${i}`
    const themed = i >= 3 && i < 3 + themedPreferences
    const statement = themed
      ? `prefer ${themedSentence(rng)}`
      : `${pick(rng, ['always', 'never', 'prefer', 'avoid'] as const)} ${sentence(rng, 6, 14)}`
    if (themed) themedIds.push(id)
    if (i === 0) sanityProbes.push({ label: 'Preference', id, text: statement })
    const props: Record<string, unknown> = { id, statement, embedding: perfTextEmbedding(statement) }
    if (chance(rng, 0.33)) {
      props['extracted_by'] = 'extraction@0.0.1/llm-local'
      props['confidence'] = Math.round((0.6 + rng() * 0.39) * 100) / 100
      extractedPreferences.push(id)
    }
    add('Preference', props)
  }

  // Skills — render text is `name: instructions`; skill i owns SkillVersion i.
  const skillVersionCount = count('SkillVersion')
  for (let i = 0; i < count('Skill'); i++) {
    const id = `perf-s-${i}`
    const themed = i < themedSkills
    const name = themed
      ? `${pick(rng, THEME_WORDS)} ${pick(rng, WORD_POOL)}`
      : `${pick(rng, WORD_POOL)} ${pick(rng, WORD_POOL)}`
    const instructions = themed ? themedSentence(rng) : sentence(rng, 10, 24)
    if (themed) themedIds.push(id)
    const props: Record<string, unknown> = {
      id,
      name,
      instructions,
      embedding: perfTextEmbedding(`${name}: ${instructions}`)
    }
    if (i < skillVersionCount) props['current_version'] = `perf-sv-${i}`
    add('Skill', props)
  }

  // Projects — render text is `name — summary`.
  for (let i = 0; i < count('Project'); i++) {
    const id = `perf-proj-${i}`
    const themed = i < themedProjects
    const name = `${pick(rng, WORD_POOL)} ${pick(rng, WORD_POOL)}`
    const summary = themed ? themedSentence(rng) : sentence(rng, 8, 16)
    if (themed) themedIds.push(id)
    add('Project', { id, name, summary, embedding: perfTextEmbedding(`${name} — ${summary}`) })
  }

  // Components — structural; some carry codebase-ingest provenance.
  const extractedComponents: string[] = []
  for (let i = 0; i < count('Component'); i++) {
    const id = `perf-c-${i}`
    const props: Record<string, unknown> = {
      id,
      name: `${pick(rng, WORD_POOL)} ${pick(rng, WORD_POOL)}`,
      type: pick(rng, ['page', 'route', 'model', 'service', 'worker', 'module'] as const)
    }
    if (chance(rng, 0.25)) {
      props['extracted_by'] = 'codebase-ingest@0.0.1'
      props['confidence'] = 1
      extractedComponents.push(id)
    }
    add('Component', props)
  }

  // Sessions — deterministic timestamps in the 90 days before BASE_TIME.
  for (let i = 0; i < count('Session'); i++) {
    const startMs = BASE_TIME_MS - int(rng, 1, 90 * 24 * 60) * 60_000
    const endMs = startMs + int(rng, 20, 240) * 60_000
    add('Session', {
      id: `perf-sess-${i}`,
      started_at: new Date(startMs).toISOString(),
      ended_at: new Date(endMs).toISOString(),
      transcript_ref: `transcripts/perf-sess-${i}.jsonl`,
      tier: 'daily'
    })
  }

  // Documents.
  for (let i = 0; i < count('Document'); i++) {
    add('Document', {
      id: `perf-doc-${i}`,
      source: `docs/perf/${pick(rng, WORD_POOL)}-${i}.md`,
      content_hash: `hash-${i.toString(16)}-${Math.floor(rng() * 0xffffffff).toString(16)}`,
      ingested_at: new Date(BASE_TIME_MS - int(rng, 1, 120 * 24) * 3_600_000).toISOString()
    })
  }

  // SkillVersions — mostly active (expansion only follows active ones).
  for (let i = 0; i < skillVersionCount; i++) {
    add('SkillVersion', {
      id: `perf-sv-${i}`,
      status: i % 10 < 7 ? 'active' : 'retired',
      benchmark_score: Math.round((0.5 + rng() * 0.45) * 100) / 100,
      instructions: sentence(rng, 8, 18)
    })
  }

  // Examples / Corrections.
  for (let i = 0; i < count('Example'); i++) {
    add('Example', {
      id: `perf-ex-${i}`,
      kind: chance(rng, 0.5) ? 'success' : 'failure',
      content: sentence(rng, 8, 16)
    })
  }
  for (let i = 0; i < count('Correction'); i++) {
    add('Correction', {
      id: `perf-corr-${i}`,
      content: `${pick(rng, ['stop', 'remember to', 'you forgot to'] as const)} ${sentence(rng, 5, 12)}`
    })
  }

  // Tags — index 0 is the global tag (§18 read-path step 1 needs one).
  const tagCount = count('Tag')
  for (let i = 0; i < tagCount; i++) {
    add('Tag', {
      id: `perf-tag-${i}`,
      name: i === 0 ? 'global' : `${pick(rng, WORD_POOL)}-${i}`,
      is_global: i === 0
    })
  }

  // MCPs / Plugins.
  for (let i = 0; i < count('MCP'); i++) {
    add('MCP', { id: `perf-mcp-${i}`, name: `${pick(rng, WORD_POOL)} server`, config_ref: `mcp/perf-${i}.json` })
  }
  for (let i = 0; i < count('Plugin'); i++) {
    add('Plugin', { id: `perf-plug-${i}`, name: `${pick(rng, WORD_POOL)} plugin`, config_ref: `plugins/perf-${i}.json` })
  }

  // ── Edges (all REL_TABLES-valid pairs; deduped) ────────────────────────────
  const edges: EdgeRow[] = []
  const seen = new Set<string>()
  const addEdge = (
    type: EdgeType,
    fromLabel: NodeLabel,
    fromId: string,
    toLabel: NodeLabel,
    toId: string
  ): void => {
    const key = `${type}|${fromId}|${toId}`
    if (seen.has(key)) return
    seen.add(key)
    edges.push({ type, fromLabel, fromId, toLabel, toId })
  }

  const knowledgeCount = count('Knowledge')
  const projectCount = count('Project')
  const componentCount = count('Component')
  const sessionCount = count('Session')
  const documentCount = count('Document')
  const skillCount = count('Skill')
  const preferenceCount = count('Preference')
  const exampleCount = count('Example')
  const correctionCount = count('Correction')
  const mcpCount = count('MCP')
  const pluginCount = count('Plugin')
  // Tiny scaled shapes may only have the global tag — then it takes the traffic.
  const nonGlobalTag = (): string => (tagCount >= 2 ? `perf-tag-${int(rng, 1, tagCount - 1)}` : 'perf-tag-0')

  // HAS_CHUNK: every Knowledge chunk belongs to one Document.
  for (let i = 0; i < knowledgeCount; i++) {
    addEdge('HAS_CHUNK', 'Document', `perf-doc-${int(rng, 0, documentCount - 1)}`, 'Knowledge', `perf-k-${i}`)
  }
  // HAS_COMPONENT: every Component belongs to one Project.
  for (let i = 0; i < componentCount; i++) {
    addEdge('HAS_COMPONENT', 'Project', `perf-proj-${int(rng, 0, projectCount - 1)}`, 'Component', `perf-c-${i}`)
  }
  // DEPENDS_ON / CONNECTS_TO: random component wiring (no self-loops).
  for (let i = 0; i < componentCount * 0.8; i++) {
    const a = int(rng, 0, componentCount - 1)
    const b = int(rng, 0, componentCount - 1)
    if (a !== b) addEdge('DEPENDS_ON', 'Component', `perf-c-${a}`, 'Component', `perf-c-${b}`)
  }
  for (let i = 0; i < componentCount * 0.25; i++) {
    const a = int(rng, 0, componentCount - 1)
    const b = int(rng, 0, componentCount - 1)
    if (a !== b) addEdge('CONNECTS_TO', 'Component', `perf-c-${a}`, 'Component', `perf-c-${b}`)
  }
  // TAGGED: every Project + Skill, and ~25% of Knowledge.
  for (let i = 0; i < projectCount; i++) addEdge('TAGGED', 'Project', `perf-proj-${i}`, 'Tag', nonGlobalTag())
  for (let i = 0; i < skillCount; i++) addEdge('TAGGED', 'Skill', `perf-s-${i}`, 'Tag', nonGlobalTag())
  for (let i = 0; i < knowledgeCount; i++) {
    if (chance(rng, 0.25)) addEdge('TAGGED', 'Knowledge', `perf-k-${i}`, 'Tag', nonGlobalTag())
  }
  // APPLIES_TO: the 3 global preferences, then every preference on 1-2 tags.
  for (let i = 0; i < Math.min(3, preferenceCount); i++) {
    addEdge('APPLIES_TO', 'Preference', `perf-pref-${i}`, 'Tag', 'perf-tag-0')
  }
  for (let i = 3; i < preferenceCount; i++) {
    addEdge('APPLIES_TO', 'Preference', `perf-pref-${i}`, 'Tag', nonGlobalTag())
    if (chance(rng, 0.2)) addEdge('APPLIES_TO', 'Preference', `perf-pref-${i}`, 'Tag', nonGlobalTag())
  }
  // PRODUCED / USED: session backbone.
  for (let i = 0; i < sessionCount; i++) {
    addEdge('PRODUCED', 'Session', `perf-sess-${i}`, 'Project', `perf-proj-${int(rng, 0, projectCount - 1)}`)
    addEdge('USED', 'Session', `perf-sess-${i}`, 'Skill', `perf-s-${int(rng, 0, skillCount - 1)}`)
    if (chance(rng, 0.5)) addEdge('USED', 'Session', `perf-sess-${i}`, 'Skill', `perf-s-${int(rng, 0, skillCount - 1)}`)
    if (chance(rng, 0.5)) addEdge('USED', 'Session', `perf-sess-${i}`, 'MCP', `perf-mcp-${int(rng, 0, mcpCount - 1)}`)
    if (chance(rng, 0.3)) addEdge('USED', 'Session', `perf-sess-${i}`, 'Plugin', `perf-plug-${int(rng, 0, pluginCount - 1)}`)
  }
  // USES: project → tools.
  for (let i = 0; i < projectCount; i++) {
    const skills = int(rng, 2, 4)
    for (let j = 0; j < skills; j++) {
      addEdge('USES', 'Project', `perf-proj-${i}`, 'Skill', `perf-s-${int(rng, 0, skillCount - 1)}`)
    }
    addEdge('USES', 'Project', `perf-proj-${i}`, 'MCP', `perf-mcp-${int(rng, 0, mcpCount - 1)}`)
    if (chance(rng, 0.5)) addEdge('USES', 'Project', `perf-proj-${i}`, 'Plugin', `perf-plug-${int(rng, 0, pluginCount - 1)}`)
  }
  // HAS_VERSION: skill i → its version i.
  for (let i = 0; i < Math.min(skillCount, skillVersionCount); i++) {
    addEdge('HAS_VERSION', 'Skill', `perf-s-${i}`, 'SkillVersion', `perf-sv-${i}`)
  }
  // HAS_EXAMPLE: every Example hangs off one Skill.
  for (let i = 0; i < exampleCount; i++) {
    addEdge('HAS_EXAMPLE', 'Skill', `perf-s-${int(rng, 0, skillCount - 1)}`, 'Example', `perf-ex-${i}`)
  }
  // Corrections: OBSERVED_IN a session, IMPROVED a skill.
  for (let i = 0; i < correctionCount; i++) {
    addEdge('OBSERVED_IN', 'Correction', `perf-corr-${i}`, 'Session', `perf-sess-${int(rng, 0, sessionCount - 1)}`)
    addEdge('IMPROVED', 'Correction', `perf-corr-${i}`, 'Skill', `perf-s-${int(rng, 0, skillCount - 1)}`)
  }
  // DERIVED_FROM: some preferences trace back to a correction.
  for (let i = 0; i < correctionCount * 2; i++) {
    addEdge(
      'DERIVED_FROM',
      'Preference',
      `perf-pref-${int(rng, 0, preferenceCount - 1)}`,
      'Correction',
      `perf-corr-${int(rng, 0, correctionCount - 1)}`
    )
  }
  // EXTRACTED_FROM: provenance edges for the extraction-stamped nodes.
  for (const id of extractedPreferences) {
    addEdge('EXTRACTED_FROM', 'Preference', id, 'Session', `perf-sess-${int(rng, 0, sessionCount - 1)}`)
  }
  for (const id of extractedComponents) {
    addEdge('EXTRACTED_FROM', 'Component', id, 'Session', `perf-sess-${int(rng, 0, sessionCount - 1)}`)
  }

  return { nodes, edges, themedIds, sanityProbes }
}

// ── Write strategies ─────────────────────────────────────────────────────────

/** One multi-pattern parameterized CREATE for a same-label batch of rows. */
async function createNodeBatch(tx: WriteTx, label: NodeLabel, rows: readonly NodeRow[]): Promise<void> {
  const params: Record<string, unknown> = { now: NOW_ISO }
  const patterns = rows.map((row, i) => {
    const fragments = ['created_at: timestamp($now)', 'updated_at: timestamp($now)']
    for (const [name, value] of Object.entries(row.props)) {
      if (value === undefined || value === null) continue
      const type = COLUMN_TYPES[name]
      if (!type) throw new Error(`perf-seed: no column type registered for ${label}.${name}`)
      const key = `${name}_${i}`
      params[key] = value
      if (type === 'TIMESTAMP') fragments.push(`${name}: timestamp($${key})`)
      else if (type === 'EMBEDDING') fragments.push(`${name}: CAST($${key} AS FLOAT[${EMBEDDING_DIM}])`)
      else fragments.push(`${name}: $${key}`)
    }
    return `(:${label} {${fragments.join(', ')}})`
  })
  await tx.cypher(`CREATE ${patterns.join(', ')}`, params)
}

/** UNWIND + list_element batch insert for one (type, fromLabel, toLabel) group. */
async function createEdgeBatch(tx: WriteTx, group: readonly EdgeRow[]): Promise<void> {
  const { type, fromLabel, toLabel } = group[0] as EdgeRow
  const idx: number[] = []
  const fs: string[] = []
  const ts: string[] = []
  for (const [i, edge] of group.entries()) {
    idx.push(i + 1) // list_element is 1-based
    fs.push(edge.fromId)
    ts.push(edge.toId)
  }
  await tx.cypher(
    `UNWIND $idx AS i ` +
      `MATCH (a:${fromLabel} {id: list_element($fs, i)}), (b:${toLabel} {id: list_element($ts, i)}) ` +
      `CREATE (a)-[:${type} {created_at: timestamp($now), updated_at: timestamp($now)}]->(b)`,
    { idx, fs, ts, now: NOW_ISO }
  )
}

function chunk<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size))
  return out
}

// ── Verification helpers ─────────────────────────────────────────────────────

/** Plain JS cosine distance — ground truth for the sanity diagnostics. */
function cosineDistance(a: readonly number[], b: readonly number[]): number {
  let dot = 0
  let na = 0
  let nb = 0
  for (let i = 0; i < a.length; i++) {
    const x = a[i] as number
    const y = b[i] as number
    dot += x * y
    na += x * x
    nb += y * y
  }
  if (na === 0 || nb === 0) return 1
  return 1 - dot / Math.sqrt(na * nb)
}

/** Deterministic distinct sample of `count` indexes into [0, size). */
function sampleIndexes(rng: Rng, size: number, count: number): number[] {
  const picked = new Set<number>()
  const want = Math.min(count, size)
  while (picked.size < want) picked.add(Math.floor(rng() * size))
  return [...picked]
}

/**
 * Read sampled rows back and compare every property against the generated
 * value (embeddings elementwise at float32 tolerance). Catches silent
 * mis-binding — this is the check that caught the driver's LIST-type fault.
 */
async function verifySampledRows(
  engine: StorageEngine,
  label: NodeLabel,
  rows: readonly NodeRow[],
  rng: Rng
): Promise<void> {
  const samples = sampleIndexes(rng, rows.length, 10).map((i) => rows[i] as NodeRow)
  const propNames = new Set<string>()
  for (const s of samples) {
    for (const key of Object.keys(s.props)) if (key !== 'id') propNames.add(key)
  }
  const cols = [...propNames]
  const back = await engine.cypher(
    `UNWIND $ids AS nid MATCH (n:${label} {id: nid}) RETURN n.id AS id${cols
      .map((c) => `, n.${c} AS ${c}`)
      .join('')}`,
    { ids: samples.map((s) => s.props['id']) }
  )
  const byId = new Map(back.map((r) => [String(r['id']), r]))
  for (const s of samples) {
    const id = s.props['id'] as string
    const row = byId.get(id)
    if (!row) throw new Error(`seedPerfGraph verify: ${label} ${id} missing after seed`)
    for (const name of cols) {
      const expected = s.props[name]
      const actual = row[name]
      const fail = (detail: string): never => {
        throw new Error(`seedPerfGraph verify: ${label} ${id}.${name} mismatch — ${detail}`)
      }
      if (expected === undefined || expected === null) {
        if (actual !== null && actual !== undefined) fail(`expected NULL, stored ${String(actual)}`)
        continue
      }
      const type = COLUMN_TYPES[name] as ColType
      if (type === 'EMBEDDING') {
        const exp = expected as number[]
        if (!Array.isArray(actual) || actual.length !== exp.length) {
          fail(`stored embedding is ${Array.isArray(actual) ? `len ${actual.length}` : String(actual)}`)
        }
        const got = actual as number[]
        for (let d = 0; d < exp.length; d++) {
          const g = got[d] as number
          const e = Math.fround(exp[d] as number)
          if (Math.abs(g - e) > 1e-6) {
            fail(`dim ${d}: stored ${g} vs generated ${e} (driver LIST-binding fault?)`)
          }
        }
      } else if (type === 'TIMESTAMP') {
        const gotMs = actual instanceof Date ? actual.getTime() : Date.parse(String(actual))
        if (gotMs !== Date.parse(expected as string)) fail(`stored ${String(actual)} vs ${String(expected)}`)
      } else if (type === 'DOUBLE') {
        if (Math.abs(Number(actual) - Number(expected)) > 1e-9) fail(`stored ${String(actual)} vs ${String(expected)}`)
      } else if (actual !== expected) {
        fail(`stored ${String(actual)} vs ${String(expected)}`)
      }
    }
  }
}

/** MATCH sampled edges by exact endpoints — catches endpoint mis-attribution. */
async function verifySampledEdges(engine: StorageEngine, edges: readonly EdgeRow[], rng: Rng): Promise<void> {
  for (const i of sampleIndexes(rng, edges.length, 40)) {
    const e = edges[i] as EdgeRow
    const rows = await engine.cypher(
      `MATCH (a:${e.fromLabel} {id: $f})-[r:${e.type}]->(b:${e.toLabel} {id: $t}) RETURN count(r) AS c`,
      { f: e.fromId, t: e.toId }
    )
    if (Number(rows[0]?.['c'] ?? 0) !== 1) {
      throw new Error(
        `seedPerfGraph verify: edge (${e.fromLabel}:${e.fromId})-[:${e.type}]->(${e.toLabel}:${e.toId}) ` +
          `not found exactly once after seed`
      )
    }
  }
}

/**
 * When a vector-index sanity probe fails, distinguish the possible faults
 * before throwing: stored rows wrong (write/binding bug) vs rows correct but
 * the HNSW index mis-attributing vectors (the insert-after-index-creation
 * misbehavior under investigation). Reads disputed rows back and recomputes
 * distances in JS.
 */
async function diagnoseSanityFailure(
  engine: StorageEngine,
  probe: SanityProbe,
  queryEmbedding: readonly number[],
  hits: readonly { id: string; distance: number }[],
  generated: ReadonlyMap<string, readonly number[]>
): Promise<string> {
  const textColumn = probe.label === 'Preference' ? 'statement' : 'content'
  const ids = [probe.id, ...hits.map((h) => h.id)]
  const rows = await engine.cypher(
    `UNWIND $ids AS nid MATCH (n:${probe.label} {id: nid}) RETURN n.id AS id, n.${textColumn} AS text, n.embedding AS embedding`,
    { ids }
  )
  const lines: string[] = []
  for (const row of rows) {
    const id = String(row['id'])
    const embedding = row['embedding'] as number[] | null
    const text = String(row['text'] ?? '')
    if (!embedding) {
      lines.push(`  ${id}: stored embedding is NULL (text "${text.slice(0, 60)}")`)
      continue
    }
    lines.push(
      `  ${id}: js-distance(query, stored)=${cosineDistance(queryEmbedding, embedding).toFixed(6)} ` +
        `js-distance(query, embed(text))=${cosineDistance(queryEmbedding, perfTextEmbedding(text)).toFixed(6)}`
    )
    const gen = generated.get(id)
    if (gen) {
      let bestId = ''
      let bestDist = Number.POSITIVE_INFINITY
      for (const [gid, gvec] of generated) {
        const dist = cosineDistance(embedding, gvec)
        if (dist < bestDist) {
          bestDist = dist
          bestId = gid
        }
      }
      lines.push(
        `    vs own generated vector: ${cosineDistance(embedding, gen).toFixed(6)}; ` +
          `closest generated vector: ${bestId} at ${bestDist.toFixed(6)}`
      )
    }
  }
  lines.push(
    '  interpretation: stored ≈ embed(text) with false hits far away ⇒ rows are fine and the HNSW',
    '  index is mis-attributing vectors (index-maintenance fault); stored disagreeing with its own',
    '  text/generated vector ⇒ the write/binding path corrupted the row.'
  )
  return lines.join('\n')
}

// ── Entry point ──────────────────────────────────────────────────────────────

export async function seedPerfGraph(engine: StorageEngine, options: SeedPerfGraphOptions): Promise<PerfSeedResult> {
  if (!Number.isSafeInteger(options.nodes) || options.nodes < 100) {
    throw new Error(`seedPerfGraph: nodes must be an integer ≥ 100, got ${options.nodes}`)
  }
  const started = performance.now()
  const graph = generateGraph(options)

  // Group nodes by label (batches must share a label) and edges by table.
  const nodesByLabelRows = new Map<NodeLabel, NodeRow[]>()
  for (const row of graph.nodes) {
    const list = nodesByLabelRows.get(row.label) ?? []
    list.push(row)
    nodesByLabelRows.set(row.label, list)
  }
  const edgeGroups = new Map<string, EdgeRow[]>()
  for (const edge of graph.edges) {
    const key = `${edge.type}|${edge.fromLabel}|${edge.toLabel}`
    const list = edgeGroups.get(key) ?? []
    list.push(edge)
    edgeGroups.set(key, list)
  }

  let nodeStrategy: PerfSeedResult['nodeStrategy'] = 'batched-create'
  let edgeStrategy: PerfSeedResult['edgeStrategy'] = 'batched-unwind'

  await engine.withWrite(async (tx) => {
    // Nodes first (edges MATCH their endpoints).
    for (const [label, rows] of nodesByLabelRows) {
      const batchSize = rows.some((r) => r.props['embedding'] !== undefined)
        ? NODE_BATCH_EMBEDDED
        : NODE_BATCH_PLAIN
      for (const batch of chunk(rows, batchSize)) {
        if (nodeStrategy === 'batched-create') {
          try {
            await createNodeBatch(tx, label, batch)
            continue
          } catch {
            // Driver refused the batched shape — a failed statement commits
            // nothing (auto-commit is per statement), so redo this batch
            // through the per-node engine path and stay there.
            nodeStrategy = 'per-node-upsert'
          }
        }
        for (const row of batch) await tx.upsertNode(row.label, row.props)
      }
    }
    for (const group of edgeGroups.values()) {
      for (const batch of chunk(group, EDGE_BATCH)) {
        if (edgeStrategy === 'batched-unwind') {
          try {
            await createEdgeBatch(tx, batch)
            continue
          } catch {
            edgeStrategy = 'per-edge-merge'
          }
        }
        for (const e of batch) {
          await tx.createEdge(e.type, { label: e.fromLabel, id: e.fromId }, { label: e.toLabel, id: e.toId })
        }
      }
    }
  })

  // ── Verification (nothing is assumed written) ──────────────────────────────
  const verifyRng = mulberry32(fnv1a(`${options.seed}:verify`))

  const nodesByLabel: Record<string, number> = {}
  let nodeCount = 0
  for (const [label, rows] of nodesByLabelRows) {
    const dbRows = await engine.cypher(`MATCH (n:${label}) RETURN count(n) AS c`)
    const c = Number(dbRows[0]?.['c'] ?? 0)
    if (c !== rows.length) {
      throw new Error(`seedPerfGraph: ${label} count mismatch — generated ${rows.length}, DB has ${c}`)
    }
    nodesByLabel[label] = c
    nodeCount += c
  }
  const edgeRows = await engine.cypher('MATCH ()-[r]->() RETURN count(r) AS c')
  const edgeCount = Number(edgeRows[0]?.['c'] ?? 0)
  if (edgeCount !== graph.edges.length) {
    throw new Error(
      `seedPerfGraph: edge count mismatch — generated ${graph.edges.length}, DB has ${edgeCount} ` +
        '(a batched edge statement may have silently matched no endpoints)'
    )
  }
  const edgesByType: Record<string, number> = {}
  for (const edge of graph.edges) edgesByType[edge.type] = (edgesByType[edge.type] ?? 0) + 1

  for (const [label, rows] of nodesByLabelRows) await verifySampledRows(engine, label, rows, verifyRng)
  await verifySampledEdges(engine, graph.edges, verifyRng)

  // Vector-index sanity (the insert-after-index-creation suspicion): querying
  // with a seeded node's EXACT embedding must return that node at ~0 distance,
  // proving the HNSW indexes serve the freshly inserted vectors.
  let worstProbeDistance = 0
  for (const probe of graph.sanityProbes) {
    const queryEmbedding = perfTextEmbedding(probe.text)
    const hits = await engine.vectorSearch(probe.label, queryEmbedding, 3)
    const hit = hits.find((h) => h.id === probe.id)
    if (!hit || hit.distance > 0.001) {
      const generatedEmbeddings = new Map<string, readonly number[]>()
      for (const row of nodesByLabelRows.get(probe.label) ?? []) {
        const e = row.props['embedding']
        if (Array.isArray(e)) generatedEmbeddings.set(row.props['id'] as string, e as number[])
      }
      const diagnosis = await diagnoseSanityFailure(engine, probe, queryEmbedding, hits, generatedEmbeddings)
      throw new Error(
        `seedPerfGraph: vector-index sanity FAILED — exact-embedding search for ${probe.label} ${probe.id} ` +
          `returned ${JSON.stringify(hits)} (expected that id at distance < 0.001). ` +
          'This smells like the insert-after-index-creation misbehavior under investigation.\n' +
          `diagnostics:\n${diagnosis}`
      )
    }
    worstProbeDistance = Math.max(worstProbeDistance, hit.distance)
  }

  return {
    nodeCount,
    edgeCount,
    seedMs: performance.now() - started,
    nodesByLabel,
    edgesByType,
    themedIds: graph.themedIds,
    nodeStrategy,
    edgeStrategy,
    sanityVectorDistance: worstProbeDistance
  }
}
