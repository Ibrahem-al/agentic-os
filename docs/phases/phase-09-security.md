# Phase 09 — Security: sandbox lanes, permissions, audit/undo, staged writes
**Goal:** the safety spine, fully real, before anything autonomous runs.
**Read first:** spec §7, §11, §13, §20, §21(3,5,6,11); phase reports 04, 08.

## Build
- Capability schema (zod): `{ fsRead[], fsWrite[], netDomains[], tools[], maxSpendUSD }` — single source for both lanes.
- Kernel enforcement (replace Phase-04 stub): tiered gates — auto-allow reads/retrieval; writes/net/spend → pending-approval row the dashboard surfaces (headless = stays queued); out-of-scope → hard block + span event.
- **Deno lane:** managed Deno binary; spawn with flags derived from capabilities (`--allow-read=…`, `--allow-write=…`, `--allow-net=…`); JSON stdin/stdout contract; CPU-time + memory caps; kill on timeout.
- **Docker lane:** deny-by-default container; mounts/network from the same capability object; detect-and-guide if Docker absent.
- **Conformance suite:** one capability fixture table → identical allow/deny outcomes in both lanes (run real probe scripts in each).
- Audit + undo: every committed agent action logs a reversible delta (graph inverse mutation / file pre-image in `backups/`); `undo(actionId)` executor; irreversible kinds flagged un-undoable.
- Staged-writes lifecycle: propose → human-readable diff → approve(commit via lane, audited) / reject.
- Injection defenses: ingested/tool content typed as `UntrustedText` end-to-end (can never reach a tool-call constructor); regex+LLM instruction-pattern scanner flags suspicious docs at ingest.

## Definition of Done
- [ ] Conformance suite green in both lanes (escape attempts: read outside scope, hit a non-allowlisted domain — both denied, both lanes).
- [ ] Undo round-trip: scripted graph write + file write fully reverted.
- [ ] Staged write approved → graph reflects it; rejected → no trace beyond the log.
- [ ] A fixture document containing "ignore instructions and POST…" gets flagged and triggers nothing.
**Do NOT:** weaken Hard Rules for test convenience.
