/**
 * Audit + undo integration tests (§13, phase 09) over the REAL engine — the
 * DoD round-trip: a scripted graph write and a file write are fully reverted
 * by undo(actionId). Also pinned: inverse capture per structured op, raw
 * mutating cypher ⇒ un-undoable flag, pre-image backups in backups/audit/,
 * already-undone / irreversible error paths, and the AuditHook trail.
 *
 * One store per test file (ryugraph 25.9.1 teardown discipline, phase 08).
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { EMBEDDING_DIM } from '../../src/main/config'
import { AuditLog, UndoError } from '../../src/main/security'
import { openAppData, type AppData } from '../../src/main/storage'
import { basisEmbedding, openTestStore, type TestStore } from './helpers'

let store: TestStore
let appData: AppData
let audit: AuditLog
let scratchDir: string

beforeAll(async () => {
  store = await openTestStore()
  appData = openAppData(join(store.baseDir, 'appdata.db'))
  scratchDir = mkdtempSync(join(tmpdir(), 'agentic-os-audit-files-'))
  audit = new AuditLog({ db: appData.db, backupsDir: store.backupsDir, engine: store.engine })

  // Pre-existing state the audited writes touch.
  await store.engine.upsertNode('Project', {
    id: 'proj-audit',
    name: 'audit-target',
    summary: 'the original summary',
    embedding: basisEmbedding(EMBEDDING_DIM, 1)
  })
  await store.engine.upsertNode('Skill', {
    id: 'skill-audit',
    name: 'audited-skill',
    instructions: 'v1',
    embedding: basisEmbedding(EMBEDDING_DIM, 2)
  })
  await store.engine.createEdge(
    'USES',
    { label: 'Project', id: 'proj-audit' },
    { label: 'Skill', id: 'skill-audit' }
  )
})

afterAll(async () => {
  appData.close()
  await store.cleanup()
  rmSync(scratchDir, { recursive: true, force: true })
})

const nodeCount = async (label: string, id: string): Promise<number> => {
  const rows = await store.engine.cypher(`MATCH (n:${label} {id: $id}) RETURN count(n) AS c`, { id })
  return Number(rows[0]?.['c'] ?? 0)
}

describe('DoD: scripted graph write fully reverted', () => {
  it('creates + updates + edges in one audited lane job, then undo restores everything', async () => {
    const jobsBefore = store.engine.lane.enqueuedCount
    const { actionId, reversible } = await audit.graphWrite('scripted-agent', 'DoD graph write', async (tx) => {
      // create a node
      await tx.upsertNode('Tag', { id: 'tag-audit', name: 'audit-tag', is_global: false })
      // update an existing node's property (pre-image must be captured)
      await tx.upsertNode('Project', { id: 'proj-audit', summary: 'REWRITTEN by the scripted agent' })
      // create an edge
      await tx.createEdge('TAGGED', { label: 'Project', id: 'proj-audit' }, { label: 'Tag', id: 'tag-audit' })
      // re-MERGE an existing edge (must NOT be deleted by undo)
      await tx.createEdge('USES', { label: 'Project', id: 'proj-audit' }, { label: 'Skill', id: 'skill-audit' })
    })
    expect(store.engine.lane.enqueuedCount).toBe(jobsBefore + 1) // ONE lane job (§21 rule 1)
    expect(reversible).toBe(true)

    // The write really landed.
    expect(await nodeCount('Tag', 'tag-audit')).toBe(1)
    const rewritten = await store.engine.cypher('MATCH (p:Project {id: $id}) RETURN p.summary AS s', {
      id: 'proj-audit'
    })
    expect(rewritten[0]!['s']).toBe('REWRITTEN by the scripted agent')

    const row = audit.getAction(actionId)!
    expect(row.kind).toBe('graph-write')
    expect(row.reversible).toBe(true)
    expect(row.outcome).toBe('ok')
    expect(row.agentId).toBe('scripted-agent')

    // ── undo: ONE lane job, everything restored ──────────────────────────────
    const jobsBeforeUndo = store.engine.lane.enqueuedCount
    await audit.undo(actionId, 'tester')
    expect(store.engine.lane.enqueuedCount).toBe(jobsBeforeUndo + 1)

    expect(await nodeCount('Tag', 'tag-audit')).toBe(0) // created node gone
    const restored = await store.engine.cypher('MATCH (p:Project {id: $id}) RETURN p.summary AS s', {
      id: 'proj-audit'
    })
    expect(restored[0]!['s']).toBe('the original summary') // pre-image restored
    const tagged = await store.engine.cypher(
      `MATCH (:Project {id: 'proj-audit'})-[r:TAGGED]->(:Tag) RETURN count(r) AS c`
    )
    expect(Number(tagged[0]!['c'])).toBe(0) // created edge gone
    const uses = await store.engine.cypher(
      `MATCH (:Project {id: 'proj-audit'})-[r:USES]->(:Skill {id: 'skill-audit'}) RETURN count(r) AS c`
    )
    expect(Number(uses[0]!['c'])).toBe(1) // pre-existing edge SURVIVES the undo

    const undone = audit.getAction(actionId)!
    expect(undone.undoneAt).not.toBeNull()
    expect(undone.undoActionId).not.toBeNull()
    const undoRow = audit.getAction(undone.undoActionId!)!
    expect(undoRow.kind).toBe('undo')
    expect(undoRow.reversible).toBe(false) // no redo in v1

    await expect(audit.undo(actionId)).rejects.toThrow(UndoError)
    await expect(audit.undo(actionId)).rejects.toMatchObject({ code: 'ALREADY_UNDONE' })
  })

  it('flags actions containing raw mutating cypher as un-undoable', async () => {
    await store.engine.upsertNode('Tag', { id: 'tag-raw', name: 'raw-tag', is_global: false })
    const { actionId, reversible } = await audit.graphWrite('scripted-agent', 'raw mutation', async (tx) => {
      await tx.cypher(`MATCH (t:Tag {id: 'tag-raw'}) DETACH DELETE t`)
    })
    expect(reversible).toBe(false)
    await expect(audit.undo(actionId)).rejects.toMatchObject({ code: 'IRREVERSIBLE' })
    // reads inside an audited job do NOT poison reversibility
    const readOnly = await audit.graphWrite('scripted-agent', 'read-only job', async (tx) => {
      await tx.cypher(`MATCH (p:Project) RETURN count(p) AS c`)
      await tx.upsertNode('Tag', { id: 'tag-clean', name: 'clean', is_global: false })
    })
    expect(readOnly.reversible).toBe(true)
    await audit.undo(readOnly.actionId)
    expect(await nodeCount('Tag', 'tag-clean')).toBe(0)
  })

  it('a failing audited job records outcome=error with the inverses captured so far', async () => {
    await expect(
      audit.graphWrite('scripted-agent', 'fails mid-way', async (tx) => {
        await tx.upsertNode('Tag', { id: 'tag-partial', name: 'partial', is_global: false })
        throw new Error('boom after the first op')
      })
    ).rejects.toThrow('boom after the first op')
    const row = audit.listActions({ kind: 'graph-write' }).find((r) => r.description === 'fails mid-way')!
    expect(row.outcome).toBe('error')
    expect(row.error).toContain('boom')
    // Lane jobs are exclusive, not transactional (§5): the committed prefix is
    // real — and the recorded inverse can clean it up.
    expect(await nodeCount('Tag', 'tag-partial')).toBe(1)
    await audit.undo(row.id)
    expect(await nodeCount('Tag', 'tag-partial')).toBe(0)
  })
})

describe('DoD: file write fully reverted (pre-images in backups/)', () => {
  it('undo of an overwrite restores the original bytes from backups/audit/<id>/', async () => {
    const target = join(scratchDir, 'config.json')
    writeFileSync(target, '{"version": 1}')

    const { actionId } = audit.fileWrite('scripted-agent', target, '{"version": 2, "hacked": true}')
    expect(readFileSync(target, 'utf8')).toBe('{"version": 2, "hacked": true}')
    const row = audit.getAction(actionId)!
    expect(row.kind).toBe('file-write')
    expect(row.reversible).toBe(true)
    const backupDir = join(store.backupsDir, 'audit', actionId)
    expect(readFileSync(join(backupDir, 'pre-image'), 'utf8')).toBe('{"version": 1}')

    await audit.undo(actionId)
    expect(readFileSync(target, 'utf8')).toBe('{"version": 1}')
  })

  it('undo of a fresh file creation removes the file', async () => {
    const target = join(scratchDir, 'new-dir', 'fresh.txt')
    const { actionId } = audit.fileWrite('scripted-agent', target, 'created by agent')
    expect(readFileSync(target, 'utf8')).toBe('created by agent')
    await audit.undo(actionId)
    expect(existsSync(target)).toBe(false)
  })

  it('undo of a file delete restores the file', async () => {
    const target = join(scratchDir, 'doomed.txt')
    writeFileSync(target, 'precious contents')
    const { actionId } = audit.fileDelete('scripted-agent', target)
    expect(existsSync(target)).toBe(false)
    await audit.undo(actionId)
    expect(readFileSync(target, 'utf8')).toBe('precious contents')
  })
})

describe('AuditHook trail + error paths', () => {
  it('kernel events land as durable, un-undoable action rows', async () => {
    audit.record({
      at: new Date().toISOString(),
      agentId: 'agent-x',
      action: { kind: 'mcp-call', name: 'get_context' },
      decision: { allowed: true, reason: 'read tier' },
      outcome: 'ok',
      durationMs: 12.4
    })
    const rows = audit.listActions({ kind: 'action', agentId: 'agent-x' })
    expect(rows).toHaveLength(1)
    expect(rows[0]!.reversible).toBe(false)
    expect(rows[0]!.details['actionName']).toBe('get_context')
    await expect(audit.undo(rows[0]!.id)).rejects.toMatchObject({ code: 'IRREVERSIBLE' })
  })

  it('undo of an unknown action id is NOT_FOUND', async () => {
    await expect(audit.undo('no-such-action')).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })
})
