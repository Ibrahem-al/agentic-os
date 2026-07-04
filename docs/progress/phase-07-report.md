# Phase 07 report — Codebase ingestion (Tree-sitter)

**Status:** done · **Date:** 2026-07-04

## What was built

### `src/main/ingest/` grows the §18 codebase write path (three new modules)

- **`codebaseWalk.ts`** — `walkCodebase(root)`: the gitignore-respecting walk. Full `.gitignore` semantics (negation `!`, dir-only `dir/`, `*` globs, **nested** `.gitignore` files scoped to their directory) via the `ignore` package — never hand-rolled; like git, an ignored directory is pruned outright. `node_modules`/`.git`/dot-directories are always pruned (matches the phase-06 scan), dotfiles skipped as files. Files partition into **code** (`CODEBASE_CODE_EXTENSIONS`: ts/tsx/mts/cts/js/jsx/mjs/cjs/py — the §18 v1 grammar set, nothing else) and **docs** (the markdown set); everything else lands in the skip list with a reason. >1 MB (`INGEST_MAX_FILE_BYTES`, the §18 figure) and NUL-sniffed binaries (first 8 KB) are skipped with reasons. Gitignored entries are invisible (not "skipped") — they were never candidates.
- **`codeParser.ts`** — Tree-sitter unit extraction. **web-tree-sitter (WASM) + the npm-shipped grammar wasm binaries** (decision 1). Extracts **meaningful units, never one node per file**:
  - *TS/JS/TSX*: `export`ed `function`/`function_signature` (overloads merge into ONE unit whose hash covers every declaration)/generator → `function`; `class`/`abstract class` → `class`; `interface`/`type`/`enum` → `model`; exported `const` with a function value → `function` (**plain exported constants are NOT units** — config.ts alone would otherwise flood the graph with ~100 meaningless nodes); function-valued `export default` → unit named `default`; top-level `app.get('/path', …)`-style member calls (get/post/put/delete/patch/options/head/all/route + a `/`-leading string literal) → `route` named `GET /path`. JSDoc directly above a unit (no blank line) is captured as its doc.
  - *Python*: top-level `def`/`class` (underscore-prefixed = private, skipped); `@dataclass` or `TypedDict`/`BaseModel`/`NamedTuple` bases → `model`; `@app.get("/x")`-style decorators → `route`; first-statement docstrings captured.
  - *Relationships*: named/default/namespace/aliased imports, `export … from` re-exports (named + `export *`; `export * as ns` deliberately unresolved — the ns object is not a unit), Python from-imports (plain/aliased/relative/wildcard) and module imports.
  - Never throws on malformed code — Tree-sitter yields a best-effort tree and extraction skips what it cannot pattern-match (pinned by test). Parsed code is **data**: never executed (§21 rule 3, and WASM parsing is itself sandboxed), never interpreted as instructions (§21 rule 5).
- **`codebase.ts`** — the orchestrator: `ingestCodebase(deps, root, {project?, onProgress?})`, the §12-shaped plain function the MCP tool and the phase-10 dashboard folder-pick both call. `deps = {engine, embedder, llm}` (structural `ProjectSummarizer` — the shared OllamaClient satisfies it). Flow: walk → parse (per-unit `sha256` content hash) → resolve DEPENDS_ON pairs (below) → match/create the Project → **read current graph state → compute the DIFF → ONE `withWrite` lane job** for the whole component-graph mutation (project create, tag create, `TAGGED`, stale-component `DETACH DELETE`, stale-edge `DELETE`, new components, `HAS_COMPONENT`, `DEPENDS_ON`) → README/markdown + docstring digests through the **phase-06 knowledge pipeline** (never writing Knowledge nodes itself), tagged to the Project → prune stale codebase docs. Progress events (`walking`/`parsing`/`writing`/`knowledge` with `filesWalked`/`codeFilesParsed`/`componentsFound`) fire throughout for the phase-10 UI.

### Identity & per-unit content-hash (§18 "re-ingest replaces only changed units")

