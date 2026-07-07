# Phase 14 report — MCP-expansion foundation (shared spine)

**Feature:** MCP integration + subscription-reasoner (`website/MCP-COVERAGE.md`; §11.1 P0 + §11.4 win on conflict). **Branch:** `feat/mcp-expansion-subscription-reasoner`. Built by Opus 4.8 via two ultracode Workflows (14a `wf_d9b84124-151`, 14b `wf_b6ddf072-505`); every P0-critical diff reviewed by the orchestrator; see `OPUS-WORKLOG.md`.

Prime directive held: **ADD, never REMOVE.** A default install and all 7 existing MCP tools behave identically to today. This phase lands only the shared/hot spine every later fan-out phase depends on — committed before any fan-out.

## What was built

### 14a — storage & safety primitives (commit `acffda5`)
- **`config.ts`** — new `Runner / subscription reasoner` section: 15 `RUNNER_*` + `EXTRACTION_SUBSCRIPTION_CHUNK_TOKENS`/`_PASS_MAX_TOKENS` + `RUNNER_WINDOW_MS` + `RUNNER_MIN_CLI_VERSION` + `RUNNER_TASK_HEADER` + `RUNNER_TOKEN_ENV`. Rule-12 picks.
- **appdata v7** (`storage/appdata.ts`) — `mcp_calls.session_kind` (CREATE + `APPDATA_COLUMN_ADDITIONS`, nullable), `runner_runs` (17 cols) + `runner_submissions` tables + 3 indexes, `APPDATA_USER_VERSION=7`. Backup/refuse-newer/stamp untouched (automatic).
- **`mcp/callLog.ts`** — 9-col INSERT with nullable `session_kind` (named columns → order-safe; existing callers → NULL).
- **`models/keychain.ts`** — `ensureRunnerToken` (get-or-create) + `rotateRunnerToken` (**unconditional** — old token dies each boot).
- **`models/callBudget.ts`** (new) — `CallBudget` over the durable `runner_runs` ledger; `CallBudgetExceededError extends SpendCeilingExceededError` (positional super → `instanceof`-compatible); `RunnerQuotaError`.
- **`triggers/queue.ts`** — `TaskRetryAtError` (re-pend at a known time, `roundExecs -= 1` so **no §20 attempt consumed**) + `retryDeferred(taskId)` (the `retry_task` backend) + `TaskRetryError{code}`.
- **P0.1** (`agents/extraction/{types,fuzzy}.ts`) — `ExtractionUnavailableError`; thrown when every model tier fails **before the final local return** (after both escalation gates, so a working cloud rescue is never killed; empty transcript still skips quietly). Never tombstones an unlearned session.

### 14b — MCP dispatch spine (this commit)
- **`mcp/tools.ts` → composable registry** — split into `mcp/tools/{shared,read,write,control}.ts`; `tools.ts` is now an import-compatible barrel (`MCP_TOOLS = [...READ,...WRITE,...CONTROL]`, original 7-tool order). `ToolErrorCode += 'INVALID_STATE' | 'INTERNAL'`. `ToolContext += spendMeter?: BudgetGuard`.
- **P0.6 scope enforcement** (`security/permissions.ts`) — `case 'mcp-call'` now consults `cap.tools` FIRST and **fail-closes** unknown names (the pre-14b allow-by-default hole is gone). `READ_TOOLS`/`STAGING_TOOLS`/`CONTROL_TOOLS` extended to the full §4.G surface and **exported** (single source of truth). `mcp:` profile declares the full surface (interactive unchanged); new `mcp-runner:` profile = READ+STAGING only, `maxSpendUSD:0`.
- **`mcp/server.ts` dispatch spine** — dual-token auth (bearer **or** runner, timing-safe); session `kind` fixed at initialize + **per-request kind re-check** (closes the token-blind gap); `X-Agentic-Os-Runner-Task` binding (400 on interactive); **server-side runner allowlist** (READ∪STAGING, independent of client `--allowedTools`); per-session `RUNNER_SESSION_MAX_TOOL_CALLS` ceiling (logged refusal); agent id `mcp-runner:<sid>`; `session_kind` on the call log; **gauge split** `inflightInteractiveCalls`/`inflightRunnerCalls` (+ back-compat `inflightCalls`).
- **`index.ts` boot** — both yield drivers read `inflightInteractiveCalls`; `rotateRunnerToken()` at boot → `runnerToken` dep; shared `CallBudget` → `spendMeter` dep (populates `ToolContext.spendMeter`).

