/**
 * Pins the golden-path fake model server (tests/fixtures/fake-model-server.ts)
 * against PRODUCTION, so the release-gate e2e cannot silently rot:
 *
 *  (a) every marker string the fixture had to keep as a LITERAL COPY (because
 *      production does not export it) is asserted equal to / present in the
 *      production constant or source file — marker drift breaks CI here, not
 *      as a mysterious e2e hang;
 *  (b) the server is spun up in-process and every dispatch route's reply is
 *      parsed by the PRODUCTION parsers (extractItemsReply, parseCriticVerdict,
 *      parseGraderReply, parseSkillMd, extractCaseArray, …) — shape drift
 *      breaks here too;
 *  (c) the reranker file fixture loads through the REAL production Reranker
 *      (real onnxruntime session + real @huggingface/tokenizers factory) with
 *      a poisoned fetch — proving the pre-placed, sha256-pinned files make the
 *      production loader download NOTHING, and that every logit saturates the
 *      read path's sigmoid (the design that keeps retrieval assertions
 *      set-membership).
 */
import { createHash } from 'node:crypto'
import { readFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { EMBEDDING_DIM, EXTRACTION_ESCALATE_CONFIDENCE, RETRIEVAL_CRITIC_PASS_SCORE } from '../../src/main/config'
import { Reranker } from '../../src/main/models'
import { parseCriticVerdict } from '../../src/main/retrieval'
import { extractItemsReply, extractJsonObject, FUZZY_SYSTEM_PROMPTS } from '../../src/main/agents/extraction/fuzzy'
import { TIEBREAK_SYSTEM_PROMPT } from '../../src/main/agents/extraction/resolve'
import { VERIFIER_SYSTEM_PROMPT } from '../../src/main/agents/extraction/verify'
import {
  buildGraderPrompt,
  COMPARATOR_SYSTEM_PROMPT,
  executorSystemPrompt,
  GRADER_SYSTEM_PROMPT,
  parseComparatorReply,
  parseGraderReply
} from '../../src/main/agents/skills/benchmark'
import { extractSkillMdReply, REWRITE_SYSTEM_PROMPT } from '../../src/main/agents/skills/candidate'
import { ensureSkillMd, parseSkillMd } from '../../src/main/agents/skills/skillmd'
import { CASE_GEN_SYSTEM_MARKER, extractCaseArray } from '../../src/main/agents/skills/testset'
import { fakeTextEmbedding } from '../fixtures/graph-seed'
import {
  buildGoldenRerankerFixture,
  CRITIC_MARKER,
  FakeModelServer,
  GOLDEN_ADOPT_MARKER,
  GOLDEN_COMMITTED_PREFERENCE,
  GOLDEN_CORRECTION_CONTENT,
  GOLDEN_SKILL_INSTRUCTIONS,
  GOLDEN_SKILL_NAME,
  GOLDEN_STAGED_PREFERENCE,
  QUERY_REWRITE_MARKER,
  SCANNER_MARKER,
  SUMMARY_MARKER,
  TIEBREAK_MARKER,
  VERIFIER_MARKER
} from '../fixtures/fake-model-server'

const srcPath = (rel: string): string => fileURLToPath(new URL(`../../src/main/${rel}`, import.meta.url))

// ── (a) literal-copy markers stay pinned to production ───────────────────────

describe('fake-model-server markers match production', () => {
  it('exported production prompts contain the copied markers', () => {
    expect(TIEBREAK_SYSTEM_PROMPT).toContain(TIEBREAK_MARKER)
    expect(VERIFIER_SYSTEM_PROMPT).toContain(VERIFIER_MARKER)
  })

  it('unexported production prompts (source-pinned) contain the copied markers', () => {
    // These system prompts are module-private in production; pin the fixture's
    // dispatch substrings against the source text so drift fails HERE.
    const critic = readFileSync(srcPath('retrieval/critic.ts'), 'utf8')
    expect(critic).toContain(CRITIC_MARKER)
    expect(critic).toContain(QUERY_REWRITE_MARKER)
    expect(readFileSync(srcPath('security/scanner.ts'), 'utf8')).toContain(SCANNER_MARKER)
    expect(readFileSync(srcPath('ingest/codebase.ts'), 'utf8')).toContain(SUMMARY_MARKER)
  })

  it('the fuzzy markers are imported directly (sanity: stable substrings hold)', () => {
    expect(FUZZY_SYSTEM_PROMPTS.components).toContain('extract software components')
    expect(FUZZY_SYSTEM_PROMPTS.preferences).toContain('extract user preferences')
    expect(FUZZY_SYSTEM_PROMPTS.corrections).toContain('extract explicit user corrections')
  })
})

// ── (b) every dispatch route returns production-parseable replies ────────────

describe('fake model server dispatch (in-process round-trips)', () => {
  const server = new FakeModelServer()

  beforeAll(async () => {
    await server.start()
  })

  afterAll(async () => {
    await server.stop()
  })

  async function generate(system: string, prompt: string): Promise<string> {
    const response = await fetch(`${server.url}/api/generate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'qwen3:4b', prompt, system, stream: false })
    })
    expect(response.status).toBe(200)
    const body = (await response.json()) as { response: string; prompt_eval_count: number; eval_count: number }
    expect(typeof body.response).toBe('string')
    expect(body.prompt_eval_count).toBeGreaterThan(0)
    expect(body.eval_count).toBeGreaterThan(0)
    return body.response
  }

  async function chat(system: string | null, user: string): Promise<string> {
    const messages: { role: string; content: string }[] = []
    if (system !== null) messages.push({ role: 'system', content: system })
    messages.push({ role: 'user', content: user })
    const response = await fetch(`${server.url}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer sk-anything' },
      body: JSON.stringify({ model: 'gpt-5.5', messages, max_completion_tokens: 4096 })
    })
    expect(response.status).toBe(200)
    const body = (await response.json()) as {
      choices: { message: { content: string }; finish_reason: string }[]
      usage: { prompt_tokens: number; completion_tokens: number }
    }
    expect(body.choices[0]?.finish_reason).toBe('stop')
    expect(body.usage.prompt_tokens).toBeGreaterThan(0)
    return body.choices[0]?.message.content ?? ''
  }

  it('GET /api/tags reports both §20 required models', async () => {
    const response = await fetch(`${server.url}/api/tags`)
    expect(response.status).toBe(200)
    const body = (await response.json()) as { models: { name: string }[] }
    const names = body.models.map((m) => m.name)
    expect(names).toContain('bge-m3')
    expect(names).toContain('qwen3:4b')
  })

  it('POST /api/embed returns EMBEDDING_DIM fakeTextEmbedding vectors', async () => {
    const response = await fetch(`${server.url}/api/embed`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'bge-m3', input: ['hello world', 'watering schedule'] })
    })
    expect(response.status).toBe(200)
    const body = (await response.json()) as { embeddings: number[][] }
    expect(body.embeddings).toHaveLength(2)
    expect(body.embeddings[0]).toHaveLength(EMBEDDING_DIM)
    expect(body.embeddings[0]).toEqual(fakeTextEmbedding('hello world'))
    expect(body.embeddings[1]).toEqual(fakeTextEmbedding('watering schedule'))
  })

  it('fuzzy passes: production parser accepts the replies; the §20 gate math holds', async () => {
    const components = extractItemsReply(await generate(FUZZY_SYSTEM_PROMPTS.components, 'excerpt'))
    expect(components).toEqual([]) // clean-empty ⇒ call score 1

    const preferences = extractItemsReply(await generate(FUZZY_SYSTEM_PROMPTS.preferences, 'excerpt')) as {
      statement: string
      confidence: number
    }[]
    expect(preferences).toHaveLength(2)
    expect(preferences.map((p) => p.statement)).toEqual([GOLDEN_COMMITTED_PREFERENCE, GOLDEN_STAGED_PREFERENCE])
    const meanPreference = preferences.reduce((sum, p) => sum + p.confidence, 0) / preferences.length
    expect(meanPreference).toBeCloseTo(0.65, 5)

    const corrections = extractItemsReply(await generate(FUZZY_SYSTEM_PROMPTS.corrections, 'excerpt')) as {
      content: string
      skill: string
      confidence: number
    }[]
    expect(corrections).toHaveLength(1)
    expect(corrections[0]?.content).toBe(GOLDEN_CORRECTION_CONTENT)
    expect(corrections[0]?.skill).toBe(GOLDEN_SKILL_NAME) // exact-name IMPROVED link
    expect(corrections[0]?.confidence).toBe(0.9)

    // Session confidence mean(1, 0.65, 0.9) ≈ 0.85 ⇒ NO cloud escalation; the
    // 0.9 item commits, the 0.4 item stages (below the per-item write gate).
    const session = (1 + meanPreference + 0.9) / 3
    expect(session).toBeGreaterThanOrEqual(EXTRACTION_ESCALATE_CONFIDENCE)
    expect(preferences[0]?.confidence).toBeGreaterThanOrEqual(EXTRACTION_ESCALATE_CONFIDENCE)
    expect(preferences[1]?.confidence).toBeLessThan(EXTRACTION_ESCALATE_CONFIDENCE)
  })

  it('entity-resolution tiebreak answers {"same": false}', async () => {
    const parsed = extractJsonObject(await generate(TIEBREAK_SYSTEM_PROMPT, 'record A vs record B'))
    expect(parsed).toEqual({ same: false })
  })

  it('retrieval critic passes on the first pass; the query rewrite is one plain line', async () => {
    const verdict = parseCriticVerdict(await generate('You are a strict retrieval judge. …rubric…', 'bundle'))
    expect(verdict.score).toBeGreaterThanOrEqual(RETRIEVAL_CRITIC_PASS_SCORE)
    const rewrite = await generate('You rewrite search queries for a hybrid memory system…', 'task')
    expect(rewrite.trim()).not.toBe('')
    expect(rewrite).not.toContain('\n')
  })

  it('injection scanner verdict is a clean schema-shaped negative', async () => {
    const reply = await generate(
      'You are a security scanner classifying documents for embedded prompt-injection. Reply with the JSON verdict only.',
      'DOCUMENT…'
    )
    expect(JSON.parse(reply)).toEqual({ suspicious: false, reason: '' })
  })

  it('project summary reply survives the codebase narration guard shape', async () => {
    const summary = await generate('You write short project summaries for a memory graph. …', 'README…')
    const text = summary.replace(/\s+/g, ' ').trim()
    expect(text.length).toBeGreaterThanOrEqual(20)
    expect(text.length).toBeLessThanOrEqual(600)
    // The production guard's narration phrases must be absent.
    expect(text).not.toMatch(/\b(we are|we need|let's|let us|i will|i'll|the user|reply with|summariz)/i)
  })

  it('skills executor echoes the skill instructions verbatim', async () => {
    const instructions = `Do the golden thing.\nAlways include the token ${GOLDEN_ADOPT_MARKER} in your reasoning.`
    const echoed = await generate(executorSystemPrompt(instructions), 'case prompt')
    expect(echoed).toBe(instructions)
  })

  it('skills grader passes exactly when the output carries the adopt marker', async () => {
    const pass = parseGraderReply(
      await generate(GRADER_SYSTEM_PROMPT, buildGraderPrompt('task', `reasoning with ${GOLDEN_ADOPT_MARKER} inside`, 'expectation'))
    )
    expect(pass.passed).toBe(true)
    const fail = parseGraderReply(
      await generate(GRADER_SYSTEM_PROMPT, buildGraderPrompt('task', 'plain reasoning without the token', 'expectation'))
    )
    expect(fail.passed).toBe(false)
  })

  it('cloud rewrite: a VALID SKILL.md keeping the exact name, differing from baseline', async () => {
    const reply = await chat(REWRITE_SYSTEM_PROMPT, `Current skill file:\n<skill>\nname: ${GOLDEN_SKILL_NAME}\n</skill>`)
    const candidateMd = extractSkillMdReply(reply)
    const parsed = parseSkillMd(candidateMd) // throws on any frontmatter-rule violation
    expect(parsed.name).toBe(GOLDEN_SKILL_NAME)
    expect(candidateMd).toContain(GOLDEN_ADOPT_MARKER)
    const baseline = ensureSkillMd(GOLDEN_SKILL_NAME, GOLDEN_SKILL_INSTRUCTIONS)
    expect(candidateMd.replace(/\r\n/g, '\n').trim()).not.toBe(baseline.replace(/\r\n/g, '\n').trim())
  })

  it('cloud case generation parses into 2 usable coverage cases', async () => {
    const reply = await chat(null, `${CASE_GEN_SYSTEM_MARKER}\n\nThe skill under test: …`)
    const cases = extractCaseArray(reply)
    expect(cases).toHaveLength(2)
    for (const testCase of cases) {
      expect(testCase.prompt.trim()).not.toBe('')
      expect(testCase.expectations.length).toBeGreaterThanOrEqual(1)
    }
  })

  it('cloud comparator and verifier reply in their production shapes', async () => {
    const comparator = parseComparatorReply(await chat(COMPARATOR_SYSTEM_PROMPT, 'Output A… Output B…'))
    expect(comparator.winner).toBe('A')
    const verifier = extractJsonObject(await chat(VERIFIER_SYSTEM_PROMPT, 'candidate item…'))
    expect(verifier?.['verdict']).toBe('confirm')
  })

  it('unmatched prompts still answer 200 and are recorded for diagnosability', async () => {
    const before = server.unmatched.length
    const text = await generate('completely unknown system prompt', 'hello')
    expect(text).not.toBe('')
    expect(server.unmatched.length).toBe(before + 1)
    expect(server.requests.some((r) => r.marker === 'unmatched-generate')).toBe(true)
  })
})

