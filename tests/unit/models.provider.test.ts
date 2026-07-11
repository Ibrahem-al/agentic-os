/**
 * ReasoningProvider seam + ProviderRouter unit tests (phase 16 / §8 Phase 4 /
 * P1.1). Pins: DEFAULT == TODAY for every §2.2 role; the per-role fallback
 * chain subscription → cloud-api → local walks correctly and PER CALL (live
 * health/key + invalidate()-then-reresolve); §11.4 HARD-local roles never route
 * to subscription; local passes `format` through as constrained decoding while
 * cloud/subscription fold it into an appended shape instruction; the
 * subscription adapter reports $0 so SpendMeter never fabricates dollars; and
 * one RoleReasoner satisfies all six structural model interfaces at once.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CLOUD_DEFAULT_MODELS, RUNNER_MODEL_DEFAULT, SMALL_LLM_MODEL } from '../../src/main/config'
import type { ProjectSummarizer } from '../../src/main/ingest/codebase'
import type { SummarizerLlm } from '../../src/main/kernel/types'
import {
  CloudApiProvider,
  LocalQwen3Provider,
  ProviderRouter,
  ProviderUnavailableError,
  ROLE_DEFAULTS,
  ROLE_KEYS,
  SpendMeter,
  SubscriptionClaudeProvider,
  defaultModelSettings,
  type CloudBrain,
  type ModelSettings,
  type OllamaLike,
  type ProviderCloudTier,
  type ProviderRouterDeps,
  type RoleKey,
  type SubscriptionComplete
} from '../../src/main/models'
import type { ExtractionLlm } from '../../src/main/agents/extraction/types'
import type { SkillLlm } from '../../src/main/agents/skills/types'
import type { SmallLlm } from '../../src/main/retrieval/types'
import type { ScannerLlm } from '../../src/main/security/scanner'
import { openAppData, type AppData } from '../../src/main/storage'

// ── shared fakes ──────────────────────────────────────────────────────────────

let dir: string
let appData: AppData
let meter: SpendMeter

/** Records the last local call; returns a canned completion. */
let lastLocal: { prompt: string; options: Parameters<OllamaLike['generate']>[1] } | null = null
const ollama: OllamaLike = {
  generate: async (prompt, options) => {
    lastLocal = { prompt, options }
    return { text: 'local-reply', inputTokens: 3, outputTokens: 2 }
  }
}

/** Records the last cloud call. */
let lastCloud: { messages: { role: string; content: string }[]; model: string | undefined; system: string | undefined } | null = null
const brain: CloudBrain = {
  provider: 'anthropic',
  model: 'claude-opus-4-8',
  complete: async (messages, options) => {
    lastCloud = { messages: messages.map((m) => ({ role: m.role, content: m.content })), model: options?.model, system: options?.system }
    return { text: 'cloud-reply', model: options?.model ?? 'claude-opus-4-8', usage: { inputTokens: 10, outputTokens: 5 }, stopReason: 'end_turn' }
  }
}
const cloudTier = (): ProviderCloudTier => ({ brain, meter })

/** Records the last subscription call. */
let lastSub: Parameters<SubscriptionComplete>[0] | null = null
const subscriptionComplete: SubscriptionComplete = async (req) => {
  lastSub = req
  return { text: 'sub-reply', usage: { inputTokens: 7, outputTokens: 4 } }
}

/** Mutable router inputs the tests drive. */
let snapshot: ModelSettings
let healthy: boolean
let hasKey: boolean

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'agentic-os-provider-'))
  appData = openAppData(join(dir, 'appdata.db'))
  meter = new SpendMeter({ db: appData.db })
  snapshot = defaultModelSettings()
  healthy = false
  hasKey = true
  lastLocal = null
  lastCloud = null
  lastSub = null
})

afterEach(() => {
  appData.close()
  rmSync(dir, { recursive: true, force: true })
})

function makeRouter(overrides: Partial<ProviderRouterDeps> = {}): ProviderRouter {
  return new ProviderRouter({
    loadSnapshot: () => snapshot,
    ollama,
    makeCloud: () => (hasKey ? cloudTier() : null),
    subscriptionComplete,
    runnerHealthy: () => healthy,
    ...overrides
  })
}

/** Turn on the subscription tier globally + make it available. */
function enableSubscription(): void {
  snapshot = { ...defaultModelSettings(), reasoning: { backend: 'subscription-claude' }, runner: { ...runnerDefaults(), enabled: true } }
  healthy = true
}

