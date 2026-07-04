# Phase 05 report — MCP server & client + call log

**Status:** done · **Date:** 2026-07-04

## What was built

### `src/main/mcp/` — the OS speaks MCP (§12)

- **`server.ts`** — `AgenticOsMcpServer`: Streamable HTTP on `127.0.0.1:4517` (`/mcp`), `@modelcontextprotocol/sdk@1.29.0` (exact §20 pin, installed this phase). Bearer auth from the phase-02 keychain gates **every** request, initialize included (timing-safe sha256 compare; 401 + `WWW-Authenticate: Bearer` JSON-RPC body; the token never appears in logs or errors). Stateful sessions: one `StreamableHTTPServerTransport` + low-level SDK `Server` pair per client, keyed by the transport's `mcp-session-id` (uuid; the §6 correlation key); GET (SSE stream) and DELETE (terminate) route through the transport; off-path → 404; other methods → 405; POST bodies parsed here (cap `MCP_MAX_BODY_BYTES`). Deliberately the **low-level `Server`, not `McpServer`**: ONE `CallToolRequest` handler is the chokepoint — every tool call (valid, invalid args, unknown name) runs through `kernel.execute('mcp:<sessionId>', {kind:'mcp-call', …})` (span + PHASE-09 permission seam) and writes its `mcp_calls` row in a `finally`. There is no code path that invokes a tool without a log row. `start()`/`stop()` (stop severs sockets synchronously first — quit-safe for appdata.db), `port`/`url` getters (tests bind port 0).
- **`tools.ts`** — exactly the seven §12 tools, no others. zod v4 schemas validate args; `z.toJSONSchema` derives the `tools/list` JSON Schema from the same validators (single source of truth). Failures throw `ToolError` with a stable code; the server returns `{error:{code,message}}` as an `isError` result (§15: clean structured error, Claude decides).
  - `get_context(task, tags?)` → phase-03 `retriever.retrieve()` (full read path + loop); returns items + always-included `globalPreferences` + loop provenance (confidence/iterations/criticScore/haltReason/totalTokens).
  - `search_memory(query, labels?, k?)` → new `retrieval/search.ts` (below).
  - `list_skills()` / `get_skill(name)` → direct reads; `get_skill` returns skill instructions + the **active** `SkillVersion` body + the `RETRIEVAL_RECENT_EXAMPLES` (3) most recent examples (§12 wording).
  - `propose_correction(node_id, patch, reason)` → **staged_writes row, never a graph write** (§21 rule 6). Patch may not touch identity/provenance fields (`id`, `created_at`, `updated_at`, `embedding`, `extracted_by`, `confidence`); the node id is resolved read-only across all 13 labels first (existing-nodes-only per §18; unknown → `NOT_FOUND`, nothing staged; ambiguous id → refused). Row: `proposed_by = claude-mcp:<sessionId>`, `kind='propose_correction'`, target label/id, payload `{patch, reason}`, status `staged` for the §13 review flow.
  - `ingest_document` / `ingest_codebase` → registered with real schemas, handlers throw `NOT_IMPLEMENTED` naming phases 06/07 ("nothing was ingested").
- **`callLog.ts`** — `McpCallLog` over `mcp_calls` + `stableStringify` (recursively key-sorted, undefined-dropping) + `hashArgs` (`sha256:<hex>`). Row: session id, tool, args JSON (only when ≤ `MCP_CALL_ARGS_JSON_MAX_BYTES` = 16 KB — `ingest_document` can carry whole documents; the **hash is always stored**), result status, error, started-unix-ms, duration. better-sqlite3 is synchronous, so the row is committed before the result leaves the process.
- **`connection.ts`** — the §12 helper: `claudeMcpAddCommand()` renders exactly `claude mcp add --transport http agentic-os http://127.0.0.1:4517/mcp --header "Authorization: Bearer <token>"`; `sampleMcpJson`/`writeSampleMcpJson` produce the project-scope `.mcp.json`. Default token is the `<token>` placeholder (rule 7 — see decision 4).
- **`clients.ts`** — `McpClientManager` (§12 client side): add/remove/list external servers in `userData/mcp-servers.json` (zod-validated, atomic tmp+rename writes; duplicates and malformed entries refused loudly), `listTools(name)` connects with the SDK `Client` (http or stdio), lists, disconnects. **The config file never holds a token**: http entries carry `bearerTokenSecret`, a keychain secret *name* resolved via the injected `secrets` lookup at connect time.
- **`index.ts`** — barrel; the MCP SDK is ESLint-fenced into `src/main/mcp/` exactly like ryugraph/LangGraph (new `@modelcontextprotocol/*` restriction in all zones; tests may import the SDK client; fence verified to fire).

