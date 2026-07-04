# Phase 07 — Codebase ingestion (Tree-sitter)
**Goal:** point at a repo folder (or call `ingest_codebase` over MCP) → `Component` graph + code-doc `Knowledge`, automatically.
**Read first:** spec §18 write paths (codebase), §20; phase reports 01, 06.

## Build
- `src/main/ingest/codebase.ts`: walk respecting `.gitignore` (skip node_modules, binaries, >1 MB); Tree-sitter with TS/JS/Python grammars (use `web-tree-sitter` if native grammar builds fight Electron — decide and document); extract **meaningful units** (exported functions/classes, route handlers, data models — NOT one node per file) → `Component {id, name, type}`; `DEPENDS_ON` edges from import/call relationships; `HAS_COMPONENT` from matched/created `Project` (match by path, create with a summary from README via small LLM).
- README/markdown/docstrings → Phase 06 pipeline, tagged to the Project.
- Per-unit content-hash: re-ingest updates only changed units. Provenance: `extracted_by = codebase-ingest@<pkg version>`, `confidence = 1.0`.
- Fill the `ingest_codebase` MCP tool + dashboard-callable function. Progress events (n files / n components) for the UI later.

## Definition of Done
- [ ] Fixture mini-repo (TS + Python) → asserted Components + DEPENDS_ON edges (golden list).
- [ ] **Self-test:** ingest *this very repo*; report node/edge counts and 3 sample `MATCH (c:Component)-[:DEPENDS_ON]->(d)` results in the phase report.
- [ ] Re-ingest after touching one file changes only that file's units.
- [ ] `retrieve("how does ingestion work", …)` on the self-ingested graph surfaces relevant Components.
**Do NOT:** other languages; no file-watcher auto-reingest (Phase 11 can schedule it).