function runnerDefaults(): NonNullable<ModelSettings['runner']> {
  return { enabled: false, model: RUNNER_MODEL_DEFAULT, stageAll: true, mode: 'completion', injectionPolicy: 'downgrade' }
}

const HARD_ROLES: readonly RoleKey[] = ['retrieval.critic', 'retrieval.rewrite', 'scanner.llmVerdict', 'skills.executor', 'skills.grader']

// ── role table ────────────────────────────────────────────────────────────────

describe('ROLE_KEYS + ROLE_DEFAULTS (§2.2 / §11.4)', () => {
  it('enumerates the §2.2 roles (13) plus the Stage-3 ingest.skillProposal extension', () => {
    // 13 §2.2 reasoning roles + ingest.skillProposal (user-directed spec
    // extension, feature A / Stage 3): a local-by-default, subscribable role.
    expect(ROLE_KEYS).toHaveLength(14)
    expect(new Set(ROLE_KEYS).size).toBe(14)
    expect(ROLE_KEYS).toContain('ingest.skillProposal')
    expect(Object.keys(ROLE_DEFAULTS).sort()).toEqual([...ROLE_KEYS].sort())
  })

  it('the HARD-local set is exactly the §11.4 five, and subscribable ⇒ !hardLocal', () => {
    const hard = ROLE_KEYS.filter((r) => ROLE_DEFAULTS[r].hardLocal)
    expect(new Set(hard)).toEqual(new Set(HARD_ROLES))
    for (const role of ROLE_KEYS) {
      const def = ROLE_DEFAULTS[role]
      if (def.subscribable) expect(def.hardLocal).toBe(false)
      // a HARD role's today tier is always local (never escalates)
      if (def.hardLocal) expect(def.today).toBe('local-qwen3')
    }
  })
})

// ── DEFAULT == TODAY ────────────────────────────────────────────────────────

describe('default routing == today (the prime directive)', () => {
  it('with a cloud key + runner off, every role resolves to its baked-in today tier', () => {
    const router = makeRouter()
    for (const role of ROLE_KEYS) {
      const r = router.resolve(role)
      expect(r.backend, role).toBe(ROLE_DEFAULTS[role].today)
      if (r.backend === 'local-qwen3') expect(r.model).toBe(SMALL_LLM_MODEL)
      if (r.backend === 'cloud-api') expect(r.model).toBe(CLOUD_DEFAULT_MODELS.anthropic)
    }
    // The four cloud-escalating roles are exactly today's cloud roles.
    const cloud = ROLE_KEYS.filter((role) => router.resolve(role).backend === 'cloud-api')
    expect(new Set(cloud)).toEqual(new Set(['extraction.verify', 'skills.testset', 'skills.rewrite', 'skills.comparator']))
  })

  it('a keyless offline install runs EVERY role local (no restart, no cloud)', () => {
    hasKey = false
    const router = makeRouter()
    for (const role of ROLE_KEYS) {
      expect(router.resolve(role).backend, role).toBe('local-qwen3')
    }
  })

  it('a fresh router with no subscriptionComplete / default runnerHealthy is all-today', () => {
    const router = new ProviderRouter({ loadSnapshot: () => defaultModelSettings(), ollama, makeCloud: () => cloudTier() })
    for (const role of ROLE_KEYS) {
      expect(router.resolve(role).backend, role).toBe(ROLE_DEFAULTS[role].today)
    }
  })
})

// ── fallback chain, per call ─────────────────────────────────────────────────

