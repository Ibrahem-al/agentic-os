/**
 * Phase-12 DoD over the REAL storage engine + kernel stack + REAL AuditLog
 * (offline: scripted local LLM / fake cloud brain / bag-of-words embedder;
 * OLLAMA=1 live gate at the end):
 *
 *  - synthetic skill with seeded corrections → candidate generated,
 *    benchmarked, ADOPTED only on net-positive + zero regression (both
 *    outcomes tested);
 *  - the stylistic path lands in the review queue, never auto-adopts —
 *    approve = the audited flip, reject = row + audited candidate retire;
 *  - the event gate (nightly new-signal only; manual bypass; pending-review
 *    block; per-skill signal kept when a run cannot proceed);
 *  - rollback restores the prior version byte-for-byte; the drift flag fires
 *    on a seeded regression stream (auto-revert per-skill, default off);
 *  - crash mid-write → resume on a FRESH instance completes with ZERO cloud
 *    calls and ZERO re-generations (checkpoints are load-bearing);
 *  - the queue handler wires the 02:00 slot + "improve now" to the workflow.
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  createSkillImprovementAgent,
  enqueueManualImprovement,
  exportSkillMdFile,
  getSkillSettings,
  latestStandingAdoption,
  listImprovements,
  registerSkillImprovementHandler,
  rollbackSkillAdoption,
  runBenchmark,
  setSkillSettings,
  skillEmbedText,
  stagedWriteIdOf,
  type SkillCloud,
  type SkillEmbedder,
  type SkillImprovementAgent,
  type SkillLlm,
  type SkillTestSet
} from '../../src/main/agents'
import { SKILL_IMPROVEMENT_PROVENANCE } from '../../src/main/config'
import { LangGraphRunner } from '../../src/main/kernel'
import { defaultModelSettings, OllamaClient, ProviderRouter, SpendMeter } from '../../src/main/models'
import {
  approveStagedWrite,
  AuditLog,
  rejectStagedWriteWithEffects,
  renderStagedWriteDiff,
  type StagedWritesDeps
} from '../../src/main/security'
import { FailingOnceEmbedder, FakeExtractionEmbedder } from '../fixtures/extraction-fakes'
import { fakeTextEmbedding } from '../fixtures/graph-seed'
import { openKernelStack, type KernelTestStack } from '../fixtures/kernel-helpers'
import { FakeSkillCloudBrain, ScriptedSkillLlm, skillMdOf, type FakeSkillCloudReplies } from '../fixtures/skill-fakes'
import { openTestStore, type TestStore } from './helpers'

let store: TestStore
let stack: KernelTestStack
let audit: AuditLog

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

const makeAgent = (models: {
  llm: SkillLlm
  cloud?: SkillCloud | null
  embedder?: SkillEmbedder
}): SkillImprovementAgent => {
  const runner = new LangGraphRunner({ db: stack.appData.db, telemetry: stack.telemetry, executor: stack.kernel })
  return createSkillImprovementAgent({
    engine: store.engine,
    db: stack.appData.db,
    runner,
    embedder: models.embedder ?? new FakeExtractionEmbedder(),
    llm: models.llm,
    cloud: models.cloud ?? null,
    audit
  })
}

const cloudOf = (replies: FakeSkillCloudReplies, options?: { failAll?: boolean }): SkillCloud & { brain: FakeSkillCloudBrain } => ({
  brain: new FakeSkillCloudBrain(replies, options),
  meter: new SpendMeter({ db: stack.appData.db })
})

interface SkillSeed {
  id: string
  name: string
  instructions: string
  activeVersion?: { id: string; instructions: string }
  corrections?: readonly { id: string; content: string }[]
  failureExamples?: readonly { id: string; content: string }[]
}

async function seedSkill(seed: SkillSeed): Promise<void> {
  await store.engine.upsertNode('Skill', {
    id: seed.id,
    name: seed.name,
    instructions: seed.instructions,
    current_version: seed.activeVersion?.id ?? '',
    embedding: fakeTextEmbedding(skillEmbedText(seed.name, seed.instructions))
  })
  if (seed.activeVersion) {
    await store.engine.upsertNode('SkillVersion', {
      id: seed.activeVersion.id,
      instructions: seed.activeVersion.instructions,
      status: 'active'
    })
    await store.engine.createEdge(
      'HAS_VERSION',
      { label: 'Skill', id: seed.id },
      { label: 'SkillVersion', id: seed.activeVersion.id }
    )
  }
  for (const correction of seed.corrections ?? []) await seedCorrection(seed.id, correction)
  for (const example of seed.failureExamples ?? []) {
    await store.engine.upsertNode('Example', { id: example.id, kind: 'failure', content: example.content })
    await store.engine.createEdge('HAS_EXAMPLE', { label: 'Skill', id: seed.id }, { label: 'Example', id: example.id })
  }
}

async function seedCorrection(skillId: string, correction: { id: string; content: string }): Promise<void> {
  await store.engine.upsertNode('Correction', { id: correction.id, content: correction.content })
  await store.engine.createEdge('IMPROVED', { label: 'Correction', id: correction.id }, { label: 'Skill', id: skillId })
}

let usedSeq = 0
/** One skill use = a Session with a USED edge (drift-watch fodder). */
async function seedUse(skillId: string): Promise<void> {
  usedSeq += 1
  const sessionId = `session-use-${skillId}-${usedSeq}`
  await store.engine.upsertNode('Session', { id: sessionId })
  await store.engine.createEdge('USED', { label: 'Session', id: sessionId }, { label: 'Skill', id: skillId })
}

