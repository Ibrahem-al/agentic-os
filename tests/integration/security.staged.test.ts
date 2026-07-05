/**
 * Staged-writes lifecycle integration tests (§13, phase 09) over the REAL
 * engine — the DoD: an approved staged write is reflected in the graph
 * (committed via the lane, audited, undoable); a rejected one leaves no trace
 * beyond the log. Both proposer payload shapes are covered: Claude's
 * propose_correction patches and the extraction agent's self-contained items.
 *
 * One store per test file (ryugraph 25.9.1 teardown discipline, phase 08).
 */
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { EMBEDDING_DIM } from '../../src/main/config'
import {
  approveStagedWrite,
  AuditLog,
  getStagedWrite,
  listStagedWrites,
  rejectStagedWrite,
  renderStagedWriteDiff,
  StagedWriteError,
  type StagedWritesDeps
} from '../../src/main/security'
import { openAppData, type AppData } from '../../src/main/storage'
import { basisEmbedding, openTestStore, type TestStore } from './helpers'

let store: TestStore
let appData: AppData
let audit: AuditLog
let deps: StagedWritesDeps

/** Deterministic single-axis fake embedder (real interface). */
const fakeEmbedder = {
  calls: 0,
  async embed(texts: string[]): Promise<number[][]> {
    fakeEmbedder.calls += texts.length
    return texts.map(() => basisEmbedding(EMBEDDING_DIM, 7))
  }
}

beforeAll(async () => {
  store = await openTestStore()
  appData = openAppData(join(store.baseDir, 'appdata.db'))
  audit = new AuditLog({ db: appData.db, backupsDir: store.backupsDir, engine: store.engine })
  deps = { db: appData.db, engine: store.engine, audit, embedder: fakeEmbedder }

  // The nodes the staged writes target.
  await store.engine.upsertNode('Preference', {
    id: 'pref-1',
    statement: 'Use npm for package installs.',
    embedding: basisEmbedding(EMBEDDING_DIM, 3)
  })
  await store.engine.upsertNode('Session', { id: 'session-s9', tier: 'daily' })
  await store.engine.upsertNode('Tag', { id: 'tag-existing', name: 'existing-tag', is_global: false })
})

afterAll(async () => {
  appData.close()
  await store.cleanup()
})

/** Insert a staged row exactly as mcp/tools.ts proposeCorrection writes it. */
function stageCorrection(patch: Record<string, unknown>, reason: string, targetId = 'pref-1'): string {
  const id = randomUUID()
  appData.db
    .prepare(
      `INSERT INTO staged_writes (id, proposed_by, kind, target_label, target_id, payload_json)
       VALUES (?, ?, 'propose_correction', 'Preference', ?, ?)`
    )
    .run(id, 'claude-mcp:test-session', targetId, JSON.stringify({ patch, reason }))
  return id
}

/** Insert a staged row exactly as the extraction write step stages items. */
function stageExtraction(payload: Record<string, unknown>, targetLabel: string, targetId: string): string {
  const id = `sw-${randomUUID().slice(0, 16)}`
  appData.db
    .prepare(
      `INSERT OR IGNORE INTO staged_writes (id, proposed_by, kind, target_label, target_id, payload_json)
       VALUES (?, 'extraction-agent:session-s9', 'extraction', ?, ?, ?)`
    )
    .run(id, targetLabel, targetId, JSON.stringify(payload))
  return id
}

const prefStatement = async (id: string): Promise<unknown> => {
  const rows = await store.engine.cypher('MATCH (p:Preference {id: $id}) RETURN p.statement AS s', { id })
  return rows[0]?.['s']
}