### `src/main/retrieval/search.ts` — search_memory's engine

`searchMemory(deps, query, {labels?, k?})`: embed → vector top-30 per requested retrievable label + FTS overall top-30 (same arms/constants as the read path; `ftsQueryOf` now exported from `pipeline.ts`) → fuse → **rerank** the fused head → top-k `{id, label, text, rerankScore, fusedScore, signals}`. §2 defines hybrid retrieval as "fused, **then reranked**", so the cross-encoder stays; "direct … no loop" (§12) removes graph expansion, global-preference section, token budgeting, and the §15 loop. Unknown labels / k outside 1..30 throw. Read-only like the whole module (suite-level zero-write assert).

### Wiring & infra

- **`storage/appdata.ts`** — appdata schema **v3**: `mcp_calls.args_hash` column. New mechanism for column additions to pre-existing tables (`APPDATA_COLUMN_ADDITIONS`: pragma `table_info` guard + `ALTER TABLE ADD COLUMN`, idempotent); v1/v2 dbs upgrade in place, newer versions still refused. Pre-v3 rows read back with NULL `args_hash` (pinned by test).
- **`config.ts` additions** — `MCP_ENDPOINT_PATH`/`MCP_URL`/`MCP_SERVER_NAME`/`MCP_SERVER_VERSION`, and rule-12 picks (decision 8): `MCP_MAX_BODY_BYTES`, `MCP_CALL_ARGS_JSON_MAX_BYTES`, `SEARCH_MEMORY_DEFAULT_K`/`SEARCH_MEMORY_MAX_K`, `MCP_SERVERS_CONFIG_FILENAME`.
- **`src/main/index.ts`** — `bootMcp()` after kernel boot: ONE `Reranker` + the shared boot `OllamaClient` (now module-held, also feeding the ContextManager) build ONE retriever (phase-03 rule); server gets the keychain token + kernel executor + appdata db; `McpClientManager` constructed over `userData/mcp-servers.json` with keychain-backed secrets. Boot logs the redacted connect command and writes the placeholder sample `.mcp.json` to userData; `AGENTIC_OS_PRINT_MCP_TOKEN=1` (dev) prints the runnable command. `EADDRINUSE` → warn + MCP disabled this launch (no crash). `will-quit` stops MCP **first** (sockets severed synchronously) before telemetry/appdata close.
- **Dependency added:** `@modelcontextprotocol/sdk@1.29.0` (exact; §20 stack pin). Its zod peer (`^3.25 || ^4.0`) resolves to our pinned `zod@4.4.3` — one zod instance in the tree.
- **Tests** — 39 new (256 total): unit `mcp.callLog` (6), `mcp.connection` (3), `mcp.clients` (6), appdata v3 updates; integration `mcp.server` (24) — real SDK client over real HTTP against the fixture graph + kernel stack, all offline (FakeEmbedder/FakeReranker/passing critic). Fixture script `tests/fixtures/mcp-smoke-seed.ts` (esbuild-bundled, hand-run) seeds the fixture graph with REAL bge-m3 embeddings for the manual smoke.

## Definition of Done — outputs

### 1. SDK-client integration test (auth / get_context / propose_correction)

`npx vitest run tests/integration/mcp.server.test.ts` — **24 tests green**, offline:

