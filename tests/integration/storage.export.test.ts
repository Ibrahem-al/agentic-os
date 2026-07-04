/**
 * Export job (§5 memory insurance): full dump to exports/<date>/ as
 * Neo4j-style CSVs + Cypher statements + manifest.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { EMBEDDING_DIM } from '../../src/main/config'
import { exportGraph } from '../../src/main/storage'
import { basisEmbedding, openTestStore, type TestStore } from './helpers'

let store: TestStore

beforeAll(async () => {
  store = await openTestStore()
  await store.engine.upsertNode('Document', {
    id: 'doc-1',
    source: 'notes/design.md',
    content_hash: 'hash-1',
    ingested_at: new Date('2026-07-04T06:00:00.000Z')
  })
  await store.engine.upsertNode('Knowledge', {
    id: 'k-1',
    content: 'a chunk with, a comma and "quotes"',
    embedding: basisEmbedding(EMBEDDING_DIM, 0),
    extracted_by: 'knowledge-ingest@1.0',
    confidence: 1.0
  })
  await store.engine.upsertNode('Knowledge', { id: 'k-2', content: "it's got an apostrophe" })
  await store.engine.upsertNode('Tag', { id: 'tag-global', name: 'global', is_global: true })
  await store.engine.createEdge('HAS_CHUNK', { label: 'Document', id: 'doc-1' }, { label: 'Knowledge', id: 'k-1' })
  await store.engine.createEdge('HAS_CHUNK', { label: 'Document', id: 'doc-1' }, { label: 'Knowledge', id: 'k-2' })
  await store.engine.createEdge('TAGGED', { label: 'Knowledge', id: 'k-1' }, { label: 'Tag', id: 'tag-global' })
})
afterAll(async () => {
  await store.cleanup()
})

describe('exportGraph', () => {
  it('dumps every table to exports/<date>/ as CSV + Cypher + manifest', async () => {
    const result = await exportGraph(store.engine, store.exportsDir)
    const day = new Date().toISOString().slice(0, 10)
    expect(result.dir).toBe(join(store.exportsDir, day))

    // Every node label gets a CSV (header-only when empty) + SchemaVersion.
    const files = readdirSync(result.dir)
    expect(files).toContain('nodes_Knowledge.csv')
    expect(files).toContain('nodes_Project.csv')
    expect(files).toContain('nodes_SchemaVersion.csv')
    expect(files).toContain('rels_HAS_CHUNK__Document__Knowledge.csv')
    expect(files).toContain('rels_USED__Session__Skill.csv')
    expect(files).toContain('graph.cypher')
    expect(files).toContain('manifest.json')
    // One file per §18 pair (23) + 14 node labels (13 + SchemaVersion) + 2.
    expect(files.filter((f) => f.startsWith('rels_'))).toHaveLength(23)
    expect(files.filter((f) => f.startsWith('nodes_'))).toHaveLength(14)

    // Counts.
    expect(result.nodeCounts['Knowledge']).toBe(2)
    expect(result.nodeCounts['Document']).toBe(1)
    expect(result.nodeCounts['Project']).toBe(0)
    expect(result.relCounts['HAS_CHUNK__Document__Knowledge']).toBe(2)
    expect(result.relCounts['TAGGED__Knowledge__Tag']).toBe(1)

    // Node CSV: neo4j-admin header, quoted comma field, ;-joined embedding.
    const knowledgeCsv = readFileSync(join(result.dir, 'nodes_Knowledge.csv'), 'utf8').split('\n')
    expect(knowledgeCsv[0]).toBe(
      'id:ID(Knowledge),content,extracted_by,confidence:double,embedding:double[],created_at:datetime,updated_at:datetime,:LABEL'
    )
    const k1Line = knowledgeCsv.find((l) => l.startsWith('k-1,'))
    expect(k1Line).toContain('"a chunk with, a comma and ""quotes"""')
    expect(k1Line).toContain('1;0;0') // embedding array separator
    expect(k1Line?.trimEnd().endsWith(',Knowledge')).toBe(true)

    // Rel CSV: START/END/TYPE columns.
    const chunkCsv = readFileSync(join(result.dir, 'rels_HAS_CHUNK__Document__Knowledge.csv'), 'utf8').split('\n')
    expect(chunkCsv[0]).toBe(
      ':START_ID(Document),:END_ID(Knowledge),extracted_by,confidence:double,created_at:datetime,updated_at:datetime,:TYPE'
    )
    expect(chunkCsv[1]).toMatch(/^doc-1,k-1,.*,HAS_CHUNK$/)

    // Cypher: node CREATEs with datetime + escaped strings, edge MATCH+CREATE.
    const cypher = readFileSync(join(result.dir, 'graph.cypher'), 'utf8')
    expect(cypher).toContain("CREATE (:Knowledge {id: 'k-1'")
    expect(cypher).toContain("it\\'s got an apostrophe")
    expect(cypher).toMatch(/created_at: datetime\('20/)
    expect(cypher).toContain(
      "MATCH (a:Document {id: 'doc-1'}), (b:Knowledge {id: 'k-1'}) CREATE (a)-[:HAS_CHUNK"
    )
    expect(cypher).toContain("CREATE (:SchemaVersion {version: 1")

    // Manifest.
    const manifest = JSON.parse(readFileSync(join(result.dir, 'manifest.json'), 'utf8')) as {
      schemaVersion: number
      nodeCounts: Record<string, number>
    }
    expect(manifest.schemaVersion).toBe(1)
    expect(manifest.nodeCounts['SchemaVersion']).toBe(1)
  })

  it('same-day re-export lands in a suffixed directory', async () => {
    const second = await exportGraph(store.engine, store.exportsDir)
    const day = new Date().toISOString().slice(0, 10)
    expect(second.dir).not.toBe(join(store.exportsDir, day))
    expect(second.dir.startsWith(join(store.exportsDir, day))).toBe(true)
    expect(existsSync(join(second.dir, 'manifest.json'))).toBe(true)
  })
})
