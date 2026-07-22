# Phase 41 report — Dedupe "accept all" + AI graph-cleanup over MCP

User-directed feature (two asks): **(1)** a button in Find duplicates that accepts every suggested
merge in one step, and **(2)** a new MCP option that has an AI go through the graph and clean
things up. Fable-5 designed/orchestrated + verified; Opus implemented (4 streams) and reviewed
(3 adversarial lenses → refute-by-default verification → fix pass).

## What was built

### 1. Batch "accept all" merge (backend + UI)

- `src/main/memory/dedupe.ts` — `mergeDuplicateGroups(deps, { groups })`: validates every group
  pre-lane via `planDedupeMerge`, then collapses **all surviving groups in ONE audited lane job**
  (one undo in History restores the entire batch — nodes with embeddings, edges, everything).
  Stale-scan safe: a group whose nodes vanished since the scan is skipped and reported in
  `skipped` (never fatal); a group overlapping an earlier merge in the batch is skipped
  ('overlaps an earlier merge in this batch'); a structurally bad request (unsupported label,
  keeper ∈ removeIds) still throws INVALID_INPUT. Zero surviving groups → **no lane job**,
  `auditActionId: null`. The single `mergeDuplicates` was refactored onto the same shared core
  (`collectMerge`) with behavior byte-compatible (existing suites untouched and green).
- `src/shared/ipc.ts` + `src/main/ipc.ts` — channel `memory.dedupe.mergeAll`
  (`MemoryDedupeMergeAllResultDto { auditActionId|null, mergedGroups, removed, edgesRepointed,
  edgesDropped, skipped[] }`), actor DASHBOARD_USER.
- `src/renderer/src/panels/MemoryPanel.tsx` (DedupeModal) — a "Merge all N suggested" primary
  button in the results header (visible when ≥1 mergeable group), inline confirm
  (`role="alertdialog"`, focus moves in on open / returns to the opener on close), honoring the
  user's per-group keeper radios (default = suggested keepers). Skill/Project groups stay
  report-only and the confirm copy says so. Result toasts report the SERVER counts; skipped
  groups get an info toast; auto re-scan after. testids: `dedupe-accept-all`,
  `dedupe-accept-all-confirm`.

### 2. AI graph-cleanup agent + `run_graph_cleanup` MCP tool

- `src/main/agents/cleanup/index.ts` (NEW, exported via the agents barrel) — §8 task kind
  **`graph-cleanup`**: `enqueueGraphCleanup` (deterministic per-minute id
  `graph-cleanup-YYYY-MM-DDTHHmm` → same-minute dedup; priority maintenance),
  `registerGraphCleanupHandler`, and the pure core `runGraphCleanup`. The run: duplicate scan
  (scope `recent` default = last `DEDUPE_RECENT_DEFAULT_WINDOW_MS`, or `count`/`all`) → EXACT
  groups validated + staged directly (rationale 'identical wording (exact duplicate)') → NEAR
  groups judged by the **local LLM** via new router role `cleanup.dedupeJudge`
  (schema-constrained `{same, keep_id?, reason}` over the members' FULL texts; hallucinated
  `keep_id` falls back to the scan's suggested keeper; per-group try/catch) → confirmed groups
  staged with the AI's rationale. Every proposal is a staged **`dedupe-merge`** row
  (`stageDedupeMerge`, proposer `agent:graph-cleanup`) — **§21 rule 6 holds: staging is the
  agent's ONLY write; the graph is provably untouched (pinned by test)**. Groups already covered
  by a pending staged row are skipped (no proposal pile-up on re-runs); judgments cap at
  `GRAPH_CLEANUP_MAX_LLM_JUDGMENTS` with honest truncation in the `{ note }`; router absent →
  exact-only with 'AI judge unavailable' noted; Skill/Project groups counted report-only.
- `src/main/models/provider.ts` + `src/main/reads/reasoningRoles.ts` — role
  **`cleanup.dedupeJudge`** = `{ today: 'local-qwen3', hardLocal: false, subscribable: true }`
  (same routing class as `extraction.tiebreak`), grouped under 'Understanding your sessions'
  (role surface now 15; override validation picked it up automatically via ROLE_KEYS).
- `src/main/config.ts` — rule-12 constants: `GRAPH_CLEANUP_MAX_LLM_JUDGMENTS = 50`,
  `GRAPH_CLEANUP_JUDGE_MAX_TOKENS = 512` (both documented in-file).
- `src/main/mcp/tools/control.ts` — MCP control tool **`run_graph_cleanup`**
  (scope/count/threshold/labels, all optional) → enqueues the task; the description + reply note
  state it STAGES for review and never merges directly. Tool surface is now **42**
  (29 read + 5 staged + 8 control).
- `src/main/security/permissions.ts` — `run_graph_cleanup` added to `DASHBOARD_TOOLS`
  (interactive sessions only). `RUNNER_SESSION_ALLOWLIST` + per-task runner templates
  **byte-unchanged** (pinned tests green; runner sessions get PERMISSION_DENIED).
- `src/main/index.ts` — `registerGraphCleanupHandler(queue, { engine, db, router })` registered
  in bootTriggers beside the other handlers.
- IPC `memory.dedupe.cleanupStart` (`{ scope, count? } → { taskId, deduped }`) + a
  "Let AI clean up" button in the DedupeModal controls with an explain/confirm block
  ('…proposals appear in Approvals — nothing changes without your approval'); testids
  `dedupe-ai-cleanup`, `dedupe-ai-cleanup-confirm`.
- Docs: in-app Docs (Mcp.tsx '~42 tools', Architecture.tsx '~42') + README (Find-duplicates
  paragraph now covers merge-all + AI cleanup + `run_graph_cleanup`).

## Adversarial review (3 lenses → verify → fix; all findings fixed)

- **HIGH (confirmed by 2 independent reviewers + 2 verifiers): cross-group edge loss in the
  batch merge.** An edge whose BOTH endpoints were removed in two *different* groups of one
  batch (e.g. duplicate Knowledge TAGGED to a duplicate Tag) was re-pointed per-group onto a
  soon-to-be-DETACH-deleted node — the keeper→keeper edge was never created and `edgesDropped`
  under-reported, silently. **Fix:** a batch-global removed-endpoint → keeper map (keyed
  `label:id`) built over all surviving groups, one shared `collectMerge` pass re-points BOTH
  endpoints through it → cross-group edges become keeperA→keeperB. Regression tests pin the
  re-point and that a single undo restores the originals.
- **LOW:** accept-all confirm's Cancel was frozen by a running scan (asymmetric with the
  per-group confirm; reachable via a second window) → Cancel now gated by `busy` only.
