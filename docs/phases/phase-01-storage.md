# Phase 01 — Storage engine & schema
**Goal:** the embedded memory store: abstraction layer, RyuGraph implementation, full §18 schema, single write lane, migrations + backup, export job, SQLite appdata.
**Read first:** spec §5, §6, §18, §20, §21(1,2,9); `docs/progress/phase-00-report.md`.

## Build
- `src/main/storage/engine.ts` — `StorageEngine` interface: `cypher(q, params)`, `upsertNode`, `createEdge`, `vectorSearch(label, embedding, k)`, `textSearch(label, q, k)`, `withWrite(tx)` . Nothing outside `storage/` may import the RyuGraph driver directly.
- `RyuGraphEngine` implementing it; DDL for every §18 node/edge **including provenance** (`created_at`/`updated_at` everywhere; `extracted_by`, `confidence`, `EXTRACTED_FROM` on extraction-written labels); HNSW index on the 4 retrievable labels' `embedding`; FTS index on their text fields.
- **Single write lane:** an async FIFO in the kernel-to-be (`storage/writeLane.ts`); ALL mutations route through it. Reads are direct.
- Migrations: `schema_version` node, ordered scripts, **file-copy backup of the graph dir before any migration** (§3).
- Export job function (scheduled later): dump all nodes/edges → `exports/<date>/` as CSV + Cypher statements.
- `src/main/storage/appdata.ts` — better-sqlite3 `appdata.db` with tables: `traces`, `tasks`, `mcp_calls`, `staged_writes`, `spend` (schemas in code, WAL mode).

## Definition of Done
- [ ] Integration test: full schema round-trip (create one of every node/edge, query back).
- [ ] Write-lane test: 50 concurrent writers → all writes serialized, none lost (assert ordering log).
- [ ] Vector + FTS test: insert 3 embedded nodes, nearest-neighbor + keyword search return correctly, offline.
- [ ] Migration test: v1→v2 dummy migration runs once, is idempotent, and a backup folder exists.
- [ ] `npm test` green.
**Do NOT:** call any model, build retrieval fusion, or expose anything over MCP yet.
