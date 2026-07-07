# Phase 16 — integration notes (16a → 16b adoption guide)

Phase-16a shipped the **ReasoningProvider seam** as dead code: `src/main/models/provider.ts`
(`ProviderRouter` + three adapters + the §11.4 role table), plus `ModelSettings.reasoning`/`runner`
and their validators, plus the `SettingsDto`/`ModelSettingsPatchDto` DTO fields. Nothing is wired,
so the suite behaves identically to phase-15. **This doc is how 16b adopts it without changing
default behavior.** Read it with `docs/phases/phase-16-provider-seam.md` (the spec) open.

## The one wiring principle

The router resolves **per call** from a **cached snapshot**. Two consequences drive the whole
integration:

1. **The router is built once at boot** (in `bootAgents`, shared with the other boots via a module
   local, exactly like `kernelInstances`/`securityInstances`). It is NOT rebuilt on settings
   changes — instead the IPC mutators call `router.invalidate()`.
2. **`forRole(role, taskId)` is called per RUN, not at boot** — the taskId is only known when a run
   starts. So an agent cannot receive a frozen `llm`/`cloud` at construction anymore; it receives
   the **router** (or a per-role bound-adapter factory) and binds its roles to the run's taskId at
   the top of each workflow run/step. This is a small, surgical change — the agents already thread
   `ctx.jobId` into their cloud calls today (`extraction/agent.ts:170,199`
   `cloud: { ...deps.cloud, taskId: ctx.jobId }`) — not a rewrite. The structural interfaces
   (`ExtractionLlm` etc.) are unchanged; `router.forRole(role, taskId)` returns an object that
   satisfies them.

Recommended dep shape (ADD, never REMOVE — keep `llm`/`cloud` optional so every existing test rig
stays valid): add `readonly router?: ProviderRouter` to `ExtractionAgentDeps`/`SkillAgentDeps`/the
retrieval + ingest + scanner + context-manager deps. When `router` is present it wins; when absent
the agent falls back to today's `llm`/`cloud` (so the 500+ existing unit tests that inject fakes are
untouched). Boot always passes `router`.

## Per-role call sites — taskId + adoption

The taskId is the budget/trace key. It only bites when a role resolves to **cloud-api** (the §14
$0.50 SpendMeter ceiling) or **subscription-claude** (the phase-14 `CallBudget` call ceiling).
HARD-local roles are always local/free, so their taskId is for span correlation only.

| § role | call site (16b edits) | taskId to thread | how to adopt |
|---|---|---|---|
| `extraction.fuzzy` | `agents/extraction/fuzzy.ts` (local passes + cloud escalation) | `ctx.jobId` | local passes → `router.forRole('extraction.fuzzy', ctx.jobId)` as the `ExtractionLlm`; cloud escalation → see the escalation nuance below |
| `extraction.tiebreak` | `agents/extraction/resolve.ts` (LLM tiebreak) | `ctx.jobId` | `router.forRole('extraction.tiebreak', ctx.jobId)` as the tiebreak `ExtractionLlm` |
| `extraction.verify` | `agents/extraction/verify.ts` (cloud verifier) | `ctx.jobId` | `router.complete('extraction.verify', { …, taskId: ctx.jobId })` (or a cloud-bound helper). Keep the §17 self-judging guard: skip verify when the extractor itself was the cloud/subscription tier |
| `retrieval.critic` | `retrieval/loop.ts` (critic vs rubric) | `'live:' + sessionId` | the loop's `SmallLlm` ← `router.forRole('retrieval.critic', taskId)`. HARD-local → always qwen3 |
| `retrieval.rewrite` | `retrieval/loop.ts` (query rewrite) | `'live:' + sessionId` | second `SmallLlm` ← `router.forRole('retrieval.rewrite', taskId)`. HARD-local |
| `skills.testset` | `agents/skills/testset.ts` (cloud synthesis) | `ctx.jobId` | `router.complete('skills.testset', { …, taskId: ctx.jobId })` |
| `skills.rewrite` | `agents/skills/candidate.ts` (cloud SKILL.md rewrite) | `ctx.jobId` | `router.complete('skills.rewrite', { …, taskId: ctx.jobId })` |
| `skills.comparator` | `agents/skills/benchmark.ts` (cloud blind A/B) | `ctx.jobId` | `router.complete('skills.comparator', { …, taskId: ctx.jobId })` |
| `skills.executor` | `agents/skills/benchmark.ts` (local case exec ×3) | `ctx.jobId` | `router.forRole('skills.executor', ctx.jobId)` as the `SkillLlm`. HARD-local |
| `skills.grader` | `agents/skills/benchmark.ts` (local schema grader) | `ctx.jobId` | `router.forRole('skills.grader', ctx.jobId)` as the grader `SkillLlm`. HARD-local |
| `ingest.projectSummary` | `ingest/codebase.ts` (README → Project summary) | synthesized, e.g. `'ingest:' + projectId` | `router.forRole('ingest.projectSummary', taskId)` as the `ProjectSummarizer` |
| `scanner.llmVerdict` | `security/scanner.ts` (injection verdict) | synthesized, e.g. `'scan:' + sha` | `router.forRole('scanner.llmVerdict', taskId)` as the `ScannerLlm`. HARD-local |
| `context.summarize` | `kernel/contextManager.ts` (map-reduce summarize) | the enclosing op's id (`'live:'+sid` on the live path, else the workflow `jobId`) | `router.forRole('context.summarize', taskId)` as the `SummarizerLlm` |