- **Auth rejected without a token**: `client.connect()` rejects (`Unauthorized`); raw POST → HTTP 401 + `WWW-Authenticate: Bearer`; wrong token → 401; auth rejections leave **no** `mcp_calls` rows. Off-path → 404, PUT → 405.
- **`get_context` returns a bundle from the fixture graph**: the deploy task yields `s-deploy`, `p-aurora`, `k-vercel` in items∪globalPreferences; both global preferences (`pref-global-reasoning`, `pref-global-tests`) present; `confidence: 'high'`, `iterations: 1`; tags route `pref-naming` into the database-tuning bundle.
- **`propose_correction` lands in `staged_writes` and the graph is untouched**: row has `kind='propose_correction'`, `target_label='Preference'`, `target_id='pref-naming'`, `status='staged'`, `proposed_by='claude-mcp:<transport session id>'`, payload round-trips; write-lane `enqueuedCount` unchanged and the node's statement re-read verbatim. Unknown node → `NOT_FOUND` with zero staged rows; patching `id` → `INVALID_INPUT`.
- Also pinned: exactly the seven §12 tools in `tools/list`; `search_memory` label filter + k + `INVALID_INPUT` on bad labels/k; `list_skills` (4 fixture skills); `get_skill` (active version body + 3-of-4 recent examples cap; no-active-version → null; unknown → `NOT_FOUND`); both ingestion tools `NOT_IMPLEMENTED` naming their phases; unknown tool → clean structured error; the client manager lists this server's 7 tools through a config entry + secret indirection; **zero graph writes across the whole suite**.

### 2. Every test call has an `mcp_calls` row (count assert)

Suite-wide invariant tests (same file): `mcp_calls` row count **exactly equals** the number of `tools/call` requests made (18 across two sessions), error-row count matches expected failures; every row carries a live transport session id, `sha256:` args hash, timestamps, duration, ok/err (+ error text on err). A second client session logs under its own session id. `kernel.mcp-call` **span count also equals the call count** (agent `mcp:<sessionId>`, error statuses matching) — every call is kernel-mediated, per the phase-04 handoff.

### 3. Manual smoke — real Claude Code connects and calls get_context

Scratch userData seeded with the fixture graph using **real bge-m3 embeddings** (`out/smoke/mcp-smoke-seed.mjs`), `npm run dev` against it. Boot log:

```
[storage] ryugraph 25.9.1 open at …\smoke-userdata\graph — schema v1, 49 nodes, vector+FTS from vendored extensions
[models] keychain open (safeStorage-encrypted) — secrets present: mcp.bearerToken
[kernel] workflow runner ready (LangGraph + SQLite checkpointer) — spans → traces table
[mcp] server listening at http://127.0.0.1:4517/mcp (bearer auth, 7 tools, call log → mcp_calls)
[mcp] connect Claude Code with:
[mcp]   claude mcp add --transport http agentic-os http://127.0.0.1:4517/mcp --header "Authorization: Bearer <token>"
[mcp] sample .mcp.json written to …\smoke-userdata\.mcp.json (replace <token> with the keychain token)
```

The exact §12 command shape connects (Claude Code 2.1.200):

```
$ claude mcp add --transport http agentic-os-smoke http://127.0.0.1:4517/mcp --header "Authorization: Bearer <real token>"
Added HTTP MCP server agentic-os-smoke with URL: http://127.0.0.1:4517/mcp to local config
$ claude mcp list
agentic-os-smoke: http://127.0.0.1:4517/mcp (HTTP) - ✔ Connected
```

Real headless session calling the tool (`claude -p … --mcp-config mcp-config.json --strict-mcp-config --allowedTools "mcp__agentic-os__get_context"`):

```
> Call the agentic-os get_context tool with task: 'deploy the aurora storefront to
  vercel and verify the checkout flow'. Then report: the confidence value, and the
  id + label of every item and every global preference in the bundle.

Here's what the bundle returned:
**Confidence:** high
**Items:**
- `s-deploy` — Skill              - `mcp-vercel` — MCP
- `sv-deploy-active` — SkillVersion   - `k-checkout` — Knowledge
- `k-vercel` — Knowledge          - `c-checkout` — Component
- `p-aurora` — Project            - `ex-deploy-rollback` — Example
**Global preferences:**
- `pref-global-reasoning` — Preference
- `pref-global-tests` — Preference
```

Full live stack end to end: real bge-m3 query embed, real int8 reranker (cold ONNX load on first call), real qwen3 critic passing at iteration 1. Server-side backbone row + span for that exact call:

```
mcp_calls: {"session_id":"43aacfa9-…","tool":"get_context","args_hash":"sha256:3728eb…","result_status":"ok","duration_ms":26761,
            "params":"{\"task\":\"deploy the aurora storefront to vercel and verify the checkout flow\"}"}
traces:    {"name":"kernel.mcp-call","status":"ok","attributes":{"agent.id":"mcp:43aacfa9-…","action.name":"get_context","mcp.session_id":"43aacfa9-…"}}
```

