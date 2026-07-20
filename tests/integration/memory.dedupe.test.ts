/**
 * Memory deduplication (dashboard maintenance) over the REAL engine + audit log
 * + appdata staging:
 *
 *  - scanDuplicates groups EXACT (normalized text/name) and NEAR (embedding
 *    cosine ≥ threshold) duplicates, leaves a just-below-threshold pair alone,
 *    and suggests the best-connected keeper;
 *  - mergeDuplicates re-points a removed node's edges onto the keeper (schema
 *    pairs, props preserved, MERGE-idempotent), deletes the duplicates in ONE
 *    audited lane job, and a single undo restores nodes + edges + embeddings;
 *  - v1 refuses Skill/Project (scan-report-only) and bad requests pre-lane;
 *  - the MCP list_duplicate_memories / propose_dedupe_merge tools reuse the same
 *    services (the proposer STAGES a `dedupe-merge` row → approve runs the same
 *    merge; reject leaves no residue), and the runner allowlist never gains them.
 *
 * Embeddings are seeded directly (basisEmbedding / blendEmbedding) so cosine is
 * controllable. ONE store per test file (ryugraph 25.9.1 teardown discipline,
 * phase 08); each describe seeds its own ids, and describe order means the scan
 * suite runs before the merge/MCP suites seed.
 */
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { EMBEDDING_DIM } from '../../src/main/config'
import {
  DEDUPE_LABELS,
  DEDUPE_MERGE_LABELS,
  DedupeScanAbortedError,
  MemoryEditError,
  mergeDuplicates,
  scanDuplicates,
  type DedupeMergeDeps,
  type DuplicateGroup
} from '../../src/main/memory'
import {
  approveStagedWrite,
  AuditLog,
  DASHBOARD_TOOLS,
  DEDUPE_MERGE_STAGED_KIND,
  listStagedWrites,
  READ_TOOLS,
  rejectStagedWrite,
  renderStagedWriteDiff,
  STAGING_TOOLS,
  type StagedWritesDeps
} from '../../src/main/security'
import { MCP_TOOLS, RUNNER_SESSION_ALLOWLIST, ToolError, type ToolContext } from '../../src/main/mcp'
import { openAppData, RETRIEVABLE_LABELS, type AppData } from '../../src/main/storage'
import { basisEmbedding, blendEmbedding, openTestStore, type TestStore } from './helpers'

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

const vectorHit = async (label: 'Preference' | 'Knowledge', axis: number, id: string): Promise<boolean> => {
  const hits = await store.engine.vectorSearch(label, basisEmbedding(EMBEDDING_DIM, axis), 5)
  return hits.some((h) => h.id === id && h.distance < 0.001)
}

const groupWith = (
  groups: readonly DuplicateGroup[],
  label: string,
  reason: 'exact' | 'near',
  ...ids: string[]
): DuplicateGroup | undefined =>
  groups.find((g) => g.label === label && g.reason === reason && ids.every((id) => g.nodes.some((n) => n.id === id)))

// ── scanDuplicates ─────────────────────────────────────────────────────────────

