# Phase 10 — Dashboard (design-skill heavy)
**Goal:** the full v1 cockpit per spec §3 — and it must NOT look like AI slop.
**Read first:** spec §3, §13 (what review/audit must show), §20; phase reports 05–09.

## Design protocol — do this BEFORE writing components
1. `/impeccable init` — context: technical operators monitoring an autonomous local system; personality: instrumental, calm, precise; dark-mode-first.
2. Query ui-ux-pro-max for patterns: `python3 .claude/skills/ui-ux-pro-max/scripts/search.py "developer dashboard data dense dark" --design-system -f markdown` (+ targeted searches per panel: table, timeline, graph viz, diff view).
3. Apply taste/design-taste-frontend with dials **VARIANCE 4 · MOTION 2 · DENSITY 7**.
4. Commit `src/renderer/design-tokens.ts` + a shared layout shell FIRST; only then parallelize panels with subagents.
5. Iterate visually with **Playwright MCP** against `npm run dev` (screenshot → adjust → repeat). Finish with `/audit` (a11y + responsive) and `/polish`.

## Panels (each reads real stores via typed IPC; no Node in renderer)
Memory browser (search + node inspector + neighborhood view) · Review queue (staged writes & skill adoptions, provenance shown: source session, pipeline pass, confidence; approve/reject) · Audit/undo timeline (with working Undo) · Spend monitor · Tasks & watchers manager · Trace viewer (waterfall from `traces`) · Skill analytics · Ingestion panel (file/folder pick → Phases 06/07, with progress) · Settings (providers, keys, models, Ollama status).

## Definition of Done
- [ ] Every panel functions against real data (seed script provided for demo data).
- [ ] Playwright e2e: approve a staged write; undo an action; trigger a folder ingest from the UI.
- [ ] `/audit` findings addressed or recorded; screenshots of every panel in the phase report.
- [ ] No `any` in IPC contracts; renderer imports no Node module.