describe('fallback chain subscription → cloud-api → local (per call)', () => {
  it('a subscribable role walks the whole chain as availability drops', () => {
    enableSubscription()
    const router = makeRouter()
    const role: RoleKey = 'skills.rewrite'

    // subscription available → subscription (model = runner default)
    expect(router.resolve(role).backend).toBe('subscription-claude')
    expect(router.resolve(role).model).toBe(RUNNER_MODEL_DEFAULT)

    // runner unhealthy → cloud-api (LIVE: no invalidate needed)
    healthy = false
    expect(router.resolve(role).backend).toBe('cloud-api')

    // …and no key → local-qwen3 (LIVE)
    hasKey = false
    expect(router.resolve(role).backend).toBe('local-qwen3')
  })

  it('subscription needs enabled AND healthy AND an injected fn — any missing falls through', () => {
    enableSubscription()
    const role: RoleKey = 'extraction.fuzzy'

    // no injected fn → cloud (key present)
    expect(makeRouter({ subscriptionComplete: undefined }).resolve(role).backend).toBe('cloud-api')

    // fn present but runner disabled in settings → cloud
    snapshot = { ...defaultModelSettings(), reasoning: { backend: 'subscription-claude' }, runner: { ...runnerDefaults(), enabled: false } }
    expect(makeRouter().resolve(role).backend).toBe('cloud-api')
  })

  it('the settings snapshot is CACHED and only re-read after invalidate()', () => {
    enableSubscription()
    const router = makeRouter()
    const role: RoleKey = 'skills.rewrite'
    expect(router.resolve(role).backend).toBe('subscription-claude')

    // Mutate the source of truth to a default (subscription off).
    snapshot = defaultModelSettings()
    // Still subscription — the router holds the cached snapshot.
    expect(router.resolve(role).backend).toBe('subscription-claude')

    router.invalidate()
    // Now re-read: skills.rewrite's today tier is cloud-api (key present).
    expect(router.resolve(role).backend).toBe('cloud-api')
  })

  it('honors a per-role override even when the global backend is off', () => {
    snapshot = {
      ...defaultModelSettings(),
      reasoning: { backend: 'local-qwen3', overrides: { 'extraction.fuzzy': 'subscription-claude' } },
      runner: { ...runnerDefaults(), enabled: true }
    }
    healthy = true
    const router = makeRouter()
    expect(router.resolve('extraction.fuzzy').backend).toBe('subscription-claude')
    // Its sibling without an override stays on today's tier.
    expect(router.resolve('extraction.tiebreak').backend).toBe('local-qwen3')
  })

  it('applies per-role model overrides on top of the resolved backend', () => {
    snapshot = { ...defaultModelSettings(), reasoning: { backend: 'local-qwen3', models: { 'context.summarize': 'qwen3:8b', 'skills.rewrite': 'gpt-5.5' } } }
    const router = makeRouter()
    expect(router.resolve('context.summarize')).toEqual({ role: 'context.summarize', backend: 'local-qwen3', model: 'qwen3:8b' })
    // skills.rewrite is cloud today; the model override rides the cloud backend.
    expect(router.resolve('skills.rewrite')).toEqual({ role: 'skills.rewrite', backend: 'cloud-api', model: 'gpt-5.5' })
  })
})

// ── §11.4 HARD-local clamp ───────────────────────────────────────────────────

describe('§11.4 HARD-local roles never route to subscription', () => {
  it('stay local even with subscription globally enabled and available', () => {
    enableSubscription()
    const router = makeRouter()
    for (const role of HARD_ROLES) {
      const r = router.resolve(role)
      expect(r.backend, role).toBe('local-qwen3')
      expect(r.model, role).toBe(SMALL_LLM_MODEL)
    }
    // Control: a subscribable role in the same snapshot DOES go subscription.
    expect(router.resolve('skills.testset').backend).toBe('subscription-claude')
  })

  it('an explicit subscription override on a HARD role is clamped to local', () => {
    enableSubscription()
    snapshot = { ...snapshot, reasoning: { backend: 'subscription-claude', overrides: { 'skills.grader': 'subscription-claude' } } }
    expect(makeRouter().resolve('skills.grader').backend).toBe('local-qwen3')
  })

  it('but a HARD role CAN take a non-subscription override (only subscription is clamped)', () => {
    snapshot = { ...defaultModelSettings(), reasoning: { backend: 'local-qwen3', overrides: { 'skills.grader': 'cloud-api' } } }
    expect(makeRouter().resolve('skills.grader').backend).toBe('cloud-api')
  })
})

// ── adapters: format vs shape instruction, $0 subscription ───────────────────