async function skillRow(id: string): Promise<{ instructions: string; currentVersion: string | null }> {
  const rows = await store.engine.cypher(
    `MATCH (s:Skill {id: $id}) RETURN s.instructions AS i, s.current_version AS v LIMIT 1`,
    { id }
  )
  const row = rows[0]
  expect(row).toBeDefined()
  return {
    instructions: String(row?.['i'] ?? ''),
    currentVersion: row?.['v'] == null || row?.['v'] === '' ? null : String(row?.['v'])
  }
}

async function versionStatus(id: string): Promise<string | null> {
  const rows = await store.engine.cypher(`MATCH (v:SkillVersion {id: $id}) RETURN v.status AS s LIMIT 1`, { id })
  return rows[0] === undefined ? null : String(rows[0]['s'])
}

const stagedDeps = (): StagedWritesDeps => ({
  db: stack.appData.db,
  engine: store.engine,
  audit,
  embedder: new FakeExtractionEmbedder()
})

beforeAll(async () => {
  store = await openTestStore()
  stack = openKernelStack()
  audit = new AuditLog({ db: stack.appData.db, backupsDir: store.backupsDir, engine: store.engine })
})

afterAll(async () => {
  stack.cleanup()
  await store.cleanup()
})

// ── shared scenario-A material (later scenarios build on the adopted state) ──

const SA_V0_BODY = 'Run the formatter on changed files.\nReport the results.'
const SA_CAND_1 = skillMdOf(
  'format-check',
  'Use this skill to format changed files safely.',
  'First run the linter, then the formatter.\nAlways skip generated files.\nCover SYNCOV scenarios.'
)
const SA_CAND_2 = skillMdOf(
  'format-check',
  'Use this skill to format changed files safely and report.',
  'First run the linter, then the formatter.\nAlways skip generated files.\nCover SYNCOV and SYNCOV2 scenarios.\nAlways print a summary line.'
)

const gradeA = (expectation: string, output: string): boolean =>
  expectation.includes('linter')
    ? output.includes('run the linter')
    : expectation.includes('generated')
      ? output.includes('skip generated files')
      : expectation.includes('summary')
        ? output.includes('print a summary')
        : expectation.includes('SYNCOV2')
          ? output.includes('SYNCOV2')
          : expectation.includes('SYNCOV')
            ? output.includes('SYNCOV')
            : false

const SA_CASES_JSON = '[{"prompt": "Format the payments module before review.", "expectations": ["The response covers SYNCOV"]}]'
const SA_CASES_JSON_2 = '[{"prompt": "Format the billing module.", "expectations": ["The response covers SYNCOV2"]}]'

let saCandidate1 = ''
let saCandidate2 = ''

describe('DoD 1a — verifiable skill: candidate generated, benchmarked, ADOPTED (nightly run)', () => {
  it('adopts on net-positive + zero regression: flip, provenance, ledger, spend, audit', async () => {
    await seedSkill({
      id: 'sa',
      name: 'format-check',
      instructions: SA_V0_BODY, // legacy plain text — exercises the SKILL.md wrap
      activeVersion: { id: 'sv-sa-v0', instructions: SA_V0_BODY },
      corrections: [
        { id: 'corr-a1', content: 'always run the linter before formatting' },
        { id: 'corr-a2', content: 'never format generated files' }
      ],
      failureExamples: [{ id: 'ex-a1', content: 'formatted a generated bundle and broke the build' }]
    })
    setSkillSettings(stack.appData.db, 'sa', { mode: 'verifiable' })
    await sleep(10)

    const cloud = cloudOf({ rewriteByName: { 'format-check': SA_CAND_1 }, casesByName: { 'format-check': SA_CASES_JSON } })
    const agent = makeAgent({ llm: new ScriptedSkillLlm({ grade: gradeA }), cloud })
    const result = await agent.runImprovement({ jobId: 'job-sa-1' }) // nightly mode: the event gate selects sa

    expect(result.mode).toBe('nightly')
    expect(result.processed).toHaveLength(1)
    const processed = result.processed[0]!
    expect(processed).toMatchObject({ skillId: 'sa', outcome: 'adopted', regressions: 0 })
    expect(processed.heldoutScore!.candidate).toBeGreaterThan(processed.heldoutScore!.active)
    saCandidate1 = processed.candidateVersionId!

    // The flip: candidate active, v0 retired, Skill serves the adopted SKILL.md.
    expect(await versionStatus(saCandidate1)).toBe('active')
    expect(await versionStatus('sv-sa-v0')).toBe('retired')
    const skill = await skillRow('sa')
    expect(skill.currentVersion).toBe(saCandidate1)
    expect(skill.instructions).toBe(SA_CAND_1) // byte-equal SKILL.md persisted

    // Provenance on the improvement-written HAS_VERSION edge (§21 rule 4 shape).
    const edge = await store.engine.cypher(
      `MATCH (s:Skill {id: 'sa'})-[r:HAS_VERSION]->(v:SkillVersion {id: $v}) RETURN r.extracted_by AS eb, r.confidence AS c`,
      { v: saCandidate1 }
    )
    expect(String(edge[0]?.['eb'])).toBe(SKILL_IMPROVEMENT_PROVENANCE)
    expect(Number(edge[0]?.['c'])).toBe(1) // candidate held-out pass rate

    // The re-embedded Skill is served back by the real vector index.
    const hits = await store.engine.vectorSearch('Skill', fakeTextEmbedding(skillEmbedText('format-check', SA_CAND_1)), 3)
    const saHit = hits.find((hit) => hit.id === 'sa')
    expect(saHit).toBeDefined()
    expect(saHit!.distance).toBeLessThan(0.001)

    // Ledger: adopted, predecessor snapshot = the pre-adoption baseline.
    const ledger = listImprovements(stack.appData.db, 'sa')
    expect(ledger).toHaveLength(1)
    expect(ledger[0]).toMatchObject({
      outcome: 'adopted',
      candidateVersionId: saCandidate1,
      predecessorVersionId: 'sv-sa-v0',
      predecessorInstructions: SA_V0_BODY,
      mode: 'verifiable',
      jobId: 'job-sa-1'
    })
    expect(ledger[0]!.adoptedAt).not.toBeNull()

    // Event-gate cursor advanced; §14 spend recorded per cloud call (2: cases + rewrite).
    expect(getSkillSettings(stack.appData.db, 'sa').lastRunAt).not.toBeNull()
    const spend = stack.appData.db
      .prepare(`SELECT count(*) AS c FROM spend WHERE task_id = 'job-sa-1'`)
      .get() as { c: number }
    expect(spend.c).toBe(2)

    // Two audited reversible actions: record + adopt.
    const actions = audit.listActions({ kind: 'graph-write' }).filter((row) => row.description.includes('sa'))
    expect(actions.some((row) => row.description.includes('record candidate version'))).toBe(true)
    const adoptAction = actions.find((row) => row.description.includes('adopt'))
    expect(adoptAction?.reversible).toBe(true)
  }, 60_000)
})

