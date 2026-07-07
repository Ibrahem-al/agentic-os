/**
 * ReasoningProvider seam + per-call ProviderRouter (§8 Phase 4 / P1.1; FP-2).
 *
 * The 13 §2.2 reasoning ROLES (extraction/retrieval/skills/ingest/scanner/
 * context) each resolve — PER CALL, from a cached settings snapshot — to one of
 * three backends behind a per-role fallback chain `subscription → cloud-api →
 * local-qwen3`. This is the seam that lets a role move between the local qwen3
 * tier, the bring-your-own-key cloud tier, and (phase-17) a Claude-subscription
 * runner WITHOUT an app restart, and without rewriting a single agent: the
 * router hands back objects that satisfy the existing structural model
 * interfaces (`ExtractionLlm`/`SkillLlm`/`SmallLlm`/`ScannerLlm`/
 * `ProjectSummarizer`/`SummarizerLlm`), so wiring is dependency injection.
 *
 * PRIME DIRECTIVE — DEFAULT == TODAY. With the runner disabled (the default)
 * and no `reasoning` overrides, every role resolves to EXACTLY the backend it
 * uses today: local-qwen3 for the local roles, cloud-api for the roles that
 * escalate to the cloud today (extraction.verify, skills.testset/rewrite/
 * comparator), and local-qwen3 as the keyless-offline fallback. Nothing
 * hard-depends on the subscription; until phase-17 injects a healthy
 * `subscriptionComplete`, the subscription backend is always treated as
 * unavailable and the chain falls through.
 *
 * BUILD-ONLY (phase 16a): this module is not yet wired at any call site — it is
 * deliberately dead code until phase-16b injects router-backed adapters at
 * boot. See docs/phases/phase-16-integration-notes.md.
 *
 * Cycle hygiene (§21): imports from `./settings` are TYPE-ONLY (settings.ts
 * imports the `ReasoningBackend`/`RoleKey` types from here, also type-only — a
 * pure compile-time cycle, erased at runtime). The only runtime sibling import
 * is `meteredComplete` from `./spend` (spend.ts has no dependency on this
 * module). Model defaults come from `../config`, never from settings.ts.
 */
import { CLOUD_DEFAULT_MODELS, RUNNER_MODEL_DEFAULT, SMALL_LLM_MODEL } from '../config'
import type { ChatMessage, CloudBrain } from './cloud'
import type { ModelSettings } from './settings'
import { meteredComplete, type SpendMeter } from './spend'

// ── Backends + the §2.2 role keys ────────────────────────────────────────────

/** The three reasoning tiers a role can resolve to. */
export type ReasoningBackend = 'local-qwen3' | 'cloud-api' | 'subscription-claude'

/** The 13 §2.2 reasoning roles (embeddings + reranker are NOT reasoning). */
export type RoleKey =
  | 'extraction.fuzzy'
  | 'extraction.tiebreak'
  | 'extraction.verify'
  | 'retrieval.critic'
  | 'retrieval.rewrite'
  | 'skills.testset'
  | 'skills.rewrite'
  | 'skills.comparator'
  | 'skills.executor'
  | 'skills.grader'
  | 'ingest.projectSummary'
  | 'scanner.llmVerdict'
  | 'context.summarize'

/** Canonical ordered list of every role (dashboards, validation, tests). */
export const ROLE_KEYS: readonly RoleKey[] = [
  'extraction.fuzzy',
  'extraction.tiebreak',
  'extraction.verify',
  'retrieval.critic',
  'retrieval.rewrite',
  'skills.testset',
  'skills.rewrite',
  'skills.comparator',
  'skills.executor',
  'skills.grader',
  'ingest.projectSummary',
  'scanner.llmVerdict',
  'context.summarize'
]

