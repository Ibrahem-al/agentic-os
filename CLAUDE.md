# CLAUDE.md — Agentic OS build

You are building **Agentic OS**: a local-first Electron desktop app that is a memory-and-tool backend for AI agents. Claude (external, over MCP) orchestrates; this app serves context, learns from finished sessions, and runs background agents. Full design: `docs/spec.md` — it is the single source of truth.

## Every session, in this order
1. Read this file.
2. Read `docs/PROGRESS.md` — see what is done and what phase is next.
3. Read the **last two** reports in `docs/progress/` for fresh context.
4. Read your assigned `docs/phases/phase-NN-*.md`, then every spec section it lists.
5. Build **only** that phase.

## Non-negotiables (full list: spec §21)
- All graph writes through the single write lane. Provenance stamped on every extraction write.
- User/rule code only in the Deno or Docker sandbox lane. Never the host.
- Claude's only write path is `propose_correction` → staged → validated.
- Defaults come from spec §20 — never invent ports, thresholds, or model names.
- Never build anything from the spec's "Optional / deferred" list.
- TypeScript `strict`. Renderer has no Node access; typed IPC only.

## Commands
- `npm run dev` — Electron app w/ HMR
- `npm test` — vitest unit + integration
- `npm run test:e2e` — Playwright
- `npm run lint && npm run typecheck`
- `npm run rebuild:native` — electron-rebuild for better-sqlite3 / onnxruntime-node / RyuGraph binding

## End-of-phase protocol (mandatory, in order)
1. All Definition-of-Done items in the phase doc pass. Run the listed commands; paste outputs into the report.
2. Write `docs/progress/phase-NN-report.md`: what was built (files/modules), key decisions + why, anything deferred or surprising, exact instructions the next phase needs.
3. Update the `docs/PROGRESS.md` table row: status `done`, date, one-line summary.
4. `git add -A && git commit -m "phase-NN: <summary>"`.
5. Stop. Do not start the next phase.

## Subagents & thinking
Use subagents whenever you judge they help. One rule: two subagents must never write the same core module concurrently. Think as hard as the problem deserves; phases 01, 08, 09, 12 deserve the most.

## Asking the user
Ask before installing anything (npm packages beyond the §20 stack pins, plugins, binaries, MCP servers, model downloads) and whenever a decision genuinely needs the user's input — credentials, destructive choices, or spec ambiguities with real tradeoffs. For small ambiguities, prefer the option most consistent with spec §21 and record it in the phase report. A true blocker (e.g., the Phase 0 RyuGraph spike fails) → write `docs/progress/BLOCKER.md` with findings and stop.
