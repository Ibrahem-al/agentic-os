# Phase 11 report — Triggers & automation

**Status:** done · **Date:** 2026-07-05

## What was built

`src/main/triggers/` (7 modules) + `scripts/hooks/` — the system becomes autonomous: every phase 01–10 capability that was a manual entry point now has a real caller, and everything runs through the §8 durable queue under the §13 envelope.

### `queue.ts` — the §8 resource scheduler (durable task queue)

An in-process priority queue (speed layer) mirrored to the appdata `tasks` table (durability layer): enqueue = INSERT, every status transition = UPDATE, `start()` reloads pending / crashed-running / deferred rows — queued tasks survive crashes and reboots (DoD 1 proven with a real SIGKILL). Semantics:

- **Ordering:** effective priority = `priority + floor(waited / 5 min)` (§8 aging — a starved low-priority task catches up), FIFO within a priority. Dispatch is serial and cooperative (§8 "no mid-generation preemption"); the write lane and cloud lane serialize the heavy resources anyway.
- **Live-session yield (§8):** dispatch waits while the MCP server reports a tool call in flight (`AgenticOsMcpServer.inflightCalls`, new counter around the phase-05 chokepoint) — capped at 60 s per dispatch, the aging guarantee applied to the yield itself.
- **Retry/backoff (§20):** a failure retries at 1 m / 5 m / 25 m (`JOB_RETRY_BACKOFF_MS`), then the task flips to `deferred` with the error flagged. Deferral persists; the next `start()` gives deferred tasks a fresh round — the next launch IS "the next run" for unscheduled tasks. `TaskFatalError` skips retries (e.g. a rule that no longer exists).
- **§13 approvals:** a handler throwing `KernelApprovalPendingError` parks the task as `deferred` + `waiting_approval_id` (headless it stays queued, exactly as phase 09 designed); `onApprovalDecided()` re-runs it on approval / fails it on denial — wired into the dashboard's `review.approvals.decide` IPC adapter, and applied at reload for decisions taken while the app was closed.
- **Dedup by id:** enqueueing an existing id (any status) is a no-op — the §6 exactly-once mechanism.
- Workflow job rows (kind `workflow`, owned by the LangGraphRunner) share the table but are invisible to the queue: only kinds with registered handlers are reloaded or dispatched; a dispatched task whose subsystem didn't boot this launch parks as `deferred` for a launch that has it.

appdata **v5** (additive, guarded like v2–v4): `tasks.priority` + `tasks.waiting_approval_id` — §8 lists priority as a queue-mirror column; the upgrade test now recreates a pre-v5 `tasks` to prove the guarded ALTERs.

### `schedules.ts` + `jobs.ts` — croner schedules (§20, local time)

`croner@10.0.1` (§20 stack pin, installed this phase) drives the three slots; each fire enqueues a durable task with a fire-minute-stamped id (`prune-2026-07-05T0300`) so an overlapping restart cannot double-enqueue:

- **nightly prune 03:00** — Sessions older than 14 days lose `transcript_ref`, stubs and extracted nodes stay. The prune is ONE **audited structured write** (per-property pre-images via `AuditLog.graphWrite` + `upsertNode(…, {transcript_ref: null})`), so it is UNDOABLE from the dashboard like any §13 action — pinned by test (undo restores the ref verbatim).
- **weekly export Sun 03:30** — the phase-01 `exportGraph` dump into `exports/<date>/`.
- **nightly skill job 02:00** — enqueues `skill-improvement`; the handler is an explicit no-op note until phase 12 replaces its body (the slot, task rows and dashboard visibility are already real).

### `sessionEnd.ts` + the hook endpoint — §6 three-tier session-end detection

