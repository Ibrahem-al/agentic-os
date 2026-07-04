# Phase 13 — Scheduler hardening, packaging, full E2E
**Goal:** contention policy, auto-update with safe migrations, installers, and one golden-path E2E that exercises the whole organism.
**Read first:** spec §3 (updates), §8, §15, §16, §20; ALL phase reports.

## Build
- Scheduler policy: priority classes (live MCP > user-initiated > background) with aging; cloud-brain single lane + per-provider rate limits; local pool concurrency; cooperative yield at step boundaries only.
- `electron-updater` wiring; prove update path runs migrations WITH the pre-migration backup (§21.9); `electron-builder` targets mac (arm64+x64) / win / linux, artifacts in CI.
- **Golden-path E2E (scripted, the release gate):** fresh profile → ingest a fixture codebase → MCP client session calls `get_context` (Components appear) → session ends via hook → extraction populates memory → a staged write is approved in the dashboard → seeded corrections → skill job improves + adopts → an audited file write is undone. Assert state at every arrow.
- Perf sanity: retrieval p50 < 500 ms on a 10k-node graph (record numbers).
- README + setup guide (Ollama, optional Docker, hook install, connecting Claude Code). Final `/audit` + `/polish` pass on the dashboard. Tag `v0.1.0`.

## Definition of Done
- [ ] Golden-path E2E green in CI on at least two OSes.
- [ ] Installer from CI artifacts boots on a clean machine/VM; guided Ollama setup appears.
- [ ] Perf numbers + any deviations recorded in the final report.
