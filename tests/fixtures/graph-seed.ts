/**
 * Fixture graph for the phase-03 retrieval tests (phase doc: "~40 nodes
 * covering every retrievable label + relationships" — this seeds 48 nodes
 * covering all 13 node labels and all 15 edge types).
 *
 * Two toy worlds with disjoint vocabularies so golden queries have clean
 * targets:
 *   - "aurora storefront": an ecommerce project (frontend flavored)
 *   - "comet telemetry": a data-pipeline project (database flavored)
 *
 * Retrievable nodes get deterministic bag-of-words hash embeddings
 * (fakeTextEmbedding) — cosine similarity then approximates lexical overlap,
 * so the vector arm behaves realistically offline. FTS content uses robust
 * alphabetic words only (phase-01 finding 8: the tokenizer drops some tokens
 * and strips digits).
 */
import { EMBEDDING_DIM } from '../../src/main/config'
import type { EdgeType, NodeLabel, StorageEngine } from '../../src/main/storage'

// ── Deterministic fake embeddings ────────────────────────────────────────────

/** Lowercase word tokens with a naive plural-strip, shared by all fakes. */
export function tokenizeForFake(text: string): string[] {
  const words = text.toLowerCase().match(/[a-z]+/g) ?? []
  return words.map((w) => (w.length > 3 && w.endsWith('s') ? w.slice(0, -1) : w))
}

function fnv1a(text: string): number {
  let hash = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash >>> 0
}

/** Bag-of-words hash embedding: cosine similarity ≈ word overlap. */
export function fakeTextEmbedding(text: string): number[] {
  const v = new Array<number>(EMBEDDING_DIM).fill(0)
  const tokens = tokenizeForFake(text)
  if (tokens.length === 0) {
    v[0] = 1
    return v
  }
  for (const token of tokens) v[fnv1a(token) % EMBEDDING_DIM]! += 1
  const norm = Math.hypot(...v)
  return v.map((x) => x / norm)
}

// ── Fixture data ─────────────────────────────────────────────────────────────

interface FixtureNode {
  label: NodeLabel
  props: Record<string, unknown>
  /** Text embedded for retrievable labels (matches what retrieval renders). */
  embedText?: string
}

const N = (label: NodeLabel, props: Record<string, unknown>, embedText?: string): FixtureNode =>
  embedText === undefined ? { label, props } : { label, props, embedText }

