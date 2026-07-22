/**
 * Batch "accept all suggested" dedupe merge (mergeDuplicateGroups) over the REAL
 * engine + audit log:
 *
 *  - many groups across Preference/Knowledge/Tag collapse in ONE audited lane job
 *    (one undoable action), the surviving counts summed correctly;
 *  - a single undo of that action restores every removed node (with embedding)
 *    and every re-pointed edge, and drops the re-points — the graph equals its
 *    pre-merge state;
 *  - a stale scan is tolerated: a group whose keeper/removal vanished is SKIPPED
 *    with a reason (never fatal) while the rest merge, and a later group that
 *    overlaps a node an earlier group already removed is skipped too;
 *  - when nothing survives validation NO lane job runs and no audit_log row is
 *    added (auditActionId is null).
 *
 * Embeddings are seeded directly (basisEmbedding) so a vector probe is a
 * deterministic identity check. ONE store per file (ryugraph teardown discipline,
 * phase 08); each describe seeds its own ids.
 */
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { EMBEDDING_DIM } from '../../src/main/config'
import {
  mergeDuplicateGroups,
  type DedupeMergeDeps,
  type MergeDuplicateGroupsResult
} from '../../src/main/memory'
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

const deps = (): DedupeMergeDeps => ({ engine: store.engine, audit, actor: 'user:dashboard' })

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

const vectorHit = async (label: 'Preference' | 'Knowledge', axis: number, id: string): Promise<boolean> => {
  const hits = await store.engine.vectorSearch(label, basisEmbedding(EMBEDDING_DIM, axis), 5)
  return hits.some((h) => h.id === id && h.distance < 0.001)
}

const auditRowCount = (): number =>
  Number((appData.db.prepare('SELECT count(*) AS c FROM audit_log').get() as { c: number }).c)

// ── one batch, three groups across labels: merge then a single undo ─────────────

