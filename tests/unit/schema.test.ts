import { describe, expect, it } from 'vitest'
import { EMBEDDING_DIM } from '../../src/main/config'
import {
  allTableDdl,
  EDGE_TYPES,
  EXTRACTION_WRITTEN_LABELS,
  ftsIndexName,
  indexDdl,
  NODE_LABELS,
  NODE_TABLES,
  nodeColumns,
  nodeTable,
  nodeTableDdl,
  REL_TABLES,
  relTable,
  relTableDdl,
  RETRIEVABLE_LABELS,
  vectorIndexName,
  writableNodeProperties
} from '../../src/main/storage/schema'

describe('schema registry (spec §18)', () => {
  it('declares all 13 node labels and 15 relationship types', () => {
    expect(NODE_LABELS).toHaveLength(13)
    expect(EDGE_TYPES).toHaveLength(15)
    expect(NODE_TABLES.map((t) => t.label)).toEqual([...NODE_LABELS])
    expect(REL_TABLES.map((t) => t.type)).toEqual([...EDGE_TYPES])
  })

  it('marks exactly Project/Skill/Preference/Knowledge as retrievable with FTS text fields', () => {
    expect(RETRIEVABLE_LABELS).toEqual(['Project', 'Skill', 'Preference', 'Knowledge'])
    expect(nodeTable('Project').ftsProperties).toEqual(['name', 'summary'])
    expect(nodeTable('Skill').ftsProperties).toEqual(['name', 'instructions'])
    expect(nodeTable('Preference').ftsProperties).toEqual(['statement'])
    expect(nodeTable('Knowledge').ftsProperties).toEqual(['content'])
    for (const spec of NODE_TABLES) {
      if (!(RETRIEVABLE_LABELS as readonly string[]).includes(spec.label)) {
        expect(spec.ftsProperties, spec.label).toBeUndefined()
      }
    }
  })

  it('gives extraction-written labels provenance columns (§21 rule 4)', () => {
    expect(EXTRACTION_WRITTEN_LABELS).toEqual(['Component', 'Preference', 'Knowledge'])
    for (const label of EXTRACTION_WRITTEN_LABELS) {
      const writable = writableNodeProperties(label)
      expect(writable.get('extracted_by'), label).toBe('STRING')
      expect(writable.get('confidence'), label).toBe('DOUBLE')
    }
    expect(writableNodeProperties('Session').has('extracted_by')).toBe(false)
  })

  it('declares the §18 relationship pairs exactly', () => {
    expect(relTable('USED').pairs).toEqual([
      ['Session', 'Skill'],
      ['Session', 'MCP'],
      ['Session', 'Plugin']
    ])
    expect(relTable('EXTRACTED_FROM').pairs).toEqual([
      ['Component', 'Session'],
      ['Preference', 'Session'],
      ['Knowledge', 'Session']
    ])
    expect(relTable('TAGGED').pairs).toEqual([
      ['Project', 'Tag'],
      ['Skill', 'Tag'],
      ['Knowledge', 'Tag']
    ])
    const totalPairs = REL_TABLES.reduce((n, t) => n + t.pairs.length, 0)
    expect(totalPairs).toBe(23)
  })

  it('stamps created_at/updated_at on every node and rel table (provenance v3.1)', () => {
    for (const spec of NODE_TABLES) {
      const names = nodeColumns(spec).map((c) => c.name)
      expect(names, spec.label).toContain('created_at')
      expect(names, spec.label).toContain('updated_at')
      expect(names[0], spec.label).toBe('id')
    }
    for (const spec of REL_TABLES) {
      const ddl = relTableDdl(spec)
      expect(ddl, spec.type).toContain('created_at TIMESTAMP')
      expect(ddl, spec.type).toContain('updated_at TIMESTAMP')
      expect(ddl, spec.type).toContain('extracted_by STRING')
      expect(ddl, spec.type).toContain('confidence DOUBLE')
    }
  })

  it('generates idempotent DDL with embeddings sized to EMBEDDING_DIM', () => {
    const ddl = allTableDdl()
    expect(ddl).toHaveLength(1 + 13 + 15) // SchemaVersion + nodes + rels
    for (const statement of ddl) expect(statement).toContain('IF NOT EXISTS')
    expect(nodeTableDdl(nodeTable('Knowledge'))).toContain(`embedding FLOAT[${EMBEDDING_DIM}]`)
    expect(nodeTableDdl(nodeTable('Session'))).toContain("tier STRING DEFAULT 'daily'")
    expect(nodeTableDdl(nodeTable('Session'))).not.toContain('embedding')
  })

  it('names one HNSW + one FTS index per retrievable label', () => {
    for (const label of RETRIEVABLE_LABELS) {
      const ddl = indexDdl(label)
      expect(ddl.vector).toContain(`CREATE_VECTOR_INDEX('${label}', '${vectorIndexName(label)}', 'embedding')`)
      expect(ddl.fts).toContain(`CREATE_FTS_INDEX('${label}', '${ftsIndexName(label)}'`)
    }
  })
})