export const FIXTURE_NODES: readonly FixtureNode[] = [
  // Sessions (2)
  N('Session', {
    id: 'sess-alpha',
    started_at: '2026-06-28T09:00:00Z',
    ended_at: '2026-06-28T11:30:00Z',
    transcript_ref: 'transcripts/sess-alpha.jsonl'
  }),
  N('Session', {
    id: 'sess-beta',
    started_at: '2026-06-29T14:00:00Z',
    ended_at: '2026-06-29T16:45:00Z',
    transcript_ref: 'transcripts/sess-beta.jsonl'
  }),

  // Projects (2)
  N(
    'Project',
    {
      id: 'p-aurora',
      name: 'aurora storefront',
      summary: 'ecommerce storefront selling ceramic pottery with catalog and checkout pages'
    },
    'aurora storefront — ecommerce storefront selling ceramic pottery with catalog and checkout pages'
  ),
  N(
    'Project',
    {
      id: 'p-comet',
      name: 'comet telemetry',
      summary: 'telemetry ingestion pipeline aggregating sensor readings into the postgres warehouse'
    },
    'comet telemetry — telemetry ingestion pipeline aggregating sensor readings into the postgres warehouse'
  ),

  // Skills (4)
  N(
    'Skill',
    {
      id: 's-deploy',
      name: 'deploy storefront',
      instructions: 'build the storefront bundle and publish it to vercel hosting then verify the checkout flow',
      current_version: 'sv-deploy-active'
    },
    'deploy storefront: build the storefront bundle and publish it to vercel hosting then verify the checkout flow'
  ),
  N(
    'Skill',
    {
      id: 's-migrate',
      name: 'postgres migration',
      instructions: 'write reversible sql migration scripts for the postgres warehouse and take a backup before applying',
      current_version: 'sv-migrate-active'
    },
    'postgres migration: write reversible sql migration scripts for the postgres warehouse and take a backup before applying'
  ),
  N(
    'Skill',
    {
      id: 's-review',
      name: 'review pull request',
      instructions: 'inspect diffs for regressions run linters and the vitest suite before approving',
      current_version: 'sv-none'
    },
    'review pull request: inspect diffs for regressions run linters and the vitest suite before approving'
  ),
  N(
    'Skill',
    {
      id: 's-charts',
      name: 'render charts',
      instructions: 'compose dashboard charts from telemetry aggregates using accessible color palettes',
      current_version: 'sv-charts-active'
    },
    'render charts: compose dashboard charts from telemetry aggregates using accessible color palettes'
  ),

  // SkillVersions (4)
  N('SkillVersion', {
    id: 'sv-deploy-active',
    status: 'active',
    benchmark_score: 0.91,
    instructions: 'build the storefront bundle publish to vercel and verify checkout with the smoke suite'
  }),
  N('SkillVersion', {
    id: 'sv-deploy-retired',
    status: 'retired',
    benchmark_score: 0.62,
    instructions: 'publish the storefront by copying files to the server manually'
  }),
  N('SkillVersion', {
    id: 'sv-migrate-active',
    status: 'active',
    benchmark_score: 0.88,
    instructions: 'write reversible sql migrations take a warehouse backup first then apply and validate row counts'
  }),
  N('SkillVersion', {
    id: 'sv-charts-active',
    status: 'active',
    benchmark_score: 0.8,
    instructions: 'compose charts with the approved accessible palette and label every axis'
  }),

  // Examples (6 — four on s-deploy so the recent-examples cap is exercised)
  N('Example', {
    id: 'ex-deploy-win',
    kind: 'success',
    content: 'storefront deploy succeeded after the checkout smoke suite passed on the preview environment'
  }),
  N('Example', {
    id: 'ex-deploy-fail',
    kind: 'failure',
    content: 'deploy failed because the payment gateway sandbox keys were absent from staging'
  }),
  N('Example', {
    id: 'ex-deploy-cache',
    kind: 'success',
    content: 'purging the cache after publish fixed the stale catalog listings'
  }),
  N('Example', {
    id: 'ex-deploy-rollback',
    kind: 'failure',
    content: 'a rollback was needed when the checkout flow broke after publish'
  }),
  N('Example', {
    id: 'ex-migrate-fail',
    kind: 'failure',
    content: 'the migration locked the warehouse because autovacuum was off during the deploy window'
  }),
  N('Example', {
    id: 'ex-charts-win',
    kind: 'success',
    content: 'the quarterly dashboard shipped with a colorblind safe palette'
  }),

  // Corrections (2)
  N('Correction', {
    id: 'corr-css',
    content: 'stop writing custom css files use tailwind utility classes instead'
  }),
  N('Correction', {
    id: 'corr-backup',
    content: 'you forgot the warehouse backup before applying the migration'
  }),

  // Preferences (6 — two on the global tag)
  N(
    'Preference',
    { id: 'pref-global-reasoning', statement: 'always explain the reasoning briefly before giving the final answer' },
    'always explain the reasoning briefly before giving the final answer'
  ),
  N(
    'Preference',
    { id: 'pref-global-tests', statement: 'always run the full test suite before declaring any work finished' },
    'always run the full test suite before declaring any work finished'
  ),
  N(
    'Preference',
    {
      id: 'pref-css',
      statement: 'prefer tailwind utility classes over custom css files',
      extracted_by: 'extraction@0.1/llm-local',
      confidence: 0.9
    },
    'prefer tailwind utility classes over custom css files'
  ),
  N(
    'Preference',
    { id: 'pref-naming', statement: 'database tables use snake case plural names in the warehouse' },
    'database tables use snake case plural names in the warehouse'
  ),
  N(
    'Preference',
    {
      id: 'pref-backup',
      statement: 'take a warehouse backup before destructive database operations',
      extracted_by: 'extraction@0.1/llm-local',
      confidence: 0.85
    },
    'take a warehouse backup before destructive database operations'
  ),
  N(
    'Preference',
    { id: 'pref-palette', statement: 'charts must remain readable for colorblind viewers' },
    'charts must remain readable for colorblind viewers'
  ),

  // MCPs (2) + Plugins (1)
  N('MCP', { id: 'mcp-github', name: 'github', config_ref: 'mcp/github.json' }),
  N('MCP', { id: 'mcp-vercel', name: 'vercel deployment', config_ref: 'mcp/vercel.json' }),
  N('Plugin', { id: 'plug-playwright', name: 'playwright browser runner', config_ref: 'plugins/playwright.json' }),

  // Components (5)
  N('Component', { id: 'c-checkout', name: 'checkout page', type: 'page' }),
  N('Component', { id: 'c-catalog', name: 'catalog page', type: 'page' }),
  N('Component', {
    id: 'c-gateway',
    name: 'payment gateway client',
    type: 'service',
    extracted_by: 'codebase-ingest@0.1',
    confidence: 1
  }),
  N('Component', { id: 'c-ingest', name: 'sensor ingest worker', type: 'service' }),
  N('Component', { id: 'c-rollup', name: 'rollup aggregator', type: 'service' }),

  // Documents (2)
  N('Document', {
    id: 'doc-runbook',
    source: 'docs/storefront-runbook.md',
    content_hash: 'hash-runbook',
    ingested_at: '2026-06-25T08:00:00Z'
  }),
  N('Document', {
    id: 'doc-warehouse',
    source: 'docs/warehouse-handbook.md',
    content_hash: 'hash-warehouse',
    ingested_at: '2026-06-26T08:00:00Z'
  }),

  // Knowledge (8)
  N(
    'Knowledge',
    { id: 'k-vercel', content: 'storefront deploys run through vercel with preview environments for every branch' },
    'storefront deploys run through vercel with preview environments for every branch'
  ),
  N(
    'Knowledge',
    { id: 'k-checkout', content: 'the checkout flow requires payment gateway sandbox keys during staging verification' },
    'the checkout flow requires payment gateway sandbox keys during staging verification'
  ),
  N(
    'Knowledge',
    { id: 'k-catalog', content: 'catalog pages render pottery listings with server side pagination' },
    'catalog pages render pottery listings with server side pagination'
  ),
  N(
    'Knowledge',
    { id: 'k-vacuum', content: 'postgres autovacuum settings need tuning when warehouse ingest volume spikes' },
    'postgres autovacuum settings need tuning when warehouse ingest volume spikes'
  ),
  N(
    'Knowledge',
    { id: 'k-partition', content: 'sensor readings land in daily partitions and compact weekly inside the warehouse' },
    'sensor readings land in daily partitions and compact weekly inside the warehouse'
  ),
  N(
    'Knowledge',
    { id: 'k-retention', content: 'telemetry retention keeps ninety days of raw readings before rollup' },
    'telemetry retention keeps ninety days of raw readings before rollup'
  ),
  N(
    'Knowledge',
    { id: 'k-lint', content: 'linting rules forbid default exports across the repository' },
    'linting rules forbid default exports across the repository'
  ),
  N(
    'Knowledge',
    { id: 'k-palette', content: 'the approved chart palette avoids red green combinations entirely' },
    'the approved chart palette avoids red green combinations entirely'
  ),

  // Tags (4 — one global)
  N('Tag', { id: 'tag-global', name: 'global', is_global: true }),
  N('Tag', { id: 'tag-frontend', name: 'frontend', is_global: false }),
  N('Tag', { id: 'tag-database', name: 'database', is_global: false }),
  N('Tag', { id: 'tag-charts', name: 'charts', is_global: false })
]