describe('scanDuplicates', () => {
  beforeAll(async () => {
    const e = store.engine
    // Exact Preference pair (casing/whitespace differ → same normalized key).
    // pe-1 carries one edge so it is the suggested keeper (most edges).
    await e.upsertNode('Preference', { id: 'pe-1', statement: 'Prefers pnpm for installs', embedding: basisEmbedding(EMBEDDING_DIM, 30) })
    await e.upsertNode('Preference', { id: 'pe-2', statement: '  prefers   PNPM   for installs ', embedding: basisEmbedding(EMBEDDING_DIM, 30) })
    await e.upsertNode('Tag', { id: 'tg-pref', name: 'installs', is_global: false })
    await e.createEdge('APPLIES_TO', { label: 'Preference', id: 'pe-1' }, { label: 'Tag', id: 'tg-pref' })

    // Near pair ABOVE threshold (cosine ≈ 0.985) — distinct text, similar vectors.
    await e.upsertNode('Preference', { id: 'pn-1', statement: 'use turbo for the monorepo build', embedding: basisEmbedding(EMBEDDING_DIM, 40) })
    await e.upsertNode('Preference', { id: 'pn-2', statement: 'the monorepo build should use turborepo', embedding: blendEmbedding(EMBEDDING_DIM, 40, 41, 0.85) })

    // Near pair BELOW threshold (cosine ≈ 0.889) — must NOT group at 0.95.
    await e.upsertNode('Preference', { id: 'pb-1', statement: 'deploy via the north region', embedding: basisEmbedding(EMBEDDING_DIM, 50) })
    await e.upsertNode('Preference', { id: 'pb-2', statement: 'ship using the northern datacenter', embedding: blendEmbedding(EMBEDDING_DIM, 50, 51, 0.66) })

    // Exact Tag pair (normalized name equality) + a unique tag.
    await e.upsertNode('Tag', { id: 'tg-1', name: 'Tooling', is_global: false })
    await e.upsertNode('Tag', { id: 'tg-2', name: 'tooling', is_global: false })
    await e.upsertNode('Tag', { id: 'tg-solo', name: 'unique', is_global: false })

    // Exact Preference trio for the keeper-ranking test (2 / 1 / 1 edges).
    await e.upsertNode('Tag', { id: 'tg-k1', name: 'typescript', is_global: false })
    await e.upsertNode('Tag', { id: 'tg-k2', name: 'strictness', is_global: false })
    for (const id of ['pk-a', 'pk-b', 'pk-c']) {
      await e.upsertNode('Preference', { id, statement: 'likes strict typescript', embedding: basisEmbedding(EMBEDDING_DIM, 45) })
    }
    await e.createEdge('APPLIES_TO', { label: 'Preference', id: 'pk-a' }, { label: 'Tag', id: 'tg-k1' })
    await e.createEdge('APPLIES_TO', { label: 'Preference', id: 'pk-b' }, { label: 'Tag', id: 'tg-k1' })
    await e.createEdge('APPLIES_TO', { label: 'Preference', id: 'pk-c' }, { label: 'Tag', id: 'tg-k1' })
    await e.createEdge('APPLIES_TO', { label: 'Preference', id: 'pk-c' }, { label: 'Tag', id: 'tg-k2' })
  })

  it('groups exact text/name duplicates and near pairs; a below-threshold pair is not grouped', async () => {
    const { groups, truncated } = await scanDuplicates({ engine: store.engine })
    expect(truncated).toBe(false)

    // Exact Preference group — no similarity, keeper is the edged pe-1.
    const exactPref = groupWith(groups, 'Preference', 'exact', 'pe-1', 'pe-2')
    expect(exactPref).toBeDefined()
    expect(exactPref!.similarity).toBeUndefined()
    expect(exactPref!.suggestedKeepId).toBe('pe-1')

    // Near Preference group above threshold — carries a similarity ≥ 0.95.
    const near = groupWith(groups, 'Preference', 'near', 'pn-1', 'pn-2')
    expect(near).toBeDefined()
    expect(near!.similarity).toBeGreaterThanOrEqual(0.95)
    expect(near!.similarity).toBeLessThanOrEqual(1)

    // The below-threshold pair forms NO group (exact or near).
    expect(groups.some((g) => g.nodes.some((n) => n.id === 'pb-1'))).toBe(false)
    expect(groups.some((g) => g.nodes.some((n) => n.id === 'pb-2'))).toBe(false)

    // Exact Tag group; the unique tag is never grouped.
    expect(groupWith(groups, 'Tag', 'exact', 'tg-1', 'tg-2')).toBeDefined()
    expect(groups.some((g) => g.nodes.some((n) => n.id === 'tg-solo'))).toBe(false)
  })

  it('threshold plumbs through: 0.99 drops the near pair, 0.85 catches the below pair', async () => {
    const strict = await scanDuplicates({ engine: store.engine }, { threshold: 0.99 })
    expect(groupWith(strict.groups, 'Preference', 'near', 'pn-1', 'pn-2')).toBeUndefined()

    const loose = await scanDuplicates({ engine: store.engine }, { threshold: 0.85 })
    expect(groupWith(loose.groups, 'Preference', 'near', 'pb-1', 'pb-2')).toBeDefined()
  })

  it('suggestedKeepId is the most-connected node, ties broken by newest', async () => {
    const { groups } = await scanDuplicates({ engine: store.engine }, { labels: ['Preference'] })
    const group = groupWith(groups, 'Preference', 'exact', 'pk-a', 'pk-b', 'pk-c')
    expect(group).toBeDefined()
    expect(group!.suggestedKeepId).toBe('pk-c') // 2 edges beats 1 + 1
    expect(group!.nodes[0]!.id).toBe('pk-c')
    expect(group!.nodes[0]!.edgeCount).toBe(2)
    // The two tied (1-edge) members are ordered newest-first.
    expect(group!.nodes[1]!.edgeCount).toBe(1)
    expect(group!.nodes[2]!.edgeCount).toBe(1)
    expect(group!.nodes[1]!.updatedAt! >= group!.nodes[2]!.updatedAt!).toBe(true)
  })

  it('rejects an unsupported scan label', async () => {
    await expect(scanDuplicates({ engine: store.engine }, { labels: ['Session'] })).rejects.toSatisfy(
      (err: unknown) => err instanceof MemoryEditError && err.code === 'INVALID_INPUT'
    )
  })

  it('DEDUPE_LABELS mirrors the retrievable labels + Tag (no drift)', () => {
    expect([...DEDUPE_LABELS]).toEqual([...RETRIEVABLE_LABELS, 'Tag'])
  })
})

