# Phase 16 report — ReasoningProvider seam + role routing (§8 Phase 4 / P1.1 / FP-2)

**Branch:** `feat/mcp-expansion-subscription-reasoner`. Built by Opus in two ultracode workflows — **16a** (`wf_c0e97f45-476`, seam design as dead code) and **16b** (`wf_cfd254ad-dd9`, wiring). The orchestrator reviewed the `provider.ts` design + integration guide at a gate between them, then reviewed the boot router construction. Prime directive held: **DEFAULT == TODAY** (a default install routes every role to its current backend; a keyless install runs entirely local).

## What was built

### 16a — the seam (design-reviewed, dead code until 16b)
- **`models/provider.ts` (new)** — `ReasoningProvider` interface + `ProviderRouter` (per-call resolution from a cached snapshot; `invalidate()`; `resolve()`/`complete()`/`forRole(role,taskId)`); 3 adapters: `LocalQwen3Provider` (Ollama, `format` passthrough), `CloudApiProvider` (`meteredComplete`, $0.50 ceiling intact), `SubscriptionClaudeProvider` (injected fn, always `reportedCostUsd:0`); `ROLE_DEFAULTS` baking in §11.4 (5 HARD-local roles, `context.summarize` local-only, 4 cloud-today roles). Per-role fallback chain `subscription → cloud-api → local-qwen3`.
- **`models/settings.ts` + `src/shared/ipc.ts`** — `ModelSettings.reasoning?`/`runner?` (+ `defaultReasoningSettings()`/`defaultRunnerSettings()` factories, validation ladder) + `SettingsDto`/`ModelSettingsPatchDto` fields.
- **`docs/phases/phase-16-integration-notes.md`** — the 16b adoption guide (taskId per role, the extraction escalation nuance, boot closure, default-behavior checklist).

### 16b — wiring (8 non-extraction roles)
- Each call site (`retrieval/loop.ts` critic+rewrite; `skills/{agent,testset,candidate,benchmark}.ts` testset/rewrite/comparator/executor/grader; `ingest/codebase.ts` projectSummary; `security/scanner.ts` llmVerdict; `kernel/context.ts` summarize) gained an **optional `router?`** dep: present → `router.forRole(role, taskId)`/`router.complete(role, req)`; **absent → today's `llm`/`cloud` unchanged** (so all 500+ fake-injecting tests are byte-identical — only boot passes the router).
- **`index.ts`** builds ONE `ProviderRouter` in `bootKernel` (module local, shared into retriever/scanner/context/skills/MCP-deps), `subscriptionComplete`/`runnerHealthy` **unset** (phase-17), and passes `onSettingsChanged: () => router.invalidate()` into `bootIpc`.
- **`ipc.ts`** — `settings.save` now merges `reasoning`/`runner` (was silently dropping them; materializes a section on first touch, preserves omitted, keeps absent absent); `save`/`setApiKey`/`clearApiKey` fire `onSettingsChanged` after success; `settingsDto()` surfaces both sections.

## Key decisions
- **`router?` optional everywhere** (ADD-never-REMOVE) — the DEFAULT==TODAY guarantee and the reason existing tests are untouched.
- **`forRole(role, taskId)` bridge** — one object structurally satisfies all 6 model interfaces; per-run binding threads the taskId (workflow `ctx.jobId` / retrieval `live:<sid>` / synthesized ingest/scan ids).
- **Per-call resolution + snapshot invalidation** = the P1.1 fix: changing provider/key/role takes effect on the **next call, no restart**.
- **Cloud roles run only when their resolved backend is non-local** — keyless resolves local → treated as "no cloud tier" → preserves today's `skipped-no-cloud` and §17's different-tier-comparator rule.
- Router built in `bootKernel` (not `bootAgents`) — boot order requires it before its consumers.

## Deferred (intentional)
- **All extraction roles** (`extraction.fuzzy/tiebreak/verify`) + the single-tier escalation branch → **phase-18**, bundled with the subscription `ExtractionTier`/`llm-subscription` pass/`skipped-subscription-extractor` (entangled; clean boundary).
- **`subscriptionComplete` + real `runnerHealthy` cache** → phase-17 (the runner). Until then the subscription backend is unavailable → every role falls through to its today tier.
- The **dashboard folder-pick `ingest.codebase`** IPC path's `projectSummary` is not router-wired (needs `IpcDeps.router`); identical under DEFAULT==TODAY (projectSummary is local-default) — minor phase-20 cleanup. The MCP `ingest_codebase` tool path IS wired.
- **HARD-override warnings + retrieval single-iteration clamp on subscription** → phase-20.

## Verification (DoD)
- Orchestrator independent run: lint clean; typecheck clean; isolated `models.provider`(6 describes) + `ipc.settings`(9) + `agents.skillimprove` + `retrieval.loop` = **63 passed | 1 skipped**.
- Verify agent full offline suite: **732 passed | 12 skipped**, exit 0 (only the `retrieval.latency` load flake, green in isolation). +48 vs phase-15.
- Audit CONFIRMED (6 pts): DEFAULT==TODAY; keyless→local & cloud-key→cloud with $0.50 ceiling; `format` preserved on local; settings round-trip + invalidate + next-call effect; **`extraction/*` unchanged (0 files)**; one shared router, subscription inert.

## Next
- **Phase-17 (runner + circuit breaker)** injects `subscriptionComplete` (completion mode) + the `runnerHealthy` cache into this router, adds `CallBudget`/quota throttle, zombie defense, `get_runner_status`, and the runner settings panel — completing the vertical slice.
