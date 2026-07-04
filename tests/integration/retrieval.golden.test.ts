/**
 * DoD golden tests: 5 queries against the fixture graph return the expected
 * node ids in the bundle (order-insensitive within the top-8), global-tag
 * preferences appear in EVERY bundle, and the whole path performs zero writes.
 *
 * Offline by construction: deterministic fake embedder (same bag-of-words
 * hash the fixture was seeded with), lexical-overlap fake reranker, and an
 * always-passing critic so each retrieve() is exactly one read-path pass.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  RETRIEVAL_BUNDLE_TOP_N,
  RETRIEVAL_RECENT_EXAMPLES
} from '../../src/main/config'
import { createRetriever, type ContextBundle, type Retriever, type SmallLlm } from '../../src/main/retrieval'
import { expandGraph } from '../../src/main/retrieval/expand'
import { mergeCandidate, type Candidate } from '../../src/main/retrieval/fusion'
import { GLOBAL_PREFERENCE_IDS, seedFixtureGraph } from '../fixtures/graph-seed'
import { FakeEmbedder, FakeReranker } from '../fixtures/retrieval-fakes'
import { openTestStore, type TestStore } from './helpers'

let store: TestStore
let retriever: Retriever
let writesAfterSeeding = 0

/** Critic that always passes → retrieve() is a single read-path pass. */
const passingCritic: SmallLlm = {
  generate: async () => ({ text: '{"score": 10, "missing": "none"}' })
}

function bundleIds(bundle: ContextBundle): string[] {
  return [...bundle.items, ...bundle.globalPreferences].map((i) => i.id)
}

beforeAll(async () => {
  store = await openTestStore()
  await seedFixtureGraph(store.engine)
  writesAfterSeeding = store.engine.lane.enqueuedCount
  retriever = createRetriever({
    engine: store.engine,
    embedder: new FakeEmbedder(),
    reranker: new FakeReranker(),
    llm: passingCritic
  })
})
afterAll(async () => {
  await store.cleanup()
})

interface GoldenCase {
  name: string
  task: string
  tags?: string[]
  expectedIds: string[]
}

const GOLDEN: GoldenCase[] = [
  {
    name: 'deploy task → deploy skill, project, deployment knowledge',
    task: 'deploy the aurora storefront to vercel and verify the checkout flow',
    expectedIds: ['s-deploy', 'p-aurora', 'k-vercel']
  },
  {
    name: 'database tuning task → knowledge chunk, project, migration skill',
    task: 'tune postgres autovacuum for the telemetry warehouse ingest spikes',
    expectedIds: ['k-vacuum', 'p-comet', 's-migrate']
  },
  {
    name: 'component question → project + graph-expanded component',
    task: 'which components make up the aurora storefront checkout pages',
    expectedIds: ['p-aurora', 'c-checkout']
  },
  {
    name: 'tagged retrieval → tag-scoped preferences surface',
    task: 'what naming convention applies to warehouse database tables',
    tags: ['database'],
    expectedIds: ['pref-naming', 'pref-backup']
  },
  {
    name: 'charts task → skill, knowledge, tag-derived preference',
    task: 'render accessible telemetry charts using the approved color palette',
    expectedIds: ['s-charts', 'k-palette', 'pref-palette']
  }
]

describe('golden retrieval bundles (DoD 1)', () => {
  for (const golden of GOLDEN) {
    it(golden.name, async () => {
      const bundle = await retriever.retrieve(golden.task, golden.tags ?? [])
      const ids = bundleIds(bundle)
      for (const expected of golden.expectedIds) {
        expect(ids, `expected ${expected} in bundle for "${golden.task}"`).toContain(expected)
      }
      expect(bundle.items.length).toBeLessThanOrEqual(RETRIEVAL_BUNDLE_TOP_N)
      expect(bundle.confidence).toBe('high')
      expect(bundle.iterations).toBe(1)
    })
  }
})

describe('global-tag preferences (DoD 2)', () => {
  it('appear in every bundle, including for an unrelated query', async () => {
    const tasks = [...GOLDEN.map((g) => g.task), 'entirely unrelated interstellar zeppelin voyage']
    for (const task of tasks) {
      const bundle = await retriever.retrieve(task)
      const prefIds = bundle.globalPreferences.map((p) => p.id)
      for (const globalId of GLOBAL_PREFERENCE_IDS) {
        expect(prefIds, `global preference ${globalId} missing for "${task}"`).toContain(globalId)
      }
      // They ride the dedicated section, not the top-8 item slots.
      for (const item of bundle.items) {
        expect(GLOBAL_PREFERENCE_IDS).not.toContain(item.id)
      }
    }
  })
})

