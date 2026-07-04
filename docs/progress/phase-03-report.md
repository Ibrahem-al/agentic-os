# Phase 03 report — Hybrid retrieval & self-correcting loop

**Status:** done · **Date:** 2026-07-04

## What was built

`src/main/retrieval/` — `retrieve(task, tags?) → ContextBundle` per the §18 read path, wrapped in the §15 loop. Depends on models only through minimal structural interfaces (`Embedder`/`RerankerLike`/`SmallLlm`/`BudgetGuard` — the real `OllamaClient`/`Reranker`/`SpendMeter` satisfy them, pinned by a compile-time test), so golden tests run fully offline on deterministic fakes.

- **`pipeline.ts`** — one read-path pass (`runReadPath`): embed query (bge-m3) → in parallel, vector top-30 **per retrievable label** + FTS top-30 → graph expansion → fusion → single rerank of the fused head → top-8 → token-budgeted bundle. FTS input is sanitized to word characters (finding 8, phase 01); the FTS arm runs per-label k=30 then keeps the overall top-30 (see decisions).
- **`expand.ts`** — §18 step 2, read-only by construction: project→skills/MCPs/plugins/components (hop 1); matched tags (caller-requested by name = hop 0, `TAGGED` from seed hits = hop 1) → preferences via `APPLIES_TO` (tag hop + 1); skill (seed or project-derived) → **active** `SkillVersion` + recent `Example`s (cap `RETRIEVAL_RECENT_EXAMPLES`); ALWAYS fetches the global Tag's preference ids.
- **`fusion.ts`** — pure scoring: `0.5·vector + 0.2·keyword + 0.3·graph` (§20). Normalization: vector = `clamp01(1 − cosineDistance)` (absolute cosine is meaningful); keyword = FTS score / max in candidate set (BM25 is unbounded); graph = `0.5^hops`. Candidates keyed `label:id`; re-observation merges best-signal (min distance, max FTS, min hops).
- **`render.ts`** — per-label text rendering (the exact string reranked and bundled), fetched in one `UNWIND` query per label. Covers all nine candidate labels (4 retrievable + SkillVersion/Example/MCP/Plugin/Component).
- **`tokens.ts`** — `TokenCounter` interface + per-provider *estimating* counter: conservative chars/token divisors for ASCII (3.3–3.6 vs the ~4 real average) and non-ASCII billed at 1 token/char, so estimates overestimate universally. Phase 04's context manager swaps in real tokenizers here (§10); no new deps were added for this.
- **`critic.ts`** — §15 evaluation on the LOCAL tier with prompts separate from everything else: rubric critic (relevance/coverage/specificity → strict-JSON score 0–10, normalized) and query rewriter. Parsing degrades gracefully: JSON → bare-number salvage → score 0 (loop keeps iterating; never throws on a formatting hiccup). Rewriter returns `null` on empty/duplicate output.
- **`loop.ts`** — `createRetriever(deps) → { retrieve, singlePass }`. Loop: pass → critic → (≥ pass score → `confidence: 'high'`) else rewrite → retry; max `LOOP_MAX_ITERATIONS` (5, §20); **stop on non-improvement** (score ≤ best); **SpendMeter consulted at the top of every iteration** (`checkBudget(taskId)`, `taskId` required when a meter is supplied); ALWAYS returns the best bundle with `confidence`, `iterations`, `criticScore`, `haltReason` (`passed | non-improvement | max-iterations | budget-exceeded | loop-error`), `queriesTried`.
- **`types.ts` / `index.ts`** — `ContextBundle`/`BundleItem`/`AssembledBundle` + the structural interfaces; barrel.

Tests & fixtures (52 new tests → 170 total):

