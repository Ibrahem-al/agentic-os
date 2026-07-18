# Phase 29 — Tokens-first cost surfaces

**Status:** done · **Date:** 2026-07-18 · User-directed feature (outside the numbered spec plan).

## What the user asked for

> "add token consumption in the cost locations instead of using money since it's hard to evaluate cost from subscription based usage."

Confirmed scope via one question → **"Tokens lead, keep real $"**: token consumption becomes the
headline metric across every cost surface; the genuine *metered cloud* dollar figures stay (secondary),
because those are really billed; the *subscription* runner (flat-fee) is shown in **tokens only** — never a
dollar figure, since its per-token "shadow cost" is meaningless on a subscription.

## Why (the crux)

A repo-wide map (5-agent workflow) established the money-vs-token landscape precisely:
- The `spend` table (metered cloud) already stores `input_tokens`/`output_tokens` **per row**, but
  `getSpendSummary` only ever **summed dollars** — so no token totals existed.
- Subscription-runner work writes **no dollar rows at all** (`reportedCostUsd` is hard-coded 0); its only
  "cost" is `shadowCostUsdEstimate`, a copy of the Claude CLI's per-token price estimate — meaningless on a
  flat plan, and **shown in zero renderers** today. Its token counts were captured but never rendered.
- An established `tokens()` formatter + "tokens in / out" column pattern already existed (private to the
  Usage panel) to reuse.

## What was built

### Backend (additive, no schema change — tokens were already stored)
- **`SpendSummaryDto`** gained `totalInputTokens` / `totalOutputTokens` / `last24hInputTokens` /
  `last24hOutputTokens`; **`SpendTaskAggregateDto`** gained `inputTokens` / `outputTokens`.
- **`getSpendSummary`** (`reads/observability.ts`) now `COALESCE(SUM(input_tokens))` / `SUM(output_tokens)`
  for the total, the 24h window, and each by-task rollup.
- New **`usage.runner`** IPC channel + token-only **`SubscriptionUsageDto`** / **`SubscriptionRunDto`**;
  the `ipc.ts` handler maps `runnerUsage()` and **drops `shadow_cost_usd`** so no fake dollars can reach the
  UI. Always answerable (zeros when the runner never ran).

### Renderer
- **`lib/format.ts`** — lifted `tokens()` out of SpendPanel into the shared formatter and extended it with
  an `M` suffix (`340` · `1.2k` · `1.4M`; `null`→`—`), with a clean k→M rollover.
- **Usage panel (`SpendPanel.tsx`)** — the "Cloud spending" headline now **leads with tokens**
  ("Tokens used" with an `in · out` hint, "Tokens, last 24 h") followed by the dollar stats; the **by-task
  table gained a "tokens in / out" column**; a shared `TokenPair` component replaces the three inline token
  cells. A new **"Subscription runner"** section (tokens + runs + recent runs, **no dollars**) with an
  informative empty state (off by default → points at Settings).
- **Home panel (`HomePanel.tsx`)** — the headline stat now leads with **tokens** ("AI usage, last 24 h",
  value = tokens, `$X on paid models` as the sub-line); the sparkline now buckets **daily tokens**.

Dollars are deliberately kept where they're genuinely metered: the Usage panel's dollar stats and the
per-task `$0.50` **ceiling meter**, and the Approvals `$` chip on a spend request (those are real).

## Key decisions
- **Tokens as the honest common denominator**, dollars retained (not removed) where metered — per the
  user's chosen option. Subscription shows tokens only; its shadow-dollar estimate stays hidden.
- **No appdata migration** — cloud token columns already existed; the runner columns already existed. Pure
  read + DTO + renderer work.
- **`usage.runner` is dashboard-only, read-only** — mirrors the existing `usage.local.summary`.

## Incidental fix
`tsconfig.node.json` now lists `lib/format.ts` + `ui/graph/model.ts` + `ui/graph/colors.ts` in the
DOM-free-renderer-libs allowlist. This satisfies TS6307 for their unit-test imports and **repairs a latent
`npm run typecheck` failure introduced by the phase-28 graph test** (which imported `model.ts`/`colors.ts`;
typecheck happened to be run before that test file existed).

## Adversarial review
A 3-reviewer workflow (backend / renderer / consistency) + a verify pass. Backend and renderer: clean.
One confirmed low finding — `tokens()` rendered the narrow band `[999,950–999,999]` as `"1000.0k"` instead
of `"1.0M"` (`toFixed(1)` rounding across the unit boundary). **Fixed** (k/M threshold at `999_950`) and the
characterization test updated to pin the clean rollover.

## Definition-of-Done — commands run
- `npm run typecheck` → clean (node + web).
- `npm run lint` → clean.
- `npm run build` → main + preload + renderer bundles built.
- Tests: `format.tokens` (unit) + `reads.queries` (spend token sums: `totalInputTokens`/`byTask` tokens/24h
  window) extended; relevant suite (`format.tokens`, `graph.model`, `reads.queries`, `mcp.read-tools`)
  **45 passed**; after the review fix, `format.tokens` **4 passed**.
- e2e `dashboard.ai-processing` (touches the Usage panel) **2 passed**.
- Visual verification (temporary Playwright shots over the demo seed, since removed): the Usage panel's
  Cloud section leads with **"174.0k Tokens used (170.0k in · 4.0k out)"** + "Tokens, last 24 h" with the
  dollar stats secondary; the **Subscription runner** section renders its token framing + empty state; Home
  leads with **"148.7k · AI usage, last 24 h"** and "$0.484 on paid models".

## For the next session
`usage.runner` is the subscription token feed; cloud token totals live on `SpendSummaryDto`. If a
token-based *budget/ceiling* is ever wanted (today the ceiling is per-task USD), that's a new config +
meter — not part of this change. `tokens()` in `lib/format.ts` is the one place to touch token formatting.
