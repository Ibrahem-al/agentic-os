# Phase 12 report — Skill-improvement agent + eval harness

**Status:** done · **Date:** 2026-07-05

## What was built

`src/main/agents/skills/` (9 modules) + the §13 staged-writes third kind + appdata v6 + dashboard surfaces — §17 agent #4 end to end: nightly, event-gated self-improvement with a no-regression adoption gate, versioning, rollback and the §20 drift watch. The vendored skill-creator reference (`docs/reference/skill-creator/`) was read in full first; its SKILL.md format rules, grader/comparator prompts and train/held-out methodology are **reimplemented, never guessed**.

### The workflow (`agent.ts`) — a Phase-04 workflow, five checkpointed steps

```
plan → testset → candidate → benchmark → write
```

Registered as `'skill-improvement'` on the kernel runner (agent id `skill-improvement-agent`, registered in `registerInternalAgents` with the extraction-style write+spend grants — its writes carry their own §13 machinery: the adoption gate, review-queue staging, audited reversible flips). Every step checkpoints (durability `'sync'`); ALL graph/ledger/staging writes live in the final `write` step. The step order is deliberate: the CLOUD spends (test synthesis, rewrite) checkpoint **before** the local-heavy benchmark, so a crash inside `benchmark` or `write` never re-buys a cloud call — pinned by the crash-resume DoD test (resume on a fresh instance with a DEAD cloud brain and DEAD executor completes the adoption with **zero** cloud calls and **zero** re-generations).

Entry points: `runImprovement({skillId?, jobId?})` (no skillId = the nightly event gate; skillId = the §17 manual "improve this skill now") and `resumeImprovement(jobId)`. `handler.ts` registers the queue handler for kind `'skill-improvement'` — the phase-11 02:00 slot's no-op stub in `triggers/jobs.ts` is **deleted**; the slot now runs the real agent, and retries RESUME the deterministic `<taskId>-wf` workflow job (the phase-11 extraction-handler pattern). `enqueueManualImprovement()` backs the dashboard's "improve now" button with full queue durability.

### `gate.ts` — the event gate + drift scan (plan step, read-only)