// ── scope + cost controls (recent / count / near-off) ────────────────────────────
//
// All over the Knowledge label with hand-set updated_at, so a scope filter is
// observable. Layout (older → newer):
//   alpha  sc-a1(OLD1) sc-a2(OLD2)   — exact dup, BOTH old
//   beta   sc-b1(OLD2) sc-b2(NEW3)   — exact dup spanning the cutoff (recent-vs-OLD)
//   gamma  sc-n1(NEW1) sc-n2(NEW2)   — NEAR dup, both recent

describe('scanDuplicates scope + cost controls', () => {
  const OLD1 = '2024-01-01T00:00:00.000Z'
  const OLD2 = '2024-02-01T00:00:00.000Z'
  const MID = '2024-06-01T00:00:00.000Z'
  const NEW1 = '2024-10-01T00:00:00.000Z'
  const NEW2 = '2024-11-01T00:00:00.000Z'
  const NEW3 = '2024-12-01T00:00:00.000Z'

  const setUpdatedAt = async (id: string, iso: string): Promise<void> => {
    await store.engine.cypher('MATCH (n:Knowledge {id: $id}) SET n.updated_at = timestamp($ts)', { id, ts: iso })
  }

  beforeAll(async () => {
    const e = store.engine
    await e.upsertNode('Knowledge', { id: 'sc-a1', content: 'alpha note', embedding: basisEmbedding(EMBEDDING_DIM, 70) })
    await e.upsertNode('Knowledge', { id: 'sc-a2', content: 'alpha note', embedding: basisEmbedding(EMBEDDING_DIM, 70) })
    await e.upsertNode('Knowledge', { id: 'sc-b1', content: 'beta note', embedding: basisEmbedding(EMBEDDING_DIM, 71) })
    await e.upsertNode('Knowledge', { id: 'sc-b2', content: 'beta note', embedding: basisEmbedding(EMBEDDING_DIM, 71) })
    await e.upsertNode('Knowledge', { id: 'sc-n1', content: 'gamma release plan', embedding: basisEmbedding(EMBEDDING_DIM, 72) })
    await e.upsertNode('Knowledge', { id: 'sc-n2', content: 'the gamma release schedule', embedding: blendEmbedding(EMBEDDING_DIM, 72, 73, 0.85) })
    await setUpdatedAt('sc-a1', OLD1)
    await setUpdatedAt('sc-a2', OLD2)
    await setUpdatedAt('sc-b1', OLD2)
    await setUpdatedAt('sc-b2', NEW3)
    await setUpdatedAt('sc-n1', NEW1)
    await setUpdatedAt('sc-n2', NEW2)
  })

  it('near:false runs the cheap exact-only pass — exact groups, zero near work', async () => {
    const res = await scanDuplicates({ engine: store.engine }, { labels: ['Knowledge'], near: false })
    expect(groupWith(res.groups, 'Knowledge', 'exact', 'sc-a1', 'sc-a2')).toBeDefined()
    expect(groupWith(res.groups, 'Knowledge', 'exact', 'sc-b1', 'sc-b2')).toBeDefined()
    expect(res.groups.some((g) => g.reason === 'near')).toBe(false)
    expect(res.scannedNodes).toBe(0) // no vector probes at all
  })

  it("scope 'recent' surfaces a recent-vs-OLD duplicate (old member pulled in) and skips all-old groups, probing only recent candidates", async () => {
    const res = await scanDuplicates(
      { engine: store.engine },
      { labels: ['Knowledge'], scope: 'recent', sinceUpdatedAtIso: MID }
    )
    // The beta exact group is surfaced BECAUSE sc-b2 is recent — and it still
    // includes the OLD sc-b1 (materialized on demand).
    const beta = groupWith(res.groups, 'Knowledge', 'exact', 'sc-b1', 'sc-b2')
    expect(beta).toBeDefined()
    // The all-old alpha group is NOT surfaced.
    expect(res.groups.some((g) => g.nodes.some((n) => n.id === 'sc-a1'))).toBe(false)
    // The recent near pair is surfaced.
    expect(groupWith(res.groups, 'Knowledge', 'near', 'sc-n1', 'sc-n2')).toBeDefined()
    // Only the 3 recent candidates were examined (not all 6 nodes) — the cost win.
    expect(res.scannedNodes).toBe(3)
  })

  it("scope 'count' compares only the newest N (a lower N excludes older duplicates)", async () => {
    // Newest 2 by updated_at: sc-b2 (NEW3), sc-n2 (NEW2).
    const two = await scanDuplicates({ engine: store.engine }, { labels: ['Knowledge'], scope: 'count', count: 2 })
    expect(two.scannedNodes).toBe(2)
    expect(groupWith(two.groups, 'Knowledge', 'exact', 'sc-b1', 'sc-b2')).toBeDefined() // sc-b2 in newest-2
    expect(two.groups.some((g) => g.nodes.some((n) => n.id === 'sc-a1'))).toBe(false) // alpha not in newest-2

    // Newest 1 = sc-b2 only → nothing probes the gamma near pair.
    const one = await scanDuplicates({ engine: store.engine }, { labels: ['Knowledge'], scope: 'count', count: 1 })
    expect(one.scannedNodes).toBe(1)
    expect(one.groups.some((g) => g.reason === 'near')).toBe(false)
  })

  it('throws DedupeScanAbortedError when the signal is already aborted', async () => {
    const ctrl = new AbortController()
    ctrl.abort()
    await expect(
      scanDuplicates({ engine: store.engine }, { labels: ['Knowledge'], signal: ctrl.signal })
    ).rejects.toBeInstanceOf(DedupeScanAbortedError)
  })
})

