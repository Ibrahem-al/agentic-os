/**
 * Skill-improvement harness logic (phase 12), pure pieces: the stratified
 * deterministic train/held-out split (skill-creator run_loop semantics),
 * grader/comparator reply parsing (fail-safe: burden of proof on the
 * expectation), majority + regression + net-positive math, the candidate
 * reply rescue, and the lifecycle id/diff helpers.
 */
import { describe, expect, it } from 'vitest'
import {
  assignSplits,
  buildCorrectionCases,
  candidateVersionIdOf,
  correctionCaseExpectation,
  diffLines,
  extractCaseArray,
  extractSkillMdReply,
  findRegressions,
  majorityPass,
  parseComparatorReply,
  parseGraderReply,
  renderSkillImprovementDiff,
  skillEmbedText,
  stagedWriteIdOf,
  summarizeBenchmark,
  type CaseRunResult,
  type SkillTestCase,
  type SkillWorkItem
} from '../../src/main/agents'
import { SKILL_HOLDOUT_FRACTION, SKILL_MAX_CORRECTION_CASES, SKILL_SYNTHETIC_CASES } from '../../src/main/config'

const workItem = (corrections: readonly { id: string; content: string }[]): SkillWorkItem => ({
  skillId: 's-x',
  skillName: 'sample skill',
  activeInstructions: 'do the thing',
  activeVersionId: null,
  mode: 'verifiable',
  autoRevert: false,
  corrections: corrections.map((c) => ({ ...c, createdAt: null, isNew: true })),
  failureExamples: []
})

const caseOf = (
  id: string,
  source: 'correction' | 'synthetic',
  split: 'train' | 'heldout',
  correctionId: string | null = null
): SkillTestCase => ({
  id,
  source,
  correctionId,
  prompt: 'p',
  expectations: ['e'],
  split
})

const runOf = (caseId: string, config: 'candidate' | 'active', runIndex: number, passRate: number): CaseRunResult => ({
  caseId,
  config,
  runIndex,
  output: 'o',
  graded: [{ expectation: 'e', passed: passRate === 1, evidence: '' }],
  passRate
})

describe('test-set building + split (skill-creator split semantics)', () => {
  it('correction cases are id-linked, capped, and carry the correction in the expectation', () => {
    const many = Array.from({ length: SKILL_MAX_CORRECTION_CASES + 3 }, (_, i) => ({
      id: `corr-${i}`,
      content: `rule number ${i}`
    }))
    const cases = buildCorrectionCases(workItem(many))
    expect(cases).toHaveLength(SKILL_MAX_CORRECTION_CASES)
    expect(cases[0]?.correctionId).toBe('corr-0')
    expect(cases[0]?.expectations[0]).toBe(correctionCaseExpectation('rule number 0'))
    // The prompt is deliberately neutral: quoting the correction there would
    // hand the answer to both configurations.
    expect(cases[0]?.prompt).not.toContain('rule number 0')
  })

  it('splits are stratified per source, deterministic per skill id, ≥1 held-out per group', () => {
    const pool = [
      ...Array.from({ length: 5 }, (_, i) => ({ ...caseOf(`c${i}`, 'correction', 'train', `corr-${i}`) })),
      ...Array.from({ length: 3 }, (_, i) => ({ ...caseOf(`s${i}`, 'synthetic', 'train') }))
    ].map(({ split: _split, ...rest }) => rest)
    const first = assignSplits(pool, 'skill-a')
    const second = assignSplits(pool, 'skill-a')
    expect(first).toEqual(second) // same seed key → same split (resume-stable)
    const heldoutCorr = first.filter((c) => c.split === 'heldout' && c.source === 'correction')
    const heldoutSyn = first.filter((c) => c.split === 'heldout' && c.source === 'synthetic')
    expect(heldoutCorr).toHaveLength(Math.max(1, Math.floor(5 * SKILL_HOLDOUT_FRACTION)))
    expect(heldoutSyn).toHaveLength(Math.max(1, Math.floor(3 * SKILL_HOLDOUT_FRACTION)))
    const other = assignSplits(pool, 'skill-b')
    expect(other.some((c, i) => c.split !== first[i]?.split)).toBe(true) // different skill → different shuffle
  })

  it('a single case still yields a held-out case (score has something to read)', () => {
    const [only] = assignSplits([{ ...caseOf('c0', 'correction', 'train', 'corr-0') }].map(({ split: _s, ...r }) => r), 's')
    expect(only?.split).toBe('heldout')
  })

  it('extractCaseArray rescues a JSON array from narration and drops malformed items', () => {
    const reply =
      'Sure! Here are the cases:\n[{"prompt": "Do X with [brackets] inside", "expectations": ["has X"]},' +
      ' {"prompt": "", "expectations": ["dropped"]}, {"prompt": "No expectations"},' +
      ' {"prompt": "Do Y", "expectations": ["has Y", "mentions \\"quoted\\" text", "third dropped by cap"]}]\nHope that helps.'
    const cases = extractCaseArray(reply)
    expect(cases).toHaveLength(2)
    expect(cases[0]?.prompt).toBe('Do X with [brackets] inside')
    expect(cases[1]?.expectations).toHaveLength(2) // capped at 2 per case
    expect(extractCaseArray('no json here')).toEqual([])
    expect(extractCaseArray('[{"broken": ')).toEqual([])
    expect(extractCaseArray(`[${'{"prompt":"p","expectations":["e"]},'.repeat(9)}{"prompt":"p","expectations":["e"]}]`)).toHaveLength(
      SKILL_SYNTHETIC_CASES
    )
  })
})