type FixtureEdge = readonly [EdgeType, NodeLabel, string, NodeLabel, string]

export const FIXTURE_EDGES: readonly FixtureEdge[] = [
  // PRODUCED + USED (session backbone)
  ['PRODUCED', 'Session', 'sess-alpha', 'Project', 'p-aurora'],
  ['PRODUCED', 'Session', 'sess-beta', 'Project', 'p-comet'],
  ['USED', 'Session', 'sess-alpha', 'Skill', 's-deploy'],
  ['USED', 'Session', 'sess-alpha', 'MCP', 'mcp-vercel'],
  ['USED', 'Session', 'sess-alpha', 'Plugin', 'plug-playwright'],
  ['USED', 'Session', 'sess-beta', 'Skill', 's-migrate'],
  // USES (project → tools)
  ['USES', 'Project', 'p-aurora', 'Skill', 's-deploy'],
  ['USES', 'Project', 'p-aurora', 'Skill', 's-review'],
  ['USES', 'Project', 'p-aurora', 'MCP', 'mcp-vercel'],
  ['USES', 'Project', 'p-aurora', 'MCP', 'mcp-github'],
  ['USES', 'Project', 'p-aurora', 'Plugin', 'plug-playwright'],
  ['USES', 'Project', 'p-comet', 'Skill', 's-migrate'],
  ['USES', 'Project', 'p-comet', 'Skill', 's-charts'],
  ['USES', 'Project', 'p-comet', 'MCP', 'mcp-github'],
  // HAS_COMPONENT / DEPENDS_ON / CONNECTS_TO
  ['HAS_COMPONENT', 'Project', 'p-aurora', 'Component', 'c-checkout'],
  ['HAS_COMPONENT', 'Project', 'p-aurora', 'Component', 'c-catalog'],
  ['HAS_COMPONENT', 'Project', 'p-aurora', 'Component', 'c-gateway'],
  ['HAS_COMPONENT', 'Project', 'p-comet', 'Component', 'c-ingest'],
  ['HAS_COMPONENT', 'Project', 'p-comet', 'Component', 'c-rollup'],
  ['DEPENDS_ON', 'Component', 'c-checkout', 'Component', 'c-gateway'],
  ['DEPENDS_ON', 'Component', 'c-rollup', 'Component', 'c-ingest'],
  ['CONNECTS_TO', 'Component', 'c-catalog', 'Component', 'c-checkout'],
  // HAS_VERSION / HAS_EXAMPLE
  ['HAS_VERSION', 'Skill', 's-deploy', 'SkillVersion', 'sv-deploy-active'],
  ['HAS_VERSION', 'Skill', 's-deploy', 'SkillVersion', 'sv-deploy-retired'],
  ['HAS_VERSION', 'Skill', 's-migrate', 'SkillVersion', 'sv-migrate-active'],
  ['HAS_VERSION', 'Skill', 's-charts', 'SkillVersion', 'sv-charts-active'],
  ['HAS_EXAMPLE', 'Skill', 's-deploy', 'Example', 'ex-deploy-win'],
  ['HAS_EXAMPLE', 'Skill', 's-deploy', 'Example', 'ex-deploy-fail'],
  ['HAS_EXAMPLE', 'Skill', 's-deploy', 'Example', 'ex-deploy-cache'],
  ['HAS_EXAMPLE', 'Skill', 's-deploy', 'Example', 'ex-deploy-rollback'],
  ['HAS_EXAMPLE', 'Skill', 's-migrate', 'Example', 'ex-migrate-fail'],
  ['HAS_EXAMPLE', 'Skill', 's-charts', 'Example', 'ex-charts-win'],
  // Corrections
  ['OBSERVED_IN', 'Correction', 'corr-css', 'Session', 'sess-alpha'],
  ['OBSERVED_IN', 'Correction', 'corr-backup', 'Session', 'sess-beta'],
  ['IMPROVED', 'Correction', 'corr-css', 'Skill', 's-deploy'],
  ['IMPROVED', 'Correction', 'corr-backup', 'Skill', 's-migrate'],
  ['DERIVED_FROM', 'Preference', 'pref-css', 'Correction', 'corr-css'],
  ['DERIVED_FROM', 'Preference', 'pref-backup', 'Correction', 'corr-backup'],
  // APPLIES_TO (tag scoping; two preferences on the global tag)
  ['APPLIES_TO', 'Preference', 'pref-global-reasoning', 'Tag', 'tag-global'],
  ['APPLIES_TO', 'Preference', 'pref-global-tests', 'Tag', 'tag-global'],
  ['APPLIES_TO', 'Preference', 'pref-css', 'Tag', 'tag-frontend'],
  ['APPLIES_TO', 'Preference', 'pref-naming', 'Tag', 'tag-database'],
  ['APPLIES_TO', 'Preference', 'pref-backup', 'Tag', 'tag-database'],
  ['APPLIES_TO', 'Preference', 'pref-palette', 'Tag', 'tag-charts'],
  // HAS_CHUNK (document → knowledge)
  ['HAS_CHUNK', 'Document', 'doc-runbook', 'Knowledge', 'k-vercel'],
  ['HAS_CHUNK', 'Document', 'doc-runbook', 'Knowledge', 'k-checkout'],
  ['HAS_CHUNK', 'Document', 'doc-runbook', 'Knowledge', 'k-catalog'],
  ['HAS_CHUNK', 'Document', 'doc-runbook', 'Knowledge', 'k-lint'],
  ['HAS_CHUNK', 'Document', 'doc-warehouse', 'Knowledge', 'k-vacuum'],
  ['HAS_CHUNK', 'Document', 'doc-warehouse', 'Knowledge', 'k-partition'],
  ['HAS_CHUNK', 'Document', 'doc-warehouse', 'Knowledge', 'k-retention'],
  ['HAS_CHUNK', 'Document', 'doc-warehouse', 'Knowledge', 'k-palette'],
  // EXTRACTED_FROM (provenance)
  ['EXTRACTED_FROM', 'Preference', 'pref-css', 'Session', 'sess-alpha'],
  ['EXTRACTED_FROM', 'Preference', 'pref-backup', 'Session', 'sess-beta'],
  ['EXTRACTED_FROM', 'Component', 'c-gateway', 'Session', 'sess-alpha'],
  // TAGGED
  ['TAGGED', 'Project', 'p-aurora', 'Tag', 'tag-frontend'],
  ['TAGGED', 'Skill', 's-deploy', 'Tag', 'tag-frontend'],
  ['TAGGED', 'Knowledge', 'k-vercel', 'Tag', 'tag-frontend'],
  ['TAGGED', 'Project', 'p-comet', 'Tag', 'tag-database'],
  ['TAGGED', 'Skill', 's-migrate', 'Tag', 'tag-database'],
  ['TAGGED', 'Knowledge', 'k-vacuum', 'Tag', 'tag-database'],
  ['TAGGED', 'Knowledge', 'k-partition', 'Tag', 'tag-database'],
  ['TAGGED', 'Skill', 's-charts', 'Tag', 'tag-charts'],
  ['TAGGED', 'Knowledge', 'k-palette', 'Tag', 'tag-charts']
]