- **`tests/fixtures/graph-seed.ts`** — 48-node fixture covering **all 13 node labels and all 15 edge types**: two disjoint-vocabulary worlds ("aurora storefront" ecommerce / "comet telemetry" pipeline), 2 global-tag preferences, 4 tags, deterministic bag-of-words hash embeddings (`fakeTextEmbedding`) so cosine ≈ lexical overlap offline; `seedFixtureGraph(engine, embedder?)` — the live test passes the real `OllamaClient` for genuine bge-m3 vectors.
- **`tests/fixtures/retrieval-fakes.ts`** — `FakeEmbedder`, `FakeReranker` (overlap/√|doc| "logits"), `ScriptedLlm` (per-iteration critic/rewrite script, discriminated by system prompt — the discriminator strings are pinned by unit tests).
- Unit: fusion math, token counter (incl. CJK conservativeness), critic parsing/prompts/rewrite hygiene, interface satisfaction. Integration: golden (below), loop (below), latency, live full-stack.

## Definition of Done — outputs

### 1. Golden tests — 5 queries return expected ids (order-insensitive top-8)

`npx vitest run tests/integration/retrieval.golden.test.ts` — 12 tests green. The five queries and their asserted ids (all found in items∪globalPreferences, items ≤ 8):

| Query (tags) | Expected ids present |
|---|---|
| deploy the aurora storefront to vercel and verify the checkout flow | s-deploy, p-aurora, k-vercel |
| tune postgres autovacuum for the telemetry warehouse ingest spikes | k-vacuum, p-comet, s-migrate |
| which components make up the aurora storefront checkout pages | p-aurora, **c-checkout** (expansion-only label) |
| what naming convention applies to warehouse database tables (`tags: ['database']`) | pref-naming, pref-backup |
| render accessible telemetry charts using the approved color palette | s-charts, k-palette, pref-palette |

Additional pinned behavior: `sv-deploy-active` (no embedding, no FTS row — reachable only via expansion) lands in the deploy bundle; retired versions are never expanded; the 4-example skill is capped at 3 recent Examples; project seeds pull skills/MCPs/plugins/components at hop 1 and their versions at hop 2; requested tags reach preferences with zero text match.

### 2. Global-tag preferences appear in every bundle

Asserted for all 5 golden queries **plus** an unrelated query ("entirely unrelated interstellar zeppelin voyage"): both `pref-global-reasoning` and `pref-global-tests` are in `bundle.globalPreferences` every time, and never consume top-8 item slots. Also pinned on the impossible-query loop exit and the budget-halt path.

### 3. Loop tests

`npx vitest run tests/integration/retrieval.loop.test.ts` — 10 tests green:
- **Bad first query improves by iteration ≤ 3**: "make the shop pages go live" (wrong vocabulary) → scripted rewrite to the deploy query → passes at **iteration 2**, `confidence: 'high'`, final bundle contains s-deploy/p-aurora, best bundle is the rewritten pass.
- **Impossible query exits at 5 with `confidence: 'low'`**: strictly-increasing-but-failing critic scores → exactly `LOOP_MAX_ITERATIONS` (5) passes (one embed each), 5 distinct queries tried, `haltReason: 'max-iterations'`, global preferences still present.
- Stop-on-non-improvement (lower **and equal** scores; best earlier bundle kept — verified via `bundle.query`), duplicate-rewrite stop, critic-death mid-loop → best-effort `loop-error` return.
- **SpendMeter consulted every iteration** (call-counted); ceiling blown before iteration 1 → one free local pass still returned (`budget-exceeded`, critic never called); ceiling blown mid-loop → best-so-far kept; `taskId` required with a meter.

### 4. p50 retrieval latency on the fixture (logged)

