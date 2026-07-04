# Phase 08 — Extraction agent
**Goal:** a finished session becomes graph memory: deterministic pass + fuzzy LLM passes + tiered entity resolution + gated writes with provenance.
**Read first:** spec §17 (extraction design), §18 write paths, §20 thresholds; phase reports 04, 05.

## Build (as a Phase-04 workflow; steps checkpointed)
1. **Deterministic pass:** `mcp_calls` rows for the session → `Session` node, `USED` edges to Skill/MCP/Plugin, `Project` match (by cwd/path) — no model, confidence 1.0.
2. **Fuzzy passes (local small LLM, one focused prompt per target):** Components touched, Preferences stated, explicit Corrections. Tolerant JSONL transcript parser (unknown record types skipped, never crash). Escalate whole session to cloud when local confidence < 0.6 or transcript > 60k tokens.
3. **Entity resolution:** stable-key match where ids exist → cosine ≥ 0.90 merge / 0.75–0.90 LLM tiebreak / < 0.75 new.
4. **Gated write:** high-confidence → write lane with full provenance; low-confidence → cloud verifier (different model than extractor); disagreement → `staged_writes` review queue. Explicit corrections only (v1).

## Definition of Done
- [ ] 3 golden fixture sessions (synthetic mcp_calls + transcript) → asserted nodes/edges incl. provenance fields.
- [ ] Resolution test: near-duplicate Preference merges; novel one creates.
- [ ] Low-confidence path lands in `staged_writes`, not the graph.
- [ ] Workflow resumes after a simulated crash between passes.
**Do NOT:** inferred corrections (deferred); no triggers — expose `runExtraction(sessionId)` manually.
