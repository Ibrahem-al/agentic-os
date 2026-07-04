/**
 * DoD: full schema round-trip — one of every §18 node and edge written through
 * the engine, queried back with provenance intact. Offline by construction
 * (vendored extensions, no network).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { NodeLabel } from '../../src/main/storage'
import { EDGE_TYPES, NODE_LABELS } from '../../src/main/storage'
import { REL_TABLES } from '../../src/main/storage/schema'
import { basisEmbedding, openTestStore, type TestStore } from './helpers'
import { EMBEDDING_DIM } from '../../src/main/config'

let store: TestStore

beforeAll(async () => {
  store = await openTestStore()
})
afterAll(async () => {
  await store.cleanup()
})

/** One representative node per label; ids are `<label>-1`. */
const NODE_FIXTURES: Record<NodeLabel, Record<string, unknown>> = {
  Session: {
    started_at: new Date('2026-07-04T08:00:00.000Z'),
    ended_at: '2026-07-04T09:30:00.500Z',
    transcript_ref: 'C:/tmp/transcript.jsonl'
    // tier omitted → DDL default 'daily'
  },
  Project: { name: 'agentic-os', summary: 'memory backend for agents', embedding: basisEmbedding(EMBEDDING_DIM, 0) },
  Skill: {
    name: 'commit-style',
    instructions: 'write conventional commits',
    current_version: 'SkillVersion-1',
    embedding: basisEmbedding(EMBEDDING_DIM, 1)
  },
  SkillVersion: { instructions: 'v1 instructions', benchmark_score: 0.75, status: 'active' },
  Example: { kind: 'success', content: 'did the thing right' },
  Correction: { content: 'actually use tabs' },
  Preference: {
    statement: 'prefer symmetric layouts',
    embedding: basisEmbedding(EMBEDDING_DIM, 2),
    extracted_by: 'extraction@1.0/llm-local',
    confidence: 0.9
  },
  MCP: { name: 'agentic-os-mcp', config_ref: 'mcp.json#agentic-os' },
  Plugin: { name: 'playwright', config_ref: 'plugins.json#playwright' },
  Component: { name: 'storage-engine', type: 'service', extracted_by: 'codebase-ingest@1.0', confidence: 1.0 },
  Document: { source: 'docs/spec.md', content_hash: 'abc123', ingested_at: new Date('2026-07-04T07:00:00.000Z') },
  Knowledge: {
    content: 'ryugraph is the embedded store',
    embedding: basisEmbedding(EMBEDDING_DIM, 3),
    extracted_by: 'extraction@1.0/llm-local',
    confidence: 0.8
  },
  Tag: { name: 'global', is_global: true }
}

const nodeId = (label: NodeLabel): string => `${label}-1`