- **Offline (CI-asserted, `retrieval.latency.test.ts`): p50 = 117.2 ms, p95 = 130.1 ms (n=30)** — the full pass with sub-ms fakes, i.e. the graph + pipeline machinery this phase owns. Asserted < 500 ms.
- **Live full stack (`OLLAMA=1 RERANKER=1`, logged): p50 = 1690.2 ms, p95 = 1750.1 ms (n=11, warm).** Probed breakdown on this machine (CPU inference): one bge-m3 query embed via Ollama = **464.8 ms p50**; warm int8 rerank = **~30 ms/doc** (8 docs 244 ms, 16 docs 505 ms, 30 docs 924 ms). The §20-mandated models alone (1 embed + even an 8-doc rerank ≈ 710 ms) exceed 500 ms on this hardware — no implementation of the §20 pipeline could hit the target live here, so the DoD number is reported for the pipeline (offline) measurement, with the live figure and its breakdown disclosed. If live latency ever matters: a GPU-served Ollama, a smaller rerank pool, or the §4 "future synergy" note (in-process BGE-M3) are the levers.

### 5. Full verification (this machine)

```
npm run lint          clean
npm run typecheck     clean (tsconfig.node + tsconfig.web)
npm test              Test Files 22 passed | 2 skipped (24) · Tests 164 passed | 6 skipped (170)
OLLAMA=1 RERANKER=1 npm test        Tests 170 passed (170)
ELECTRON_RUN_AS_NODE=1 electron … vitest run tests/integration
                      Tests 51 passed | 6 skipped (57)
```

Live full-stack loop (real bge-m3 embeddings in the graph, real int8 cross-encoder, real qwen3 critic): `confidence=high criticScore=1.00 iterations=1 halt=passed` on the deploy task, with s-deploy/p-aurora and both global preferences in the bundle.

### No writes anywhere in this path (phase "Do NOT")

Every retrieval statement is MATCH/UNWIND/RETURN and avoids the engine's mutation-detector keywords (audited; note `created_at` does **not** trip `\bcreate\b`). Pinned by test: the write-lane `enqueuedCount` is unchanged across all five golden retrievals plus a direct pass. Not exposed over MCP (phase 05).

## Key decisions & findings (read before later phases)