describe('grader/comparator reply parsing (fail-safe)', () => {
  it('parses clean grader JSON and rescues a malformed reply by its passed field', () => {
    expect(parseGraderReply('{"passed": true, "evidence": "line 3"}')).toEqual({ passed: true, evidence: 'line 3' })
    expect(parseGraderReply('verdict — {"passed": false} trailing').passed).toBe(false)
  })

  it('an unparseable grader reply FAILS the expectation (burden of proof)', () => {
    const verdict = parseGraderReply('I think it looks fine overall.')
    expect(verdict.passed).toBe(false)
    expect(verdict.evidence).toContain('unparseable')
  })

  it('parses comparator verdicts incl. bare-letter rescue; nonsense → null', () => {
    expect(parseComparatorReply('{"winner": "B", "reasoning": "clearer"}').winner).toBe('B')
    expect(parseComparatorReply('Winner: A').winner).toBe('A')
    expect(parseComparatorReply('they are identical, tie').winner).toBe('TIE')
    expect(parseComparatorReply('…').winner).toBeNull()
  })

  it('extractSkillMdReply strips code fences and preamble before the frontmatter', () => {
    const md = '---\nname: x\ndescription: d\n---\nbody'
    expect(extractSkillMdReply('```markdown\n' + md + '\n```')).toBe(md)
    expect(extractSkillMdReply('Here is the rewrite:\n' + md)).toBe(md)
    expect(extractSkillMdReply(md)).toBe(md)
  })
})

