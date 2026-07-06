# Phase 18 report — extraction subscription tier + staged-write/control tools (§8 Phase 2 / FP-4)

**Branch:** `feat/mcp-expansion-subscription-reasoner`. Opus ultracode workflow (`wf_c9e43fbc-0ac`): two parallel streams (extraction / tools) linked by explicit contracts → verify. Orchestrator independently confirmed the security invariants (full 38-tool surface, **no §5 spine verbs**) + the router boot-fix. After this an interactive Claude can drive the **whole** learning loop on the subscription — manually, **through the same gates.**

**Prime directive held:** DEFAULT==TODAY (extraction stays local+cloud two-tier until the runner is enabled+healthy); staged writes are the only agent write path; the human-gated spine is never exposed.

## Stream A — extraction subscription tier (`agents/extraction/*`, `triggers/{sessionEnd,jobs}.ts`)
- **3 roles routed** through the phase-16 router (optional `router?` on `ExtractionAgentDeps`; absent → today's `llm`/`cloud` byte-identical): `extraction.tiebreak`/`extraction.fuzzy` via `forRole(role, ctx.jobId)`, `extraction.verify` via `complete` (a transport-agnostic `ExtractionVerifier` binding). §17 self-judging guard kept.
- **Escalation-mode branch:** decided once/run from `router.resolve('extraction.fuzzy').backend` — `subscription-claude` → **single tier** (no Gate A/B; `EXTRACTION_SUBSCRIPTION_CHUNK_TOKENS` 30k / `EXTRACTION_SUBSCRIPTION_PASS_MAX_TOKENS` 2k; keeps the P0.1 all-failed loud throw); `local`/`cloud` → today's two-tier. Default resolves local → dormant branch.
- **New values:** `ExtractionTier += 'subscription'`; `ExtractionPass += 'llm-subscription'` (`extraction@0.0.1/llm-subscription`); `VerifyState.mode += 'skipped-subscription-extractor'` (mirrors `skipped-cloud-extractor` unless an independent `cloud-api` verifier is configured).
- **Delegate + continuation** (P1.2): `runDelegateExtraction` (`collect → deterministic → load runner_submissions as tier 'subscription' + re-chunk at `EXTRACTION_CLOUD_CHUNK_TOKENS` → resolve → verify → write`); **re-chunk is identical to `read_session`** (pinned by a multi-page equivalence test). `SessionEndOrigin += 'mcp'`; `enqueueExtractionContinuation` (`extract-cont-<sid>-<sha8>`, `{continuation:true}`); **P1.12** `runTaskRetentionSweep` exempts `extract-cont-*` (sweepable) while `extract-<sid>` §6 tokens stay kept-forever.

## Stream B — staged-write + control tools (`mcp/tools/{write,control}.ts`, `skills/{agent,candidate,handler}.ts`)
- **Staged-write:** `propose_extraction` (→ `staged_writes` kind extraction, provenance server-stamped), `submit_extraction_items` (→ `runner_submissions`, deterministic ids; synthesizes the continuation task when unbound), `propose_skill_revision` (validates SKILL.md → enqueues `skill-improvement` with `providedCandidate`; **does NOT skip the §17 gate** — the objective benchmark stays the arbiter).
- **Control:** `run_extraction` (`enqueueExtraction …,'mcp'`), `improve_skill_now`, `run_maintenance` (prune/export), `retry_task` (`queue.retryDeferred`; `TaskRetryError.code`→`ToolError`), `scan_watched_folder`. Deps threaded via `McpReadContext.queue` + `ToolContext.boundTaskId` (missing dep → clean `INVALID_STATE`).
- **Skills `providedCandidate`** — the candidate step uses a provided SKILL.md (version id recomputed via `candidateVersionIdOf`) **before** the no-cloud guard; `testset`/`benchmark`/`write` unchanged.

## Boot fix (caught by the verify stage)
`createExtractionAgent` at boot had **omitted `router`** (both streams left `index.ts`), leaving the whole subscription tier unreachable in the real app. The verify agent added `...(providerRouter !== null ? { router: providerRouter } : {})` (mirroring the skills agent). Confirmed by the orchestrator: `router: providerRouter` now wired into all 4 agent constructions.

## Security (independently confirmed by the orchestrator)
- Full **38-tool** surface (27 read + 4 staged-write + 7 control). `get_runner_status` now live (phase-17).
- **No §5 spine verbs** — grep of every `name:` in `mcp/tools/*` shows zero `approve`/`reject`/`decide`/`undo`/`grant`/`registerAgent`/`setApiKey`/`revealMcpToken`/`installHook`/`watch.add`/`watch.remove`/`rollback`/`improvementSettings`.
- `propose_skill_revision` rides the full benchmark + §17 gate — a subscription-generated candidate cannot self-certify.

## Verification (DoD)
- Orchestrator: lint clean; typecheck clean; isolated `mcp.tools.phase18` + `agents.extraction-subscription` + `agents.verify` = **26 passed**; tool-surface + spine grep as above.
- Verify agent full offline suite: **817 passed | 12 skipped** (+30 vs phase-17); the sole failure the known `security.conformance`-docker load flake, green in isolation (22/22, 14s). 6-point audit CONFIRMED (DEFAULT==TODAY, gates intact, interactive loop, subscription single-tier, P1.12, chunk equivalence).

## Next
- **Phase-19** — scheduled **agent mode** (runner token + dual-auth already in 14b; the `delegate` variant already exists; add the runner spawn-back that connects to loopback MCP + submits via the staged-write tools; tombstone-before-spawn + `--session-id`; `stageAll` default; injection downgrade policy).
- **Phase-20** — hardening & honesty (model-version bookkeeping, review-queue batch UX + Ollama-required preflight, consent dialog + README/website copy, settings validation warnings, CI canary, HARD-override warnings).
