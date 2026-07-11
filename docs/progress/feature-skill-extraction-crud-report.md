# Feature report — project skill extraction + full graph/KB CRUD + memory dedupe + approvals readability

**Row 24 in `docs/PROGRESS.md`.** User-directed work extending the spec (recorded per §21 rule 12).
Two source briefs drove it: `feature-brief-skills-crud.md` (features A + B) and `readability-addendum.md`
(the R-series human-readable approvals/graph + dedupe UI). Built as six implementation stages, each
verified green by its builder; this report is the end-of-feature consolidation, gates, and handoff.

Prime directive held throughout: **DEFAULT == TODAY** — with none of the new surfaces exercised, every
existing flow is byte-identical (proven by the 993 pre-existing + new tests staying green and the four
dashboard e2e specs passing). Two hard invariants preserved: **§21.6** (Claude's only write path stays
`propose_correction` → staged → validated — CRUD is human-only over IPC, never MCP) and **§21.4/§21.11**
(every extraction write stamped with provenance; every user mutation rides `audit.graphWrite` → visible
and undoable from History).

---

## What was built, by stage

### Stage 1 — structured graph deletes + fully restorable undo (backend foundation)
Files: `src/main/storage/engine.ts`, `src/main/storage/ryugraph.ts`, `src/main/security/audit.ts`,
`tests/integration/security.audit.delete.test.ts`.
- `WriteTx` + `StorageEngine` gained `deleteNode(label, id)` (DETACH-DELETE semantics; engine-internal
  cypher, does **not** count as caller `rawMutations`, so a delete inside `audit.graphWrite` stays
  `reversible: true`) and `deleteEdge(type, from, to)`.
- Audit recording tx captures a **full pre-image** before deleting — all node props *including the
  embedding* + every incident edge (type, other endpoint, props) — and emits two new `GraphInverseOp`
  variants **`restore-node`** and **`restore-edge`**, ordered so undo replays the node before its edges.
  Appliers added to `undoGraph`. `undoGraph` itself was switched to structured deletes (see the ryugraph
  defect below).
- **ryugraph 25.9.1 defect found + worked around** (`ryugraph.ts` `deleteNodeInLane` /
  `rebuildEmptiedVectorIndex`): once a label's HNSW vector index is *fully emptied* by deletes it enters
  a degenerate state — a later insert is never served by `QUERY_VECTOR_INDEX` (returns zero rows;
  probe-verified, same vector-extension fragility phase-13 hardened `rebuildEmbedding` against). The
  engine now detects a delete that empties a retrievable label and does a `DROP_VECTOR_INDEX` +
  `CREATE_VECTOR_INDEX`, registered in `vectorRebuilds` so concurrent searches await it. Fires at most
  once per label (the emptying delete); non-empty deletes maintain correctly, so bulk cascades stay cheap.

### Stage 2 — feature B backend: `memory.*` user-CRUD channels (IPC only, never MCP)
Files: `src/main/memory/edit.ts` (new), `src/main/memory/index.ts` (new barrel), `src/shared/ipc.ts`,
`src/main/ipc.ts`, `tests/integration/memory.edit.test.ts`. Actor `user:dashboard`; every mutation rides
`audit.graphWrite` → History-visible + undoable; every response carries `auditActionId` (toast "Undo").
- `memory.node.create { label, props }` / `memory.node.update { label, id, props }` — pre-lane
  validation: label ∈ schema labels; props ⊆ `writableNodeProperties(label)`; **`PROTECTED_NODE_KEYS`**
  (`id`, `created_at`, `updated_at`, `embedding`, `extracted_by`, `confidence`) rejected from the client
  with `INVALID_INPUT` listing offenders; server generates `usr-<label8>-<hash8>` ids. Retrievable labels
  (Project/Skill/Preference/Knowledge) compute the embedding **pre-lane** via the Ollama embedder — if the
  embedder is down, fail with code **`OLLAMA_ERROR`** and a plain message, writing **nothing**. Creating a
  Skill also creates its active `SkillVersion` (delegates to the Stage-3 `importSkill` committer).
- `memory.node.delete { label, id }` — structured cascade via Stage-1 deletes: Document also deletes its
  `HAS_CHUNK` Knowledge chunks; Skill also deletes its `HAS_VERSION` SkillVersions. Returns
  `{ auditActionId, deleted: { nodes, edges } }` counts.
- `memory.edge.create` / `memory.edge.delete { type, from:{label,id}, to:{label,id} }` — validate type ∈
  schema edge types and endpoint labels against §18 allowed pairs, exposed to the renderer through new
  **renderer-safe `IPC_EDGE_TYPES` / `IPC_EDGE_PAIRS`** in `src/shared/ipc.ts` (a drift test pins them to
  the main-side schema). User edges carry **no** props — provenance keys are for extraction only
  (recorded decision); the audit row records the actor.