describe('graph expansion (§18 read path step 2)', () => {
  it('surfaces structural nodes unreachable by vector/FTS (MCP, SkillVersion)', async () => {
    const bundle = await retriever.retrieve(
      'deploy the aurora storefront to vercel and verify the checkout flow'
    )
    const ids = bundleIds(bundle)
    // sv-deploy-active has no embedding and no FTS row — only expansion
    // (seed skill → active version) can have produced it.
    expect(ids).toContain('sv-deploy-active')
    const labels = new Map(bundle.items.map((i) => [i.id, i.label]))
    expect(labels.get('sv-deploy-active')).toBe('SkillVersion')
  })

  it('expands only the ACTIVE skill version and caps recent examples', async () => {
    const candidates = new Map<string, Candidate>()
    mergeCandidate(candidates, { label: 'Skill', id: 's-deploy' })
    const outcome = await expandGraph(store.engine, candidates, [])
    const keys = [...candidates.keys()]
    expect(keys).toContain('SkillVersion:sv-deploy-active')
    expect(keys).not.toContain('SkillVersion:sv-deploy-retired')
    const examples = keys.filter((k) => k.startsWith('Example:'))
    expect(examples.length).toBe(RETRIEVAL_RECENT_EXAMPLES) // s-deploy has 4 examples
    expect(outcome.globalPreferenceIds).toEqual([...GLOBAL_PREFERENCE_IDS].sort())
  })

  it('project seeds pull skills, MCPs, plugins and components at hop 1', async () => {
    const candidates = new Map<string, Candidate>()
    mergeCandidate(candidates, { label: 'Project', id: 'p-aurora', vectorDistance: 0.1 })
    await expandGraph(store.engine, candidates, [])
    const keys = new Set(candidates.keys())
    for (const expected of [
      'Skill:s-deploy',
      'Skill:s-review',
      'MCP:mcp-vercel',
      'MCP:mcp-github',
      'Plugin:plug-playwright',
      'Component:c-checkout',
      'Component:c-catalog',
      'Component:c-gateway'
    ]) {
      expect(keys).toContain(expected)
    }
    expect(candidates.get('MCP:mcp-vercel')?.graphHops).toBe(1)
    // Project-derived skills expand one hop further to their active version.
    expect(candidates.get('SkillVersion:sv-deploy-active')?.graphHops).toBe(2)
    // The seed keeps its own signals; it is not its own graph neighbor.
    expect(candidates.get('Project:p-aurora')?.graphHops).toBeUndefined()
  })

  it('requested tags reach their preferences without any text match', async () => {
    const candidates = new Map<string, Candidate>()
    const outcome = await expandGraph(store.engine, candidates, ['charts'])
    expect([...candidates.keys()]).toContain('Preference:pref-palette')
    expect(candidates.get('Preference:pref-palette')?.graphHops).toBe(1)
    expect(outcome.matchedTagIds).toContain('tag-charts')
  })
})

describe('token budget (§18 read path step 3)', () => {
  it('trims reranked items to the budget; global preferences stay mandatory', async () => {
    const unbounded = await retriever.retrieve(
      'deploy the aurora storefront to vercel and verify the checkout flow'
    )
    expect(unbounded.items.length).toBeGreaterThan(2)

    const globalTokens = unbounded.globalPreferences.reduce((sum, p) => sum + p.tokens, 0)
    const firstItemTokens = unbounded.items[0]!.tokens
    const budget = globalTokens + firstItemTokens
    const trimmed = await retriever.retrieve(
      'deploy the aurora storefront to vercel and verify the checkout flow',
      [],
      { tokenBudget: budget }
    )
    expect(trimmed.globalPreferences.map((p) => p.id).sort()).toEqual([...GLOBAL_PREFERENCE_IDS].sort())
    expect(trimmed.items.length).toBeLessThan(unbounded.items.length)
    expect(trimmed.totalTokens).toBeLessThanOrEqual(budget)

    // Budget zero: items vanish, the mandatory global preferences never do.
    const zero = await retriever.retrieve('deploy the aurora storefront', [], { tokenBudget: 0 })
    expect(zero.items).toEqual([])
    expect(zero.globalPreferences.length).toBe(GLOBAL_PREFERENCE_IDS.length)
  })
})

describe('no writes anywhere in this path (phase doc "Do NOT")', () => {
  it('the write lane never sees a job during any retrieval', async () => {
    for (const golden of GOLDEN) {
      await retriever.retrieve(golden.task, golden.tags ?? [])
    }
    await retriever.singlePass('one more direct pass to be sure')
    expect(store.engine.lane.enqueuedCount).toBe(writesAfterSeeding)
  })
})