describe('propose_correction flow (Claude, §21 rule 6)', () => {
  it('renders a human-readable current → proposed diff', async () => {
    const id = stageCorrection({ statement: 'Use pnpm for package installs.' }, 'the team switched to pnpm')
    const diff = await renderStagedWriteDiff(deps, id)
    expect(diff).toContain('PATCH Preference pref-1')
    expect(diff).toContain("~ statement: 'Use npm for package installs.' → 'Use pnpm for package installs.'")
    expect(diff).toContain('reason: the team switched to pnpm')
    expect(diff).toContain('claude-mcp:test-session')
  })

  it('DoD: approve → the graph reflects the patch, committed via ONE audited lane job — and undo reverts it', async () => {
    const id = stageCorrection({ statement: 'Use pnpm for package installs.' }, 'the team switched to pnpm')
    const jobsBefore = store.engine.lane.enqueuedCount
    const result = await approveStagedWrite(deps, id, { decidedBy: 'tester' })

    expect(store.engine.lane.enqueuedCount).toBe(jobsBefore + 1)
    expect(await prefStatement('pref-1')).toBe('Use pnpm for package installs.')
    const row = getStagedWrite(appData.db, id)!
    expect(row.status).toBe('committed')
    expect(row.decidedAt).not.toBeNull()
    expect(row.committedAt).not.toBeNull()
    expect(row.validation).toMatchObject({ decidedBy: 'tester', auditActionId: result.auditActionId })

    // The commit is an audited agent action with a reversible delta (§13).
    const auditRow = audit.getAction(result.auditActionId)!
    expect(auditRow.kind).toBe('graph-write')
    expect(auditRow.agentId).toBe('claude-mcp:test-session')
    expect(auditRow.reversible).toBe(true)
    await audit.undo(result.auditActionId)
    expect(await prefStatement('pref-1')).toBe('Use npm for package installs.')
  })

  it('DoD: reject → no trace beyond the log (graph untouched, zero lane jobs)', async () => {
    const id = stageCorrection({ statement: 'Use yarn for package installs.' }, 'wrong guess')
    const jobsBefore = store.engine.lane.enqueuedCount
    const before = await prefStatement('pref-1')

    rejectStagedWrite(appData.db, id, { decidedBy: 'tester', reason: 'not true' })

    expect(store.engine.lane.enqueuedCount).toBe(jobsBefore) // ZERO lane jobs
    expect(await prefStatement('pref-1')).toBe(before) // graph untouched
    const row = getStagedWrite(appData.db, id)!
    expect(row.status).toBe('rejected')
    expect(row.committedAt).toBeNull()
    expect(row.validation).toMatchObject({ decidedBy: 'tester', reason: 'not true' })
    // no audit graph-write happened for it
    expect(audit.listActions({ kind: 'graph-write' }).some((a) => a.description.includes(id))).toBe(false)
    // decided rows cannot be re-decided
    expect(() => rejectStagedWrite(appData.db, id, { decidedBy: 'tester' })).toThrow(StagedWriteError)
    await expect(approveStagedWrite(deps, id, { decidedBy: 'tester' })).rejects.toMatchObject({
      code: 'INVALID_STATE'
    })
  })

  it('refuses protected-key patches at commit time (defense in depth)', async () => {
    const id = stageCorrection({ extracted_by: 'me', statement: 'x' }, 'sneaky')
    await expect(approveStagedWrite(deps, id, { decidedBy: 'tester' })).rejects.toMatchObject({
      code: 'INVALID_PAYLOAD'
    })
    expect(getStagedWrite(appData.db, id)!.status).toBe('approved') // decision recorded, commit refused
  })

  it('a vanished target fails the commit and records the error for retry', async () => {
    const id = stageCorrection({ statement: 'x' }, 'orphan', 'pref-gone')
    await expect(approveStagedWrite(deps, id, { decidedBy: 'tester' })).rejects.toMatchObject({
      code: 'COMMIT_FAILED'
    })
    const row = getStagedWrite(appData.db, id)!
    expect(row.status).toBe('approved')
    expect(String(row.validation?.['commitError'])).toContain('no longer exists')
  })
})