describe('mergeDuplicateGroups — batch of 3 across Preference/Knowledge/Tag', () => {
  let result: MergeDuplicateGroupsResult
  let jobsBefore: number

  beforeAll(async () => {
    const e = store.engine
    // Group A — Preference bp-keep ← bp-rm (bp-rm carries one APPLIES_TO edge).
    await e.upsertNode('Preference', { id: 'bp-keep', statement: 'prefers vitest', embedding: basisEmbedding(EMBEDDING_DIM, 90) })
    await e.upsertNode('Preference', { id: 'bp-rm', statement: 'prefers vitest', embedding: basisEmbedding(EMBEDDING_DIM, 91) })
    await e.upsertNode('Tag', { id: 'bp-tag', name: 'testing', is_global: false })
    await e.createEdge('APPLIES_TO', { label: 'Preference', id: 'bp-rm' }, { label: 'Tag', id: 'bp-tag' })

    // Group B — Knowledge bk-keep ← bk-rm (a TAGGED, a props-bearing extraction,
    // and an incoming HAS_CHUNK to re-point).
    await e.upsertNode('Knowledge', { id: 'bk-keep', content: 'ci pipeline notes', embedding: basisEmbedding(EMBEDDING_DIM, 92) })
    await e.upsertNode('Knowledge', { id: 'bk-rm', content: 'ci pipeline notes', embedding: basisEmbedding(EMBEDDING_DIM, 93) })
    await e.upsertNode('Session', { id: 'bk-sess' })
    await e.upsertNode('Document', { id: 'bk-doc', source: 'ci.md', content_hash: 'h' })
    await e.upsertNode('Tag', { id: 'bk-tag', name: 'ci', is_global: false })
    await e.createEdge('TAGGED', { label: 'Knowledge', id: 'bk-rm' }, { label: 'Tag', id: 'bk-tag' })
    await e.createEdge('EXTRACTED_FROM', { label: 'Knowledge', id: 'bk-rm' }, { label: 'Session', id: 'bk-sess' }, { extracted_by: 'batch-prov@1', confidence: 0.6 })
    await e.createEdge('HAS_CHUNK', { label: 'Document', id: 'bk-doc' }, { label: 'Knowledge', id: 'bk-rm' })

    // Group C — Tag bt-keep ← bt-rm (an incoming TAGGED from a Project).
    await e.upsertNode('Project', { id: 'bt-proj', name: 'shop', embedding: basisEmbedding(EMBEDDING_DIM, 94) })
    await e.upsertNode('Tag', { id: 'bt-keep', name: 'keepC', is_global: false })
    await e.upsertNode('Tag', { id: 'bt-rm', name: 'dupC', is_global: false })
    await e.createEdge('TAGGED', { label: 'Project', id: 'bt-proj' }, { label: 'Tag', id: 'bt-rm' })

    jobsBefore = store.engine.lane.enqueuedCount
    result = await mergeDuplicateGroups(deps(), {
      groups: [
        { label: 'Preference', keepId: 'bp-keep', removeIds: ['bp-rm'] },
        { label: 'Knowledge', keepId: 'bk-keep', removeIds: ['bk-rm'] },
        { label: 'Tag', keepId: 'bt-keep', removeIds: ['bt-rm'] }
      ]
    })
  })

  it('runs ONE audited lane job with correct summed counts; every group merges', async () => {
    expect(store.engine.lane.enqueuedCount).toBe(jobsBefore + 1) // ONE audited lane job for the whole batch
    expect(result.auditActionId).toEqual(expect.any(String))
    expect(result.mergedGroups).toBe(3)
    expect(result.removed).toBe(3)
    expect(result.edgesRepointed).toBe(5) // 1 (Pref) + 3 (Knowledge) + 1 (Tag)
    expect(result.edgesDropped).toBe(0)
    expect(result.skipped).toEqual([])

    // Every duplicate is gone, every keeper survives.
    expect(await nodeCount('Preference', 'bp-rm')).toBe(0)
    expect(await nodeCount('Knowledge', 'bk-rm')).toBe(0)
    expect(await nodeCount('Tag', 'bt-rm')).toBe(0)
    expect(await nodeCount('Preference', 'bp-keep')).toBe(1)
    expect(await nodeCount('Knowledge', 'bk-keep')).toBe(1)
    expect(await nodeCount('Tag', 'bt-keep')).toBe(1)

    // Edges re-pointed onto the keepers (props preserved on the extraction edge).
    expect(await edgeCount('Preference', 'bp-keep', 'APPLIES_TO', 'Tag', 'bp-tag')).toBe(1)
    expect(await edgeCount('Knowledge', 'bk-keep', 'TAGGED', 'Tag', 'bk-tag')).toBe(1)
    expect(await edgeCount('Knowledge', 'bk-keep', 'EXTRACTED_FROM', 'Session', 'bk-sess')).toBe(1)
    expect(await edgeCount('Document', 'bk-doc', 'HAS_CHUNK', 'Knowledge', 'bk-keep')).toBe(1)
    expect(await edgeCount('Project', 'bt-proj', 'TAGGED', 'Tag', 'bt-keep')).toBe(1)
    const props = await store.engine.cypher(
      'MATCH (:Knowledge {id: "bk-keep"})-[r:EXTRACTED_FROM]->(:Session {id: "bk-sess"}) RETURN r.extracted_by AS by, r.confidence AS conf'
    )
    expect(props[0]?.['by']).toBe('batch-prov@1')
    expect(Number(props[0]?.['conf'])).toBeCloseTo(0.6)
  })

  it('a single undo of the batch action restores every node + edge and drops the re-points', async () => {
    await audit.undo(result.auditActionId!, 'tester')

    // Every removed node is back, embeddings included.
    expect(await nodeCount('Preference', 'bp-rm')).toBe(1)
    expect(await nodeCount('Knowledge', 'bk-rm')).toBe(1)
    expect(await nodeCount('Tag', 'bt-rm')).toBe(1)
    expect(await vectorHit('Preference', 91, 'bp-rm')).toBe(true)
    expect(await vectorHit('Knowledge', 93, 'bk-rm')).toBe(true)

    // Every original edge is back on its original endpoint.
    expect(await edgeCount('Preference', 'bp-rm', 'APPLIES_TO', 'Tag', 'bp-tag')).toBe(1)
    expect(await edgeCount('Knowledge', 'bk-rm', 'TAGGED', 'Tag', 'bk-tag')).toBe(1)
    expect(await edgeCount('Knowledge', 'bk-rm', 'EXTRACTED_FROM', 'Session', 'bk-sess')).toBe(1)
    expect(await edgeCount('Document', 'bk-doc', 'HAS_CHUNK', 'Knowledge', 'bk-rm')).toBe(1)
    expect(await edgeCount('Project', 'bt-proj', 'TAGGED', 'Tag', 'bt-rm')).toBe(1)

    // The re-points created by the merge are gone from the keepers.
    expect(await edgeCount('Preference', 'bp-keep', 'APPLIES_TO', 'Tag', 'bp-tag')).toBe(0)
    expect(await edgeCount('Knowledge', 'bk-keep', 'TAGGED', 'Tag', 'bk-tag')).toBe(0)
    expect(await edgeCount('Knowledge', 'bk-keep', 'EXTRACTED_FROM', 'Session', 'bk-sess')).toBe(0)
    expect(await edgeCount('Document', 'bk-doc', 'HAS_CHUNK', 'Knowledge', 'bk-keep')).toBe(0)
    expect(await edgeCount('Project', 'bt-proj', 'TAGGED', 'Tag', 'bt-keep')).toBe(0)
  })
})