(26.8 s = first-call reranker session load ~20 s + live loop; warm passes are the phase-03 ~1.7 s floor.) Cleaned up after: smoke server entry removed from the local claude config, app killed, port 4517 released.

### 4. Full verification (this machine)

```
npm run lint          clean (incl. new @modelcontextprotocol/* fence; probe import verified to fire)
npm run typecheck     clean (tsconfig.node + tsconfig.web)
npm test              Test Files 33 passed | 3 skipped (36) · Tests 249 passed | 7 skipped (256)
OLLAMA=1 RERANKER=1 npm test        Tests 256 passed (256)
ELECTRON_RUN_AS_NODE=1 electron … vitest run tests/integration
                      Test Files 11 passed | 3 skipped (14) · Tests 81 passed | 7 skipped (88)
```

Live-run caveat, reported honestly: with the live models resident the vitest **forks-pool teardown** flake (ryugraph dirty exit, phase-01 finding 3 / phase-04 note) surfaced more often — across four live runs, individual workers died at/near teardown (`storage.migration`, `retrieval.loop` — both pre-phase-05 files); every affected file is green in isolation and the final live run reported **all 256/256 tests passing** with only post-report teardown errors. Offline runs: one transient worker error on the first run, clean on re-run — same signature as phase 04.

## Key decisions & findings (read before later phases)

1. **Low-level SDK `Server`, not `McpServer`** — the phase demands "impossible to invoke a tool without a log row"; a single `CallToolRequestSchema` handler is a real chokepoint (logging + `kernel.execute` wrap unknown tools and validation failures too), where per-tool registration wrappers would be a convention. Cost: tools carry hand-registered JSON schemas — recovered by deriving them from the zod validators via `z.toJSONSchema` (zod 4), so validation and advertisement share one definition.
2. **`mcp_calls` logs `tools/call` requests only** — the table is tool-shaped (tool, args, duration) and §6's backbone is "which skills / MCPs / plugins fired"; `initialize`/`tools/list` are protocol handshake, not experience. Auth-rejected requests never reach a tool and are deliberately not logged (pinned by test).
3. **args hash + capped args JSON** (appdata v3): the phase doc specifies "args hash"; §6 extraction wants the args themselves. Both: `args_hash` always (sha256 of key-order-independent canonical JSON), `params_json` only ≤ 16 KB (rule-12 `MCP_CALL_ARGS_JSON_MAX_BYTES`) so document-bearing ingest calls can't bloat the log. Schema change is an idempotent guarded `ALTER` (new `APPDATA_COLUMN_ADDITIONS` mechanism — reuse it for future column adds).
4. **Rule 7 vs "helper prints the command"**: the §12/phase-doc text itself shows `Bearer <token>` — so boot prints the command with the **placeholder** and the sample `.mcp.json` is written with the placeholder too (a real token in a world-readable file would violate rule 7). The real token surfaces only on explicit request: the phase-10 dashboard (planned), or the `AGENTIC_OS_PRINT_MCP_TOKEN=1` dev flag used for the smoke.
5. **`search_memory` = arms + fusion + rerank, minus expansion/loop/budget** — §2 defines hybrid retrieval as "fused, then reranked", so rerank stays; "direct … over retrievable nodes, no loop" (§12) excludes graph traversal and the §15 loop. Defaults k=8 (the §20 bundle top-N), max 30 (the arm depth — beyond it the arms would need widening).
6. **`propose_correction` validates existence at proposal time** (13 indexed point reads) and refuses identity/provenance patch keys — cheap early failure beats staging junk for the phase-09 review queue; the graph stays untouched either way. `proposed_by` carries the transport session id, so §13's review UI can correlate a staged write with the session (and its `mcp_calls` rows) that proposed it.
7. **Sessions are the transport's** (`mcp-session-id`, uuid, stateful transport per client; DELETE terminates; kernel agent id = `mcp:<sessionId>`). The §6 inactivity timeout (phase 11) reads `mcp_calls.started_unix_ms` grouped by this same id — no extra bookkeeping was added.
8. **Rule-12 picks** (recorded; none are §20 values): endpoint path `/mcp` (from the §12 helper command), server identity `agentic-os@0.0.1`, `MCP_MAX_BODY_BYTES` 4 MB, `MCP_CALL_ARGS_JSON_MAX_BYTES` 16 KB, `SEARCH_MEMORY_DEFAULT_K` 8 / `SEARCH_MEMORY_MAX_K` 30, client-manager config `userData/mcp-servers.json`, get_skill example cap = `RETRIEVAL_RECENT_EXAMPLES` (3), tool error codes `INVALID_INPUT|NOT_FOUND|NOT_IMPLEMENTED` (+ `INTERNAL` for unexpected throws), 401 JSON-RPC code -32001.
9. **No SpendMeter on the MCP retrieval path** — retrieval is local/free (phase-03); live MCP calls have no per-task budget context yet. Phase 08+ background tasks pass `{spendMeter, taskId}` through `RetrieveOptions` when they call the same retriever.
10. **MCP SDK 1.29.0 + zod 4**: the SDK's zod peer (`^3.25 || ^4.0`) dedupes onto our pinned `zod@4.4.3` — one instance, no compat shims needed. The client manager reuses the same SDK for outbound (`Client` + streamable-http/stdio transports).
11. **Client manager config never holds secrets** — http entries reference keychain secret *names* (`bearerTokenSecret`); the resolver is injected (Keychain in production, plain closure in tests). Add UI + health checks in phase 10; agents consume `listTools` from phase 08.
12. **First live `get_context` over MCP ≈ 27 s cold** (one-time ONNX session load inside the 570 MB reranker; phase-02 design), ~1.7–2 s warm (phase-03 finding 11). If cold-start ever matters for UX, warm the reranker at boot behind a setting — deliberately not done now (§20 mandates lazy-load + idle-unload).

