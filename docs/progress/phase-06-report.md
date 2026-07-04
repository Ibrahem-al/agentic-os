# Phase 06 report — Knowledge ingestion

**Status:** done · **Date:** 2026-07-04

## What was built

### `src/main/ingest/` — the §18 knowledge write path (new module)

- **`chunker.ts`** — `chunkDocument(content, {format, targetTokens?, overlapTokens?})`, the §20 structure-aware chunker (split on headings/code fences, target ~512 tokens, 64 overlap; both values from config, never re-declared). The document parses into atomic blocks — ATX headings, fenced code blocks (``` / ~~~, nesting-safe via marker length, unclosed fence = rest of file), blank-line paragraphs — then blocks pack greedily up to the target. **A heading ALWAYS starts a new chunk** (headings are the chunk boundaries the DoD pins); a **code fence is atomic** unless it alone exceeds the target, in which case it splits by lines and every piece is re-wrapped in the original fence markers (no chunk ever carries an unterminated fence). When a chunk fills mid-section, the next chunk is seeded with the last ~64 tokens of the previous one at line granularity — but **overlap never crosses a heading boundary** (the heading is the clean break). Pending prose (typically the section's heading) merges into an oversized block's split, so headings are never orphaned as tiny chunks. Pathological single lines (minified content) hard-split by characters; forward progress is guaranteed (overlap is dropped when it would eat a piece's whole budget; `overlap < target` is validated). `format: 'plain'` (txt/source files) disables heading/fence parsing so `# python comments` stay inline. Token counting = the phase-03 estimating counter (conservative overestimate ⇒ "~512" holds against any real tokenizer). Each chunk carries `index`, exact `text`, estimated `tokens`, and a `headingTrail` breadcrumb. Pure module — no I/O, no storage, no models.
- **`knowledge.ts`** — the pipeline: `ingestKnowledgeContent(deps, content, {source, tags?, format?})`, `ingestKnowledgeFile(deps, path, {tags?})`, and `ingestDocument(deps, path_or_content, tags?)` — the §12-shaped plain function the MCP tool, the phase-10 dashboard file-pick and the phase-11 watchers all call. `deps = {engine, embedder}` (structural `KnowledgeEmbedder` interface — the shared `OllamaClient` satisfies it; no new model instances). Flow: validate (non-empty, no NUL bytes) → sha256 content hash → **dedup check via direct reads BEFORE any model call or lane job** → chunk → **one `embedder.embed()` batch** (BGE-M3, the only embedding model) → resolve tag names by exact match (same rule as the retrieval read path) → **ONE `engine.withWrite` job** for the whole mutation: delete old chunks (`DETACH DELETE`; HNSW + FTS auto-maintain, phase-01 finding 1), upsert `Document {id, source, content_hash, ingested_at}`, create missing `Tag` nodes (`is_global: false`), create `Knowledge` chunks (content + embedding + `extracted_by='knowledge-ingest@1.0'` + `confidence=1.0`), `HAS_CHUNK` and `TAGGED` edges. Errors are `IngestError` with a `ToolError`-compatible code (`INVALID_INPUT`/`NOT_FOUND`) and always state "nothing was ingested". File mode gates on extension: markdown set → structure-aware, text/source set → plain, **rich formats (.pdf, .docx, …) error clearly as deferred**, unknown extensions error listing what IS supported; >1 MB and directories refused. §21 rule 5 holds by construction: content is chunked, embedded and stored — never parsed for instructions.
- **`watch.ts`** — watched folders, **definition + manual trigger only** (per the phase doc; live chokidar watching + scheduling land in phase 11): `WatchedFolder` zod schema (`name`, `path`, `tags`, optional dot-prefixed `extensions` allowlist, `enabled`), `WatchedFolderStore` over `userData/watched-folders.json` (same zod-validated atomic tmp+rename pattern as `mcp-servers.json`; duplicates/invalid entries refused loudly), and `scanWatchedFolder(deps, folder)` — the manual trigger: recursive walk pruning `node_modules`/`.git`/dot-dirs, size + extension gating, every supported file through `ingestKnowledgeFile` with the folder's tags. Per-file failures are collected in the result (`ingested`/`skipped`/`failed` with reasons), never thrown — one bad file cannot abort a folder. Re-scans are cheap no-ops thanks to content-hash dedup.
- **`index.ts`** — barrel.

### Identity & dedup scheme (§18 "content-hash dedup … replace-on-change")

- A `Document` is identified by its **`source`** (resolved absolute path for files; `inline:<sha256(content)[0:16]>` for pasted content — so identical inline re-adds dedup naturally). Document id = `doc-<sha256(source)[0:16]>` (deterministic, collision-negligible at local scale).
- **Identical re-add** (same source, same `content_hash`) returns `status:'unchanged'` after reads only — **zero lane jobs, zero embed calls** (both pinned by test).
- **Changed content** → `status:'replaced'`: old chunks `DETACH DELETE`d and the new set written **in the same single lane job**, `content_hash`/`ingested_at` re-stamped on the same Document node (no versioning). Chunk ids embed the content hash (`<docId>-<hash8>-c<n>`), so replacement chunks never collide with old ids and "old gone / new present" is directly assertable.

### `ingest_document` MCP tool filled (`src/main/mcp/tools.ts`)

The `NOT_IMPLEMENTED` throw is replaced by a call to `ingestDocument` with `ctx.engine` + `ctx.retrieval.embedder` (the deps already in `ToolContext` — **no server/boot changes were needed**; the phase-05 CallTool chokepoint logs + kernel-mediates it automatically, no second registration path). A single-line absolute path ingests that file (missing → `NOT_FOUND`); anything else ingests as inline content. `IngestError` maps 1:1 onto `ToolError`, so failures come back as the §15 clean structured error. Input schema unchanged (was already final per §12). `ingest_codebase` still throws `NOT_IMPLEMENTED` naming phase 07.

### Config additions (rule-12 picks, recorded — §20 values untouched)

`INGEST_MARKDOWN_EXTENSIONS` (.md/.markdown/.mdx), `INGEST_TEXT_EXTENSIONS` (txt + ~30 source/config extensions), `INGEST_DEFERRED_EXTENSIONS` (pdf/docx/… → clear "deferred" error), `INGEST_MAX_FILE_BYTES` = 1 MB (mirrors the only file-size figure the spec states, §18 codebase rule), `KNOWLEDGE_INGEST_PROVENANCE` = `knowledge-ingest@1.0`, `INGEST_INLINE_SOURCE_PREFIX` = `inline:`, `WATCHED_FOLDERS_CONFIG_FILENAME` = `watched-folders.json`.

### Tests — 44 new (287 total)

- **`tests/unit/ingest.chunker.test.ts` (13)** — heading boundaries + trail, atomic fences, oversized-fence split with re-wrapping, ~target packing with line-granular overlap, no overlap across headings, pathological-line hard split, plain format (`#` comments stay inline), CRLF, empty input, option validation, token-count honesty.
- **`tests/integration/ingest.knowledge.test.ts` (13 offline + 1 live)** — the DoD suite over the real engine (details below) + store/scan watched-folder coverage + a live `OLLAMA=1` gate: real bge-m3 ingestion, then a paraphrased query's vector search ranks the semantically right chunk first.
- **`tests/integration/mcp.server.test.ts` (28, was 24)** — new `ingest_document` end-to-end describe (below); the suite-wide invariants (every call logged, span per call) now cover the ingest calls too; the zero-graph-writes invariant became "writes came ONLY from ingest_document lane jobs" (`writesAfterSeeding + graphWriteJobsExpected` exact count).

## Definition of Done — outputs

### 1. Fixture md → expected chunk count, heading boundaries, embeddings present

`ingest.knowledge.test.ts`: a 5-boundary fixture (intro paragraph + `# Irrigation`/`## Valves`/`# Harvest`/`## Storage`) ingested from a real file → **exactly 5 chunks**, `HAS_CHUNK` from one `Document` (source/content_hash/ingested_at all pinned), and the chunks' first lines are exactly `['Operations handbook…', '# Irrigation', '## Valves', '# Harvest', '## Storage']` in document order — headings preserved as chunk boundaries. Embeddings present and **indexed**: `vectorSearch('Knowledge', embed(chunkText))` returns that chunk at distance ~0 through the real HNSW index, and FTS finds the chunk text. Provenance stamped on every chunk (`knowledge-ingest@1.0`, confidence 1). Tags: every chunk `TAGGED`; a pre-existing tag name is reused (no duplicate `Tag`), a new name (`Cooling Systems`) is created as `tag-cooling-systems`, `is_global: false`.

### 2. Re-ingest unchanged = zero writes; changed = old chunks gone, new present

- Unchanged: `status:'unchanged'`, `engine.lane.enqueuedCount` **identical before/after** (the write-lane journal is the assert) — and the embedder call count is also unchanged (dedup short-circuits before any model call).
- Changed (one sentence edited): `status:'replaced'`, `deletedChunkCount` 5, all 5 **old chunk ids return zero rows**, the new 5 are the document's exact chunk set, new text FTS-findable, old text gone, `content_hash` moved, still exactly one `Document` for the source. Validation failures (missing file etc.) leave the lane untouched.

### 3. `ingest_document` over MCP end-to-end + `mcp_calls`

`mcp.server.test.ts` — real MCP SDK client over real Streamable HTTP against the fixture graph: inline ingest with tags → `status:'created'`, 2 chunks + `TAGGED` edges verified **in the graph**, exactly **one write-lane job**; identical re-add over MCP → `'unchanged'`, zero lane jobs; a `.pdf` path → clean `INVALID_INPUT` "deferred" error. The `mcp_calls` rows for the tool are directly asserted (`['ok','ok','error']`, `sha256:` args hash + params JSON present) **and** the suite-wide count invariant (every `tools/call` = one row = one `kernel.mcp-call` span) now includes these calls. No manual Claude Code smoke was repeated this phase: the transport/chokepoint/boot wiring is untouched since the phase-05 smoke (real Claude Code 2.1.200 ✔); the SDK client exercises the identical wire path.

### 4. Full verification (this machine)

```
npm run lint          clean
npm run typecheck     clean (tsconfig.node + tsconfig.web)
npm run build         clean (electron-vite production build)
npm test              Test Files 35 passed | 3 skipped (38) · Tests 279 passed | 8 skipped (287)
OLLAMA=1 RERANKER=1 npx vitest run --no-file-parallelism
                      Test Files 38 passed (38) · Tests 287 passed (287)   [169s]
ELECTRON_RUN_AS_NODE=1 electron … vitest run tests/integration
                      Test Files 12 passed | 3 skipped (15) · Tests 98 passed | 8 skipped (106)
```

Live-run caveat (same as phases 04/05, reported honestly): with live models resident, **parallel** live runs (`OLLAMA=1 RERANKER=1 npm test`) kept hitting the known ryugraph forks-pool teardown flake — across four runs, 1–2 workers died at/near teardown (`storage.migration`, `kernel.context.live` — both pre-phase-06 files, each green in isolation) with **zero actual test failures** ever reported. The sequential run above (`--no-file-parallelism`) is the definitive signal: **all 287 tests pass live with zero errors**. Offline parallel runs are clean.

## Key decisions & findings (read before later phases)

1. **Headings ALWAYS open a new chunk** — the DoD phrase "headings preserved as chunk boundaries" is implemented literally: a heading-dense document yields small chunks rather than packed ones. §20's "~512" is a cap, not a fill target; retrieval quality favors semantically clean sections over stuffed windows.
2. **Oversized-section handling never orphans headings**: pending prose merges into the line-split of an oversized paragraph (found by the first test round — flush-then-split left `# Long` as its own 3-token chunk with no overlap link). Code fences are the exception: their pieces stay pure fence-wrapped code, so prose before a giant fence remains its own chunk.
3. **Dedup is checked before everything** (reads only) — that is what makes "identical re-add = zero writes" literal: no embed call, no lane job, pinned by both the lane journal and the embedder call counter. Consequence (spec-conformant, §18 "identical re-adds skip"): re-adding identical content with NEW tags is also a no-op — re-tagging an unchanged document is a phase-10 dashboard concern, not an ingestion concern.
4. **Replace-on-change is ONE lane job** (delete old chunks + doc upsert + new chunks + edges). `withWrite` gives lane exclusivity, not transactional atomicity (phase-01 finding 4) — but a single job means no other writer's job interleaves, and a crash mid-job can at worst leave a document with partial chunks whose next re-ingest fully heals it (same content hash → replaced again; ids are hash-derived so no collisions).
5. **`DETACH DELETE` of HNSW/FTS-indexed Knowledge nodes works on 25.9.1** — phase-01 finding 1 ("indexes auto-maintain on insert/delete") now proven on the delete path by the replace tests: old chunks vanish from vector + FTS results, new chunks appear, no index rebuild dance needed (that dance is only for `SET` on an indexed property, which ingestion never does — chunks are always fresh creates).
6. **Chunk ids are content-addressed** (`<docId>-<hash8>-c<n>`): replacement sets can never collide with the set they replace, upsertNode always takes the pure-CREATE path (inline property map with embedding — the fast, legal path per phase-01), and "old gone / new present" is assertable by id.
7. **Provenance on ingested chunks**: `extracted_by='knowledge-ingest@1.0'`, `confidence=1.0`, mirroring §18's codebase-ingest convention (deterministic pipeline). No `EXTRACTED_FROM` edge — that edge is for session-derived nodes; a chunk's origin is its `HAS_CHUNK` document. Undo-by-source for documents = delete the document's chunks, which replace/re-ingest already implements.
8. **Tag matching is exact-name, case-sensitive** — identical to the retrieval read path's `t.name IN $names` (phase-03), so a tag created by ingestion is guaranteed retrievable under the same string. New tags get readable slug ids (`tag-<slug>`, hash-suffixed on the improbable id collision), `is_global: false` always — nothing ingestion creates can silently join the always-included global preference set.
9. **chokidar was NOT installed** (though §20-pinned): phase 06 is "definition + manual trigger only" — the manual scan is an `fs` walk and the definition is data. Phase 11 installs chokidar when something actually watches. No unused dependency shipped.
10. **`ingest_document` runs synchronously in the MCP call** (no phase-04 runner job): chunk+embed+write for a ≤1 MB document is seconds — same order as a cold `get_context` — and the caller gets the full result (chunk ids, status) in the reply. If phase 11's watchers ever need background ingestion, `runner.define` a one-step workflow around the same plain function.
11. **Path-vs-content classification** (§12's `path_or_content`): single-line ≤4096 chars AND absolute (POSIX or `C:\`-style) → file mode; a nonexistent path-looking string errors `NOT_FOUND` rather than being silently ingested as literal content (the more dangerous misinterpretation). Everything else is content mode under an `inline:<hash>` source.
12. **Inline content chunks as markdown** — pasted content is typically prose/md, and markdown parsing of plain prose degrades gracefully (no headings → paragraph packing). Files choose by extension (source files chunk as `plain`, so `#` comments and stray backticks aren't misread as structure).
13. **The mcp.server suite's write invariant evolved**: "zero graph writes ever" (phase 05) is now "graph writes exactly equal the ingest_document lane jobs" — rule 6 (Claude never writes memory directly) still holds: `propose_correction` remains staged-only, and ingestion is the OS's own sanctioned §18 write path, lane-serialized and logged like everything else.

## Deferred / notes

- Live chokidar watching, scheduling, and `enabled` enforcement — phase 11 (`scanWatchedFolder` is the callable it will schedule; the store is its config surface).
- Dashboard file-pick UI + watched-folder manager panel — phase 10 (call `ingestDocument` / the store + `scanWatchedFolder`; results are already UI-shaped with per-file reasons).
- PDF/rich formats stay deferred (spec Optional lists LlamaIndex.TS as the escape hatch if we ever roll it).
- Re-tagging an unchanged document is a no-op (decision 3) — if phase 10 wants "edit tags", do it as an explicit tag-edit operation, not a re-ingest.
- `ingest_document` responses include full chunk-id lists; if a caller ever ingests a 1 MB doc with hundreds of chunks the reply is large but bounded (~50 KB) — fine for MCP.

## Instructions for phase 07 (codebase ingestion)

- Build `src/main/ingest/codebase.ts` beside this module; export through `src/main/ingest/index.ts`. Reuse `IngestError` and the identity conventions (deterministic ids from stable sources; per-unit `content_hash` for the "only changed units re-ingest" DoD — the chunk-id-embeds-hash trick generalizes).
- README/markdown/docstrings → **this** pipeline: call `ingestKnowledgeContent` (or `ingestKnowledgeFile`) with the Project's tag; do NOT write Knowledge nodes yourself.
- Fill `ingest_codebase` in `src/main/mcp/tools.ts` exactly like `ingest_document` was filled: swap the throw for the plain function, map `IngestError` → `ToolError`; the chokepoint logs it automatically. `ToolContext` already carries `engine` + `retrieval.embedder`; if you need the small LLM (README → Project summary per the phase doc), extend `AgenticOsMcpServerDeps`/`ToolContext` with the shared `OllamaClient` from `bootMcp` — do not construct a second one.
- Tree-sitter grammars are NOT yet installed — decide native vs `web-tree-sitter` against Electron's ABI early (phase doc explicitly allows either; document the choice) and ask the user before installing.
- Component writes are extraction-class: stamp `extracted_by = codebase-ingest@<version>`, `confidence = 1.0` on nodes AND edges (rel tables already carry provenance columns, phase-01 decision 5).
- Test rigs: `ingest.knowledge.test.ts` shows the full-engine ingest pattern (openTestStore + FakeEmbedder + lane-journal asserts); `mcp.server.test.ts` shows tool e2e (remember to bump `graphWriteJobsExpected` for every graph-writing call you add there).
- Watch the FTS tokenizer quirks (phase-01 finding 8) if you golden-test code-identifier search: digits are stripped, some tokens dropped.
