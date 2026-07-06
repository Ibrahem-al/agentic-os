# Phase 21 report — subscription-runner fallback visibility (chip + broadened banner)

**Branch:** `feat/mcp-expansion-subscription-reasoner`. Post-feature UX enhancement. **Fable-5 planned** (high effort), **Opus implemented** (ultracode workflow `wf_35447569-c77`: parallel backend/renderer → verify). Prime directive held: ADD, never REMOVE — DEFAULT==TODAY (runner OFF → `fallbackActive:false`, `effectiveBackend:null`, no chip, banner unchanged, DOM byte-identical).

## Why
Fallback (`subscription → cloud-api → local-qwen3`) was silent except a narrow banner. This adds (1) a neutral dashboard **chip** showing the effective tier when the subscription is enabled-but-unavailable, and (2) **broadens** the banner to the `not-installed` state.

## What was built
### Backend enrichment (single source of truth — chip AND `get_runner_status` agents see it)
- **`RunnerStatusDto`** (`src/shared/ipc.ts`) += `fallbackActive: boolean` + `effectiveBackend: 'cloud-api' | 'local-qwen3' | null`.
- **`reads/runner.ts`** — `fallbackActive = enabled && !runner.isHealthy()` (computed from **`isHealthy()`, the exact gate the router consults — NOT the raw sticky `state`**, which decays to `unknown` after the 15-min TTL while routing re-probes); `effectiveBackend = router.resolve('skills.rewrite').backend` (clamped to `null` on a raced `subscription-claude` / no router). `RunnerStatusSource` += `isHealthy()`; `RunnerStatusDeps` += optional `router?: Pick<ProviderRouter,'resolve'>`.
- **`ipc.ts` / `index.ts`** — thread `router` into the `runner.status` handler (optional dep; existing rigs unchanged). **`mcp/tools/read.ts`** — `get_runner_status` passes `ctx.router` (already on `ToolContext`) so the two fields populate over MCP too.

### Renderer (`design-tokens.ts`, `App.tsx`)
- `statusColor` += `fallback: 'warn'` (neutral degraded-but-working token, not `err`).
- **Chip** — `RunnerFallbackChip` (kit `Badge`) in a rail block between the review-week counter and `SubsystemStatus`, `role="status"`, `data-testid="runner-fallback-chip"`. Trigger `enabled && fallbackActive && state !== 'unknown'` (anti-flicker). Copy by tier: `fallback: cloud` / `fallback: local` / `fallback active`, full sentence on `title`.
- **Banner** broadened to `['auth-expired','quota-exhausted','not-installed']` via a per-state `{title,hint,tint}` record (auth/quota copy+tints kept; `not-installed` added with an install hint). **Never banners `unknown`** (no first-load flash). Testids/roles/retry preserved. Chip + banner **coexist** (chip = ambient effective-tier fact; banner = loud actionable overlay).

## Orchestrator rulings (on the plan's flagged risks)
1. **Accepted** the deduped `--version` freshness probe — `isHealthy()` is the router's own gate, already firing on every route; `reads` calling it adds no new spawn behavior (deduped ≤1/15min, enabled-only, never an auth/reasoning call).
2. **Accepted** the simple `enabled && !isHealthy()` trigger (records a half-config over-trigger) — keeps `provider.ts` untouched.
3. **Accepted** `skills.rewrite` as the representative probe role — informational.

## Related finding (NOT changed here — flagged for the user)
Enabling the runner toggle sets `runner.enabled` but **not** `reasoning.backend='subscription-claude'`; `desiredBackend` only routes a role to the subscription when `reasoning.backend` is that (or a per-role override / agent mode). So a user who only flips the runner toggle may make the subscription *available* without any role actually *using* it. Separate UX gap from this change — surfaced, not silently altered.

## Verification (DoD)
- Orchestrator: lint clean; typecheck clean; isolated `reads.runner-status` = **10 passed** (4 existing + 6 new: disabled→false/null, enabled+healthy→false/null, unhealthy→cloud, unhealthy→local, unhealthy+no-router→null, race-clamp); `package.json`/lock diff empty; `reads/runner.ts:69` confirms the `isHealthy()`-based computation.
- Verify agent full offline suite: **850 passed | 12 skipped**; the 2 failures the known `retrieval.latency` + `security.conformance`-docker load flakes, green in isolation; no cross-stream contract mismatch.
