# Phase 14 — MCP-expansion foundation (shared spine)

**Feature:** MCP integration + subscription-reasoner (spec: `../../website/MCP-COVERAGE.md`; conflicts resolved by §11.1 P0 + §11.4). Prime directive: **ADD, never REMOVE** — every existing path stays wired; a default install behaves identically to today.

This phase lands the **shared/hot files** that all later fan-out phases depend on, **serially, committed first** (CLAUDE.md concurrency rule + IMPLEMENTATION-PROMPT "Foundation"). No fan-out until this is green + committed.

Split into two serialized Fable-5 subagent commits:
- **14a — storage & safety primitives** (no MCP/permission coupling).
- **14b — MCP dispatch spine** (permissions, tool registry, server dispatch, boot). Depends on 14a (runner token, callBudget).

All values are **rule-12 recorded picks** unless in spec §20. Every constant lives in `config.ts`.

---

## 14a — storage & safety primitives

### A1. `config.ts` — new constants (flat `export const`s under a new `// ── Runner / subscription reasoner ──` banner)
Verified: config.ts is a flat module of `export const`s; add with the doc-comment convention `// not §20 — rule-12 pick, recorded in phase-14 report`.

```
RUNNER_MODEL_DEFAULT = 'sonnet'
RUNNER_COMPLETION_TIMEOUT_MS = 120_000
RUNNER_AGENT_TIMEOUT_MS = 900_000
RUNNER_MAX_TURNS_AGENT = 40
RUNNER_SESSION_MAX_TOOL_CALLS = 60
RUNNER_TASK_MAX_CALLS = 40
RUNNER_HEALTH_TTL_MS = 900_000
RUNNER_CONCURRENCY = 1
RUNNER_LANES = 2
RUNNER_COMPLETION_CONCURRENCY = 1
RUNNER_LIVE_SESSION_MAX_CALLS = 20
RUNNER_WINDOW_TOKEN_BUDGET = 300_000
RUNNER_QUOTA_FRACTION = 0.5
RUNNER_WINDOW_MS = 5 * 60 * 60 * 1000        // 5-hour rolling window (rule-12)
RUNNER_MIN_CLI_VERSION = '1.0.0'             // pin; refine at FP-3 against installed CLI
EXTRACTION_SUBSCRIPTION_CHUNK_TOKENS = 30_000
EXTRACTION_SUBSCRIPTION_PASS_MAX_TOKENS = 2_000
```
Also add the task-header + id-family string constants used later (keep names centralized):
```
RUNNER_TASK_HEADER = 'X-Agentic-Os-Runner-Task'
RUNNER_TOKEN_ENV = 'AGENTIC_OS_RUNNER_TOKEN'
```

### A2. `storage/appdata.ts` — migration **v6 → v7** (consts are module-private; edit in place)
Verified anchors: `APPDATA_SCHEMA` (:30-215, 12 `CREATE TABLE IF NOT EXISTS`), `APPDATA_COLUMN_ADDITIONS` (:229-233, `{table,column,ddl}[]`), `APPDATA_USER_VERSION = 6` (:217). `openAppData` already does backup-before-migration (VACUUM INTO), refuses newer, stamps version.
1. `mcp_calls` (:60-71): add `session_kind TEXT` to the CREATE (fresh installs) **and** push `{ table: 'mcp_calls', column: 'session_kind', ddl: 'ALTER TABLE mcp_calls ADD COLUMN session_kind TEXT' }` onto `APPDATA_COLUMN_ADDITIONS` (existing installs). Nullable (no DEFAULT needed since nullable).
2. Append to `APPDATA_SCHEMA`:
   - `runner_runs(id TEXT PRIMARY KEY, task_id TEXT NOT NULL, mode TEXT NOT NULL, model TEXT, claude_session_id TEXT, transport_session_id TEXT, pid INTEGER, started_at TEXT NOT NULL, duration_ms INTEGER, num_turns INTEGER, input_tokens INTEGER, output_tokens INTEGER, shadow_cost_usd REAL, stderr_tail TEXT, is_error INTEGER, error TEXT, exit_code INTEGER)` + index on `(task_id)` and `(started_at)`.
   - `runner_submissions(id TEXT PRIMARY KEY, task_id TEXT NOT NULL, session_id TEXT NOT NULL, kind TEXT NOT NULL, payload_json TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now')))` + index on `(task_id)`.
3. `APPDATA_USER_VERSION` 6 → 7; extend the version-history comment (:341-346) with "v6 → v7: mcp_calls.session_kind; runner_runs; runner_submissions".
Backup / refuse-newer / stamp happen automatically. (spec §10.2, P0.5)

