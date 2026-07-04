# Phase 01 report — Storage engine & schema

**Status:** done · **Date:** 2026-07-04

## What was built

`src/main/storage/` — the embedded memory store behind the §5 abstraction layer:

- **`engine.ts`** — `StorageEngine` interface: `cypher(q, params)`, `upsertNode`, `createEdge`, `vectorSearch(label, embedding, k)`, `textSearch(label, q, k)`, `withWrite(tx)`, plus `checkpoint()`, `close()`, `schemaVersion`, `lane`. Pure types, no driver import.
- **`schema.ts`** — the code form of spec §18: 13 node tables, 15 rel tables (23 FROM/TO pairs, multi-pair rel tables for USED/USES/EXTRACTED_FROM/TAGGED), retrievable-label registry (Project/Skill/Preference/Knowledge with their FTS text fields), provenance columns, DDL + index-DDL generation. `nodeColumns()`/`relColumns()` are shared by DDL and export so they cannot drift.
- **`writeLane.ts`** — the single write lane (§21 rule 1): strict-FIFO async queue with a bounded ordering journal (`seq`/`startOrder`/`finishOrder`/status per job), failure isolation, `onIdle()`, and AsyncLocalStorage-based reentrancy rejection (enqueueing from inside a lane job throws instead of deadlocking).
- **`ryugraph.ts`** — `RyuGraphEngine` (the **only** module touching the `ryugraph` driver; ESLint enforces the boundary). Opens `graph/graph.ryugraph`, loads vendored vector+FTS extensions **by absolute path** from `resources/extensions/v25.9.0/<platform>/`, two connections (direct reads / lane writes), runs migrations. Mutating `cypher()` statements are auto-routed through the lane (conservative keyword detection — false positives merely serialize a read); `INSTALL`, `LOAD EXTENSION`, `BEGIN/COMMIT/ROLLBACK`, `CHECKPOINT` are rejected in raw cypher. All values travel as bound params; labels/property names are validated against the §18 registry; `k` is integer-validated before inlining.
- **`migrations.ts`** — ordered idempotent registry (v1 = full §18 schema + HNSW/FTS indexes), `SchemaVersion` node per applied migration, sidecar `graph/schema-version.json`, and the **pre-open file-copy backup** into `backups/<stamp>-pre-migration-v<N>/` (§21 rule 9).
- **`export.ts`** — `exportGraph()` (§5 memory insurance; scheduling lands in phase 11): every node/rel table (incl. SchemaVersion) to `exports/<date>/` as neo4j-admin-style CSVs (`id:ID(Label)`, `:LABEL`, `:START_ID/:END_ID/:TYPE`, `;`-joined arrays, `:datetime` columns), a generic `graph.cypher` (CREATEs + `datetime('…')`), and `manifest.json` with counts. Runs inside one `withWrite` reservation → quiesced consistent snapshot.
- **`appdata.ts`** — better-sqlite3 `appdata.db`, WAL + `synchronous=NORMAL` + FK on, tables `traces`, `tasks`, `mcp_calls`, `staged_writes`, `spend` (schemas in code, `user_version=1`), plus a **dual-ABI native-binding resolver** (below). Refuses a db whose `user_version` is newer than it understands.
- **`index.ts`** — barrel; the rest of the app imports only from here.

Wiring & infra:

- **`src/main/index.ts`** — boots storage for real: opens appdata.db + the graph engine under Electron `userData` (win32 gated on `node_modules/ryugraph/.electron-safe` as before), logs schema version/node count/backup path; `will-quit` checkpoints and closes **connections only** (see finding 3). `AGENTIC_OS_USER_DATA_DIR` env override points the whole app at a scratch userData dir (used by the dev smoke; Playwright e2e will want it too).
- **`scripts/native/rebuild-native.cjs`** — new `rebuild:native`: probes/stashes better-sqlite3 binaries per ABI (`better_sqlite3-node.node` + `better_sqlite3-electron.node`, default = plain-Node), then delegates to the untouched `rebuild-ryugraph-electron.cjs`. End state: `npm test` (plain node) and `npm run dev` (Electron) both work on the same machine, no flip-flop rebuilds.
- **ESLint boundary** — `no-restricted-imports` + `no-restricted-syntax` forbid `ryugraph` outside `src/main/storage/` (verified to fire).
- **CI ported off the spike** — the offline checks now run the real integration suite under per-OS network denial (`unshare -n` / `sandbox-exec deny network*` / outbound firewall rule), and the Electron-ABI check runs the **full storage suite** under `ELECTRON_RUN_AS_NODE` (ubuntu/macos). Spike scripts deleted; `spike:ryugraph` npm script removed.
- **Tests** — 52 total: unit (config, writeLane, schema registry, appdata) + integration (schema round-trip, write-lane over the real graph, vector+FTS incl. embedding-update dance and vendored-path provenance, migrations v1→v2, export).

## Key decisions & findings (read before later phases)

