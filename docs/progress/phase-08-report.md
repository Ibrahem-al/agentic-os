# Phase 08 report — Extraction agent

**Status:** done · **Date:** 2026-07-04

## What was built

### `src/main/agents/extraction/` — a finished session becomes graph memory (§17)

The extraction agent is a **Phase-04 workflow** of six checkpointed steps —

```
collect → deterministic → extract → resolve → verify → write
```

— registered on the kernel runner as `'extraction'` (agent id `extraction-agent`, so every step already runs through the kernel chokepoint: span + PHASE-09 permission seam). Every step's output is plain JSON checkpointed by the runner (durability `'sync'`), and **all graph writes live in the final step** — a crash anywhere earlier leaves the graph untouched, and `resume()` continues from the last completed pass without re-running earlier model calls. No triggers (per the phase doc): `runExtraction(sessionId, {transcriptPath?, cwd?, jobId?})` and `resumeExtraction(jobId)` are the manual entry points phase 11 will wire to the SessionEnd hook + inactivity fallback.

- **`transcript.ts`** — the tolerant JSONL parser (§6 "best-effort source"). Never crashes on content: malformed lines and unknown record types are counted and skipped. Renders the conversation (`User:`/`Assistant:`/`[tool] name(args≤160)` lines; `tool_result` bodies deliberately NOT rendered — the noisiest, least-trusted content stays out of prompts; meta records skipped) and pulls the deterministic record facts: cwd, timestamps, session id, and tool_use classification — `mcp__<server>__<tool>` → external MCP server (the OS's own server excluded; last-`__` split so servers with underscores parse), `mcp__plugin_<plugin>_<server>__*` and `Skill {skill: "plugin:skill"}` → plugin, plain `Skill` invocations → skill names. The §20 escalation gate reads this digest's (over)estimated token count.
- **`deterministic.ts`** — §17 step 1, no model, confidence 1.0. Session timing = mcp_calls window widened by transcript timestamps. Skills: successful `get_skill` calls + transcript skill invocations, matched to **existing Skill nodes only** (a name-only Skill shell would pollute `list_skills` and the improvement loop — recorded decision). MCPs/Plugins: matched by exact name or planned as creates (`mcp-<slug>`/`plugin-<slug>`, §18 "MERGE Skill/MCP/Plugin used"). Project match by cwd mirrors phase-07's order: path-derived `proj-<rootKey>` → the project owning `cmp-<rootKey>-*` components → exact-name basename → create with a deterministic stub summary (no model in this pass; embedded at resolve time). `rootKeyOf` is now exported from `ingest/codebase.ts` so extraction derives the identical path identity.
- **`fuzzy.ts`** — §17 step 2: one focused prompt per target (Components touched / Preferences stated / explicit Corrections), local-first over transcript chunks (~2048 est-tokens each, message-boundary packing, pathological lines hard-split). **Local calls use Ollama structured outputs** (`format` = a per-pass JSON schema) — the load-bearing finding of this phase (below). Replies are rescued tolerantly (`{"items":[…]}` object or bare array, narration-tolerant string-aware scanning), items normalized field-by-field (drop-don't-crash; missing confidence → 0.5 = borderline → review path), deduped across chunks by normalized text (max confidence, unions). **Confidence accounting** drives the §20 gate: each call scores 0 (unparseable = the model failed), 1 (clean empty array = confident "nothing here"), or mean item confidence; `sessionConfidence` = mean over local call scores. **Gate A**: transcript > 60k est-tokens → the whole session escalates to cloud chunks (~100k tokens each). **Gate B**: `sessionConfidence < 0.6` → whole-session cloud re-extraction replaces local results. Cloud unavailable/failing → degrade to local with a warning (the write gate then stages what's uncertain); every cloud call is `meteredComplete` against the job id (§14 ceiling).
- **`resolve.ts`** — §17 step 3, tiered per §20: **stable-key** (component exact-name within the session's project) → **cosine ≥ 0.90 merge / 0.75–0.90 LLM tiebreak / < 0.75 new**. Preferences reuse the BGE-M3 **vector index** directly (`vectorSearch('Preference')`, similarity = 1 − distance; skipped while the label is empty); Components are structural (no stored embedding, §18) so their cosine tier embeds BOTH sides at resolution time — the exact `component <name> (<type>)` text retrieval renders — against a token-overlap prefilter (cap 10) of the project's existing components. Same-session near-duplicates fold intra-batch (the survivor keeps max confidence; the duplicate writes nothing). The tiebreak asks the local LLM for `{"same": bool}` (schema-constrained; YES/NO scan fallback); an unavailable/unparseable tiebreak resolves 'new' with **confidence capped at 0.5** — persistent uncertainty routes to review instead of silently merging or duplicating. Corrections are per-session observations (deterministic ids, no cross-session dedup); named skills resolve to existing Skill nodes for `IMPROVED`. Tags resolve like ingestion (exact name, `tag-<slug>` creates); new Projects get their name tag + `TAGGED` (phase-07 symmetry) and an embedding of exactly `name — summary`.
- **`verify.ts`** — §17 step 4's independent reviewer. Items below the write gate go to the **cloud verifier only when the extractor was local** (a different model, §15's separate-critic principle); when the session escalated, "the step-2 cloud escalation doubles as this reviewer" — remaining low-confidence items are persistent uncertainty and go straight to review, same as when no cloud key exists. Each verdict is one metered call carrying the item + the transcript chunk it came from; replies parse to `confirm/reject + confidence` (rescued, tolerant); failures/budget halts mark items `unavailable` (→ staged, never committed).
- **`write.ts`** — §17 step 4's gated write. Per-item disposition: confidence ≥ 0.6 commits at the extractor's tier pass; verifier-confirmed ≥ 0.6 commits at the **verifier's** confidence as `llm-local+verified`; everything else stages. The WHOLE graph mutation is **ONE `withWrite` lane job** (§21 rule 1) of idempotent ops (upserts + MERGE edges), nodes before edges: Session (`tier: 'daily'`), MCP/Plugin creates, Project create w/ embedding, committed-needed Tags, then PRODUCED / USED / USES / TAGGED / HAS_COMPONENT / DEPENDS_ON (among committed session components) / EXTRACTED_FROM / APPLIES_TO (item tags + the project tag) / OBSERVED_IN / IMPROVED / DERIVED_FROM (preference→correction when the model's quote matches a committed correction). Provenance (§21 rule 4): `extracted_by = extraction@0.0.1/<pass>` + `confidence` on every provenance-bearing node (Component, Preference) **and every edge**; labels without provenance columns (Session, Project, MCP, Plugin, Correction, Tag — §18 schema) carry it on their extraction-written edges, the phase-07 convention. Staged items become `staged_writes` rows (kind `'extraction'`, `proposed_by extraction-agent:<sessionNodeId>`) with **deterministic ids + INSERT OR IGNORE** (a crash-resumed write step can't duplicate review rows) and a full payload: op create/merge, node props, edges, tag creates (staged-only tags are NOT created in the graph now — they ride the payload), provenance, evidence quote, human-readable reason. Merges write only the `EXTRACTED_FROM` evidence edge — an existing preference's statement/tags/embedding are never rewritten by a merge (recorded decision).
- **`agent.ts`** — workflow assembly, input validation, `runExtraction`/`resumeExtraction` (both return the job's `ExtractionResult` + jobId). A missing transcript file degrades to backbone-only extraction with a warning (§6: transcript is supplementary); a session with no mcp_calls AND no transcript fails `NOT_FOUND` ("nothing to extract"). `src/main/agents/index.ts` is the barrel; **no fenced SDK imports anywhere** (the agents zone falls under the strictest ESLint boundary — kernel/storage/model interfaces only).

### Boot wiring (`src/main/index.ts`)

`bootAgents()` after `bootMcp`: builds the cloud tier only when the active provider has a keychain API key (`createCloudBrain` + a `SpendMeter` over appdata.db), then `createExtractionAgent` over the shared engine/db/runner/OllamaClient singletons. Boot line: `[agents] extraction agent ready — runExtraction(sessionId) is manual until phase 11 (cloud tier: …)`.

### The load-bearing model finding: schema-constrained decoding

Probed live (this machine, qwen3:4b): with plain "reply ONLY with a JSON array" prompts the local model **narrates its reasoning through the entire `num_predict` budget** (`eval_count=800`, JSON never reached — phase-04 finding 8 reproduced exactly; its *reasoning* was correct, its output discipline wasn't). With Ollama **structured outputs** (`format` = JSON schema, `think:false`), the same prompt yields clean, *correct* items in ~156 tokens: both planted preferences extracted verbatim at 0.9. Phase-04 found `format:` vacuous for *summaries*; for extraction-shaped tasks it is the fix, not a failure. Changes: `OllamaClient.GenerateOptions` gained `format?: 'json' | JSONSchema` (additive to the phase-02 module), local fuzzy passes send per-pass schemas (`{"items": […]}` top-level object — the safest grammar shape), the tiebreak sends `{"same": boolean}`. The cloud tier gets no format param (provider-agnostic) and follows the prompt's shape; the parser accepts both.

### Config additions (rule-12 picks, recorded — §20 values untouched)

`EXTRACTION_PROVENANCE` = `extraction@0.0.1` (§18's `extraction@<version>/<pass>`; suffixes `deterministic | llm-local | llm-cloud | llm-local+verified`), `EXTRACTION_LOCAL_CHUNK_TOKENS` 2048, `EXTRACTION_CLOUD_CHUNK_TOKENS` 100_000, `EXTRACTION_PASS_MAX_TOKENS` 800, `EXTRACTION_MAX_ITEMS_PER_PASS` 20, `EXTRACTION_VERIFIER_MAX_TOKENS` 300, `EXTRACTION_TIEBREAK_MAX_TOKENS` 64. **The per-item write gate deliberately reuses `EXTRACTION_ESCALATE_CONFIDENCE` (0.6)** — §20 defines that figure as extraction's "low confidence" line; the gated write is that line applied per item (no second threshold invented).

### Tests — 48 new (370 total)

- **`tests/unit/agents.transcript.test.ts` (8)** — render + facts, malformed/unknown lines skipped (never crash), MCP/plugin/skill classification (incl. the OS's own server excluded), tool_result injection text provably absent from prompts, meta records, empty file, oversized args truncation, NOT_FOUND on missing files.
- **`tests/unit/agents.fuzzy.test.ts` (16)** — JSON rescue (narration, string-aware brackets, `{"items": …}` object-first), tolerant normalization (drop garbage/clamp/cap/borderline default), chunk packing + hard split, cross-chunk dedup w/ max-confidence, call-score accounting → `sessionConfidence`, gate A (cloud used, local never called; no-cloud warning path), gate B (escalate + replace; degrade on total cloud failure), tier `none`.
- **`tests/integration/agents.extraction.test.ts` (23 offline + 1 live)** — the DoD suite over the real engine + kernel stack (below), plus verifier confirm/reject, input validation, missing-transcript degradation.
- **`tests/fixtures/extraction-fakes.ts`** — `ScriptedExtractionLlm` (dispatches on the stable system-prompt markers), `FakeCloudBrain` (real `CloudBrain` interface, so `meteredComplete` + `SpendMeter` run for real), `FailingOnceEmbedder` (crash simulation), Claude Code JSONL record builders, `insertMcpCalls`.
- **`tests/fixtures/extraction-selftest.ts`** → `out/smoke/extraction-selftest.mjs` — the hand-run live demo (below).

## Definition of Done — outputs

### 1. Three golden fixture sessions → asserted nodes/edges incl. provenance

All three run against one real store + kernel stack (synthetic `mcp_calls` rows + JSONL transcript files):

- **`s1-feature` (local tier, everything commits):** Session node (`started_at`/`ended_at` = call-log window widened by transcript timestamps, `transcript_ref`, `tier: 'daily'`); `USED → deploy-web` **deduped** across a successful `get_skill` call and a transcript `Skill` invocation, while the *errored* `get_skill('ghost-skill')` creates nothing; `MCP {vercel}` + `Plugin {sentry}` created from `mcp__vercel__*` / `mcp__plugin_sentry_*` tool_uses with `USED` edges; Project **matched by cwd path identity** (`proj-<rootKey>`, seeded as phase-07 leaves it) + `PRODUCED` + `USES ×3` + `TAGGED` to its created name tag — every deterministic edge stamped `extraction@0.0.1/deterministic` confidence 1.0. Components `checkout page (page, 0.9)` / `payment service (service, 0.85)` with `extracted_by extraction@0.0.1/llm-local` on nodes AND on their `HAS_COMPONENT`/`EXTRACTED_FROM`/`DEPENDS_ON` edges; Preferences committed with **real (index-served) embeddings** — `vectorSearch('Preference')` returns them at distance < 0.001 — plus `APPLIES_TO` their extracted tags AND the project tag, and `EXTRACTED_FROM`; the explicit Correction with `OBSERVED_IN` (stamped; the Correction label itself carries no provenance columns per §18) + `IMPROVED → deploy-web` + **`DERIVED_FROM`** linking the preference that restates it. Zero staged rows; the whole mutation was **exactly ONE write-lane job** (lane-journal delta 1). **Idempotent re-run**: components merge by stable key (2 merged / 0 created), preferences merge at cosine 1.0, the correction upserts onto its deterministic id — node counts pinned unchanged.
- **`s2-greenfield` (cloud escalation by size, project created):** a 400-record transcript (> 60k est-tokens) with a local tier that THROWS on any extraction call — gate A provably bypasses it (`extractionCalls = 0`); the fake cloud brain (real `CloudBrain` interface) serves exactly 3 pass calls (one 100k-token chunk × 3). Project `nimbus-tracker` **created** from cwd: path-derived id, deterministic stub summary, embedding of `name — summary` served back by the Project HNSW index at distance < 0.001, `PRODUCED` + `TAGGED`. Items commit with `extracted_by extraction@0.0.1/llm-cloud` (component 0.95, preference 0.9 w/ `APPLIES_TO` auth + project tags); `USED → MCP github`. **Every cloud call metered**: 3 spend rows under the job's task id (provider/model/usd > 0). Runs FIRST in the file, which also exercises resolution's empty-Preference-index guard.
- **`s3-review` (low confidence, no cloud → staged_writes, not the graph):** see DoD 3.

### 2. Resolution: near-duplicate Preference merges; novel one creates

Seeded preferences at controlled bag-of-words distances; extracted statements hit every §20 band in one session (`s5-resolution`):

| extracted | vs seed | cosine | path | outcome |
|---|---|---|---|---|
| "Use pnpm for package installs." | `use pnpm for package installs` | 1.00 | ≥ 0.90 merge | **no new node**; `EXTRACTED_FROM` evidence edge on the seed (stamped llm-local/0.9); seed statement re-read verbatim (merges never rewrite) |
| "prefer tabs over spaces for readability" | `…for indentation` | ≈ 0.833 | tiebreak → **YES** | merged onto the seed |
| "never push directly to the staging branch" | `…production branch` | ≈ 0.857 | tiebreak → **NO** | new node beside the seed |
| "always write integration tests for parsers" | (everything) | < 0.75 | new | new node |

Exactly 2 tiebreak calls; result counts `preferences: 2, mergedPreferences: 2`; total Preference delta exactly +2.

### 3. Low-confidence path lands in `staged_writes`, not the graph

- **No cloud (`s3-review`):** three items at 0.2–0.4 → session confidence 0.3 → gate B fires but no cloud exists (warning recorded) → all three land as `staged_writes` rows (kind `extraction`, status `staged`, `proposed_by extraction-agent:session-s3-review`) with full payloads — op `create`, node props, planned edges (`EXTRACTED_FROM` / `APPLIES_TO` / `OBSERVED_IN`), provenance (`llm-local` + the low confidence), evidence quote, and a reason naming the 0.6 gate. The graph is provably untouched: no such Component/Preference/Correction nodes, and the staged-only `tag-style` was NOT created (its create rides the payload). The Session + deterministic edges still committed.
- **Verifier disagreement (`s4-verified`):** mixed confidences keep the session mean at ~0.73 (no escalation) while two items sit below the gate → exactly 2 metered verifier calls. The confirmed component **commits at the verifier's confidence** (0.85) as `extraction@0.0.1/llm-local+verified` (node + edges); the rejected preference stages with the disagreement recorded (`verifier rejected: …one-off instruction…`). The 0.9-confidence sibling committed straight through as `llm-local`.

### 4. Workflow resumes after a simulated crash between passes

`s6-crash`: an embedder that throws on its first call kills the run **inside `resolve`** — after `collect`/`deterministic`/`extract` checkpointed (the scripted LLM's 3 pass calls happened), before any write. Asserted: job `failed` (attempts 1), **graph completely untouched** (no Session node, no items, no staged rows — all writes live in the final step). A **fresh runner + fresh agent instance** over the same appdata.db (real re-instantiation) whose local LLM **throws on any extraction call** then `resumeExtraction(jobId)` → completes: job `done` (attempts 2), the preference committed with full provenance + `EXTRACTED_FROM` — and `extractionCalls = 0` on the resumed instance proves the fuzzy results came from the checkpoint, never a re-run.

### 5. Live self-test (real qwen3 + bge-m3, no cloud key)

`node out/smoke/extraction-selftest.mjs <scratch>` — synthetic session (2 mcp_calls + 4-record transcript) through the REAL local stack:

```
[selftest] extraction done in 22.0s — job 2828fab6-…
[selftest] tier=local escalated=false committed={"project":"created","usedSkills":1,"usedMcps":1,"usedPlugins":0,
           "components":1,"mergedComponents":0,"preferences":2,"mergedPreferences":0,"corrections":1}
[selftest] staged=0 warnings=0
[selftest]   (Session)-[:USED extraction@0.0.1/deterministic conf=1]-> (Skill s-deploy 'deploy-web')
[selftest]   (Session)-[:USED extraction@0.0.1/deterministic conf=1]-> (MCP mcp-vercel 'vercel')
[selftest]   (Session)-[:PRODUCED extraction@0.0.1/deterministic conf=1]-> (Project proj-ce9c6d84… 'shop-backend')
[selftest]   Component: 'payments webhook handler route' extraction@0.0.1/llm-local conf=0.9
[selftest]   Preference: 'Always use pnpm for installing packages in this repo' extraction@0.0.1/llm-local conf=0.9
[selftest]   Preference: 'Always load secrets from environment variables instead of config files' extraction@0.0.1/llm-local conf=0.9
[selftest]   Correction: 'Stop putting secrets in the config file — always load secrets from environment variables instead' (provenance on edges)
```

The OLLAMA=1 test-suite gate runs the same shape end to end and pins: workflow done, deterministic facts committed, and the session's clearly-stated content (pnpm / secrets) surfacing in the graph or the review queue.

### 6. Full verification (this machine)

```
npm run lint          clean
npm run typecheck     clean (tsconfig.node + tsconfig.web)
npm run build         clean (electron-vite production build)
npm test              Test Files 41 passed | 3 skipped (44) · Tests 360 passed | 9 skipped (369)
OLLAMA=1 RERANKER=1 npx vitest run --no-file-parallelism
                      Test Files 44 passed (44) · Tests 370 passed (370)   [263s, exit 0 — zero errors]
ELECTRON_RUN_AS_NODE=1 electron … vitest run tests/integration
                      Test Files 14 passed | 3 skipped (17) · Tests 138 passed | 9 skipped (147)
```

Run notes (reported honestly): the first full offline run lost one worker to the known ryugraph forks-pool teardown flake **after** its tests reported (zero test failures ever; the clean run above is the re-run, and phases 04–07 carry the same caveat). The live sequential run and the Electron-runtime run were clean on the first attempt. One REAL crash was found and fixed during this phase, distinct from the flake: closing a second ryugraph store mid-test-file segfaults the worker deterministically enough to matter (decision 14) — the suite now uses one store per file like every other suite.

## Key decisions & findings (read before later phases)

1. **Schema-constrained decoding is the local extraction fix** (probed live; see the finding section above). qwen3:4b narrates through its whole output budget on plain JSON-array prompts but fills a constrained schema with correct content directly (~5× fewer output tokens, correct items). `format` is now a first-class `OllamaClient.generate` option. Phase 12's skill-improvement prompts should reach for it whenever the reply is structured; free-prose tasks (summaries) still hit the phase-04 vacuity wall.
2. **The deterministic pass reads the transcript's record facts too** — mcp_calls alone cannot name external MCP servers/plugins (the OS logs only its own server) and carries no cwd. Tool_use names and cwd fields are facts of the record, not model output, so using them keeps §17's "no model, nothing to hallucinate" while §6's "which skills/MCPs/plugins fired" actually gets answered. Interpretation recorded per spec §0.
3. **Skills are matched, never created; MCPs/Plugins are MERGEd** (§18's wording). A `get_skill` that returned ok is proof the Skill node exists; a transcript-only skill name with no node is a client-local skill, and a name-only Skill shell would join `list_skills` and the phase-12 improvement loop with no content. MCP/Plugin are lightweight structural labels — creating them from observed usage is exactly their §18 role. The OS's own server never becomes an MCP node (it is the substrate, not a used tool).
4. **All graph writes in the final step, ONE lane job, idempotent ops** — this is what makes the crash-resume DoD trivial-by-construction: checkpoints carry pass outputs (embeddings included, plain JSON), `write` re-runs safely (upserts + MERGE edges), and staged rows use deterministic ids + `INSERT OR IGNORE` so review rows can't duplicate. Readers never see a half-extracted session.
5. **One 0.6 line, three §17 roles** — session escalation gate, per-item write gate, and verifier-agreement bar all use `EXTRACTION_ESCALATE_CONFIDENCE`. §20 defines 0.6 as extraction's low-confidence line; inventing a second threshold would have violated rule 12 for no modeling gain.
6. **Component cosine resolution embeds at resolution time** (both sides, the exact retrieval render `component <name> (<type>)`, token-overlap prefilter capped at 10) — the vector index only covers retrievable labels and §18 keeps Components embedding-free. §17's "reuses the BGE-M3 vector index" holds literally for Preferences.
7. **Tiebreak-unavailable ⇒ 'new' + confidence cap 0.5** — the §17 "persistent uncertainty → human review" path expressed in the §20 bands: the item stays below the write gate, so it stages instead of silently merging (which could corrupt an established node) or silently committing a near-duplicate.
8. **Merges add evidence, never content** — a graph merge writes only `EXTRACTED_FROM` (+ nothing else) onto the existing node; statements, tags and embeddings are not touched, and merged items never re-tag (a wrong tag would silently re-scope an established preference). Re-extraction of the same session converges to pure merges (pinned by the idempotency test).
9. **Cloud failures degrade, never crash the job**: escalation falling back to local results, verification marking items `unavailable` (→ staged), and budget halts stopping further verifier calls are all warnings + review-queue routing. §15's retry/backoff for genuinely failed background jobs stays with the phase-11 scheduler; a cloud outage should not zero out a session whose local extraction succeeded.
10. **Corrections carry no node provenance by schema** (§18: Correction has no `extracted_by` columns; `EXTRACTED_FROM` pairs don't include it) — their session lineage is `OBSERVED_IN` and every such edge is stamped. v1 scope held: the prompt forbids inferring corrections from edits/re-runs/silence, and only explicit statements survive normalization.
11. **`DERIVED_FROM` comes from the model's own quote** (`derived_from` field on preference items) matched against committed corrections' content/evidence by normalized containment — no inference layer. If the quote matches nothing committed, no edge; staged payloads carry their planned edges for the phase-10 committer instead.
12. **Preferences additionally `APPLIES_TO` the session's project tag** — §18 "tag everything" + the read path's tag→preference expansion; a session-stated preference is at minimum scoped to the project it was stated in. Retrievability doesn't depend on it (vector/FTS still match), it only adds an expansion path.
13. **The transcript is prompt DATA end to end** (§21 rule 5): tool_result bodies never render into prompts at all (the likeliest injection carrier), and everything extracted lands as inert node content behind the gate. Extraction can propose memory; it cannot trigger tools.
14. **Windows/ryugraph test discipline**: one store per test file, full `close()` only at file end — closing a store mid-file trips the 25.9.1 native teardown fault (reproduced; restructured so the greenfield golden shares the file's store and runs first). The live selftest uses the app quit path's `close({skipDatabaseClose: true})` for a clean exit code.

## Deferred / notes

- **Triggers** (SessionEnd hook endpoint, inactivity timeout, spool drain) — phase 11; `runExtraction(sessionId, {transcriptPath, cwd})` is the exact callable, and the hook payload (`session_id`, `transcript_path`, `cwd`) maps 1:1 onto its arguments.
- **Inferred corrections** (silent edits, re-runs) — explicitly out of scope for v1 (§17); the prompts forbid them.
- **staged_writes approval/commit flow** — phase 09/10 (§13 review queue). Payloads are self-contained: op, node props, edges, tag creates, provenance, evidence, reason; `embedOnCommit: true` marks new Preferences for embedding at approval time (statements are in the payload — embeddings are deliberately not staged).
- **CONNECTS_TO** stays unused (as in phase 07); the fuzzy prompt collects `depends_on` only.
- Cloud chunking merges per-chunk results for >100k-token sessions; no cross-chunk map-reduce synthesis (sessions that size are rare and dedup handles the overlap-free merge).
- `getApiKey` is read at boot; a key added later needs an app restart to arm the extraction cloud tier (phase-10 settings UI can re-boot agents).
- The workflow keeps the rendered transcript in checkpointed state (up to a few hundred KB for huge sessions) — SQLite blobs handle it; revisit only if phase 11 batches many concurrent extractions.

## Instructions for phase 09 (security & sandbox)

- The kernel permission stub now has a real caller worth gating: every extraction step runs `kernel.execute('extraction-agent', {kind: 'workflow-step', …})` — the §13 capability engine can scope `extraction-agent` (graph write via lane, appdata read/write, model calls; no fs/network beyond Ollama/cloud) without touching agent code.
- `staged_writes` now receives rows from TWO proposers (`claude-mcp:<session>` via propose_correction, `extraction-agent:<sessionNode>` with kind `'extraction'`) — the §13 validation/commit flow must handle both payload shapes; extraction payloads carry `op`, planned `edges`, `tagCreates`, and `embedOnCommit` (call the shared OllamaClient at commit).
- The audit-log stub records every extraction action already (kernel events); the real reversible-delta log replaces it seamlessly — extraction's lane job is the natural undo unit, and §18's undo-by-source works today: `MATCH (n)-[:EXTRACTED_FROM]->(:Session {id: $sid}) DETACH DELETE n` plus the session's staged rows.
- Model plumbing: `OllamaClient.generate` now supports `format` (structured outputs) — use it for any structured judge/validator you add.
- Test rigs to reuse: `extraction-fakes.ts` (scripted LLM by system-marker, real-interface fake cloud brain, JSONL builders, `insertMcpCalls`), `agents.extraction.test.ts` (full-stack agent-run asserts incl. lane deltas and staged-row payload checks), `extraction-selftest.ts` (live-evidence script pattern).
