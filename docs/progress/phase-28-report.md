# Phase 28 — Obsidian-style knowledge-graph visualization

**Status:** done · **Date:** 2026-07-18 · User-directed feature (outside the numbered spec plan).

## What the user asked for

> "implement a graph based visualization of the knowledge and I want it to look and feel like Obsidian's visualization."

## What was built

A first-class **Knowledge graph** panel (new nav item under *Knowledge*) that renders the whole §18
memory graph as a force-directed canvas with Obsidian's interaction grammar. No new npm dependency — the
force simulation is hand-rolled on an HTML canvas, the same approach Obsidian itself takes.

### Backend (one read, one channel — additive)

- **`src/main/reads/graph.ts` — `graphOverview(engine, {limit})`** → `GraphOverviewDto`. Iterates
  `NODE_TABLES` (id + `DISPLAY_PROPS` human handle + `updated_at`, newest-first, per-label capped) and
  `REL_TABLES`/pairs (edges between included nodes only). Node identity is the graph-wide
  `` `${label}:${id}` `` key (ids are unique only within a label table); edges reference nodes by that key.
  Degree is computed from the returned edges. The embedding vector is never selected (reuses the memory
  browser's projection). Bounded like the dedupe scan: `GRAPH_OVERVIEW_MAX_NODES` (2000) newest nodes +
  `GRAPH_OVERVIEW_MAX_EDGES` (8000); `truncated` + true `totalNodes` let the UI say what it hid.
- **`src/shared/ipc.ts`** — `GraphNodeDto` / `GraphEdgeDto` / `GraphOverviewDto` + channel
  `'graph.overview': { req:{limit?:number}; res:GraphOverviewDto }`. Read-only, **dashboard-only** (never
  an MCP tool — consistent with §21.6 and the memory-editing surface).
- **`src/main/config.ts`** — `GRAPH_OVERVIEW_MAX_NODES=2000`, `GRAPH_OVERVIEW_MAX_EDGES=8000` (UI-render
  caps, not §20 backend thresholds; rule-12 picks, sized to stay smooth on the canvas sim while covering
  any realistic personal graph).
- **`src/main/ipc.ts`** — `register('graph.overview', …)`; **`reads/index.ts`** exports it. Preload is
  generic (`invoke<C>` off the channel map) so no bridge change was needed.

### Renderer

- **`ui/graph/colors.ts`** — a 13-entry OKLCH palette (one hue per node label, uniform L/C from the dark
  theme family; Tag neutral gray), `colorForLabel`, `withAlpha`. The `Record<IpcNodeLabel,…>` keeps it
  exhaustive (a new label fails the build).
- **`ui/graph/model.ts`** — pure, canvas-free helpers: `buildAdjacency`, `neighborhood` (local-graph BFS),
  `subgraph`, `nodeRadius`. Unit-tested on their own.
- **`ui/graph/ForceGraph.tsx`** — the canvas renderer + simulation. Spring/charge/gravity physics with
  **grid-bucketed repulsion** (stays smooth into the thousands). The hot loop runs entirely on refs and
  only redraws when something changed (`dirty`), so a settled graph idles at 0 CPU; DPR-aware sizing via
  ResizeObserver. Interaction = the Obsidian grammar: **scroll to zoom about the cursor, drag the
  background to pan, drag a node, hover to light up a node + its neighbors while the rest dims, click to
  select, double-click to open**. Labels fade in with zoom (gated by on-screen node size) and always show
  for the active node + neighbors. Node positions persist by key across prop changes, so filtering a label
  or entering local mode animates instead of jumping. Auto-fits once on first load; a `fitSignal` prop +
  imperative `fit()` handle drive the toolbar "Fit" and mode-change re-frames.
- **`panels/GraphPanel.tsx`** — loads `graph.overview` once, then: a per-label **legend that doubles as a
  show/hide filter**, a **search box** that finds + centers a node, an Obsidian-style **Local graph** mode
  (N-hop neighborhood of a focused node, computed client-side from the one payload; depth 1/2/3), a
  **selection card** that deep-links into the Memory inspector via `onInspect` (reusing App's existing R3
  route) and can pivot into local mode, plus live stats and a truncation note.
- **`App.tsx`** / **`ui/icons.tsx`** — new `graph` PanelKey + `Knowledge graph` nav entry under
  *Knowledge* (memory · **graph** · ingest · skills) + a `graph` line-icon.

## Key decisions

- **Own panel, not a mode inside Memory.** Obsidian's graph is a first-class view; a dedicated panel is
  the most Obsidian-like and keeps `MemoryPanel` untouched (zero regression risk). The two bridge via the
  selection card's **Open in Memory** deep-link.
- **One backend read; local-graph + label-filter are client-side.** A personal graph fits in one bounded
  payload, so local mode and filtering are pure client-side crops of it — no second query, instant.
- **No new dependency.** A custom canvas force-sim (grid repulsion) matches the app's stack-pin discipline
  and how Obsidian works. OKLCH strings render directly in canvas `fillStyle` (Electron 43 / Chromium ~130).
- **Dashboard-only, read-only.** Not exposed as an MCP tool (§21.6). No writes, no lane involvement.

## Deferred / not done

- No WebGL — the 2D-canvas sim is smooth to the 2000-node cap; a WebGL renderer would only matter far
  above it.
- Search matches node display text (startsWith then includes); no fuzzy ranking.
- Local mode is undirected BFS (matches Obsidian's local graph); no per-edge-type filtering yet.

## Definition-of-Done — commands run

- `npm run typecheck` → clean (node + web).
- `npm run lint` → clean.
- `npm run build` → main + preload + renderer bundles built (renderer 53 modules).
- Tests: new `tests/unit/graph.model.test.ts` (adjacency / BFS / subgraph / sizing / palette) +
  `tests/integration/graph.overview.test.ts` (real engine + full fixture: graph-wide keys, no embeddings,
  every edge endpoint resolvable, degree = 2·edges, newest-N cap + truncation). Relevant suite run
  (`config`, `appdata`, `memory.edit`, `memory.dedupe`, `graph.model`, `graph.overview`): **64 passed**.
  (The full `npm test` aborted on the documented ryugraph forks-pool teardown flake in an unrelated
  `agents.extraction-subscription` test, not this work.)
- **Visual verification** (temporary Playwright screenshot over the demo seed, since removed): the global
  view renders 49 nodes / 64 links colored by type with the legend/filter and live stats; hovering a hub
  lights its neighbors and connecting edges while the rest dims; clicking opens the selection card with
  **Open in Memory** + **Local graph**.

## For the next session

The graph is read-only. If graph editing is ever wanted, route it through the existing
`memory.node.*` / `memory.edge.*` IPC (audited, undoable) — never a new write path. `graph.overview` is the
single data source; local-graph and filtering are client-side crops, so most UX changes are renderer-only.
