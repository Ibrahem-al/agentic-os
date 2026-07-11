/**
 * Structured deletes + restorable undo (feature Stage 1) over the REAL engine.
 *
 * Two concerns, one store:
 *  - engine-level `deleteNode` (DETACH semantics) / `deleteEdge` maintain the
 *    HNSW + FTS indexes on delete (a vector/text search stops returning the
 *    deleted node);
 *  - the audit recorder captures a full pre-image (node props incl. embedding +
 *    every incident edge) so `undo(actionId)` restores a deleted node, its
 *    edges and its embedding byte-for-byte — and a delete inside graphWrite
 *    stays reversible (structured op, no raw-mutation flag).
 *
 * One store per test file (ryugraph 25.9.1 teardown discipline, phase 08).
 */
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { EMBEDDING_DIM } from '../../src/main/config'
import { AuditLog } from '../../src/main/security'
import { openAppData, type AppData } from '../../src/main/storage'
import { basisEmbedding, openTestStore, type TestStore } from './helpers'

let store: TestStore
let appData: AppData
let audit: AuditLog

beforeAll(async () => {
  store = await openTestStore()
  appData = openAppData(join(store.baseDir, 'appdata.db'))
  audit = new AuditLog({ db: appData.db, backupsDir: store.backupsDir, engine: store.engine })
})

afterAll(async () => {
  appData.close()
  await store.cleanup()
})

const nodeCount = async (label: string, id: string): Promise<number> => {
  const rows = await store.engine.cypher(`MATCH (n:${label} {id: $id}) RETURN count(n) AS c`, { id })
  return Number(rows[0]?.['c'] ?? 0)
}

const edgeCount = async (fromL: string, fromId: string, type: string, toL: string, toId: string): Promise<number> => {
  const rows = await store.engine.cypher(
    `MATCH (:${fromL} {id: $from})-[r:${type}]->(:${toL} {id: $to}) RETURN count(r) AS c`,
    { from: fromId, to: toId }
  )
  return Number(rows[0]?.['c'] ?? 0)
}

const vectorHits = async (label: 'Project' | 'Skill' | 'Preference' | 'Knowledge', embedding: number[], id: string): Promise<boolean> => {
  const hits = await store.engine.vectorSearch(label, embedding, 5)
  return hits.some((h) => h.id === id && h.distance < 0.001)
}

const textHits = async (label: 'Project' | 'Skill' | 'Preference' | 'Knowledge', query: string, id: string): Promise<boolean> => {
  const hits = await store.engine.textSearch(label, query, 10)
  return hits.some((h) => h.id === id)
}

describe('engine structured deletes maintain the HNSW/FTS indexes', () => {
  it('deleteNode DETACH-removes a node + its edges and drops it from vector/text search', async () => {
    const emb = basisEmbedding(EMBEDDING_DIM, 5)
    await store.engine.upsertNode('Preference', {
      id: 'pref-eng',
      statement: 'prefers pnpm over npm for installs',
      embedding: emb,
      extracted_by: 'user:test',
      confidence: 0.8
    })
    await store.engine.upsertNode('Tag', { id: 'tag-eng', name: 'tooling', is_global: false })
    await store.engine.createEdge('APPLIES_TO', { label: 'Preference', id: 'pref-eng' }, { label: 'Tag', id: 'tag-eng' })

    expect(await vectorHits('Preference', emb, 'pref-eng')).toBe(true)
    expect(await textHits('Preference', 'pnpm', 'pref-eng')).toBe(true)
    expect(await edgeCount('Preference', 'pref-eng', 'APPLIES_TO', 'Tag', 'tag-eng')).toBe(1)

    await store.engine.deleteNode('Preference', 'pref-eng')

    expect(await nodeCount('Preference', 'pref-eng')).toBe(0)
    expect(await nodeCount('Tag', 'tag-eng')).toBe(1) // DETACH removes the edge, not the far endpoint
    expect(await edgeCount('Preference', 'pref-eng', 'APPLIES_TO', 'Tag', 'tag-eng')).toBe(0)
    // Index maintenance on delete: the node is no longer served by either index.
    expect(await vectorHits('Preference', emb, 'pref-eng')).toBe(false)
    expect(await textHits('Preference', 'pnpm', 'pref-eng')).toBe(false)
  })

  it('deleteEdge removes only the edge; both endpoints survive', async () => {
    await store.engine.upsertNode('Project', { id: 'proj-de', name: 'p', embedding: basisEmbedding(EMBEDDING_DIM, 6) })
    await store.engine.upsertNode('Skill', { id: 'skill-de', name: 's', instructions: 'i', embedding: basisEmbedding(EMBEDDING_DIM, 7) })
    await store.engine.createEdge('USES', { label: 'Project', id: 'proj-de' }, { label: 'Skill', id: 'skill-de' })
    expect(await edgeCount('Project', 'proj-de', 'USES', 'Skill', 'skill-de')).toBe(1)

    await store.engine.deleteEdge('USES', { label: 'Project', id: 'proj-de' }, { label: 'Skill', id: 'skill-de' })

    expect(await edgeCount('Project', 'proj-de', 'USES', 'Skill', 'skill-de')).toBe(0)
    expect(await nodeCount('Project', 'proj-de')).toBe(1)
    expect(await nodeCount('Skill', 'skill-de')).toBe(1)
  })

  it('deleteNode of an absent node is a no-op; deleteEdge rejects a non-schema pair', async () => {
    await expect(store.engine.deleteNode('Tag', 'does-not-exist')).resolves.toBeUndefined()
    await expect(
      store.engine.deleteEdge('USES', { label: 'Skill', id: 'x' }, { label: 'Project', id: 'y' })
    ).rejects.toThrow(/not in the §18 schema/)
  })
})