1. **Phase-00 finding 4 is corrected: FTS auto-maintains on 25.9.1.** Probes show post-index-creation inserts, updates and deletes are all reflected in `QUERY_FTS_INDEX` (the phase-00 observation was the tokenizer quirk, not staleness). The HNSW vector index auto-maintains on insert/delete too. **But `SET` on an HNSW-indexed property is illegal** ("Try delete and then insert"), even via `MERGE … ON CREATE SET`. Consequences baked into the engine: new nodes are `CREATE`d with inline property maps; changing an existing node's embedding runs drop-index → `SET` → recreate-index inside its lane job (float32-compared first, so re-supplying an identical embedding skips the rebuild; concurrent `vectorSearch` awaits an in-flight rebuild and retries once). Index default metric is **cosine** (right for BGE-M3).
2. **JS `Date` params bind as DATE and silently truncate to midnight.** Convention: timestamps travel as ISO-8601 strings wrapped `timestamp($p)`; the engine encodes this for `upsertNode`/`createEdge` (which accept `Date` or ISO string) and **rejects raw `Date` params in `cypher()`** with an actionable error.
3. **`Database.close()`/`closeSync()` poisons process teardown** (native access violation at exit — every close variant; functionally the close itself works, locks release, reopen works). Also **an open db's files cannot be copied on Windows** (byte-range locks), and a second `Database` on the same path is lock-rejected. Resulting lifecycle: the **app quit path** checkpoints and closes connections but skips `Database.close()` (clean exit + WAL-replay durability were probe-proven); **tests** close fully — vitest's forks pool reports results over IPC before the worker's dirty exit (verified; `pool: 'forks'` is pinned in vitest.config with a comment). Migrations therefore **back up before the db is ever opened**, keyed on the sidecar version file: sidecar missing-or-behind + data present → file-copy backup; the in-graph `SchemaVersion` node stays authoritative after open. A lost sidecar costs one defensive backup, never a skipped one.
4. **`withWrite` = lane exclusivity, not a DB transaction.** Index create/drop calls are legal only in auto-transaction mode (probe), and embedding updates need them mid-job, so explicit `BEGIN/COMMIT` is not used (and is rejected in raw cypher — a lone `BEGIN` as a lane job would bleed into the next job anyway). Statement-level atomicity + single-writer serialization is the phase-01 contract.
5. **Provenance columns are uniform on all rel tables** (nullable `extracted_by`, `confidence`, plus `created_at`/`updated_at` everywhere, engine-stamped). §21 rule 4 requires provenance on every extraction-written *edge*; extraction (phase 08) can stamp any of the 9+ edge types it writes without schema changes. `createEdge` MERGEs on (from, to, type) — idempotent re-links update `updated_at` + provided props; missing endpoints throw (count-checked).
6. **Dual-ABI better-sqlite3.** It is not N-API; one binary cannot serve plain Node (vitest) and Electron. `rebuild:native` now stashes both ABIs in `build/Release/` and `appdata.ts` picks via the documented `nativeBinding` option (runtime-ordered candidates, ABI-mismatch errors falls through, others propagate; winner cached). Fresh `npm ci` + no rebuild still works under plain node and fails with a "run npm run rebuild:native" message in Electron. ryugraph itself needs no such dance — the phase-00 delay-load rebuild works under both runtimes.
7. **CALL arguments reject expressions** (`CAST($p AS FLOAT[N])` is a binder error inside `CALL`), but bare `$q`/`$k` params bind fine — `QUERY_VECTOR_INDEX('L','idx',$q,$k)` is the shape. In property maps/SET, `CAST($p AS FLOAT[1024])` works and is required.
8. **FTS tokenizer quirks:** some tokens are dropped entirely ('hello'), digits are stripped (`zebra7` matches every `zebraN`). Retrieval (phase 03) and its tests must use robust alphabetic terms and must not assume every literal token is searchable.
9. **Stale June-prototype data found in the real userData dir** (`%APPDATA%/agentic-os`): a 5 MB `graph` **file** (blocks our `graph/` dir), an `appdata.db` with `user_version=2` and different table shapes, `backups/`, `keychain.json`, `sample.mcp.json`, `agentic-os/`, `spike-data/`. I did not move user data; instead the engine now throws a clear error when the graph path exists as a non-directory, and `openAppData` refuses a newer `user_version`. **User action before `npm run dev` uses the default userData:** move those leftovers aside, e.g. into `%APPDATA%/agentic-os/legacy-2026-06-prototype/`. The dev smoke below used `AGENTIC_OS_USER_DATA_DIR` with a scratch dir.
10. Conservative picks under §21 rule 12 (none of these are §20 values): lane journal capacity 1000; search `k` capped at 1000; appdata `user_version` 1; backup dir naming `<stamp>-pre-migration-v<N>`; same-day re-exports get time-suffixed dirs; graph db file named `graph/graph.ryugraph`; export CSVs written per-table with header-only files for empty tables.
11. `ryugraph`'s exports map exposes `types` — official driver typings are used (inside storage/ only). `Connection.query()` on a multi-statement string returns an array of results (rows are concatenated by the engine).
12. Vector search on an **empty** indexed table returns `[]` (no error) — pinned by test.

