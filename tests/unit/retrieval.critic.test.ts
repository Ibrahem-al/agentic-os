/**
 * Critic + rewriter unit tests (§15: separate prompts, local tier). Covers
 * verdict parsing (clean JSON → salvage → graceful zero), prompt contents,
 * and rewrite hygiene (single line, quote stripping, no repeats).
 */
import { describe, expect, it } from 'vitest'
import { parseCriticVerdict, rewriteQuery, scoreBundle } from '../../src/main/retrieval'
import type { AssembledBundle, SmallLlm } from '../../src/main/retrieval'

function stubLlm(reply: string): SmallLlm & { prompts: string[]; systems: string[] } {
  const prompts: string[] = []
  const systems: string[] = []
  return {
    prompts,
    systems,
    async generate(prompt, options) {
      prompts.push(prompt)
      systems.push(options?.system ?? '')
      return { text: reply }
    }
  }
}

const bundle: AssembledBundle = {
  query: 'deploy the storefront',
  items: [
    {
      id: 's-deploy',
      label: 'Skill',
      text: 'deploy storefront: build and publish to vercel',
      tokens: 12,
      fusedScore: 0.6,
      rerankScore: 3.2,
      signals: { vector: 0.8, keyword: 0.5, graph: 0.5 }
    }
  ],
  globalPreferences: [
    {
      id: 'pref-global-tests',
      label: 'Preference',
      text: 'always run the full test suite before declaring any work finished',
      tokens: 16,
      fusedScore: 0,
      rerankScore: null,
      signals: { vector: 0, keyword: 0, graph: 0 }
    }
  ],
  totalTokens: 28,
  candidateCount: 9
}

describe('parseCriticVerdict', () => {
  it('parses a clean JSON verdict and normalizes to 0..1', () => {
    expect(parseCriticVerdict('{"score": 7, "missing": "no project context"}')).toEqual({
      score: 0.7,
      feedback: 'no project context'
    })
  })

  it('parses JSON embedded in prose', () => {
    const verdict = parseCriticVerdict('Sure! Here is my judgement: {"score": 4, "missing": "none"} Hope that helps.')
    expect(verdict.score).toBeCloseTo(0.4, 10)
  })

  it('clamps out-of-range scores', () => {
    expect(parseCriticVerdict('{"score": 15, "missing": ""}').score).toBe(1)
    expect(parseCriticVerdict('{"score": -3, "missing": ""}').score).toBe(0)
  })

  it('salvages a bare number when the JSON is broken', () => {
    expect(parseCriticVerdict('I would rate this 8 out of 10').score).toBeCloseTo(0.8, 10)
  })

  it('degrades to zero on an unusable reply instead of throwing', () => {
    const verdict = parseCriticVerdict('no idea what you want from me')
    expect(verdict.score).toBe(0)
    expect(verdict.feedback).toMatch(/unparseable/)
  })
})

describe('scoreBundle', () => {
  it('prompts the LOCAL critic with the task, the rubric and every bundle item', async () => {
    const llm = stubLlm('{"score": 9, "missing": "none"}')
    const verdict = await scoreBundle(llm, 'deploy the aurora storefront', bundle)
    expect(verdict).toEqual({ score: 0.9, feedback: 'none' })
    expect(llm.prompts[0]).toContain('deploy the aurora storefront')
    expect(llm.prompts[0]).toContain('deploy storefront: build and publish to vercel')
    expect(llm.prompts[0]).toContain('always run the full test suite')
    // The ScriptedLlm test fake discriminates calls by these system prompts.
    expect(llm.systems[0]).toContain('retrieval judge')
    expect(llm.systems[0]).toMatch(/relevance|coverage|specificity/)
  })

  it('tells the critic when the bundle is empty', async () => {
    const llm = stubLlm('{"score": 0, "missing": "everything"}')
    await scoreBundle(llm, 'anything', { ...bundle, items: [], globalPreferences: [] })
    expect(llm.prompts[0]).toContain('bundle is empty')
  })
})

describe('rewriteQuery', () => {
  it('returns the first useful line, stripped of quotes', async () => {
    const llm = stubLlm('\n  "postgres autovacuum warehouse tuning"  \nBecause the last query was vague.')
    const next = await rewriteQuery(llm, 'tune the database', 'no postgres facts', ['tune the database'])
    expect(next).toBe('postgres autovacuum warehouse tuning')
    expect(llm.prompts[0]).toContain('tune the database')
    expect(llm.prompts[0]).toContain('no postgres facts')
    expect(llm.systems[0]).toContain('rewrite search queries')
  })

  it('lists every previously tried query in the prompt', async () => {
    const llm = stubLlm('brand new query')
    await rewriteQuery(llm, 'task', '', ['first try', 'second try'])
    expect(llm.prompts[0]).toContain('- first try')
    expect(llm.prompts[0]).toContain('- second try')
  })

  it('returns null when the rewrite repeats a tried query (case-insensitive)', async () => {
    const llm = stubLlm('  First TRY ')
    expect(await rewriteQuery(llm, 'task', '', ['first try'])).toBeNull()
  })

  it('returns null when the rewrite is empty', async () => {
    const llm = stubLlm('   \n  ')
    expect(await rewriteQuery(llm, 'task', '', ['first try'])).toBeNull()
  })
})
