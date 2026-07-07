# Phase 21 — subscription-runner fallback visibility (chip + broadened banner)

Post-feature UX enhancement. Fallback is silent today; add (1) a neutral dashboard **chip** showing the effective tier when the subscription is enabled-but-unavailable, and (2) **broaden** the runner banner beyond auth/quota. Planned by a Fable-5 agent; orchestrator rulings folded in below. **Prime directive:** ADD, never REMOVE — DEFAULT==TODAY (runner OFF → no chip, no banner, DOM byte-identical; golden-path e2e never enables the runner, so it must stay green).

## Load-bearing facts (verified)
- **`isHealthy()` ≠ raw `state`.** `RunnerHealth.isHealthy()` = `enabled ∧ resolved ∧ versionOk ∧ effectiveState∈{ok,unknown}`; sticky failures decay to `unknown` after `RUNNER_HEALTH_TTL_MS` (15 min) so routing re-probes. **"Fallback active" must come from `isHealthy()`** (the exact primitive `ProviderRouter.subscriptionAvailable` uses), NOT re-derived from the DTO `state` (which stays sticky). `isHealthy()` on an ENABLED runner may kick one deduped, non-blocking `claude --version` probe per TTL — **this is the router's own gate, already firing on every route; reads calling it adds no new spawn behavior** (disabled runner still spawns nothing — the enabled check precedes the probe).
- `runner.enabled` alone does not route roles to subscription (`desiredBackend` also needs `reasoning.backend==='subscription-claude'`/an override, or `mode==='agent'`). ⇒ the simple trigger over-triggers in the half-config case — **accepted** (the statement "subscription unavailable — reasoning on cloud/local" stays true).

## Backend enrichment (single source of truth — serves the chip AND `get_runner_status`)
`src/shared/ipc.ts` — add to `RunnerStatusDto` (after `lastError`):
```ts
/** True when the runner is enabled but the subscription tier is unavailable (same isHealthy() the router consults) — reasoning that would ride the subscription is falling back. Always false when disabled (local/cloud is then the CONFIGURED tier). */
readonly fallbackActive: boolean
/** Where a subscription-eligible role actually lands while falling back (live router resolution). null when not falling back, or no router wired. */
readonly effectiveBackend: 'cloud-api' | 'local-qwen3' | null
```
`src/main/reads/runner.ts`:
- `RunnerStatusSource` gains `isHealthy(): boolean` (phase-17 `Runner` already satisfies it).
- `RunnerStatusDeps` gains `router?: Pick<ProviderRouter, 'resolve'> | null` (type-only import from `'../models'`).
- Compute: `fallbackActive = enabled && !(runner?.isHealthy() ?? false)`; `const resolved = fallbackActive ? router?.resolve('skills.rewrite') : undefined`; `effectiveBackend = (resolved === undefined || resolved.backend === 'subscription-claude') ? null : resolved.backend` (clamps a raced `subscription-claude`).
- Update the module header comment's "never spawns claude" note per the fact above (deduped `--version` only, enabled-only).
`src/main/ipc.ts` — `IpcDeps.runner` Pick gains `'isHealthy'`; add optional `router?: ProviderRouter | null` (type-only, documented like `onSettingsChanged`); the `runner.status` handler passes `router: deps.router ?? null`. (Optional deps ⇒ existing rigs compile unchanged.)
`src/main/index.ts` — add `router: providerRouter` to the `registerIpcHandlers` call (next to `runner: subscriptionRunner`). `setReadContext` needs NO change (`ToolContext.router` already flows via server deps).
`src/main/mcp/tools/read.ts` — `get_runner_status` handler passes `router: ctx.router ?? null`; extend the one-sentence description to mention the fallback flag.
`tests/integration/reads.runner-status.test.ts` — update the exact-shape assertion (+`fallbackActive:false, effectiveBackend:null`); `sourceOf` gains an `isHealthy` param; 6 new cases: disabled→false/null; enabled+healthy→false/null; enabled+unhealthy+router→cloud-api→true/'cloud-api'; +router→local-qwen3→true/'local-qwen3'; enabled+unhealthy+no-router→true/null; race-clamp router→'subscription-claude'→true/null.

## Renderer (rail chip + broadened banner)
`src/renderer/src/design-tokens.ts` — add `fallback: 'warn'` to the runner block of `statusColor` (neutral "degraded but working" token; NOT `err`).
`src/renderer/src/App.tsx`:
- **Chip** — a small `RunnerFallbackChip` (kit `Badge`, local like `RunnerBanner`) in a rail block **between** the review-week block and `<SubsystemStatus/>`, `role="status"`, `data-testid="runner-fallback-chip"`. Trigger: `runnerStatus && runnerStatus.enabled && runnerStatus.fallbackActive && runnerStatus.state !== 'unknown'` (the `!== 'unknown'` is renderer-only anti-flicker; the DTO stays factual). Copy: `effectiveBackend==='cloud-api'` → label `fallback: cloud`, title "subscription unavailable — reasoning is running on your cloud api tier until it recovers"; `'local-qwen3'` → `fallback: local`, "…on the local model until it recovers"; `null` → `fallback active`, "…on the fallback tier". Reuse the existing single `useRunnerStatus` poll (no second consumer).
- **Banner broaden** — `RUNNER_BANNER_STATES = ['auth-expired','quota-exhausted','not-installed']`; trigger `runnerStatus && runnerStatus.enabled && RUNNER_BANNER_STATES.includes(state)`. Refactor `RunnerBanner` to a per-state config record `{title, hint, tint}`: keep the existing auth/quota copy + tints; add `not-installed` (warn tint, title "subscription runner cli unavailable", hint: install claude code (`npm install -g @anthropic-ai/claude-code`) or point `runner.binaryPath` in settings.json at the cli, then retry). Keep the shared tail sentence ("reasoning falls back to your cloud or local tier until this clears, so nothing is blocked."), the `lastError` mono line, `data-testid="runner-banner"`/`runner-banner-retry`, `role="alert"`, and the existing retry (`runner.testConnection`→refresh). **Never banner `unknown`** (prevents first-load flash).
- Chip and banner **coexist** (chip = ambient effective-tier fact in the rail; banner = loud actionable overlay at top of main) — no hide-coupling.

## Concurrency / files
Backend stream: `shared/ipc.ts` (DTO — the contract both build to), `reads/runner.ts`, `ipc.ts`, `index.ts`, `mcp/tools/read.ts`, `reads.runner-status.test.ts`. Renderer stream: `design-tokens.ts`, `App.tsx` (build to the DTO field names above). Disjoint files → parallelizable; the renderer builds against the specified `fallbackActive`/`effectiveBackend` contract.

## DoD
`npm run lint && npm run typecheck && npm test` green (offline; latency/docker/EBADF flakes isolated). New reads tests pass. DEFAULT==TODAY: runner off → `fallbackActive:false`/`effectiveBackend:null`, chip not rendered, banner unchanged, e2e selectors intact (`runner-fallback-chip` absent from a default DOM). `get_runner_status` (MCP + IPC) additively gains the two fields.
