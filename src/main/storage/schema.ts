/**
 * Graph schema registry — the code form of spec §18 (memory ontology).
 *
 * Single source of truth for node labels, relationship types, their properties
 * and provenance columns; DDL is generated from it, and the engine validates
 * every write against it. No driver imports here.
 *
 * Provenance (§18 "Provenance (v3.1)" + §21 rule 4):
 * - every node and every relationship carries `created_at` / `updated_at`
 *   (stamped by the engine, not by callers);
 * - extraction-written node labels (`Component`, `Preference`, `Knowledge`)
 *   carry `extracted_by` + `confidence` and can have an `EXTRACTED_FROM` edge;
 * - all relationship tables carry nullable `extracted_by` + `confidence` so
 *   any edge the extraction agent writes can be stamped at write time.
 */
import { EMBEDDING_DIM } from '../config'

// ── Node labels ──────────────────────────────────────────────────────────────

export const NODE_LABELS = [
  'Session',
  'Project',
  'Skill',
  'SkillVersion',
  'Example',
  'Correction',
  'Preference',
  'MCP',
  'Plugin',
  'Component',
  'Document',
  'Knowledge',
  'Tag'
] as const
export type NodeLabel = (typeof NODE_LABELS)[number]

/** The four labels carrying a BGE-M3 embedding + full-text index (§18). */
export const RETRIEVABLE_LABELS = ['Project', 'Skill', 'Preference', 'Knowledge'] as const
export type RetrievableLabel = (typeof RETRIEVABLE_LABELS)[number]

/** Node labels written by the extraction agent → provenance columns (§18). */
export const EXTRACTION_WRITTEN_LABELS = ['Component', 'Preference', 'Knowledge'] as const

/** Scalar property types we use; EMBEDDING maps to FLOAT[EMBEDDING_DIM]. */
export type PropertyType = 'STRING' | 'INT64' | 'DOUBLE' | 'BOOLEAN' | 'TIMESTAMP' | 'EMBEDDING'

export interface PropertySpec {
  readonly name: string
  readonly type: PropertyType
  /** Emitted as a DDL DEFAULT clause (string values only). */
  readonly defaultValue?: string
}

export interface NodeTableSpec {
  readonly label: NodeLabel
  /** Domain properties, excluding id/created_at/updated_at/provenance/embedding. */
  readonly properties: readonly PropertySpec[]
  /** Set for the four retrievable labels: which text columns the FTS index covers. */
  readonly ftsProperties?: readonly string[]
  /** True for extraction-written labels (adds extracted_by + confidence). */
  readonly provenance: boolean
}

export const NODE_TABLES: readonly NodeTableSpec[] = [
  {
    label: 'Session',
    properties: [
      { name: 'started_at', type: 'TIMESTAMP' },
      { name: 'ended_at', type: 'TIMESTAMP' },
      { name: 'transcript_ref', type: 'STRING' },
      { name: 'tier', type: 'STRING', defaultValue: 'daily' }
    ],
    provenance: false
  },
  {
    label: 'Project',
    properties: [
      { name: 'name', type: 'STRING' },
      { name: 'summary', type: 'STRING' }
    ],
    ftsProperties: ['name', 'summary'],
    provenance: false
  },
  {
    label: 'Skill',
    properties: [
      { name: 'name', type: 'STRING' },
      { name: 'instructions', type: 'STRING' },
      { name: 'current_version', type: 'STRING' }
    ],
    ftsProperties: ['name', 'instructions'],
    provenance: false
  },
  {
    label: 'SkillVersion',
    properties: [
      { name: 'instructions', type: 'STRING' },
      { name: 'benchmark_score', type: 'DOUBLE' },
      { name: 'status', type: 'STRING' } // candidate | active | retired
    ],
    provenance: false
  },
  {
    label: 'Example',
    properties: [
      { name: 'kind', type: 'STRING' }, // success | failure
      { name: 'content', type: 'STRING' }
    ],
    provenance: false
  },
  {
    label: 'Correction',
    properties: [{ name: 'content', type: 'STRING' }],
    provenance: false
  },
  {
    label: 'Preference',
    properties: [{ name: 'statement', type: 'STRING' }],
    ftsProperties: ['statement'],
    provenance: true
  },
  {
    label: 'MCP',
    properties: [
      { name: 'name', type: 'STRING' },
      { name: 'config_ref', type: 'STRING' }
    ],
    provenance: false
  },
  {
    label: 'Plugin',
    properties: [
      { name: 'name', type: 'STRING' },
      { name: 'config_ref', type: 'STRING' }
    ],
    provenance: false
  },
  {
    label: 'Component',
    properties: [
      { name: 'name', type: 'STRING' },
      { name: 'type', type: 'STRING' } // page | route | model | service | …
    ],
    provenance: true
  },
  {
    label: 'Document',
    properties: [
      { name: 'source', type: 'STRING' },
      { name: 'content_hash', type: 'STRING' },
      { name: 'ingested_at', type: 'TIMESTAMP' }
    ],
    provenance: false
  },
  {
    label: 'Knowledge',
    properties: [{ name: 'content', type: 'STRING' }],
    ftsProperties: ['content'],
    provenance: true
  },
  {
    label: 'Tag',
    properties: [
      { name: 'name', type: 'STRING' },
      { name: 'is_global', type: 'BOOLEAN' }
    ],
    provenance: false
  }
]