- **Nightly:** only skills with new `Correction`s (`IMPROVED` edge) or failure `Example`s created **after** the skill's `last_run_at` cursor. Quiet skills are silently gated out; the task row honestly notes "nothing to do".
- **Manual:** bypasses the new-since-last-run filter but still requires SOME signal ever ("improve now" with nothing to improve from completes with a note).
- Skills with an undecided `skill-improvement` staged row are skipped (`skipped-pending-review`) — candidates never pile up behind an unreviewed one.
- Per-run cap (`SKILL_IMPROVEMENT_MAX_PER_RUN` = 5, rule 12): overflow skills defer with their signal **kept** (the cursor only advances for processed skills), so the next night continues where this one stopped.
- Baseline instructions = the active `SkillVersion`'s body when one exists (get_skill semantics), else `Skill.instructions`.
- **Drift scan (§20, nightly only):** for every open ledger watch, uses = `Session-USED->Skill` edge timestamps after `adopted_at` (first 20), corrections = `Correction.created_at` in that window; predecessor rate = its own tenure (previous adoption → this adoption, or the predecessor version's creation). Worse-than-predecessor → finding `worse`; 20 uses survived → `cleared` (watch closes). Detection is pure graph reads — it needs no model and no cloud.

### `testset.ts` — §17 step 1

- **Corrections → regression cases, deterministically** (id-linked, most recent first, capped at 8): a neutral execution prompt ("walk through exactly how you carry the task out…") + the expectation carrying the correction verbatim. The prompt deliberately does NOT quote the correction — that would hand the answer to both configurations and flatten the delta; the graded expectation holds it instead.
- **Synthetic padding = the cloud brain** (exactly the build item's parenthetical): ONE metered call designs `SKILL_SYNTHETIC_CASES` (3) coverage cases as JSON (`{prompt, expectations[]}`), rescued tolerantly (string-aware bracket scan, malformed items dropped, capped). Cloud failure → warning, benchmark proceeds on correction cases alone.
- **Split (skill-creator `run_loop.py` semantics, reimplemented):** stratified per source group, Fisher-Yates with a PRNG seeded from the skill id (stable across runs/resumes), held-out = `max(1, floor(len × 0.4))` per non-empty group. The rewriter sees corrections and failure examples, **never the cases** — held-out stays unseen, which is what makes "score by held-out" mean something.

### `candidate.ts` — §17 step 2

The cloud brain rewrites the skill into a complete SKILL.md (system prompt reimplements the skill-creator improvement guidance: generalize from feedback instead of overfitting, keep the prompt lean, explain the why, imperative form). The reply is fence/preamble-rescued, validated against the reference's frontmatter rules, must keep `name:` exactly, and must actually differ from the baseline; one retry carries the exact validation error. Failures degrade to a per-skill `failed-candidate` outcome (signal kept) — never a crashed job. Candidate identity is content-derived (`sv-<skillId>-<sha8(instructions)>`), so a crash-resumed write step upserts instead of duplicating and identical content = identical version.

### `benchmark.ts` — §17 step 3, the eval harness

Candidate vs active over the whole test set, `SKILL_BENCHMARK_RUNS` (3, the reference's `runs_per_configuration`) runs per case per configuration. Executions run on the **local tier** (§7 budget rule — the cloud is spent on rewriting and judging, not on generating dozens of case outputs).

- **Verifiable → assertion grader**, adapted from `agents/grader.md`: PASS only on clear, citable evidence of genuine compliance; when uncertain the burden of proof is on the expectation; superficial/coincidental compliance fails; no partial credit. Runs locally with a **schema-constrained** `{passed, evidence}` verdict (the phase-08 structured-outputs finding), a prompt/rubric separate from the executor (§15's own "local-model critic against a rubric" shape). Unparseable verdict ⇒ FAIL (fail-safe). The grader grades BOTH configurations symmetrically, so grader bias cancels in the delta the gate reads.
- **Stylistic → blind A/B comparator**, adapted from `agents/comparator.md`: content (correctness/completeness/accuracy) + structure (organization/formatting/usability) rubric, expectations as secondary evidence, decisive (ties rare). Judged by the **cloud tier** — §17 mandates a different model/tier from the (local) executor. The A/B assignment alternates per (case, run) parity so neither side owns a label; verdicts map back through the blinding. Judge failures mark comparisons `unavailable` and stop spending.
- **Scores:** held-out mean pass rate per configuration (verifiable) / held-out win-loss-tie tallies (stylistic); train scores recorded as diagnostics only.
- **Regressions:** a correction case (either split) the active majority-passes and the candidate majority-fails, strict majority of runs. **Net-positive:** strictly greater held-out score (wins > losses for stylistic).

### `lifecycle.ts` + the `'skill-improvement'` staged kind — §17 step 4 / §18 write path

Adoption mechanics, all audited (§21 rules 1/4/11), each an undo unit of its own:

- `recordCandidateVersion` — SkillVersion upsert + `HAS_VERSION` stamped `skill-improvement@0.0.1` + confidence = the candidate's score (Skill/SkillVersion carry no provenance columns per §18 — the edge carries it, the phase-07/08 convention).
- `adoptSkillVersion` — THE flip: candidate→active, prior active(s)→retired, and the Skill node takes the candidate's instructions + `current_version` + a fresh embedding of exactly the retrieval render (`name: instructions`) — retrieval and get_skill serve the adopted version immediately (pinned: the real HNSW index returns the re-embedded skill at distance < 0.001). Idempotent retry-safe (an already-landed flip reports `alreadyAdopted`).
- `rollbackSkillAdoption` — DoD 3: the standing adoption's candidate retires, the predecessor version (or, for first adoptions, the ledger's instructions snapshot) returns, the Skill re-embeds. Ledger marks `rolled_back_at`; the rollback chain continues from the previous adoption.
- **Adoption gate (verifiable):** net-positive AND zero regression → record + adopt in the same write step (two audit actions — undoing/rolling back an adoption keeps the candidate as history: "versions retained for rollback"). Fail → the candidate is recorded `status='retired'` with its benchmark score (honest history within the spec's three statuses) + ledger `rejected` naming the broken corrections.
- **Stylistic:** candidate recorded `status='candidate'` + a `staged_writes` row (kind `'skill-improvement'`, deterministic `sw-skill-<versionId>` id, INSERT OR IGNORE) carrying the full payload (both instruction texts, benchmark summary, predecessor) — **never auto-adopted**. `stagedWrites.ts` gained the third kind: the diff renderer shows the adoption header, A/B tallies and an LCS line diff of the instructions; **approve** = `commitSkillImprovementApproval` (the audited flip + ledger decision, `COMMIT_FAILED`-retryable when Ollama is down for the re-embed); **reject** = `rejectStagedWriteWithEffects` — the row flips AND the recorded candidate retires (audited) so no orphaned `candidate` version lingers. That reject touching the graph is a **recorded deviation** from the other kinds' "rejection touches nothing": this kind's candidate was already a first-class graph record before review. Correction/extraction rejections keep the old row-only behavior verbatim.
- **Drift application (write step):** `worse` → ledger flag (+details); auto-revert **only** when the per-skill setting asks (default off, §20) and only when the flagged adoption is still the standing one — a resumed write step or a raced operator rollback can never revert the wrong version. `cleared` → the watch closes.

### `skillmd.ts` — the SKILL.md format (reference-reimplemented)

`parse/validate` per `utils.py` + `quick_validate.py`: frontmatter fences, allowed keys {name, description, license, allowed-tools, metadata, compatibility} (indented nested lines are not top-level keys), kebab-case name ≤64 without edge/double hyphens, description ≤1024 with no angle brackets, compatibility ≤500, multiline `>|>-|-` description indicators. **Persistence contract:** a skill's `instructions` property stores the FULL SKILL.md text verbatim — `exportSkillMdFile` writes `<dir>/<name>/SKILL.md` byte-equal to the stored instructions and `importSkillMdFile` reads it back byte-equal (DoD 4), so skills stay portable to/from Claude Code. Legacy plain-text instructions wrap once with synthesized rule-clean frontmatter (name kebab-cased, description = first line sanitized) on their first candidate.

### `state.ts` + appdata v6

Two new tables (additive guarded upgrade v5→v6, refuses newer versions as always):

- `skill_settings` — the §17 per-skill adoption mode (`'verifiable'` may auto-adopt; **`'stylistic'` is the default** — nothing auto-adopts until the user opts a skill in), the §20 auto-revert toggle (default off) and the event-gate cursor (`last_run_at`).
- `skill_improvements` — the ledger: one row per candidate attempt (id = candidate version id → crash-safe upsert) with benchmark JSON, outcome (`adopted|rejected|staged` + qualifying timestamps), the predecessor version id AND instructions snapshot (what rollback restores), job id, and the drift columns (`drift_flagged_at/drift_json/drift_resolved_at/rolled_back_at`).

### Boot, IPC, dashboard

- `bootAgents` builds the agent beside extraction (audit is a hard dependency — every flip is a reversible delta); `bootTriggers` registers the queue handler; new boot line: `[agents] skill-improvement agent ready — 02:00 slot + "improve now" drive it (cloud tier: …)`. Quit path clears the singleton.
- Four new typed channels (§21 rule 8, the one channel map): `skills.improvement` (settings + ledger + canRollback), `skills.improvementSettings`, `skills.improveNow` (→ `enqueueManualImprovement`), `skills.rollback`. `review.staged.reject` upgraded to the kind-aware `rejectStagedWriteWithEffects`. `SkillImprovementError` codes map into the existing `IpcErrorCode` union.
- SkillsPanel: an "improvement" section in the detail inspector — adoption-mode select, drift-mode select, "improve now", rollback (disabled without a standing adoption), the last-run cursor, and the ledger with outcome/drift-flagged/rolled-back badges (three new statusColor entries; the ReviewPanel renders the new kind through the existing diff modal untouched).

### Config (rule-12 picks, recorded)

`SKILL_IMPROVEMENT_PROVENANCE` `skill-improvement@0.0.1`; synthetic cases 3 ("a few"); correction-case cap 8; benchmark runs 3 and held-out fraction 0.4 (both from the vendored reference); per-run skill cap 5; output caps (case-gen 2000 / rewrite 4096 / execution 600 / grader 200 / comparator 400); `TASK_PRIORITY.skillImprove` 10 (user-initiated, routine tier). §20 values (02:00 slot, drift 20 uses, auto-revert off, $0.50 ceiling) untouched.

## Definition of Done — outputs

All four DoD items run in `tests/integration/agents.skillimprove.test.ts` over ONE real RyuGraph store + kernel stack + REAL AuditLog (scripted local LLM whose executor/grader are pure functions; fake cloud brain on the real `CloudBrain` interface so `meteredComplete` + `SpendMeter` run for real).

### 1. Synthetic skill with seeded corrections — adopted only on net-positive + no regression (both outcomes)

- **Adopt (`sa`, nightly run):** legacy plain-text skill + 2 corrections + a failure example, mode `verifiable`. The event gate selects it; cloud designs 1 synthetic case + rewrites; benchmark: active fails everything, candidate passes everything → net-positive (1.00 vs 0.00 held-out), zero regressions → **adopted**: candidate `active` / v0 `retired`, `Skill.current_version` + instructions byte-equal the candidate SKILL.md, `HAS_VERSION` stamped `skill-improvement@0.0.1` confidence 1, the re-embedded skill served by the real vector index at distance < 0.001, ledger `adopted` with predecessor id + instructions snapshot, `last_run_at` advanced, exactly 2 §14 spend rows under the job id, and TWO audited reversible actions (record + adopt).
- **Reject (`sb`, regression):** v0 already complies with corr-b1 ("previously fixed"); the candidate fixes corr-b2 but drops corr-b1 → the harness reports 1 regression naming `corr-b1` → **not adopted**: active version and skill untouched, the candidate recorded `retired` with its score, ledger `rejected`, `summary.regressions` length 1. (Net-positive strictness — a held-out TIE rejects — is pinned in the unit suite.)

### 2. Stylistic path lands in the review queue, not auto-adopted

`sc` (default settings — pins that `stylistic` IS the default): candidate recorded `status='candidate'`, the blind comparator judged 6 held-out comparisons (2 cases × 3 runs; the scripted judge sees only outputs), and a `staged_writes` row (kind `skill-improvement`) carries the full payload — while `Skill.instructions`/`current_version` are PROVABLY unchanged. The rendered diff shows `ADOPT SkillVersion …`, `candidate wins 6, active wins 0, ties 0` and the `+/-` instruction lines. **Approve** → the audited flip (first adoption: no predecessor to retire), ledger `adopted`. **Reject** (`sd`) → row `rejected` + the candidate retired (audited), skill untouched, ledger `rejected`.

### 3. Rollback restores the prior version; drift flag fires on a seeded regression stream

- **Rollback:** after sa's second adoption (the new-correction re-gate test), `rollbackSkillAdoption` retires candidate-2, re-activates candidate-1 and restores `Skill.instructions` **byte-for-byte** from the ledger snapshot; the first adoption remains the next standing rollback target. First-adoption rollback (no predecessor version node) restores the pre-version plain instructions (`sc`).
- **Drift:** three skills adopted with a 0.5-corrections-per-use predecessor tenure. `sf`: 3 post-adoption uses drawing 3 corrections (rate 1.0 > 0.5) → nightly run **flags** (`drift_flagged_at` + rates in `drift_json`) and the version STAYS active (§20 default). `sg`: same stream with `auto_revert` on → **auto-reverted** (predecessor active again, ledger `rolled_back_at`). `sh`: 20 clean uses → watch **cleared** (`drift_resolved_at`), version stays. Same run pins that drift detection needs no cloud and that no-cloud skips keep the event-gate cursor (signal preserved).

### 4. Skill round-trips losslessly to a SKILL.md file on disk

The adopted skill's stored instructions → `exportSkillMdFile` → disk bytes identical → `importSkillMdFile` → identical again (integration, on the really-adopted skill). Unit suite additionally pins the legacy wrap (body preserved verbatim, canonical form byte-stable on re-export) and every reference format rule.

Plus: crash mid-write (embedder dies during the adoption re-embed) → job `failed` with the candidate recorded but nothing adopted and no ledger row → resume on a FRESH instance with a dead cloud + dead executor completes the adoption with **0 cloud calls, 0 re-generations**; the queue handler runs nightly ("nothing to do" note) and manual tasks end to end with the deterministic `-wf` workflow job rows; the 02:00 slot on a launch without the agent parks `deferred` (updated jobs test).

### Verification (this machine)

```
npm run lint          clean
npm run typecheck     clean (tsconfig.node + tsconfig.web)
npm run build         clean (electron-vite production build)
npm test              Test Files 61 passed | 3 skipped (64) · Tests 562 passed | 11 skipped (573)  [exit 0, zero errors]
                      (562 = phase-11's 514 + 48 new)
OLLAMA=1 RERANKER=1 npx vitest run --no-file-parallelism
                      Test Files 64 passed (64) · Tests 573 passed (573)  [547s, exit 0, zero errors —
                      every OLLAMA/RERANKER gate ran live, incl. the new skill-benchmark gate]
ELECTRON_RUN_AS_NODE  Test Files 23 passed | 3 skipped (26) · Tests 214 passed | 11 skipped (225)  [exit 0]
  (tests/integration under Electron runtime)
npm run test:e2e      3 passed, 1 env-gated skip [exit 0] — audit 1.1s, ingest 23.2s (real bge-m3),
                      review 1.1s (production build boots the FULL runtime incl. the new agent + handler)
boot smoke            node out/smoke/boot-smoke.mjs [exit 0] — all subsystem lines incl. the NEW
                      "[agents] skill-improvement agent ready — 02:00 slot + \"improve now\" drive it";
                      seeded spool file drained and extracted during the smoke
live gate             OLLAMA=1 on the DoD file: 16/16 incl. "live benchmark (real qwen3 executor +
                      schema-constrained grader)" — candidate vs active generated and graded on the
                      real local tier in 126.6s, scores sane and correctly ordered
```

Phase-12 suites in isolation: **48 tests in ~21 s** (skillmd 17, harness 14, integration 15 offline + 1 live), plus the updated appdata (v6) and triggers.jobs (deferred-slot) tests.

Run notes (reported honestly): mid-verification, `npm test` runs intermittently lost 1 test (the phase-03 `retrieval.latency` p50<500ms benchmark at 500–566 ms) and workers died at forks teardown far more often than prior phases. Root cause found: **two orphaned vitest worker processes survived a killed background run** and competed with every subsequent suite. After killing them, both the offline and the live sequential runs above completed **exit 0 with zero errors** on the first try — the elevated flake rate this session was self-inflicted contention, not phase-12 code (the latency test passes in isolation and in both final runs; no phase-12 test ever failed after the barrel-export fix below).

## Key decisions & findings (read before phase 13)

1. **Skill instructions persist as full SKILL.md text.** The phase doc's "skills persist in SKILL.md format" is taken literally: `Skill.instructions`/`SkillVersion.instructions` store the whole file, making the DoD-4 round-trip byte-lossless by construction and keeping FTS/embeddings over the real served content. Legacy plain instructions wrap once (validated frontmatter synthesized) when their first candidate is generated.
2. **Correction→case mapping is deterministic; only the synthetic padding is cloud.** The build item attaches "(cloud brain)" to the padding alone. Deterministic template cases keep the regression gate available even when the cloud is down, keep correction ids attached for the zero-regression check, and cannot be gamed by the model that also writes the candidate. The neutral execution prompt (correction only in the graded expectation) is what preserves the candidate-vs-active delta.
3. **Executor local, grader local (separate prompt/rubric), comparator cloud.** §17 mandates a different model/tier only for the stylistic judge; the verifiable grader follows §15's own example shape ("a local-model critic against a rubric") and grades both configurations symmetrically, so its biases cancel in the delta the gate reads. The §7 budget rule keeps the 60+ per-skill executions off the meter.
4. **One benchmark, two gates:** net-positive = STRICTLY greater held-out score; zero regression = no correction case (either split) where active majority-passes and candidate majority-fails, strict majority over 3 runs. Regression evidence names the correction ids in the ledger + task note.
5. **Rejected verifiable candidates are recorded as `status='retired'` with their score** — honest history within the spec's three statuses (§18), visible in the skills panel. The two-audit-action adopt (record, then flip) keeps rollback/undo scoped to the adoption alone, preserving the candidate as history.
6. **Stylistic reject touches the graph (recorded deviation):** the candidate is a first-class graph record before review, so rejection retires it (audited) instead of leaving an orphaned `candidate`. Correction/extraction rejections remain row-only; their phase-09 tests still pass byte-identical.
7. **`stylistic` is the default adoption mode** (rule 12): nothing auto-adopts until the user flips a skill to `verifiable` — the conservative reading of §17's "Set per-skill".
8. **The ledger (`skill_improvements`) is operational state, not ontology.** The graph keeps §18 exactly; adopted_at/predecessor-snapshot/drift columns live in appdata like tasks/spend do. The predecessor **instructions snapshot** is what makes rollback work for first adoptions (no predecessor version node exists) and immune to later version edits.
9. **Drift auto-revert is resume-safe:** the write step re-checks that the flagged adoption is still the standing one before reverting — a crash-resumed run (or a raced operator rollback) can only flag, never roll back the wrong version. Watches close (`drift_resolved_at`) after 20 clean uses, so old adoptions don't get re-scanned forever.
10. **Signal is consumed only by a completed pass.** `last_run_at` advances per skill on adopted/rejected/staged; `failed-*`/`skipped-no-cloud`/deferred keep the corrections "new" for the next run. A permanently failing rewrite therefore retries nightly at ≤ the $0.50 per-task ceiling — accepted v1 behavior, noted for phase-13 hardening (a per-skill failure backoff would bound it).
11. **The dashboard-undo caveat:** audit-undoing an *adoption* action from the audit panel reverses the graph but not the ledger row (it still reads `adopted`). `rollbackSkillAdoption` (the skills-panel button / auto-revert / drift path) is the sanctioned rollback — it keeps both in sync. Recorded rather than blocked: the audit trail's generic undo stays fully honest about the graph.
12. **§6's "example accumulation" (nightly item 1) has no builder in any phase doc** — extraction (phase 08) deliberately writes no `Example` nodes and this phase's build list starts at the event gate. The gate honors failure Examples whenever something creates them (seeds, future phases); recorded as a spec-vs-phases gap rather than silently building unlisted scope.
13. **A missing barrel export is invisible to `tsc` until a consumer exists** — the fixture imported `CASE_GEN_SYSTEM_MARKER` before it was exported; vitest's esbuild transform yielded `undefined` at runtime (typecheck had passed before the fixture existed). Caught by the DoD suite's spend-count assertion; fixed by exporting the marker + prompt builder.

## Deferred / notes

- **Per-skill failure backoff** for permanently failing rewrites (decision 10) — phase-13 hardening candidate.
- **Ledger sync on audit-panel undo of adoptions** (decision 11) — phase-13 candidate if operators actually use that path.
- **Failure-example accumulation** (§6 item 1, decision 12) — unowned by the phase plan; the gate and rewrite prompt already consume failure Examples when present.
- The improvement ledger + settings are dashboard-editable via the skills panel only; no MCP surface (the §12 tool list is fixed).
- Benchmark outputs are checkpointed in workflow state (KBs per skill; the same SQLite-blob reasoning as phase 08's transcripts).

## Instructions for phase 13 (hardening & release)

- The 02:00 slot now does real work: quiet nights complete with "no skills accrued new corrections or failure examples — nothing to do"; watch task-row retention (phase-11 note) since improvement runs add rows nightly.
- `skills.rollback` / `review.staged.reject` are the operator paths that keep ledger + graph in sync; the audit panel's generic undo of adoption actions is graph-only (decision 11).
- Drift flags surface in the skills panel per-skill; a rail-level "drift flagged" badge would be a cheap visibility win.
- Test rigs to reuse: `tests/fixtures/skill-fakes.ts` (ScriptedSkillLlm dispatching on the executor/grader markers, FakeSkillCloudBrain keyed by frontmatter name with a blind-judge callback, `skillMdOf`), and the integration file's `seedSkill`/`seedUse`/`driftSkill` helpers for any release-smoke over skill improvement.