### Stage 3 — feature A backend: project skill extraction in codebase ingest
Files: `src/main/ingest/skills.ts` (new), `src/main/ingest/codebase.ts`,
`src/main/agents/skills/lifecycle.ts` (new `importSkill`), `src/main/security/stagedWrites.ts` (new
kind), `src/main/config.ts`, `src/shared/ipc.ts`, `src/main/ipc.ts`, `src/main/mcp/tools/control.ts`,
`tests/integration/ingest.skills.test.ts`. **One shared service serves both** the dashboard
`ingest.codebase` IPC path and the MCP `ingest_codebase` tool (both call `ingestCodebase()`).
- **Discovery** (`discoverProjectSkills`): deterministic artifacts — `**/skills/*/SKILL.md` (anywhere) +
  `.claude/skills/*/SKILL.md` + `.claude/commands/*.md` (name `cmd-<file>`). The codebase walker prunes
  dot-dirs, so `.claude/*` is read via **targeted root reads** rather than the walked list (recorded
  deviation). Invalid frontmatter → counted as skipped, never throws.
- **LLM proposals** — up to **3** procedural skills over README + top-level docs, via the new router role
  **`ingest.skillProposal`** (added to `ROLE_DEFAULTS`, default local like `ingest.projectSummary`,
  schema-constrained). Graceful skip when no model is available — **ingestion never fails** for this pass.
- **Stage, don't write**: each candidate is injection-scanned (flags ride `injection_flags` + payload
  warning), then written as a `staged_writes` row of new kind **`skill-import`**, payload
  `{ name, instructions, source, projectId, contentHash, proposal }`, `mode: create | revision`.
  sha256 content-hash dedup (identical staged/committed import → skip); name matches an existing Skill →
  staged as `revision`. **Revisions NEVER auto-adopt.**
- **Approve** (`stagedWrites.ts` → new **`importSkill(deps, payload)`** in lifecycle.ts): the single Skill
  committer — one audited lane job creating `Skill` (`skl-<slug8>-<hash8>`, commit-time embedding via
  `skillEmbedText` ⇒ `requiresEmbedder: true`, reusing the P1.7 pattern) + active `SkillVersion` +
  `HAS_VERSION` + the Project `USES` link. Provenance is **edges-only** (schema has no Skill-node
  provenance columns, §18): `extracted_by = 'project-skill-extraction@0.0.1'` (new constant
  `PROJECT_SKILL_EXTRACTION_PROVENANCE`), **confidence 1.0 for artifacts, 0.6 for LLM proposals**
  (no §20 value — recorded rule-12 pick). Revision mode → `recordCandidateVersion` (candidate status).
  `importSkill` is also the committer reused by `memory.node.create` for a Skill.
- **Results + progress**: `IngestCodebaseResultDto.skills = { discovered, staged, revisions,
  skippedExisting, proposalsSkipped }`, threaded through both handlers; `'skills'` added to the
  `IngestProgressEventDto` phase union.

### Stage 4 — memory dedupe (backend) + the MCP dedupe tools
Files: `src/main/memory/dedupe.ts` (new), `src/main/memory/index.ts`, `src/shared/ipc.ts`,
`src/main/ipc.ts`, `src/main/mcp/tools/read.ts`, `src/main/mcp/tools/write.ts`,
`src/main/security/permissions.ts`, `src/main/config.ts`, `tests/integration/memory.dedupe.test.ts`.
- `scanDuplicates` — exact (normalized-text/name equality) + near (embedding cosine ≥
  **`DEDUPE_SIMILARITY_DEFAULT` 0.95**, per-label cap **`DEDUPE_SCAN_PER_LABEL_CAP` 2000`**, own-label
  vector probe **`DEDUPE_NEAR_NEIGHBOR_K` 10`**). Suggested keeper = most-connected, tie → newest
  (§21 rule 12). Truncated flag when a label exceeds the cap. All three constants are conservative rule-12
  picks (0.95 is deliberately above the extraction-time `ENTITY_MERGE_COSINE` 0.9 — a false near-merge
  silently loses a distinct memory).
- `mergeDuplicates` — **Preference/Knowledge/Tag only** (`DEDUPE_MERGE_LABELS`); Skill/Project are
  scan/report-only. Re-points the removed nodes' edges onto the keeper preserving props, then deletes the
  duplicates — one audited, fully **undoable** lane job.
