/**
 * Graph-cleanup agent (§8 background task 'graph-cleanup' — user-directed spec
 * extension) over the REAL engine + appdata staging + a FAKE local judge:
 *
 *  - the pure core `runGraphCleanup` stages EXACT duplicate groups directly and
 *    routes NEAR groups past the local LLM judge, EVERY proposal a staged
 *    'dedupe-merge' row (proposed_by 'agent:graph-cleanup') — and the graph
 *    itself is NEVER mutated (§21 rule 6: staging is the only write, so the audited
 *    write lane's enqueuedCount and every per-label node count are unchanged);
 *  - the judge verdict governs a near group: SAME → staged with the AI rationale,
 *    DIFFERENT → not staged, a THROW → counted as a judge error while the run
 *    completes; a hallucinated keep_id falls back to the scan's suggested keeper;
 *  - a re-run over rows already awaiting review skips them (no duplicate rows);
 *  - no injected router → exact staged, near left for a run with a judge (noted);
 *  - the LLM-judgment cap truncates the near sweep and the note says so;
 *  - Skill/Project duplicate groups are report-only (counted, never staged);
 *  - the thin queue wrappers: enqueueGraphCleanup mints a deterministic per-minute
 *    id (a burst dedups) and registerGraphCleanupHandler wires the handler.
 *
 * ONE store per file (ryugraph teardown discipline, phase 08). Nodes are seeded
 * append-only (never deleted — a delete-between-tests cycle destabilizes the
 * binding); isolation instead comes from monotonic `updated_at` + a `scope:'count'`
 * scan over the test's own `labels`, so each run sees only that test's newest
 * nodes. Embeddings are seeded directly (basisEmbedding/blendEmbedding) so a near
 * pair is a deterministic cosine, and each test uses its own embedding axes + text.
 */
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { EMBEDDING_DIM, GRAPH_CLEANUP_JUDGE_MAX_TOKENS, TASK_PRIORITY } from '../../src/main/config'
import {
  enqueueGraphCleanup,
  GRAPH_CLEANUP_PROPOSER,
  GRAPH_CLEANUP_TASK_KIND,
  registerGraphCleanupHandler,
  runGraphCleanup,
  type DedupeJudgeRouter
} from '../../src/main/agents'
import { DEDUPE_MERGE_STAGED_KIND, listStagedWrites, type StagedWriteRow } from '../../src/main/security'
import { DurableTaskQueue } from '../../src/main/triggers'
import { openAppData, type AppData, type NodeLabel } from '../../src/main/storage'
import { basisEmbedding, blendEmbedding, openTestStore, type TestStore } from './helpers'

let store: TestStore
let appData: AppData

beforeAll(async () => {
  store = await openTestStore()
  appData = openAppData(join(store.baseDir, 'appdata.db'))
})

afterAll(async () => {
  appData.close()
  await store.cleanup()
})

// Staging/task rows are the only per-test residue we clear (cheap SQLite deletes);
// graph nodes are left in place (append-only) — a 'count'-scoped scan ignores them.
afterEach(() => {
  appData.db.prepare('DELETE FROM staged_writes').run()
  appData.db.prepare('DELETE FROM tasks').run()
})

// A module-monotonic clock: every seeded node gets a strictly-newer updated_at, so
// (a) a test's nodes are always the newest (scope:'count' selects exactly them) and
// (b) the LAST-seeded node of a group is its suggested keeper (newest wins).
let clockMs = Date.parse('2030-01-01T00:00:00.000Z')
const seed = async (label: NodeLabel, props: Record<string, unknown>): Promise<void> => {
  await store.engine.upsertNode(label, props)
  clockMs += 60_000
  await store.engine.cypher(`MATCH (n:${label} {id: $id}) SET n.updated_at = timestamp($ts)`, {
    id: String(props['id']),
    ts: new Date(clockMs).toISOString()
  })
}

/** An EXACT Preference pair (same normalized text); keepId is seeded LAST ⇒ suggested keeper. */
const seedExactPref = async (rmId: string, keepId: string, text: string, axis: number): Promise<void> => {
  await seed('Preference', { id: rmId, statement: `  ${text.toUpperCase()} `, embedding: basisEmbedding(EMBEDDING_DIM, axis) })
  await seed('Preference', { id: keepId, statement: text, embedding: basisEmbedding(EMBEDDING_DIM, axis + 1) })
}

/** A distinct-text NEAR Preference pair (cosine ≈ 0.985); keepId seeded LAST ⇒ suggested keeper. */
const seedNearPref = async (rmId: string, keepId: string, tag: string, axis: number): Promise<void> => {
  await seed('Preference', { id: rmId, statement: `use turbo for the ${tag} build`, embedding: basisEmbedding(EMBEDDING_DIM, axis) })
  await seed('Preference', { id: keepId, statement: `the ${tag} build should use turborepo`, embedding: blendEmbedding(EMBEDDING_DIM, axis, axis + 1, 0.85) })
}