## Key decisions (rule-12, recorded)
- **`CallBudgetExceededError extends SpendCeilingExceededError`** — reuses every existing `instanceof SpendCeilingExceededError` halt catch (e.g. `verify.ts`) with zero edits; parent's numeric slots carry `callsUsed`/`ceilingCalls`.
- **Distinct error codes** on runner guards — allowlist violation → `PERMISSION_DENIED`; call-ceiling → `INVALID_STATE`.
- **Runner-task header on an interactive session → 400** (a default interactive client never sends it, so today's behavior is untouched).
- **Exported the permission tool-name sets** so `server.ts`'s runner allowlist derives from them — the dispatch allowlist and the §13 engine agree by construction (two layers, one source).
- Doc-comment style: a section-level rule-12 note + descriptive per-constant comments (config.ts house style), not 19 identical notes.

## Deferred to later phases (intentional)
- **will-quit child-tree kill / boot-sweep of stale `runner/*.mcp.json` / zombie kill-on-boot** → FP-3 (they need the runner process registry). Boot rotates the runner token now (the token-lifetime half of the zombie defense).
- **`getContext` live-path budget wiring** (`taskId: 'live:'+sessionId`, `RUNNER_LIVE_SESSION_MAX_CALLS`) → FP-1. The `spendMeter` dep is available in `ToolContext`; `getContext` behavior is unchanged this phase.
- **Agent-mode per-task templates** that narrow the runner allowlist below READ+STAGING → FP-5.
- New tool **handlers** (read tools → FP-1/phase-15; staged-write + control → FP-4/phase-18). Their **names are already tiered** in permissions, so they gate correctly the moment a handler lands.

## Instructions the next phases need
- **Cross-phase contract:** FP-3's runner MUST write `runner_runs.started_at` as `Date.toISOString()` (ISO-8601 UTC) — `CallBudget.windowUsage` relies on lexicographic time comparison.
- **Read tools (phase-15)** fill `mcp/tools/read.ts` (the seam exists) and should extract the ~9–10 inline IPC read queries (memory.counts/list/node, skills.detail, spend.summary, tasks.list, traces.recent/spans, review.flags.list, triggers.status/settings.get assembly) into a shared `reads` module consumed by both `ipc.ts` and `tools/read.ts`. Also wire `getContext`'s live-path budget here (P0.2 completion) now that `ToolContext.spendMeter` is populated.
- **Provider seam (phase-16)** fills `mcp/tools/write.ts`? No — write/control tools are FP-4/phase-18. Phase-16 = `models/provider.ts` + settings; `ModelSettings` new `reasoning`/`runner` sections MUST also be merged in `ipc.ts`'s `settings.save` field-list (it silently drops unknown keys) + `SettingsDto`.
- `mcp/tools.ts` is a barrel — new tools go in the tier file (`read.ts`/`write.ts`/`control.ts`), never re-touch `tools.ts`/`server.ts`/`permissions.ts`.

## Verification (DoD)
- `npm run lint` → clean. `npm run typecheck` → clean.
- `npm test` (offline) → **652 passed | 12 skipped | 1 flaky** (the `retrieval.latency` p50<500ms benchmark under 70-file concurrency; confirmed **green in isolation** — 14b touches no retrieval code; documented flake since phase-03). 12 skips = OLLAMA/live-gated.
- +37 tests vs phase-13's 618 (appdata v7, callLog, keychain, callBudget, queue retry, extraction P0.1, permissions P0.6, server dual-token/allowlist/budget/gauge).
- Both security-critical diffs (permissions P0.6, server auth spine) reviewed line-by-line by the orchestrator.
