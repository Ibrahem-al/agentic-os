# Phase 00 — Scaffold & de-risk
**Goal:** a running Electron+TS app, native-module pipeline proven, RyuGraph viability proven, CI green, build skills installed.
**Read first:** spec §0–§3, §5, §20–§23.

## Build
- `git init`; scaffold with **electron-vite** (main / preload / renderer), TypeScript `strict`, React + Tailwind in renderer. Repo layout per spec §22 (create empty module folders).
- Native-module pipeline: install `better-sqlite3` + `onnxruntime-node`, wire `npm run rebuild:native` (electron-rebuild), prove both load **inside Electron main** (log versions on launch).
- **RyuGraph de-risk spike (the point of this phase):** find the official Node binding via docs.ryugraph.io / github.com/predictable-labs/ryugraph. Pin ≥ v0.11.3. In Electron main: create a DB on disk, load the **vector + FTS extensions with networking disabled**, create a node, query it back. If extensions are not pre-installed in the npm build, vendor them into `resources/extensions/` and load from there.
  - If no Electron-compatible binding exists after honest effort → write `docs/progress/BLOCKER.md` comparing the failure to the spec §5 SQLite fallback, and STOP (the only permitted stop).
- Config module `src/main/config.ts` exporting every §20 value (port, paths, thresholds, model names). Everything else imports from it.
- CI (GitHub Actions): lint, typecheck, vitest, and the offline extension-load check on ubuntu/macos/windows.
- Install build skills (document each result in the report):
  - `npx skills add https://github.com/Leonxlnx/taste-skill --skill "design-taste-frontend"`
  - `/plugin marketplace add pbakaus/impeccable` → `/plugin` → install impeccable
  - `/plugin marketplace add nextlevelbuilder/ui-ux-pro-max-skill` → `/plugin install ui-ux-pro-max@ui-ux-pro-max-skill`
  - Playwright MCP: `claude mcp add playwright -- npx @playwright/mcp@latest`
  - Vendor Anthropic's skill-creator into `docs/reference/skill-creator/` (clone from github.com/anthropics/skills, copy the skill folder).
- Copy this handoff's `CLAUDE.md`, `docs/` into the repo if not already present.

## Definition of Done
- [ ] `npm run dev` opens a window; main logs better-sqlite3 + onnxruntime versions.
- [ ] RyuGraph spike script passes offline (run with network blocked) on this machine.
- [ ] `npm run lint && npm run typecheck && npm test` green; CI config committed.
- [ ] Skills installed and listed in the phase report with verification output.
**Do NOT:** start the storage abstraction, schema, or any feature work.
