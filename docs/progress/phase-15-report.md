# Phase 15 report — MCP read-tool surface (§8 Phase 1 / FP-1)

**Branch:** `feat/mcp-expansion-subscription-reasoner`. Opus ultracode workflow (`wf_995c32b9-803`): shared-reads module → parallel(`ipc.ts` DRY refactor, read-tool handlers) → verify. Orchestrator reviewed the `McpReadContext`/`index.ts` wiring + ran independent checks. Prime directive held: dashboard IPC behaves identically; a default install is unchanged.

## What was built
- **`src/main/reads/` (new)** — the shared, write-free read layer consumed by BOTH `ipc.ts` and `mcp/tools/read.ts`: `memory.ts`, `skills.ts`, `sessions.ts`, `review.ts`, `observability.ts`, `tasks.ts`, `status.ts`, `serialize.ts`, `types.ts`, `index.ts`. Every §4 read-tool data source is a plain-DTO function; existing shared fns (`listStagedWrites`, `renderStagedWriteDiff`, `listApprovals`, `AuditLog.listActions`, skills state/ledger fns, `WatchedFolderStore.list`, `ollama.status`) are called, not reimplemented.
- **`agents/skills/gate.ts`** — exported `collectSignal`, `hasPendingReview`, `scanDrift` (were private) + re-exported via `agents/index.ts` (needed by `get_skill_signal`/`get_pending_work`).
- **`ipc.ts` DRY refactor** — read handlers (`memory.counts/list/node`, `skills.detail`, `spend.summary`, `tasks.list`, `traces.recent/spans`, `review.flags.list`, `triggers.status`, `settings.get` core) delegate to the shared fns; orphaned inline helpers + imports removed. **1121 → 740 lines, `+37/−417`, behavior-identical** (the typed `register<C>` contract forces each return to equal the channel DTO). `app.status` deliberately left inline (the shared `getAppStatus` is a superset).
- **`mcp/tools/read.ts`** — the **22** §4 read tools (all except `get_runner_status`, deferred to phase-17) added to `READ_TOOL_DEFS` (→ 26 read defs, `MCP_TOOLS` → 29). Each: zod input via `parse()`, one-sentence description, `handle` calling the matching `reads/*` fn. Every tool rides the dispatch chokepoint (span + `mcp_calls` row automatic).
- **P0.2 completion** — `get_context` now passes `{ spendMeter, taskId: 'live:'+sessionId, ceilingUsd: RUNNER_LIVE_SESSION_MAX_CALLS }` to `retrieve()`. No-op on a default install (empty `runner_runs`); bites only once subscription spawns record runs.
- **`McpReadContext` + `setReadContext()`** — several read tools need deps beyond `db/engine/retrieval/scanner` (`permissions`, `runner`, `triggers`, `watchedFolders`, `ollama`, `keychain`, `appStatus`). Solved additively: `ToolContext extends McpReadContext` (7 optional late-bound deps); `server.setReadContext()` (default-empty, spread into every ctx); wired at `bootIpc` with the same singletons the IPC handlers get (a pure hoist of the `triggers`/`subsystems` locals + the additive call). An un-wired server behaves exactly as before; a missing dep yields a clean `INVALID_STATE`.

## Key decisions
- **22 read tools, not "18"** — the assignment prompt miscounted; the §4 read surface minus `get_runner_status` is 22 new tools (the 4 phase-05 tools — `get_context` etc. — are separate). The agent counted the enumeration and did the right thing.
- **`read_session` resolves the transcript path server-side** from the `extract-<sid>` task payload — the input is `{session_id, page}`, no path field — so it can never become an arbitrary-file read (pinned: `/etc/passwd` ignored).
- **`get_settings_summary` presence-booleans only** — never key material (pinned: `sk-test-key` absent from the serialized reply); `reasoning`/`runner` fields present-only, inert until phase-16.
- Reads fns take minimal structural deps (not `ToolContext`/`IpcDeps`) so both callers supply them.

## Deferred (intentional)
- `get_runner_status` → phase-17 (needs the runner health cache). Its name is in `READ_TOOLS`; the dispatcher answers `NOT_FOUND` until the handler lands.
- `get_usage`'s runner section reads `runner_runs` (empty until runners run); `get_settings_summary` reasoning/runner fill in at phase-16.

## Verification (DoD)
- Orchestrator independent run: `npm run lint` clean; `npm run typecheck` clean; isolated `mcp.read-tools`(25) + `reads.queries`(6) + `mcp.server`(39) = **70 passed**.
- Verify agent full offline suite: green with only the documented load flakes (`retrieval.latency`, `security.conformance` docker probe under 72-file concurrency), each confirmed green in isolation; net ≈ 684 passing + 12 skipped.
- +49 tests vs phase-14 (reads.queries 6 + mcp.read-tools 25 + surface updates).
- Adversarial audit (6 points) CONFIRMED: dashboard identical, chokepoint, `read_session` no caller path, `get_settings_summary` sanitized, `get_context` live-budget, `get_runner_status` correctly absent.

## Next phases
- **Phase-16 (provider seam)** touches `ipc.ts` (settings mutators) + `index.ts` (bootAgents) — sequential after this commit. Doc ready: `docs/phases/phase-16-provider-seam.md`.
- The `reads/` module + `McpReadContext` are the stable seam for any future read tool.
