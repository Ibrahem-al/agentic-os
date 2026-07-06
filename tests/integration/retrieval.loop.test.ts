/**
 * DoD loop tests (§15) over the fixture graph:
 *  - a deliberately bad first query improves by iteration ≤ 3;
 *  - an impossible query exits at 5 iterations with confidence: low;
 * plus stop-on-non-improvement, the per-iteration SpendMeter consult with
 * budget halt, and best-effort returns on mid-loop failures.
 *
 * The critic/rewriter is a scripted local-LLM fake, so verdicts are
 * deterministic; the retrieval passes underneath run for real against the
 * fixture graph.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { LOOP_MAX_ITERATIONS, RUNNER_MODEL_DEFAULT, SMALL_LLM_MODEL } from '../../src/main/config'
import { ProviderRouter, defaultModelSettings, type ProviderRouterDeps } from '../../src/main/models'
import { createRetriever, type BudgetGuard, type RetrieverDeps, type SmallLlm } from '../../src/main/retrieval'
import { seedFixtureGraph } from '../fixtures/graph-seed'
import { FakeEmbedder, FakeReranker, ScriptedLlm, type ScriptedLlmStep } from '../fixtures/retrieval-fakes'
import { openTestStore, type TestStore } from './helpers'

let store: TestStore

/** checkBudget throws from the `failFrom`-th consult onward (1-based). */
class CountingGuard implements BudgetGuard {
  calls = 0
  constructor(private readonly failFrom = Number.POSITIVE_INFINITY) {}
  checkBudget(): void {
    this.calls += 1
    if (this.calls >= this.failFrom) throw new Error('spend ceiling exceeded (simulated)')
  }
}

function retrieverWith(steps: ScriptedLlmStep[]): {
  retriever: ReturnType<typeof createRetriever>
  llm: ScriptedLlm
  embedder: FakeEmbedder
} {
  const llm = new ScriptedLlm(steps)
  const embedder = new FakeEmbedder()
  const deps: RetrieverDeps = { engine: store.engine, embedder, reranker: new FakeReranker(), llm }
  return { retriever: createRetriever(deps), llm, embedder }
}

const score = (n: number, missing = 'none'): string => `{"score": ${n}, "missing": "${missing}"}`

beforeAll(async () => {
  store = await openTestStore()
  await seedFixtureGraph(store.engine)
})
afterAll(async () => {
  await store.cleanup()
})