/**
 * Per-role §11.4 defaults, baked in so the router can NEVER ship a bad default.
 *
 *  - `today`     — the backend the role uses TODAY (subscription off). This is
 *                  the anchor for DEFAULT == TODAY: with no `reasoning` config a
 *                  role always resolves to `today` (subject only to the cloud
 *                  key existing). local for the local roles; cloud-api for the
 *                  four roles that escalate to the cloud today.
 *  - `hardLocal` — §11.4 HARD-local. These roles NEVER resolve to subscription,
 *                  not via the global toggle and not via an explicit override
 *                  (this phase; phase-20 relaxes HARD overrides to
 *                  honor-with-warning + forced single-iteration for retrieval).
 *                  Reason: live-path timeout/egress/volume (retrieval), raw
 *                  JSON.parse fragility + privacy + offline detection (scanner),
 *                  and non-viable call volume (skills executor/grader).
 *  - `subscribable` — the global `reasoning.backend='subscription-claude'`
 *                  toggle routes this role to subscription. True for exactly the
 *                  §11.4 "subscription-claude when enabled" rows; false for the
 *                  HARD-local roles and context.summarize (local-only). By
 *                  construction `subscribable ⇒ !hardLocal`.
 */
export interface RoleDefault {
  readonly today: 'local-qwen3' | 'cloud-api'
  readonly hardLocal: boolean
  readonly subscribable: boolean
}

export const ROLE_DEFAULTS: Readonly<Record<RoleKey, RoleDefault>> = {
  'extraction.fuzzy': { today: 'local-qwen3', hardLocal: false, subscribable: true },
  'extraction.tiebreak': { today: 'local-qwen3', hardLocal: false, subscribable: true },
  'extraction.verify': { today: 'cloud-api', hardLocal: false, subscribable: true },
  'retrieval.critic': { today: 'local-qwen3', hardLocal: true, subscribable: false },
  'retrieval.rewrite': { today: 'local-qwen3', hardLocal: true, subscribable: false },
  'skills.testset': { today: 'cloud-api', hardLocal: false, subscribable: true },
  'skills.rewrite': { today: 'cloud-api', hardLocal: false, subscribable: true },
  'skills.comparator': { today: 'cloud-api', hardLocal: false, subscribable: true },
  'skills.executor': { today: 'local-qwen3', hardLocal: true, subscribable: false },
  'skills.grader': { today: 'local-qwen3', hardLocal: true, subscribable: false },
  'ingest.projectSummary': { today: 'local-qwen3', hardLocal: false, subscribable: true },
  'scanner.llmVerdict': { today: 'local-qwen3', hardLocal: true, subscribable: false },
  'context.summarize': { today: 'local-qwen3', hardLocal: false, subscribable: false }
}

// ── The provider contract ─────────────────────────────────────────────────────

/**
 * One reasoning request. `schema` is the union OllamaClient's `format` accepts
 * (the phase-doc's `Record<string, unknown>` constrained-decoding case that
 * every current call site uses, plus bare `'json'` for structural parity with
 * the model interfaces): local passes it through as constrained decoding;
 * cloud/subscription have no constrained decoding, so it becomes an appended
 * shape instruction. `model` is populated by the router per call (a raw caller
 * may omit it to use the backend's own default).
 */
export interface ReasoningRequest {
  readonly prompt: string
  readonly system?: string
  readonly maxTokens?: number
  readonly temperature?: number
  readonly schema?: 'json' | Record<string, unknown>
  readonly taskId: string
  /** Resolved model id; the router sets this. Omit for the backend default. */
  readonly model?: string
}

export interface ReasoningResult {
  readonly text: string
  readonly usage?: { readonly inputTokens: number; readonly outputTokens: number }
  /**
   * USD the call really cost. 0 for local (free) and for subscription (a
   * flat-fee plan — see SubscriptionClaudeProvider); the provider-reported
   * figure for cloud. Never let a subscription call reach SpendMeter without
   * this, or its aggressive FALLBACK_PRICE would fabricate dollars and burn the
   * $0.50 ceiling in ~4 calls.
   */
  readonly reportedCostUsd?: number
}

/** A backend adapter. The three implementations below satisfy this. */
export interface ReasoningProvider {
  readonly backend: ReasoningBackend
  complete(req: ReasoningRequest): Promise<ReasoningResult>
}

/** Raised when an adapter is invoked without its backend being available. */
export class ProviderUnavailableError extends Error {
  constructor(
    readonly backend: ReasoningBackend,
    message: string
  ) {
    super(message)
    this.name = 'ProviderUnavailableError'
  }
}

// ── Structural deps (kept structural so this module imports no model class) ──