**Synthesized taskIds** (ingest/scan) have no workflow job. Pick a stable, per-operation string so
the `CallBudget`/spend rows aggregate sensibly and nothing collides with the §6 exactly-once
`extract-<sid>` tokens. `'ingest:<projectId>'` and `'scan:<contentSha>'` are fine (both are local
today; the id only matters if a future setting routes them to subscription).

## The extraction escalation nuance (the subtle part)

Today extraction is **two-tier**: local qwen3 fuzzy passes, and two §20 gates escalate the WHOLE
session to the cloud tier — **Gate A** transcript > `EXTRACTION_ESCALATE_TRANSCRIPT_TOKENS` (60k),
**Gate B** local confidence < `EXTRACTION_ESCALATE_CONFIDENCE` (0.6). Keep this EXACTLY when
`extraction.fuzzy` resolves to **local-qwen3** or **cloud-api**.

When `extraction.fuzzy` resolves to **subscription-claude**, the subscription tier IS the primary
reasoning tier (a big-context Claude), so there is no smaller tier to escalate FROM — per §2.2 it is
a **single tier**. **Gate A/B become no-ops**: run the fuzzy passes once on the subscription tier
over `EXTRACTION_SUBSCRIPTION_CHUNK_TOKENS` (30k) chunks capped at
`EXTRACTION_SUBSCRIPTION_PASS_MAX_TOKENS` (2000) — the constants phase-14 added for exactly this —
and never invoke the cloud-escalation path. The independent verifier (`extraction.verify`) still
applies, minus the self-judging guard (don't verify a subscription extraction with the same
subscription tier).

Decide the mode once per run from `router.resolve('extraction.fuzzy').backend`:
- `'subscription-claude'` → single-tier path (no gates, subscription chunk sizes).
- `'local-qwen3'` / `'cloud-api'` → today's two-tier escalation, unchanged.

Because DEFAULT == TODAY, a default install always resolves `'local-qwen3'` here, so the two-tier
path is what actually runs until a user opts into the subscription — the new branch is dormant.

## Settings mutators → `router.invalidate()`

`index.ts` owns the boot closures, so it builds the router and passes an `onSettingsChanged` callback
INTO the IPC deps (`bootIpc`). Wire it at the only three mutators, AFTER a successful mutation:

- `settings.save` — **CRITICAL**: this handler (ipc.ts ~:676) rebuilds `next` from an explicit field
  list and silently drops unknown keys. Today it only carries `cloudProvider`/`cloudModels`/
  `smallLlmModel`. 16b must merge `reasoning` and `runner` too (validate via the new
  `loadModelSettings` ladder / the `ReasoningSettings`/`RunnerSettings` shapes; `defaultReasoningSettings()`
  / `defaultRunnerSettings()` materialize a section the first time a patch touches it) or a saved
  reasoning/runner patch vanishes on write. Then call `deps.onSettingsChanged()`.
