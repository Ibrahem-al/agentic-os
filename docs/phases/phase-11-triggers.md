# Phase 11 — Triggers & automation
**Goal:** the system becomes autonomous: durable task queue, schedules, SessionEnd hook + spool, inactivity fallback, watchers, user rules.
**Read first:** spec §6 (session-end, 3-tier), §7, §8 (queue mirror), §17 (rule format), §20; phase reports 08–10.

## Build
- **Durable queue:** in-memory priority heap mirrored to `tasks` (insert on enqueue, status updates, reload pending/deferred on boot). Retry/backoff per §20; deferral persists.
- `croner` schedules: nightly prune 03:00 (drop `transcript_ref` > 14 d, keep stubs), weekly export Sun 03:30, nightly skill-job slot 02:00 (no-op until Phase 12).
- **Hook endpoint** `POST /hooks/session-end` (auth: token) → enqueue extraction. **Hook installer:** safe deep-merge into `~/.claude/settings.json` (never clobber existing hooks; show diff; backup); hook command = `scripts/hooks/session-end.sh|.ps1` → POST, on connection failure append JSON to `~/.agentic-os/pending-sessions/`; app drains spool on boot.
- Inactivity fallback: session id with `mcp_calls` silence > 30 min → enqueue extraction (idempotent with the hook — dedup by session id).
- Watchers runtime: cheap local detection (poll/diff via chokidar or fetch+hash) → on trigger, enqueue the action; spend gated.
- User rules: load + zod-validate `~/.agentic-os/rules/*.rule.json` (spec §17 shape); actions execute through the Phase 09 lanes under their declared capabilities.

## Definition of Done
- [ ] Kill the app with 3 queued tasks → restart → all 3 run.
- [ ] Fake SessionEnd POST → extraction runs end-to-end on a fixture session. App closed + spool file → drained on next boot.
- [ ] Same session via hook AND inactivity → extracted exactly once.
- [ ] Demo rule (watch a local file, run a TS action in Deno writing to its allowed dir) fires; an out-of-scope write from it is denied.
- [ ] Hook installer test: settings.json with a pre-existing hook keeps it intact (golden-file diff).