describe('DoD 1b — verifiable skill: candidate REJECTED on a regression', () => {
  it('a candidate breaking a previously-fixed correction is not adopted; the attempt is recorded', async () => {
    const sbV0 = 'Always run the linter first.\nThen format changed files.'
    const sbCand = skillMdOf('json-tidy', 'Tidy JSON files.', 'Do NEWTHING checks.\nFormat changed files.')
    await seedSkill({
      id: 'sb',
      name: 'json-tidy',
      instructions: sbV0,
      activeVersion: { id: 'sv-sb-v0', instructions: sbV0 },
      corrections: [
        { id: 'corr-b1', content: 'always run the linter before formatting' }, // previously fixed: v0 complies
        { id: 'corr-b2', content: 'always mention NEWTHING checks' }
      ]
    })
    setSkillSettings(stack.appData.db, 'sb', { mode: 'verifiable' })
    await sleep(10)

    const grade = (expectation: string, output: string): boolean =>
      expectation.includes('linter')
        ? output.includes('run the linter')
        : expectation.includes('NEWTHING')
          ? output.includes('NEWTHING')
          : false
    const cloud = cloudOf({ rewriteByName: { 'json-tidy': sbCand }, casesByName: { 'json-tidy': '[]' } })
    const agent = makeAgent({ llm: new ScriptedSkillLlm({ grade }), cloud })
    const result = await agent.runImprovement({ skillId: 'sb', jobId: 'job-sb-1' })

    const processed = result.processed[0]!
    expect(processed.outcome).toBe('rejected')
    expect(processed.regressions).toBe(1)
    expect(processed.note).toContain('corr-b1') // the broken correction is named

    // NOT adopted: active version + skill untouched; the attempt is honest history.
    expect(await versionStatus('sv-sb-v0')).toBe('active')
    const skill = await skillRow('sb')
    expect(skill.currentVersion).toBe('sv-sb-v0')
    expect(skill.instructions).toBe(sbV0)
    expect(await versionStatus(processed.candidateVersionId!)).toBe('retired')

    const ledger = listImprovements(stack.appData.db, 'sb')[0]!
    expect(ledger.outcome).toBe('rejected')
    expect(ledger.adoptedAt).toBeNull()
    const summary = (ledger.benchmark['summary'] ?? {}) as Record<string, unknown>
    expect((summary['regressions'] as unknown[]).length).toBe(1)
  }, 60_000)
})

