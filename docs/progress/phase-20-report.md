# Phase 20 report — hardening & honesty (§8 Phase 6 / FP-6, FINAL)

**Branch:** `feat/mcp-expansion-subscription-reasoner`. Opus ultracode workflow (`wf_c88f1ba7-d0d`): three disjoint streams (backend / renderer / docs) → verify. Orchestrator confirmed OFF-by-default + README preservation. **This closes the MCP-expansion + subscription-reasoner feature.**

**Prime directive held:** ADD, never REMOVE. Everything still ships OFF by default; a default install is unchanged (grep + the full suite confirm).

## What was built
### Backend (P1.7/8/11, §10.4)
- **P1.8 model-version bookkeeping** — `skill_improvements.benchmark_json` now stamps the resolved model id (`skills.rewrite`'s, mirroring `runner_runs.model`); `scanDrift` computes `modelChangedMidWindow` (adoption's `benchmark_json.model` vs the run's model) and the write step makes such findings **flag-only regardless of `autoRevert`** (a global model bump never auto-reverts a skill). Stamped only when a router is injected → no-router test rigs are byte-identical (DEFAULT==TODAY).
- **P1.11 independence warning** — `console.warn` (once per snapshot load) when `skills.rewrite` and `skills.comparator` resolve to the same **non-local** backend+model (§17 different-tier mandate, a warning not a block).
- **§10.4 retrieval single-iteration clamp** — `retrieval.critic`/`retrieval.rewrite` now honor a deliberate `subscription-claude` override (other HARD roles stay clamped to local), and `loop.ts` forces `maxIterations:1` when so overridden, so a live `get_context` can't fan out to ~9 subscription spawns.
- **P1.7 backend** — `stagedWriteRequiresEmbedder(row)` (byte-for-byte the condition `commitExtraction` embeds under) → `StagedWriteDto.requiresEmbedder`, surfaced on both the IPC + reads paths.

### Renderer (P1.7/10)
- **Review-queue batch UX** — staged writes grouped by source session with a per-group approve-all (batch-confirm modal); a "staged this week / decided this week" throughput counter on the home rail (tinted `warn` when staged > decided).
- **Ollama-required approve preflight** — approve disabled with "Ollama required to commit this item" when `requiresEmbedder && ollamaStatus !== 'ready'` (fails **open** on unknown/loading); approve-all skips embedder-blocked rows.
- **P1.10 first-enable consent dialog** — flipping the runner toggle ON first shows a modal with the §10.7 egress in plain words + an explicit "I understand" gate before persisting; `localStorage`-remembered, pre-enabled installs seeded (no retroactive nag). Golden-path e2e selectors preserved (verified safe: fake model server → Ollama ready → not blocked; the review spec's seeded item is a `propose_correction`, not embedder-gated).

### Docs / CI / ToS gate (P1.10, §6.1, P2)
- **README honesty (P1.10)** — new "Privacy — what leaves your machine" + "Subscription runner (optional, off by default)" sections with the two canonical §10.7 sentences; intro overclaim reframed; a Requirements bullet. **The pre-existing working-tree Windows `rebuild:native` note is preserved verbatim** (it was extended by its author, not clobbered).
- **§6.1 recorded ToS gate** — `docs/subscription-runner-tos.md` (dated 2026-07-06): the runner ships OFF; before ANY default is flipped toward the subscription the then-current Anthropic usage policy for scheduled headless subscription use MUST be re-confirmed. Explicitly a recorded process gate — **terms were NOT re-verified this session** (this only establishes the gate).
- **CI canary (P2, gated)** — `scripts/diag/runner-canary.mjs` (dependency-free; asserts the envelope fields when `claude` resolves, prints "skipped: claude not installed" + exit 0 otherwise) + a `continue-on-error` gated CI step. `claude` is NOT installed in CI.
- **Handoff:** the website repo's "local-first" marketing copy needs the same honesty edit — recorded (out of this repo).

## Verification (DoD)
- Orchestrator: lint clean; typecheck clean; isolated `security.staged` + `models.provider` + `retrieval.loop` + `agents.skillimprove` = **74 passed | 1 skipped**; `package.json`/lock diff empty; README `git diff` shows both notes present.
- Verify agent full offline suite: **846 passed | 12 skipped** (+7 vs phase-19); the 2 failures the known `retrieval.latency` + `security.conformance`-docker load flakes, both green in isolation. 6-point audit CONFIRMED (OFF-by-default, requiresEmbedder, drift flag-only, retrieval clamp, README both-present, no dep + canary safe).

---

## Feature complete
The MCP-integration + subscription-reasoner feature is done across phases 14–20 (branch `feat/mcp-expansion-subscription-reasoner`): **38 MCP tools** (27 read + 4 staged-write + 7 control); the **`ReasoningProvider` seam + per-call `ProviderRouter`** with `local-qwen3 → cloud-api → subscription-claude` fallback; the **runner** (completion + agent mode) with the **`CallBudget` circuit breaker**, quota self-throttle, zombie defense, and health/binary resolution; the **human-gated spine** (§5 approve/reject/undo/grant/keys/rollback) provably **off the MCP surface**; **everything OFF by default** with a first-enable consent dialog and the recorded ToS gate. Nothing was removed — a default install behaves exactly as v0.1.0.
