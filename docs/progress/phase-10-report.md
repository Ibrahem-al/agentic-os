# Phase 10 report — Dashboard

**Status:** done · **Date:** 2026-07-04

## What was built

The full v1 cockpit (spec §3): nine panels over the real phase 01–09 stores, behind a typed IPC contract (§21 rule 8), designed through the mandated protocol (impeccable init → ui-ux-pro-max pattern searches → taste dials VARIANCE 4 · MOTION 2 · DENSITY 7 → tokens + shell first → panels in parallel → Playwright-driven visual iteration → audit + polish).

### Design system (committed BEFORE components, per the phase doc)

- **`PRODUCT.md` + `DESIGN.md`** (repo root) — the impeccable project context. Register: product. Personality: instrumental, calm, precise. Theme: **dark, locked** (scene: operator's second monitor, low ambient light — a single-theme desktop instrument, `color-scheme: dark` declared). Strategy: chroma-0 neutral ramp carries ~95% of every screen; ONE indigo accent (`oklch(0.68 0.14 268)`, the impeccable palette-seed hue) for interactive/selected; semantic `ok/warn/err/undo` colors carry state and appear nowhere else. System font stacks (no webfont fetches in a local-first app); ALL numerals/ids/hashes/timestamps mono (the DENSITY 7 rule). No cards-for-data — tables, hairlines, tint zones; radius 6 everywhere; z-scale named; MOTION 2 = 120ms hover/active feedback only, `prefers-reduced-motion` collapses it.
- **`src/renderer/src/design-tokens.ts`** — the committed tokens (colors, `statusColor` grammar mapping every backend status string to a token, spacing/type/z/motion scales). CSS authority lives in `assets/main.css` as a Tailwind v4 `@theme` block **with the default palette reset** (`--color-*: initial`) — `text-zinc-*`/`bg-black` do not exist, so drift off the token grammar is impossible rather than discouraged.
- **`src/renderer/src/ui/kit.tsx`** — the ONE component grammar all panels share: `DataTable` (sticky header, 34px hairline rows, hover raise, accent-inset selection, keyboard-operable clickable rows), `Badge` (status word → color, always text + color, never dot-only), `Confidence` (mono value + 32×3 meter), `Button` (primary/danger/ghost), `Modal` (esc + focus-on-open), `ToastProvider` (errors sticky, others 5s), `KV`, `Timestamp` (relative + absolute on hover), `EmptyState`/`ErrorState`/`LoadingRows` (skeletons shaped like the table, no spinners), `TextInput`/`Select` (label or ariaLabel).

### Typed IPC (spec §21 rule 8 — no `any`, renderer has no Node)

- **`src/shared/ipc.ts`** — the single contract file, included by BOTH tsconfigs, dependency-free. A `JsonValue`/`JsonObject` vocabulary (no `any` anywhere), one `IpcChannels` map (34 channels: request DTO → response DTO), two push events (`ingest.progress`, `ollama.pull`), and an `IpcResult` envelope so every backend error crosses as `{code, message}` — stable codes (`UNAVAILABLE`, `NOT_FOUND`, `INVALID_STATE`, `COMMIT_FAILED`, `IRREVERSIBLE`, `ALREADY_UNDONE`, …) mapped 1:1 from `StagedWriteError`/`UndoError`/`IngestError`/`OllamaError`.
- **`src/main/ipc.ts`** — one registration per channel over the boot singletons; thin adapters only (every rule stays enforced in its owning module). Highlights: `memory.node` builds the neighborhood **schema-driven** from `REL_TABLES` (queries derive from the §18 registry, so a schema change can't silently desync the inspector); embeddings never cross the boundary; approve/reject/undo/decide record `decided_by = 'user:dashboard'`; `ingest.codebase` streams `CodebaseIngestProgress` to the invoking WebContents; `settings.revealMcpToken` surfaces the keychain bearer token (the phase-05 sanctioned surface — never logged, shown only on click). Subsystems that didn't boot yield structured `UNAVAILABLE` errors, never blank panels.
- **`src/preload/index.ts`** — one generic `invoke` derived from the channel map (the renderer cannot name a nonexistent channel) + typed event subscriptions returning unsubscribe functions.
- Boot: `bootIpc()` registers handlers after all other boots; the ONE lazy `Reranker` instance is shared with the MCP server (created independently only if MCP boot was skipped). New boot line: `[ipc] dashboard IPC ready (typed contract, structured errors)`.

### The nine panels (`src/renderer/src/panels/`, each on real stores)

1. **Memory browser** — label counts → paged node lists (50/page, "x of total"), hybrid search (Enter → `searchMemory`: vector+FTS+rerank), and a node inspector: props with provenance pulled out prominently (`extracted_by` + confidence meter), outgoing/incoming edges grouped by type with per-edge provenance, neighbor navigation with a back stack.
2. **Review queue** — the §13 surface. Staged writes (status filter) → wide modal: provenance block (extracted_by, confidence, evidence quote, session) above the backend's human diff (`+`/`~`/`−` lines tinted) → approve (commits via the audited lane; toast "committed (undoable in audit log)") / reject / retry-commit for failed approvals with `validation.commitError` shown. Pending approvals with scope facts (paths/host/$) and inline approve/deny. Flagged documents (injection scanner findings, advisory).
3. **Audit/undo timeline** — newest-first, 8px status square, kind + outcome badges, reversible/irreversible delta column; undo behind a confirm modal ("applies the recorded inverse delta through the write lane…"), undone rows dim with an `undone` badge; UndoError codes verbatim.
4. **Spend monitor** — total / last-24h / $0.50 ceiling strip (plain hairline row, no hero-metric cards), per-task aggregates, recent calls with token counts.
5. **Tasks & watchers** — background jobs (status, attempts, last_error verbatim); watched folders: add (browse dialog or typed path), remove, **scan now** → full per-file result block; hint that automatic watching arrives with phase-11 triggers.
6. **Trace viewer** — recent traces (spans, errors, duration) → waterfall: parent-depth indentation, bars offset/width % of trace wall-clock, error spans red; span click expands attributes with `permission.*` keys highlighted (denied §13 actions are visibly `permission.decision: block`).
7. **Skill analytics** — per-skill versions/uses/examples (failures in red)/corrections/active benchmark; detail: instructions, version history with status badges, examples, corrections.
8. **Ingestion** — document ingest (file pick or typed path, tags; injection-flag warning box routes to the review queue) and codebase ingest with **live progress** (phase, files walked/parsed, components, current file) via push events keyed by a renderer-generated runId.
9. **Settings** — cloud provider + per-provider model override; API keys (presence only, set via password modal, clear; §21 rule 7 — key material never renders or crosses back); Ollama status with one-click model pull + streamed progress; small-LLM override; MCP connection (URL, `claude mcp add` command with `<token>` placeholder + copy, sample config path, reveal-token).

Shell: 216px rail (9 panels + live pending-review count polled every 20s) + subsystem status footer (storage/models/kernel/mcp/agents with real up/down state + sr-only text) — which proved itself during the phase by diagnosing the first e2e failure at a glance ("storage down").

### Seed script (DoD: "seed script provided for demo data")

`tests/fixtures/dashboard-seed.ts` → `npm run seed:demo -- <dir>` (esbuild-bundles to `out/smoke/dashboard-seed.mjs`, prints the `AGENTIC_OS_USER_DATA_DIR=… npm run dev` line) and `seedDashboardDemo()` for the e2e. Seeds: the full phase-03 fixture graph (all 13 labels, 15 edge types; fake deterministic embeddings by default, `--real-embeddings` for Ollama), staged writes in BOTH proposer shapes (an offline-approvable correction patch + an `embedOnCommit` extraction create), two pending §13 approvals, **real audited actions via `AuditLog.graphWrite`** (so dashboard Undo applies real recorded inverses — plus a raw-cypher action that is honestly irreversible), injection flags, two multi-span traces (incl. a `permission.decision: block` error span), spend rows, tasks (done/failed-with-SpendCeilingExceededError/pending), and a watched `demo-docs` folder with two markdown files (the e2e ingest target).

### Playwright e2e (`tests/e2e/`, `npm run test:e2e`)

`@playwright/test` 1.61.1 installed (§20 stack pin; Electron driver, no browser download). Config: serial (fixed MCP port), globalSetup builds the app + bundles the seed. Each spec seeds a fresh tmpdir scratch **in a child process** (the seed keeps its ryugraph handle open to dodge the 25.9.1 close() teardown fault; only process exit releases the graph lock) and launches the production build.

1. **`dashboard.review.spec.ts`** — approve the staged correction: row → diff modal (shows `statement` → 'schema linter') → approve → row leaves the staged list → **memory browser shows the patched Preference statement** (the graph really changed).
2. **`dashboard.audit.spec.ts`** — undo the seeded reversible write: confirm modal → row flips to `undone` → **the tag the audited write created is gone from the memory browser** (the inverse really applied).
3. **`dashboard.ingest.spec.ts`** — folder ingest from the UI: watched-folder "scan now" → "2 ingested" → the runbook chunk appears under Knowledge in the memory browser. Real bge-m3 embeddings; skips gracefully when Ollama is down (same policy as the OLLAMA=1 vitest gates).
4. **`screenshots.spec.ts`** — env-gated (`AGENTIC_OS_E2E_SCREENSHOTS=1`) capture of all panels → `docs/progress/assets/phase-10/`.

## Definition of Done — outputs

### 1. Every panel functions against real data

All ten screenshots in `docs/progress/assets/phase-10/` were captured from the REAL app over the seeded stores — every count, badge, diff line, waterfall bar and error string on them is served by the phase 01–09 backends through the typed IPC (no mock layer exists).

![memory](assets/phase-10/memory.png)
![review](assets/phase-10/review.png)
![review diff modal](assets/phase-10/review-diff.png)
![audit](assets/phase-10/audit.png)
![spend](assets/phase-10/spend.png)
![tasks & watchers](assets/phase-10/tasks.png)
![traces](assets/phase-10/traces.png)
![skills](assets/phase-10/skills.png)
![ingestion](assets/phase-10/ingest.png)
![settings](assets/phase-10/settings.png)

### 2. Playwright e2e green

```
npm run test:e2e   (final run, against the post-polish production build)
  ok 1 dashboard.audit.spec.ts  › undo a reversible graph write from the audit log (714ms)
  ok 2 dashboard.ingest.spec.ts › trigger a watched-folder ingest from the UI (30.8s)
  ok 3 dashboard.review.spec.ts › approve a staged correction from the review queue (858ms)
  -  4 screenshots.spec.ts      › capture every panel (env-gated)
  1 skipped / 3 passed (1.1m)
```

The ingest spec ran with REAL Ollama bge-m3 embeddings on this machine (skips gracefully when the daemon is down). Each spec asserts the OUTCOME in the memory browser, not just the toast: the approved patch's new statement, the undone tag's absence, and the ingested runbook chunk are all read back from the graph through the UI.

### 3. /audit findings addressed or recorded

Audit per the impeccable checklist (a11y / performance / theming / responsive / anti-patterns), over the live screenshots + code:

| Dimension | Score | Finding |
|---|---|---|
| Accessibility | 3→4 | **Fixed during the pass:** clickable table rows were mouse-only → now focusable + Enter/Space-activated (kit-level, all panels at once); label-less filter/search inputs had no accessible name → `ariaLabel` prop added and applied; modal now takes focus on open; `ink-faint` raised `oklch(0.55 → 0.62)` (11px hints were ~3.7:1, now ≥4.5:1). **Recorded, not fixed:** modal has focus-on-open + esc but no full focus TRAP (tabbing can exit the dialog) — P2, revisit in phase 13 hardening. |
| Performance | 4 | No animations beyond 120ms feedback; queries capped (50–500 rows); no polling except the 20s rail badge; skeletons instead of spinners. `memory.counts` runs 13 sequential label counts per open — fine embedded, recorded. |
| Theming | 4 | Default Tailwind palette is RESET; only token utilities compile. Dark-locked is deliberate and documented (single-theme desktop instrument), not a missing light mode. |
| Responsive | 3 | Desktop app: window floor set to 960×600 (added this pass); master-detail grids use minmax(0,…) and tables scroll internally. Touch targets are 28px (dense buttons) — a mouse/keyboard cockpit by declared context; recorded, not "fixed". |
| Anti-patterns | 4 | No gradient text/glass/hero-metric cards/identical card grids/AI-purple glow; the only dots are real semantic state (subsystem up/down, audit outcome squares); zero em/en-dashes in UI strings (the backend's own diff header em-dash renders verbatim by the errors-verbatim rule). |

Visual-iteration fix from the screenshot loop: task/spend ids truncated at 8–12 chars made seeded ids indistinguishable ("job-demo" ×3) → now 20 chars + full id on hover.

### 4. No `any` in IPC contracts; renderer imports no Node module

`src/shared/ipc.ts` + preload + all renderer sources contain zero `any` (typed end-to-end via the channel map; payload-ish values are `JsonValue`); `npm run typecheck` (strict, `noUncheckedIndexedAccess`) and `npm run lint` are clean. The renderer imports only react, kit, lib, design-tokens and `src/shared/ipc` types; privileged work exists solely behind `window.agenticOS` (contextIsolation on, nodeIntegration off, unchanged CSP).

### 5. Full verification (this machine)

```
npm run lint          clean
npm run typecheck     clean (tsconfig.node + tsconfig.web, incl. src/shared + tests/e2e)
npm run build         clean (electron-vite production build)
npm test              Test Files 50 passed | 3 skipped (53) · Tests 453 passed | 10 skipped (463)  [exit 0]
npm run test:e2e      3 passed, 1 env-gated skip [exit 0] (post-polish build; review 858ms,
                      audit 714ms, ingest 30.8s w/ real bge-m3)
seed:demo             out/smoke/dashboard-seed.mjs seeds a scratch dir in ~14s, exit 0
```

Boot smoke (captured from the e2e's production-build launches, scratch userData): all prior boot
lines intact plus the new `[ipc] dashboard IPC ready (typed contract, structured errors)`; clean exit.

Run notes (reported honestly): one `npm test` run that overlapped the e2e/Ollama load lost the
docker conformance case `write outside fsWrite is denied [docker]` to a 30s timeout plus the known
forks-teardown errors; the file re-ran 18/18 in isolation (16.6s, `docker ps -a --filter name=sbx-`
empty) and the quiet-machine full rerun above is completely clean at exit 0. Zero failures in any
phase-10 code path across all runs. The first e2e round surfaced two real launch bugs (decision 4)
which are fixed in `tests/e2e/launch.ts`, not worked around.

## Key decisions & findings (read before later phases)

1. **The IPC layer is adapters-only.** Every §13/§21 rule (protected keys, staged-only writes, lane discipline, undo semantics) stays enforced in the owning phase-09 module; `src/main/ipc.ts` relays inputs and errors. Nothing in the dashboard can do what the backend refuses.
2. **`IpcResult` envelopes instead of thrown IPC rejections** — Electron mangles rejected-promise errors into strings; the envelope preserves `{code, message}` so panels can branch on `ALREADY_UNDONE` vs `UNDO_FAILED` and still show the operator the verbatim backend sentence.
3. **The Tailwind palette reset is the enforcement mechanism for the design system.** With `--color-*: initial`, a subagent typing `text-zinc-400` produces nothing visible and fails its own visual check — four parallel panel agents converged on one grammar with zero palette drift.
4. **Electron + Playwright launch pitfalls (cost one debugging round each, fixed in `tests/e2e/launch.ts`):** (a) launch the APP DIRECTORY, not `out/main/index.js` — otherwise `app.getAppPath()` points at `out/main`, `node_modules/ryugraph` doesn't resolve, and storage silently stays down; (b) `fileURLToPath` on a directory URL leaves a trailing backslash that escapes the closing quote in the Windows spawn command line — Electron never boots and the hang is silent (strip with `resolve()`).
5. **The seed runs as a child process for the e2e** — it holds its ryugraph handle open (the 25.9.1 `close()` teardown fault, phases 01/08) and `process.exit(0)`s; the app under test can only open the graph after that exit. In-process seeding from the Playwright worker would either segfault the worker or deadlock the lock.
6. **Undo's action id round-trip**: `AuditLog.undo()` returns void; the dashboard re-reads the action row for `undo_action_id`. Recorded in case phase 11+ wants a richer return shape.
7. **API keys arm background agents at next launch** (phase-08 note: `getApiKey` is read at boot). The settings panel says so under the save button rather than pretending a live re-arm exists. Wiring a live re-boot of `bootAgents()` is a phase-11 candidate.
8. **The subsystem footer is diagnostic, not decorative** — it turned the first e2e failure ("storage down" + UNAVAILABLE alerts naming the boot-log lines) into a one-glance root cause. Keep it through phase 13.
9. **Skill analytics are cypher aggregates over the §18 graph** (versions / HAS_EXAMPLE kinds / IMPROVED corrections / Session USED counts / active benchmark_score) — no new tables; phase 12's improvement agent will make these numbers move.
10. **Recorded conservative picks (rule 12):** decisions record as `decided_by = 'user:dashboard'`; memory lists page at 50; traces list caps at 50/200; spend shows top-20 tasks + 50 recent calls; injection flags cap at 500; the impeccable plugin update (3.5.0 → 3.9.1) was NOT taken mid-phase (install consent); impeccable "live mode" config skipped — visual iteration used Playwright Electron screenshots (real IPC beats a browser shim against a preload-less page).

## Deferred / notes

- **Modal focus trap** (P2) and arrow-key row navigation in tables — phase 13 hardening candidates; esc/tab/enter/space all work today.
- **Approvals panel is signature-grained** (§13 phase-09 semantics): approving releases the exact action signature on retry. Phase 11's scheduler owns re-running queued jobs after approval (`KernelApprovalPendingError` carries the id).
- **Search panel requires live Ollama** (query-time embeddings) — with the daemon down it surfaces the structured OLLAMA_ERROR; browse/inspect stay fully offline.
- **`tests/e2e` runs against the production build**; `AGENTIC_OS_E2E_SKIP_BUILD=1` reuses `out/` for fast local iteration. e2e is not part of `npm test` (vitest) — CLAUDE.md's `npm run test:e2e` is now real.
- The Playwright HTML/artifact dirs (`test-results/`, `playwright-report/`) are gitignored.

## Instructions for phase 11 (triggers & automation)

- **Session-end hook** → `runExtraction(sessionId, {transcriptPath, cwd})` (phase-08 signature). After wiring, the dashboard already shows the results live: job rows in tasks, spans in traces, spend rows, staged items in review.
- **Watchers**: `WatchedFolderStore` + `scanWatchedFolder` are UI-managed now (add/remove/scan in tasks & watchers); chokidar wiring should reuse the same store and respect `enabled`. The ingest progress event channel (`IPC_EVENT_INGEST_PROGRESS`) is reusable for watcher-triggered runs if you thread a runId.
- **Rule execution**: queued §13 approvals now have a UI — a rule blocked on `KernelApprovalPendingError` gets its decision in review queue → pending approvals; the phase-11 scheduler should retry on approval (signature-persistent).
- **New IPC needs** (e.g. rules list, trigger status): add the channel to `src/shared/ipc.ts` (the map is the only place), implement the adapter in `src/main/ipc.ts`, and the preload/renderer pick it up typed.
- Reuse `seedDashboardDemo` for any trigger e2e — it produces every §13 artifact class in one call.
