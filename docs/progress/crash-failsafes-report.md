# Crash fail-safes — write-intent journal, boot rollback sweep, quit-order fix, updater quiesce (§21.9)

**Date:** 2026-07-11
**Scope:** user-directed crash-safety hardening, built in three stages (A: journal + sweep + schema; B: staged-approved sweep + updater quiesce; C: adversarial verify + kill-proof + docs).
**Result:** typecheck + lint clean; `npm test` **1012 passed | 21 skipped | 0 failed**; e2e `dashboard.audit` + `dashboard.review` pass. **No new npm deps.**

---

## The problem (audit gaps G1–G7)

The single write lane (`writeLane.ts`) provides lane **exclusivity**, not a database **transaction**: `BEGIN`/`COMMIT`/`ROLLBACK` are denied because RyuGraph's index DDL (the drop→set→recreate vector-index dance) is only legal in auto-transaction mode, so **each statement auto-commits**. A crash partway through a multi-op `withWrite` therefore leaves a **durable, partially-applied graph write** with nothing to undo it.

| Gap | The window | Fix (stage) |
|---|---|---|
| **G1** | Crash mid-lane-job → durable partial graph write, no recorded inverse. | Write-intent journal + boot rollback sweep (A). |
| **G2** | `audit.graphWrite` recorded inverses in memory and INSERTed the `audit_log` row only *after* the lane resolved → crash mid-job = **no record at all**; crash after-commit-before-insert = **an un-undoable, unrecorded write**. | `graphWrite` now writes a `'pending'` row *before* the lane job and re-persists `inverse_json` before every forward mutation; finalizes to ok/error (A). |
| **G3** | `will-quit` closed `appData.close()` **before** `engine.close()` — but `engine.close()` is what drains the lane, and draining jobs still write to appdata.db (audit finalize + journal `jobFinished` deletes). On a *clean* quit a draining job could hit a closed SQLite handle. | Reordered: `engine.close()` (drain + checkpoint) completes, then `appData.close()` in a `.finally` (A). |
| **G4** | `approveStagedWrite` flips staged→approved→committed with the audited commit in between; a crash after the commit left a stuck `'approved'` row with **no boot sweep**. | `runStagedApprovedSweep` re-drives embedder-free approved rows; embedder-needed ones defer to Approvals (B). |
| **G5** | `updater.install` → `quitAndInstall` bypassed will-quit's bounded drain entirely (no quiesce guard beyond `state==='downloaded'`). | `quiesceForInstall` waits bounded for queue + lane idle, then force-checkpoints (B). |
| **G6** | `autoInstallOnAppQuit` could close appdata.db out from under a draining/journaling job. | Same quiesce guard; the lane-job journal now also makes an un-quiesced window **observable** (a stranded `lane_jobs` row → a spurious boot warn next launch); the real safety net is will-quit's reordered drain (B). |
| **G7** | Residual durability posture (see "Accepted trade" below). | Documented, accepted (C). |

---

## What was built, per gap

### G1 + G2 — write-intent journal (`src/main/security/audit.ts`, `src/main/storage/*`)

