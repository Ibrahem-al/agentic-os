# Phase 38 — "Find duplicates" runs in the background, with scope + cost controls

**Status:** done · **Date:** 2026-07-20 · User-directed ("make finding duplicates run in the background so the user needn't stay in the popup; add options to search recent memory / a set number of nodes / the entire database; and find other ways to cut its computation cost"). Design help from a Fable subagent (as requested); implementation Opus.

## The problems
The old scan (`memory/dedupe.ts` + `DedupeModal`) ran **synchronously inside the modal** — closing the popup threw the work away — and always compared the newest ≤2000 nodes per label with no user control. Right after importing a batch of projects there was no cheap way to check just the new memories, and no way to force a full-database pass.

## What was built

### 1. Background scan controller (survives the popup) — `src/main/memory/dedupeController.ts` (new)
A main-process `DedupeScanController` runs the scan **detached** from any window. `start(options)` returns immediately; progress + completion ride `IPC_EVENT_DEDUPE_STATUS`; the **last completed result** is persisted to a new `dedupe_scans` appdata row so reopening the modal — even after a restart — shows it. Deliberately **not** the durable task queue: a read-only maintenance scan isn't a user "job" (no retry/backoff, no Jobs-list noise; an interrupted scan is simply re-run). `cancel()` aborts cooperatively. A second `start()` while one runs is rejected (`INVALID_INPUT`). New IPC: `memory.dedupe.scanStart` / `cancel` / `status` (the old synchronous `memory.dedupe.scan` channel is gone). Table added to the base `CREATE TABLE IF NOT EXISTS` schema → **no `APPDATA_USER_VERSION` bump**.

### 2. Scope modes — `src/main/memory/dedupe.ts` `scope: 'recent' | 'count' | 'all'`
- **recent** — only memories changed since the last check. The controller resolves the cutoff from a persisted **`watermark_at`** (the scan-START of the last completed recent/all scan), or, on the first-ever run, `DEDUPE_RECENT_DEFAULT_WINDOW_MS` (7 days) ago. Self-calibrating: right after an ingest stamps `updated_at = now`, "recent" compares exactly the new batch. Only recent/all advance the watermark (a `count` spot-check must not claim completeness).
- **count** — the newest `count` memories across the scanned labels (default `DEDUPE_COUNT_DEFAULT = 500`).
- **all** — the entire database, bounded only by `DEDUPE_HARD_NODE_CEILING = 50000` (an OOM backstop; the real bound is background execution + progress + cancel).
- Omitting `scope` preserves the **legacy** whole-newest-per-label behavior, so the MCP `list_duplicate_memories` tool and every existing test are unchanged.

### 3. Cost reduction — the core ask
- **Decoupled passes.** A **cheap exact pass** (text/name columns only, **no embeddings loaded**, up to `DEDUPE_EXACT_SCAN_CAP = 20000`/label) is separated from the **expensive near pass** (embeddings + ANN probes) whose candidate set the scope bounds. The old code pulled every node's embedding blob even for exact matching.
- **Probe recent against the full index (the headline win).** A newly-introduced near-duplicate must involve a recent node, so the near pass probes **only the in-scope candidates** — but each probe still searches the **full** ANN index, so a recent node duplicating an *old* one is still found. That turns O(all·k) into **O(recent·k)**. The old (out-of-scope) member of a match is materialized on demand and dropped if it vanished mid-scan.
- **`near:false`** skips the embedding pass entirely (fast, exact-only).
- Scope-filtered groups: for recent/count a group surfaces only when it contains ≥1 in-scope node.

### 4. UI — `src/renderer/src/panels/MemoryPanel.tsx` `DedupeModal` (rebuilt)
Reads `memory.dedupe.status` on open and subscribes to the status event, so it shows a scan already in flight (or the last result). A scope picker (recent / a set number + count field / everything) drives **Scan**; while running it shows live progress ("Checking preferences… 120 of 450 memories. You can close this window — it keeps going in the background.") with **Stop**. Results carry a scope-aware summary and a scope-aware empty state ("No duplicates among the memories that changed since your last check" vs a whole-DB clean bill). Merge is unchanged (still one audited, undoable lane job); after a merge it re-scans with the same scope.

## Untouched (deliberately)
`mergeDuplicates` (the audited, undoable merge) and the MCP staging path (§21 rule 6) are byte-for-byte unchanged. All new tunables are rule-12 documented `config.ts` constants.

## Files touched
New: `src/main/memory/dedupeController.ts`, `tests/integration/memory.dedupeController.test.ts`. Changed: `src/main/memory/dedupe.ts` (scope-aware decoupled scan + progress/abort), `src/main/memory/index.ts` (barrel), `src/main/config.ts` (5 new `DEDUPE_*` constants + repurposed doc), `src/main/storage/appdata.ts` (`dedupe_scans` table), `src/main/ipc.ts` (controller dep + scanStart/cancel/status), `src/main/index.ts` (boot controller + broadcast), `src/preload/index.ts` (`onDedupeStatus`), `src/shared/ipc.ts` (DTOs + channels + `IPC_EVENT_DEDUPE_STATUS`), `src/renderer/src/panels/MemoryPanel.tsx` (rebuilt modal), `tests/integration/memory.dedupe.test.ts` (scope + abort tests).

## Definition-of-Done — commands run
- `npm run typecheck` (node + web) → **clean**. `npm run lint` → **clean**. `npm run build` → **all 3 bundles**.
- Tests: `memory.dedupe` (scope/recent-vs-old/count/near-off/abort) + `memory.dedupeController` (detached-run persistence, reopen-after-restart, watermark advances on recent/all not count, first-run fallback window, double-start reject) → **22 passed**; `mcp.tools.phase18` (unchanged MCP path) green.
- No new deps. New `dedupe_scans` table via the base `IF NOT EXISTS` schema (no version bump). `DEFAULT == TODAY`: omitting `scope` reproduces the prior scan; a fresh install has no `dedupe_scans` row until the first scan.