### A3. `mcp/callLog.ts` — `McpCallLog` → 9 bound columns
Verified: INSERT (:49-52) binds exactly 8; `McpCallRecord` (:34-43); `record()` (:55-70). Add `session_kind` (nullable): extend the prepared INSERT, the `McpCallRecord` type (`sessionKind?: string | null`), and bind `record.sessionKind ?? null`. Default callers (interactive) pass nothing ⇒ NULL. (P0.5)

### A4. `models/keychain.ts` — runner token
Verified: `ensureMcpBearerToken` (:119-125), `ensureSessionEndHookToken` (:128-134), `KnownSecretName` union (:30), atomic persist. Add:
- `RUNNER_TOKEN_SECRET = 'runner.token'` + extend `KnownSecretName`.
- `ensureRunnerToken(): string` — clone `ensureMcpBearerToken` verbatim.
- `rotateRunnerToken(): string` — **unconditional** `randomBytes(32).toString('base64url')` + `setSecret` + return (no read-existing). (P0.3 / §10.1)

### A5. `models/callBudget.ts` (**new**) — the $-ceiling replacement
Reads `runner_runs` (durable across resume), not memory (§9.3/P0.2).
- `class CallBudgetExceededError extends SpendCeilingExceededError` — `super(taskId, callsUsed, ceilingCalls)` (positional ctor verified spend.ts:72-83); override `name`+`message` to say "calls"; keep honest `calls`/`ceilingCalls` fields. Satisfies existing `instanceof SpendCeilingExceededError` catch sites (verify.ts:170) with zero edits.
- `class CallBudget` over `{db}`:
  - `callsUsed(taskId): number` = `SELECT count(*) FROM runner_runs WHERE task_id = ?`.
  - `checkBudget(taskId, ceilingCalls = RUNNER_TASK_MAX_CALLS): void` — throw `CallBudgetExceededError` at `used >= ceiling`. **Structurally satisfies `BudgetGuard`** (retrieval/types.ts:30-32 `checkBudget(taskId, ceilingUsdOverride?)`), so it drops into `RetrieveOptions.spendMeter` and `meteredComplete`'s seam.
  - `windowUsage(nowMs): { inputTokens, outputTokens }` = SUM over trailing `RUNNER_WINDOW_MS` (for FP-3 quota self-throttle; define now, use later).
- `class RunnerQuotaError extends Error` (thrown at FP-3; define the class here for shared import).

### A6. `triggers/queue.ts` — `TaskRetryAtError` + `retryDeferred`
Verified: `recordFailure` (:438) branch order (`KernelApprovalPendingError` → `TaskFatalError` → retry/backoff → deferred); `roundExecs` pre-incremented at `runTask` (:406); `onApprovalDecided` re-pending shape (:308-333).
- `class TaskRetryAtError extends Error { constructor(readonly retryAtUnixMs: number, message?) }` near `TaskFatalError` (:58); export via barrel (`triggers/index.ts` :7-15).
- In `recordFailure`, **between the `TaskFatalError` branch (ends :459) and `const retryIndex` (:461)**:
  ```ts
  if (err instanceof TaskRetryAtError) {
    task.roundExecs -= 1               // un-consume the pre-increment
    task.notBeforeUnixMs = err.retryAtUnixMs
    this.pending.set(task.id, task)
    this.updateStatus.run('pending', err.retryAtUnixMs, null, message, nowIso(), task.id)
    return
  }
  ```
- `retryDeferred(taskId): { taskId; status: 'pending' }` — new public method after `onApprovalDecided` (:333), mirroring its re-pending shape: require row `status='deferred'` & `kind` in `this.handlers` & id not in `pending`/`current` (else throw an INVALID_STATE-mappable error / return a discriminated result); `updateStatus.run('pending', null, null, null, nowIso(), id)`; rebuild a fresh `MemTask` (`roundExecs:0, seq:this.seqCounter++, enqueuedAtMs:Date.now()`, payload parsed like `start()` :227-234); `pending.set`; `poke()`. (P0.7 / §4.E `retry_task`)

### A7. `agents/extraction/` — **P0.1 silent-loss fix**
Verified: `runFuzzyExtraction` never throws on total failure; `TierRun.totalCalls/failedCalls` exist (fuzzy.ts:365-366) but the returned state doesn't; the correct throw site is **immediately before the final local return at fuzzy.ts:587** (a working cloud rescue returns earlier at :567-577).
- Define `class ExtractionUnavailableError extends ExtractionError` (retryable, NOT `TaskFatalError`) in `extraction/types.ts` after `ExtractionError` (:84); export via `agents/index.ts`.
- In `fuzzy.ts`, **before the final `return { tier: 'local', … }` at :587**: `if (localRun.totalCalls > 0 && localRun.failedCalls === localRun.totalCalls) throw new ExtractionUnavailableError(...)`. Preserve the "empty transcript ⇒ skip quietly" path (`totalCalls === 0`).
- Confirm `isNothingToExtract` (sessionEnd.ts:225, private) does NOT match the new error (different name/code) so retries actually run. (P0.1 / §9.5)
- Add a regression test: all-calls-fail extraction ⇒ throws ⇒ task deferred, not `done`.

