# Phase 22 — enabling the runner must engage `reasoning.backend` (the routing-gap fix)

**Bug:** the dashboard "subscription runner" enable toggle sets only `runner.enabled`, but the OS's background reasoning routes to the subscription only when `reasoning.backend === 'subscription-claude'` (`ProviderRouter.desiredBackend`). There is no UI control for `reasoning.backend`, so enabling the runner leaves it "available but unused" — no role actually uses the subscription. **Fix: enabling the runner also sets the global reasoning backend, in ONE atomic save.** Fable-5 planned; orchestrator rulings folded in. Prime directive: ADD, never REMOVE — **DEFAULT==TODAY** (runner OFF/default → `reasoning.backend` absent-or-`'local-qwen3'` → every role on its `ROLE_DEFAULTS.today` tier, byte-identical; golden-path e2e never enables the runner, stays green).

## The fix (RENDERER-ONLY — no main-side change)
Verified: `settings.save` (ipc.ts) already MERGES a `reasoning` patch onto current settings (preserving `overrides`/`models`) + fires `onSettingsChanged → router.invalidate()`; `ModelSettingsPatchDto.reasoning` already accepts `{ backend }`. The whole routing stack works — the bug is that no UI ever wrote the setting.

`src/renderer/src/panels/SettingsPanel.tsx` — `saveRunner` (the single choke point both enable paths funnel through) pairs the reasoning backend with any `enabled` change in ONE `settings.save`:
```ts
const save: ModelSettingsPatchDto =
  patch.enabled === undefined
    ? { runner: next }
    : { runner: next, reasoning: { backend: patch.enabled ? 'subscription-claude' : 'local-qwen3' } }
```
- Enable → `{ runner:{…enabled:true}, reasoning:{ backend:'subscription-claude' } }`. Disable → `{ …enabled:false, reasoning:{ backend:'local-qwen3' } }`. **Model-select saves never touch `reasoning`.**
- Backend-only patch ⇒ the main-side merge preserves any hand-edited `reasoning.overrides`/`models`.
- One atomic save (no two-write window where enabled=true but backend still local); `runnerStatus.reload()` on an enabled-change for status-line freshness.
- Add `ModelSettingsPatchDto` to the existing `'../../../shared/ipc'` type import.

## Revert-on-disable = `'local-qwen3'` unconditionally (safety, not cosmetic)
If `'subscription-claude'` were left standing with the runner off, `routeWith` walks subscription→(unavailable)→**cloud-api** if a key exists — the 3 local-today subscribable roles (`extraction.fuzzy`, `extraction.tiebreak`, `ingest.projectSummary`) would silently ride the **paid** cloud tier forever. Reverting to `'local-qwen3'` restores exactly `ROLE_DEFAULTS.today` for every role (identical to an absent section). Send the disable reasoning patch unconditionally.

## What moves (spec'd §11.4)
Enabling (runner enabled+healthy) moves the 7 `subscribable:true` roles to subscription: `extraction.fuzzy/tiebreak/verify`, `skills.testset/rewrite/comparator`, `ingest.projectSummary` — including the 4 **cloud-today** roles (extraction.verify + the 3 skills) moving cloud→subscription (`reportedCostUsd:0`, no spend rows — desired). HARD-local (`retrieval.critic/rewrite`, `scanner.llmVerdict`, `skills.executor/grader`) and `context.summarize` stay local. Disabling → all revert to `today`.

## Visibility (Decision iii) + consent
- **Status line** under the runner section (`data-testid="settings-runner-routing"`): "background reasoning: subscription" / "…subscription — currently falling back to your cloud api tier | the local model | the fallback tier" (from `runnerStatus.fallbackActive`/`effectiveBackend`, same null-handling as the App.tsx chip) / "local + cloud api defaults" (disabled or backend≠subscription). Derive "configured" from the **readback** `dto.reasoning?.backend` + `runnerCfg.enabled`, never optimistic state.
- **Consent**: the P1.10 modal text is now literally true — no mandatory change. ADD one sentence after its first `<p>`: "While the runner is unavailable, background reasoning falls back to your cloud api key (if set) or the local model; turning the runner off restores those defaults." **Implementer: grep `tests/` for pinned consent copy strings BEFORE editing — add a sentence, do not alter the existing lines; keep all `settings-runner-consent*` testids.**
- Optional: enable/disable toast copy ("runner enabled — background reasoning uses your subscription" / "…back to local/cloud defaults").

## Side effect (good): the fallback chip becomes truthful
Post-fix, UI-driven `enabled=true` always coincides with `backend='subscription-claude'`, so the phase-21 chip's `fallbackActive`/`effectiveBackend` now describe a real desire→fallback (the earlier accepted half-config over-trigger is unreachable via the UI). No chip/`reads/runner.ts` change.

## File list
- `src/renderer/src/panels/SettingsPanel.tsx` — the combined `saveRunner` patch + status line + consent sentence + toast copy + `runnerStatus.reload()`. **RENDERER-ONLY fix.**
- `tests/integration/ipc.settings.test.ts` — new contract tests (below).
- `tests/e2e/dashboard.settings-runner.spec.ts` — OPTIONAL new spec (consent→enable→routing line + settings.json both-fields→disable→revert; health-agnostic).
- docs (report + PROGRESS/worklog).
- **Unchanged:** `ipc.ts`, `provider.ts`, `settings.ts`, `shared/ipc.ts`, `reads/runner.ts`, `index.ts`, `App.tsx`.

## Test plan (offline; the ipc.settings rig already imports loadModelSettings/settingsPath + spies onSettingsChanged)
1. **Enable-patch round trip**: `settings.save` with the renderer enable patch → on-disk `runner.enabled===true` AND `reasoning.backend==='subscription-claude'`; DTO surfaces both; `onSettingsChanged` fired once.
2. **Overrides/models survive**: seed `reasoning` with `overrides`+`models`, apply the backend-only enable patch → preserved with flipped backend; disable → preserved, backend back to `'local-qwen3'`.
3. **The toggle actually routes** (load-bearing): after the enable patch, build a `ProviderRouter` (`loadSnapshot: () => loadModelSettings(settingsPath(dir))`, `runnerHealthy: () => true`, stub `subscriptionComplete`) → `resolve('extraction.fuzzy').backend==='subscription-claude'` and `resolve('extraction.verify').backend==='subscription-claude'`; apply disable + `invalidate()` → `extraction.fuzzy`→'local-qwen3', `extraction.verify`→'cloud-api' (with a makeCloud tier) / 'local-qwen3' keyless; `skills.grader` stays local throughout.
- Renderer: `npm run typecheck && npm run lint` (no component test rig — do not invent one). Golden-path e2e unchanged/green.

## DoD
`npm run lint && npm run typecheck && npm test` green (flakes isolated). DEFAULT==TODAY: fresh install never materializes `reasoning`/`runner`; the coupling fires only on an explicit user toggle; runner off → today's routing byte-identical. `settings.json` after a toggle cycle shows `reasoning.backend:'local-qwen3'` (routes identically to absent).