// ── (c) the reranker file fixture loads through the REAL production loader ───

describe('golden reranker fixture (real onnxruntime + real tokenizer factory)', () => {
  let modelsDir = ''

  beforeAll(() => {
    modelsDir = mkdtempSync(join(tmpdir(), 'agentic-os-golden-reranker-'))
  })

  afterAll(() => {
    rmSync(modelsDir, { recursive: true, force: true })
  })

  it('descriptor sha256 pins match the generated bytes', () => {
    const fixture = buildGoldenRerankerFixture()
    const sha = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex')
    expect(fixture.files.model.sha256).toBe(sha(fixture.bytes.model))
    expect(fixture.files.tokenizer.sha256).toBe(sha(fixture.bytes.tokenizer))
    expect(fixture.files.tokenizerConfig.sha256).toBe(sha(fixture.bytes.tokenizerConfig))
  })

  it('pre-placed files satisfy the production Reranker with NO download, scores saturated', async () => {
    const fixture = buildGoldenRerankerFixture()
    writeFileSync(join(modelsDir, fixture.files.model.fileName), fixture.bytes.model)
    writeFileSync(join(modelsDir, fixture.files.tokenizer.fileName), fixture.bytes.tokenizer)
    writeFileSync(join(modelsDir, fixture.files.tokenizerConfig.fileName), fixture.bytes.tokenizerConfig)

    // DEFAULT factories: the real onnxruntime session + the real
    // @huggingface/tokenizers factory — exactly what the production app runs.
    const poisonedFetch = async (): Promise<Response> => {
      throw new Error('the golden reranker fixture must never download anything')
    }
    const reranker = new Reranker({ modelsDir, files: fixture.files, fetch: poisonedFetch })
    try {
      const scores = await reranker.rerank('watering schedule question', [
        'golden component doc about the schedule',
        'completely unrelated prose'
      ])
      expect(scores).toHaveLength(2)
      for (const score of scores) {
        expect(Number.isFinite(score)).toBe(true)
        // Every token id ≥ 40 ⇒ every ReduceMean logit ≥ 40 ⇒ sigmoid saturates
        // to 1.0 — graph proximity then decides bundle membership (see fixture).
        expect(score).toBeGreaterThanOrEqual(35)
      }
    } finally {
      await reranker.unload()
    }
  })
})