1. **Probes (ran before building):** string-array params bind fine (`UNWIND $ids` / `WHERE x IN $ids` via prepare+execute); multi-word FTS queries are disjunctive (OR); label-filtered traversal works on multi-pair rel tables (`(p:Project)-[:USES]->(s:Skill)`); timestamps come back as `Date`; none of these query shapes touch the write lane.
2. **"FTS top-30" interpretation** (§20 wording gives "per label" only to vector): FTS runs per-label with k=30, results merged and cut to an overall top-30. BM25 scores across the four labels aren't perfectly comparable; keyword-arm normalization (max in candidate set) absorbs most of that.
3. **Graph-proximity is earned, not automatic**: seed hits get NO default graph signal; `graphHops` is set only when expansion (re)discovers a node — so the 0.3 arm measures actual proximity to other matched content (a seed skill reachable from a seed project scores 0.5^1), instead of a flat +0.3 for every seed.
4. **Global-tag preferences ride a dedicated `globalPreferences` section**, always present (§18 step 1 / DoD 2), excluded from the top-8 item slots (no duplication), and **mandatory even when over the token budget** — the budget then only trims items. Budget assembly walks rank order and skips items that don't fit (rather than stopping at the first miss).
5. **Confidence is binary**: `'high'` iff the critic passed the rubric threshold; `'low'` otherwise (best-effort). Loop details travel in `haltReason`/`criticScore`/`iterations` for consumers who need nuance.
6. **Budget halt still serves**: if the task's ceiling is already blown before iteration 1, the loop runs exactly one local (free) pass and returns it flagged low — §15 "always return best-effort" beats returning nothing. `budgetExceeded` treats any `checkBudget` throw as a halt (conservative; the guard is structural so extraction-phase fakes work).
7. **Rerank uses each pass's (possibly rewritten) query** — a pass is self-consistent end to end; the critic always judges against the ORIGINAL task.
8. **Critic robustness over strictness**: unparseable local-LLM verdicts score 0 with feedback "critic reply was unparseable" — the loop proceeds and exits low-confidence rather than crashing retrieval on model formatting.
9. **Rule-12 picks** (none are §20 values; all in `config.ts` with comments): `RETRIEVAL_RERANK_TOP_K = 50` (bounds cross-encoder latency; fused sets can exceed 150 in production), `RETRIEVAL_BUNDLE_TOKEN_BUDGET = 8192` (per-call override), `RETRIEVAL_RECENT_EXAMPLES = 3`, `RETRIEVAL_GRAPH_DECAY = 0.5`, `RETRIEVAL_CRITIC_PASS_SCORE = 0.7`, `RETRIEVAL_CRITIC_MAX_TOKENS = 256` / `RETRIEVAL_REWRITE_MAX_TOKENS = 128`. Also: fusion normalizations (decision 3 above), tag discovery limited to caller-requested names + seeds' `TAGGED` edges, critic/rewrite temperatures 0 / 0.7.
10. **Per-provider tokenizers (§10) are estimated, not real, in phase 03**: no provider in the §20 stack ships a local tokenizer (Anthropic = counting API only; tiktoken would be a new dependency). `TokenCounter` is the seam where phase 04's context manager installs real counting; the estimator deliberately overestimates (ASCII divisors 3.3–3.6, non-ASCII billed 1 token/char) so bundles never blow a real budget.
11. **Live latency is model-bound** (DoD 4 output above): the pipeline itself is ~117 ms; bge-m3-embed-via-Ollama (465 ms) + int8 rerank (~30 ms/doc) dominate. Phase 05's `get_context` should expect ~1.5–2 s wall time on CPU-only machines and must not add its own model calls to this path.
12. **Prompt-content note for phase 09**: the critic necessarily reads retrieved content inside its prompt (that's its job, §15). No tool surface is reachable from the critic and its output is parsed as a score only — worst case a poisoned document flatters its own bundle. Containment/undo (§13) remain the reliable layers; revisit when URL ingestion lands.
13. A code-review pass found and fixed two issues pre-commit: the token estimator's non-ASCII underestimate (finding 10) and a dead type re-export in pipeline.ts.

## Deferred / notes

- Expansion's ~5 sequential query rounds could partially overlap (e.g. global-preference fetch alongside project expansion) — not worth the churn at 117 ms p50; revisit if graphs grow.
- Fusion currently ignores provenance confidence/staleness; §18 "fusion scoring may downweight low-confidence/stale nodes" is a MAY and needs extraction-written data to tune against — revisit in/after phase 08.
- `runReadPath` (single pass, no loop) is exported — phase 05's `search_memory` wants something close to it.
- Prepared-statement caching (phase-01 note) still untouched; the retrieval hot path now exists and runs ~10 small queries/pass if it ever needs shaving.

## Instructions for phase 04 (kernel, runner, tracing)

- Construct once and share: `createRetriever({ engine, embedder: ollamaClient, reranker, llm: ollamaClient })` from `src/main/retrieval` — `Reranker` self-manages lazy-load/idle-unload; one instance per app (phase-02 note).
- `retrieve(task, tags?, options)`: pass `{ spendMeter, taskId }` for any task that can spend elsewhere (retrieval itself is local/free but the loop halts on a blown ceiling); `ceilingUsd` forwards a per-task override.
- The context manager (§10) should implement `TokenCounter` with real per-provider tokenizers and pass it via `options.tokenCounter` (and set `tokenBudget` from the active provider's window).
- Tracing: `singlePass` is the natural span unit; `ContextBundle.iterations/haltReason/criticScore/queriesTried` are the loop's ready-made span attributes.
- Don't call retrieval from inside a `withWrite` job (it issues reads only, but keep the lane free); never add writes to this path — the lane-journal test will catch you.
- Test patterns to reuse: `seedFixtureGraph` (optionally with a real embedder), `FakeEmbedder`/`FakeReranker`/`ScriptedLlm`, and the golden-test structure in `tests/integration/retrieval.golden.test.ts`.