- `settings.setApiKey` / `settings.clearApiKey` — call `deps.onSettingsChanged()` (a key change flips
  `makeCloud()` between a tier and `null`; `makeCloud` is already read live per call, but invalidating
  also refreshes the cached snapshot's provider).

`onSettingsChanged = () => router.invalidate()`. That is the entire "no restart to change provider"
fix (P1.1). `get_settings_summary` (phase-15, `reads/status.ts`) already surfaces `reasoning`/`runner`
when present, so once `settings.save` persists them the MCP + dashboard summaries reflect them with no
further change. Also extend the dashboard `settingsDto()` assembly (ipc.ts ~:653) to pass through
`summary.reasoning`/`summary.runner` into the new optional `SettingsDto` fields.

## Boot closures for the router (`bootAgents`)

```ts
const router = new ProviderRouter({
  loadSnapshot: () => loadModelSettings(settingsPath(userDataDir)),
  ollama,                                    // the shared OllamaClient
  makeCloud: () => {                         // live keychain read → per-call
    const s = loadModelSettings(settingsPath(userDataDir))
    const apiKey = keychain?.getApiKey(s.cloudProvider)
    return apiKey
      ? { brain: createCloudBrain(s.cloudProvider, { apiKey, model: activeCloudModel(s),
            ...(CLOUD_BASE_URL_OVERRIDE !== undefined ? { baseUrl: CLOUD_BASE_URL_OVERRIDE } : {}) }),
          meter: new SpendMeter({ db: appData.db }) }
      : null
  },
  // subscriptionComplete: left undefined — phase-17 injects the runner completion fn.
  // runnerHealthy: left default (() => false) — phase-17 provides the real health cache.
  callBudget: new CallBudget({ db: appData.db })   // durable subscription call ceiling
})
```

Notes:
- `makeCloud` re-reads the snapshot so a provider/model change is honored; it re-mints the `SpendMeter`
  per call (cheap, stateless over the shared `spend` table). Keep the `CLOUD_BASE_URL_OVERRIDE`
  passthrough so the golden-path e2e's scripted cloud server still fronts the cloud tier.
- `subscriptionComplete`/`runnerHealthy` stay unset → the subscription backend is unavailable → every
  role falls through to its today tier. This is why DEFAULT == TODAY holds after wiring.
- Share the one router with `bootMcp` (retrieval critic/rewrite), `bootKernel` (context summarizer),
  and the ingest/scanner construction — a module local like the existing `kernelInstances`.

## Precise file list 16b touches

- `src/main/index.ts` — build the `ProviderRouter` (module local); inject into extraction + skills
  agents, the retriever (critic/rewrite), the context manager, the codebase summarizer, the injection
  scanner; pass `onSettingsChanged` into `bootIpc`.
- `src/main/ipc.ts` — `settings.save` merges `reasoning`/`runner`; `settings.save`/`setApiKey`/
  `clearApiKey` call `onSettingsChanged`; `settingsDto()` surfaces the two sections; `IpcDeps` gains
  `onSettingsChanged`.
- `src/main/agents/extraction/{agent,fuzzy,resolve,verify}.ts` — `router?` dep + per-run `forRole`
  binding + the escalation-mode branch.
- `src/main/agents/skills/{agent,testset,candidate,benchmark}.ts` — `router?` dep + per-run binding.
- `src/main/retrieval/loop.ts` (+ `retrieval/index.ts` retriever factory) — critic/rewrite `SmallLlm`
  from `forRole`.
- `src/main/ingest/codebase.ts` — `ProjectSummarizer` from `forRole`.
- `src/main/security/scanner.ts` — `ScannerLlm` from `forRole`.
- `src/main/kernel/contextManager.ts` — `SummarizerLlm` from `forRole`.

Do NOT touch `provider.ts`/`settings.ts` shapes (16a froze them). Phase-20 owns the HARD-override
warning copy + the retrieval single-iteration clamp on subscription; phase-17 injects
`subscriptionComplete` + the real `runnerHealthy` cache and the runner dashboard.

## Default-behavior preservation checklist (must all stay true after 16b)

- No `reasoning`/`runner` on disk (default install) → every role resolves to its `ROLE_DEFAULTS[*].today`
  tier (verified by `models.provider.test.ts`).
- Keyless install → every role local; a cloud key → the four cloud roles (`extraction.verify`,
  `skills.testset/rewrite/comparator`) escalate to cloud exactly as today.
- The §14 $0.50 SpendMeter ceiling still wraps every cloud call (`CloudApiProvider` rides
  `meteredComplete`, no ceiling override).
- `qwen3` constrained decoding (`format`) is preserved on the local path — load-bearing for the grader
  + extraction; the router passes `schema` straight through as Ollama `format`.
- Changing provider/key/role takes effect on the NEXT call — no app restart (the P1.1 fix).
