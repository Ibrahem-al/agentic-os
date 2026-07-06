# Opus work log — MCP expansion & subscription reasoner

**Purpose:** a clear, running record of everything implemented by **Opus 4.8** for the MCP-integration + subscription-reasoner feature (branch `feat/mcp-expansion-subscription-reasoner`). Requested by the user on 2026-07-05.

## Model policy (set by the user 2026-07-05 — overrides the IMPLEMENTATION-PROMPT's "all app subagents must be Fable 5" rule)

- **Implementation** is done by **Opus 4.8** — the orchestrator directly at `max` effort, and/or **ultracode Workflows whose agents inherit Opus 4.8**. No Fable for implementation.
- **Fable 5** is reserved for **planning and extremely-deep-reasoning tasks only**, used sparingly (user is near their Fable usage limit). The initial code-grounding (4 read-only Fable agents) was completed before this directive and is reused.
- Every Opus implementation unit is logged below.

## Reference docs
- Feature spec: `../../website/MCP-COVERAGE.md` (§1–8 spec, §9–11 P0/P1/P2 roadmap; §11.1 P0 + §11.4 win on conflict).
- Orchestrator instructions: `../../website/IMPLEMENTATION-PROMPT.md`.
- Plan + phase breakdown: this build = feature phases FP-0…FP-6 (docs phases 14–20). Phase docs live in `docs/phases/phase-14…20-*.md`.

## Grounding (done before implementation, 2026-07-05)
Orchestrator (Opus) read `MCP-COVERAGE.md` (1729 lines, twice), `spec.md` §20/§21, `CLAUDE.md`, `PROGRESS.md` + phase 00–13 history. Four Fable-5 read-only agents produced verified `file:line` grounding reports for: (A) MCP/permissions/config/storage/keychain, (B) extraction pipeline, (C) skills/retrieval/models, (D) triggers/boot/ipc/kernel. Key errata captured in `docs/phases/phase-14-foundation.md`.

---

## Log

| Date | Phase | Unit | How | Files | Result | Commit |
|---|---|---|---|---|---|---|
| 2026-07-05 | — | Plan + grounding | Opus orch + 4 Fable grounding agents (pre-directive) | docs/phases/phase-14-foundation.md, this log | plan approved (full scope, autonomous) | — |
| 2026-07-05 | 14a | Storage & safety primitives (config constants, appdata v7, callLog 9-col, keychain runner token, callBudget, queue TaskRetryAtError+retryDeferred, P0.1 fix) | ultracode Workflow (`wf_d9b84124-151`), Opus agents | config.ts, storage/appdata.ts, mcp/callLog.ts, models/keychain.ts, models/callBudget.ts (new), models/index.ts, triggers/queue.ts, triggers/index.ts, agents/extraction/{types,fuzzy}.ts, agents/index.ts, +7 test files | **done** — lint+typecheck clean, 642 passed / 12 skipped offline (latency benchmark flaky under concurrent load, green in isolation); orchestrator reviewed every critical diff | `phase-14a` |

_(appended per work unit; each phase also gets a `docs/progress/phase-NN-report.md` per the CLAUDE.md protocol.)_

---

## Phase 14a — details (2026-07-05)

Delivered the shared storage/safety primitives of the MCP-expansion foundation. Ran as a 7-agent ultracode Workflow (5 parallel disjoint-file agents → dependent `callBudget` → adversarial verify+fix). The agents' self-reports misattributed authorship (parallel-tree artifact); the orchestrator independently confirmed the real diff + re-ran the full gate + reviewed every P0-critical hunk by eye.

- **`config.ts`** — new `// ── Runner / subscription reasoner ──` section: 15 `RUNNER_*` + `EXTRACTION_SUBSCRIPTION_CHUNK_TOKENS=30k` / `_PASS_MAX_TOKENS=2k` + `RUNNER_WINDOW_MS` (5h) + `RUNNER_MIN_CLI_VERSION` + `RUNNER_TASK_HEADER` + `RUNNER_TOKEN_ENV`. All rule-12 picks, recorded here. No existing constant touched.
- **`storage/appdata.ts`** — migration **v6→v7**: `mcp_calls.session_kind TEXT` (in CREATE + `APPDATA_COLUMN_ADDITIONS`, nullable), new `runner_runs` (17 cols incl. `pid`/`model`/`stderr_tail`/`shadow_cost_usd`) + `runner_submissions` tables + 3 indexes, `APPDATA_USER_VERSION=7`, history comments. `openAppData` backup/refuse-newer/stamp untouched (auto).
- **`mcp/callLog.ts`** — 9-column INSERT with nullable `session_kind` (named columns → order-safe); existing callers unchanged ⇒ NULL.
- **`models/keychain.ts`** — `RUNNER_TOKEN_SECRET`; `ensureRunnerToken()` (get-or-create); `rotateRunnerToken()` **unconditional** (old token dies each boot — the §10.1 zombie-child defense).
- **`models/callBudget.ts`** (new) — `CallBudget` reads the durable `runner_runs` ledger (resume-safe): `callsUsed`, `checkBudget` (default `RUNNER_TASK_MAX_CALLS`, satisfies `BudgetGuard`), `windowUsage` (trailing 5h, ISO-8601 UTC comparison). `CallBudgetExceededError extends SpendCeilingExceededError` (positional super → `instanceof`-compatible so `verify.ts`'s halt catch works unchanged). `RunnerQuotaError` (for FP-3). **Cross-phase contract: FP-3's runner MUST write `runner_runs.started_at` as `Date.toISOString()`** for `windowUsage`'s lexicographic time compare.
- **`triggers/queue.ts`** — `TaskRetryAtError` (re-pend at a known time, `roundExecs -= 1` so **no §20 attempt is consumed**) branch in `recordFailure` before the retry-index logic; public `retryDeferred(taskId)` (the `retry_task` backend) with full guards (not-found / not-deferred / approval-parked / no-handler / already-queued / corrupt-payload); `TaskRetryError{code}` mapping to the MCP `NOT_FOUND`/`INVALID_STATE` vocab without importing mcp.
- **P0.1 (`agents/extraction/{types,fuzzy}.ts`)** — `ExtractionUnavailableError extends ExtractionError` (code `UNAVAILABLE`, retryable, NOT fatal); thrown when `totalCalls>0 && failedCalls===totalCalls` **before the final local return** (after both escalation gates, so a working cloud rescue returns first and is never killed; empty transcript still skips quietly). Distinct name+code so the session-end "nothing to extract" path can't swallow it → the queue defers instead of tombstoning an unlearned session.

Tests added across 7 files (appdata v7 fresh+upgrade+backup+refuse-newer; callLog 9-col; keychain ensure/rotate; callBudget count/ceiling/instanceof/window; queue TaskRetryAtError-no-attempt + retryDeferred + guards; extraction P0.1 loud-fail incl. real-queue-handler-defers-not-done).
