# Phase 27 — Stuck-job fix + task control (run-now / cancel) + per-task process & resource visibility

User-directed. Report: two background actions ("workflow" and "extraction") had been stuck for
days; investigate + fix, and add the ability to (a) target a specific task to run now, (b) cancel a
job, and (c) see what process is running for a task and its RAM/CPU. Fable-5 reviewed the design;
Opus implemented.

## Root cause (confirmed from the live appdata.db)

The two rows were ONE logical extraction: the queue task `extract-<sid>` (kind `extraction`) and its
`extract-<sid>-wf` LangGraph job (kind `workflow`). The workflow failed with:

```
Ollama /api/embed returned HTTP 400: {"error":"Post \"http://127.0.0.1:57279/tokenize\":
dial tcp 127.0.0.1:57279: connectex: No connection could be made ... actively refused"}
```

That is Ollama's per-model **runner subprocess crashing / being unreachable** (its internal tokenize
port died). `OllamaClient.request()` had **no retry**, so one transient runner fault sank the whole
extraction step. The queue retried 4× (§20 1m/5m/25m) then set the task `deferred`; deferred tasks
only re-run on the next app launch's `queue.start()` reload or a manual `retryDeferred` — no
in-session recovery and no user button, so it sat "stuck for days." Secondary: ~10 workflow rows
showed `failed` = "nothing to extract" — benign (the extraction task was `done`; the handler treats
NOT_FOUND as success), but `run()` left the `-wf` row `failed`, cluttering the "failed workflow" view.

## What was built

### 1. Fix — the jobs actually complete now
- **Ollama resilience (the real fix)** `src/main/models/ollama.ts`: bounded in-process retry
  (`OLLAMA_RETRY_ATTEMPTS=3`, backoff 300ms/1s/2.5s) around `request()` for **transient** runner
  faults only — `isTransientOllamaFault()` matches HTTP 5xx, a 4xx whose body signals the runner is
  unreachable (`dial tcp`/`connectex`/`connection refused`/`tokenize`/…), and network throws. A
  permanent 4xx (bad request / unknown model) and an AbortError are re-thrown immediately;
  post-2xx validation (dim/count/no-response) is never retried (it lives outside `request()`).
- **Per-request timeout** (Fable-flagged sibling root cause): a runner that ACCEPTS the socket then
  never answers would pin a task + a pool slot forever. `OLLAMA_EMBED_TIMEOUT_MS=120s` /
  `OLLAMA_GENERATE_TIMEOUT_MS=300s` via `AbortSignal.timeout`, merged with the caller's cancel signal
  through `AbortSignal.any`. A timeout is a clean, NON-transient `OllamaError` → the step fails and
  the queue retries the whole task (by which point the daemon has usually recovered).
- **Benign "nothing to extract" is not a failure**: the extraction handler calls
  `runner.resolveNoop(workflowJobId)` on that path so the `-wf` row settles to `done`.
- **Boot reconciliation** `reconcileWorkflowJobs()` (runs before `queue.start()`): flips orphaned
  `running` workflow rows with no live driver → `failed`, and settles existing benign "nothing to
  extract" `failed` rows (with a `done` driver) → `done`. Rows a pending/deferred/running driver will
  resume are left untouched; non-task (`-wf`-less) workflow ids are never touched.

### 2. Run now (target a task)
`DurableTaskQueue.runNow(id)` force-runs any task regardless of state (deferred/failed/cancelled/
backoff-pending), resetting its §20 round + clearing backoff. `retryDeferred` now delegates to the
same `forceRun()` (deferred-only). IPC `tasks.runNow` + a per-row "Run now" button.

### 3. Cancel a job — §8 cooperative cancel
`DurableTaskQueue.cancel(id)`:
- in-flight task → set `CurrentTask.cancelRequested` + abort its `AbortController`; **runTask's settle
  path is the SINGLE writer** of `cancelled` (so `recordFailure` can never overwrite it, and a handler
  that finishes despite the cancel still lands `done`); plus kill the task's runner child process(es).
- pending/deferred/orphaned/bare-workflow row → drop from memory + mark `cancelled` now.
- rejects a finished task and one parked behind a §13 approval (INVALID_STATE — "decide it in
  Approvals"; the human-gated spine is untouched).

The `AbortSignal` threads `queue → extraction handler → agent.run/resume → RunWorkflowOptions.signal →
LangGraphRunner`. The runner checks the signal at every **step boundary** (§8 "no mid-generation
preemption") → `WorkflowCancelledError` → `settleFailure` marks the `-wf` row `cancelled` (not
`failed`). Cancel is not terminal-forever: `runNow` revives a cancelled task, and the workflow resumes
from its last checkpoint exactly like a failed one (`resume()` still only no-ops on `done`).

New task status **`cancelled`** → appdata **v10** (`migrateTasksStatusCheck`, a guarded/idempotent
in-place tasks-table rebuild widening the CHECK, mirroring the v8 audit_log rebuild — 11-column copy,
`idx_tasks_status` recreated, pre-upgrade snapshot as the outer net). Retention sweep now also prunes
`cancelled` rows (sparing the §6 exactly-once `extract-*` tokens).

Runner-child kill is **pid-reuse-safe** (Fable): `killRunnerChildrenForTask()` kills the in-process
`liveChildren` registry (extended with `taskId`) — never a recycled DB pid.

### 4. Process + RAM/CPU per task
IPC `tasks.processes` (+ `TaskProcessesDto`) over `reads/processes.ts`, three honest layers:
- **host**: the app's own main process (Electron `app.getAppMetrics` — cross-platform CPU +
  workingSet) — where in-process tasks (extraction/ingest/skills/maintenance) actually run.