- IPC `memory.dedupe.scan` / `memory.dedupe.merge`.
- MCP: **`list_duplicate_memories`** (read-only) + **`propose_dedupe_merge`** (validates, then **stages** a
  `staged_writes` row of new kind **`dedupe-merge`** — never merges directly, §21.6). New permission tier
  **`DASHBOARD_TOOLS = { list_duplicate_memories, propose_dedupe_merge }`** in `permissions.ts`, granted to
  the interactive `mcp:` profile only; the `RUNNER_SESSION_ALLOWLIST` is unchanged and pinned by test.

### Stage 5 — renderer CRUD + skill/import UI
Files: `src/renderer/src/panels/MemoryPanel.tsx`, `ReviewPanel.tsx`, `IngestPanel.tsx`,
`src/renderer/src/ui/kit.tsx`, `tests/e2e/dashboard.memory-edit.spec.ts` (new).
- **Memory panel**: "Add memory" modal (plain label picker + per-label forms via a hand-kept
  `LABEL_FORMS` mirror); inspector Edit / Delete-with-cascade-confirm (plain counts) / "Connect to…"
  (edge-type select filtered to valid §18 pairs in both directions, target picker via `memory.search`) +
  per-edge remove. Every mutation → reload + **undoable toast** (kit `ToastProvider` gained an additive
  inline `ToastAction`, wired to the returned `auditActionId` → `audit.undo`).
- **Approvals panel**: `skill-import` rows rendered as sentences; the `requiresEmbedder` approve preflight
  generalizes to them.
- **Ingest panel**: result line "N skills found — waiting in Approvals" with a navigate link.
- **e2e** `dashboard.memory-edit.spec.ts`: add a Tag → delete → undo from History (Tag is non-retrievable,
  so it is offline-friendly and needs no Ollama in CI).

### Stage 6 — approvals + graph readability, and the dedupe UI
Files: `src/renderer/src/lib/stagedSummary.ts` (new), `src/renderer/src/lib/nodeSummary.ts` (new),
`src/renderer/src/lib/plain.ts`, `src/renderer/src/App.tsx`, `ReviewPanel.tsx`, `MemoryPanel.tsx`,
`IngestPanel.tsx`, `tsconfig.node.json`, `tests/unit/stagedSummary.test.ts`,
`tests/unit/nodeSummary.test.ts`, `tests/unit/plain.propLabel.test.ts`.
- **`stagedSummary.ts`** (pure): `summarizeStagedWrite(row) → { what, why?, source? }` — deterministic
  what/why/where templates per staged kind (correction, extraction, skill-improvement, skill-import,
  dedupe-merge) and per op; unknown shapes degrade to a grammatical sentence, never raw JSON. `SourceRef`
  chips deep-link into the Memory inspector.
- **`nodeSummary.ts`** (pure): `summarizeNode(detail) → string` — a per-label lead sentence in the
  inspector. **`plainPropLabel(label, key)`** in `plain.ts` — friendly KV labels (raw key kept in a
  `title` attr).