describe('self-correcting loop (§15, DoD 3)', () => {
  it('a deliberately bad first query improves by iteration ≤ 3', async () => {
    // "make the shop pages go live" shares almost no vocabulary with the
    // deploy world; the scripted rewrite supplies the query a competent local
    // LLM would produce, and the second pass must actually retrieve the goods.
    const rewritten = 'deploy the aurora storefront to vercel and verify the checkout flow'
    const { retriever, llm } = retrieverWith([
      { criticReply: score(2, 'no deployment skill or project context'), rewriteReply: rewritten },
      { criticReply: score(9) }
    ])
    const bundle = await retriever.retrieve('make the shop pages go live')

    expect(bundle.iterations).toBeLessThanOrEqual(3)
    expect(bundle.confidence).toBe('high')
    expect(bundle.haltReason).toBe('passed')
    expect(bundle.query).toBe(rewritten) // the improved pass won
    expect(bundle.queriesTried).toEqual(['make the shop pages go live', rewritten])
    const ids = [...bundle.items, ...bundle.globalPreferences].map((i) => i.id)
    expect(ids).toContain('s-deploy')
    expect(ids).toContain('p-aurora')
    expect(llm.criticCalls).toHaveLength(2)
    expect(llm.rewriteCalls).toHaveLength(1)
  })

  it('an impossible query exits at 5 iterations with confidence: low', async () => {
    // Strictly-increasing-but-failing scores keep the loop improving until the
    // §20 cap of 5; it must return its best effort flagged low.
    const steps: ScriptedLlmStep[] = [1, 2, 3, 4, 5].map((n, i) => ({
      criticReply: score(n, 'still nothing about flux capacitors'),
      rewriteReply: `flux capacitor blueprints attempt ${'abcde'[i]}`
    }))
    const { retriever, embedder } = retrieverWith(steps)
    const bundle = await retriever.retrieve('locate the quantum flux capacitor blueprints')

    expect(bundle.iterations).toBe(LOOP_MAX_ITERATIONS)
    expect(bundle.confidence).toBe('low')
    expect(bundle.haltReason).toBe('max-iterations')
    expect(bundle.criticScore).toBeCloseTo(0.5, 10)
    expect(bundle.queriesTried).toHaveLength(LOOP_MAX_ITERATIONS)
    expect(new Set(bundle.queriesTried).size).toBe(LOOP_MAX_ITERATIONS)
    expect(embedder.calls).toBe(LOOP_MAX_ITERATIONS) // one real pass per iteration
    // Global preferences survive even a hopeless bundle (DoD 2).
    expect(bundle.globalPreferences.length).toBeGreaterThan(0)
  })

  it('stops on non-improvement and keeps the better earlier bundle', async () => {
    const { retriever } = retrieverWith([
      { criticReply: score(5, 'missing warehouse specifics'), rewriteReply: 'a worse rewrite entirely' },
      { criticReply: score(4) } // worse than 5 → stop, keep iteration 1
    ])
    const task = 'tune postgres autovacuum for the telemetry warehouse ingest spikes'
    const bundle = await retriever.retrieve(task)

    expect(bundle.haltReason).toBe('non-improvement')
    expect(bundle.iterations).toBe(2)
    expect(bundle.confidence).toBe('low')
    expect(bundle.query).toBe(task) // best bundle = the first pass
    expect(bundle.criticScore).toBeCloseTo(0.5, 10)
  })

  it('an equal score counts as non-improvement', async () => {
    const { retriever } = retrieverWith([
      { criticReply: score(5), rewriteReply: 'another phrasing of the same idea' },
      { criticReply: score(5) }
    ])
    const bundle = await retriever.retrieve('render accessible telemetry charts')
    expect(bundle.haltReason).toBe('non-improvement')
    expect(bundle.iterations).toBe(2)
  })

  it('stops when the rewriter only repeats an already-tried query', async () => {
    const task = 'deploy the aurora storefront'
    const { retriever } = retrieverWith([{ criticReply: score(3), rewriteReply: task }])
    const bundle = await retriever.retrieve(task)
    expect(bundle.haltReason).toBe('non-improvement')
    expect(bundle.iterations).toBe(1)
    expect(bundle.confidence).toBe('low')
  })

  it('returns best-effort when the critic dies mid-loop', async () => {
    // Iteration 2's critic reply is not scripted → the fake throws, standing
    // in for a crashed Ollama daemon. The loop must keep iteration 1's bundle.
    const { retriever } = retrieverWith([
      { criticReply: score(3), rewriteReply: 'second attempt with different words' }
    ])
    const task = 'deploy the aurora storefront to vercel'
    const bundle = await retriever.retrieve(task)
    expect(bundle.haltReason).toBe('loop-error')
    expect(bundle.iterations).toBe(2)
    expect(bundle.confidence).toBe('low')
    expect(bundle.query).toBe(task)
    expect(bundle.items.length).toBeGreaterThan(0)
  })
})