describe('DoD 2 — stylistic path lands in the review queue, never auto-adopted', () => {
  const scV0 = 'Write release notes in a friendly tone.'
  const scCand = skillMdOf('release-notes', 'Draft release notes.', 'CANDMARK: use short sentences.\nKeep a friendly tone.')
  let scCandidateId = ''

  it('stages the benchmarked candidate (blind A/B ran) and leaves the skill untouched', async () => {
    await seedSkill({
      id: 'sc',
      name: 'release-notes',
      instructions: scV0, // no version node — first-adoption path
      corrections: [{ id: 'corr-c1', content: 'use shorter sentences in release notes' }]
    })
    // Deliberately NO setSkillSettings: 'stylistic' must be the default.
    await sleep(10)

    const cloud = cloudOf({
      rewriteByName: { 'release-notes': scCand },
      casesByName: { 'release-notes': '[{"prompt": "Draft notes for v2.", "expectations": ["Uses short sentences"]}]' },
      compare: (a, b) => (a.includes('CANDMARK') ? 'A' : b.includes('CANDMARK') ? 'B' : 'TIE')
    })
    const agent = makeAgent({ llm: new ScriptedSkillLlm({ grade: () => false }), cloud })
    const result = await agent.runImprovement({ skillId: 'sc', jobId: 'job-sc-1' })

    const processed = result.processed[0]!
    expect(processed.outcome).toBe('staged')
    scCandidateId = processed.candidateVersionId!
    expect(processed.stagedWriteId).toBe(stagedWriteIdOf(scCandidateId))

    // The blind comparator judged held-out cases (2 cases × 3 runs).
    expect(cloud.brain.calls.filter((call) => call.kind === 'compare')).toHaveLength(6)

    // Review queue row with the self-contained payload; graph skill untouched.
    const row = stack.appData.db
      .prepare(`SELECT kind, status, target_id, payload_json FROM staged_writes WHERE id = ?`)
      .get(processed.stagedWriteId) as { kind: string; status: string; target_id: string; payload_json: string }
    expect(row).toMatchObject({ kind: 'skill-improvement', status: 'staged', target_id: 'sc' })
    const payload = JSON.parse(row.payload_json) as Record<string, unknown>
    expect(payload['candidateInstructions']).toBe(scCand)
    expect(payload['activeInstructions']).toBe(scV0)

    expect(await versionStatus(scCandidateId)).toBe('candidate') // recorded, NOT active
    const skill = await skillRow('sc')
    expect(skill.currentVersion).toBeNull()
    expect(skill.instructions).toBe(scV0) // §17: no auto-adoption for stylistic
    expect(listImprovements(stack.appData.db, 'sc')[0]!.outcome).toBe('staged')

    // The one-click row renders a real diff with the benchmark verdicts.
    const diff = await renderStagedWriteDiff(stagedDeps(), processed.stagedWriteId!)
    expect(diff).toContain(`ADOPT SkillVersion ${scCandidateId}`)
    expect(diff).toContain('candidate wins 6, active wins 0, ties 0')
    expect(diff).toContain('+ CANDMARK: use short sentences.')
  }, 60_000)

  it('APPROVE commits the audited adoption flip (first adoption: no predecessor to retire)', async () => {
    const approved = await approveStagedWrite(stagedDeps(), stagedWriteIdOf(scCandidateId), {
      decidedBy: 'user:test'
    })
    expect(approved.status).toBe('committed')
    expect(approved.auditActionId).not.toBe('')

    expect(await versionStatus(scCandidateId)).toBe('active')
    const skill = await skillRow('sc')
    expect(skill.currentVersion).toBe(scCandidateId)
    expect(skill.instructions).toBe(scCand)
    const ledger = listImprovements(stack.appData.db, 'sc')[0]!
    expect(ledger.outcome).toBe('adopted')
    expect(ledger.adoptedAt).not.toBeNull()
  }, 30_000)

  it('and rolling back a FIRST adoption restores the pre-version plain instructions', async () => {
    const rollback = await rollbackSkillAdoption(
      { engine: store.engine, db: stack.appData.db, audit, embedder: new FakeExtractionEmbedder() },
      { skillId: 'sc', decidedBy: 'user:test' }
    )
    expect(rollback.restoredVersionId).toBeNull()
    expect(await versionStatus(scCandidateId)).toBe('retired')
    const skill = await skillRow('sc')
    expect(skill.currentVersion).toBeNull()
    expect(skill.instructions).toBe(scV0) // byte-equal restore from the ledger snapshot
    expect(listImprovements(stack.appData.db, 'sc')[0]!.rolledBackAt).not.toBeNull()
  }, 30_000)

  it('REJECT flips the row and retires the recorded candidate (audited) — skill untouched', async () => {
    const sdV0 = 'Summarize incidents plainly.'
    const sdCand = skillMdOf('incident-summary', 'Summarize incidents.', 'DULLMARK: summarize with headers.')
    await seedSkill({
      id: 'sd',
      name: 'incident-summary',
      instructions: sdV0,
      corrections: [{ id: 'corr-d1', content: 'keep incident summaries under five lines' }]
    })
    await sleep(10)
    const cloud = cloudOf({
      rewriteByName: { 'incident-summary': sdCand },
      casesByName: { 'incident-summary': '[]' },
      compare: () => 'TIE'
    })
    const agent = makeAgent({ llm: new ScriptedSkillLlm({ grade: () => false }), cloud })
    const result = await agent.runImprovement({ skillId: 'sd', jobId: 'job-sd-1' })
    const processed = result.processed[0]!
    expect(processed.outcome).toBe('staged') // stylistic stages even when the A/B is a wash

    await rejectStagedWriteWithEffects(stagedDeps(), processed.stagedWriteId!, {
      decidedBy: 'user:test',
      reason: 'not better'
    })
    const row = stack.appData.db
      .prepare(`SELECT status FROM staged_writes WHERE id = ?`)
      .get(processed.stagedWriteId) as { status: string }
    expect(row.status).toBe('rejected')
    expect(await versionStatus(processed.candidateVersionId!)).toBe('retired') // no orphaned candidate
    const skill = await skillRow('sd')
    expect(skill.instructions).toBe(sdV0)
    expect(skill.currentVersion).toBeNull()
    expect(listImprovements(stack.appData.db, 'sd')[0]!.outcome).toBe('rejected')
  }, 60_000)
})

