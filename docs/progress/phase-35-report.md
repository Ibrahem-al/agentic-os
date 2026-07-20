# Phase 35 — Graph settles gently instead of re-exploding

**Status:** done · **Date:** 2026-07-20 · User-directed ("whenever the user does anything with the visual knowledge graph the graph nodes move around like crazy and it takes them a bit to settle down — find a way to avoid that").

## The problem
Every interaction that re-derives the visible node set — switching to local/focus mode, changing depth, or **searching** (which recomputes `visible` via `focusKey` even when the node set is unchanged) — ran the force-sim rebuild effect, which slammed `alphaRef` to `ALPHA_REHEAT_DATA = 0.9`. Since node positions are **preserved by key** across a rebuild, 0.9 energy on an already-settled layout throws every node across the canvas and it takes a second or two to re-converge. It looked like the graph "explodes" on every click.

## The fix (`src/renderer/src/ui/graph/ForceGraph.tsx`)
Reheat is now proportional to how much actually changed:
- **Cold start** (`prevPositions.size === 0`, the very first layout forming from the spiral seed) keeps the full `ALPHA_REHEAT_DATA = 0.9` — it genuinely needs the energy.
- **Warm rebuild** (re-filter / mode change / search over an existing layout) uses a gentle `ALPHA_REHEAT_WARM = 0.12`, scaled up only by the fraction of genuinely-new nodes (`newCount / nextNodes.length`), capped at `0.3`. A search that changes nothing new → 0.12, a barely-perceptible settle; a rebuild that adds a few nodes → a small nudge so the newcomers ease in without disturbing the rest.
- **Drag reheat** lowered `0.35 → 0.2` (a drag should nudge neighbors, not shake the whole graph).
- **Fit signal** (toolbar "Fit" / mode change) no longer bumps alpha at all — it only sets `needsFitRef`/`dirtyRef` to re-frame the current layout. Re-centering should never re-jiggle; a mode change already picked its own gentle alpha in the rebuild effect.

Net: positions persist, and the sim adds just enough energy to absorb real change. No re-explosion on search/filter/mode/fit.

## Files touched
`src/renderer/src/ui/graph/ForceGraph.tsx` only (3 reheat constants, `newCount` tracking in the rebuild loop, the cold/warm alpha branch, and the fit-effect reheat removal).

## Definition-of-Done — commands run
- `npm run typecheck` (node + web) → **clean**. `npm run lint` → **clean**.
- The force sim is a hand-rolled canvas loop with no unit coverage (consistent with the rest of the renderer viz); the change is a behavioral tuning of the reheat energy, verified by reasoning about the preserved-position invariant. No appdata change, no new deps. `DEFAULT == TODAY` for a cold first render (still 0.9).