- **LOW:** the confirm swap lost keyboard focus and was unannounced → `role="alertdialog"` +
  focus lifecycle (in on open, back to the opener on close).

## Gates (all run fresh at the end, after every fix)

- `npm run typecheck` → clean (both tsconfigs). `npm run lint` → clean.
- Phase suites: `memory.dedupeMergeAll` (8 incl. the 2 cross-group regressions) +
  `memory.dedupe` + `memory.dedupeController` + `agents.cleanup` (10) + `mcp.graphCleanup` +
  `ipc.cleanupStart` + `models.provider` + `reads.reasoning-roles` + `ipc.settings` +
  `security.permissions` → **10 files, 119/119 passed**.
- Live e2e visual verify (throwaway hermetic Playwright spec, deleted after): seeded two
  identically-named Tags → scanned 'Everything' → both buttons render → accept-all alertdialog
  confirm + Cancel → AI cleanup confirm → 'AI cleanup started — proposals will appear in
  Approvals.' toast → real batch merge → 'Merged 1 duplicate across 1 group — undo available in
  History.' **1 passed (38.9s)**; 4 screenshots eyeballed (also confirmed the phase-36 port
  fallback: the hermetic instance bound 4518 beside the live app's 4517).
- Full `npm test` deliberately not re-run (known load flakes; every touched suite ran green in
  isolation — the established phase practice).

## Decisions & deviations (recorded)

- The cleanup agent's `recent` scope computes its own cutoff (now − 7d window) and deliberately
  does NOT touch the dashboard scan controller's `dedupe_scans` watermark — a background sweep
  must not change what the user's next manual "recently changed" scan compares.
- The cleanup module keeps a small local mirror of the per-label text-column map (dedupe.ts's
  `DEDUPE_RENDER` is module-private); commented as a deliberate duplication.
- v1 cleanup = duplicates only. Orphan-node pruning / stale-content proposals would need a new
  staged-write kind (delete) + Approvals UI + committer — deferred, noted here.
- `runGraphCleanup` (the pure core) is exported beyond the minimal surface for testability,
  mirroring how the skills agent exports its cores.
- agents.cleanup tests seed append-only (monotonic `updated_at` + per-test labels): deleting
  graph nodes between tests hangs the ryugraph 25.9.1 binding synchronously (same fault family
  phase 24 recorded). Documented in the test-file header.
- Runner-denial is proven at the PermissionEngine level + a RUNNER_SESSION_ALLOWLIST membership
  pin (no full runner HTTP session stood up) — matches the existing control-tool denial pattern.
- Commit adds explicit paths rather than `git add -A`: the working tree contains pre-existing
  user-owned untracked files (`AGENTIC-OS-COMPLETE-GUIDE.md`, `bash.exe.stackdump`) that must
  not ride along.
- Infra note: the implementing workflow lost two agents to transient network drops
  (`ENOTFOUND`) and one to a structured-output cap — all work was recovered from disk each time
  (journal + git state), verified, and completed; nothing was re-implemented blind.

## For the next phase

- The cleanup agent stages `dedupe-merge` rows — the existing Approvals UI renders them
  (`stagedSummary` kind 'dedupe-merge', proposer `agent:graph-cleanup`); approve runs the same
  audited `mergeDuplicates`, undoable from History.
- `run_graph_cleanup` args: `{ scope?: 'recent'|'count'|'all', count?, threshold?, labels? }`;
  same-minute calls dedup (`deduped: true`).
- If a future phase wants scheduled cleanups, `RULE_PRESETS` (triggers/rules.ts) is the seam —
  add a 'graph-cleanup' preset enqueuing the existing kind.