describe('audit undo restores structured deletes', () => {
  it('delete a node with edges → undo restores node + edges + embedding byte-equal', async () => {
    const skillEmb = basisEmbedding(EMBEDDING_DIM, 10)
    await store.engine.upsertNode('Skill', {
      id: 'skill-undo',
      name: 'storefront-deployer',
      instructions: 'deploy the storefront bundle to production',
      current_version: 'v1',
      embedding: skillEmb
    })
    await store.engine.upsertNode('Project', { id: 'proj-undo', name: 'shop', embedding: basisEmbedding(EMBEDDING_DIM, 11) })
    await store.engine.upsertNode('Tag', { id: 'tag-undo', name: 'deploy', is_global: true })
    await store.engine.upsertNode('SkillVersion', { id: 'sv-undo', instructions: 'deploy the storefront bundle to production', status: 'active' })
    // Incoming edge (Project USES Skill, with props) + outgoing edges (TAGGED, HAS_VERSION).
    await store.engine.createEdge(
      'USES',
      { label: 'Project', id: 'proj-undo' },
      { label: 'Skill', id: 'skill-undo' },
      { extracted_by: 'user:test', confidence: 0.95 }
    )
    await store.engine.createEdge('TAGGED', { label: 'Skill', id: 'skill-undo' }, { label: 'Tag', id: 'tag-undo' })
    await store.engine.createEdge('HAS_VERSION', { label: 'Skill', id: 'skill-undo' }, { label: 'SkillVersion', id: 'sv-undo' })

    const originalEmbedding = (
      await store.engine.cypher('MATCH (n:Skill {id: $id}) RETURN n.embedding AS e', { id: 'skill-undo' })
    )[0]!['e'] as number[]

    const jobsBefore = store.engine.lane.enqueuedCount
    const { actionId, reversible } = await audit.graphWrite('user:dashboard', 'delete skill-undo', async (tx) => {
      await tx.deleteNode('Skill', 'skill-undo')
    })
    // Structured op → ONE lane job, reversible (no rawMutations flag).
    expect(store.engine.lane.enqueuedCount).toBe(jobsBefore + 1)
    expect(reversible).toBe(true)
    expect(audit.getAction(actionId)!.reversible).toBe(true)

    // The delete really landed: node, all three edges, index entry gone.
    expect(await nodeCount('Skill', 'skill-undo')).toBe(0)
    expect(await edgeCount('Project', 'proj-undo', 'USES', 'Skill', 'skill-undo')).toBe(0)
    expect(await edgeCount('Skill', 'skill-undo', 'TAGGED', 'Tag', 'tag-undo')).toBe(0)
    expect(await edgeCount('Skill', 'skill-undo', 'HAS_VERSION', 'SkillVersion', 'sv-undo')).toBe(0)
    expect(await vectorHits('Skill', skillEmb, 'skill-undo')).toBe(false)
    // The far endpoints survived the DETACH.
    expect(await nodeCount('Project', 'proj-undo')).toBe(1)
    expect(await nodeCount('Tag', 'tag-undo')).toBe(1)
    expect(await nodeCount('SkillVersion', 'sv-undo')).toBe(1)

    // ── undo: node + edges + embedding all come back ─────────────────────────
    const jobsBeforeUndo = store.engine.lane.enqueuedCount
    await audit.undo(actionId, 'tester')
    expect(store.engine.lane.enqueuedCount).toBe(jobsBeforeUndo + 1) // ONE lane job

    expect(await nodeCount('Skill', 'skill-undo')).toBe(1)
    const restored = await store.engine.cypher(
      'MATCH (n:Skill {id: $id}) RETURN n.name AS name, n.instructions AS instructions, n.current_version AS cv, n.embedding AS e',
      { id: 'skill-undo' }
    )
    expect(restored[0]!['name']).toBe('storefront-deployer')
    expect(restored[0]!['instructions']).toBe('deploy the storefront bundle to production')
    expect(restored[0]!['cv']).toBe('v1')
    // Embedding restored byte-for-byte (float32 read-back equals the original).
    expect(restored[0]!['e']).toEqual(originalEmbedding)
    expect(await vectorHits('Skill', skillEmb, 'skill-undo')).toBe(true)
    expect(await textHits('Skill', 'storefront', 'skill-undo')).toBe(true)

    // All three edges reconnected; the props edge kept its provenance.
    expect(await edgeCount('Project', 'proj-undo', 'USES', 'Skill', 'skill-undo')).toBe(1)
    expect(await edgeCount('Skill', 'skill-undo', 'TAGGED', 'Tag', 'tag-undo')).toBe(1)
    expect(await edgeCount('Skill', 'skill-undo', 'HAS_VERSION', 'SkillVersion', 'sv-undo')).toBe(1)
    const usesProps = await store.engine.cypher(
      'MATCH (:Project {id: $from})-[r:USES]->(:Skill {id: $to}) RETURN r.extracted_by AS eb, r.confidence AS conf',
      { from: 'proj-undo', to: 'skill-undo' }
    )
    expect(usesProps[0]!['eb']).toBe('user:test')
    expect(usesProps[0]!['conf']).toBeCloseTo(0.95, 6)
  })

  it('delete an edge → undo restores just that edge', async () => {
    await store.engine.upsertNode('Project', { id: 'proj-edge', name: 'pe', embedding: basisEmbedding(EMBEDDING_DIM, 12) })
    await store.engine.upsertNode('MCP', { id: 'mcp-edge', name: 'server', config_ref: 'ref' })
    await store.engine.createEdge(
      'USES',
      { label: 'Project', id: 'proj-edge' },
      { label: 'MCP', id: 'mcp-edge' },
      { extracted_by: 'user:test', confidence: 0.5 }
    )

    const { actionId, reversible } = await audit.graphWrite('user:dashboard', 'delete USES edge', async (tx) => {
      await tx.deleteEdge('USES', { label: 'Project', id: 'proj-edge' }, { label: 'MCP', id: 'mcp-edge' })
    })
    expect(reversible).toBe(true)
    expect(await edgeCount('Project', 'proj-edge', 'USES', 'MCP', 'mcp-edge')).toBe(0)
    // Endpoints untouched.
    expect(await nodeCount('Project', 'proj-edge')).toBe(1)
    expect(await nodeCount('MCP', 'mcp-edge')).toBe(1)

    await audit.undo(actionId)
    expect(await edgeCount('Project', 'proj-edge', 'USES', 'MCP', 'mcp-edge')).toBe(1)
    const props = await store.engine.cypher(
      'MATCH (:Project {id: $from})-[r:USES]->(:MCP {id: $to}) RETURN r.extracted_by AS eb, r.confidence AS conf',
      { from: 'proj-edge', to: 'mcp-edge' }
    )
    expect(props[0]!['eb']).toBe('user:test')
    expect(props[0]!['conf']).toBeCloseTo(0.5, 6)
  })

  it('Document + chunks cascade delete → undo restores chunks with their embeddings', async () => {
    await store.engine.upsertNode('Document', { id: 'doc-cas', source: 'notes.md', content_hash: 'h1' })
    const chunks = [
      { id: 'kn-cas-1', content: 'the quokka is a small marsupial', axis: 20 },
      { id: 'kn-cas-2', content: 'quokkas are native to western australia', axis: 21 }
    ]
    for (const c of chunks) {
      await store.engine.upsertNode('Knowledge', { id: c.id, content: c.content, embedding: basisEmbedding(EMBEDDING_DIM, c.axis) })
      await store.engine.createEdge('HAS_CHUNK', { label: 'Document', id: 'doc-cas' }, { label: 'Knowledge', id: c.id })
    }

    const { actionId, reversible } = await audit.graphWrite('user:dashboard', 'cascade delete doc-cas', async (tx) => {
      // Cascade: delete the chunks first, then the document (Stage-2 will drive
      // this shape from memory.node.delete). Each Knowledge DETACH drops its
      // HAS_CHUNK edge; the document DETACH then has none left.
      for (const c of chunks) await tx.deleteNode('Knowledge', c.id)
      await tx.deleteNode('Document', 'doc-cas')
    })
    expect(reversible).toBe(true)
    expect(await nodeCount('Document', 'doc-cas')).toBe(0)
    for (const c of chunks) {
      expect(await nodeCount('Knowledge', c.id)).toBe(0)
      expect(await vectorHits('Knowledge', basisEmbedding(EMBEDDING_DIM, c.axis), c.id)).toBe(false)
    }

    await audit.undo(actionId)

    expect(await nodeCount('Document', 'doc-cas')).toBe(1)
    for (const c of chunks) {
      expect(await nodeCount('Knowledge', c.id)).toBe(1)
      expect(await edgeCount('Document', 'doc-cas', 'HAS_CHUNK', 'Knowledge', c.id)).toBe(1)
      // Embeddings restored → served by the vector index again.
      expect(await vectorHits('Knowledge', basisEmbedding(EMBEDDING_DIM, c.axis), c.id)).toBe(true)
      const content = await store.engine.cypher('MATCH (n:Knowledge {id: $id}) RETURN n.content AS content', { id: c.id })
      expect(content[0]!['content']).toBe(c.content)
    }
  })
})