## Deferred / notes

- **No hook endpoint** (`/hooks/session-end`) — phase 11 per the phase doc; the HTTP server 404s everything but `/mcp`. When phase 11 adds it, extend `handleHttp` routing (the hook shares this server per §20).
- Ingestion tool bodies are phases 06/07: replace the `NOT_IMPLEMENTED` throws in `tools.ts`; schemas are already final per §12.
- Tools return JSON as text content only (no `structuredContent`/`outputSchema`) — works with every client; revisit if a consumer wants typed results.
- `McpClientManager.listTools` connects per call (no pooling/caching) — fine until agents call it in loops; revisit in phase 08.
- The smoke-seed script (`tests/fixtures/mcp-smoke-seed.ts`) is reusable for any hand-run demo against a scratch userData (esbuild-bundle → `node … <dir>`, same pattern as `span-evidence.ts`).
- SSE streaming (GET) passes through the transport but nothing emits server-initiated notifications yet.

## Instructions for phase 06 (knowledge ingestion)

- **Fill `ingest_document` in `src/main/mcp/tools.ts`**: replace the `NOT_IMPLEMENTED` throw. `ToolContext` gives you `engine` (write via `engine.withWrite` — §21 rule 1) and `db`; if ingestion should run as a background job, extend `AgenticOsMcpServerDeps`/`ToolContext` with the phase-04 `runner` (`kernelInstances.runner` is already available in `bootMcp`) and return the jobId — `runner.getJob(jobId)` powers status.
- Chunking defaults are in config: `CHUNK_TARGET_TOKENS` 512 / `CHUNK_OVERLAP_TOKENS` 64 (§20); embeddings via the shared `OllamaClient` (`bootMcp` holds it; don't construct a second one).
- `Document`/`Knowledge` write shapes: content-hash dedup + replace-changed-chunks per §18 write paths; `HAS_CHUNK` edges; tag chunks per the `tags` arg (`TAGGED` targets `Knowledge` per §18).
- The call log requires nothing from you — any tool you register through `MCP_TOOLS` is logged and kernel-mediated automatically by the CallTool chokepoint. Do NOT add a second registration path.
- Test rig: `tests/integration/mcp.server.test.ts` shows the full client-over-HTTP pattern (`connect`/`call` helpers, port 0, `openKernelStack` + `openTestStore`); `mcp.smoke-seed` for live demos.
- Watched-folder ingestion (chokidar) is phase 11 (triggers); phase 06 is the pipeline + the MCP tool + dashboard file-pick only.
