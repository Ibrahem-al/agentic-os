# Phase 06 — Knowledge ingestion
**Goal:** documents become tagged, embedded `Knowledge` chunks under `Document` nodes; dedup + replace-on-change.
**Read first:** spec §18 write paths (knowledge), §20 chunking; phase reports 01, 02, 05.

## Build
- `src/main/ingest/knowledge.ts`: structure-aware chunker (split on headings/code fences, ~512 tokens, 64 overlap) for md/txt/source files (PDF etc. are deferred — error clearly); BGE-M3 embed; `Document` (id, source, content_hash, ingested_at) + `Knowledge` chunks via `HAS_CHUNK`; `TAGGED` to provided tags; all through the write lane.
- Content-hash dedup: identical re-add = no-op; changed doc = delete old chunks, write new (no versioning).
- Fill the `ingest_document` MCP tool; also export a plain function the dashboard/watchers call.
- Watched-folder definition type (chokidar) — definition + manual trigger only; scheduling wires up in Phase 11.

## Definition of Done
- [ ] Fixture md file → expected chunk count, headings preserved as chunk boundaries, embeddings present.
- [ ] Re-ingest unchanged = zero writes (write-lane log asserted); changed file = old chunks gone, new present.
- [ ] `ingest_document` over MCP works end-to-end and logs to `mcp_calls`.
**Do NOT:** GraphRAG entity extraction (deferred); no codebase parsing.
