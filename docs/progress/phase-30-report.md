# Phase 30 — Task Resources view + Cancel warning + Pause/Resume

**Status:** done · **Date:** 2026-07-18 · User-directed feature (outside the numbered spec plan).

## What the user asked for

> "when users click resources on a completed task it does nothing … I would want it to show the user
> averages and time that it took … it also didn't work with an active task so make sure to check if there
> are any issues … lastly when the user attempts to cancel a job give a warning since it would be
> destructive and then also give an option to pause a job but not end it."

## Diagnosis of "Resources does nothing"

The per-row **Resources** button *did* fire — it set `procTarget`, which updated a persistent "What's running
& resources" **section far below the jobs table**. So (1) nothing near the button changed and (2) that
section only ever showed the *app's* live process metrics (`app.getAppMetrics`) + Ollama models — identical
for every task and empty of task-specific info. For a **completed** task there's no live process, so it read
as "nothing happened." Both a UX problem and a missing feature.

## What was built (three parts)

### 1. Resources → a per-task modal with a real summary
- Clicking **Resources** now opens a **modal** (unmistakable feedback), titled `Resources — <job>`.
- It leads with a **summary**: **time it took** (or "…so far" live for a running task), **how that compares
  to the typical time for that job kind** (mean over recent finished runs of the same kind — the "average"),
  **tries**, and any **attributable AI usage** — cloud tokens/$ from `spend` and runner tokens from
  `runner_runs` (both keyed on `task_id`; the on-device tier isn't itemized per task, stated honestly).
  For a **running** task it also shows the live processes (host + shared models + children).
- **Backend:** new `tasks.started_at` column (set in `queue.markRunning`) drives duration;
  `reads/processes.ts buildTaskSummary` computes it + the kind average + usage; `getTaskProcesses` now
  returns a `summary` (`TaskSummaryDto`). Pure, fully guarded (never throws into the read).

### 2. Cancel → a destructive-action warning
- Cancel now opens a **"Stop this job?"** modal explaining it discards progress (revivable with Run now, but
  it starts over) and offers **"Pause instead"** as the non-destructive alternative — directly answering the
  request. Buttons: *Keep it* · *Pause instead* · *Cancel job* (danger).

### 3. Pause / Resume (hold without ending)
- New `'paused'` status (**appdata v11**: `migrateTasksV11` — a guarded in-place rebuild widening the
  `tasks.status` CHECK to add `'paused'` and adding `started_at`, same idempotent pattern as the phase-27 v10
  migration).
- **`queue.pause()`** — a running task stops cooperatively (abort its signal + kill children) and its settle
  path is the **single writer** of `'paused'` (mirrors cancel, so `recordFailure` can't overwrite it); a
  pending/deferred task is held. **Paused rows are not reloaded by `start()`**, so a pause survives restarts.
  **`queue.resume()`** re-queues it (a workflow resumes from its checkpoint; a plain handler re-runs).
  **Cancel wins over Pause** when both target the in-flight task.
- IPC `tasks.pause` / `tasks.resume`; a standalone **Pause** button (running/pending/deferred), a **Resume**
  button (paused), and Cancel widened to cover paused. Status vocabulary: `plainStatus('paused')` +
  `statusColor.paused='undo'` + the jobs composition bar.
- The confusing persistent "What's running & resources" section was **removed** (superseded by the modal).

## Adversarial review
3-reviewer workflow (queue / read+schema / renderer) + a verify pass. Queue and renderer: clean. One
confirmed **low** finding — `buildTaskSummary` used `updated_at` as the run-end for *all* non-running rows,
but `updated_at` is bumped by a later transition (e.g. a **deferred-then-paused** task, or a restart
re-pend) while `started_at` stays, inflating the "time it took" across the idle gap. **Fixed**: duration is
computed only for genuinely terminal rows (`done`/`failed`/`cancelled`, whose `updated_at` is frozen at
settle) and live for running; paused/deferred/pending report null. A regression test pins it.

## Definition-of-Done — commands run
- `npm run typecheck` → clean (node + web). `npm run lint` → clean. `npm run build` → bundles built.
- Tests: **appdata** (new v10→v11 migration test: paused + started_at, data preserved) + **storage.reset**
  (version bumped to 11) + **triggers.queue** (6 new: pause-holds-then-resume, pause-in-flight single-writer,
  cancel-wins-over-pause, pause/resume rejections, paused-survives-restart, started_at recorded) +
  **reads.processes** (summary: duration/kind-avg/cloud/runner, live vs terminal, and the paused-duration
  guard) — the affected suite runs **72 passed** across those files.
- **Visual verification** (temporary Playwright shots over the demo seed, since removed): the jobs table
  shows Pause · Cancel · Resources on active jobs (Run now · Resources on failed, Resources-only on done);
  **Resources** opens the modal ("Running for: 2.8 s so far", tries, AI used, live processes); **Cancel**
  opens the "Stop this job?" warning with **Pause instead**.

## For the next session
Duration precision is bounded by reusing `updated_at` as run-end for terminal rows (no dedicated per-run
`finished_at` column). If exact duration for paused/deferred rows is ever wanted, add a `finished_at` column
set only at run-settle (in `runTask` + `recordFailure`) and cleared at `markRunning`. Local-tier AI usage is
still not attributable per task (`local_llm_usage` has no `task_id`).
