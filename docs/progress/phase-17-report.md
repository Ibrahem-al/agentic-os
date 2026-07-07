# Phase 17 report — the runner: completion mode + circuit breaker (§8 Phase 3 / FP-3)

**Branch:** `feat/mcp-expansion-subscription-reasoner`. Opus 4-stage ultracode workflow (`wf_a254d46c-27b`): runner module + fake-`claude -p` harness → boot integration + tests → renderer → verify. Orchestrator reviewed the boot injection + confirmed no dependency creep. **This phase completes the vertical slice** (subscription reasoning via completion mode + the budget circuit breaker, with silent local/API fallback).

**Prime directive:** ADD, never REMOVE. **Ships OFF by default** (`runner.enabled=false` → `isHealthy()` false → subscription unavailable → nothing spawns `claude` → a default/keyless install is byte-for-byte local). **No new npm dependency** (`child_process` + `process.execPath` only).

## What was built
- **`src/main/runner/` (7 new files)** — `types.ts`; `binary.ts` (resolution: env `AGENTIC_OS_RUNNER_BINARY` → `settings.runner.binaryPath` → well-known paths → PATH; `.mjs`/`.js`→`process.execPath` test seam; win `.cmd`→`cmd.exe /d /s /c`, **never `shell:true`**; `RUNNER_MIN_CLI_VERSION` gate); `spawn.ts` (argv-array spawn, POSIX-detached, stdin prompt, **process-tree watchdog kill**, `runner.spawn` telemetry span, defensive envelope parse, `runner_runs` row with **ISO-8601 UTC `started_at`** — the phase-14 `CallBudget.windowUsage` contract); `health.ts` (TTL cache, non-blocking refresh, single `classifyRunnerFailure` auth/quota+reset/not-installed/other); `lanes.ts` (live+background, background yields); `completion.ts` (the `subscriptionComplete` fn: `checkBudget` → quota self-throttle → `claude -p --output-format json --max-turns 1`, tools stripped, no MCP); `index.ts` (`Runner` facade).
- **Boot (`index.ts`)** — one `Runner` in `bootKernel` over ONE shared `CallBudget`; **injects `subscriptionComplete=runner.complete` + `runnerHealthy=()=>runner.isHealthy()` into the phase-16 `ProviderRouter`** (were unset). `will-quit`: `killChildren()` runs **FIRST**, before `mcpServer.stop()`. Boot: `sweepZombies()` (image-verified, **never by pid alone**) + `sweepStaleRunnerMcpConfigs()`.
- **`get_runner_status`** (deferred from phase-15) — `reads/runner.ts` (health snapshot + latest `runner_runs` + agent-mode tombstone count) + the tool. `get_usage`'s runner section now has data. New `runner.status` + `runner.testConnection` IPC + DTOs.
- **Renderer** — SettingsPanel "subscription runner" section (enable toggle + model select via `settings.save`, test-connection canary, status line); `App.tsx` auth-expired/quota banner (20s poll, renders `null` by default → DOM unchanged); `kit.tsx` `Toggle`; health→`statusColor` mapping. Honest scope copy included. Consent dialog + sparkline + run-history deferred to phase-20.
- **Test seam:** `tests/fixtures/fake-runner.mjs` — standalone marker-dispatched `claude -p` emulator (ok/auth/quota/quota-429/error/drift-*/hang/`--version`).

## Key decisions
- **The circuit breaker ships here, before any scheduled use** (§7): `CallBudget.checkBudget` (throws `CallBudgetExceededError extends SpendCeilingExceededError` before the `RUNNER_TASK_MAX_CALLS`-th spawn) + wall-clock watchdog + quota self-throttle (`windowUsage` vs `RUNNER_WINDOW_TOKEN_BUDGET × RUNNER_QUOTA_FRACTION`).
- **`runner_runs` row lifecycle IS the zombie-sweep contract** — INSERT with pid+`started_at` before the await, finalize on exit; a crash mid-run leaves exactly the `is_error IS NULL AND exit_code IS NULL` signature §10.1 sweeps; finished rows always set `is_error`.
- **Async health probes** — `isHealthy()` (called per-route by the router) kicks a non-blocking refresh; version/npm probes never block the Electron main thread.
- **One shared `CallBudget`** between runner and router (durable over `runner_runs`, resume-safe).
- Health `state` is the full 5-value union (incl. `quota-exhausted`) for the banner; DTO enriched with `versionOk`+`lastError`.

## Deferred (intentional)
- **Agent mode** (loopback MCP connect-back, runner token, template allowlist tightening, tombstones) → **phase-19**.
- **Extraction subscription tier** (`extraction.fuzzy`→subscription single-tier, `llm-subscription` pass, `skipped-subscription-extractor`) → **phase-18**.
- Consent dialog + quota sparkline + run-history table → **phase-20**.

## Verification (DoD)
- Orchestrator independent run: lint clean; typecheck clean; isolated runner tests (`runner.binary` 16 + `runner.health` 22 + `runner.completion` 13 + `reads.runner-status` 4) = **55 passed**. `package.json`/lock diff **empty**.
- Verify agent full offline suite: **787 passed | 12 skipped**, exit 0 (no load flakes even fired; +55 vs phase-16; skip count unchanged → nothing newly gated).
- Audit CONFIRMED (6 pts): DEFAULT==TODAY; circuit breaker (budget/watchdog/quota); zero spend rows + ISO `runner_runs`; no `shell:true` / fake via `execPath` / status surfaces path+state; `will-quit` kills child before mcp stop / `sweepZombies` never by pid alone; no new dep.

## Vertical-slice milestone reached
Foundation P0 fixes + `ProviderRouter`/fallback seam + read-tool surface + a tested end-to-end **subscription-backed reasoning path with automatic local/API fallback** (completion mode) are all committed and green. Everything ahead (extraction subscription tier, agent mode, hardening) is additive on this base.

## Next
- **Phase-18**: extraction subscription tier (route `extraction.fuzzy/tiebreak/verify` through the router with the single-tier escalation branch) + the staged-write/control MCP tools (`propose_extraction`, `propose_skill_revision`, `submit_extraction_items`, `run_extraction`, `improve_skill_now`, `run_maintenance`, `retry_task`, `scan_watched_folder`) — after which an interactive Claude can drive the whole learning loop on the subscription.