- `rootKey = sha256(resolved root, lowercased on win32)[0:16]`; Project id `proj-<rootKey>`; Component id **`cmp-<rootKey>-<sha256(relPath\n kind\n name)[0:16]>-<unitHash[0:8]>`** — the phase-06 "id embeds the content hash" trick generalized. An unchanged unit maps to an id that already exists → zero writes for it; a changed unit is a new id, the stale one deleted in the same lane job; edges from unchanged units re-point automatically because the full desired edge set is recomputed and diffed. Component `name` = `<relPath>:<unitName>` (path-qualified: greppable, disambiguates same-named units, and gives the reranker real tokens), `type` = `function|class|model|route` (§18's open enum).
- **Identical re-ingest = zero lane jobs, zero embeds, zero LLM calls** (all three counters pinned by test; the knowledge docs dedup via phase-06 content hashes before any model call). Live: re-ingesting this whole repo took **1.3 s** (vs 324 s cold) with `status:'unchanged'`, 0 created / 0 deleted.

### DEPENDS_ON derivation (imports × references)

For each import binding in file A: resolve the specifier repo-internally (TS: relative-only, extension candidates + NodeNext `.js→.ts` swaps + `index.*`; Python: relative dots + root/sibling packages, `mod.py` or `mod/__init__.py`), then **resolve the exported name through barrels** — TS `export … from` chains (named, aliased, `export *`) and Python's import surface (a name imported by `__init__.py` IS importable from the package) — cycle/depth-safe. An edge `U -[:DEPENDS_ON]-> T` is created only when unit U's own source text references the imported local name (word-boundary; `ns.member` / `pkg.mod.member` attribute matching for namespace/module imports; wildcard from-imports match the target's identifier-named units). External packages never become components or edges. This barrel-following matters: in this repo most cross-module imports go through `index.ts` barrels — without it the self-ingest graph loses most of its 197 edges.

### Project match/create (§18 "match by path, create with a summary from README")

Match order: (1) explicit `project` arg by exact name; (2) path-derived id `proj-<rootKey>`; (3) the project already owning this root's components (`c.id STARTS WITH 'cmp-<rootKey>-'`) — covers renames and named-first-ingest cases. Created projects get: name from `package.json` `name` (fallback: folder basename), summary from the **local qwen3** over the root README (capped prompt + `CODEBASE_SUMMARY_MAX_TOKENS`), and a real **bge-m3 embedding of exactly what retrieval renders** (`name — summary`). qwen3's known narration failure mode (phase-04 finding) is guarded: replies that narrate ("We are summarizing…", length/shape violations) are rejected — rescued from trailing quotes when possible — and fall back to the README's first prose paragraph (deterministic; also the no-Ollama path, so ingestion works fully offline). Tag: a `Tag {name: <project name>, is_global: false}` is created/reused (same slug + exact-name rules as phase 06 — `tagSlug` is now shared), the Project is `TAGGED` to it, and every knowledge chunk ingests under it.

### Docstring / markdown knowledge, tagged to the Project

- Every walked markdown file → `ingestKnowledgeFile` (absolute path = source; a manually-ingested duplicate of the same file dedups naturally).
- Every code file with doc text → a per-file markdown digest (`# Code documentation — <relPath>` + `## <unit>` sections) ingested under source **`code-docs:<absolute file path>`** — distinct from the file's own path so a literal ingest of the file never collides. Doc changes ride phase-06 dedup: a body-only edit leaves the digest unchanged → no knowledge writes.
- **Prune**: project-tagged documents under the root (md files or `code-docs:` sources) that this run did not produce are deleted (chunks + Document, one lane job) — deleted files and emptied docstrings don't leave stale knowledge.

### `ingest_codebase` MCP tool filled (`src/main/mcp/tools.ts`)

The `NOT_IMPLEMENTED` throw is replaced by a call to `ingestCodebase` with `ctx.engine` + `ctx.retrieval.embedder` + `ctx.llm` — **`ToolContext`/`AgenticOsMcpServerDeps` gained `llm`**, wired in `bootMcp` from the ONE shared OllamaClient (no second instance). `IngestError → ToolError` 1:1; the phase-05 CallTool chokepoint logs + kernel-mediates automatically (no second registration path). The reply echoes the full result with the skip list capped at 50 entries (+`skippedTotal`).

### Retrieval refinements (phase-07 findings, measured live — see decisions 6–8)

Two defects in the phase-03 read path only manifest on graphs bigger than the rerank pool, and this phase built the first such graph:

- **`rerankAdmissionOrder` (pipeline.ts)** — fused scores tie EXACTLY for expansion-only candidates (all 282 of a project's components sit at graph 0.5 → fused 0.15), and the old tie-break (id `localeCompare`) made pool admission effectively random for content-hash ids. Ties are now broken by cheap lexical overlap with the query (camelCase/path-splitting, prefix-tolerant: "ingestion" ~ "ingest"). Applied **only when candidates exceed the pool** — small graphs (every offline fixture) take the identical old path.
- **Structural carry-through in the final ordering (pipeline.ts)** — §2 pins THREE-way hybrid ("semantic + structural + lexical, fused, then reranked"), but the cross-encoder only reads text: graph proximity is invisible to it, and its absolute logits carry a measured **class bias** (~4 logits between on-topic prose and terse `component x (function)` name-cards; live probe in decision 7). Final ordering is now `sigmoid(rerank logit) + RETRIEVAL_FUSION_WEIGHTS.graphProximity × graph signal` — the §20 graph weight in its §20 role, no invented constants. Rerank order is untouched among equal-structure candidates; prose-only pools are unchanged (graph signal 0).
- **`FakeReranker` is now scale-faithful** (tests/fixtures): it kept the same monotone overlap ordering but now emits realistic logits (zero overlap → −8, else spread over (−2, +10]) — required so sigmoid-calibrated offline bundles behave like live ones. Order-based assertions were unaffected by the affine rescale.

### Config additions (rule-12 picks, recorded — §20 untouched)

`CODEBASE_INGEST_PROVENANCE` = `codebase-ingest@0.0.1` (§18's `codebase-ingest@<version>`; tracks package.json), `CODEBASE_CODE_EXTENSIONS`, `CODEBASE_DOCS_SOURCE_PREFIX` = `code-docs:`, `CODEBASE_SUMMARY_MAX_TOKENS` = 160, `CODEBASE_README_PROMPT_MAX_CHARS` = 6000 (fits the 4096-token local window), `CODEBASE_SUMMARY_FALLBACK_MAX_CHARS` = 400; `INGEST_CODEBASE_SKIPPED_REPLY_CAP` = 50 (tools.ts).

### Dependencies added (user-approved this phase, exact pins)

`web-tree-sitter@0.26.10`, `tree-sitter-typescript@0.23.2`, `tree-sitter-javascript@0.25.0`, `tree-sitter-python@0.25.0` (all ship prebuilt `.wasm` in their npm tarballs), `ignore@7.0.5`. Tree-sitter is **ESLint-fenced into `src/main/ingest/`** exactly like ryugraph/LangGraph/MCP-SDK (probe-verified to fire); `tests/fixtures/mini-repo` is excluded from tsc + eslint (parse-fodder, not project source).

### Tests — 35 new (322 total)

- **`tests/unit/ingest.codeParser.test.ts` (14)** — TS exports incl. overload merge + default exports + TSX, route detection, JSDoc attach + per-unit hashes, imports/re-exports, malformed-source resilience; Python defs/classes/private-underscore, dataclass/TypedDict → model, route decorators, import forms.
- **`tests/unit/ingest.codebaseWalk.test.ts` (3)** — gitignore negation + nested scopes, always-pruned dirs, binary/oversize/extension skip reasons.
- **`tests/integration/ingest.codebase.test.ts` (14)** — the DoD suite over the real engine (below) + project/tag/knowledge assertions, error paths, progress events, narrated-summary fallback.
- **`tests/integration/mcp.server.test.ts` (31, was 28)** — `ingest_codebase` end-to-end describe (create/unchanged/error + mcp_calls rows); the suite-wide "every call logged + kernel span" invariants now cover it; the write invariant is now "graph writes came ONLY from ingest_document/ingest_codebase lane jobs".
- **`tests/unit/retrieval.fusion.test.ts` (+1)** — `rerankAdmissionOrder` tie-break golden.

## Definition of Done — outputs

### 1. Fixture mini-repo (TS + Python) → golden Components + DEPENDS_ON

`tests/fixtures/mini-repo/` (TS schedule engine + express-style route + JS module + Python pipeline/FastAPI package; `.gitignore` with negation; the test copy adds node_modules/dist/binary/>1 MB junk). Asserted **golden list, exact**: 12 components —

```
src/schedule.ts:WateringSchedule(model)  src/schedule.ts:computeSchedule(function)  src/schedule.ts:toMinutes(function)
src/util.ts:clamp(function)  src/util.ts:formatLabel(function)  src/server.ts:GET /schedule(route)
src/legacy.js:legacyThing(function)  py/pipeline.py:SensorReading(model)  py/pipeline.py:Batch(model)
py/pipeline.py:run_pipeline(function)  py/filters.py:smooth(function)  py/api.py:GET /readings(route)
```

and exactly 4 DEPENDS_ON edges (two of them through indirection: the TS **barrel** `index.ts` and the Python **`__init__` import surface**):

```
src/server.ts:GET /schedule      → src/schedule.ts:computeSchedule   (via export … from './schedule')
src/schedule.ts:computeSchedule  → src/util.ts:clamp
py/api.py:GET /readings          → py/pipeline.py:run_pipeline       (via from . import → __init__ → .pipeline)
py/pipeline.py:run_pipeline      → py/filters.py:smooth
```

Provenance `codebase-ingest@0.0.1` + confidence 1.0 on **every node and every edge** (§21 rule 4). Gitignored (`ignored.ts`, nested `src/.gitignore` scratch), pruned (node_modules, dist) and private (`_internal_helper`) units provably absent; binary + oversized files in the skip list with reasons; `secret*.md` skipped while the `!secretpublic.md` negation is ingested.

### 2. Self-test: this very repo (real bge-m3 + qwen3 + reranker)

`out/smoke/codebase-selftest.mjs` (esbuild-bundled `tests/fixtures/codebase-selftest.ts`) over a scratch store:

```
[selftest] project agentic-os (proj-5e5e315f5eb41212) status=created — 189 files walked, 130 code files parsed
[selftest] components: {"total":282,"created":282,"deleted":0,"unchanged":0} — dependsOn: {"total":197,"created":197,"deleted":0}
[selftest] knowledge: 85 documents (555 chunks), 0 failed, 25 files skipped        [ingest: 322.9s cold]
[selftest] node counts: Project=1 Component=282 Document=85 Knowledge=555 Tag=1
[selftest] edge counts: HAS_COMPONENT=282 DEPENDS_ON=197 HAS_CHUNK=555 TAGGED=556
[selftest] sample MATCH (c:Component)-[:DEPENDS_ON]->(d):
[selftest]   src/main/ingest/chunker.ts:chunkDocument      -[:DEPENDS_ON]->  src/main/retrieval/tokens.ts:estimatingTokenCounter
[selftest]   src/main/ingest/codebase.ts:CodebaseIngestDeps -[:DEPENDS_ON]-> src/main/ingest/knowledge.ts:KnowledgeEmbedder
[selftest]   src/main/ingest/codebase.ts:CodebaseIngestDeps -[:DEPENDS_ON]-> src/main/storage/engine.ts:StorageEngine
```

qwen3's live summary attempt narrated (decision 5's guard caught it) → the stored summary is the deterministic README fallback, clean. Immediate re-run: `status=unchanged`, 0 created / 0 deleted, **1.3 s** — the live zero-write proof at repo scale.

### 3. Re-ingest after touching one file changes only that file's units

`ingest.codebase.test.ts`: editing `clamp`'s body (JSDoc untouched) → `components {created: 1, deleted: 1, unchanged: 11}`, **exactly one** lane job (the diff job; the docstring digest didn't change so knowledge is silent), old clamp id out / new id in, and **every other component keeps both its id AND its `updated_at`** (nodes untouched, pinned per node). The `computeSchedule → clamp` edge re-points to the new id (edge write only; `computeSchedule`'s node untouched). Also covered: deleting `py/filters.py` prunes `smooth`, its incoming edge, and its `code-docs:` document (`knowledge.pruned` + zero rows in the graph), while `run_pipeline` keeps its id.

### 4. retrieve("how does ingestion work") surfaces relevant Components

- **Offline** (mini-repo graph, fake models): bundle items contain Components (schedule-related) for a schedule task — pinned by test.
- **Live** (the self-ingested graph, real bge-m3 + int8 reranker + qwen3 critic):

```
[selftest] retrieve("how does ingestion work") → confidence=high iterations=2 items=8
   Knowledge  …spec §18 Graph schema / Read path / Relationships chunks (3)
   Component  src/main/retrieval/search.ts:SearchMemoryHit (model)
   Component  src/main/retrieval/search.ts:SearchMemoryOptions (model)
   Component  src/main/retrieval/search.ts:searchMemory (function)
   Component  docs/reference/skill-creator/scripts/run_eval.py:run_single_query (function)
   Component  src/main/ingest/knowledge.ts:ingestKnowledgeContent (function)
[selftest] components in bundle: 5 PASS
```

This DoD required the two retrieval refinements (decisions 6–8): before them, pool admission was hash-random among 282 tied components and the measured reranker class bias kept even perfectly-named components ~4 logits below any on-topic prose — 0 components in the bundle across two full live runs, deterministically.

### 5. Full verification (this machine)

```
npm run lint          clean (incl. new tree-sitter fence; probe import verified to fire)
npm run typecheck     clean (tsconfig.node + tsconfig.web)
npm run build         clean (electron-vite production build)
npm test              Test Files 38 passed | 3 skipped (41) · Tests 314 passed | 8 skipped (322)
OLLAMA=1 RERANKER=1 npx vitest run --no-file-parallelism
                      Test Files 41 passed (41) · Tests 322 passed (322)   [273s warm; one post-report
                      ryugraph teardown worker-exit — the known flake, zero test failures]
ELECTRON_RUN_AS_NODE=1 electron … vitest run tests/integration
                      Test Files 13 passed | 3 skipped (16) · Tests 115 passed | 8 skipped (123)
```

Live/parallel-run caveat (same as phases 04–06, reported honestly): individual runs intermittently lose a worker to the known ryugraph forks-pool teardown flake **after** its tests report (zero test failures ever; affected files green in isolation and on re-run). Offline re-run in this phase: 38/38 files clean.

## Key decisions & findings (read before later phases)

1. **web-tree-sitter (WASM), not native node-tree-sitter** (user-approved). All three grammar npm packages ship prebuilt `.wasm`; the runtime is pure JS+WASM. Zero native builds, zero dual-ABI ritual (native would have added 4 modules × the better-sqlite3 dance, with no Electron prebuilds), and the identical artifact runs under plain-Node vitest and Electron main — proven by the Electron-runtime suite. Grammar ABI 14/15 both load. WASM parse throughput was a non-issue: 130 files parse in low seconds; the 322 s cold self-ingest is ~embedding-dominated (555 chunks through bge-m3).
2. **`ignore@7.0.5` for gitignore semantics** (user-approved) — negation, dir-only, anchoring and nesting are exactly the edge cases hand-rolled matchers get wrong; the walk composes per-directory scopes and prunes ignored dirs like git does (no re-inclusion inside an ignored dir).
3. **Unit granularity**: exported/top-level only; plain exported constants excluded (decision recorded: config.ts would become ~100 meaningless components); TS overloads merge; `model` covers interfaces/type aliases/enums/dataclasses/TypedDict/BaseModel/NamedTuple bases; route units are named `VERB /path`. Intra-file references are deliberately NOT edges (import/call relationships only, per §18) — self-edges and same-file noise stay out.
4. **Diff-based single lane job** — reads compute the full desired state (components, edges, links) and diff against the graph; only the delta is written, in ONE `withWrite` job (§21 rule 1). `createEdge` MERGE would re-stamp `updated_at` on every edge every run, so existing edges/links are read first and only missing ones created — that is what makes "unchanged re-ingest = zero writes" literal at repo scale (1.3 s live).
5. **README summary guard**: qwen3 narrates even with `think:false` (phase-04 finding, reproduced live here). Replies failing shape checks (20–600 chars, no narration markers) are rescued from a trailing quoted span or replaced by the README's first prose paragraph. Summary/embedding are **create-only** — re-ingests never clobber a user-curated project summary, and an unavailable local tier degrades to the deterministic fallback (ingestion works offline).
6. **Rerank-pool admission was hash-random under ties** (phase-03 latent defect, exposed at 282 components): fused scores tie exactly for expansion-only candidates, and the id tie-break made pool membership arbitrary for content-hash ids. Fixed with a lexical-overlap tie-break that only engages when candidates exceed the pool — every pre-existing fixture (< 50 candidates) takes a byte-identical path.
7. **The cross-encoder's class bias is real and measured**: live probe (int8 bge-reranker-v2-m3, query "how does ingestion work") — relevant prose −0.5…−2.0 logits, relevant component name-cards −4.2…−6.6, irrelevant components −11. It discriminates WITHIN a class but offsets BETWEEN classes, so pure-logit ordering can never surface a structural node once ≥ 8 on-topic prose chunks exist. §2 pins the hybrid as three-way (semantic + structural + lexical) — the fix carries the structural signal through the final ordering: `sigmoid(logit) + 0.3 × graph` (the §20 graph-proximity weight; no new constants). Verified live: the DoD bundle went from 0 components (twice, deterministically) to 5 relevant ones alongside the 3 best prose chunks, and all 314 offline + live retrieval goldens still pass.
8. **FakeReranker now emits logit-scale scores** (−8 for zero overlap; (−2, +10] otherwise, same monotone order). With the old [0..2] scale, `sigmoid` compressed everything to 0.5–0.9 and offline bundles diverged from live behavior — fakes must match the real model's *scale*, not just its ordering, once any consumer calibrates scores.
9. **Component ids embed the root key** — `cmp-<rootKey>-…` makes "this root's components" a prefix query (`STARTS WITH`), which is how re-ingest finds existing state and how a renamed/renamed-project root is re-matched ("match by path" without a path property on Project — §18's Project schema has none).
10. **Docstring digests are their own documents** (`code-docs:<path>`), not appended to file ingests: body edits don't churn knowledge, doc edits don't churn components, and phase-06 dedup applies per concern. Pruning is scoped to project-tagged docs under the root, so a user's manual ingests elsewhere can never be collateral damage.
11. **`ingest_codebase` runs synchronously in the MCP call** (like `ingest_document`): the cold self-ingest of THIS repo (189 files) is ~5.4 min — dominated by 555 bge-m3 chunk embeds — but typical target repos are far smaller, re-ingests are ~1 s, and the §15 policy (clean structured errors, caller decides) holds. If phase 11 wants background ingestion, wrap the same plain function in a runner workflow.
12. **`tests/fixtures/mini-repo` ships a `gitignore` file (no dot)** renamed to `.gitignore` in the test's temp copy — a real dotted one would make git itself ignore the fixture's `ignored.ts`, and node_modules/dist junk is created at test time because the repo's own root `.gitignore` excludes those names everywhere.

## Deferred / notes

- chokidar still NOT installed (watcher auto-reingest is phase 11 — the phase doc forbids it here; `ingestCodebase` is the callable to schedule).
- `CONNECTS_TO` edges unused (schema supports them; nothing in TS/JS/Python import analysis maps to "connects to" yet).
- Reference detection is lexical (word-boundary occurrence inside unit text) — a shadowed local name could create a false edge; acceptable at this granularity, revisit only if extraction (phase 08) needs precision.
- CJS `require()` calls are not parsed for dependencies (repo standard is ESM; scripts/*.cjs yield no units anyway); `export * as ns from` is not resolved (the namespace object is not a unit).
- Packaged-app paths for the grammar wasm files (electron-builder `extraResources`, like the ryugraph extensions) — phase 13.
- The `skipped` list in the plain-function result is unbounded (dashboard-friendly); the MCP reply caps it at 50 + `skippedTotal`.
- Self-test scratch stores under the OS temp dir are disposable; `out/smoke/codebase-selftest.mjs` is reusable for any hand-run demo (`node … <scratchDir> <modelsDir>`).

## Instructions for phase 08 (extraction agent)

- **Provenance precedent**: Components + all their edges are stamped `extracted_by`/`confidence` at write time — extraction writes must do the same AND add `EXTRACTED_FROM → Session` (codebase ingestion deliberately has no session; §18 gives its chunks provenance via `HAS_CHUNK`/`TAGGED` instead).
- **Entity resolution against ingested nodes**: projects created here are `proj-<rootKey>` with real embeddings of `name — summary`; §20's cosine thresholds (0.90 merge / 0.75 tiebreak) apply when extraction meets an existing Project. Match-by-name first — `planProject` shows the order that avoids duplicates.
- `ToolContext`/`AgenticOsMcpServerDeps` now carry `llm` (the shared OllamaClient) — extraction's local tier is already plumbed to the MCP layer if needed.
- The retrieval final ordering now carries the graph signal (decision 7) — extraction-written structural nodes (Corrections→Sessions etc.) benefit the same way components do; do NOT re-add class-bias workarounds elsewhere.
- Test rigs: `ingest.codebase.test.ts` shows full-engine diff-ingest asserts (lane deltas, per-node `updated_at` stability); `codebase-selftest.ts` shows the live-evidence script pattern.
- Write shapes to reuse: `tagSlug` (shared), `IngestError` codes, the diff-then-one-lane-job pattern for any bulk graph mutation.