- **Diff modal restructured**: summary first ("what happens if you approve" / "why" / "where it came
  from" chips), the raw ops moved behind a **`defaultOpen` 'Technical changes' Disclosure** so existing
  staged-diff e2e assertions still resolve (verified against `dashboard.review.spec.ts` + the static
  golden-path assertions before moving the body).
- **Dedupe UI**: "Find duplicates" modal — groups with reason chips, suggested-keeper radio, inline
  confirm (deviation: inline confirm, not a nested modal, to sidestep kit `Modal` Escape handling), merge
  → undoable toast.
- **Deep-link plumbing** (App.tsx, renderer-only, additive): a one-shot `InspectTarget` on `PanelProps` —
  ReviewPanel source chips + IngestPanel skill line switch to the Memory panel and open the inspector.
- `tsconfig.node.json` gained 3 explicit includes for the DOM-free renderer libs (TS6307, mirroring the
  `shared/ipc.ts` precedent).

---

## Gates (run fresh at end-of-feature, 2026-07-11)

| Gate | Result |
|---|---|
| `npm run typecheck` | **pass** (exit 0) — `tsc --noEmit` node + web projects clean |
| `npm run lint` | **pass** (exit 0) — `eslint .` clean |
| `npm test` | **pass** (exit 0) — **993 passed \| 21 skipped** (env-gated live suites), no flakes fired |
| e2e `dashboard.review` | **pass** — approve a staged correction (1.1s) |
| e2e `dashboard.ingest` | **pass** — watched-folder ingest from the UI (20.7s) |
| e2e `dashboard.audit` | **pass** — undo a reversible graph write from the audit log (747ms) |
| e2e `dashboard.memory-edit` | **pass** — add a Tag → delete-with-confirm → undo from History (1.9s) |

(All four ran over the production build in one Playwright serial run: **4 passed (1.5m)**, exit 0.)

`golden-path.spec.ts` was **not** run locally by design: the user's LIVE app holds MCP port 4517, and the
spec POSTs a session-end hook — running it would inject test data into their real system. Its assertions
(including the moved diff body) were statically verified; CI covers the actual run.

Known pre-existing full-suite flakes (`storage.checkpoint` dirty-gated, `retrieval.latency` p50, the
docker conformance probes) did **not** fire this run; each is green in isolation if it ever does.

---

## Recorded decisions & deviations (§21 rule 12)

1. **§12 exact-tool-surface deviation — user-directed.** The §12 MCP surface is extended by two tools
   (`list_duplicate_memories` read, `propose_dedupe_merge` staged). This is explicit user-directed work.
   **§21.6 is preserved**: `propose_dedupe_merge` only *stages* (kind `dedupe-merge`) — it never merges
   directly; the CRUD channels are IPC-only and never reachable over MCP.
2. **CRUD is human-only, dashboard-only.** No MCP tool writes the graph directly; Claude's path stays
   `propose_correction`. The `memory.*` channels are `user:dashboard` IPC only.
3. **User writes carry no extraction provenance.** A user node/edge is not an extraction; the audit row
   records the actor. `PROTECTED_NODE_KEYS` (incl. `extracted_by`/`confidence`) are refused from clients.
4. **Skill-import confidence 0.6 for LLM proposals, 1.0 for deterministic artifacts** — §20 has no figure;
   conservative rule-12 pick.
5. **Skill provenance is edges-only** — `Skill`/`SkillVersion` have no provenance columns (§18); the stamp
   rides `HAS_VERSION` + the Project `USES` link.
6. **Extracted skills are staged, never auto-active; same-name is staged as a revision, never overwritten**
   (§21.5: ingested content is data-not-instructions; a skill becomes standing instructions served over
   `get_skill`, so it must pass the injection scanner and a human).
7. **Dot-dir discovery via targeted root reads** — the walker prunes dot-dirs, so `.claude/skills` and
   `.claude/commands` are read directly rather than from the walked file list.
8. **Dedupe near-threshold 0.95** — deliberately above the extraction-time `ENTITY_MERGE_COSINE` 0.9,
   because a false near-merge of two long-lived nodes silently loses a distinct memory.
9. **Dedupe merge is Preference/Knowledge/Tag only**; Skill/Project are scan/report-only (auto-merging a
   skill or a project is too destructive to propose blindly — reviewed in the Skills panel instead).
10. **Diff-modal 'Technical changes' Disclosure is `defaultOpen`** so pre-existing staged-diff e2e and
    static golden-path assertions keep resolving the raw op text.
11. **Dedupe confirm is an inline confirm, not a nested modal** — sidesteps kit `Modal` Escape-key
    handling.
12. **`tsconfig.node.json` explicit includes** for the DOM-free renderer libs — mirrors the existing
    `shared/ipc.ts` precedent (TS6307).

---

## Known limitations (for the next builder)

- **`LABEL_FORMS` needs manual sync.** The renderer's per-label add-memory field map is a hand-kept mirror
  of the main-side schema's writable properties. A schema change to writable props must be reflected here
  by hand (there is no build-time check binding them — the drift is only caught by a failing create).
- **Connect-to target picker searches retrievable labels only.** It uses `memory.search`, so non-retrievable
  endpoints (e.g. a Tag or Session as an edge target) are unreachable from the picker. Edge *validation*
  accepts them; only the picker UI can't surface them.
- **Undo re-stamps timestamps.** `restore-node` re-`upsertNode`s the pre-image, which sets a fresh
  `updated_at` (the node content, edges, and embedding are byte-restored; only the audit timestamps move).

## Exact instructions for whoever builds next

- **Extend the golden-path release gate in CI** to cover the two new end-to-end arrows this feature adds:
  (a) codebase ingest → `skill-import` staged → dashboard approve → `get_skill`/`list_skills` serves the
  imported skill with an embedding; (b) `list_duplicate_memories` → `propose_dedupe_merge` staged →
  approve → merge → undo round-trip. They are covered by integration tests today but not by the packaged
  golden-path gate. Do this in CI (it must not run locally against the user's live port-4517 app).
- If you add a **new node label with writable props**, update the renderer `LABEL_FORMS` mirror (Memory
  panel) alongside the schema, or the Add-memory form will silently omit the new field.
- The **single Skill committer is `importSkill`** in `src/main/agents/skills/lifecycle.ts` — route any new
  base-Skill creation through it (do not re-create `Skill`+`SkillVersion` inline; deterministic extraction
  still deliberately refuses to create Skills).
- Any **new staged-write kind** should get a `stagedSummary.ts` template (it degrades gracefully, but the
  generic sentence is worse than a tailored one) and, if it writes the graph, must ride `audit.graphWrite`
  so History/undo keeps working.
