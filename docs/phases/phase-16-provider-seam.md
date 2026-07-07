# Phase 16 — ReasoningProvider seam + role routing (§8 Phase 4 / P1.1; FP-2)

Introduce the `ReasoningProvider` seam + a **per-call** `ProviderRouter` (§2.1, §10.11/P1.1) behind the existing structural model interfaces, with three backends and a per-role fallback chain. **Default routing == today's behavior** (subscription is off, so every role resolves to local-qwen3 or cloud-api exactly as now). This also fixes the pre-existing restart-to-change-provider paper cut.

**Prime directive:** ADD, never REMOVE. A default install (local models + optional cloud key) behaves identically. `qwen3`, `CloudBrain`+`SpendMeter`+$0.50 ceiling, `bge-m3`, the ONNX reranker all stay wired.

## `src/main/models/provider.ts` (new)
```ts
type ReasoningBackend = 'local-qwen3' | 'cloud-api' | 'subscription-claude'
interface ReasoningProvider {
  readonly backend: ReasoningBackend
  complete(req: { prompt: string; system?: string; maxTokens?: number; temperature?: number
    schema?: Record<string, unknown>; taskId: string }): Promise<{ text: string; usage?: {...} }>
}
```
Adapters (grounded interface superset: `generate(prompt, {system?, maxTokens?, temperature?, think?, format?}) => {text}`):
- **`local-qwen3`** — over `OllamaClient.generate` (thinking off, **`format` passthrough** — constrained decoding is load-bearing for the grader + extraction; DO NOT drop it, `LOCAL_POOL_CONCURRENCY` semaphore already applies).
- **`cloud-api`** — over `meteredComplete(brain, meter, taskId, …)` ($0.50 ceiling intact; `schema` → appended shape instruction; tolerant parsing stays).
- **`subscription-claude`** — an **injected function** `subscriptionComplete?: (req) => Promise<...>` (the runner completion-mode fn lands in phase-17). Until injected/healthy, the router **falls back**. Must set `reportedCostUsd = 0` so `SpendMeter` never fabricates dollars (per grounding: fallback pricing would burn the ceiling in ~4 calls).

## `ProviderRouter` (per-call resolution — the P1.1 fix for boot-frozen wiring)
- Resolves `(backend, model, adapter)` **per call** from a cached settings snapshot + `runner_health` (for the subscription backend) + the per-role fallback chain **`subscription → cloud-api → local-qwen3`**.
- Fallback triggers: subscription disabled / runner unhealthy / no `subscriptionComplete` injected → cloud-api if a key exists → else local-qwen3. **Nothing hard-depends on the subscription.**
- Exposes adapters that satisfy the existing structural interfaces (`ExtractionLlm`, `ExtractionCloud`, `SkillLlm`, `SkillCloud`, `SmallLlm`, `ScannerLlm`, `ProjectSummarizer`, `SummarizerLlm`) so wiring is **dependency injection at boot, not agent rewrites** — the call sites already code against these interfaces.
- **Snapshot invalidation:** the router reads a cached `ModelSettings` snapshot invalidated by an in-process `onSettingsChanged` event (no file-watch), fired by the IPC settings mutators. Changing a role/backend/key then takes effect without an app restart.

## Role keys + §11.4 revised defaults (bake these in — never ship a bad default)
Roles (§2.2): `extraction.fuzzy`, `extraction.tiebreak`, `extraction.verify`, `retrieval.critic`, `retrieval.rewrite`, `skills.testset`, `skills.rewrite`, `skills.comparator`, `skills.executor`, `skills.grader`, `ingest.projectSummary`, `scanner.llmVerdict`, `context.summarize`.

| role | default backend (when subscription ENABLED) | when subscription OFF (default install) |
|---|---|---|
| extraction.fuzzy/tiebreak/verify, skills.testset/rewrite/comparator, ingest.projectSummary | subscription-claude | today's tier (local or cloud-api) |
| **retrieval.critic, retrieval.rewrite** | **local-qwen3 HARD** (live-path timeout+egress+volume) | local |
| **scanner.llmVerdict** | **local-qwen3 HARD** (raw JSON.parse fragility + privacy + offline detection) | local |
| **skills.executor, skills.grader** | **local-qwen3 HARD** (non-viable volume) | local |
| context.summarize | local-qwen3 | local |
| Embeddings / reranker | never move (not LLM reasoning) | local/in-process |

Overrides for the HARD-local roles must carry a warning label (P1 copy, phase-20); the router still honors an explicit override but forces single-iteration on the subscription for retrieval (phase-20/§10.4). This phase: implement the routing + defaults; the override-warnings/validation land in phase-20.

## Settings (`models/settings.ts` + `src/shared/ipc.ts` + `ipc.ts`)
`ModelSettings +=`:
```ts
reasoning?: { backend: ReasoningBackend /* default 'local-qwen3' */, overrides?: Partial<Record<RoleKey, ReasoningBackend>>, models?: Partial<Record<RoleKey, string>> }
runner?: { enabled: boolean /* DEFAULT false */, model: string /* RUNNER_MODEL_DEFAULT */, stageAll: boolean /* DEFAULT true */, mode: 'completion' | 'agent' /* DEFAULT 'completion' */, injectionPolicy: 'downgrade' | 'proceed' /* DEFAULT 'downgrade' */, verifierModel?: string, binaryPath?: string }
```
- Touch **all three**: `defaultModelSettings()`, the `loadModelSettings` field-by-field validation ladder, AND — CRITICAL — the `settings.save` IPC handler (ipc.ts ~:1057) which **rebuilds `next` from an explicit field list and silently drops unknown keys**; merge the new sections there or they vanish on first save. Extend `SettingsDto` too.
- **Snapshot-invalidation event:** attach at the only mutators — `settings.save`, `settings.setApiKey`, `settings.clearApiKey` — via an `onSettingsChanged` callback passed into the IPC deps from `index.ts` (which owns the boot closures). `get_settings_summary` (phase-15) then reflects `reasoning`/`runner` automatically.

## Boot (`index.ts` bootAgents) — serialized single-owner
Build the `ProviderRouter` (with `local`+`cloud` adapters; `subscriptionComplete` left undefined — phase-17 injects it) and inject router-backed adapters into `createExtractionAgent` / `createSkillImprovementAgent` / the retrieval critic/rewrite / scanner / summarizer / project-summarizer call sites, replacing the boot-frozen `cloud` closure with per-call router resolution. Wire `onSettingsChanged` → router snapshot invalidation. Every default resolves to today's behavior.

## DoD
`npm run lint && npm run typecheck && npm test` green (offline; latency flake handled in isolation). Tests: default routing == today (each role resolves to its current backend when runner off); the fallback chain (subscription-unhealthy → cloud-api → local) walks correctly and per-call (no restart); `format` is passed through on local, appended-as-instruction on cloud/subscription; a settings change invalidates the snapshot and the next call routes anew; `subscription-claude` adapter sets reportedCostUsd 0; the §11.4 HARD-local roles never route to subscription even when globally enabled. A keyless offline install still extracts/retrieves locally exactly as before.