/** Satisfied by OllamaClient.generate. */
export interface OllamaLike {
  generate(
    prompt: string,
    options?: {
      model?: string
      system?: string
      think?: boolean
      maxTokens?: number
      temperature?: number
      format?: 'json' | Record<string, unknown>
    }
  ): Promise<{ text: string; inputTokens?: number; outputTokens?: number }>
}

/** The bring-your-own-key cloud tier (null when no API key is configured). */
export interface ProviderCloudTier {
  readonly brain: CloudBrain
  readonly meter: SpendMeter
}

/**
 * The injected subscription completion fn (phase-17's runner completion mode).
 * Undefined until then → the subscription backend is unavailable and the chain
 * falls through. Receives a schema-free prompt (the router folds any schema
 * into the prompt as a shape instruction first).
 */
export type SubscriptionComplete = (
  req: ReasoningRequest
) => Promise<{ text: string; usage?: { inputTokens: number; outputTokens: number } }>

/** The durable runner call-ceiling (phase-14 CallBudget), structurally. */
export interface SubscriptionBudget {
  checkBudget(taskId: string): void
}

// ── Shape instruction (cloud/subscription have no constrained decoding) ──────

function shapeInstruction(schema: 'json' | Record<string, unknown>): string {
  if (schema === 'json') {
    return 'Respond with ONLY a single valid JSON value — no prose, no explanation, no markdown code fence.'
  }
  return (
    'Respond with ONLY a single JSON value conforming to this JSON Schema — no prose, no explanation, ' +
    `no markdown code fence:\n${JSON.stringify(schema)}`
  )
}

/** Prompt with any schema folded in as an appended instruction. */
function promptWithSchema(req: ReasoningRequest): string {
  return req.schema === undefined ? req.prompt : `${req.prompt}\n\n${shapeInstruction(req.schema)}`
}

// ── Adapter 1: local-qwen3 (over OllamaClient) ───────────────────────────────

/**
 * Local tier. `schema` is passed straight through as Ollama's `format`
 * (constrained decoding is load-bearing for the grader + extraction — DO NOT
 * drop it). Thinking is OFF (routing/eval callers want the plain answer);
 * OllamaClient's LOCAL_POOL_CONCURRENCY semaphore already applies. Local work
 * is free, so `reportedCostUsd` is 0.
 */
export class LocalQwen3Provider implements ReasoningProvider {
  readonly backend = 'local-qwen3' as const

  constructor(private readonly ollama: OllamaLike) {}

  async complete(req: ReasoningRequest): Promise<ReasoningResult> {
    const res = await this.ollama.generate(req.prompt, {
      ...(req.model !== undefined ? { model: req.model } : {}),
      ...(req.system !== undefined ? { system: req.system } : {}),
      ...(req.maxTokens !== undefined ? { maxTokens: req.maxTokens } : {}),
      ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
      think: false,
      ...(req.schema !== undefined ? { format: req.schema } : {})
    })
    return {
      text: res.text,
      ...(res.inputTokens !== undefined && res.outputTokens !== undefined
        ? { usage: { inputTokens: res.inputTokens, outputTokens: res.outputTokens } }
        : {}),
      reportedCostUsd: 0
    }
  }
}

// ── Adapter 2: cloud-api (over meteredComplete) ──────────────────────────────

/**
 * Bring-your-own-key cloud tier. Rides `meteredComplete`, so the §14 $0.50
 * per-task ceiling stays intact (checked before spend, recorded after) and the
 * tolerant parsing on the caller side is unchanged. No constrained decoding, so
 * `schema` becomes an appended shape instruction on the user message; `system`
 * stays a top-level system prompt.
 */
export class CloudApiProvider implements ReasoningProvider {
  readonly backend = 'cloud-api' as const

  constructor(private readonly tier: ProviderCloudTier) {}

  async complete(req: ReasoningRequest): Promise<ReasoningResult> {
    const messages: ChatMessage[] = [{ role: 'user', content: promptWithSchema(req) }]
    const completion = await meteredComplete(this.tier.brain, this.tier.meter, req.taskId, messages, {
      ...(req.model !== undefined ? { model: req.model } : {}),
      ...(req.system !== undefined ? { system: req.system } : {}),
      ...(req.maxTokens !== undefined ? { maxTokens: req.maxTokens } : {})
      // ceilingUsd intentionally omitted → SpendMeter's $0.50 default holds.
    })
    return {
      text: completion.text,
      usage: completion.usage,
      ...(completion.reportedCostUsd !== undefined ? { reportedCostUsd: completion.reportedCostUsd } : {})
    }
  }
}