### 14a DoD
`npm run lint && npm run typecheck && npm test` green (offline). New tests: v7 migration (fresh + 6→7 upgrade, backup taken, refuse-newer still holds); callLog 9-col round-trip; runner-token ensure/rotate (rotate changes value); CallBudget count/ceiling + `instanceof SpendCeilingExceededError`; queue `TaskRetryAtError` (no attempt consumed) + `retryDeferred`; P0.1 all-fail throw ⇒ deferred.

---

## 14b — MCP dispatch spine (depends on 14a)

### B1. `mcp/tools.ts` — error code + composable registry + ctx budget
Verified: `ToolErrorCode` (:29) lacks `INVALID_STATE`; `server.ts:371` emits non-union `'INTERNAL'`; `MCP_TOOLS` (:347) `readonly McpToolDef[]`; `ToolContext` (:43-57) has no `spendMeter`.
- `ToolErrorCode += 'INVALID_STATE' | 'INTERNAL'` (fold in the server's ad-hoc `'INTERNAL'`).
- **Refactor `MCP_TOOLS` into a composable registry**: create `mcp/tools/read.ts`, `mcp/tools/write.ts`, `mcp/tools/control.ts`, each exporting a `readonly McpToolDef[]`. Move the existing 7 tools into them (get_context/search_memory/list_skills/get_skill → read; propose_correction → write; ingest_document/ingest_codebase → control) with their zod consts + handlers + the shared `parse()`/`jsonSchema()` helpers (export the helpers + `McpToolDef`/`ToolContext`/`ToolError` from a `mcp/tools/shared.ts` or keep `tools.ts` as the barrel). `MCP_TOOLS = [...READ_TOOL_DEFS, ...WRITE_TOOL_DEFS, ...CONTROL_TOOL_DEFS]`. **Behavior identical** — phase-05 tests for the 7 tools must stay green.
- `ToolContext += spendMeter?: BudgetGuard` (P0.2 plumbing; filled at boot in 14b/B4).

### B2. `security/permissions.ts` — **P0.6** scope enforcement + tool sets + profiles
Verified: `READ_TOOLS` (:62), `STAGING_TOOLS` (:64), no `CONTROL_TOOLS`; ingest gated by inline name check (:173-175); `case 'mcp-call'` (:166-177) skips `cap.tools` **and** allow-defaults unknown names (:176); `case 'tool-call'` (:158-164) consults `cap.tools`; `mcp:` profile (:339-353) tools=7 + `gates.write:'allow'`.
- Extend the sets to the **full planned surface** (names only; handlers land in later phases — a name with no handler is harmless, dispatcher answers NOT_FOUND):
  - `READ_TOOLS +=` list_sessions, read_session, get_pending_work, get_skill_full, get_skill_signal, memory_counts, list_nodes, get_node, list_staged_writes, get_staged_write, list_approvals, list_injection_flags, list_audit_log, list_traces, get_trace, get_usage, list_tasks, get_task, get_triggers_status, list_watched_folders, get_app_status, get_settings_summary, get_runner_status.
  - `STAGING_TOOLS +=` propose_extraction, propose_skill_revision, submit_extraction_items.
  - **new** `CONTROL_TOOLS =` run_extraction, improve_skill_now, run_maintenance, retry_task, scan_watched_folder (+ ingest_document, ingest_codebase moved into it).
- **P0.6 fix in `case 'mcp-call'`** (top of the branch, before tier logic):
  ```ts
  if (!cap.tools.includes(action.name) && !cap.tools.includes('*')) return this.block(action, `tool '${action.name}' not in agent's declared tools`)
  ```
  Then: READ/STAGING → auto-allow; CONTROL → `gate(...,'write',{tool})`; **remove the allow-by-default fallthrough at :176** → replace with `return this.block(...)` for names not in any set.
- `mcp:` profile `tools` → the full surface (so interactive behavior is unchanged with the cap.tools check now live).
- **new** `mcp-runner:` prefix profile in `registerInternalAgents` (:309): `tools = [...READ_TOOLS, ...STAGING_TOOLS]` names only, **no** standing grants (reads/staging auto-allow), `maxSpendUSD: 0`.
- Note prefix hygiene: `'mcp-runner:'.startsWith('mcp:')` is false — clean separation (verified).

### B3. `mcp/server.ts` — dispatch spine (auth, tagging, allowlist, budget, gauge split)
Verified: `dispatchTool` (:330) → `deps.executor.execute('mcp:${sessionId}', {kind:'mcp-call',...})`; auth `tokenMatches` vs `deps.bearerToken` (:203-208, `tokenMatches` private :97-101); session lookup by header is **token-blind** (:210-211); `McpSession = {transport, server}` (:63-66); `createSession` (:292-309); `inflight` single gauge (:127/:140-142/:339/:379); `AgenticOsMcpServerDeps` (:42-61) has no `runnerToken`/`spendMeter`; `callLog` internal (:131).
- `AgenticOsMcpServerDeps += runnerToken: string`, `spendMeter?: BudgetGuard` (or a `CallBudget`).
- **Dual-token auth + session-kind tag:** accept `deps.bearerToken` **or** `deps.runnerToken` (both timing-safe via `tokenMatches`). On session create, record `sessionKind: 'interactive' | 'runner'` on the `McpSession` (widen the type) from which token authed the *initialize*. **Re-verify per request**: a request's token must match the kind bound to the session id it addresses (close the token-blind gap) — else 401/PERMISSION_DENIED.
- **`X-Agentic-Os-Runner-Task` binding:** honored **only** on runner-token sessions; store `boundTaskId` on the session. Ignored (or 400) on interactive sessions. (P0.6 #3)
- **Server-side template allowlist:** in `dispatchTool`, for runner sessions, consult a per-session allowlist derived from the bound task's template; a tool outside it ⇒ `ToolError('PERMISSION_DENIED')` even if client `--allowedTools` was tampered. (Template registry can be a simple map keyed by task-kind; agent-mode templates land FP-5 — for now runner sessions get READ+STAGING.)
- **Runner tool-call budget:** for runner sessions, if that session's `mcp_calls` count ≥ `RUNNER_SESSION_MAX_TOOL_CALLS` ⇒ structured `ToolError`. Enforce inside the `try` (after inflight++), so the `finally` still logs.
- **Agent id:** runner sessions execute as `mcp-runner:${transportSessionId}` (selects the new profile); interactive stay `mcp:${sessionId}`.
- **`session_kind` on the call log:** pass `sessionKind === 'runner' ? 'runner' : null` into `callLog.record` (A3).
- **Gauge split (§3.6a/P0.9):** replace the single `inflight` with `inflightInteractiveCalls` (interactive only — drives yields) + `inflightRunnerCalls` (observability). Keep a combined `inflightCalls` getter if referenced elsewhere, but expose `inflightInteractiveCalls`. Inc/dec by session kind in `dispatchTool` (:339/:379).

### B4. `src/main/index.ts` — boot wiring (owned/serialized across all phases)
Verified: MCP server constructed idx:303-316 (deps list); `bootKernel` yield point idx:267 `createInflightYield(() => mcpServer?.inflightCalls ?? 0)`; `bootTriggers` idx:432 `shouldYield: () => (mcpServer?.inflightCalls ?? 0) > 0`; `will-quit` idx:655-695 stops MCP first (:663), `queue.stop()` (:674).
- **Gauge split:** idx:267 → `() => mcpServer?.inflightInteractiveCalls ?? 0`; idx:432 → `() => (mcpServer?.inflightInteractiveCalls ?? 0) > 0`.
- **Runner token dep:** pass `runnerToken: keychain.ensureRunnerToken()` to the MCP server ctor (idx:303). **Rotate on boot:** call `keychain.rotateRunnerToken()` before constructing the server so a zombie's token is dead (P0.3/§10.1) — i.e. rotate then read the rotated value. (Boot-sweep of stale `runner/*.mcp.json` + zombie kill-on-boot land at FP-3 with the runner module.)
- **Shared `SpendMeter`/budget for MCP (P0.2):** construct a `CallBudget` (or reuse a `SpendMeter`) and pass as `spendMeter` to the MCP server deps so `ToolContext.spendMeter` is populated; the `getContext` live-path budget wiring (`taskId: 'live:'+sessionId`, `RUNNER_LIVE_SESSION_MAX_CALLS`) lands when `read.ts`'s `getContext` is refactored (FP-1) — for now just make the dep available.

### 14b DoD
`npm run lint && npm run typecheck && npm test` green. New/updated tests: the 7 existing tools still pass through the split registry; P0.6 — a principal whose profile lacks a tool is blocked on `mcp-call` (and the unknown-name fallthrough now blocks); `mcp-runner:` profile scoped to READ+STAGING; dual-token auth + per-request kind re-check (runner token can't ride a user session id and vice versa); `RUNNER_SESSION_MAX_TOOL_CALLS` budget trips; gauge split (runner calls don't drive interactive yield). Boot smoke green.

---

## After phase 14
Commit `phase-14: MCP-expansion foundation`. Then fan out (phases 15–20) on disjoint files per the plan. `index.ts` and `ipc.ts` remain serialized single-owner.