- **localRuntime**: the SHARED Ollama daemon's loaded models (`/api/ps` — memory per model).
- **children**: the task's runner `claude` children (runner_runs by task_id) sampled by pid via
  `reads/processSampler.ts` (`tasklist` on win32 → RAM; `ps -o rss=,%cpu=` on posix → RAM+CPU). No new
  dependency. Best-effort throughout — a vanished pid / dead daemon / sampler failure degrades to
  null/empty, never a throw. Dashboard: a "What's running & resources" section + a per-row "Resources"
  button.

## Decisions / deviations (rule-12 recorded)
- Retry counts/backoff/timeouts are invented values (§20 has none for this): 3 tries @ 300ms/1s/2.5s;
  embed 120s / generate 300s ceilings. Chosen so legitimate work is never cut off but a hang is bounded.
- **Cancel timing**: prompt at step boundaries and for child processes; a task stuck *inside a single
  model call* is cancelled when that call returns or hits its per-request timeout (the signal is
  threaded to the workflow node but NOT deep into each extraction embed/generate — a larger surface
  deferred). The retry + timeout already prevent/bound the hang that motivated this.
- **MCP parity deferred**: the four asks are delivered on the dashboard/IPC (the user-facing surface,
  §21.6-consistent). No new MCP control/read tools were added, to avoid destabilizing the carefully
  counted/tested 38-tool surface. `retry_task` (deferred-only) is unchanged.
- Dropped best-effort Ollama-daemon-pid RAM/CPU (Fable): `/api/ps` gives no pid and `tasklist` has no
  CPU% — the ps size/vram + host metrics are the honest readout.

## Adversarial review (2 independent Opus reviewers over the diff) — findings fixed
- **HIGH (fixed):** the per-request timeout was misclassified — undici rejects an `AbortSignal.timeout`
  fetch with a DOMException named `TimeoutError`, NOT `AbortError`, so my timeout branch was dead code
  and a timeout fell through to the "unreachable" (transient) path → it would retry the hang ~4× the
  ceiling. Now detected via the timeout signal OR the `TimeoutError` name, ahead of the abort gate, and
  is non-transient. New test drives a real `TimeoutError`.
- **MEDIUM-HIGH (fixed):** the dashboard showed `Cancel` on `kind='workflow'` rows, and cancelling a
  live `<taskId>-wf` row killed the extraction's child + raced the runner's terminal write. Fixed:
  hide Cancel on workflow rows (the user cancels the driver row), AND `queue.cancel()` now redirects a
  live workflow-row cancel to its driver (defense for any other caller). New test.
- **LOW (fixed):** `getTaskProcesses` runner_runs query now try/caught + LIKE wildcards escaped (honor
  "never throws"); the cancel toast now says "Cancelling…" for a running job (cooperative) vs "cancelled"
  for a dropped queued one; `resolveNoop` guards against touching a 'running'/'done' row.
- Confirmed correct by both reviewers: single-writer cancel (no recordFailure overwrite), signal
  set/cleared per job (no leak), v10 migration (index recreated, 11-col copy, snapshot), reconcile
  driver-liveness logic, retention sparing §6 tokens, DEFAULT==TODAY, IPC error mapping, no renderer loop.

## Gates
- `npm run typecheck` (node + web): clean.
- `npm run lint` (changed files): clean.
- `npm test` (full offline): **1098 passed | 21 skip | 2 failed** — the 2 are the known
  load-induced flakes (`retrieval.latency p50<500ms`, `runner.completion` process-tree-kill timing);
  both PASS in isolation (14/14). +~30 new tests: ollama retry/timeout/abort classification, queue
  cancel/runNow (single-writer, done-wins, revive, guards), kernel-runner cancel/resolveNoop, appdata
  v9→v10 migration (rebuild + index + snapshot + cancelled round-trip), reconcileWorkflowJobs matrix,
  getTaskProcesses (host/models/children + degradation).
- NO new npm dependencies. `DEFAULT == TODAY` preserved (runner off / keyless install byte-identical
  except the intended fixes).

## Files
main: models/ollama.ts, config.ts, kernel/{types,runner,index}.ts, triggers/{queue,jobs,sessionEnd,
index}.ts, agents/extraction/agent.ts, runner/{spawn,index}.ts, storage/appdata.ts,
reads/{processes,processSampler,index}.ts, ipc.ts, index.ts. shared: ipc.ts. renderer:
panels/TasksPanel.tsx, lib/plain.ts. Tests: unit/{models.ollama,triggers.queue,triggers.reconcile,
reads.processes,kernel.runner,appdata,storage.reset}.

## For the user's live stuck task
On the next launch the boot reconcile + the Ollama retry make `extract-adf50dc6-…` recoverable; the
user can also click **Run now** on it (or Cancel it) from the Background-work panel, and watch its
process + RAM/CPU in "What's running & resources".