// ── Relationship types ───────────────────────────────────────────────────────

export const EDGE_TYPES = [
  'PRODUCED',
  'USED',
  'USES',
  'HAS_COMPONENT',
  'DEPENDS_ON',
  'CONNECTS_TO',
  'HAS_VERSION',
  'HAS_EXAMPLE',
  'OBSERVED_IN',
  'IMPROVED',
  'DERIVED_FROM',
  'APPLIES_TO',
  'HAS_CHUNK',
  'EXTRACTED_FROM',
  'TAGGED'
] as const
export type EdgeType = (typeof EDGE_TYPES)[number]

export interface RelTableSpec {
  readonly type: EdgeType
  /** Every (FROM, TO) label pair this relationship connects (§18). */
  readonly pairs: readonly (readonly [NodeLabel, NodeLabel])[]
}

export const REL_TABLES: readonly RelTableSpec[] = [
  { type: 'PRODUCED', pairs: [['Session', 'Project']] },
  {
    type: 'USED',
    pairs: [
      ['Session', 'Skill'],
      ['Session', 'MCP'],
      ['Session', 'Plugin']
    ]
  },
  {
    type: 'USES',
    pairs: [
      ['Project', 'Skill'],
      ['Project', 'MCP'],
      ['Project', 'Plugin']
    ]
  },
  { type: 'HAS_COMPONENT', pairs: [['Project', 'Component']] },
  { type: 'DEPENDS_ON', pairs: [['Component', 'Component']] },
  { type: 'CONNECTS_TO', pairs: [['Component', 'Component']] },
  { type: 'HAS_VERSION', pairs: [['Skill', 'SkillVersion']] },
  { type: 'HAS_EXAMPLE', pairs: [['Skill', 'Example']] },
  { type: 'OBSERVED_IN', pairs: [['Correction', 'Session']] },
  { type: 'IMPROVED', pairs: [['Correction', 'Skill']] },
  { type: 'DERIVED_FROM', pairs: [['Preference', 'Correction']] },
  { type: 'APPLIES_TO', pairs: [['Preference', 'Tag']] },
  { type: 'HAS_CHUNK', pairs: [['Document', 'Knowledge']] },
  {
    type: 'EXTRACTED_FROM',
    pairs: [
      ['Component', 'Session'],
      ['Preference', 'Session'],
      ['Knowledge', 'Session']
    ]
  },
  {
    type: 'TAGGED',
    pairs: [
      ['Project', 'Tag'],
      ['Skill', 'Tag'],
      ['Knowledge', 'Tag']
    ]
  }
]

/** Optional, engine-stamped-or-caller-supplied properties on every edge. */
export const REL_PROPERTIES: readonly PropertySpec[] = [
  { name: 'extracted_by', type: 'STRING' },
  { name: 'confidence', type: 'DOUBLE' }
]

// ── Lookups ──────────────────────────────────────────────────────────────────

const NODE_TABLE_BY_LABEL = new Map(NODE_TABLES.map((t) => [t.label, t]))
const REL_TABLE_BY_TYPE = new Map(REL_TABLES.map((t) => [t.type, t]))

export function nodeTable(label: NodeLabel): NodeTableSpec {
  const spec = NODE_TABLE_BY_LABEL.get(label)
  if (!spec) throw new Error(`unknown node label: ${label}`)
  return spec
}

export function relTable(type: EdgeType): RelTableSpec {
  const spec = REL_TABLE_BY_TYPE.get(type)
  if (!spec) throw new Error(`unknown relationship type: ${type}`)
  return spec
}

export function isRetrievable(label: NodeLabel): label is RetrievableLabel {
  return (RETRIEVABLE_LABELS as readonly string[]).includes(label)
}