1. **Primary — SessionEnd hook:** `POST /hooks/session-end` mounted on the SAME HTTP server as MCP (§20), handled before the MCP route. Auth = a **dedicated hook token** (new keychain secret `hooks.sessionEndToken`, timing-safe compare) — deliberately NOT the MCP bearer token: its only power is enqueuing extraction. The handler validates (zod: `session_id` required; `transcript_path`/`cwd`/`reason` optional) and ENQUEUES — extraction runs in the queue, never on the request path. Unarmed (trigger boot skipped/pending) → 503, and the hook script spools.
2. **Spool:** `drainSessionSpool()` on boot — every `*.json` in `~/.agentic-os/pending-sessions/` either enqueues (dedup-aware) and is deleted, or is renamed `*.bad` so a poison file can't loop forever.
3. **Fallback — MCP-log inactivity:** `InactivityMonitor` sweeps `mcp_calls` (immediately at boot + every 5 min) for session ids silent past the §20 30-min timeout, with a `NOT EXISTS` filter against `tasks` so already-tasked sessions never re-surface. Backbone-only extraction (no hook = no transcript path — §6 tier 3 demoted the file watcher to enrichment, deliberately not a trigger).

**Exactly-once (§6/DoD 3):** all three paths enqueue the deterministic task id `extract-<sessionId>` — hook + spool + inactivity converge on ONE extraction per session, durably (a session extracted last week stays extracted).

The **extraction handler** runs the REAL phase-08 workflow with a deterministic workflow-job id (`extract-<sid>-wf`): retries RESUME the same job from its checkpoint, so model passes never re-run (the phase-08 crash-resume design, now load-bearing). A session with no `mcp_calls` and no readable transcript completes with a note — `ExtractionError NOT_FOUND` (detected through the `WorkflowJobError` cause chain) is not retryable.

### `hookInstaller.ts` + `scripts/hooks/session-end.{sh,ps1}` — the one-time guided setup

