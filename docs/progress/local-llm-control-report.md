# Report — AI-processing control + local-LLM usage & resource visibility

**Date:** 2026-07-13 · **Branch:** main · **Status:** done (4 stages)

User intent: (1) let the user REPLACE the local qwen3 reasoning tier with their cloud API
key or their Claude subscription (the MCP-connected runner) from one obvious place; (2) give
usage indicators + resource trackers for the local LLM so the user can SEE and CONTROL what
runs on their computer. Built in 4 stages on top of the phase-14–22 MCP-expansion +
subscription-reasoner spine. `DEFAULT == TODAY` holds throughout: a user who touches nothing
gets byte-identical behavior.

## What shipped, by stage

### Stage 1 — local-LLM usage tracking (backend)
- **appdata v9** (`storage/appdata.ts`): additive `local_llm_usage` table
  (`id, ts, role NULL, model, prompt_tokens NULL, eval_tokens NULL, duration_ms, ok`) + a
  `ts` index. Rides `APPDATA_SCHEMA` + the version-bump upgrade path (no bespoke migration).
- **Recorder seam** (`storage/localUsage.ts`, new): `LocalLlmUsageRecorder` interface +
  appdata-backed `LocalLlmUsageStore` (one prepared INSERT) + `pruneLocalLlmUsage`.
  `OllamaClient` gains an **optional** `recorder`; `generate()` records exactly one row per
  call in a `finally` (success and failure), stamping Ollama's `prompt_eval_count` /
  `eval_count` / `total_duration` (ns→ms; wall-clock fallback on an errored call). Recording
  **never fails the call** — `recordUsage()` swallows + `console.warn`. Absent recorder ⇒
  byte-identical to today. `embed()` untouched (embedder out of scope).
- **`ps()`** on `OllamaClient` → `LoadedModel[]` from `GET /api/ps`, graceful `[]` on
  daemon-down / non-2xx / parse error, bypasses the §8 pool.
- **IPC `usage.local.summary`** + **MCP read tool `get_local_usage`** over
  `reads/localUsage.ts getLocalUsage()` — raw SQL aggregation (totals/byRole/byDay/recent) +
  a parallel live `ps()`+`status()` probe. `sinceDays` clamped `[1,365]`, default 30.
- **Retention:** `LOCAL_LLM_USAGE_RETENTION_DAYS = 30`, pruned once per boot from `bootModels`.

### Stage 2 — routing control (backend)
- **`ReasoningSettings.allowSensitiveNonLocal?: boolean`** (settings.ts validator + DTO in
  shared/ipc.ts). Absent/false = today. `settings.save` needed no code change — its reasoning
  merge already spreads `patch.reasoning`, and `saveModelSettings` full-serializes, so the
  flag round-trips; `parseReasoning` reads it back.
- **`ProviderRouter.desiredBackend` rule** (provider.ts): the gate
  `sensitiveUnlocked = def.hardLocal && reasoning.allowSensitiveNonLocal === true` is read in
  BOTH the desired-backend selection and the §11.4 clamp. A HARD-local role resolves non-local
  only when consent is granted AND (an explicit override OR a non-local global backend);
  everything still subject to the unchanged availability chain (local is the final fallback).
  Flag absent/false ⇒ byte-identical to today.
- **IPC `reasoning.roles`** (`reads/reasoningRoles.ts`, new) → all 14 roles projected into 5
  plain groups with `sensitive` + live `effectiveBackend`.

### Stage 3 — renderer
- **Settings → "AI processing"** (new section after "AI providers"): a vertical radio list
  (local / cloud key / subscription) wired to `reasoning.backend` — subscription **reuses the
  runner-enable path verbatim** (consent gate + atomic coupling), local/cloud go through a new
  `saveBackend` that mirrors the toggle's disable coupling. "What runs where" table from
  `reasoning.roles` (grouped, lock on sensitive groups). Sensitive-egress Toggle behind a
  consent Modal; revoke sends `allowSensitiveNonLocal:false` explicitly. Note: "Search
  indexing (embeddings) always runs on this computer."
- **Usage panel** (SpendPanel.tsx, title → "Usage"): new "On this computer" section above
  cloud spending — live loaded-model line, StatStrip, 14-day compute BarChart, 7-day
  role-group CompositionBar, recent-calls DataTable behind a Disclosure. Two windows
  (`sinceDays:14` + `:7`), UTC day buckets.
- **Home**: an 11th poll + a 5th HeadlineStats "Local AI today" stat. **Nav**: label
  `Spending` → `Usage & spending` (`nav-spend` testid + `spend` panelKey unchanged).

