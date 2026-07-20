# Phase 34 — Close-guard: warn before closing while running or connected

**Status:** done · **Date:** 2026-07-19 · User-directed ("a warning for closing the app while anything is running or connected"). §21.11 (irreversible actions prompt first).

## What was built

Closing the app while a background job is running or Claude is connected now shows an in-app warning modal first.

- **Interception (`src/main/index.ts`).** A `win.on('close')` handler is the single choke point — the custom title-bar button (`IPC_WINDOW_CLOSE`→`win.close()`), Alt+F4, and the taskbar close all funnel through it. If the app is busy it `preventDefault`s and pushes a `CloseActivityDto` on `IPC_EVENT_CLOSE_REQUEST`.
- **`computeCloseActivity()`** reads live state: the durable queue (`runningTaskId`, plus pending/deferred counts for the informational "queued" line) and a new **`AgenticOsMcpServer.activeSessions()`** getter (interactive vs runner sessions). `busy = running || connected` (an interactive MCP session = "Claude connected"). Queued-only is **not** busy — those jobs are durable and resume next launch. A null/degraded subsystem ⇒ not busy ⇒ a normal silent close.
- **Warning modal (`App.tsx` `CloseGuardModal`, kit `Modal`).** "Close Agentic OS?" lists what's active — *Claude is connected* (with session count) and/or *a background job is running (`<id>`)* — with a reassuring "it'll pick up where it left off" line and the queued-count note. Buttons: **Keep it open** (dismiss — Escape/backdrop also dismiss) / **Close anyway** (danger).
- **Confirm loop.** "Close anyway" → `window.confirmClose()` → `IPC_WINDOW_CLOSE_CONFIRM` → main sets `forceClose` and calls `win.close()`, which the guard now lets through.

## Key design decision — programmatic quits must NOT be guarded

The guard must fire only on a user's *direct* window-close, never on `app.quit()` (the auto-updater's `quitAndInstall`, OS shutdown/logout, `window-all-closed` after a confirmed close, or Playwright's `app.close()`). The mechanism: an `app.on('before-quit')` flag (`appQuitting`) — `before-quit` fires BEFORE the window `close` events during any `app.quit()`, so `if (forceClose || appQuitting) return` bypasses the guard for every programmatic quit. This was **found via the visual smoke**: the first run's teardown hung for 120 s because `app.close()` → `app.quit()` was blocked by the guard while a seeded task ran; the `before-quit` bypass fixed it (re-run passed with a clean teardown). Belt-and-suspenders: `updater.install` also calls `deps.allowNextClose()` (sets `forceClose`) right before `quitAndInstall`.

## Files touched
`src/shared/ipc.ts` (`CloseActivityDto` + `IPC_EVENT_CLOSE_REQUEST` + `IPC_WINDOW_CLOSE_CONFIRM`), `src/main/mcp/server.ts` (`activeSessions()`), `src/main/index.ts` (`forceClose`/`appQuitting`, `computeCloseActivity`, the `close` interceptor, `before-quit`, the confirm handler, `allowNextClose` wiring), `src/main/ipc.ts` (`IpcDeps.allowNextClose` + the install-path call), `src/preload/index.ts` (`window.onCloseRequest` + `window.confirmClose`), `src/renderer/src/App.tsx` (`CloseGuardModal` + subscription + render).

## Definition-of-Done — commands run
- `npm run typecheck` (node + web) → **clean**. `npm run lint` → **clean**. `npm run build` → **all 3 bundles**.
- **Visual verification** (throwaway hermetic Playwright, since removed): pushing a synthetic `event.window.close-request` renders the modal exactly — "Claude is connected", "A background job is running (extract-demo-session)", "2 more jobs are queued", Keep it open / Close anyway; "Keep it open" dismisses. The teardown-hang finding drove the `before-quit` fix; the re-run passed clean.
- NO new deps, NO appdata change. `DEFAULT == TODAY` (idle app closes silently as before). Main-process window logic is not unit-tested (the app verifies window/quit behavior via e2e, not vitest), consistent with the existing title-bar controls.