describe('extraction payload flow (§17 low-confidence items)', () => {
  const createPayload = {
    op: 'create',
    node: {
      label: 'Preference',
      id: 'pref-staged-new',
      props: {
        statement: 'Always load secrets from the environment.',
        extracted_by: 'extraction@0.0.1/llm-local',
        confidence: 0.4
      }
    },
    embedOnCommit: true,
    edges: [
      {
        type: 'EXTRACTED_FROM',
        from: { label: 'Preference', id: 'pref-staged-new' },
        to: { label: 'Session', id: 'session-s9' },
        props: { extracted_by: 'extraction@0.0.1/llm-local', confidence: 0.4 }
      },
      {
        type: 'APPLIES_TO',
        from: { label: 'Preference', id: 'pref-staged-new' },
        to: { label: 'Tag', id: 'tag-security' },
        props: { extracted_by: 'extraction@0.0.1/llm-local', confidence: 0.4 }
      }
    ],
    tagCreates: [{ id: 'tag-security', name: 'security' }],
    provenance: { extracted_by: 'extraction@0.0.1/llm-local', confidence: 0.4 },
    evidence: 'User: always load secrets from the environment',
    reason: 'confidence 0.40 below the 0.6 gate',
    session: 'session-s9'
  }

  it('renders the create diff with node, edges, tags and provenance', async () => {
    const id = stageExtraction(createPayload, 'Preference', 'pref-staged-new')
    const diff = await renderStagedWriteDiff(deps, id)
    expect(diff).toContain('+ CREATE Preference pref-staged-new')
    expect(diff).toContain('+ Tag tag-security')
    expect(diff).toContain('[:EXTRACTED_FROM]->(Session session-s9)')
    expect(diff).toContain('provenance: extraction@0.0.1/llm-local confidence 0.4')
    expect(diff).toContain('(embedding computed at commit)')
    rejectStagedWrite(appData.db, id, { decidedBy: 'tester' }) // leave no state behind for the next test
  })

  it('DoD: approve → node created with commit-time embedding + provenance edges; staged-only tag created', async () => {
    const id = stageExtraction(createPayload, 'Preference', 'pref-staged-new')
    const embedsBefore = fakeEmbedder.calls
    const result = await approveStagedWrite(deps, id, { decidedBy: 'tester' })

    expect(fakeEmbedder.calls).toBe(embedsBefore + 1) // embedOnCommit ran
    expect(await prefStatement('pref-staged-new')).toBe('Always load secrets from the environment.')
    // The embedding is REAL: the vector index serves the node back.
    const hits = await store.engine.vectorSearch('Preference', basisEmbedding(EMBEDDING_DIM, 7), 1)
    expect(hits[0]?.id).toBe('pref-staged-new')
    expect(hits[0]!.distance).toBeLessThan(0.001)
    // Edges + provenance stamps (§21 rule 4) landed verbatim.
    const edges = await store.engine.cypher(
      `MATCH (p:Preference {id: 'pref-staged-new'})-[r]->(n)
       RETURN r.extracted_by AS by, r.confidence AS conf, n.id AS target ORDER BY target`
    )
    expect(edges).toHaveLength(2)
    expect(edges.every((e) => e['by'] === 'extraction@0.0.1/llm-local' && Number(e['conf']) === 0.4)).toBe(true)
    const tag = await store.engine.cypher(`MATCH (t:Tag {id: 'tag-security'}) RETURN t.name AS name`)
    expect(tag[0]?.['name']).toBe('security')
    // audited + undoable
    expect(audit.getAction(result.auditActionId)!.reversible).toBe(true)
  })

  it('merge payloads only add evidence edges — existing content is never rewritten', async () => {
    const id = stageExtraction(
      {
        op: 'merge',
        node: null,
        embedOnCommit: false,
        edges: [
          {
            type: 'EXTRACTED_FROM',
            from: { label: 'Preference', id: 'pref-1' },
            to: { label: 'Session', id: 'session-s9' },
            props: { extracted_by: 'extraction@0.0.1/llm-local', confidence: 0.5 }
          }
        ],
        tagCreates: [],
        provenance: { extracted_by: 'extraction@0.0.1/llm-local', confidence: 0.5 },
        evidence: 'User: use npm please',
        reason: 'confidence 0.50 below the 0.6 gate',
        session: 'session-s9'
      },
      'Preference',
      'pref-1'
    )
    const before = await prefStatement('pref-1')
    await approveStagedWrite(deps, id, { decidedBy: 'tester' })
    expect(await prefStatement('pref-1')).toBe(before) // statement untouched
    const evidence = await store.engine.cypher(
      `MATCH (:Preference {id: 'pref-1'})-[r:EXTRACTED_FROM]->(:Session {id: 'session-s9'}) RETURN count(r) AS c`
    )
    expect(Number(evidence[0]!['c'])).toBe(1)
  })

  it('DoD: rejected extraction item leaves the graph provably untouched', async () => {
    const id = stageExtraction(
      { ...createPayload, node: { ...createPayload.node, id: 'pref-rejected' } },
      'Preference',
      'pref-rejected'
    )
    const jobsBefore = store.engine.lane.enqueuedCount
    rejectStagedWrite(appData.db, id, { decidedBy: 'tester' })
    expect(store.engine.lane.enqueuedCount).toBe(jobsBefore)
    const rows = await store.engine.cypher(`MATCH (p:Preference {id: 'pref-rejected'}) RETURN count(p) AS c`)
    expect(Number(rows[0]!['c'])).toBe(0)
    expect(getStagedWrite(appData.db, id)!.status).toBe('rejected')
  })

  it('malformed payloads are refused, never partially committed', async () => {
    const bad = stageExtraction(
      { ...createPayload, node: { label: 'NotALabel', id: 'x', props: {} } },
      'Preference',
      'x'
    )
    await expect(approveStagedWrite(deps, bad, { decidedBy: 'tester' })).rejects.toMatchObject({
      code: 'INVALID_PAYLOAD'
    })
    const missingEmbedder = stageExtraction(
      { ...createPayload, node: { ...createPayload.node, id: 'pref-no-embedder' } },
      'Preference',
      'pref-no-embedder'
    )
    await expect(
      approveStagedWrite({ db: deps.db, engine: deps.engine, audit: deps.audit }, missingEmbedder, {
        decidedBy: 'tester'
      })
    ).rejects.toMatchObject({ code: 'COMMIT_FAILED' })
    const rows = await store.engine.cypher(`MATCH (p:Preference {id: 'pref-no-embedder'}) RETURN count(p) AS c`)
    expect(Number(rows[0]!['c'])).toBe(0)
  })

  it('listStagedWrites filters by status', () => {
    const all = listStagedWrites(appData.db)
    expect(all.length).toBeGreaterThan(0)
    const staged = listStagedWrites(appData.db, { status: 'staged' })
    expect(staged.every((r) => r.status === 'staged')).toBe(true)
    const committed = listStagedWrites(appData.db, { status: 'committed' })
    expect(committed.length).toBeGreaterThan(0)
  })
})
