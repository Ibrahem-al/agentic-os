/**
 * Dashboard memory CRUD (feature B Stage 2) — the memory.* mutation service
 * over the REAL engine + audit log:
 *
 *  - validation is pre-lane: a rejected request writes nothing (no lane job,
 *    no audit row) and protected keys are refused by name;
 *  - retrievable creates/updates embed BEFORE the lane (embedder down ⇒
 *    OllamaError → the IPC envelope's OLLAMA_ERROR — graph untouched);
 *  - every mutation is ONE audited lane job whose undo round-trips, and every
 *    result carries the auditActionId the UI's Undo toast needs;
 *  - the two owned-children cascades (Document→HAS_CHUNK chunks,
 *    Skill→HAS_VERSION versions) delete children before parent in one job;
 *  - the shared-IPC edge vocabulary (IPC_EDGE_TYPES/IPC_EDGE_PAIRS) is pinned
 *    against REL_TABLES so the hand-kept mirror can never drift.
 *
 * One store per test file (ryugraph 25.9.1 teardown discipline, phase 08).
 */
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { EMBEDDING_DIM } from '../../src/main/config'
import {
  createMemoryEdge,
  createMemoryNode,
  deleteMemoryEdge,
  deleteMemoryNode,
  MemoryEditError,
  updateMemoryNode,
  type MemoryEditDeps
} from '../../src/main/memory'
import { OllamaError } from '../../src/main/models'
import { AuditLog } from '../../src/main/security'
import { openAppData, REL_TABLES, type AppData } from '../../src/main/storage'
import { IPC_EDGE_PAIRS, IPC_EDGE_TYPES } from '../../src/shared/ipc'
import { basisEmbedding, openTestStore, type TestStore } from './helpers'

let store: TestStore
let appData: AppData
let audit: AuditLog
let deps: MemoryEditDeps

/** Deterministic single-axis fake embedder (real interface) with a counter. */
const fakeEmbedder = {
  calls: 0,
  axis: 40,
  failNext: false,
  async embed(texts: string[]): Promise<number[][]> {
    if (fakeEmbedder.failNext) {
      fakeEmbedder.failNext = false
      throw new OllamaError('Ollama daemon unreachable at http://127.0.0.1:11434 — is it running?')
    }
    fakeEmbedder.calls += texts.length
    return texts.map(() => basisEmbedding(EMBEDDING_DIM, fakeEmbedder.axis))
  }
}