describe('adapters (format passthrough vs appended shape instruction)', () => {
  const SCHEMA = { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'] }

  it('local passes `format` (a schema) straight through, thinking OFF, cost $0', async () => {
    const local = new LocalQwen3Provider(ollama)
    const res = await local.complete({ prompt: 'P', taskId: 't', schema: SCHEMA, model: 'qwen3:4b', temperature: 0 })
    expect(lastLocal?.options?.format).toEqual(SCHEMA)
    expect(lastLocal?.options?.think).toBe(false)
    expect(lastLocal?.options?.model).toBe('qwen3:4b')
    expect(res).toEqual({ text: 'local-reply', usage: { inputTokens: 3, outputTokens: 2 }, reportedCostUsd: 0 })
  })

  it('local passes the bare "json" format token through too', async () => {
    await new LocalQwen3Provider(ollama).complete({ prompt: 'P', taskId: 't', schema: 'json' })
    expect(lastLocal?.options?.format).toBe('json')
  })

  it('cloud appends the schema as a shape instruction (no constrained decoding) and meters spend', async () => {
    const cloud = new CloudApiProvider(cloudTier())
    const res = await cloud.complete({ prompt: 'ORIGINAL', taskId: 'task-cloud', schema: SCHEMA, system: 'SYS' })
    const content = lastCloud?.messages[0]?.content ?? ''
    expect(content).toContain('ORIGINAL')
    expect(content).toContain('JSON Schema')
    expect(content).toContain(JSON.stringify(SCHEMA))
    expect(lastCloud?.system).toBe('SYS') // system stays top-level
    expect(res.usage).toEqual({ inputTokens: 10, outputTokens: 5 })
    // The $0.50-ceiling meter ran: a real spend row exists.
    expect(meter.totalSpendUsd()).toBeGreaterThan(0)
  })

  it('subscription appends the shape instruction, reports $0, and never touches the meter', async () => {
    const sub = new SubscriptionClaudeProvider(subscriptionComplete)
    const res = await sub.complete({ prompt: 'ORIGINAL', taskId: 't', schema: SCHEMA })
    expect(lastSub?.prompt).toContain('ORIGINAL')
    expect(lastSub?.prompt).toContain('JSON Schema')
    expect(lastSub?.schema).toBeUndefined() // folded into the prompt, not forwarded
    expect(res.reportedCostUsd).toBe(0)
    expect(res.usage).toEqual({ inputTokens: 7, outputTokens: 4 })
    expect(meter.totalSpendUsd()).toBe(0) // SpendMeter can never fabricate dollars here
  })

  it('subscription with no injected fn throws ProviderUnavailableError (never pretends)', async () => {
    const sub = new SubscriptionClaudeProvider(undefined)
    await expect(sub.complete({ prompt: 'P', taskId: 't' })).rejects.toBeInstanceOf(ProviderUnavailableError)
  })

  it('a subscription route through the router reports $0 and records no spend', async () => {
    enableSubscription()
    const router = makeRouter()
    const res = await router.complete('skills.rewrite', { prompt: 'P', taskId: 'task-sub' })
    expect(res.reportedCostUsd).toBe(0)
    expect(res.text).toBe('sub-reply')
    expect(meter.totalSpendUsd()).toBe(0)
  })
})

// ── the role-bound structural adapter ────────────────────────────────────────

describe('forRole() — one object satisfies all six structural interfaces', () => {
  it('is structurally assignable to every §2.2 model interface (compile-time pin)', () => {
    const r = makeRouter().forRole('extraction.fuzzy', 'task')
    const asExtraction: ExtractionLlm = r
    const asSkill: SkillLlm = r
    const asSmall: SmallLlm = r
    const asScanner: ScannerLlm = r
    const asProject: ProjectSummarizer = r
    const asSummarizer: SummarizerLlm = r
    for (const x of [asExtraction, asSkill, asSmall, asScanner, asProject, asSummarizer]) {
      expect(typeof x.generate).toBe('function')
    }
  })

  it('maps `format` → schema and drops `think` on a HARD-local role (routes local)', async () => {
    const SCHEMA = { type: 'object' }
    const reasoner = makeRouter().forRole('scanner.llmVerdict', 'task-scan')
    const out = await reasoner.generate('scan me', { format: SCHEMA, think: true, temperature: 0, maxTokens: 128 })
    expect(out).toEqual({ text: 'local-reply' })
    expect(lastLocal?.options?.format).toEqual(SCHEMA)
    expect(lastLocal?.options?.think).toBe(false) // think is ignored, thinking stays off
    expect(lastLocal?.options?.maxTokens).toBe(128)
    expect(lastLocal?.prompt).toBe('scan me')
  })

  it('routes a cloud role through the cloud adapter with the shape instruction folded in', async () => {
    const SCHEMA = { type: 'object', properties: {} }
    const reasoner = makeRouter().forRole('extraction.verify', 'task-verify')
    const out = await reasoner.generate('verify this', { format: SCHEMA })
    expect(out).toEqual({ text: 'cloud-reply' })
    expect(lastCloud?.messages[0]?.content).toContain('verify this')
    expect(lastCloud?.messages[0]?.content).toContain('JSON Schema')
  })

  it('re-resolves per generate() call after invalidate()', async () => {
    enableSubscription()
    const router = makeRouter()
    const reasoner = router.forRole('skills.rewrite', 'task')
    await reasoner.generate('a')
    expect(lastSub).not.toBeNull() // went subscription

    lastSub = null
    lastCloud = null
    snapshot = defaultModelSettings() // subscription off
    router.invalidate()
    await reasoner.generate('b')
    expect(lastSub).toBeNull() // did NOT go subscription
    expect(lastCloud).not.toBeNull() // went cloud (skills.rewrite today tier)
  })
})

// ── P1.11 independence warning (skills.rewrite vs skills.comparator) ──────────

describe('P1.11 — warns when the rewriter and stylistic comparator are the same model/tier', () => {
  it('warns once (per snapshot load) on a keyed default where both resolve to the same cloud model', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const router = makeRouter() // key present → rewrite + comparator both cloud-api / same model
      router.resolve('skills.rewrite') // first resolve triggers the snapshot-load check
      expect(warn).toHaveBeenCalledTimes(1)
      expect(String(warn.mock.calls[0]?.[0])).toContain('skills.rewrite and skills.comparator')
      // The cached snapshot is not re-checked → no duplicate warning on later resolves.
      router.resolve('skills.comparator')
      expect(warn).toHaveBeenCalledTimes(1)
    } finally {
      warn.mockRestore()
    }
  })

  it('does NOT warn when the comparator is pinned to a different model (§17 independence preserved)', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      snapshot = { ...defaultModelSettings(), reasoning: { backend: 'local-qwen3', models: { 'skills.comparator': 'claude-different-judge' } } }
      makeRouter().resolve('skills.rewrite')
      expect(warn).not.toHaveBeenCalled()
    } finally {
      warn.mockRestore()
    }
  })

  it('does NOT warn on a keyless install (both roles resolve local; the comparator is inert)', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      hasKey = false
      makeRouter().resolve('skills.rewrite')
      expect(warn).not.toHaveBeenCalled()
    } finally {
      warn.mockRestore()
    }
  })
})

