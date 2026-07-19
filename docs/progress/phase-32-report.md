# Phase 32 — In-app engineering handbook (Docs panel)

**Status:** done · **Date:** 2026-07-19 · User-directed ("add the documentation in the website into the app").

## What the user asked for

> "add the documentation in the website into the app and then push it"

The marketing site (`agentic_os/website`, a separate Vercel project) carries an **engineering handbook** under `src/pages/learn/*` — nine pages describing every subsystem. The user wanted that reference available **inside the app**, then a release.

## What was built

A new **Docs** panel (nav rail → new **Help** group), a self-contained in-app reading surface that ports the handbook faithfully into the app's design system — no external fetch, renderer-only (no Node, no IPC).

- **`src/renderer/src/ui/docs.tsx`** — the prose/spec/callout grammar ported from the site's `components/site/docs.tsx` + `CodeBlock.tsx` + `primitives.tsx`, remapped onto the app's OKLCH tokens (the site and app share token names, so the classes carried over almost verbatim). Atoms: `DocHeader/DocProse/H2/H3/P/Ul/Li/Strong/Code/CodeBlock/Callout/SpecTable` + the `DOC_NAV` grouping. Marketing/animation components (ArchitectureStack, RetrievalSim, etc.) were deliberately **not** ported — the prose is the substance; each diagram was omitted with its surrounding text intact.
- **`src/renderer/src/panels/DocsPanel.tsx`** — a two-column reading shell: a grouped doc-nav on the left (Start · System design · Internals · Engineering) driving a single scrollable column, with prev/next paging in reading order. `doc-nav-<key>` testids.
- **`src/renderer/src/panels/docs/*.tsx`** — the nine pages: Overview, Architecture, MCP, Retrieval, Memory, Background agents, Security, Tech stack, Build. Overview + Architecture written by hand as the template; the other seven **transcribed faithfully by a 7-way parallel subagent fan-out** (each read one website page and wrote the app page against the shared atoms; every subagent self-verified `tsc` + `eslint` clean).
- **`src/renderer/src/App.tsx`** — `docs` PanelKey + PANELS entry (icon `doc`) + a new `{ label: 'Help', keys: ['docs'] }` nav group.

## Notes / decisions
- Faithful transcription, not paraphrase: all prose, code blocks, spec tables, callouts, and inline data (BOOT list, dependency cards, permission-tier grid, label chips, step-flows) kept verbatim; only the animated marketing diagrams were dropped.
- One narrowing bug in `DocsPanel` (prev/next under `noUncheckedIndexedAccess`) was caught by a subagent and fixed (`?? null`).
- No backend, no IPC, no new deps, no appdata change. `DEFAULT == TODAY` for everything else.

## Definition-of-Done — commands run
- `npm run typecheck` (node + web) → **clean**. `npm run lint` → **clean**. `npm run build` → **all 3 bundles** (renderer +~80 KB / CSS +5 KB from the handbook content, expected).
- **Visual verification** (throwaway hermetic Playwright, since removed): the Docs rail item opens the panel; the doc-nav groups render; Overview → Architecture navigates with the content rendering faithfully (kicker, headings, invariants list); the Tech-stack page renders every dependency card (confirmed via the accessibility tree). Screenshots captured.
- Shipped in the **0.1.13** release.
