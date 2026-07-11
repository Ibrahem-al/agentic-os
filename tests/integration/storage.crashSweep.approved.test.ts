/**
 * Crash-safety Stage B: the staged-approved boot sweep (§21.9) over the REAL
 * engine.
 *
 * A `staged_writes` row stuck at status 'approved' means the app died between the
 * audited commit and the status flip (or between the flip's halves).
 * runStagedApprovedSweep re-drives the EMBEDDER-FREE rows (approveStagedWrite is
 * re-drivable — it re-invokes the commit) so they land 'committed', and LEAVES the
 * embedder-needed rows with a warn diagnostic pointing at Approvals (the sweep has
 * no embedder; the user finishes those with one click).
 *
 * One store per test file (ryugraph 25.9.1 teardown discipline, phase 08).
 */
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { EMBEDDING_DIM } from '../../src/main/config'
import { AuditLog, getStagedWrite } from '../../src/main/security'
import { runStagedApprovedSweep } from '../../src/main/crashSweep'
import { openAppData, type AppData } from '../../src/main/storage'
import { basisEmbedding, openTestStore, type TestStore } from './helpers'

let store: TestStore
let appData: AppData
let audit: AuditLog

beforeAll(async () => {
  store = await openTestStore()
  appData = openAppData(join(store.baseDir, 'appdata.db'))
  audit = new AuditLog({ db: appData.db, backupsDir: store.backupsDir, engine: store.engine })

  // The nodes the staged writes target.
  await store.engine.upsertNode('Preference', {
    id: 'pref-approved',
    statement: 'Use npm for package installs.',
    embedding: basisEmbedding(EMBEDDING_DIM, 3)
  })
  await store.engine.upsertNode('Session', { id: 'session-b1', tier: 'daily' })
})

afterAll(async () => {
  appData.close()
  await store.cleanup()
})

/** Insert a staged_writes row already at status 'approved' — the crash state. */
function insertApproved(row: {
  id: string
  kind: string
  targetLabel: string | null
  targetId: string | null
  payload: Record<string, unknown>
  proposedBy?: string
}): void {
  appData.db
    .prepare(
      `INSERT INTO staged_writes (id, proposed_by, kind, target_label, target_id, payload_json, status, decided_at)
       VALUES (?, ?, ?, ?, ?, ?, 'approved', strftime('%Y-%m-%dT%H:%M:%fZ','now'))`
    )
    .run(
      row.id,
      row.proposedBy ?? 'claude-mcp:b1',
      row.kind,
      row.targetLabel,
      row.targetId,
      JSON.stringify(row.payload)
    )
}

const prefStatement = async (id: string): Promise<unknown> => {
  const rows = await store.engine.cypher('MATCH (p:Preference {id: $id}) RETURN p.statement AS s', { id })
  return rows[0]?.['s']
}

describe('staged-approved sweep: embedder-free re-drive', () => {
  it('re-drives an interrupted approved correction to committed (single graph result) and is idempotent', async () => {
    const id = randomUUID()
    insertApproved({
      id,
      kind: 'propose_correction',
      targetLabel: 'Preference',
      targetId: 'pref-approved',
      payload: { patch: { statement: 'Use pnpm for package installs.' }, reason: 'the team switched to pnpm' }
    })
    expect(await prefStatement('pref-approved')).toBe('Use npm for package installs.')

    const result = await runStagedApprovedSweep({ db: appData.db, engine: store.engine, audit })

    expect(result.reCommitted).toBe(1)
    expect(result.reCommitFailed).toBe(0)
    expect(result.embedderDeferred).toBe(0)
    // The commit landed exactly once: the patch is applied and the row is committed.
    expect(await prefStatement('pref-approved')).toBe('Use pnpm for package installs.')
    const row = getStagedWrite(appData.db, id)!
    expect(row.status).toBe('committed')
    expect(row.committedAt).not.toBeNull()
    // Exactly ONE audited graph-write references this staged id (no double-commit).
    const commits = audit.listActions({ kind: 'graph-write' }).filter((a) => a.description.includes(id))
    expect(commits).toHaveLength(1)
    // A warn diagnostic reports the recovery.
    const warn = result.diagnostics.find((d) => d.detail.includes('finished committing'))
    expect(warn?.level).toBe('warn')
    expect(warn?.subsystem).toBe('storage')

    // Idempotent: the row is 'committed' now, so a re-run advances nothing.
    const again = await runStagedApprovedSweep({ db: appData.db, engine: store.engine, audit })
    expect(again.reCommitted).toBe(0)
    expect(again.diagnostics).toHaveLength(0)
  })
})

describe('staged-approved sweep: embedder-needed row left for Approvals', () => {
  it('leaves an approved embedding-on-commit extraction untouched with a warn diagnostic', async () => {
    const id = `sw-${randomUUID().slice(0, 16)}`
    insertApproved({
      id,
      proposedBy: 'extraction-agent:session-b1',
      kind: 'extraction',
      targetLabel: 'Preference',
      targetId: 'pref-embed',
      payload: {
        op: 'create',
        embedOnCommit: true,
        node: { label: 'Preference', id: 'pref-embed', props: { statement: 'A new preference needing a vector.' } },
        edges: [],
        tagCreates: [],
        provenance: { extracted_by: 'extraction-agent@1', confidence: 0.5 },
        evidence: 'e',
        reason: 'r',
        session: 'session-b1'
      }
    })

    const result = await runStagedApprovedSweep({ db: appData.db, engine: store.engine, audit })

    expect(result.embedderDeferred).toBe(1)
    expect(result.reCommitted).toBe(0)
    expect(result.reCommitFailed).toBe(0)
    // The row is UNTOUCHED (still approved) and the node was never created.
    const row = getStagedWrite(appData.db, id)!
    expect(row.status).toBe('approved')
    const nodeRows = await store.engine.cypher('MATCH (p:Preference {id: $id}) RETURN count(p) AS c', { id: 'pref-embed' })
    expect(Number(nodeRows[0]?.['c'] ?? 0)).toBe(0)
    // A warn points the user at Approvals.
    const warn = result.diagnostics.find((d) => d.detail.includes('open Approvals'))
    expect(warn?.level).toBe('warn')
    expect(warn?.subsystem).toBe('storage')
  })
})