beforeAll(async () => {
  store = await openTestStore()
  appData = openAppData(join(store.baseDir, 'appdata.db'))
  audit = new AuditLog({ db: appData.db, backupsDir: store.backupsDir, engine: store.engine })
  deps = { engine: store.engine, audit, embedder: fakeEmbedder, actor: 'user:dashboard' }
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

const vectorHits = async (
  label: 'Project' | 'Skill' | 'Preference' | 'Knowledge',
  axis: number,
  id: string
): Promise<boolean> => {
  const hits = await store.engine.vectorSearch(label, basisEmbedding(EMBEDDING_DIM, axis), 5)
  return hits.some((h) => h.id === id && h.distance < 0.001)
}

const expectEditError = async (
  promise: Promise<unknown>,
  code: 'INVALID_INPUT' | 'NOT_FOUND',
  message: RegExp
): Promise<void> => {
  await expect(promise).rejects.toSatisfy(
    (err: unknown) => err instanceof MemoryEditError && err.code === code && message.test(err.message)
  )
}

// ── memory.node.create ───────────────────────────────────────────────────────

describe('createMemoryNode', () => {
  it('creates a non-retrievable node with a server id and no embed call; undo removes it', async () => {
    const embedsBefore = fakeEmbedder.calls
    const result = await createMemoryNode(deps, { label: 'Tag', props: { name: 'tooling', is_global: true } })

    expect(result.label).toBe('Tag')
    expect(result.id).toMatch(/^usr-tag-[0-9a-f]{8}$/)
    expect(fakeEmbedder.calls).toBe(embedsBefore) // Tag is not retrievable
    expect(await nodeCount('Tag', result.id)).toBe(1)

    const action = audit.getAction(result.auditActionId)
    expect(action).toBeDefined()
    expect(action!.kind).toBe('graph-write')
    expect(action!.agentId).toBe('user:dashboard')
    expect(action!.reversible).toBe(true)

    await audit.undo(result.auditActionId, 'tester')
    expect(await nodeCount('Tag', result.id)).toBe(0)
  })

  it('creates a retrievable Preference with a pre-lane embedding and NO provenance stamps', async () => {
    fakeEmbedder.axis = 41
    const embedsBefore = fakeEmbedder.calls
    const result = await createMemoryNode(deps, {
      label: 'Preference',
      props: { statement: 'prefers pnpm strict mode for installs' }
    })

    expect(result.id).toMatch(/^usr-preferen-[0-9a-f]{8}$/)
    expect(fakeEmbedder.calls).toBe(embedsBefore + 1)
    // Served back by the vector index (the embedding really landed).
    expect(await vectorHits('Preference', 41, result.id)).toBe(true)
    // User-authored rows carry NO extraction provenance (§21 rule 4) — the
    // audit row records the actor instead.
    const rows = await store.engine.cypher(
      'MATCH (p:Preference {id: $id}) RETURN p.extracted_by AS eb, p.confidence AS conf',
      { id: result.id }
    )
    expect(rows[0]!['eb'] ?? null).toBeNull()
    expect(rows[0]!['conf'] ?? null).toBeNull()
  })

  it('creates a Skill as Skill + active SkillVersion + HAS_VERSION in ONE audited lane job; undo removes all three', async () => {
    fakeEmbedder.axis = 42
    const jobsBefore = store.engine.lane.enqueuedCount
    const result = await createMemoryNode(deps, {
      label: 'Skill',
      props: { name: 'storefront-deploy', instructions: 'build then deploy the storefront bundle' }
    })
    expect(store.engine.lane.enqueuedCount).toBe(jobsBefore + 1) // one job for the whole shape

    const skillRows = await store.engine.cypher(
      'MATCH (s:Skill {id: $id}) RETURN s.name AS name, s.current_version AS cv',
      { id: result.id }
    )
    const versionId = String(skillRows[0]!['cv'])
    expect(skillRows[0]!['name']).toBe('storefront-deploy')
    expect(versionId).toMatch(new RegExp(`^sv-${result.id}-[0-9a-f]{8}$`))

    const versionRows = await store.engine.cypher(
      'MATCH (v:SkillVersion {id: $id}) RETURN v.status AS status, v.instructions AS instructions',
      { id: versionId }
    )
    expect(versionRows[0]!['status']).toBe('active')
    expect(versionRows[0]!['instructions']).toBe('build then deploy the storefront bundle')
    expect(await edgeCount('Skill', result.id, 'HAS_VERSION', 'SkillVersion', versionId)).toBe(1)
    expect(await vectorHits('Skill', 42, result.id)).toBe(true)

    await audit.undo(result.auditActionId, 'tester')
    expect(await nodeCount('Skill', result.id)).toBe(0)
    expect(await nodeCount('SkillVersion', versionId)).toBe(0)
    expect(await vectorHits('Skill', 42, result.id)).toBe(false)

    // That undo deleted the store's ONLY Skill — the undo path must run the
    // engine's emptied-vector-index rebuild (structured deleteNode, not raw
    // cypher), or the ryugraph 25.9.1 emptied-index degeneracy would silently
    // stop serving every LATER Skill insert (found by this suite).
    await store.engine.upsertNode('Skill', {
      id: 'skill-probe',
      name: 'probe',
      instructions: 'served after the emptied-index rebuild',
      embedding: basisEmbedding(EMBEDDING_DIM, 43)
    })
    expect(await vectorHits('Skill', 43, 'skill-probe')).toBe(true)
  })

  it('rejects bad input pre-lane — nothing written, no audit row', async () => {
    const graphWritesBefore = audit.listActions({ kind: 'graph-write' }).length
    const embedsBefore = fakeEmbedder.calls

    await expectEditError(createMemoryNode(deps, { label: 'Widget', props: {} }), 'INVALID_INPUT', /unknown node label/)
    await expectEditError(
      createMemoryNode(deps, { label: 'Tag', props: { id: 'my-id', name: 'x' } }),
      'INVALID_INPUT',
      /\bid\b.*protected/
    )
    await expectEditError(
      createMemoryNode(deps, {
        label: 'Preference',
        props: { statement: 's', extracted_by: 'me', confidence: 1 }
      }),
      'INVALID_INPUT',
      /extracted_by, confidence are protected/
    )
    await expectEditError(
      createMemoryNode(deps, { label: 'Preference', props: { statement: 's', embedding: [1, 2, 3] } }),
      'INVALID_INPUT',
      /embedding.*protected/
    )
    await expectEditError(
      createMemoryNode(deps, { label: 'Tag', props: { name: 'x', color: 'red' } }),
      'INVALID_INPUT',
      /'color' is not a writable Tag property/
    )
    await expectEditError(
      createMemoryNode(deps, { label: 'Tag', props: { name: 42 } }),
      'INVALID_INPUT',
      /Tag\.name: expected a string/
    )
    await expectEditError(
      createMemoryNode(deps, { label: 'Preference', props: {} }),
      'INVALID_INPUT',
      /nothing to embed/
    )
    await expectEditError(
      createMemoryNode(deps, { label: 'Skill', props: { name: 'x' } }),
      'INVALID_INPUT',
      /'instructions' must be a non-empty string/
    )
    await expectEditError(
      createMemoryNode(deps, {
        label: 'Skill',
        props: { name: 'x', instructions: 'y', current_version: 'v1' }
      }),
      'INVALID_INPUT',
      /current_version.*server-managed/
    )

    expect(audit.listActions({ kind: 'graph-write' }).length).toBe(graphWritesBefore)
    expect(fakeEmbedder.calls).toBe(embedsBefore)
  })

  it('fails OLLAMA_ERROR when the embedder is down — graph untouched, no audit row', async () => {
    const graphWritesBefore = audit.listActions({ kind: 'graph-write' }).length
    const knowledgeBefore = (await store.engine.cypher('MATCH (k:Knowledge) RETURN count(k) AS c'))[0]!['c']

    fakeEmbedder.failNext = true
    await expect(
      createMemoryNode(deps, { label: 'Knowledge', props: { content: 'quokkas are marsupials' } })
    ).rejects.toBeInstanceOf(OllamaError)

    // No embedder wired at all (model layer did not boot) → same failure shape.
    const noEmbedder: MemoryEditDeps = { engine: store.engine, audit, actor: 'user:dashboard' }
    await expect(
      createMemoryNode(noEmbedder, { label: 'Knowledge', props: { content: 'quokkas are marsupials' } })
    ).rejects.toThrow(/nothing was saved.*unavailable/)

    const knowledgeAfter = (await store.engine.cypher('MATCH (k:Knowledge) RETURN count(k) AS c'))[0]!['c']
    expect(knowledgeAfter).toEqual(knowledgeBefore)
    expect(audit.listActions({ kind: 'graph-write' }).length).toBe(graphWritesBefore)
  })
})

// ── memory.node.update ───────────────────────────────────────────────────────

describe('updateMemoryNode', () => {
  it('updates a non-retrievable node without re-embedding; undo restores the old value', async () => {
    await store.engine.upsertNode('Tag', { id: 'tag-upd', name: 'before', is_global: false })
    const embedsBefore = fakeEmbedder.calls

    const result = await updateMemoryNode(deps, { label: 'Tag', id: 'tag-upd', props: { name: 'after' } })
    expect(result.auditActionId).not.toBe('')
    expect(fakeEmbedder.calls).toBe(embedsBefore)
    const rows = await store.engine.cypher('MATCH (t:Tag {id: $id}) RETURN t.name AS name', { id: 'tag-upd' })
    expect(rows[0]!['name']).toBe('after')

    await audit.undo(result.auditActionId, 'tester')
    const restored = await store.engine.cypher('MATCH (t:Tag {id: $id}) RETURN t.name AS name', { id: 'tag-upd' })
    expect(restored[0]!['name']).toBe('before')
  })

  it('re-embeds when a retrievable text column changes; undo restores statement AND embedding', async () => {
    await store.engine.upsertNode('Preference', {
      id: 'pref-upd',
      statement: 'use npm',
      embedding: basisEmbedding(EMBEDDING_DIM, 45)
    })
    expect(await vectorHits('Preference', 45, 'pref-upd')).toBe(true)

    fakeEmbedder.axis = 46
    const embedsBefore = fakeEmbedder.calls
    const result = await updateMemoryNode(deps, {
      label: 'Preference',
      id: 'pref-upd',
      props: { statement: 'use pnpm' }
    })
    expect(fakeEmbedder.calls).toBe(embedsBefore + 1)
    expect(await vectorHits('Preference', 46, 'pref-upd')).toBe(true)

    await audit.undo(result.auditActionId, 'tester')
    const rows = await store.engine.cypher('MATCH (p:Preference {id: $id}) RETURN p.statement AS s', { id: 'pref-upd' })
    expect(rows[0]!['s']).toBe('use npm')
    // restore-props restored the embedding too — the OLD vector is served again.
    expect(await vectorHits('Preference', 45, 'pref-upd')).toBe(true)
    expect(await vectorHits('Preference', 46, 'pref-upd')).toBe(false)
  })

  it('does not re-embed when only a non-text property changes on a retrievable label', async () => {
    await store.engine.upsertNode('Skill', {
      id: 'skill-upd',
      name: 'reviewer',
      instructions: 'review the diff',
      embedding: basisEmbedding(EMBEDDING_DIM, 47)
    })
    const embedsBefore = fakeEmbedder.calls
    await updateMemoryNode(deps, { label: 'Skill', id: 'skill-upd', props: { current_version: 'sv-x' } })
    expect(fakeEmbedder.calls).toBe(embedsBefore)
    const rows = await store.engine.cypher('MATCH (s:Skill {id: $id}) RETURN s.current_version AS cv', {
      id: 'skill-upd'
    })
    expect(rows[0]!['cv']).toBe('sv-x')
  })

  it('rejects protected keys, unknown props, empty patches and missing nodes', async () => {
    const graphWritesBefore = audit.listActions({ kind: 'graph-write' }).length
    await expectEditError(
      updateMemoryNode(deps, { label: 'Tag', id: 'tag-upd', props: { created_at: '2026-01-01' } }),
      'INVALID_INPUT',
      /created_at is protected/
    )
    await expectEditError(
      updateMemoryNode(deps, { label: 'Tag', id: 'tag-upd', props: { color: 'red' } }),
      'INVALID_INPUT',
      /'color' is not a writable Tag property/
    )
    await expectEditError(
      updateMemoryNode(deps, { label: 'Tag', id: 'tag-upd', props: {} }),
      'INVALID_INPUT',
      /no properties supplied/
    )
    await expectEditError(
      updateMemoryNode(deps, { label: 'Tag', id: 'tag-missing', props: { name: 'x' } }),
      'NOT_FOUND',
      /does not exist/
    )
    // Blanking every embed-text column of a retrievable node is refused.
    await expectEditError(
      updateMemoryNode(deps, { label: 'Preference', id: 'pref-upd', props: { statement: '' } }),
      'INVALID_INPUT',
      /nothing to embed/
    )
    expect(audit.listActions({ kind: 'graph-write' }).length).toBe(graphWritesBefore)
  })
})

// ── memory.node.delete ───────────────────────────────────────────────────────

describe('deleteMemoryNode', () => {
  it('cascades a Document to its HAS_CHUNK chunks (children first, one job); undo restores everything', async () => {
    await store.engine.upsertNode('Document', { id: 'doc-del', source: 'notes.md', content_hash: 'h1' })
    await store.engine.upsertNode('Knowledge', {
      id: 'kn-del-1',
      content: 'alpha fact',
      embedding: basisEmbedding(EMBEDDING_DIM, 50)
    })
    await store.engine.upsertNode('Knowledge', {
      id: 'kn-del-2',
      content: 'beta fact',
      embedding: basisEmbedding(EMBEDDING_DIM, 51)
    })
    await store.engine.upsertNode('Tag', { id: 'tag-del', name: 'notes', is_global: false })
    await store.engine.createEdge('HAS_CHUNK', { label: 'Document', id: 'doc-del' }, { label: 'Knowledge', id: 'kn-del-1' })
    await store.engine.createEdge('HAS_CHUNK', { label: 'Document', id: 'doc-del' }, { label: 'Knowledge', id: 'kn-del-2' })
    await store.engine.createEdge('TAGGED', { label: 'Knowledge', id: 'kn-del-1' }, { label: 'Tag', id: 'tag-del' })

    const jobsBefore = store.engine.lane.enqueuedCount
    const result = await deleteMemoryNode(deps, { label: 'Document', id: 'doc-del' })
    expect(store.engine.lane.enqueuedCount).toBe(jobsBefore + 1) // ONE lane job for the cascade
    expect(result.deleted).toEqual({ nodes: 3, edges: 3 }) // 2 HAS_CHUNK + 1 TAGGED

    expect(await nodeCount('Document', 'doc-del')).toBe(0)
    expect(await nodeCount('Knowledge', 'kn-del-1')).toBe(0)
    expect(await nodeCount('Knowledge', 'kn-del-2')).toBe(0)
    expect(await nodeCount('Tag', 'tag-del')).toBe(1) // far endpoint survives

    await audit.undo(result.auditActionId, 'tester')
    expect(await nodeCount('Document', 'doc-del')).toBe(1)
    expect(await edgeCount('Document', 'doc-del', 'HAS_CHUNK', 'Knowledge', 'kn-del-1')).toBe(1)
    expect(await edgeCount('Document', 'doc-del', 'HAS_CHUNK', 'Knowledge', 'kn-del-2')).toBe(1)
    expect(await edgeCount('Knowledge', 'kn-del-1', 'TAGGED', 'Tag', 'tag-del')).toBe(1)
    // Chunk embeddings restored — served by the vector index again.
    expect(await vectorHits('Knowledge', 50, 'kn-del-1')).toBe(true)
    expect(await vectorHits('Knowledge', 51, 'kn-del-2')).toBe(true)
  })

  it('cascades a Skill to its HAS_VERSION SkillVersions; undo restores the shape', async () => {
    await store.engine.upsertNode('Skill', {
      id: 'skill-del',
      name: 'migrator',
      instructions: 'run the migration',
      current_version: 'sv-del-2',
      embedding: basisEmbedding(EMBEDDING_DIM, 52)
    })
    await store.engine.upsertNode('SkillVersion', { id: 'sv-del-1', instructions: 'v1', status: 'retired' })
    await store.engine.upsertNode('SkillVersion', { id: 'sv-del-2', instructions: 'v2', status: 'active' })
    await store.engine.upsertNode('Project', { id: 'proj-del', name: 'shop', embedding: basisEmbedding(EMBEDDING_DIM, 53) })
    await store.engine.createEdge('HAS_VERSION', { label: 'Skill', id: 'skill-del' }, { label: 'SkillVersion', id: 'sv-del-1' })
    await store.engine.createEdge('HAS_VERSION', { label: 'Skill', id: 'skill-del' }, { label: 'SkillVersion', id: 'sv-del-2' })
    await store.engine.createEdge('USES', { label: 'Project', id: 'proj-del' }, { label: 'Skill', id: 'skill-del' })

    const result = await deleteMemoryNode(deps, { label: 'Skill', id: 'skill-del' })
    expect(result.deleted).toEqual({ nodes: 3, edges: 3 }) // 2 HAS_VERSION + 1 USES

    expect(await nodeCount('Skill', 'skill-del')).toBe(0)
    expect(await nodeCount('SkillVersion', 'sv-del-1')).toBe(0)
    expect(await nodeCount('SkillVersion', 'sv-del-2')).toBe(0)
    expect(await nodeCount('Project', 'proj-del')).toBe(1)

    await audit.undo(result.auditActionId, 'tester')
    expect(await nodeCount('Skill', 'skill-del')).toBe(1)
    expect(await nodeCount('SkillVersion', 'sv-del-1')).toBe(1)
    expect(await edgeCount('Skill', 'skill-del', 'HAS_VERSION', 'SkillVersion', 'sv-del-2')).toBe(1)
    expect(await edgeCount('Project', 'proj-del', 'USES', 'Skill', 'skill-del')).toBe(1)
    expect(await vectorHits('Skill', 52, 'skill-del')).toBe(true)
  })

  it('deletes a plain node with no cascade and reports it; missing nodes are NOT_FOUND', async () => {
    await store.engine.upsertNode('Tag', { id: 'tag-solo', name: 'solo', is_global: false })
    const result = await deleteMemoryNode(deps, { label: 'Tag', id: 'tag-solo' })
    expect(result.deleted).toEqual({ nodes: 1, edges: 0 })
    expect(await nodeCount('Tag', 'tag-solo')).toBe(0)

    await expectEditError(deleteMemoryNode(deps, { label: 'Tag', id: 'tag-solo' }), 'NOT_FOUND', /does not exist/)
  })
})

// ── memory.edge.create / memory.edge.delete ──────────────────────────────────

describe('createMemoryEdge / deleteMemoryEdge', () => {
  it('creates a schema-valid edge with NO provenance props; undo removes it', async () => {
    await store.engine.upsertNode('Project', { id: 'proj-e', name: 'pe', embedding: basisEmbedding(EMBEDDING_DIM, 60) })
    await store.engine.upsertNode('Skill', {
      id: 'skill-e',
      name: 'se',
      instructions: 'i',
      embedding: basisEmbedding(EMBEDDING_DIM, 61)
    })

    const result = await createMemoryEdge(deps, {
      type: 'USES',
      from: { label: 'Project', id: 'proj-e' },
      to: { label: 'Skill', id: 'skill-e' }
    })
    expect(await edgeCount('Project', 'proj-e', 'USES', 'Skill', 'skill-e')).toBe(1)
    // A user edge carries no extraction stamps — the audit row names the actor.
    const props = await store.engine.cypher(
      'MATCH (:Project {id: $from})-[r:USES]->(:Skill {id: $to}) RETURN r.extracted_by AS eb, r.confidence AS conf',
      { from: 'proj-e', to: 'skill-e' }
    )
    expect(props[0]!['eb'] ?? null).toBeNull()
    expect(props[0]!['conf'] ?? null).toBeNull()

    await audit.undo(result.auditActionId, 'tester')
    expect(await edgeCount('Project', 'proj-e', 'USES', 'Skill', 'skill-e')).toBe(0)
  })

  it('rejects unknown types, non-schema pairs and missing endpoints', async () => {
    await expectEditError(
      createMemoryEdge(deps, { type: 'LIKES', from: { label: 'Project', id: 'proj-e' }, to: { label: 'Skill', id: 'skill-e' } }),
      'INVALID_INPUT',
      /unknown edge type/
    )
    await expectEditError(
      createMemoryEdge(deps, { type: 'USES', from: { label: 'Skill', id: 'skill-e' }, to: { label: 'Project', id: 'proj-e' } }),
      'INVALID_INPUT',
      /USES does not connect Skill→Project.*Project→Skill/
    )
    await expectEditError(
      createMemoryEdge(deps, { type: 'USES', from: { label: 'Project', id: 'proj-e' }, to: { label: 'Skill', id: 'nope' } }),
      'NOT_FOUND',
      /Skill nope does not exist/
    )
  })

  it('deletes an edge (endpoints survive); undo restores it; a missing edge is NOT_FOUND', async () => {
    await store.engine.upsertNode('Tag', { id: 'tag-e', name: 'te', is_global: true })
    await store.engine.createEdge('TAGGED', { label: 'Skill', id: 'skill-e' }, { label: 'Tag', id: 'tag-e' })

    const result = await deleteMemoryEdge(deps, {
      type: 'TAGGED',
      from: { label: 'Skill', id: 'skill-e' },
      to: { label: 'Tag', id: 'tag-e' }
    })
    expect(await edgeCount('Skill', 'skill-e', 'TAGGED', 'Tag', 'tag-e')).toBe(0)
    expect(await nodeCount('Skill', 'skill-e')).toBe(1)
    expect(await nodeCount('Tag', 'tag-e')).toBe(1)

    await audit.undo(result.auditActionId, 'tester')
    expect(await edgeCount('Skill', 'skill-e', 'TAGGED', 'Tag', 'tag-e')).toBe(1)

    await expectEditError(
      deleteMemoryEdge(deps, { type: 'APPLIES_TO', from: { label: 'Preference', id: 'pref-upd' }, to: { label: 'Tag', id: 'tag-e' } }),
      'NOT_FOUND',
      /no APPLIES_TO edge/
    )
  })
})

// ── shared-IPC edge vocabulary drift pin ─────────────────────────────────────

describe('shared IPC edge vocabulary', () => {
  it('IPC_EDGE_TYPES / IPC_EDGE_PAIRS mirror REL_TABLES exactly (no drift)', () => {
    expect([...IPC_EDGE_TYPES]).toEqual(REL_TABLES.map((spec) => spec.type))
    for (const spec of REL_TABLES) {
      expect(IPC_EDGE_PAIRS[spec.type]).toEqual(spec.pairs)
    }
  })
})