// ── §10.4 retrieval single-iteration clamp on a subscription override ─────────

describe('§10.4 — retrieval roles honor a subscription override, and force single-iteration', () => {
  /** Explicit per-role subscription override, subscription available (enabled+healthy+injected). */
  function overrideRetrievalToSubscription(overrides: Partial<Record<RoleKey, 'subscription-claude'>>): void {
    snapshot = {
      ...defaultModelSettings(),
      reasoning: { backend: 'local-qwen3', overrides },
      runner: { ...runnerDefaults(), enabled: true }
    }
    healthy = true
  }

  it('HONORS an explicit subscription override on a retrieval role (unlike other HARD roles)', () => {
    overrideRetrievalToSubscription({ 'retrieval.critic': 'subscription-claude' })
    const router = makeRouter()
    expect(router.resolve('retrieval.critic').backend).toBe('subscription-claude')
    // The un-overridden sibling stays local; the GLOBAL toggle never moves it.
    expect(router.resolve('retrieval.rewrite').backend).toBe('local-qwen3')
    // And a NON-retrieval HARD role's subscription override is STILL clamped (unchanged §11.4).
    router.invalidate()
    snapshot = {
      ...snapshot,
      reasoning: { backend: 'local-qwen3', overrides: { 'retrieval.critic': 'subscription-claude', 'skills.grader': 'subscription-claude' } }
    }
    expect(makeRouter().resolve('skills.grader').backend).toBe('local-qwen3')
  })

  it('forces single-iteration exactly when a retrieval role resolves to subscription', () => {
    // Default: both retrieval roles local → no clamp.
    expect(makeRouter().retrievalForcesSingleIteration()).toBe(false)

    // Critic overridden + subscription available → clamp forced.
    overrideRetrievalToSubscription({ 'retrieval.critic': 'subscription-claude' })
    expect(makeRouter().retrievalForcesSingleIteration()).toBe(true)

    // Rewrite overridden + subscription available → clamp forced.
    overrideRetrievalToSubscription({ 'retrieval.rewrite': 'subscription-claude' })
    expect(makeRouter().retrievalForcesSingleIteration()).toBe(true)

    // Overridden but subscription UNAVAILABLE (runner unhealthy) → falls back off
    // subscription → no real fan-out → no clamp.
    overrideRetrievalToSubscription({ 'retrieval.critic': 'subscription-claude' })
    healthy = false
    expect(makeRouter().retrievalForcesSingleIteration()).toBe(false)
  })
})