// ── Adapter 3: subscription-claude (over the injected runner fn) ─────────────

/**
 * Claude-subscription tier — a thin wrapper over the injected
 * `subscriptionComplete` (phase-17's runner completion mode). No constrained
 * decoding → `schema` folds into the prompt. The durable runner call-ceiling
 * (CallBudget) is checked first when present. reportedCostUsd is ALWAYS 0: a
 * subscription is a flat-fee plan, not per-token, so it must never let
 * SpendMeter fabricate dollars from the price table. Until `subscriptionComplete`
 * is injected the adapter is inert — the router never routes here without it,
 * but a direct call throws rather than pretend.
 */
export class SubscriptionClaudeProvider implements ReasoningProvider {
  readonly backend = 'subscription-claude' as const

  constructor(
    private readonly subscriptionComplete: SubscriptionComplete | undefined,
    private readonly budget?: SubscriptionBudget
  ) {}

  async complete(req: ReasoningRequest): Promise<ReasoningResult> {
    if (this.subscriptionComplete === undefined) {
      throw new ProviderUnavailableError(
        'subscription-claude',
        'no subscriptionComplete injected (lands in phase-17) — subscription backend unavailable'
      )
    }
    this.budget?.checkBudget(req.taskId)
    const res = await this.subscriptionComplete({
      prompt: promptWithSchema(req),
      ...(req.system !== undefined ? { system: req.system } : {}),
      ...(req.maxTokens !== undefined ? { maxTokens: req.maxTokens } : {}),
      ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
      ...(req.model !== undefined ? { model: req.model } : {}),
      taskId: req.taskId
    })
    return {
      text: res.text,
      ...(res.usage !== undefined ? { usage: res.usage } : {}),
      reportedCostUsd: 0
    }
  }
}

// ── The role-bound structural adapter ────────────────────────────────────────

/**
 * Option superset across every §2.2 structural model interface: ScannerLlm
 * carries `think` + `format`; Extraction/Skill carry `format`; retrieval's
 * SmallLlm / ProjectSummarizer / SummarizerLlm carry the subset. A function
 * accepting this superset (all optional) is structurally assignable to all six,
 * so one `RoleReasoner` drops into every call site.
 */
export interface RoleGenerateOptions {
  system?: string
  maxTokens?: number
  temperature?: number
  /**
   * Accepted for ScannerLlm structural parity. The local backend runs
   * thinking-OFF regardless (§16), and cloud/subscription have no thinking mode,
   * so it is accepted-and-ignored — faithful, since no call site ever passes
   * `think: true` today.
   */
  think?: boolean
  format?: 'json' | Record<string, unknown>
}

/**
 * A role- and taskId-bound object exposing `generate(prompt, opts) => {text}`.
 * This is how phase-16b adopts the router: it satisfies `ExtractionLlm`,
 * `SkillLlm`, `SmallLlm`, `ScannerLlm`, `ProjectSummarizer`, and `SummarizerLlm`
 * at once, so an agent coded against any of those interfaces takes a
 * `RoleReasoner` with zero changes.
 */
export interface RoleReasoner {
  generate(prompt: string, options?: RoleGenerateOptions): Promise<{ text: string }>
}

// ── The router ────────────────────────────────────────────────────────────────

/** What a role resolved to (backend + concrete model), for introspection. */
export interface ResolvedRoute {
  readonly role: RoleKey
  readonly backend: ReasoningBackend
  readonly model: string
}

export interface ProviderRouterDeps {
  /** Loads the current ModelSettings; the result is cached until invalidate(). */
  readonly loadSnapshot: () => ModelSettings
  readonly ollama: OllamaLike
  /** Builds the cloud tier from the live keychain — null when no key is set. */
  readonly makeCloud: () => ProviderCloudTier | null
  /** Injected in phase-17; absent → subscription backend unavailable. */
  readonly subscriptionComplete?: SubscriptionComplete
  /** Runner auth/health (real cache lands phase-17). Default: always unhealthy. */
  readonly runnerHealthy?: () => boolean
  /** Durable runner call-ceiling for the subscription path (phase-14). */
  readonly callBudget?: SubscriptionBudget
}

