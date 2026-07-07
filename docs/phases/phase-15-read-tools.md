# Phase 15 — MCP read-tool surface (§8 Phase 1; FP-1)

Add the §4 READ tools. Pure adapters over existing queries — no schema changes, no risk. Every read tool rides the existing dispatch chokepoint (kernel span + `mcp_calls` row, added automatically by `dispatchTool`); each just implements `handle(args, ctx)`: zod-parse input → query via `ctx` → return the DTO. Permission names already tiered in `READ_TOOLS` (phase-14b), so they auto-allow.

**Prime directive:** ADD, never REMOVE. The dashboard IPC read handlers must behave **identically** after the DRY refactor.

## Design: one shared reads module, two consumers
Extract the inline IPC read queries into `src/main/reads/` (new), consumed by **both** `src/main/ipc.ts` (refactored to call them — behavior-identical) and `src/main/mcp/tools/read.ts` (the new tools). This is the §8-Phase-1 intent ("IPC handlers refactored into shared functions consumed by both").

Suggested files (agent may adjust, keep cohesive): `reads/memory.ts`, `reads/skills.ts`, `reads/review.ts`, `reads/observability.ts`, `reads/tasks.ts`, `reads/sessions.ts`, `reads/status.ts`, `reads/index.ts` (barrel). Each fn takes `(db | engine | deps, args)` and returns a plain DTO. Renderer-safe DTO types already live in `src/shared/ipc.ts` — reuse them where they match; define new output shapes locally for tools with no dashboard equivalent.

## The tools (22 this phase — `get_runner_status` deferred to phase-17)
Map each per MCP-COVERAGE §4 (verified against the grounding):

**4.A session/extraction**
- `list_sessions` — `mcp_calls` aggregation (the `InactivityMonitor.selectQuiet` shape minus the quiet filter) LEFT JOIN `tasks.id='extract-'||session_id` + `MATCH (s:Session)`. Exclude `session_kind='runner'` rows from "pending".
- `read_session` — server resolves the transcript path from the `extract-<sid>` task payload (`transcriptPath`) — **never from caller input** (no arbitrary-file read). `selectCalls` over `mcp_calls` + `parseTranscriptFile`/`parseTranscriptContent` + `chunkTranscript(text, EXTRACTION_CLOUD_CHUNK_TOKENS, estimatingTokenCounter())` for paging + regex `injection_findings` via the scanner's `INJECTION_PATTERNS`. Wrap transcript in `{ untrusted: true, ... }`. tool_result bodies stay unrendered (parser already skips them).
- `get_pending_work` — inactivity query + `collectSignal` + `getSkillSettings` cursor + `listOpenDriftWatches` + `listStagedWrites({status:'staged'})` + `listApprovals({status:'pending'})`.

**4.B skills** — `get_skill_full` (the `skills.detail` cypher set + `getSkillSettings` + `listImprovements` + `latestStandingAdoption`), `get_skill_signal` (`collectSignal` + `hasPendingReview`).
> `collectSignal`, `hasPendingReview`, `scanDrift` are **module-private in `agents/skills/gate.ts`** — export them (and via `agents/index.ts`) for `get_skill_signal`/`get_pending_work`.

**4.C memory** — `memory_counts` (per-`NODE_TABLES` count), `list_nodes` (`memory.list` DISPLAY_PROPS projection), `get_node` (`memory.node` inspector, embedding never shipped).

**4.D review/observability** — `list_staged_writes` (+ `proposed_by_me` filter on the session's proposer stamp), `get_staged_write` (+ `include_diff` via `renderStagedWriteDiff`), `list_approvals`, `list_injection_flags`, `list_audit_log` (never expose `audit.undo`), `list_traces`/`get_trace`, `get_usage` (spend.summary queries + a `runner_runs` aggregation; `shadowCostUsd` labeled an estimate; runner section empty until runners run).

**4.E tasks/triggers** — `list_tasks`, `get_task` (+ `runner.getJob('<taskId>-wf')` when `include_workflow`), `get_triggers_status`, `list_watched_folders`.

**4.F status** — `get_app_status` (`app.status` + `ollama.status()`), `get_settings_summary` (sanitized — presence booleans only, **never key material**; `reasoning`/`runner` sections optional until phase-16 defines them — read whatever `loadModelSettings` returns).

## Also this phase: P0.2 live-path budget completion
`getContext` now lives in `mcp/tools/read.ts` and `ToolContext.spendMeter` is populated (phase-14b). Wire the live guard: `ctx.retriever.retrieve(input.task, input.tags ?? [], ctx.spendMeter ? { spendMeter: ctx.spendMeter, taskId: 'live:' + ctx.sessionId, ceilingUsd: RUNNER_LIVE_SESSION_MAX_CALLS } : {})`. (The 2nd `checkBudget` arg is a CALL ceiling for `CallBudget`; `retrieve`/`loop.ts` already thread `spendMeter`+`taskId`.) Behavior for a default install: `CallBudget` over an empty `runner_runs` returns 0 → never trips → identical to today; the guard only bites once subscription spawns record runs.

## Deferred (cross-phase, intentional)
- **`get_runner_status`** → phase-17 (needs the runner health cache). Its name is already in `READ_TOOLS`; the handler lands with the runner module.
- `get_settings_summary`'s `reasoning`/`runner` fields fill in once phase-16 defines those settings — additive, no rework.

## DoD
`npm run lint && npm run typecheck && npm test` green (offline; the `retrieval.latency` benchmark is a known load flake — confirm in isolation, don't "fix"). New tests: each read tool over a real MCP SDK client (or the server test harness) returns the mapped shape + writes an `mcp_calls` row; the dashboard IPC read handlers still return identical results after the refactor (pin a couple); `read_session` refuses a caller-supplied path; `getContext` live-budget wired (trips at the ceiling when `runner_runs` is seeded, no-ops when empty).