// ── stale-scan tolerance: skips (never fatal) ────────────────────────────────────

describe('mergeDuplicateGroups — stale-scan skips', () => {
  it('skips a group whose keeper vanished since the scan, merges the rest', async () => {
    const e = store.engine
    // A valid Tag group…
    await e.upsertNode('Project', { id: 'sk-proj', name: 'p', embedding: basisEmbedding(EMBEDDING_DIM, 96) })
    await e.upsertNode('Tag', { id: 'sk-keep', name: 'keepX', is_global: false })
    await e.upsertNode('Tag', { id: 'sk-rm', name: 'dupX', is_global: false })
    await e.createEdge('TAGGED', { label: 'Project', id: 'sk-proj' }, { label: 'Tag', id: 'sk-rm' })
    // …and a stale group: 'sk-gone-keep' was never re-created after the scan.
    await e.upsertNode('Tag', { id: 'sk-gone-rm', name: 'dupY', is_global: false })

    const jobsBefore = e.lane.enqueuedCount
    const res = await mergeDuplicateGroups(deps(), {
      groups: [
        { label: 'Tag', keepId: 'sk-gone-keep', removeIds: ['sk-gone-rm'] }, // keeper missing → skipped
        { label: 'Tag', keepId: 'sk-keep', removeIds: ['sk-rm'] } // merges
      ]
    })

    expect(e.lane.enqueuedCount).toBe(jobsBefore + 1) // one job for the surviving group
    expect(res.auditActionId).toEqual(expect.any(String))
    expect(res.mergedGroups).toBe(1)
    expect(res.removed).toBe(1)
    expect(res.edgesRepointed).toBe(1)
    expect(res.skipped).toHaveLength(1)
    expect(res.skipped[0]).toMatchObject({ label: 'Tag', keepId: 'sk-gone-keep' })
    expect(res.skipped[0]!.reason).toMatch(/does not exist/)

    // The valid group merged; the skipped group's node is untouched.
    expect(await nodeCount('Tag', 'sk-rm')).toBe(0)
    expect(await nodeCount('Tag', 'sk-keep')).toBe(1)
    expect(await edgeCount('Project', 'sk-proj', 'TAGGED', 'Tag', 'sk-keep')).toBe(1)
    expect(await nodeCount('Tag', 'sk-gone-rm')).toBe(1)
  })

  it('skips a later group that overlaps a node an earlier group already removed', async () => {
    const e = store.engine
    await e.upsertNode('Tag', { id: 'ov-keep', name: 'ovKeep', is_global: false })
    await e.upsertNode('Tag', { id: 'ov-shared', name: 'ovDup', is_global: false }) // removed by group 1
    await e.upsertNode('Tag', { id: 'ov-keep2', name: 'ovKeep2', is_global: false })

    const jobsBefore = e.lane.enqueuedCount
    const res = await mergeDuplicateGroups(deps(), {
      groups: [
        { label: 'Tag', keepId: 'ov-keep', removeIds: ['ov-shared'] }, // consumes ov-shared
        { label: 'Tag', keepId: 'ov-keep2', removeIds: ['ov-shared'] } // overlaps → skipped
      ]
    })

    expect(e.lane.enqueuedCount).toBe(jobsBefore + 1) // only group 1 ran
    expect(res.mergedGroups).toBe(1)
    expect(res.skipped).toHaveLength(1)
    expect(res.skipped[0]).toMatchObject({
      label: 'Tag',
      keepId: 'ov-keep2',
      reason: 'overlaps an earlier merge in this batch'
    })
    expect(await nodeCount('Tag', 'ov-shared')).toBe(0) // removed by group 1
    expect(await nodeCount('Tag', 'ov-keep2')).toBe(1) // group 2 skipped, its keeper intact
  })

  it('all groups vanished → auditActionId null, no lane job, no audit_log row added', async () => {
    const rowsBefore = auditRowCount()
    const jobsBefore = store.engine.lane.enqueuedCount
    const res = await mergeDuplicateGroups(deps(), {
      groups: [
        { label: 'Tag', keepId: 'ghost-1', removeIds: ['ghost-2'] },
        { label: 'Knowledge', keepId: 'ghost-3', removeIds: ['ghost-4'] }
      ]
    })

    expect(res.auditActionId).toBeNull()
    expect(res.mergedGroups).toBe(0)
    expect(res.removed).toBe(0)
    expect(res.edgesRepointed).toBe(0)
    expect(res.edgesDropped).toBe(0)
    expect(res.skipped).toHaveLength(2)
    expect(store.engine.lane.enqueuedCount).toBe(jobsBefore) // no lane job ran
    expect(auditRowCount()).toBe(rowsBefore) // and no audit_log row was inserted
  })

  it('still throws INVALID_INPUT for a structurally bad group (keeper ∈ removeIds)', async () => {
    await expect(
      mergeDuplicateGroups(deps(), { groups: [{ label: 'Tag', keepId: 'x', removeIds: ['x'] }] })
    ).rejects.toSatisfy((err: unknown) => err instanceof Error && /cannot also be/.test(err.message))
  })
})

