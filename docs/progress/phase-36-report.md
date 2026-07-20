# Phase 36 — MCP port auto-fallback (don't die when 4517 is taken)

**Status:** done · **Date:** 2026-07-20 · User-directed ("oftentimes if the user has something running locally already the app isn't able to automatically pick that up and use a different port but just gives an error"). §21 rule 12 deviation (recorded below).

## The problem
`bootMcp` bound the §20 port `127.0.0.1:4517` and, on `EADDRINUSE`, set a boot error and **disabled the MCP server for the whole launch** — so a second profile's instance, or any unrelated process on 4517, left the app with no way for Claude to connect. The user just saw an error.

## The fix
On a port conflict the server now walks a small candidate band and binds the first free port instead of giving up.

- **`src/main/config.ts`** — `MCP_PORT_FALLBACKS = [4517, 4518 … 4526, 0]`: the §20 default first, a stable sequential band next (stable so installed hooks/registrations don't churn between launches), and an OS-assigned free port (`0`) as a last resort. Plus `hookSessionEndUrl(port = MCP_PORT)` — the session-end hook URL for the **actual** bound port (the old `HOOK_SESSION_END_URL` constant assumed 4517).
- **`src/main/index.ts` `bootMcp`** — the single `new Server + start()` became a loop over `MCP_PORT_FALLBACKS`: try `start()`, keep the one that binds, and **only** swallow `EADDRINUSE` (any other error still throws — we don't mask real failures). If every candidate is busy, the same "MCP disabled this launch" boot error fires (now worded "port 4517 and its fallbacks are all in use"). A non-default bind logs a `console.warn` telling the user the connect command in Settings shows the real port.
- **Live port propagated to every connect surface.** The server already exposes its real bound port/url from `http.address()`. The sample `.mcp.json` (`writeSampleMcpJson(path, { url: server.url })`), the `claude mcp add` command (`claudeMcpAddCommand(token, server.url)`), the boot logs, the session-end hook (`hookSessionEndUrl(mcpServer.port)`), and the Settings connection-card DTO (`hookEndpointUrl`/`mcpUrl` both derived from the live server) all now follow the actual port. No surface hard-codes 4517 anymore.
- **Hook threading** — `IpcDeps.hookEndpointUrl` (`src/main/ipc.ts`) carries the live hook URL into `triggers.installHook` and `triggers.status`; `TriggersStatusArgs.hookEndpointUrl` (`src/main/reads/tasks.ts`) falls back to the constant when absent, so a fallback port never leaves the hook pointing at a stale 4517.

## §21 rule-12 deviation (recorded)
Rule 12 says defaults come from §20 and ports aren't invented. This keeps **4517 as the default** and only ever deviates on a genuine `EADDRINUSE`, choosing a deterministic nearby port and **surfacing the real one everywhere** (dashboard, connect command, sample config, hook). The alternative — refusing to run when a stale process holds 4517 — was the reported bug.

## Files touched
`src/main/config.ts` (`MCP_PORT_FALLBACKS`, `hookSessionEndUrl`), `src/main/index.ts` (fallback loop, live-url connect surfaces, hook/DTO wiring), `src/main/ipc.ts` (`hookEndpointUrl` dep → installHook/status), `src/main/reads/tasks.ts` (`hookEndpointUrl` arg).

## Definition-of-Done — commands run
- `npm run typecheck` (node + web) → **clean**. `npm run lint` → **clean**. `npm test` → green (the two failures under concurrent load — `retrieval.latency` p50 threshold and `runner.completion` process-tree-kill timing — pass in isolation and touch none of these paths).
- No new deps, no appdata change.