const nodeCount = async (label: NodeLabel, id: string): Promise<number> => {
  const rows = await store.engine.cypher(`MATCH (n:${label} {id: $id}) RETURN count(n) AS c`, { id })
  return Number(rows[0]?.['c'] ?? 0)
}

const dedupeRows = (): StagedWriteRow[] => listStagedWrites(appData.db).filter((r) => r.kind === DEDUPE_MERGE_STAGED_KIND)

/** A fake local judge (a plain `{ complete }` — the ProviderRouter contract's Pick). */
interface FakeJudge {
  readonly router: DedupeJudgeRouter
  readonly calls: { prompt: string; maxTokens: number | undefined; taskId: string }[]
}
const fakeJudge = (verdict: (prompt: string) => { same: boolean; keep_id?: string; reason?: string }): FakeJudge => {
  const calls: FakeJudge['calls'] = []
  return {
    calls,
    router: {
      complete: async (_role, req) => {
        calls.push({ prompt: req.prompt, maxTokens: req.maxTokens, taskId: req.taskId })
        return { text: JSON.stringify(verdict(req.prompt)) }
      }
    }
  }
}
const throwingJudge = (): FakeJudge => {
  const calls: FakeJudge['calls'] = []
  return {
    calls,
    router: {
      complete: async (_role, req) => {
        calls.push({ prompt: req.prompt, maxTokens: req.maxTokens, taskId: req.taskId })
        throw new Error('judge transport boom')
      }
    }
  }
}

// ── EXACT + NEAR staging; the graph is provably untouched ────────────────────────

describe('runGraphCleanup — stages exact + AI-confirmed near proposals, never touches the graph', () => {
  it('stages one exact + one AI-confirmed near dedupe-merge row (proposer agent:graph-cleanup)', async () => {
    await seedExactPref('ex-rm', 'ex-keep', 'prefers pnpm for installs', 10)
    await seedNearPref('nr-rm', 'nr-keep', 'alpha', 40)

    const judge = fakeJudge(() => ({ same: true, keep_id: 'nr-keep', reason: 'both say use turborepo' }))
    const laneBefore = store.engine.lane.enqueuedCount

    const result = await runGraphCleanup(
      { engine: store.engine, db: appData.db, router: judge.router },
      { scope: 'count', count: 4, labels: ['Preference'] }
    )

    expect(result.stagedExact).toBe(1)
    expect(result.stagedAiConfirmed).toBe(1)
    expect(result.aiRejected).toBe(0)
    expect(result.reportOnly).toBe(0)
    expect(result.judgeErrors).toBe(0)
    expect(result.judgeUnavailable).toBe(false)
    expect(result.judgmentsTruncated).toBe(false)
    expect(result.vanished).toBe(0)
    expect(result.skippedAlreadyStaged).toBe(0)
    expect(result.note).toContain('staged 2 proposals (1 exact + 1 AI-confirmed)')

    // The judge saw the FULL member texts and the config max-tokens cap.
    expect(judge.calls).toHaveLength(1)
    expect(judge.calls[0]!.maxTokens).toBe(GRAPH_CLEANUP_JUDGE_MAX_TOKENS)
    expect(judge.calls[0]!.prompt).toContain('use turbo for the alpha build')
    expect(judge.calls[0]!.prompt).toContain('the alpha build should use turborepo')

    const rows = dedupeRows()
    expect(rows).toHaveLength(2)
    for (const row of rows) {
      expect(row.proposedBy).toBe(GRAPH_CLEANUP_PROPOSER)
      expect(row.payload['label']).toBe('Preference')
    }
    const exact = rows.find((r) => r.payload['keepId'] === 'ex-keep')!
    expect(exact.payload['removeIds']).toEqual(['ex-rm'])
    expect(exact.payload['rationale']).toBe('identical wording (exact duplicate)')
    expect(exact.payload['displays']).toEqual([{ id: 'ex-rm', display: expect.any(String) }])

    const near = rows.find((r) => r.payload['keepId'] === 'nr-keep')!
    expect(near.payload['removeIds']).toEqual(['nr-rm'])
    const rationale = String(near.payload['rationale'])
    expect(rationale.startsWith('AI cleanup: both say use turborepo')).toBe(true)
    expect(rationale).toMatch(/~\d+% similar/)

    // §21 rule 6: the graph never changed — no write-lane job, both members of each
    // group still present (per-label node counts identical before/after).
    expect(store.engine.lane.enqueuedCount).toBe(laneBefore)
    for (const id of ['ex-keep', 'ex-rm', 'nr-keep', 'nr-rm']) {
      expect(await nodeCount('Preference', id)).toBe(1)
    }
  })
})