- `installSessionEndHook()`: safe deep-merge into `~/.claude/settings.json` — parse (a corrupt file is NEVER touched), preserve every existing key and every existing hook verbatim, find our entry by script name, append a new SessionEnd group (or replace our own command in place on token/path rotation), back up the changed file to `settings.json.bak.<stamp>`, write atomically, and return a line diff (LCS, dependency-free). Idempotent: re-install returns `changed: false`.
- The hook scripts read stdin (the Claude Code hook JSON), POST with `Authorization: Bearer <hook token>` (payload piped, never argv), and on ANY failure — connection refused, non-2xx, curl missing — append the payload to the spool folder. Always exit 0 (a hook must never break the user's session). LF pinned for the `.sh` via `.gitattributes`.
- Surfaced in the dashboard: settings panel → "session-end hook" section (install/repair button, result + diff — with the token REDACTED before crossing IPC), and the tasks panel shows installed-state.

### `rules.ts` — user rules (§17 shape, exactly)

`loadRules(~/.agentic-os/rules/*.rule.json)`: zod-validated against the §17 shape — `id`, `trigger` (`{type:'watch', url|path, intervalMin}` or `{type:'schedule', cron}`), optional `condition`, `action` (`kind:'code'` only in v1 — §7 sandboxed code; `lang` ts/js → Deno lane, anything else → Docker lane), `modelTier`, `capabilities` through the phase-09 `parseCapabilities` (absolute paths, ~-expansion, default-deny). Load-time coherence: a rule may only WATCH what it declared (`trigger.path` ∈ `fsRead`, `trigger.url` host ∈ `netDomains`) — §13 even for detection; the entry file must exist; cron expressions are probed. Invalid files land in `errors` with the exact reason (boot log + dashboard) and never half-run; duplicate ids keep the first file.

**Condition DSL (v1):** exactly the spec's example grammar — `<dotted.path> contains '<literal>'` evaluated against the trigger event; anything else is a load-time error (fail-fast beats silently-always-true). Recorded decision.

Every valid rule registers the §13 agent `rule:<id>` with its declared capabilities and **NO standing grants** (phase-09 decision 2): side-effecting actions queue for the dashboard.

### `watchers.ts` — the watchers runtime (§7: cheap local detection → enqueue)

`chokidar@5.0.0` (§20 stack pin, installed this phase):

- **Watched folders**: chokidar on every enabled folder (awaitWriteFinish debounce 1 s) → changed/added supported files enqueue `ingest-file` tasks through the phase-06 pipeline; one `watch-scan` task per folder at start catches files changed while the app was closed (content-hash dedup keeps it cheap). Autonomously ingested documents get the **`auto-ingested` tag** — the §13 source-trust-tagging v1 (phase-09 deferred item): retrieval and review can always tell watcher-ingested content from user-invoked ingests. Injection scanner + audited lane jobs apply as always (the handlers run as kernel `storage-write` actions under `system`).
- **Rule file watches**: detection reads + hashes the file THROUGH the kernel (`fs-read` — auto-allowed only inside the rule's own `fsRead`), fires on a REAL content change (hash ≠ persisted baseline).
- **Rule url watches**: fetch+hash polling on the rule's interval (≥15 s floor, bounded 64 KB bodies) routed through the kernel as `net` actions — for user rules that tier is approval-gated, so the FIRST poll queues one §13 approval and polling stays dark until the dashboard approves (signature-persistent: approve once). First successful poll = baseline, only a change fires. §7 budget rule holds: detection is a local fetch; the expensive action runs only on fire.
- **Rule schedules**: croner per rule.
- A fire evaluates the condition and enqueues a `rule-action` task; baselines persist in `userData/trigger-state.json` so restarts don't re-fire unchanged targets; watcher errors log once per (rule, reason), never spam.

**Rule action runner** (`rule-action` handler): §21 rule 3 end-to-end — the action executes ONLY in a phase-09 sandbox lane (managed Deno / Docker), under the rule's own capabilities, behind the kernel's `sandbox-run` gate: read-only capability sets auto-allow; side-effecting sets throw `KernelApprovalPendingError` on first run → the queue parks the task → the dashboard decision releases it (or fails it). Docker-lane rules with Docker missing fail with install guidance, no retry burn.

### Boot + quit (`src/main/index.ts`)

`bootTriggers()` after `bootAgents()`: queue (with the MCP-inflight yield) → handlers (extraction / maintenance / ingest / rule-action, each guarded by its subsystem) → rules loaded + registered as §13 agents → hook endpoint armed with the keychain token → spool drained → `queue.start()` → schedules → inactivity monitor → watchers. Boot lines:

```
[triggers] durable queue ready — 0 task(s) reloaded, spool drained (1 new, 0 dup, 0 bad); schedules armed (skill 02:00, prune 03:00, export Sun 03:30)
[triggers] session-end: hook endpoint armed at http://127.0.0.1:4517/hooks/session-end; inactivity fallback 30 min; watchers: 0 folder(s), 0 rule(s)
```

The quit path now stops triggers FIRST (schedules/watchers/inactivity synchronously; the queue's in-flight task gets a bounded 5 s grace) before the db handle closes — a task cut off at quit stays `running` in the mirror and the next launch re-runs it (handlers are idempotent by design: extraction resumes its checkpoint, ingest dedups by content hash). `will-quit` now always `preventDefault()`s and exits through one async chain (exercised by every Playwright spec's `app.close()`).

### Typed IPC + dashboard touches

- `triggers.status` (queue counts + running task, schedule next-fires, watched folders, rules + validation errors verbatim, hook installed-state) and `triggers.installHook` — the only two new channels (§21 rule 8: added to the one channel map; preload/renderer picked them up typed).
- Tasks panel: a "triggers" section (queue/schedules/rules status); watched-folders copy updated (watching is now automatic; "scan now" stays as the manual trigger). Settings panel: the hook install section.
- `review.approvals.decide` now nudges the queue (`onApprovalDecided`) so a parked rule action retries the moment the operator approves.

### Hermeticity

`AGENTIC_OS_DOT_DIR` env override for the `~/.agentic-os` base (spool + rules) — same pattern as `AGENTIC_OS_USER_DATA_DIR`; the e2e launcher and boot smoke set it so test apps can never drain the user's real spool or load their real rules.

## Definition of Done — outputs

### 1. Kill the app with 3 queued tasks → restart → all 3 run

`triggers.queue.kill.test.ts`: a REAL child process (esbuild-bundled, plain node) enqueues 3 tasks and starts its queue; the parent SIGKILLs it **while task 1 is mid-run** (handshake-synchronized). The durable mirror then holds `running / pending / pending`; a fresh queue over the same appdata.db (the "restarted app") reloads **3** and all 3 run to `done` — task 1's re-run included (crashed-running rows re-enter as pending). Passed in 5.0 s.

### 2. Fake SessionEnd POST → extraction end-to-end; spool drained on next boot

`triggers.sessionEnd.test.ts` (12 tests, real MCP HTTP server on an ephemeral port + real engine + real kernel/permission stack + phase-08 workflow with scripted local LLM):

- `POST /hooks/session-end` with the hook token + a fixture session (mcp_calls rows + JSONL transcript) → 200 `{taskId: 'extract-…', deduped: false}` → the queue runs the REAL extraction workflow → task `done`, and the graph provably changed: `Session` node + the extracted Preference (statement read back, `extracted_by extraction@…`, confidence 0.9, stamped `EXTRACTED_FROM` edge) + the deterministic `-wf` workflow job row `done`.
- Auth/protocol: missing/wrong token → 401 with nothing enqueued; non-POST → 405; junk JSON → 400; missing `session_id` → 400 naming it; unarmed endpoint → 503.
- **The REAL hook scripts** (`session-end.ps1` on this machine): against the live endpoint → exit 0, task enqueued, nothing spooled; against a dead port (app closed) → exit 0 and the EXACT payload landed in the (redirected-HOME) spool dir — then `drainSessionSpool` enqueued it and extraction ran. Malformed spool files quarantine as `*.bad`; already-tasked sessions dedup and their files still delete.

### 3. Same session via hook AND inactivity → extracted exactly once

Hook POST enqueues `extract-sess-both`; the inactivity sweep (which sees the same session quiet 45 min) returns `[]` — deduped by the deterministic id. Pinned: exactly ONE task row, ONE workflow job row, ONE `Session` node. The reverse order (inactivity first, hook second → `deduped: true` over HTTP) is covered by the repeat-POST test. The sweep itself: quiet sessions enqueue once, active sessions don't, re-sweeps are no-ops (`NOT EXISTS` filter).

### 4. Demo rule fires in Deno; an out-of-scope write from it is denied

`triggers.watchers.test.ts` — the full §13 story on the REAL managed Deno binary (v2.9.1, cached in `out/test-bin`):

- Rule `demo-file-rule`: watch a local file (`fsRead` scope), condition `content contains 'deploy'`, TS action, `fsWrite: [agentic-out]`.
- A NON-matching change does not fire (condition filter). A matching write → kernel-mediated detection (`kernel.fs-read` span, decision `allow`) → `rule-action` task → the sandbox-run gate parks it behind a **pending §13 approval** (`waiting on approval …`, scope facts `fsWrite: [agentic-out]` in the row, NOTHING ran — `result.txt` absent). Dashboard-style approve + queue nudge → the action runs in the REAL Deno lane: **the allowed write landed on the host** (`agentic-out/result.txt`, content `fired by demo-file-rule: <hash>`) and **the out-of-scope write was DENIED** (`outside/evil.txt` provably absent; the probe saw `NotCapable`). Span evidence: `kernel.sandbox-run` decisions go `pending` → `allow`.
- Url watcher: the first poll queues ONE net approval and polling stays dark; after approval the first successful poll is a baseline (no fire), a non-matching change doesn't fire, a matching change enqueues the rule action with the url event payload.
- Watched folders: the boot catch-up scan ingested a pre-existing file (Knowledge chunks tagged `auto-ingested` + the folder's tags); a file dropped while running was ingested automatically.

### 5. Hook installer: pre-existing hooks kept intact (golden-file diff)

`triggers.hookInstaller.test.ts` (7 tests): a settings.json carrying a pre-existing `PostToolUse` hook, someone else's `SessionEnd` entry, and top-level `model`/`permissions` keys → install → every pre-existing key/hook deep-equals the original, our command was APPENDED as a new group, the diff shows only `+` lines for it, and the backup file is byte-identical to the original. Plus: fresh install, idempotent re-install (`changed: false`, no second backup), token rotation replaces in place, corrupt JSON refused untouched, non-array `hooks.SessionEnd` refused, per-platform command shapes (incl. POSIX quote escaping).

### 6. Full verification (this machine)

```
npm run lint          clean
npm run typecheck     clean (tsconfig.node + tsconfig.web)
npm run build         clean (electron-vite production build)
npm test              Test Files 58 passed | 3 skipped (61) · Tests 514 passed | 10 skipped (524)  [exit 0, zero errors]
                      (514 = phase-10's 453 + 61 new)
ELECTRON_RUN_AS_NODE  Test Files 22 passed | 3 skipped (25) · Tests 199 passed | 10 skipped (209)  [exit 0]
  (tests/integration under Electron runtime)
npm run test:e2e      3 passed, 1 env-gated skip [exit 0] — review 1.2s, audit 682ms, ingest 30.4s
                      (real bge-m3; the seeded app now boots the FULL trigger runtime + new quit path)
boot smoke            node out/smoke/boot-smoke.mjs (production build, scratch userData + dot-dir,
                      real Ollama up) — all subsystem boot lines present incl. both [triggers] lines;
                      the seeded spool file drained (1 new), reloaded by queue.start(), and the
                      extraction task RAN to done ("nothing to extract" note path) during the smoke
```

Phase-11 suites in isolation: 8 files, **61 tests, all passing in ~14 s** (queue 12, rules 15, schedules 5, installer 7, sessionEnd 12, kill 1, watchers 5, jobs 4).

Run notes (reported honestly): one earlier `npm test` run hit the known ryugraph forks-teardown flake (a worker exited after its tests ran; 4 pass-marks unreported, exit still 0); the clean rerun above reported all 524. Separately, the FIRST watchers-test run overlapped a concurrent subagent's tsc/eslint/vitest verification and one trivial test's timers starved for ~5 min (same environment-contention class as phase-10's overlapped-run note) — on a quiet machine the file passes in 12 s and did so on every subsequent run, including twice inside full-suite runs. Zero phase-11 test failures otherwise.

## Key decisions & findings (read before later phases)

1. **Retry semantics** (§20's "3 attempts, backoff 1 m / 5 m / 25 m" is ambiguous): implemented as initial run + up to 3 retries at those delays (4 executions per round), because three backoff values imply three delayed retries. After a round, `deferred` + flag; the next launch gives deferred tasks a fresh round. Recorded interpretation.
2. **The queue's dedup-by-id IS the exactly-once mechanism** — no separate ledger. `extract-<sessionId>` from all three §6 tiers; the row (any status) blocks re-enqueue forever, cheaply, durably.
3. **Extraction retries resume the workflow job, never restart it** — the handler derives `extract-<sid>-wf` deterministically and calls `resumeExtraction` when the job exists. The phase-08 checkpoint design means a retry after a mid-extraction crash re-runs ZERO model calls.
4. **The hook token is a separate, low-privilege credential** (`hooks.sessionEndToken`). It rides the command line inside the user's own `~/.claude/settings.json` — a deliberate, recorded exception to "never plaintext on disk": its only power is enqueuing extraction of a session, the file is in the user's own home-dir trust boundary (like the transcripts themselves), and the MCP bearer token (real capability) never leaves the keychain. The dashboard redacts it (`<hook-token>`) in the install diff.
5. **Approval-parked tasks don't poll** — `KernelApprovalPendingError` parks the task (`deferred` + `waiting_approval_id`); the release is event-driven (IPC decide adapter → `onApprovalDecided`) or reload-time (decisions taken while the app was closed apply at `start()`). No retry churn against a pending approval, no starved approvals.
6. **Url-watch detection runs through the kernel net gate ON PURPOSE** — for user rules the first poll queues one approval and the watcher stays dark until the operator approves (§13 "prompt before network calls"; phase-09: user rules get no standing grants). Approvals are signature-persistent, so one decision covers every subsequent poll of that host. File-watch detection is `fs-read`-tier: auto-allowed, but only inside the rule's declared scope, and validated again at load ("a rule may only watch what it declared").
7. **Source trust-tagging v1 = the `auto-ingested` tag** on watcher-ingested documents (the §13 prerequisite for autonomous watchers, deferred from phase 09). URL content is NOT ingested by watchers in v1 — url detection only hashes; content goes to the sandboxed action as data.
8. **The condition DSL is exactly the spec's example grammar** (`x.y contains 'lit'`) and nothing more; unsupported expressions are load-time errors. A missing path evaluates false (no fire), never true.
9. **§8 "live MCP session is prioritized" = yield-while-inflight, aging-capped** — dispatch defers while a tool call is actually in flight (a live counter around the phase-05 chokepoint, not a "recent activity" heuristic), rechecks every 1 s, and never yields more than 60 s total per dispatch.
10. **The nightly prune is a structured, AUDITED, reversible write** — `upsertNode` can null a property on an existing node, so per-session pre-images record and dashboard undo restores `transcript_ref` (pinned). No raw cypher, no un-undoable flag.
11. **`AGENTIC_OS_DOT_DIR`** keeps e2e/smoke apps away from the real `~/.agentic-os` (they were about to drain the user's real spool). Production behavior unchanged.
12. **Conservative rule-12 picks** (config.ts, recorded): task aging +1/5 min; yield recheck 1 s / cap 60 s; priorities rule-action 20 > extraction/ingest 10 > watch-scan 5 > maintenance 0; inactivity sweep every 5 min; watcher debounce 1 s; url poll floor 15 s / body cap 64 KB; hook body cap 256 KB; `trigger-state.json`; `auto-ingested` tag name.

## Deferred / notes

- **Task-row retention**: `watch-scan`/`ingest-file`/schedule task rows accumulate (one watch-scan per folder per boot; one row per schedule fire). Harmless at this scale; a retention sweep is a phase-13 hardening candidate.
- **Rules reload only at boot** — add/edit a `.rule.json` and restart (the dashboard shows loaded rules + errors). Live reload (chokidar on the rules dir) is a natural phase-13 nicety.
- **Watched-folder changes apply on next boot for the WATCHERS** (chokidar set is built at start); dashboard "scan now" works immediately on the current store either way.
- **Docker-lane rules**: the runner picks the Docker lane for non-ts/js langs and fails with guidance when Docker is missing; no demo Docker rule is shipped (the conformance suite already proves the lane; the DoD demo rule is Deno per the phase doc).
- **The skill-improvement slot enqueues nightly and no-ops** — phase 12 replaces exactly one handler body (`jobs.ts`) and inherits schedule, queue, retry, dashboard visibility.
- The e2e seeded app now RUNS its seeded pending `export` task at boot (the queue is real now) and boot-scans the seeded demo-docs folder — both benign (export to the scratch dir; content-hash dedup), verified by the green e2e.

## Instructions for phase 12 (skill-improvement agent)

- **Your trigger is already firing**: the 02:00 slot enqueues kind `skill-improvement` nightly (deterministic per-fire id, §20 retry/backoff, deferral). Replace the no-op handler body in `src/main/triggers/jobs.ts` (`registerMaintenanceHandlers`) with the real agent — or better, register a richer handler from your own module and delete the stub.
- **Event-gating** (§20 "only skills with new Corrections/failure Examples"): do it inside the handler (query the graph, exit with a note when nothing accrued) so the slot's task row honestly records "checked, nothing to do".
- **Manual "improve now"**: `queue.enqueue({kind: 'skill-improvement', id: 'skill-manual-<ts>', payload: {skillId}})` from a new IPC channel gives you the §17 manual trigger with all the queue's durability for free.
- **Cloud calls**: run them as workflow steps under the kernel (agent id of your choosing, registered in `registerInternalAgents` with a justified spend grant like `extraction-agent`); `SpendMeter` + the $0.50 ceiling apply per task id.
- The vendored skill-creator reference is at `docs/reference/skill-creator/` — read it before designing (CLAUDE.md §23 mandate).
- Everything you commit through the write lane should ride `audit.graphWrite` (see `jobs.ts` prune for the pattern) so SkillVersion flips are undoable.