describe('full §18 schema round-trip', () => {
  it('creates one node of every label through the write lane', async () => {
    for (const label of NODE_LABELS) {
      const result = await store.engine.upsertNode(label, { id: nodeId(label), ...NODE_FIXTURES[label] })
      expect(result).toEqual({ id: nodeId(label), created: true, embeddingRebuilt: false })
    }
    for (const label of NODE_LABELS) {
      const rows = await store.engine.cypher(`MATCH (n:${label}) RETURN count(*) AS c`)
      expect(Number(rows[0]?.['c']), label).toBe(1)
    }
  })

  it('creates one edge of every §18 (type, from, to) pair and queries each back', async () => {
    let pairCount = 0
    for (const spec of REL_TABLES) {
      for (const [from, to] of spec.pairs) {
        pairCount += 1
        await store.engine.createEdge(
          spec.type,
          { label: from, id: nodeId(from) },
          { label: to, id: nodeId(to) },
          { extracted_by: 'extraction@1.0/test', confidence: 0.66 }
        )
        const rows = await store.engine.cypher(
          `MATCH (a:${from} {id: $from})-[r:${spec.type}]->(b:${to} {id: $to})
           RETURN r.extracted_by AS eb, r.confidence AS cf, r.created_at AS created, r.updated_at AS updated`,
          { from: nodeId(from), to: nodeId(to) }
        )
        expect(rows, `${spec.type} ${from}→${to}`).toHaveLength(1)
        expect(rows[0]?.['eb']).toBe('extraction@1.0/test')
        expect(rows[0]?.['cf']).toBe(0.66)
        expect(rows[0]?.['created']).toBeInstanceOf(Date)
        expect(rows[0]?.['updated']).toBeInstanceOf(Date)
      }
    }
    expect(pairCount).toBe(23)
    expect(EDGE_TYPES).toHaveLength(15)
  })

  it('round-trips representative properties with provenance and timestamps', async () => {
    const session = await store.engine.cypher(
      'MATCH (n:Session {id: $id}) RETURN n.started_at AS started, n.ended_at AS ended, n.tier AS tier, n.transcript_ref AS ref, n.created_at AS created',
      { id: nodeId('Session') }
    )
    expect(session[0]?.['started']).toEqual(new Date('2026-07-04T08:00:00.000Z'))
    expect(session[0]?.['ended']).toEqual(new Date('2026-07-04T09:30:00.500Z'))
    expect(session[0]?.['tier']).toBe('daily') // DDL default applied
    expect(session[0]?.['ref']).toBe('C:/tmp/transcript.jsonl')
    expect(session[0]?.['created']).toBeInstanceOf(Date)

    const component = await store.engine.cypher(
      'MATCH (n:Component {id: $id}) RETURN n.name AS name, n.type AS type, n.extracted_by AS eb, n.confidence AS cf',
      { id: nodeId('Component') }
    )
    expect(component[0]).toEqual({ name: 'storage-engine', type: 'service', eb: 'codebase-ingest@1.0', cf: 1.0 })

    const tag = await store.engine.cypher('MATCH (n:Tag {id: $id}) RETURN n.is_global AS g', { id: nodeId('Tag') })
    expect(tag[0]?.['g']).toBe(true)

    const knowledge = await store.engine.cypher(
      'MATCH (n:Knowledge {id: $id}) RETURN n.embedding AS emb, n.confidence AS cf',
      { id: nodeId('Knowledge') }
    )
    expect(Array.isArray(knowledge[0]?.['emb'])).toBe(true)
    expect((knowledge[0]?.['emb'] as number[]).length).toBe(EMBEDDING_DIM)
    expect(knowledge[0]?.['cf']).toBe(0.8)
  })

  it('updates via upsert: props change, created_at survives, updated_at bumps', async () => {
    const before = await store.engine.cypher(
      'MATCH (n:Example {id: $id}) RETURN n.created_at AS created, n.updated_at AS updated',
      { id: nodeId('Example') }
    )
    await new Promise((r) => setTimeout(r, 5))
    const result = await store.engine.upsertNode('Example', { id: nodeId('Example'), content: 'refined example' })
    expect(result.created).toBe(false)
    const after = await store.engine.cypher(
      'MATCH (n:Example {id: $id}) RETURN n.kind AS kind, n.content AS content, n.created_at AS created, n.updated_at AS updated',
      { id: nodeId('Example') }
    )
    expect(after[0]?.['content']).toBe('refined example')
    expect(after[0]?.['kind']).toBe('success') // untouched props survive
    expect((after[0]?.['created'] as Date).getTime()).toBe((before[0]?.['created'] as Date).getTime())
    expect((after[0]?.['updated'] as Date).getTime()).toBeGreaterThan((before[0]?.['updated'] as Date).getTime())
  })

  it('records the schema version as a node and a sidecar', async () => {
    expect(store.engine.schemaVersion).toBe(1)
    const rows = await store.engine.cypher('MATCH (v:SchemaVersion) RETURN v.version AS version, v.name AS name')
    expect(rows).toHaveLength(1)
    expect(Number(rows[0]?.['version'])).toBe(1)
    expect(rows[0]?.['name']).toBe('initial-schema')
    const sidecar = JSON.parse(readFileSync(join(store.graphDir, 'schema-version.json'), 'utf8')) as {
      version: number
    }
    expect(sidecar.version).toBe(1)
    expect(existsSync(join(store.graphDir, 'graph.ryugraph'))).toBe(true)
  })

  it('rejects writes outside the schema and engine-managed statements', async () => {
    await expect(store.engine.upsertNode('Tag', { id: 't-x', bogus: 1 })).rejects.toThrow(/not a writable property/)
    await expect(store.engine.upsertNode('Tag', { id: 't-x', created_at: '2026-01-01' })).rejects.toThrow(
      /not a writable property/
    )
    await expect(
      store.engine.createEdge('TAGGED', { label: 'Session', id: nodeId('Session') }, { label: 'Tag', id: nodeId('Tag') })
    ).rejects.toThrow(/not in the §18 schema/)
    await expect(
      store.engine.createEdge('HAS_CHUNK', { label: 'Document', id: 'missing-doc' }, { label: 'Knowledge', id: nodeId('Knowledge') })
    ).rejects.toThrow(/endpoint\(s\) missing/)
    await expect(store.engine.cypher('BEGIN TRANSACTION')).rejects.toThrow(/engine-managed/)
    await expect(store.engine.cypher("INSTALL vector")).rejects.toThrow(/engine-managed/)
    await expect(
      store.engine.cypher('MATCH (n:Session) WHERE n.started_at > $t RETURN n.id', { t: new Date() })
    ).rejects.toThrow(/timestamp\(/)
  })
})