// ── the judge verdict governs a near group ───────────────────────────────────────

describe('runGraphCleanup — the local judge decides each near group', () => {
  it('judged DIFFERENT → not staged (aiRejected), no dedupe row', async () => {
    await seedNearPref('df-rm', 'df-keep', 'beta', 42)
    const judge = fakeJudge(() => ({ same: false, reason: 'distinct tools' }))

    const result = await runGraphCleanup(
      { engine: store.engine, db: appData.db, router: judge.router },
      { scope: 'count', count: 2, labels: ['Preference'] }
    )

    expect(result.stagedAiConfirmed).toBe(0)
    expect(result.aiRejected).toBe(1)
    expect(result.judgeErrors).toBe(0)
    expect(dedupeRows()).toHaveLength(0)
    expect(result.note).toContain('1 judged different')
  })

  it('judge THROWS → judgeErrors counted, run still completes, nothing staged', async () => {
    await seedNearPref('th-rm', 'th-keep', 'gamma', 44)
    const judge = throwingJudge()

    const result = await runGraphCleanup(
      { engine: store.engine, db: appData.db, router: judge.router },
      { scope: 'count', count: 2, labels: ['Preference'] }
    )

    expect(judge.calls).toHaveLength(1)
    expect(result.judgeErrors).toBe(1)
    expect(result.stagedAiConfirmed).toBe(0)
    expect(dedupeRows()).toHaveLength(0)
    expect(result.note).toContain('judge errors 1')
  })

  it('a hallucinated keep_id (not a group member) falls back to the scan suggestedKeepId', async () => {
    await seedNearPref('hk-rm', 'hk-keep', 'delta', 46) // hk-keep seeded last ⇒ suggested keeper
    const judge = fakeJudge(() => ({ same: true, keep_id: 'ghost-not-a-member', reason: 'same' }))

    const result = await runGraphCleanup(
      { engine: store.engine, db: appData.db, router: judge.router },
      { scope: 'count', count: 2, labels: ['Preference'] }
    )

    expect(result.stagedAiConfirmed).toBe(1)
    const row = dedupeRows()[0]!
    expect(row.payload['keepId']).toBe('hk-keep') // NOT the hallucinated id
    expect(row.payload['removeIds']).toEqual(['hk-rm'])
  })
})

// ── idempotent re-run: already-staged groups are skipped ─────────────────────────

describe('runGraphCleanup — a re-run skips groups already awaiting review', () => {
  it('a second pass over already-staged rows skips them and creates no duplicate row', async () => {
    await seedExactPref('rr-rm', 'rr-keep', 'likes strict typescript', 12)

    const first = await runGraphCleanup(
      { engine: store.engine, db: appData.db },
      { scope: 'count', count: 2, labels: ['Preference'] }
    )
    expect(first.stagedExact).toBe(1)
    expect(dedupeRows()).toHaveLength(1)

    const second = await runGraphCleanup(
      { engine: store.engine, db: appData.db },
      { scope: 'count', count: 2, labels: ['Preference'] }
    )
    expect(second.stagedExact).toBe(0)
    expect(second.skippedAlreadyStaged).toBe(1)
    expect(dedupeRows()).toHaveLength(1) // still exactly one — no duplicate proposal
    expect(second.note).toContain('already-staged 1')
  })
})

// ── no judge injected: exact only ────────────────────────────────────────────────

describe('runGraphCleanup — without a router the near groups are left for a judged run', () => {
  it('stages exact duplicates, leaves near groups untouched, and the note flags the missing judge', async () => {
    await seedExactPref('nj-rm', 'nj-keep', 'deploy to us-east', 14)
    await seedNearPref('nj-na', 'nj-nb', 'epsilon', 48)

    const result = await runGraphCleanup(
      { engine: store.engine, db: appData.db }, // no router
      { scope: 'count', count: 4, labels: ['Preference'] }
    )

    expect(result.stagedExact).toBe(1)
    expect(result.stagedAiConfirmed).toBe(0)
    expect(result.judgeUnavailable).toBe(true)
    expect(result.note).toContain('AI judge unavailable — staged exact duplicates only')

    const rows = dedupeRows()
    expect(rows).toHaveLength(1) // only the exact group
    expect(rows[0]!.payload['keepId']).toBe('nj-keep')
    // The near pair is untouched — not staged.
    expect(rows.some((r) => (r.payload['removeIds'] as string[]).includes('nj-nb'))).toBe(false)
  })
})

// ── LLM-judgment cap ────────────────────────────────────────────────────────────