/**
 * Resolves `(backend, model, adapter)` PER CALL for a role, from a cached
 * ModelSettings snapshot + live `runnerHealthy()`/`makeCloud()` + the per-role
 * fallback chain. `invalidate()` (fired by the IPC settings mutators via
 * onSettingsChanged — no file-watch) drops the cached snapshot so the next call
 * routes anew: a role/backend/key change takes effect without an app restart
 * (the P1.1 fix for boot-frozen wiring).
 */
export class ProviderRouter {
  private readonly local: LocalQwen3Provider
  private readonly subscription: SubscriptionClaudeProvider
  private cached: ModelSettings | null = null

  constructor(private readonly deps: ProviderRouterDeps) {
    this.local = new LocalQwen3Provider(deps.ollama)
    this.subscription = new SubscriptionClaudeProvider(deps.subscriptionComplete, deps.callBudget)
  }

  /** Drop the cached settings snapshot; the next resolution reloads it. */
  invalidate(): void {
    this.cached = null
  }

  private snapshot(): ModelSettings {
    if (this.cached === null) {
      this.cached = this.deps.loadSnapshot()
      this.warnOnResolutionHazards(this.cached)
    }
    return this.cached
  }

  private runnerHealthy(): boolean {
    return this.deps.runnerHealthy?.() ?? false
  }

  private subscriptionAvailable(s: ModelSettings): boolean {
    return s.runner?.enabled === true && this.runnerHealthy() && this.deps.subscriptionComplete !== undefined
  }

  /** The backend a role WANTS, before availability fallback. */
  private desiredBackend(role: RoleKey, s: ModelSettings): ReasoningBackend {
    const def = ROLE_DEFAULTS[role]
    const override = s.reasoning?.overrides?.[role]
    let desired: ReasoningBackend
    if (override !== undefined) {
      desired = override
    } else if (s.reasoning?.backend === 'subscription-claude' && def.subscribable) {
      desired = 'subscription-claude'
    } else {
      desired = def.today
    }
    // §11.4 HARD-local clamp. phase-20 §10.4: an EXPLICIT per-role override to
    // subscription is HONORED for the two retrieval roles (the retrieval loop then
    // forces a single critic pass — see retrievalForcesSingleIteration — so a live
    // get_context can't fan out to ~9 subscription spawns). Every OTHER HARD-local
    // role stays clamped to local, and the GLOBAL toggle never moves any HARD-local
    // role (subscribable=false, handled above) — so a default install is unchanged
    // and only a deliberate retrieval override reaches the subscription tier.
    if (def.hardLocal && desired === 'subscription-claude') {
      const honoredRetrievalOverride =
        override === 'subscription-claude' && (role === 'retrieval.critic' || role === 'retrieval.rewrite')
      if (!honoredRetrievalOverride) desired = 'local-qwen3'
    }
    return desired
  }

  private modelFor(backend: ReasoningBackend, role: RoleKey, s: ModelSettings): string {
    const override = s.reasoning?.models?.[role]
    if (override !== undefined) return override
    switch (backend) {
      case 'local-qwen3':
        return s.smallLlmModel ?? SMALL_LLM_MODEL
      case 'cloud-api':
        return s.cloudModels[s.cloudProvider] ?? CLOUD_DEFAULT_MODELS[s.cloudProvider]
      case 'subscription-claude':
        return s.runner?.model ?? RUNNER_MODEL_DEFAULT
    }
  }

  /**
   * Walk the fallback chain, returning the first AVAILABLE backend and its
   * adapter: subscription (only if enabled + healthy + injected) → cloud-api
   * (only if a key exists) → local-qwen3 (always).
   */
  private route(role: RoleKey): { backend: ReasoningBackend; model: string; provider: ReasoningProvider } {
    return this.routeWith(this.snapshot(), role)
  }

  private routeWith(s: ModelSettings, role: RoleKey): { backend: ReasoningBackend; model: string; provider: ReasoningProvider } {
    let desired = this.desiredBackend(role, s)

    if (desired === 'subscription-claude') {
      if (this.subscriptionAvailable(s)) {
        return { backend: 'subscription-claude', model: this.modelFor('subscription-claude', role, s), provider: this.subscription }
      }
      desired = 'cloud-api' // fall through
    }
    if (desired === 'cloud-api') {
      const tier = this.deps.makeCloud()
      if (tier !== null) {
        return { backend: 'cloud-api', model: this.modelFor('cloud-api', role, s), provider: new CloudApiProvider(tier) }
      }
      // no key → local
    }
    return { backend: 'local-qwen3', model: this.modelFor('local-qwen3', role, s), provider: this.local }
  }

