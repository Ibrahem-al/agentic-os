# Phase 22 report — enabling the runner engages `reasoning.backend` (routing-gap fix)

**Branch:** `feat/mcp-expansion-subscription-reasoner`. **Fable-5 planned** (high effort), **Opus implemented** (ultracode workflow `wf_23392b5f-d6c`: implement → verify). Fixes the gap flagged after phase-21: the dashboard runner toggle set only `runner.enabled`, so the OS's background reasoning never actually used the subscription (which requires `reasoning.backend='subscription-claude'`, with no UI control). Prime directive held: DEFAULT==TODAY.

## The fix (renderer-only — no main-side change)
`src/renderer/src/panels/SettingsPanel.tsx` — `saveRunner` now pairs the reasoning backend with any `enabled` change in ONE atomic `settings.save`:
```ts
patch.enabled === undefined
  ? { runner: next }
  : { runner: next, reasoning: { backend: patch.enabled ? 'subscription-claude' : 'local-qwen3' } }
```
So enabling the runner (after the P1.10 consent) now genuinely routes the 7 `subscribable` roles to the subscription (when the runner is healthy); disabling reverts them to their `ROLE_DEFAULTS.today` tier. The `settings.save` merge (preserves `reasoning.overrides`/`models`) + `router.invalidate()` already existed — the bug was purely that no UI ever wrote the setting.

Also added: a `data-testid="settings-runner-routing"` status line ("background reasoning: subscription / …falling back to cloud|local / local + cloud api defaults", from the readback + `runnerStatus.fallbackActive`/`effectiveBackend`) and one consent sentence (no test pins the consent copy — grep-confirmed). Model-select saves never touch `reasoning`.

## Key decisions (Fable-planned, orchestrator-ruled)
- **Toggle sets the backend** (not a separate 3-way selector — 2 of its 3 positions would be routing no-ops since `desiredBackend` treats global `cloud-api`/`local-qwen3` identically; and not a router-side `runner.enabled` read — that would break the pinned per-role-override test).
- **Disable → `'local-qwen3'` unconditionally** (SAFETY): leaving `'subscription-claude'` standing with the runner off would silently ride the **paid** cloud tier forever for the 3 local-today subscribable roles (subscription unavailable → cloud-api). Reverting restores exactly today's routing.
- **Accepted** the designed §11.4 fallback chain (enable while unhealthy → cloud/local per role; bounded by the $0.50 ceiling, surfaced by the chip/banner, disclosed by consent).
- **Side effect (good):** the phase-21 fallback chip is now truthful — UI-driven `enabled=true` always coincides with `backend='subscription-claude'`, so the earlier accepted half-config over-trigger is unreachable via the UI.

## Verification (DoD)
- Orchestrator: working tree = only `SettingsPanel.tsx` + `ipc.settings.test.ts` (renderer-only, no main-side); the atomic patch confirmed at `SettingsPanel.tsx:208`; lint clean; typecheck clean; isolated `ipc.settings` = **12 passed** (9 + 3 new); no new dep.
- Verify agent full offline suite: **854 passed | 12 skipped**; the 4 failures are known load flakes (`retrieval.latency`, `security.conformance`-docker ×2, and `runner.completion > sweepZombies` — a real-process pid-kill test, load-timing sensitive), each **green in isolation**.
- The load-bearing new test builds a real `ProviderRouter` over the saved `settings.json` and pins: enable → `extraction.fuzzy`/`extraction.verify` resolve to `subscription-claude` (healthy); disable → back to `local-qwen3`/`cloud-api`; `skills.grader` (HARD-local) stays local throughout. Plus: enable-patch atomic round-trip (one `onSettingsChanged`); `overrides`/`models` survive the toggle.

## Result
Turning on the dashboard "subscription runner" toggle now does what it says: the OS's background reasoning (extraction, skill improvement, ingest summary) runs on your Claude subscription while it's healthy, falls back to cloud/local when it isn't, and reverts cleanly when you turn it off. Still OFF by default; your Claude-Code-over-MCP usage (Path 1) is unaffected.