// ── mergeDuplicates ────────────────────────────────────────────────────────────

describe('mergeDuplicates', () => {
  const deps = (): DedupeMergeDeps => ({ engine: store.engine, audit, actor: 'user:dashboard' })

  it('re-points edges onto the keeper (props preserved, idempotent), deletes duplicates; one undo restores it all', async () => {
    const e = store.engine
    await e.upsertNode('Session', { id: 'sess-1' })
    await e.upsertNode('Document', { id: 'doc-1', source: 'notes.md', content_hash: 'h' })
    await e.upsertNode('Tag', { id: 'tg-a', name: 'survivor-tag', is_global: false })
    await e.upsertNode('Tag', { id: 'tg-x', name: 'shared-tag', is_global: false })
    await e.upsertNode('Knowledge', { id: 'kn-keep', content: 'north region deploy notes', embedding: basisEmbedding(EMBEDDING_DIM, 60) })
    await e.upsertNode('Knowledge', { id: 'kn-rm1', content: 'northern deploy notes', embedding: basisEmbedding(EMBEDDING_DIM, 61) })
    await e.upsertNode('Knowledge', { id: 'kn-rm2', content: 'up north datacenter notes', embedding: basisEmbedding(EMBEDDING_DIM, 62) })

    // Keeper already tagged tg-x (the idempotency target).
    await e.createEdge('TAGGED', { label: 'Knowledge', id: 'kn-keep' }, { label: 'Tag', id: 'tg-x' })
    // rm1: a fresh survivor tag, the shared tag, a props-bearing extraction edge, an incoming chunk edge.
    await e.createEdge('TAGGED', { label: 'Knowledge', id: 'kn-rm1' }, { label: 'Tag', id: 'tg-a' })
    await e.createEdge('TAGGED', { label: 'Knowledge', id: 'kn-rm1' }, { label: 'Tag', id: 'tg-x' })
    await e.createEdge('EXTRACTED_FROM', { label: 'Knowledge', id: 'kn-rm1' }, { label: 'Session', id: 'sess-1' }, { extracted_by: 'test-prov@1', confidence: 0.7 })
    await e.createEdge('HAS_CHUNK', { label: 'Document', id: 'doc-1' }, { label: 'Knowledge', id: 'kn-rm1' })
    // rm2: the SAME survivor tag as rm1 → the re-point target dedups to one edge.
    await e.createEdge('TAGGED', { label: 'Knowledge', id: 'kn-rm2' }, { label: 'Tag', id: 'tg-a' })

    const jobsBefore = store.engine.lane.enqueuedCount
    const result = await mergeDuplicates(deps(), { label: 'Knowledge', keepId: 'kn-keep', removeIds: ['kn-rm1', 'kn-rm2'] })
    expect(store.engine.lane.enqueuedCount).toBe(jobsBefore + 1) // ONE audited lane job
    expect(result.removed).toBe(2)
    expect(result.edgesRepointed).toBe(4) // →tg-a (deduped), →tg-x (existed), →sess-1, doc-1→keep
    expect(result.edgesDropped).toBe(0) // no same-label pair exists ⇒ no self-loop possible

    // Duplicates gone, keeper survives.
    expect(await nodeCount('Knowledge', 'kn-rm1')).toBe(0)
    expect(await nodeCount('Knowledge', 'kn-rm2')).toBe(0)
    expect(await nodeCount('Knowledge', 'kn-keep')).toBe(1)

    // Edges moved onto the keeper; the pre-existing tg-x edge is not duplicated.
    expect(await edgeCount('Knowledge', 'kn-keep', 'TAGGED', 'Tag', 'tg-a')).toBe(1)
    expect(await edgeCount('Knowledge', 'kn-keep', 'TAGGED', 'Tag', 'tg-x')).toBe(1)
    expect(await edgeCount('Document', 'doc-1', 'HAS_CHUNK', 'Knowledge', 'kn-keep')).toBe(1)
    // The re-pointed extraction edge preserved its provenance props.
    const props = await e.cypher(
      'MATCH (:Knowledge {id: "kn-keep"})-[r:EXTRACTED_FROM]->(:Session {id: "sess-1"}) RETURN r.extracted_by AS by, r.confidence AS conf'
    )
    expect(props[0]?.['by']).toBe('test-prov@1')
    expect(Number(props[0]?.['conf'])).toBeCloseTo(0.7)

    // ── undo restores nodes, embeddings and the ORIGINAL edges; drops the re-points ──
    await audit.undo(result.auditActionId, 'tester')
    expect(await nodeCount('Knowledge', 'kn-rm1')).toBe(1)
    expect(await nodeCount('Knowledge', 'kn-rm2')).toBe(1)
    expect(await vectorHit('Knowledge', 61, 'kn-rm1')).toBe(true)
    expect(await vectorHit('Knowledge', 62, 'kn-rm2')).toBe(true)
    // Original edges are back.
    expect(await edgeCount('Knowledge', 'kn-rm1', 'TAGGED', 'Tag', 'tg-a')).toBe(1)
    expect(await edgeCount('Knowledge', 'kn-rm1', 'TAGGED', 'Tag', 'tg-x')).toBe(1)
    expect(await edgeCount('Knowledge', 'kn-rm1', 'EXTRACTED_FROM', 'Session', 'sess-1')).toBe(1)
    expect(await edgeCount('Document', 'doc-1', 'HAS_CHUNK', 'Knowledge', 'kn-rm1')).toBe(1)
    expect(await edgeCount('Knowledge', 'kn-rm2', 'TAGGED', 'Tag', 'tg-a')).toBe(1)
    // The NEWLY created re-points are gone; the pre-existing keeper edge stays.
    expect(await edgeCount('Knowledge', 'kn-keep', 'TAGGED', 'Tag', 'tg-a')).toBe(0)
    expect(await edgeCount('Knowledge', 'kn-keep', 'EXTRACTED_FROM', 'Session', 'sess-1')).toBe(0)
    expect(await edgeCount('Document', 'doc-1', 'HAS_CHUNK', 'Knowledge', 'kn-keep')).toBe(0)
    expect(await edgeCount('Knowledge', 'kn-keep', 'TAGGED', 'Tag', 'tg-x')).toBe(1)
  })

  it('merges Tags too (re-points the tag endpoint onto the keeper)', async () => {
    const e = store.engine
    await e.upsertNode('Project', { id: 'proj-t', name: 'shop', embedding: basisEmbedding(EMBEDDING_DIM, 70) })
    await e.upsertNode('Tag', { id: 'tg-keep', name: 'keep', is_global: false })
    await e.upsertNode('Tag', { id: 'tg-dup', name: 'dup', is_global: false })
    await e.createEdge('TAGGED', { label: 'Project', id: 'proj-t' }, { label: 'Tag', id: 'tg-dup' })

    const result = await mergeDuplicates(deps(), { label: 'Tag', keepId: 'tg-keep', removeIds: ['tg-dup'] })
    expect(result).toMatchObject({ removed: 1, edgesRepointed: 1, edgesDropped: 0 })
    expect(await nodeCount('Tag', 'tg-dup')).toBe(0)
    expect(await edgeCount('Project', 'proj-t', 'TAGGED', 'Tag', 'tg-keep')).toBe(1)
  })

  it('refuses unsupported labels and bad requests pre-lane (nothing written)', async () => {
    const jobsBefore = store.engine.lane.enqueuedCount
    const expectErr = (p: Promise<unknown>, code: 'INVALID_INPUT' | 'NOT_FOUND', re: RegExp): Promise<void> =>
      expect(p).rejects.toSatisfy((err: unknown) => err instanceof MemoryEditError && err.code === code && re.test(err.message))

    await expectErr(mergeDuplicates(deps(), { label: 'Skill', keepId: 'a', removeIds: ['b'] }), 'INVALID_INPUT', /not supported.*Skill/)
    await expectErr(mergeDuplicates(deps(), { label: 'Project', keepId: 'a', removeIds: ['b'] }), 'INVALID_INPUT', /not supported/)
    await expectErr(mergeDuplicates(deps(), { label: 'Tag', keepId: 'x', removeIds: [] }), 'INVALID_INPUT', /at least one/)
    await expectErr(mergeDuplicates(deps(), { label: 'Tag', keepId: 'a', removeIds: ['a'] }), 'INVALID_INPUT', /cannot also be/)
    await expectErr(mergeDuplicates(deps(), { label: 'Tag', keepId: 'nope', removeIds: ['also-nope'] }), 'NOT_FOUND', /nope does not exist/)
    // No audited job ran for any of the refusals.
    expect(store.engine.lane.enqueuedCount).toBe(jobsBefore)
  })

  it('DEDUPE_MERGE_LABELS is exactly Preference, Knowledge, Tag', () => {
    expect([...DEDUPE_MERGE_LABELS]).toEqual(['Preference', 'Knowledge', 'Tag'])
  })
})