// ── cross-group edges: an edge whose BOTH endpoints are removed in DIFFERENT
//    groups of one batch must re-point keeperA→keeperB, never be silently lost ───
//
// Regression: collectGroupMerge used to re-point each group against ONLY its own
// removeSet, so a k_rm-[TAGGED]->t_rm edge (Knowledge removed in group K, Tag
// removed in group T) became k_keep→t_rm in K and k_rm→t_keep in T — both copies
// pointing at a node the batch then DETACH-deleted. The intended k_keep→t_keep was
// never created and the loss was NOT counted in edgesDropped. The batch now shares
// one removed→keeper map across every group, so both endpoints re-point together.

describe('mergeDuplicateGroups — cross-group edge (both endpoints removed in different groups)', () => {
  let result: MergeDuplicateGroupsResult

  beforeAll(async () => {
    const e = store.engine
    // A Knowledge group, a Preference group and a Tag group accepted together.
    // The removed Knowledge is TAGGED to the removed Tag, and the removed
    // Preference APPLIES_TO the SAME removed Tag — each edge has BOTH endpoints
    // removed, across two different groups (the exact 'accept all' hazard).
    await e.upsertNode('Knowledge', { id: 'cg-k-keep', content: 'react hooks notes', embedding: basisEmbedding(EMBEDDING_DIM, 70) })
    await e.upsertNode('Knowledge', { id: 'cg-k-rm', content: 'react hooks notes', embedding: basisEmbedding(EMBEDDING_DIM, 71) })
    await e.upsertNode('Preference', { id: 'cg-p-keep', statement: 'prefers eslint', embedding: basisEmbedding(EMBEDDING_DIM, 72) })
    await e.upsertNode('Preference', { id: 'cg-p-rm', statement: 'prefers eslint', embedding: basisEmbedding(EMBEDDING_DIM, 73) })
    await e.upsertNode('Tag', { id: 'cg-t-keep', name: 'js', is_global: false })
    await e.upsertNode('Tag', { id: 'cg-t-rm', name: 'javascript', is_global: false })
    await e.createEdge('TAGGED', { label: 'Knowledge', id: 'cg-k-rm' }, { label: 'Tag', id: 'cg-t-rm' })
    await e.createEdge('APPLIES_TO', { label: 'Preference', id: 'cg-p-rm' }, { label: 'Tag', id: 'cg-t-rm' })

    result = await mergeDuplicateGroups(deps(), {
      groups: [
        { label: 'Knowledge', keepId: 'cg-k-keep', removeIds: ['cg-k-rm'] },
        { label: 'Preference', keepId: 'cg-p-keep', removeIds: ['cg-p-rm'] },
        { label: 'Tag', keepId: 'cg-t-keep', removeIds: ['cg-t-rm'] }
      ]
    })
  })

  it('re-points a cross-group edge onto keeperA→keeperB instead of dropping it', async () => {
    expect(result.mergedGroups).toBe(3)
    expect(result.removed).toBe(3)
    // Each cross-group edge re-points ONCE (not double-counted per group)…
    expect(result.edgesRepointed).toBe(2)
    // …and NOTHING is dropped — the associations survive on the keepers.
    expect(result.edgesDropped).toBe(0)
    expect(result.skipped).toEqual([])

    // The keeper→keeper edges exist (the bug lost these entirely, silently).
    expect(await edgeCount('Knowledge', 'cg-k-keep', 'TAGGED', 'Tag', 'cg-t-keep')).toBe(1)
    expect(await edgeCount('Preference', 'cg-p-keep', 'APPLIES_TO', 'Tag', 'cg-t-keep')).toBe(1)

    // Every duplicate is gone, and no stray edge is left on a removed endpoint.
    expect(await nodeCount('Knowledge', 'cg-k-rm')).toBe(0)
    expect(await nodeCount('Preference', 'cg-p-rm')).toBe(0)
    expect(await nodeCount('Tag', 'cg-t-rm')).toBe(0)
    expect(await edgeCount('Knowledge', 'cg-k-rm', 'TAGGED', 'Tag', 'cg-t-keep')).toBe(0)
    expect(await edgeCount('Preference', 'cg-p-rm', 'APPLIES_TO', 'Tag', 'cg-t-keep')).toBe(0)
  })

  it('a single undo restores the pre-merge cross-group edges and drops the keeper re-points', async () => {
    await audit.undo(result.auditActionId!, 'tester')

    // Removed nodes (embeddings included) and their original cross-group edges are back.
    expect(await nodeCount('Knowledge', 'cg-k-rm')).toBe(1)
    expect(await nodeCount('Preference', 'cg-p-rm')).toBe(1)
    expect(await nodeCount('Tag', 'cg-t-rm')).toBe(1)
    expect(await vectorHit('Knowledge', 71, 'cg-k-rm')).toBe(true)
    expect(await edgeCount('Knowledge', 'cg-k-rm', 'TAGGED', 'Tag', 'cg-t-rm')).toBe(1)
    expect(await edgeCount('Preference', 'cg-p-rm', 'APPLIES_TO', 'Tag', 'cg-t-rm')).toBe(1)

    // The keeper→keeper re-points created by the merge are gone.
    expect(await edgeCount('Knowledge', 'cg-k-keep', 'TAGGED', 'Tag', 'cg-t-keep')).toBe(0)
    expect(await edgeCount('Preference', 'cg-p-keep', 'APPLIES_TO', 'Tag', 'cg-t-keep')).toBe(0)
  })
})
