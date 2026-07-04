# Phase 03 — Hybrid retrieval & self-correcting loop
**Goal:** `retrieve(task, tags?) -> ContextBundle` exactly per the §18 read path, wrapped in the bounded §15 loop.
**Read first:** spec §2, §15, §18 read path, §20; phase reports 01–02.

## Build
- `src/main/retrieval/`: embed task → parallel vector (top-30 per retrievable label) + FTS (top-30) → **graph expansion** (project→skills/MCPs/plugins/components; matched tags→preferences via APPLIES_TO + ALWAYS the global tag's preferences; skill→active SkillVersion + recent Examples) → fusion score (0.5 vector / 0.2 keyword / 0.3 graph-proximity) → ONNX rerank → top-8 → bundle assembled within a token budget (per-provider tokenizer counts).
- Self-correcting loop: local small-LLM critic scores the bundle vs. a rubric; if low → small LLM rewrites the query → retry. Max 5, stop-on-non-improvement, always return best + `confidence` flag. SpendMeter consulted each iteration.
- Fixture graph (`tests/fixtures/graph-seed.ts`): ~40 nodes covering every retrievable label + relationships.

## Definition of Done
- [ ] Golden tests: 5 queries against the fixture return expected node ids in the bundle (order-insensitive top-8).
- [ ] Global-tag preferences appear in every bundle.
- [ ] Loop test: a deliberately bad first query improves by iteration ≤ 3; an impossible one exits at 5 with `confidence: low`.
- [ ] p50 retrieval latency on the fixture < 500 ms (log it in the report).
**Do NOT:** expose over MCP yet; no writes anywhere in this path.