/** The two preferences on the global tag — must appear in EVERY bundle (DoD). */
export const GLOBAL_PREFERENCE_IDS = ['pref-global-reasoning', 'pref-global-tests'] as const

/**
 * Seed the fixture into a fresh engine (writes ride the lane, as all writes
 * do). Embeddings default to the deterministic fake; the live test passes the
 * real OllamaClient so the graph holds genuine bge-m3 vectors.
 */
export async function seedFixtureGraph(
  engine: StorageEngine,
  embedder: { embed(texts: string[]): Promise<number[][]> } = {
    embed: async (texts) => texts.map(fakeTextEmbedding)
  }
): Promise<void> {
  const embeddable = FIXTURE_NODES.filter((n) => n.embedText !== undefined)
  const embeddings = await embedder.embed(embeddable.map((n) => n.embedText as string))
  const embeddingById = new Map(embeddable.map((n, i) => [n.props['id'] as string, embeddings[i] as number[]]))
  for (const node of FIXTURE_NODES) {
    const embedding = embeddingById.get(node.props['id'] as string)
    const props = embedding ? { ...node.props, embedding } : node.props
    await engine.upsertNode(node.label, props)
  }
  for (const [type, fromLabel, fromId, toLabel, toId] of FIXTURE_EDGES) {
    await engine.createEdge(type, { label: fromLabel, id: fromId }, { label: toLabel, id: toId })
  }
}