/**
 * All properties writable through upsertNode for a label, keyed by name.
 * Includes provenance columns (extracted_by, confidence) where applicable and
 * `embedding` for retrievable labels; excludes engine-stamped created_at /
 * updated_at and the immutable id.
 */
export function writableNodeProperties(label: NodeLabel): ReadonlyMap<string, PropertyType> {
  const spec = nodeTable(label)
  const map = new Map<string, PropertyType>()
  for (const p of spec.properties) map.set(p.name, p.type)
  if (spec.provenance) {
    map.set('extracted_by', 'STRING')
    map.set('confidence', 'DOUBLE')
  }
  if (spec.ftsProperties) map.set('embedding', 'EMBEDDING')
  return map
}

/** Caller-writable edge properties (created_at/updated_at are engine-stamped). */
export function writableRelProperties(): ReadonlyMap<string, PropertyType> {
  return new Map(REL_PROPERTIES.map((p) => [p.name, p.type]))
}

export function vectorIndexName(label: RetrievableLabel): string {
  return `idx_vec_${label.toLowerCase()}`
}

export function ftsIndexName(label: RetrievableLabel): string {
  return `idx_fts_${label.toLowerCase()}`
}

/**
 * Full column list of a node table in DDL order: id, domain properties,
 * provenance, embedding, timestamps. DDL generation and the export job both
 * derive from this so they can never disagree.
 */
export function nodeColumns(spec: NodeTableSpec): PropertySpec[] {
  const cols: PropertySpec[] = [{ name: 'id', type: 'STRING' }, ...spec.properties]
  if (spec.provenance) {
    cols.push({ name: 'extracted_by', type: 'STRING' }, { name: 'confidence', type: 'DOUBLE' })
  }
  if (spec.ftsProperties) cols.push({ name: 'embedding', type: 'EMBEDDING' })
  cols.push({ name: 'created_at', type: 'TIMESTAMP' }, { name: 'updated_at', type: 'TIMESTAMP' })
  return cols
}

/** Column list of every rel table: caller-writable props + timestamps. */
export function relColumns(): PropertySpec[] {
  return [
    ...REL_PROPERTIES,
    { name: 'created_at', type: 'TIMESTAMP' },
    { name: 'updated_at', type: 'TIMESTAMP' }
  ]
}

// ── DDL generation ───────────────────────────────────────────────────────────

function columnDdl(p: PropertySpec): string {
  const type = p.type === 'EMBEDDING' ? `FLOAT[${EMBEDDING_DIM}]` : p.type
  const dflt = p.defaultValue !== undefined ? ` DEFAULT '${p.defaultValue}'` : ''
  return `${p.name} ${type}${dflt}`
}

export function nodeTableDdl(spec: NodeTableSpec): string {
  const cols = nodeColumns(spec).map(columnDdl)
  return `CREATE NODE TABLE IF NOT EXISTS ${spec.label}(${cols.join(', ')}, PRIMARY KEY(id))`
}

export function relTableDdl(spec: RelTableSpec): string {
  const pairs = spec.pairs.map(([from, to]) => `FROM ${from} TO ${to}`)
  const cols = relColumns().map(columnDdl)
  return `CREATE REL TABLE IF NOT EXISTS ${spec.type}(${pairs.join(', ')}, ${cols.join(', ')})`
}

/** DDL for the internal schema-version bookkeeping table (phase doc: "schema_version node"). */
export const SCHEMA_VERSION_TABLE_DDL =
  'CREATE NODE TABLE IF NOT EXISTS SchemaVersion(version INT64, name STRING, applied_at TIMESTAMP, PRIMARY KEY(version))'

/** Every §18 table DDL statement, nodes before rels (rels reference node tables). */
export function allTableDdl(): string[] {
  return [
    SCHEMA_VERSION_TABLE_DDL,
    ...NODE_TABLES.map(nodeTableDdl),
    ...REL_TABLES.map(relTableDdl)
  ]
}

/** `CALL CREATE_VECTOR_INDEX(...)` / `CALL CREATE_FTS_INDEX(...)` statements for a label. */
export function indexDdl(label: RetrievableLabel): { vector: string; fts: string } {
  const spec = nodeTable(label)
  const ftsProps = (spec.ftsProperties ?? []).map((p) => `'${p}'`).join(', ')
  return {
    // Defaults: metric := 'cosine' — right for BGE-M3 (probe: SHOW_INDEXES definition).
    vector: `CALL CREATE_VECTOR_INDEX('${label}', '${vectorIndexName(label)}', 'embedding')`,
    fts: `CALL CREATE_FTS_INDEX('${label}', '${ftsIndexName(label)}', [${ftsProps}])`
  }
}