describe('event gate (§20: only skills with new signal since the last run)', () => {
  it('a quiet nightly run processes nothing', async () => {
    const agent = makeAgent({ llm: new ScriptedSkillLlm({ grade: gradeA }), cloud: cloudOf({}) })
    const result = await agent.runImprovement({ jobId: 'job-quiet-1' })
    expect(result.processed).toHaveLength(0) // sa/sb/sc/sd all consumed their signal
    expect(result.drift).toHaveLength(0) // adopted versions have zero uses yet
  }, 60_000)

  it('a NEW correction re-gates the skill; the nightly run improves it again', async () => {
    await sleep(10)
    await seedCorrection('sa', { id: 'corr-a3', content: 'always print a summary line at the end' })
    await sleep(10)
    const cloud = cloudOf({ rewriteByName: { 'format-check': SA_CAND_2 }, casesByName: { 'format-check': SA_CASES_JSON_2 } })
    const agent = makeAgent({ llm: new ScriptedSkillLlm({ grade: gradeA }), cloud })
    const result = await agent.runImprovement({ jobId: 'job-sa-2' })

    expect(result.processed.map((p) => p.skillId)).toEqual(['sa'])
    expect(result.processed[0]!.outcome).toBe('adopted')
    saCandidate2 = result.processed[0]!.candidateVersionId!
    expect(await versionStatus(saCandidate2)).toBe('active')
    expect(await versionStatus(saCandidate1)).toBe('retired') // the chain: v0 → cand1 → cand2
    expect(listImprovements(stack.appData.db, 'sa')).toHaveLength(2)
  }, 60_000)

  it('a skill with a PENDING review row is skipped until the row is decided', async () => {
    const seV0 = 'Answer support tickets politely.'
    await seedSkill({
      id: 'se',
      name: 'ticket-reply',
      instructions: seV0,
      corrections: [{ id: 'corr-e1', content: 'sign every reply with the team name' }]
    })
    await sleep(10)
    const cloud = cloudOf({
      rewriteByName: { 'ticket-reply': skillMdOf('ticket-reply', 'Reply to tickets.', 'Sign with the team name.') },
      casesByName: { 'ticket-reply': '[]' },
      compare: () => 'TIE'
    })
    const first = await makeAgent({ llm: new ScriptedSkillLlm({ grade: () => false }), cloud }).runImprovement({
      skillId: 'se',
      jobId: 'job-se-1'
    })
    expect(first.processed[0]!.outcome).toBe('staged')

    await sleep(10)
    await seedCorrection('se', { id: 'corr-e2', content: 'link the runbook in every reply' })
    await sleep(10)
    const nightly = await makeAgent({ llm: new ScriptedSkillLlm({ grade: () => false }), cloud: cloudOf({}) }).runImprovement({
      jobId: 'job-se-2'
    })
    const seEntry = nightly.processed.find((p) => p.skillId === 'se')
    expect(seEntry?.outcome).toBe('skipped-pending-review')
    expect(listImprovements(stack.appData.db, 'se')).toHaveLength(1) // no second candidate piled up
  }, 60_000)

  it('manual mode needs SOME signal: a skill with none completes with a note', async () => {
    await seedSkill({ id: 'sk-empty', name: 'empty-skill', instructions: 'Do nothing in particular.' })
    const agent = makeAgent({ llm: new ScriptedSkillLlm({}), cloud: cloudOf({}) })
    const result = await agent.runImprovement({ skillId: 'sk-empty', jobId: 'job-empty-1' })
    expect(result.processed[0]!.outcome).toBe('skipped-no-signal')
    expect(listImprovements(stack.appData.db, 'sk-empty')).toHaveLength(0)
  }, 60_000)
})