describe('runGraphCleanup — caps the LLM judgments per run', () => {
  it('judges up to the cap and flags the rest as truncated (via the maxJudgments seam)', async () => {
    await seedNearPref('cap-a-rm', 'cap-a-keep', 'zeta', 50)
    await seedNearPref('cap-b-rm', 'cap-b-keep', 'eta', 60)
    const judge = fakeJudge(() => ({ same: true, reason: 'same' }))

    const result = await runGraphCleanup(
      { engine: store.engine, db: appData.db, router: judge.router },
      { scope: 'count', count: 4, labels: ['Preference'], maxJudgments: 1 }
    )

    expect(judge.calls).toHaveLength(1) // only one near group judged
    expect(result.stagedAiConfirmed).toBe(1)
    expect(result.judgmentsTruncated).toBe(true)
    expect(dedupeRows()).toHaveLength(1)
    expect(result.note).toContain('judgments capped at 1 — some near groups left for next run')
  })
})

// ── Skill/Project groups are report-only ─────────────────────────────────────────

describe('runGraphCleanup — Skill/Project duplicate groups are report-only', () => {
  it('never stages a Project duplicate group (counted report-only)', async () => {
    await seed('Project', { id: 'rp-a', name: 'checkout service', summary: 'payments API', embedding: basisEmbedding(EMBEDDING_DIM, 62) })
    await seed('Project', { id: 'rp-b', name: 'checkout service', summary: 'payments API', embedding: basisEmbedding(EMBEDDING_DIM, 63) })
    const judge = fakeJudge(() => ({ same: true, reason: 'same' }))

    const result = await runGraphCleanup(
      { engine: store.engine, db: appData.db, router: judge.router },
      { scope: 'count', count: 2, labels: ['Project'] }
    )

    expect(result.reportOnly).toBe(1)
    expect(result.stagedExact).toBe(0)
    expect(result.stagedAiConfirmed).toBe(0)
    expect(judge.calls).toHaveLength(0) // report-only groups never reach the judge
    expect(dedupeRows()).toHaveLength(0)
    expect(result.note).toContain('1 report-only (Skill/Project)')
    expect(await nodeCount('Project', 'rp-a')).toBe(1)
    expect(await nodeCount('Project', 'rp-b')).toBe(1)
  })
})

// ── the thin queue wrappers ──────────────────────────────────────────────────────

describe('enqueueGraphCleanup + registerGraphCleanupHandler (§8 wiring)', () => {
  it('mints a deterministic per-minute id, dedups a burst, and carries the scan options in the payload', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-07-21T12:34:00.000Z'))
    try {
      const queue = new DurableTaskQueue({ db: appData.db }) // NOT started — enqueue just mirrors the row
      const first = enqueueGraphCleanup(queue, { scope: 'count', count: 100, threshold: 0.9, labels: ['Preference'] })
      expect(first.deduped).toBe(false)
      expect(first.taskId).toMatch(/^graph-cleanup-\d{4}-\d{2}-\d{2}T\d{4}$/)

      // A second "clean up now" in the same minute collapses onto the same task id.
      const second = enqueueGraphCleanup(queue, {})
      expect(second.taskId).toBe(first.taskId)
      expect(second.deduped).toBe(true)

      const row = appData.db.prepare('SELECT kind, priority, payload_json FROM tasks WHERE id = ?').get(first.taskId) as {
        kind: string
        priority: number
        payload_json: string
      }
      expect(row.kind).toBe(GRAPH_CLEANUP_TASK_KIND)
      expect(row.priority).toBe(TASK_PRIORITY.maintenance)
      expect(JSON.parse(row.payload_json)).toEqual({ scope: 'count', count: 100, threshold: 0.9, labels: ['Preference'] })
    } finally {
      vi.useRealTimers()
    }
  })

  it('registers the graph-cleanup handler and runs it end-to-end (payload decoded, note recorded, row staged)', async () => {
    await seedExactPref('wf-rm', 'wf-keep', 'wf test statement', 16)

    const queue = new DurableTaskQueue({ db: appData.db })
    registerGraphCleanupHandler(queue, { engine: store.engine, db: appData.db })
    expect(queue.registeredKinds).toContain(GRAPH_CLEANUP_TASK_KIND)

    queue.start()
    try {
      const { taskId } = enqueueGraphCleanup(queue, { scope: 'count', count: 2, labels: ['Preference'] })
      await vi.waitFor(
        () => {
          const t = appData.db.prepare('SELECT status FROM tasks WHERE id = ?').get(taskId) as { status: string } | undefined
          expect(t?.status).toBe('done')
        },
        { timeout: 10_000, interval: 20 }
      )
      const row = appData.db.prepare('SELECT last_error FROM tasks WHERE id = ?').get(taskId) as { last_error: string | null }
      expect(row.last_error).toBeNull()
      const rows = dedupeRows()
      expect(rows).toHaveLength(1)
      expect(rows[0]!.proposedBy).toBe(GRAPH_CLEANUP_PROPOSER)
      expect(rows[0]!.payload['keepId']).toBe('wf-keep')
    } finally {
      await queue.stop(0)
    }
  })
})
