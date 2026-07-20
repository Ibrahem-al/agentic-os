# Phase 40 — Update-while-a-job-runs: tell the user + offer pause-and-restart

**Status:** done · **Date:** 2026-07-20 · User-directed ("when the user attempts to update while a job is running it doesn't work and doesn't tell them it isn't restarting because a job is in progress — let them know and give the option to pause the work and restart").

## The problem
Clicking **Settings → Updates → Restart to update** while a background job was running gave a bad experience: `updater.install` ran `quiesceForInstall`, which **silently** waited up to 30s for the durable queue's running task + the write lane to drain (no feedback during the wait), and if the job outlived the bound it deferred with a vague message — *"The app is finishing a write — the update will install when you next close it."* — that never said a **job** was blocking the restart and offered no way to proceed.

## What was built

### 1. Backend — `updater.install` is job-aware (`src/main/ipc.ts`)
The handler now inspects `queue.runningTaskId` up front:
- **A job is running and `force` is not set** → it returns *immediately* (no silent 30s wait) with `installDeferred: true`, the new **`blockedByTaskId`** field, and a plain message naming the job. The install is not attempted — the running write is never interrupted.
- **`force: true`** ("pause and restart") → it **`queue.pause(runningTaskId)`** first (a cooperative abort that settles the task to `paused` — nothing is lost, it resumes on request), then runs the same `quiesceForInstall` (which now drains promptly), checkpoints, `allowNextClose()`, and `quitAndInstall()`.
- **No running job** → unchanged: quiesce (fast) → install. A lane-busy-but-no-queued-job defer still returns the original generic message (no `blockedByTaskId`).

`updater.install`'s request type went from `void` to `{ force?: boolean }`; `UpdaterStatusDto` gained `blockedByTaskId?: string` (set alongside `installDeferred`).

### 2. UI — say why, and offer to pause (`src/renderer/src/panels/SettingsPanel.tsx`)
`installUpdate(force = false)` calls `updater.install` with the flag. When the result carries `blockedByTaskId`, the Updates section renders a dedicated block (`updater-blocked-job`): *"The app didn't restart because a background job is running (`<id>`). It'll update on its own once the job finishes and you close the app — or pause the job and restart now (you can resume the job from Jobs afterwards)."* with a **"Pause the job & restart"** primary button that calls `installUpdate(true)` (shows "Pausing…" while it works). The plain write-drain defer keeps its original single-line message (gated on `blockedByTaskId === undefined`), so that path is unchanged.

## Design notes
- **Pause, not cancel** — the user asked to *pause* the work; `queue.pause` settles the task to `paused` (survives the restart; the user resumes it from Jobs). Cancel would discard progress.
- **No silent wait** — the running-job path returns instantly so the user gets immediate, specific feedback instead of a frozen 30s.
- Reuses the existing `queue.pause` (phase 30) and the `allowNextClose` close-guard bypass (phase 34); the §21.9 quiesce/checkpoint crash-safety is untouched (a paused-then-drained store still checkpoints before the new binary boots).

## Files touched
`src/shared/ipc.ts` (`blockedByTaskId` + `updater.install` req `{force?}`), `src/main/ipc.ts` (job-aware install handler), `src/renderer/src/panels/SettingsPanel.tsx` (`installUpdate(force)` + the blocked-job block + `pausingRestart` state), `tests/unit/ipc.updater.test.ts` (new — running job blocks + names the task; `force` pauses then installs; no job installs straight away).

## Definition-of-Done — commands run
- `npm run typecheck` (node + web) → **clean**. `npm run lint` → **clean**. `npm run build` → **all 3 bundles**.
- `tests/unit/ipc.updater.test.ts` (3) + `updater` + `ipc.settings` + `ipc.reconnect` → **47 passed**; full suite green.
- No new deps, no appdata change. `DEFAULT == TODAY`: with no job running the restart behaves exactly as before; the plain write-drain defer message is unchanged.