describe('DoD 3a — rollback restores the prior version', () => {
  it('rollbackSkill retires the adopted version and restores the predecessor byte-for-byte', async () => {
    // sa is on candidate-2 (adoption 2); rollback returns it to candidate-1.
    const rollback = await rollbackSkillAdoption(
      { engine: store.engine, db: stack.appData.db, audit, embedder: new FakeExtractionEmbedder() },
      { skillId: 'sa', decidedBy: 'user:test' }
    )
    expect(rollback.retiredVersionId).toBe(saCandidate2)
    expect(rollback.restoredVersionId).toBe(saCandidate1)

    expect(await versionStatus(saCandidate2)).toBe('retired')
    expect(await versionStatus(saCandidate1)).toBe('active')
    const skill = await skillRow('sa')
    expect(skill.currentVersion).toBe(saCandidate1)
    expect(skill.instructions).toBe(SA_CAND_1) // the predecessor snapshot, verbatim

    const ledger = listImprovements(stack.appData.db, 'sa')
    const second = ledger.find((row) => row.candidateVersionId === saCandidate2)!
    expect(second.rolledBackAt).not.toBeNull()
    // The FIRST adoption still stands — the rollback chain continues from it.
    expect(latestStandingAdoption(stack.appData.db, 'sa')?.candidateVersionId).toBe(saCandidate1)
  }, 30_000)

  it('the adopted skill round-trips losslessly to a SKILL.md file on disk (DoD 4)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agentic-os-skillexport-'))
    try {
      const skill = await skillRow('sa')
      const path = exportSkillMdFile(dir, 'format-check', skill.instructions)
      expect(readFileSync(path, 'utf8')).toBe(skill.instructions) // graph → disk, byte-equal
      expect(readFileSync(path, 'utf8')).toBe(SA_CAND_1)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('DoD 3b — drift watch: flag on a seeded regression stream; auto-revert per-skill', () => {
  const driftSkill = async (
    id: string,
    name: string,
    correctionId: string
  ): Promise<{ candidateId: string }> => {
    const v0 = `Handle ${name} tasks carefully.`
    await seedSkill({
      id,
      name,
      instructions: v0,
      activeVersion: { id: `sv-${id}-v0`, instructions: v0 },
      corrections: [{ id: correctionId, content: `always double-check ${name} MARKPHRASE` }]
    })
    setSkillSettings(stack.appData.db, id, { mode: 'verifiable' })
    // Predecessor tenure: 2 clean uses (rate: 1 correction / 2 uses = 0.5).
    await seedUse(id)
    await seedUse(id)
    await sleep(10)
    const cand = skillMdOf(name, `Handle ${name} tasks.`, `Always double-check ${name} MARKPHRASE first.`)
    const cloud = cloudOf({ rewriteByName: { [name]: cand }, casesByName: { [name]: '[]' } })
    const grade = (expectation: string, output: string): boolean =>
      expectation.includes('MARKPHRASE') ? output.includes('MARKPHRASE first') : false
    const result = await makeAgent({ llm: new ScriptedSkillLlm({ grade }), cloud }).runImprovement({
      skillId: id,
      jobId: `job-${id}-adopt`
    })
    expect(result.processed[0]!.outcome).toBe('adopted')
    return { candidateId: result.processed[0]!.candidateVersionId! }
  }

  let sfCandidate = ''
  let sgCandidate = ''
  let shCandidate = ''

  it('flags a worse-than-predecessor corrections rate (default: flag only), auto-reverts when asked, clears a survived watch', async () => {
    const sf = await driftSkill('sf', 'deploy-notes', 'corr-f1')
    sfCandidate = sf.candidateId
    const sg = await driftSkill('sg', 'query-tuner', 'corr-g1')
    sgCandidate = sg.candidateId
    setSkillSettings(stack.appData.db, 'sg', { autoRevert: true })
    const sh = await driftSkill('sh', 'log-triage', 'corr-h1')
    shCandidate = sh.candidateId
    await sleep(10)

    // The regression streams. sf/sg: 3 uses drawing 3 corrections each
    // (rate 1.0 vs predecessor 0.5 → worse). sh: 20 clean uses → watch
    // complete, rate 0 ≤ predecessor → cleared.
    for (const id of ['sf', 'sg']) {
      for (let i = 0; i < 3; i++) {
        await seedUse(id)
        await seedCorrection(id, { id: `corr-${id}-drift-${i}`, content: `post-adoption complaint ${i} about ${id}` })
      }
    }
    for (let i = 0; i < 20; i++) await seedUse('sh')
    await sleep(10)

    // Drift evaluates on the NIGHTLY run. No cloud this launch: the freshly
    // re-gated sf/sg skip with their signal kept — detection never needs the
    // cloud tier, and a skipped skill keeps its event-gate cursor.
    const sfCursorBefore = getSkillSettings(stack.appData.db, 'sf').lastRunAt
    const nightly = await makeAgent({ llm: new ScriptedSkillLlm({}), cloud: null }).runImprovement({
      jobId: 'job-drift-1'
    })

    const byId = new Map(nightly.drift.map((d) => [d.skillId, d]))
    expect(byId.get('sf')).toMatchObject({ verdict: 'worse', action: 'flagged', versionId: sfCandidate })
    expect(byId.get('sf')!.newRate).toBeGreaterThan(byId.get('sf')!.predecessorRate)
    expect(byId.get('sg')).toMatchObject({ verdict: 'worse', action: 'auto-reverted', versionId: sgCandidate })
    expect(byId.get('sh')).toMatchObject({ verdict: 'cleared', action: 'cleared', versionId: shCandidate })

    // sf: flagged but STILL ACTIVE (§20 auto-revert off by default).
    expect(await versionStatus(sfCandidate)).toBe('active')
    const sfLedger = listImprovements(stack.appData.db, 'sf')[0]!
    expect(sfLedger.driftFlaggedAt).not.toBeNull()
    expect(sfLedger.rolledBackAt).toBeNull()
    expect((sfLedger.drift?.['newRate'] as number) > (sfLedger.drift?.['predecessorRate'] as number)).toBe(true)

    // sg: auto-reverted — predecessor active again, candidate retired.
    expect(await versionStatus(sgCandidate)).toBe('retired')
    expect(await versionStatus('sv-sg-v0')).toBe('active')
    expect((await skillRow('sg')).currentVersion).toBe('sv-sg-v0')
    const sgLedger = listImprovements(stack.appData.db, 'sg')[0]!
    expect(sgLedger.driftFlaggedAt).not.toBeNull()
    expect(sgLedger.rolledBackAt).not.toBeNull()

    // sh: survived its 20-use probation — watch closed, version stays.
    expect(await versionStatus(shCandidate)).toBe('active')
    expect(listImprovements(stack.appData.db, 'sh')[0]!.driftResolvedAt).not.toBeNull()

    // The no-cloud run kept the re-gated skills' signal (cursor unchanged).
    const sfEntry = nightly.processed.find((p) => p.skillId === 'sf')
    expect(sfEntry?.outcome).toBe('skipped-no-cloud')
    expect(getSkillSettings(stack.appData.db, 'sf').lastRunAt).toBe(sfCursorBefore)
  }, 120_000)
})

describe('crash-resume (the checkpoint design is load-bearing)', () => {
  it('a crash mid-write resumes on a FRESH instance with zero cloud calls and zero re-generations', async () => {
    const siV0 = 'Rotate the API keys quarterly.'
    const siCand = skillMdOf('key-rotation', 'Rotate keys.', 'Rotate quarterly and RECORDIT in the vault log.')
    await seedSkill({
      id: 'si',
      name: 'key-rotation',
      instructions: siV0,
      activeVersion: { id: 'sv-si-v0', instructions: siV0 },
      corrections: [{ id: 'corr-i1', content: 'always RECORDIT after rotating keys' }]
    })
    setSkillSettings(stack.appData.db, 'si', { mode: 'verifiable' })
    await sleep(10)

    const grade = (expectation: string, output: string): boolean =>
      expectation.includes('RECORDIT') ? output.includes('RECORDIT in the vault log') : false
    const crashCloud = cloudOf({ rewriteByName: { 'key-rotation': siCand }, casesByName: { 'key-rotation': '[]' } })
    // The embedder dies on its FIRST call — which is the adoption re-embed
    // inside the write step (nothing earlier embeds).
    const crashing = makeAgent({
      llm: new ScriptedSkillLlm({ grade }),
      cloud: crashCloud,
      embedder: new FailingOnceEmbedder()
    })
    await expect(crashing.runImprovement({ skillId: 'si', jobId: 'job-si-1' })).rejects.toThrow(/deliberately crashing/)

    // Crash state: candidate recorded, adoption NOT applied, no ledger row.
    const candidateId = (await store.engine.cypher(
      `MATCH (s:Skill {id: 'si'})-[:HAS_VERSION]->(v:SkillVersion) WHERE v.id <> 'sv-si-v0' RETURN v.id AS id, v.status AS st`
    ))[0]!
    expect(String(candidateId['st'])).toBe('candidate')
    expect((await skillRow('si')).currentVersion).toBe('sv-si-v0')
    expect(listImprovements(stack.appData.db, 'si')).toHaveLength(0)

    // Fresh instance: cloud DEAD, executor DEAD — only checkpoints can finish it.
    const deadLlm = new ScriptedSkillLlm({ failExecute: true })
    const deadCloud = cloudOf({}, { failAll: true })
    const resumed = makeAgent({ llm: deadLlm, cloud: deadCloud, embedder: new FakeExtractionEmbedder() })
    const result = await resumed.resumeImprovement('job-si-1')

    expect(result.processed[0]!.outcome).toBe('adopted')
    expect(deadCloud.brain.calls).toHaveLength(0) // cloud never re-bought
    expect(deadLlm.executorCalls).toBe(0) // benchmark never re-ran
    expect((await skillRow('si')).currentVersion).toBe(String(candidateId['id']))
    expect(listImprovements(stack.appData.db, 'si')[0]!.outcome).toBe('adopted')
  }, 60_000)
})

describe('queue handler (the 02:00 slot + "improve now")', () => {
  it('runs nightly tasks with an honest note and manual tasks for one skill', async () => {
    const { DurableTaskQueue } = await import('../../src/main/triggers')
    const queue = new DurableTaskQueue({ db: stack.appData.db })
    const runner = new LangGraphRunner({ db: stack.appData.db, telemetry: stack.telemetry, executor: stack.kernel })
    const agent = createSkillImprovementAgent({
      engine: store.engine,
      db: stack.appData.db,
      runner,
      embedder: new FakeExtractionEmbedder(),
      llm: new ScriptedSkillLlm({}),
      cloud: null,
      audit
    })
    registerSkillImprovementHandler(queue, { agent, runner })
    queue.start()
    try {
      const waitFor = async (id: string): Promise<{ status: string; last_error: string | null }> => {
        const deadline = Date.now() + 60_000
        for (;;) {
          const row = stack.appData.db.prepare('SELECT status, last_error FROM tasks WHERE id = ?').get(id) as
            | { status: string; last_error: string | null }
            | undefined
          if (row !== undefined && row.status !== 'pending' && row.status !== 'running') return row
          if (Date.now() > deadline) throw new Error(`task ${id} did not settle`)
          await sleep(50)
        }
      }
      queue.enqueue({ id: 'skill-nightly-test', kind: 'skill-improvement' })
      expect((await waitFor('skill-nightly-test')).status).toBe('done')

      const manual = enqueueManualImprovement(queue, 'sk-empty')
      expect(manual.taskId).toMatch(/^skill-manual-sk-empty-/)
      expect((await waitFor(manual.taskId)).status).toBe('done')
      // The workflow job rows exist beside the task rows (deterministic -wf ids).
      const wf = stack.appData.db
        .prepare(`SELECT status FROM tasks WHERE id = ?`)
        .get(`${manual.taskId}-wf`) as { status: string } | undefined
      expect(wf?.status).toBe('done')
    } finally {
      await queue.stop(0)
    }
  }, 90_000)
})

// ── phase-16b: ProviderRouter injection (roles route through the router) ─────

describe('phase-16b — ProviderRouter injection (DEFAULT == TODAY; router wins over llm/cloud)', () => {
  it('router present: executor/grader via forRole, testset/rewrite via complete; deps.llm/cloud bypassed', async () => {
    const srV0 = 'Deploy the service and move on.'
    const srCand = skillMdOf('deploy-guard', 'Deploy safely.', 'Run the healthcheck and ROUTEMARK before declaring done.')
    await seedSkill({
      id: 'sr',
      name: 'deploy-guard',
      instructions: srV0,
      activeVersion: { id: 'sv-sr-v0', instructions: srV0 },
      corrections: [{ id: 'corr-r1', content: 'always ROUTEMARK after deploying' }]
    })
    setSkillSettings(stack.appData.db, 'sr', { mode: 'verifiable' })
    await sleep(10)

    // The router's LOCAL tier (a scripted qwen3, structurally an OllamaLike) and
    // its CLOUD tier (the fake brain + a REAL SpendMeter, so §14 metering runs).
    const grade = (expectation: string, output: string): boolean =>
      expectation.includes('ROUTEMARK') ? output.includes('ROUTEMARK') : false
    const routerLocal = new ScriptedSkillLlm({ grade })
    const routerBrain = new FakeSkillCloudBrain({
      rewriteByName: { 'deploy-guard': srCand },
      casesByName: { 'deploy-guard': '[]' }
    })
    const router = new ProviderRouter({
      loadSnapshot: () => defaultModelSettings(),
      ollama: routerLocal,
      makeCloud: () => ({ brain: routerBrain, meter: new SpendMeter({ db: stack.appData.db }) })
    })

    // deps.llm is DEAD and deps.cloud is null: if the router did not win, the
    // executor would throw and no cloud call could land → the run would not adopt.
    const deadLlm = new ScriptedSkillLlm({ failExecute: true })
    const runner = new LangGraphRunner({ db: stack.appData.db, telemetry: stack.telemetry, executor: stack.kernel })
    const agent = createSkillImprovementAgent({
      engine: store.engine,
      db: stack.appData.db,
      runner,
      embedder: new FakeExtractionEmbedder(),
      llm: deadLlm,
      cloud: null,
      router,
      audit
    })

    const result = await agent.runImprovement({ skillId: 'sr', jobId: 'job-sr16b-1' })

    expect(result.processed[0]!.outcome).toBe('adopted')
    // Cloud roles (testset synthesis + rewrite) routed through the ROUTER's cloud.
    expect(routerBrain.calls.map((c) => c.kind).sort()).toEqual(['cases', 'rewrite'])
    // Local roles (executor + grader) routed through the ROUTER's local tier.
    expect(routerLocal.executorCalls).toBeGreaterThan(0)
    expect(routerLocal.graderCalls).toBeGreaterThan(0)
    // The today path (deps.llm) was never touched — proof the router won.
    expect(deadLlm.executorCalls).toBe(0)
    // §14: the router's cloud adapter still meters every call against the job id.
    const spend = stack.appData.db.prepare(`SELECT count(*) AS c FROM spend WHERE task_id = 'job-sr16b-1'`).get() as { c: number }
    expect(spend.c).toBe(2) // cases + rewrite
    expect(await versionStatus(result.processed[0]!.candidateVersionId!)).toBe('active')
  }, 60_000)

  it('router present but KEYLESS (makeCloud → null): skills.rewrite resolves local → skipped-no-cloud, zero spend', async () => {
    const ssV0 = 'Answer questions concisely.'
    await seedSkill({
      id: 'ss',
      name: 'concise-answers',
      instructions: ssV0,
      corrections: [{ id: 'corr-s1', content: 'always cite a source' }]
    })
    await sleep(10)

    const router = new ProviderRouter({
      loadSnapshot: () => defaultModelSettings(),
      ollama: new ScriptedSkillLlm({}),
      makeCloud: () => null // keyless → the cloud roles resolve local → treated as no cloud tier
    })
    const runner = new LangGraphRunner({ db: stack.appData.db, telemetry: stack.telemetry, executor: stack.kernel })
    const agent = createSkillImprovementAgent({
      engine: store.engine,
      db: stack.appData.db,
      runner,
      embedder: new FakeExtractionEmbedder(),
      llm: new ScriptedSkillLlm({}),
      cloud: null,
      router,
      audit
    })

    const result = await agent.runImprovement({ skillId: 'ss', jobId: 'job-ss16b-1' })

    expect(result.processed[0]!.outcome).toBe('skipped-no-cloud') // DEFAULT == TODAY (keyless)
    expect((await skillRow('ss')).instructions).toBe(ssV0) // skill untouched
    const spend = stack.appData.db.prepare(`SELECT count(*) AS c FROM spend WHERE task_id = 'job-ss16b-1'`).get() as { c: number }
    expect(spend.c).toBe(0) // no non-local tier was ever called
  }, 60_000)
})

// ── live gate: the real local tier executes + grades through the real prompts ─

describe.skipIf(process.env['OLLAMA'] !== '1')('live benchmark (OLLAMA=1: real qwen3 executor + schema-constrained grader)', () => {
  it('runs candidate vs active on the real local tier and produces sane scores', async () => {
    const testset: SkillTestSet = {
      skillId: 'live-lint',
      cases: [
        {
          id: 'case-live-1',
          source: 'correction',
          correctionId: 'corr-live-1',
          prompt: 'A user asks you to prepare their JavaScript changes for commit. List the exact steps you take, in order.',
          expectations: [
            'The walkthrough complies with this user correction: "always run eslint before committing" — the corrected mistake does not appear, and the corrected behavior does.'
          ],
          split: 'heldout'
        }
      ],
      warnings: []
    }
    const benchmark = await runBenchmark({
      llm: new OllamaClient(),
      cloud: null,
      kind: 'verifiable',
      testset,
      candidateInstructions:
        'Prepare changes for commit: 1) run eslint and fix findings, 2) run the tests, 3) commit. Running eslint FIRST matters — commits must never carry lint errors.',
      activeInstructions: 'Prepare changes for commit: run the tests, then commit.',
      runsPerCase: 1
    })
    expect(benchmark.error).toBeNull()
    expect(benchmark.runs).toHaveLength(2) // 1 case × 2 configs × 1 run
    for (const run of benchmark.runs) {
      expect(run.output.length).toBeGreaterThan(0)
      expect(run.passRate).toBeGreaterThanOrEqual(0)
      expect(run.passRate).toBeLessThanOrEqual(1)
    }
    expect(benchmark.summary.heldoutScore).not.toBeNull()
    // The candidate names eslint; the active does not. The real grader should
    // separate them — pin the direction without demanding perfection twice.
    expect(benchmark.summary.heldoutScore!.candidate).toBeGreaterThanOrEqual(benchmark.summary.heldoutScore!.active)
  }, 240_000)
})