describe('adoption math (§17: net-positive AND zero regression, majority-of-runs)', () => {
  it('majorityPass needs a STRICT majority', () => {
    expect(majorityPass(2, 3)).toBe(true)
    expect(majorityPass(1, 3)).toBe(false)
    expect(majorityPass(1, 2)).toBe(false) // even split is not a majority
    expect(majorityPass(2, 2)).toBe(true)
  })

  it('findRegressions flags exactly: active majority-passes AND candidate majority-fails, correction cases only', () => {
    const cases = [caseOf('cr', 'correction', 'train', 'corr-1'), caseOf('sy', 'synthetic', 'train')]
    const runs = [
      // corr case: active 3/3 pass, candidate 1/3 → regression
      ...[0, 1, 2].map((i) => runOf('cr', 'active', i, 1)),
      runOf('cr', 'candidate', 0, 1),
      runOf('cr', 'candidate', 1, 0),
      runOf('cr', 'candidate', 2, 0),
      // synthetic case with the same shape must NOT count as a regression
      ...[0, 1, 2].map((i) => runOf('sy', 'active', i, 1)),
      ...[0, 1, 2].map((i) => runOf('sy', 'candidate', i, 0))
    ]
    const regressions = findRegressions(cases, runs)
    expect(regressions).toHaveLength(1)
    expect(regressions[0]).toMatchObject({ caseId: 'cr', correctionId: 'corr-1', activePassRuns: 3, candidatePassRuns: 1 })
  })

  it('a case the active also fails is NOT a regression (it was never fixed)', () => {
    const cases = [caseOf('cr', 'correction', 'train', 'corr-1')]
    const runs = [...[0, 1, 2].map((i) => runOf('cr', 'active', i, 0)), ...[0, 1, 2].map((i) => runOf('cr', 'candidate', i, 0))]
    expect(findRegressions(cases, runs)).toHaveLength(0)
  })

  it('verifiable summary: net-positive is STRICTLY greater on held-out; ties reject', () => {
    const cases = [caseOf('h', 'correction', 'heldout', 'corr-1')]
    const equal = summarizeBenchmark(
      'verifiable',
      cases,
      [...[0, 1, 2].map((i) => runOf('h', 'active', i, 1)), ...[0, 1, 2].map((i) => runOf('h', 'candidate', i, 1))],
      [],
      []
    )
    expect(equal.heldoutScore).toEqual({ candidate: 1, active: 1 })
    expect(equal.netPositive).toBe(false)
    expect(equal.notes.join(' ')).toContain('not net-positive')

    const better = summarizeBenchmark(
      'verifiable',
      cases,
      [...[0, 1, 2].map((i) => runOf('h', 'active', i, 0)), ...[0, 1, 2].map((i) => runOf('h', 'candidate', i, 1))],
      [],
      []
    )
    expect(better.netPositive).toBe(true)
    expect(better.zeroRegression).toBe(true)
  })

  it('stylistic summary tallies held-out comparisons; assertions play no gating role', () => {
    const cases = [caseOf('h', 'synthetic', 'heldout')]
    const summary = summarizeBenchmark('stylistic', cases, [], [
      { caseId: 'h', runIndex: 0, winner: 'candidate', reasoning: '' },
      { caseId: 'h', runIndex: 1, winner: 'candidate', reasoning: '' },
      { caseId: 'h', runIndex: 2, winner: 'active', reasoning: '' }
    ], [])
    expect(summary.comparisons).toEqual({ candidateWins: 2, activeWins: 1, ties: 0 })
    expect(summary.netPositive).toBe(true)
    expect(summary.heldoutScore).toBeNull()
    expect(summary.notes.join(' ')).toContain('review-queue approval is the adoption gate')
  })
})

describe('lifecycle helpers', () => {
  it('candidate version ids derive from content (same text ⇒ same identity)', () => {
    expect(candidateVersionIdOf('s-a', 'text')).toBe(candidateVersionIdOf('s-a', 'text'))
    expect(candidateVersionIdOf('s-a', 'text')).not.toBe(candidateVersionIdOf('s-a', 'other'))
    expect(candidateVersionIdOf('s-a', 'text')).toMatch(/^sv-s-a-[0-9a-f]{8}$/)
    expect(stagedWriteIdOf('sv-s-a-abc')).toBe('sw-skill-sv-s-a-abc')
  })

  it('skillEmbedText matches the retrieval render (name: instructions)', () => {
    expect(skillEmbedText('deploy', 'do it safely')).toBe('deploy: do it safely')
    expect(skillEmbedText('deploy', '')).toBe('deploy')
  })

  it('diffLines marks changed lines only; the review diff carries the benchmark', () => {
    expect(diffLines('a\nb\nc', 'a\nx\nc')).toEqual(['  a', '- b', '+ x', '  c'])
    const rendered = renderSkillImprovementDiff({
      skillId: 's-x',
      skillName: 'sample',
      mode: 'stylistic',
      candidateVersionId: 'sv-x-1',
      predecessorVersionId: null,
      candidateInstructions: 'a\nx\nc',
      activeInstructions: 'a\nb\nc',
      benchmark: { comparisons: { candidateWins: 4, activeWins: 1, ties: 1 } },
      reason: 'stylistic — human approval'
    })
    expect(rendered).toContain('ADOPT SkillVersion sv-x-1')
    expect(rendered).toContain('candidate wins 4, active wins 1, ties 1')
    expect(rendered).toContain('- b')
    expect(rendered).toContain('+ x')
    expect(rendered).toContain('first adoption')
  })
})