- **Two durable records** make a partial write recoverable:
  1. **`audit_log` `'pending'` graph-write row.** `graphWrite` inserts it (empty inverses) *before* the lane job, then a `persistInverse()` call re-writes `inverse_json` (the whole array reversed → newest-first == undo order) after every recorded op and **before** the matching forward mutation. On success → `'ok'`; on a caught error → `'error'` (today's semantics preserved). A row still `'pending'` at boot is a write the process died mid-way, and its `inverse_json` rolls back exactly the committed prefix.
  2. **`lane_jobs` table** (`{ id, label, started_at, finished_at }`) via the new **`LaneJournal`** engine hook (`createLaneJournal` in `crashSweep.ts`). `RyuGraphEngine.laneJob(label, fn)` inserts a row on start and DELETEs it on clean finish (success OR error) in a `finally`, so a row present at boot = a lane job that died mid-execution. Brackets `withWrite` + `upsertNode`/`createEdge`/`deleteNode`/`deleteEdge` + mutating cypher (**NOT** checkpoints/migrations — they aren't reconciliation targets). Absent journal ⇒ byte-identical lane behaviour (same labels, same ordering).
- **Schema: appdata migration v8** (`src/main/storage/appdata.ts`, `APPDATA_USER_VERSION` 7→8):
  - `audit_log.outcome` CHECK widened `('ok','error')` → **`('ok','error','pending')`**. It's a **column** CHECK and SQLite can't `ALTER` a CHECK, so existing stores are handled by `migrateAuditLogOutcomeCheck(db)`: copy rows into a table with the widened CHECK, swap, recreate the two indexes — all inside **one `db.transaction`** so a crash rolls back to the original; the pre-upgrade VACUUM-INTO snapshot is the outer net. Guarded/idempotent: skips when the on-disk `sqlite_master.sql` already contains `'pending'` (fresh installs get it from `APPDATA_SCHEMA`) or when the table doesn't exist yet. `audit_log` has no incoming FKs, so DROP+RENAME is safe with `foreign_keys=ON`.
  - New table **`lane_jobs`** (purely additive; `finished_at` stays NULL by design — a clean finish DELETEs the row).
- **`rollbackInterruptedWrite(id)`** (audit.ts): the sweep entry. Applies the recorded inverses in ONE lane job (label `interrupted-rollback:<id>`) via the shared `applyInverseOps`, then flips the row to `'error'` + a `(rolled back after interrupted write)` suffix. It creates **no new audit row** (unlike user `undo`, which records an `'undo'` action) — it just settles the original.
- **pending-row semantics (recorded decision):** `'pending'` is a transient internal state, filtered OUT of `listActions` via `WHERE outcome != 'pending'`. `AuditActionRow`/`AuditActionDto` stay `'ok'|'error'`, so the dashboard History panel AND the MCP `list_audit_log` tool (both go through `listActions` → `reads/observability.listAuditLog`) are untouched. The sweep reads pending rows directly by outcome (raw SQL). `getAction` is unchanged (only ever called on settled rows; a pending row also has `reversible=0`, so even if its id leaked, `undo` throws `IRREVERSIBLE`).

### G1 boot sweep — `runCrashSweep` (`src/main/crashSweep.ts`)

Wired in `bootStorage` (index.ts) right after both stores open and `engine.setLaneJournal(...)`, **before every subsystem boots** (so no new write races it; in particular **before `queue.start()`**, which is in `bootTriggers`). Fully fail-safe (a sweep hiccup never takes boot down; the underlying writes stay durable regardless).

- **(a)** rolls back every `outcome='pending'` row via `audit.rollbackInterruptedWrite`, emits a `warn`; a rollback failure leaves the row and emits an `error`.
- **(b)** deletes every `lane_jobs` row — silently when its label (`graph-write:<id>` / `undo:<id>` / `interrupted-rollback:<id>`) maps to an existing audit row (already reconciled by (a)), else emits a detection-only `warn` (a non-audited raw ingest withWrite — re-running the ingest reconciles, writes are idempotent).
- **Idempotent + self-clearing:** a second run finds no pending rows (settled) and no lane_jobs rows (deleted). Because the inverse ops are idempotent (`delete-node` on an absent node no-ops, `restore-node` upserts), a crash *between* the rollback and the flip is safe — the next boot re-rolls-back to the same clean state.

### G4 staged-approved sweep — `runStagedApprovedSweep` (`crashSweep.ts`)

Runs right after `runCrashSweep`, over the same throwaway `AuditLog`. For each `staged_writes` row stuck at `status='approved'`:
- **embedder-free** rows: re-drive `approveStagedWrite` (designed re-drivable) → `'committed'`, warn. Commit ops are idempotent (upsert/MERGE), so the "graph write done, flip not done" window yields a benign **second audit action** rather than a lost commit — **recorded decision** (a benign double-action beats a stuck row). A dedupe-merge whose targets were already consumed fails cleanly → counted `reCommitFailed`, left in Approvals.
- **embedder-needed** rows: left with a warn diagnostic pointing at Approvals (the sweep has no embedder — that build is later in boot; the user finishes with one click).

### G3 quit-order fix — `src/main/index.ts` `will-quit`

`engine.close({ skipDatabaseClose: true })` (drains `lane.onIdle` + CHECKPOINT) now completes **before** `appData.close()` (moved into the `.finally`), with a comment explaining why: draining lane jobs write to appdata.db (the audit `pending`→ok/error finalize + the journal `jobFinished` deletes), so closing appdata first would lose those records on a clean quit.

### G5 + G6 updater quiesce — `src/main/updater.ts`, `src/main/ipc.ts`

`quiesceForInstall(deps)` (pure, testable): waits bounded (30s, 200ms poll) for `queue.runningTaskId===null` AND `engine.laneIdle()`, then force-checkpoints. The `updater.install` IPC handler (only when `state==='downloaded'`) awaits it; if still busy after the bound it does **not** install — returns `installDeferred:true` (state stays `'downloaded'`) and `autoInstallOnAppQuit` applies the update on the next quit. Added `laneIdle()` to `StorageEngine`/`RyuGraphEngine` backed by `WriteLane.idle` (additive). Quiesce is **best-effort, not a lock** — a new job could enqueue between the idle check and `quitAndInstall`; will-quit's own bounded drain (queue.stop 5s + the G3 ordering) is the real net.

---

## Accepted trade (G7)

The residual durability posture, **accepted and documented**:

- The graph WAL is checkpointed by a periodic timer on a **2-minute bound** (`GRAPH_CHECKPOINT_INTERVAL_MS = 2 * 60 * 1000`), and appdata.db runs with **`synchronous = NORMAL`** (the SQLite-recommended WAL balance, not `FULL`).
- Consequence: a **hard power-loss** (not a process crash) between checkpoints/fsyncs can still lose the last un-checkpointed writes, and a genuinely *torn* WAL is **quarantined and the store reopened at the last checkpoint**, not replayed.
- Why accepted: `synchronous=FULL` would fsync on every commit (a large perf hit on a write-heavy ingest) for protection only against sudden power-loss — a rare failure mode for a desktop app. The dominant failure mode is a **process** crash / force-quit / mid-update kill, where the OS flushes the WAL on process death, so the committed prefix survives and the boot sweep + torn-WAL quarantine fully cover it. The 2-minute checkpoint bound caps how much a power-loss can cost; the weekly export + pre-migration/pre-upgrade backups are the outer belt.

---

## Stage-C adversarial verification (the 4 vectors) — 0 fixes needed

Re-read all Stage A+B code against the four failure vectors called out; **every one was already correct**, so **no code changed this stage** (no `src/` diff — only new tests + docs). Findings:

1. **Double-rollback on re-boot (sweep idempotency).** A crash between a rollback and its `'error'` flip leaves the row `'pending'`; the next boot re-applies the same inverses. Safe because the inverse ops are idempotent (`delete-node` on an absent node no-ops; `restore-node`/`restore-props` upsert). The sweep's own re-run test (`storage.crashSweep.test.ts`) already pins "second run does nothing". **OK.**
2. **Sweep racing the queue's re-pended tasks.** `runCrashSweep` runs inside `bootStorage`, which is `await`-ed to completion in `whenReady` *before* `bootTriggers` calls `queue.start()`. The reconnect path only re-runs `bootStorage` (and thus the sweep) when storage itself is down, and the sweep from the storage generation that first came up already cleared everything. **The sweep provably completes before any queue dispatch. OK.**
3. **Pending-row filtering in every `audit_log` consumer.** Grepped every `audit_log` reader: only `crashSweep.ts` (reads pending by design), `appdata.ts` (schema), and `reads/observability.ts` touch it. Both the dashboard `audit.list` handler and the MCP `list_audit_log` tool go through `audit.listActions`, which filters `outcome != 'pending'`. `getAction` isn't filtered but is only ever called on settled ids, and a pending row is `reversible=0` so `undo` refuses it anyway. **No consumer counts or shows pending rows. OK.**
4. **Updater deferred path leaving queue intake stopped.** `quiesceForInstall` only **polls** `runningTaskId`/`laneIdle()`; it never stops or pauses the queue (grep-confirmed: the only `queue.stop()` callers are will-quit and reconnect teardown). On the deferred path nothing was stopped, so there is nothing to resume — the queue keeps running normally. **OK.**

---

## New tests (Stage C)

- **`tests/integration/storage.crashSweep.kill.test.ts`** + **`tests/fixtures/audit-kill-child.ts`** + **`tests/fixtures/audit-kill-constants.ts`** — the definitive kill-mid-write proof, real SIGKILL (mirrors `triggers.queue.kill.test.ts`). A bundled child opens the REAL RyuGraph engine + appdata.db, wires the lane journal exactly as boot does, seeds a clean baseline node, then starts a LONG audited `graphWrite` (5 upserts) and prints a handshake once the committed prefix + inverses are durable. The parent SIGKILLs it mid-lane-job, reopens both stores, asserts the durable partial write really survived (all 5 nodes + the baseline on disk, one `'pending'` row, a stranded `graph-write:<id>` lane_jobs row), runs `runCrashSweep`, then asserts: the 5 partial nodes are **rolled back to pre-state (0)**, the baseline is **untouched (1)**, the audit row is `'error'` with the rolled-back suffix, `auditedCleared≥1` / `nonAuditedFlagged==0`, a `warn` diagnostic surfaced, and a re-run is a no-op (idempotent).
  - *Constants live in a separate no-execution module so importing them in the parent doesn't run the child fixture's `main()` in-process — the child only ever runs as its own spawned node process.*
- **`tests/integration/storage.crashSweep.quitOrder.test.ts`** — regression guard for the G3 will-quit ordering. Starts an audited write, then runs the exact will-quit sequence `engine.close().finally(() => appData.close())`, and asserts that by the time `engine.close()` resolves the in-flight write has **fully settled in appdata.db** (audit row `'ok'`, `lane_jobs` row deleted) **with appData still open** — proving the drain's appdata writes land before appData closes. (Electron `will-quit` itself isn't drivable in-process; this asserts the invariant it relies on.)

---

## Gates (Stage C)

| Gate | Result |
|---|---|
| `npm run typecheck` | clean |
| `npm run lint` | clean |
| `npm test` | **1012 passed \| 21 skipped \| 0 failed** (+2 vs Stage B's 1010; known `storage.checkpoint` dirty-gated + `retrieval.latency` p50 flakes did **not** fire) |
| e2e `dashboard.audit` + `dashboard.review` | 2 passed (History/Approvals surfaces, run with `AGENTIC_OS_E2E_SKIP_BUILD=1` after a fresh build) |
| golden-path e2e | **skipped locally** — the user's live app holds MCP port 4517; defer to CI |

---

## Notes for the next builder

- **`finished_at` in `lane_jobs` is always NULL by design** (a clean finish DELETEs the row; the sweep treats any present row as interrupted). If you want a "job ran but its settle-write failed" signal, start setting it — but the sweep already covers "any present row".
- **The sweep uses a throwaway `AuditLog`** built over `appData.db` + `engine` in `bootStorage` (the durable one is built later in `bootKernel`). If you add a third boot sweep, mirror this: build the throwaway `AuditLog`/deps and fold results into the existing `crashSweepDiagnostics` accumulator (already concatenated into `currentBootDiagnostics()` and replaced per boot so reconnect never duplicates).
- **Lane-job correlation is by label prefix** (`auditedActionIdOf`): `graph-write:` / `undo:` / `interrupted-rollback:`. Any audited write (including a staged-commit's `graphWrite`, which tags `graph-write:<actionId>`) is auto-covered — no new prefix needed for new audited callers.
- **Double-audit-on-redrive is an accepted, honest outcome** for the staged-approved sweep (a benign second audit action beats a stuck row). A dedupe-merge whose targets were already consumed re-drives to a clean `COMMIT_FAILED` and is left in Approvals for an eyeball.
- **Quiesce is best-effort, not a lock.** The real safety net for an install is will-quit's bounded drain + the G3 ordering. If you ever want the updater to *hold* the lane, that's a bigger change (a lane-level pause primitive) — out of scope here.
- **The DetachedNSIS install→migrate path is proven by `scripts/smoke/packaged-smoke.mjs`, not re-run here** — that smoke is the belt-and-braces for the deferred install path end-to-end.