### Stage 4 — verify, docs, commit (this stage)
- Adversarial re-read of all three stages' diffs (below): **0 fixes needed**.
- README Privacy section rewritten for the AI-processing backend choice + the opt-in
  sensitive-egress control + a "Seeing what runs locally" note.

## Decisions recorded (spec deviations)
- **§11.4 hard-local override behind consent.** The 5 HARD-local roles (retrieval.critic/
  rewrite, skills.executor/grader, scanner.llmVerdict) become user-overridable, extending the
  §10.7 egress-consent pattern (phase-20 precedent). Default off ⇒ unchanged.
- **"MCP server" in the user ask = the existing subscription-claude backend** (the runner
  connects over MCP). No new backend built.
- **30-day retention** for the usage ledger (rule-12 pick) — wider than the §20 14-day
  transcript window because the ledger is pure observability at negligible size and the panel
  wants a month of trend.
- **Embedder excluded.** bge-m3 + the ONNX reranker are out of scope (embedding dimension is
  schema-pinned, §20); "replace the local llm" = the qwen3 reasoning roles only. Surfaced in
  the UI ("Search indexing always runs on this computer").
- **Possible follow-up (not built):** a custom OpenAI-compatible endpoint — OpenRouter already
  covers arbitrary hosted models.

## Stage-4 adversarial findings
Re-read the full `git diff` for six failure vectors; each is already correct and test-pinned:
1. **Recorder DB error mid-call never fails a model call** — `recordUsage()` try/catch swallow
   + warn; pinned by `localUsage.test.ts` "NEVER fails the completion when the recorder throws".
2. **DEFAULT==TODAY covers ALL 5 hard-local roles** — `models.provider.test.ts` `HARD_ROLES`
   = the exact 5, asserted equal to the `hardLocal` set (line 135), and the "flag ABSENT" test
   loops all 5 under both non-local globals with subscription healthy + a cloud key present.
3. **settings.save merge doesn't drop the flag** — `{ ...default, ...current, ...patch }` +
   full `JSON.stringify` serialize + `parseReasoning` readback; round-trip/preserve/revoke
   pinned in `ipc.settings.test.ts`.
4. **Consent dialog doesn't persist on cancel** — Cancel/onClose only close; only the acked
   "Allow" button calls `saveSensitive(true)`.
5. **Usage panel graceful when Ollama down AND when the table is empty** — daemon-down,
   running-but-idle, and empty-loaded lines; `CompositionBar` guards `total===0`; bars show a
   "No local reasoning" note; recent table has an `empty` message; `busiest` → '—'.
6. **README Privacy still truthful** — rewritten this stage.

**No source changes were needed in Stage 4.** Result: 0 fixes.

## Files touched (cumulative, stages 1–4)
- **Backend:** config.ts, storage/appdata.ts, storage/localUsage.ts (new), storage/index.ts,
  models/ollama.ts, models/index.ts, models/provider.ts, models/settings.ts,
  reads/localUsage.ts (new), reads/reasoningRoles.ts (new), reads/index.ts,
  mcp/tools/shared.ts, mcp/tools/read.ts, security/permissions.ts, ipc.ts, index.ts,
  shared/ipc.ts.
- **Renderer:** App.tsx, lib/plain.ts, panels/HomePanel.tsx, panels/SettingsPanel.tsx,
  panels/SpendPanel.tsx, ui/icons.tsx.
- **Tests:** unit/appdata.test.ts, unit/localUsage.test.ts (new), unit/models.provider.test.ts,
  unit/models.settings.test.ts, unit/storage.reset.test.ts, integration/ipc.localUsage.test.ts
  (new), integration/ipc.settings.test.ts, integration/mcp.read-tools.test.ts,
  integration/reads.reasoning-roles.test.ts (new), e2e/dashboard.ai-processing.spec.ts (new).
- **Docs:** README.md (Privacy + "Seeing what runs locally"), docs/PROGRESS.md (row 26),
  this report.

## Gates (Stage 4)
_Filled from the fresh run — see the commit body / handoff._

## Known limits / left open
- `READ_TOOLS` gained `get_local_usage` (§13 scope check fails closed on untiered tools);
  `RUNNER_SESSION_ALLOWLIST` derives from `READ_TOOLS ∪ STAGING_TOOLS`, so no manual runner
  edit — but note the runner CAN now call `get_local_usage` (read-tier, harmless observability).
- No custom OpenAI-compatible endpoint (deferred, see above).
- The Usage-panel Home poll adds one recurring `usage.local.summary` every 20s → an Ollama
  `/api/ps` + status probe (graceful when the daemon is down).