## Deferred / notes

- Prepared-statement caching (correctness-first now; revisit for the phase-03 retrieval hot path).
- Packaged-app path for `resources/extensions/` (electron-builder `extraResources`) — phase 13.
- The 30 s vitest `testTimeout` is global; integration tests take ~20 s wall total on this machine.
- Export loads each table fully into memory — fine at memory-insurance scale; stream if it ever matters.

## Instructions for phase 02 (model layer)

- Get the engine via `openRyuGraphEngine({ graphDir, backupsDir, extensionsDir })` from `src/main/storage` (see `src/main/index.ts` boot for the Electron wiring; tests: `tests/integration/helpers.ts`). Never import `ryugraph` — ESLint will stop you.
- Embeddings are `number[]` of `EMBEDDING_DIM` (1024, config). Write them via `upsertNode(label, { …, embedding })`; query via `vectorSearch(label, embedding, k)` (cosine distance, smaller = closer). No model calls exist in storage — phase 02 owns Ollama/bge-m3 and must reuse `config.ts` names (`EMBEDDING_MODEL`, `SMALL_LLM_MODEL`, `RERANKER_*`).
- The ONNX reranker weights dir is `appDataPaths(userData).modelsDir`.
- Timestamps into raw `cypher()`: ISO strings wrapped `timestamp($p)` — raw `Date` params throw.
- Never call engine-level write methods inside `withWrite` (reentrancy error) — use the `tx` handle.
- `openAppData(paths.appDb)` is already booted in main; the `spend` table is ready for §14 spend tracking.
- Run `npm run rebuild:native` once per machine/Electron bump (unchanged ritual); `npm test` runs under plain node everywhere.

## Definition of Done — outputs

### 1–4. Integration tests (schema round-trip, write lane ×50, vector+FTS, migration v1→v2)

`npx vitest run tests/integration` — 5 files, 28 tests: `storage.schema.test.ts` (one node of all 13 labels, all 23 edge pairs queried back with provenance + timestamps; upsert-update semantics; schema/edge/statement rejections), `storage.writeLane.test.ts` (50 concurrent writers → 50 nodes, FIFO journal `startOrder≡seq`, `finishOrder≡startOrder`, max concurrency 1; mutation auto-routing; single-reservation `withWrite`; reentrancy rejection; failure isolation), `storage.search.test.ts` (3 embedded 1024-dim nodes: NN order + distances, k-cap, embedding-update rebuild reflected, FTS keyword/update/delete visibility, empty-label `[]`, vendored-extension provenance `source USER` from `resources/extensions/v25.9.0`), `storage.migration.test.ts` (v1 fresh no-backup → v1→v2 backup exists containing `graph.ryugraph` + runs-once → re-run no-op idempotent → lost-sidecar defensive backup without re-application → malformed registries rejected), `storage.export.test.ts` (CSV/Cypher/manifest shapes + counts).

### 5. `npm test` green (plus lint/typecheck)

```
Test Files  9 passed (9)
Tests  52 passed (52)
> eslint .            (clean)
> tsc --noEmit -p tsconfig.node.json && tsc --noEmit -p tsconfig.web.json   (clean)
```

### Extra: the same integration suite under Electron's runtime (Windows, this machine)

```
ELECTRON_RUN_AS_NODE=1 electron.exe node_modules/vitest/vitest.mjs run tests/integration
Test Files  5 passed (5) · Tests  28 passed (28)
```

### Extra: real-app dev smoke (scratch userData via AGENTIC_OS_USER_DATA_DIR)

```
[boot] agentic-os main process starting (MCP reserved at 127.0.0.1:4517)
[native] onnxruntime-node 1.27.0 (runtime 1.27.0) loaded in Electron main
[storage] appdata.db open (WAL: traces, tasks, mcp_calls, staged_writes, spend) at …\dev-smoke-userdata\appdata.db
[storage] ryugraph 25.9.1 open at …\dev-smoke-userdata\graph — schema v1, 1 nodes, vector+FTS from vendored extensions
```

Graceful quit left `graph/graph.ryugraph` + `schema-version.json`, no WAL remnant, no crash, no electron processes.

### rebuild:native (this machine)

```
[rebuild:native] default binding loads under Electron → stashing as better_sqlite3-electron.node
[rebuild:native] Electron-ABI stash OK
[rebuild:native] running npm rebuild better-sqlite3 (restores the plain-Node prebuilt) …
[rebuild:native] plain-Node ABI stash OK
[rebuild:native] better-sqlite3 ready: default=plain-Node ABI, better_sqlite3-electron.node=Electron ABI
[ryu-rebuild] ryujs.node already rebuilt for Electron 43.0.0, skipping
```