describe('spend budget (§14/§15: consulted every iteration)', () => {
  it('is consulted once per iteration', async () => {
    const guard = new CountingGuard()
    const steps: ScriptedLlmStep[] = [
      { criticReply: score(1), rewriteReply: 'second query wording' },
      { criticReply: score(2), rewriteReply: 'third query wording' },
      { criticReply: score(3) }
    ]
    const { retriever } = retrieverWith(steps)
    const bundle = await retriever.retrieve('locate the quantum flux capacitor blueprints', [], {
      spendMeter: guard,
      taskId: 'task-consult',
      maxIterations: 3
    })
    expect(bundle.haltReason).toBe('max-iterations')
    expect(guard.calls).toBe(3)
  })

  it('halts before the first pass but still returns a best-effort bundle', async () => {
    const guard = new CountingGuard(1) // ceiling already blown elsewhere
    const { retriever, llm } = retrieverWith([]) // any critic call would throw
    const bundle = await retriever.retrieve('deploy the aurora storefront', [], {
      spendMeter: guard,
      taskId: 'task-broke'
    })
    expect(bundle.haltReason).toBe('budget-exceeded')
    expect(bundle.confidence).toBe('low')
    expect(bundle.iterations).toBe(1)
    expect(bundle.criticScore).toBeNull() // the critic never ran
    expect(bundle.items.length).toBeGreaterThan(0) // the free local pass still served
    expect(bundle.globalPreferences.length).toBeGreaterThan(0)
    expect(guard.calls).toBe(1)
    expect(llm.criticCalls).toHaveLength(0)
  })

  it('halts mid-loop and keeps the best bundle so far', async () => {
    const guard = new CountingGuard(2) // ok for iteration 1, throws at 2
    const { retriever } = retrieverWith([
      { criticReply: score(3), rewriteReply: 'a second wording to try' }
    ])
    const task = 'tune postgres autovacuum for the warehouse'
    const bundle = await retriever.retrieve(task, [], { spendMeter: guard, taskId: 'task-halt' })
    expect(bundle.haltReason).toBe('budget-exceeded')
    expect(bundle.iterations).toBe(1) // the second pass never ran
    expect(bundle.query).toBe(task)
    expect(bundle.criticScore).toBeCloseTo(0.3, 10)
    expect(guard.calls).toBe(2)
  })

  it('requires a taskId when a spendMeter is provided', async () => {
    const { retriever } = retrieverWith([])
    await expect(
      retriever.retrieve('anything', [], { spendMeter: new CountingGuard() })
    ).rejects.toThrow(/taskId/)
  })
})

/**
 * Phase-16b: with a ProviderRouter injected, the loop binds the two §11.4
 * HARD-local retrieval roles (`retrieval.critic` / `retrieval.rewrite`) through
 * it per retrieve() call instead of using `deps.llm`. Because both roles are
 * HARD-local, they ALWAYS resolve to local-qwen3 — behavior must be byte-for-
 * byte identical to injecting the fake as `llm`. The router-ABSENT path (every
 * describe above) is unchanged; those tests inject `llm` with no router.
 */