  /** Introspection: the backend + model a role resolves to right now. */
  resolve(role: RoleKey): ResolvedRoute {
    const r = this.route(role)
    return { role, backend: r.backend, model: r.model }
  }

  /**
   * §10.4: true when either retrieval role currently resolves to the subscription
   * tier — only possible via a deliberate per-role override (honored in
   * desiredBackend). The retrieval loop reads this to clamp to a SINGLE critic
   * pass (one critic, no rewrite loop) so a live get_context can't fan out to ~9
   * subscription spawns and trip the client MCP timeout. Default/local/cloud
   * resolution → false → the normal LOOP_MAX_ITERATIONS.
   */
  retrievalForcesSingleIteration(): boolean {
    const s = this.snapshot()
    return (
      this.routeWith(s, 'retrieval.critic').backend === 'subscription-claude' ||
      this.routeWith(s, 'retrieval.rewrite').backend === 'subscription-claude'
    )
  }

  /**
   * Best-effort advisory logging fired once per snapshot load (boot + after each
   * invalidate). NEVER affects routing and NEVER throws — a pathological
   * `makeCloud` is swallowed so resolution is unaffected.
   *
   *  - P1.11: §17 wants the stylistic comparator on a DIFFERENT model/tier from
   *    the candidate rewriter (self-judging bias). Warn when they resolve to the
   *    same NON-local backend+model. (On local the comparator is inert — the
   *    stylistic benchmark runs no cloud judging — so there is nothing to warn.)
   *  - §10.4 honor-with-warning: a deliberate subscription override on a retrieval
   *    role is honored (unlike other HARD-local roles) but is single-iteration.
   */
  private warnOnResolutionHazards(s: ModelSettings): void {
    try {
      const rewrite = this.routeWith(s, 'skills.rewrite')
      const comparator = this.routeWith(s, 'skills.comparator')
      if (
        rewrite.backend !== 'local-qwen3' &&
        rewrite.backend === comparator.backend &&
        rewrite.model === comparator.model
      ) {
        console.warn(
          `[provider] skills.rewrite and skills.comparator both resolve to ${rewrite.backend} / ${rewrite.model} — ` +
            '§17 expects the stylistic comparator on a different model/tier from the candidate rewriter ' +
            '(self-judging bias). Advisory only; the majority + zero-regression benchmark gate still applies.'
        )
      }
      for (const role of ['retrieval.critic', 'retrieval.rewrite'] as const) {
        if (this.routeWith(s, role).backend === 'subscription-claude') {
          console.warn(
            `[provider] ${role} is overridden to subscription-claude — the retrieval loop runs a SINGLE critic ` +
              'pass (no rewrite loop) to bound live get_context egress/latency (§10.4).'
          )
        }
      }
    } catch {
      // advisory only — never let a logging probe affect resolution
    }
  }

  /** Resolve the role and complete the request against its backend. */
  async complete(role: RoleKey, req: ReasoningRequest): Promise<ReasoningResult> {
    const r = this.route(role)
    return r.provider.complete({ ...req, model: r.model })
  }

  /**
   * A role+taskId-bound `generate(prompt, opts) => {text}` — the drop-in for the
   * structural model interfaces. `format` maps to `schema`; `think` is accepted
   * for ScannerLlm parity (ignored, per §16). Resolution happens per generate()
   * call, so a settings change (after invalidate()) reroutes the next call.
   */
  forRole(role: RoleKey, taskId: string): RoleReasoner {
    return {
      generate: async (prompt, options = {}) => {
        const res = await this.complete(role, {
          prompt,
          ...(options.system !== undefined ? { system: options.system } : {}),
          ...(options.maxTokens !== undefined ? { maxTokens: options.maxTokens } : {}),
          ...(options.temperature !== undefined ? { temperature: options.temperature } : {}),
          ...(options.format !== undefined ? { schema: options.format } : {}),
          taskId
        })
        return { text: res.text }
      }
    }
  }
}