// ── MCP tools + staging + runner allowlist ──────────────────────────────────────

describe('dedupe MCP tools + staged propose/approve/reject', () => {
  const mcpTool = (name: string): (typeof MCP_TOOLS)[number] => {
    const def = MCP_TOOLS.find((t) => t.name === name)
    if (def === undefined) throw new Error(`tool ${name} not found`)
    return def
  }
  const stagedDeps = (): StagedWritesDeps => ({ db: appData.db, engine: store.engine, audit })
  const engineCtx = (): ToolContext => ({ engine: store.engine }) as unknown as ToolContext
  const mcpCtx = (): ToolContext => ({ engine: store.engine, db: appData.db, sessionId: 'mcp-dedupe' }) as unknown as ToolContext

  beforeAll(async () => {
    const e = store.engine
    // An exact Tag dup group where tg-fmt-1 is the keeper (most edges: 2 vs 1).
    await e.upsertNode('Project', { id: 'proj-m', name: 'app', embedding: basisEmbedding(EMBEDDING_DIM, 80) })
    await e.upsertNode('Tag', { id: 'tg-fmt-1', name: 'formatting', is_global: false })
    await e.upsertNode('Tag', { id: 'tg-fmt-2', name: 'Formatting', is_global: false })
    await e.createEdge('TAGGED', { label: 'Project', id: 'proj-m' }, { label: 'Tag', id: 'tg-fmt-1' })
    await e.upsertNode('Knowledge', { id: 'kn-fmt-b', content: 'eslint config notes', embedding: basisEmbedding(EMBEDDING_DIM, 82) })
    await e.createEdge('TAGGED', { label: 'Knowledge', id: 'kn-fmt-b' }, { label: 'Tag', id: 'tg-fmt-1' })
    // tg-fmt-2 carries one edge that must re-point onto the keeper on approval.
    await e.upsertNode('Knowledge', { id: 'kn-fmt', content: 'prettier config notes', embedding: basisEmbedding(EMBEDDING_DIM, 81) })
    await e.createEdge('TAGGED', { label: 'Knowledge', id: 'kn-fmt' }, { label: 'Tag', id: 'tg-fmt-2' })
    // A second, independent Tag dup group for the reject case.
    await e.upsertNode('Tag', { id: 'tg-lint-1', name: 'linting', is_global: false })
    await e.upsertNode('Tag', { id: 'tg-lint-2', name: 'linting', is_global: false })
  })

  it('list_duplicate_memories reports groups + a suggested keeper (via the tool def)', async () => {
    const reply = (await mcpTool('list_duplicate_memories').handle({}, engineCtx())) as {
      groups: DuplicateGroup[]
      groupsTotal: number
      truncated: boolean
    }
    expect(reply.truncated).toBe(false)
    expect(reply.groupsTotal).toBe(reply.groups.length)
    const tagGroup = groupWith(reply.groups, 'Tag', 'exact', 'tg-fmt-1', 'tg-fmt-2')
    expect(tagGroup).toBeDefined()
    expect(tagGroup!.suggestedKeepId).toBe('tg-fmt-1') // the edged one wins

    // labels filter narrows to Tag only.
    const tagsOnly = (await mcpTool('list_duplicate_memories').handle({ labels: ['Tag'] }, engineCtx())) as {
      groups: DuplicateGroup[]
    }
    expect(tagsOnly.groups.every((g) => g.label === 'Tag')).toBe(true)
  })

  it('propose_dedupe_merge STAGES a dedupe-merge row (never merges); approve runs the merge', async () => {
    const reply = (await mcpTool('propose_dedupe_merge').handle(
      { label: 'Tag', keep_id: 'tg-fmt-1', remove_ids: ['tg-fmt-2'], rationale: 'same tag, different case' },
      mcpCtx()
    )) as { staged: boolean; stagedWriteId: string; status: string }
    expect(reply.staged).toBe(true)
    expect(reply.status).toBe('staged')

    const row = listStagedWrites(appData.db).find((r) => r.id === reply.stagedWriteId)!
    expect(row.kind).toBe(DEDUPE_MERGE_STAGED_KIND)
    expect(row.proposedBy).toBe('claude-mcp:mcp-dedupe')
    expect(row.status).toBe('staged')
    // Nothing merged yet — both tags still live.
    expect(await nodeCount('Tag', 'tg-fmt-2')).toBe(1)

    // The review diff renders plain sentences with both displays.
    const diff = await renderStagedWriteDiff({ db: appData.db, engine: store.engine }, reply.stagedWriteId)
    expect(diff).toMatch(/Keep 'formatting'/)
    expect(diff).toMatch(/Remove 1 duplicate/)
    expect(diff).toMatch(/Formatting/) // the removed node's display

    // Approve → the SAME audited merge runs (no embedder needed).
    const approved = await approveStagedWrite(stagedDeps(), reply.stagedWriteId, { decidedBy: 'user:dashboard' })
    expect(listStagedWrites(appData.db).find((r) => r.id === reply.stagedWriteId)!.status).toBe('committed')
    expect(await nodeCount('Tag', 'tg-fmt-2')).toBe(0)
    expect(await nodeCount('Tag', 'tg-fmt-1')).toBe(1)
    // tg-fmt-2's edge re-pointed onto the keeper.
    expect(await edgeCount('Knowledge', 'kn-fmt', 'TAGGED', 'Tag', 'tg-fmt-1')).toBe(1)
    expect(audit.getAction(approved.auditActionId)!.reversible).toBe(true)
  })

  it('propose_dedupe_merge then reject leaves no residue beyond the log', async () => {
    const reply = (await mcpTool('propose_dedupe_merge').handle(
      { label: 'Tag', keep_id: 'tg-lint-1', remove_ids: ['tg-lint-2'] },
      mcpCtx()
    )) as { stagedWriteId: string }
    rejectStagedWrite(appData.db, reply.stagedWriteId, { decidedBy: 'user:dashboard', reason: 'not duplicates' })
    expect(listStagedWrites(appData.db).find((r) => r.id === reply.stagedWriteId)!.status).toBe('rejected')
    // Both tags untouched (a reject never writes to the graph).
    expect(await nodeCount('Tag', 'tg-lint-1')).toBe(1)
    expect(await nodeCount('Tag', 'tg-lint-2')).toBe(1)
  })

  it('propose_dedupe_merge validates like the merge would (ToolError codes)', async () => {
    const expectTool = (p: Promise<unknown>, code: string): Promise<void> =>
      expect(p).rejects.toSatisfy((err: unknown) => err instanceof ToolError && err.code === code)
    await expectTool(mcpTool('propose_dedupe_merge').handle({ label: 'Tag', keep_id: 'x', remove_ids: ['x'] }, mcpCtx()), 'INVALID_INPUT')
    await expectTool(mcpTool('propose_dedupe_merge').handle({ label: 'Tag', keep_id: 'nope', remove_ids: ['gone'] }, mcpCtx()), 'NOT_FOUND')
    // Skill/Project are rejected by the enum before reaching the service.
    await expectTool(mcpTool('propose_dedupe_merge').handle({ label: 'Skill', keep_id: 'a', remove_ids: ['b'] }, mcpCtx()), 'INVALID_INPUT')
  })

  it('the runner allowlist never gains the dashboard-only dedupe tools (pinned)', () => {
    // Registered + dispatchable, but scoped to the dashboard tier.
    expect(MCP_TOOLS.some((t) => t.name === 'list_duplicate_memories')).toBe(true)
    expect(MCP_TOOLS.some((t) => t.name === 'propose_dedupe_merge')).toBe(true)
    expect(DASHBOARD_TOOLS.has('list_duplicate_memories')).toBe(true)
    expect(DASHBOARD_TOOLS.has('propose_dedupe_merge')).toBe(true)
    // Deliberately NOT in the read/staging tiers the runner surface derives from.
    expect(READ_TOOLS.has('list_duplicate_memories')).toBe(false)
    expect(STAGING_TOOLS.has('propose_dedupe_merge')).toBe(false)
    // The runner allowlist is unchanged: exactly READ ∪ STAGING, neither dedupe tool.
    expect(RUNNER_SESSION_ALLOWLIST.has('list_duplicate_memories')).toBe(false)
    expect(RUNNER_SESSION_ALLOWLIST.has('propose_dedupe_merge')).toBe(false)
    expect([...RUNNER_SESSION_ALLOWLIST].sort()).toEqual([...new Set([...READ_TOOLS, ...STAGING_TOOLS])].sort())
  })
})