describe('router-injected critic/rewrite (phase-16b, §11.4 HARD-local)', () => {
  const rewritten = 'deploy the aurora storefront to vercel and verify the checkout flow'

  /**
   * Build a retriever whose critic/rewrite ride a REAL ProviderRouter. The
   * router's local backend is the same scripted fake (system-prompt discrimination
   * still applies); `makeCloud` throws and `deps.llm` is poisoned, so any escape
   * from the local seam — or any use of the non-router path — fails loudly.
   */
  function routerRetrieverWith(steps: ScriptedLlmStep[], routerOverrides: Partial<ProviderRouterDeps> = {}) {
    const local = new ScriptedLlm(steps)
    const router = new ProviderRouter({
      loadSnapshot: () => defaultModelSettings(),
      ollama: local,
      makeCloud: () => {
        throw new Error('retrieval critic/rewrite must never reach the cloud tier')
      },
      ...routerOverrides
    })
    const forRoleSpy = vi.spyOn(router, 'forRole')
    const poisoned: SmallLlm = {
      generate: () => {
        throw new Error('router present → deps.llm must not be used')
      }
    }
    const deps: RetrieverDeps = {
      engine: store.engine,
      embedder: new FakeEmbedder(),
      reranker: new FakeReranker(),
      llm: poisoned,
      router
    }
    return { retriever: createRetriever(deps), local, router, forRoleSpy }
  }

  it('resolves both retrieval roles to local-qwen3 on a default install', () => {
    const { router } = routerRetrieverWith([])
    for (const role of ['retrieval.critic', 'retrieval.rewrite'] as const) {
      expect(router.resolve(role).backend, role).toBe('local-qwen3')
      expect(router.resolve(role).model, role).toBe(SMALL_LLM_MODEL)
    }
  })

  it('drives the loop through the router identically to the injected llm, deps.llm untouched', async () => {
    const { retriever, local, forRoleSpy } = routerRetrieverWith([
      { criticReply: score(2, 'no deployment skill or project context'), rewriteReply: rewritten },
      { criticReply: score(9) }
    ])
    const bundle = await retriever.retrieve('make the shop pages go live', [], { taskId: 'live:sess-1' })

    // Same outcome as the non-router "bad first query improves" DoD case.
    expect(bundle.iterations).toBeLessThanOrEqual(3)
    expect(bundle.confidence).toBe('high')
    expect(bundle.haltReason).toBe('passed')
    expect(bundle.query).toBe(rewritten)
    expect(bundle.queriesTried).toEqual(['make the shop pages go live', rewritten])
    const ids = [...bundle.items, ...bundle.globalPreferences].map((i) => i.id)
    expect(ids).toContain('s-deploy')
    expect(ids).toContain('p-aurora')

    // Both roles were bound through the router with phase-15's live taskId…
    expect(forRoleSpy).toHaveBeenCalledWith('retrieval.critic', 'live:sess-1')
    expect(forRoleSpy).toHaveBeenCalledWith('retrieval.rewrite', 'live:sess-1')
    // …and both actually ran on the LOCAL backend (critic ×2, rewrite ×1).
    expect(local.criticCalls).toHaveLength(2)
    expect(local.rewriteCalls).toHaveLength(1)
  })

  it('falls back to a stable live:unknown taskId when retrieve() is given none', async () => {
    const { retriever, forRoleSpy } = routerRetrieverWith([{ criticReply: score(9) }])
    const bundle = await retriever.retrieve('render accessible telemetry charts')
    expect(bundle.haltReason).toBe('passed')
    expect(forRoleSpy).toHaveBeenCalledWith('retrieval.critic', 'live:unknown')
    expect(forRoleSpy).toHaveBeenCalledWith('retrieval.rewrite', 'live:unknown')
  })

  it('stays local even when the subscription tier is globally enabled and healthy', async () => {
    const { retriever, local, router } = routerRetrieverWith([{ criticReply: score(9) }], {
      loadSnapshot: () => ({
        ...defaultModelSettings(),
        reasoning: { backend: 'subscription-claude' },
        runner: { enabled: true, model: RUNNER_MODEL_DEFAULT, stageAll: true, mode: 'completion', injectionPolicy: 'downgrade' }
      }),
      subscriptionComplete: async () => {
        throw new Error('HARD-local retrieval roles must never reach the subscription tier')
      },
      runnerHealthy: () => true
    })
    // The §11.4 clamp holds at the retrieval layer, not just in the router unit test.
    expect(router.resolve('retrieval.critic').backend).toBe('local-qwen3')
    expect(router.resolve('retrieval.rewrite').backend).toBe('local-qwen3')
    const bundle = await retriever.retrieve('deploy the aurora storefront', [], { taskId: 'live:sess-9' })
    expect(bundle.haltReason).toBe('passed')
    expect(local.criticCalls).toHaveLength(1) // ran on local despite subscription ON
  })

  it('§10.4: a deliberate subscription OVERRIDE on the retrieval roles clamps to one critic pass', async () => {
    // Explicit per-role override (not the global toggle) → honored → subscription.
    // A low critic score would normally rewrite and loop to LOOP_MAX_ITERATIONS;
    // the §10.4 clamp forces a SINGLE critic pass so a live get_context can't fan
    // out to ~9 subscription spawns and trip the client MCP timeout.
    let subCalls = 0
    const { retriever, local } = routerRetrieverWith([], {
      loadSnapshot: () => ({
        ...defaultModelSettings(),
        reasoning: {
          backend: 'local-qwen3',
          overrides: { 'retrieval.critic': 'subscription-claude', 'retrieval.rewrite': 'subscription-claude' }
        },
        runner: { enabled: true, model: RUNNER_MODEL_DEFAULT, stageAll: true, mode: 'completion', injectionPolicy: 'downgrade' }
      }),
      makeCloud: () => null, // roles go to subscription, not cloud; avoid the throwing default
      subscriptionComplete: async () => {
        subCalls += 1
        return { text: score(2, 'thin bundle') } // low → would rewrite+loop WITHOUT the clamp
      },
      runnerHealthy: () => true
    })

    const bundle = await retriever.retrieve('deploy the aurora storefront', [], { taskId: 'live:sess-clamp' })

    expect(bundle.iterations).toBe(1)
    expect(bundle.haltReason).toBe('max-iterations')
    expect(subCalls).toBe(1) // exactly one critic call; the rewrite loop never started
    expect(local.criticCalls).toHaveLength(0) // critic ran on subscription, not local
    expect(local.rewriteCalls).toHaveLength(0)
  })
})
