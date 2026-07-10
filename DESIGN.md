# Design

Visual system for the Agentic OS dashboard. Register: product. Dials: VARIANCE 4 · MOTION 2 · DENSITY 7 → ~5.
**Approachability pass (UI redesign):** the audience now includes less technical people, so density is dialed from 7 toward ~5 — plain-English labels lead, technical terms move behind tooltips/"Details", and overviews are visualization-first. Keep the instrument-panel honesty (truthful state, deliberate destructive actions); lose the cockpit clutter. The color system below is unchanged.
Theme: **dark, locked** (single-theme app; scene: low ambient light, long sessions). No light mode in v1 — the window itself declares `color-scheme: dark`.

## Color (OKLCH; anchor seed hue 268 — "considered indigo behind a developer's keyboard at 11pm")

Strategy: restrained. Neutral chroma-0 dark ramp carries 95% of the surface; ONE indigo accent for interactive/selected; semantic green/amber/red/violet carry state and are used nowhere else.

| Token | Value | Role |
|---|---|---|
| `bg` | `oklch(0.145 0 0)` | app canvas |
| `surface` | `oklch(0.185 0 0)` | panel bodies, table headers |
| `raised` | `oklch(0.225 0 0)` | hover rows, inputs, popped elements |
| `line` | `oklch(1 0 0 / 0.09)` | hairline dividers (1px, the only separator) |
| `line-strong` | `oklch(1 0 0 / 0.16)` | input borders, focused container edges |
| `ink` | `oklch(0.93 0 0)` | primary text |
| `ink-mute` | `oklch(0.72 0 0)` | secondary text (4.5:1+ on bg/surface) |
| `ink-faint` | `oklch(0.62 0 0)` | tertiary hints (11px floor; raised from 0.55 in the audit pass for AA) |
| `accent` | `oklch(0.68 0.14 268)` | interactive: links, active nav, focus, selection |
| `accent-ink` | `oklch(0.97 0.01 268)` | text on accent fills |
| `ok` | `oklch(0.75 0.15 155)` | committed / approved / done / ready |
| `warn` | `oklch(0.80 0.14 85)` | pending / staged / queued / degraded |
| `err` | `oklch(0.70 0.19 25)` | denied / failed / blocked / flagged |
| `undo` | `oklch(0.72 0.12 315)` | undone / reverted (distinct from err) |

Rules: pure `#000`/`#fff` never; accent covers ≤10% of any screen; status colors appear only as badge text/tint + the 8px status square in timelines; body text is `ink`, never `ink-faint`.

## Typography

System stacks (desktop app; no webfont fetches, no bundled fonts):
- **UI sans**: `system-ui, "Segoe UI Variable Text", "Segoe UI", sans-serif` — labels, body, headings.
- **Mono**: `ui-monospace, "Cascadia Mono", Consolas, monospace` — ALL numerals, ids, hashes, paths, timestamps, diffs, cypher, JSON (DENSITY 7 rule: numbers are always mono).

Scale (px): 11 (dense meta, mono only), 12 (table body, badges), 13 (default UI body), 14 (panel section heads), 16 (panel title), 20 (page title, weight 600). Line-height 1.4 tables / 1.5 prose. No display sizes — a cockpit has no hero. `tracking` never below -0.01em; no uppercase-tracked eyebrows.

## Layout

- App shell: fixed left rail 216–232px, content area `min-w-0` with per-panel header row (title + one-line plain subtitle + primary action) and scrollable body. Content max-width none — tables stretch.
- Nav is **grouped**, not a flat list: **Home** (default on launch, the visualization-first overview) at top, then labelled groups **Decisions** (Approvals, History), **Knowledge** (Memory, Add knowledge, Skills), **Activity** (Background work, Agent runs, Spending), and **Settings** pinned at the bottom. Group labels are 11px medium sentence-case `ink-mute` — never tracked-caps eyebrows. Nav items are `Icon` + label, 32px tall; the boot-status footer speaks plain words ("All systems running").
- Spacing grid 4px. Table rows ~40px; cell padding 8×10px; panel gutters roomier (20px); section gaps 24px (VARIANCE 4: left-aligned headers over full-bleed data, occasional 2fr/1fr master-detail splits — no perfect symmetry, no masonry).
- Cards banned for data: tables + hairlines + background tint zones. Stats render as a hairline-separated **strip**, not floating cards. The only rounded containers: inputs, badges, buttons, modals, and the `bg-surface` inset of a "Details" disclosure (radius 6px everywhere — one radius system; badges pill).
- z-scale: `sticky-header 10 · rail 20 · modal-backdrop 30 · modal 40 · toast 50`.

## Components

- **Table**: sticky header row (surface bg, 11px mono uppercase-free labels, `ink-mute`), hairline row dividers, hover `raised`, selected row 2px accent inset-left via box-shadow (not border-left-stripe), numeric/id cells mono right-or-left per column, empty state = centered 13px `ink-mute` sentence + the action that populates it.
- **Badge**: 11px mono status pill, tinted bg `color / 0.14` + colored text — always text + color, never dot-only. Shows the **plain label** (from `lib/plain.ts`: waiting / in progress / finished / needs a look …) with the one-sentence explanation in its `title` tooltip; the RAW backend word always stays in `data-status`. Exception: on Approvals staged-write rows the raw word (`staged/approved/rejected/committed`) stays visible as the pill text, plain wording alongside.
- **Confidence**: mono number `0.87` + 32×3px inline meter (no background track — filled portion only against `line`).
- **Buttons**: primary = accent fill; danger = err fill (approve/undo confirm); ghost = hairline border. 28px tall dense, 32px default. `:active` translate-y 1px.
- **Diff view**: mono 12px, `+` lines `ok`-tinted bg `ok/0.08`, `~` lines `warn/0.08`, `−` lines `err/0.08`; property diffs as `key: old → new` (the arrow is the backend's own rendering).
- **Trace waterfall**: rows 24px; span bars 8px tall, accent for ok / err for error spans, offset+width % of trace wall-clock; mono duration right-aligned.
- **Timeline (audit)**: 8px status square + action row; undone rows get `undo` badge and strikethrough-free dimming (`ink-mute`).
- **Toasts**: bottom-right, surface bg + hairline, status-colored 3px top edge, auto-dismiss 5s except errors (sticky).
- **Focus**: 2px accent ring, 2px offset, on every interactive element. Keyboard: arrow-row navigation in tables is nice-to-have; tab order strict.
- **PanelHeader**: title + optional subdued `Icon` left of it + a one-line plain-English `subtitle` (12–13px `ink-mute`) under every panel title, saying in plain words what the panel is for.
- **Disclosure** ("Details"): chevron + summary button (`aria-expanded`), children in a `bg-surface` inset. The home for ids, hashes, model names, raw JSON, and provenance — progressive disclosure, never the first thing a row says.
- **Charts** (hand-rolled inline SVG, tokens only, `role="img"` + takeaway `aria-label`, all numerals mono, every chart has a plain-words empty state): `Sparkline` (accent line + last dot), `BarChart` (vertical bars, 2px top radius, first/last axis ticks), `MeterBar` (capacity: ok <70% / warn 70–90% / err ≥90%), `CompositionBar` (one 8px stacked part-of-whole bar + wrapping legend). `accent` = primary series; ok/warn/err only for semantic state; `line` for gridlines/tracks. No pies, no 3D, no gradient fills.
- **StatStrip**: hairline-separated horizontal strip (NOT cards) — 20px mono value (toned only when a `tone` is set), 12px `ink-mute` sentence-case label, optional 60×20 sparkline, optional `ink-mute` hint line (`ink-faint` is banned for body/hints).
- **Icons**: hand-drawn 16×16 inline SVG, `stroke="currentColor"`, 1.5 stroke, round caps/joins, `aria-hidden`; one consistent line set, no filled blobs. Icon-only controls carry an `aria-label`.
- **Empty state**: plain sentence saying why it's empty and what fills it, plus an optional action and optional icon (e.g. "No memory changes waiting — when an agent proposes something, it appears here").

## Motion (MOTION 2)

Hover/active/focus transitions only: `background-color, border-color, opacity 120ms ease-out`. Modal/toast: 80ms fade + 4px translate. No entrance animations, no staggers, no loops, no parallax. `prefers-reduced-motion: reduce` → transitions 0ms.

## Voice

Sentence-case, plain English, concrete — written for someone who is not a developer. Prefer the plain word over the jargon: **Approvals** not "review queue", **History** not "audit log", **Spending** not "spend", **Agent runs** not "traces", **Add knowledge** not "ingest", "proposed memory change" not "staged write", "safety flag" not "injection flag", "local AI helper (Ollama)" not "embedder". The plain-language dictionary and status labels live once in `lib/plain.ts`; never restyle a status word inline per panel. Explain *why* something is empty and *what* will populate it. Technical identifiers (ids, hashes, model names, JSON) stay mono and move behind "Details" — visible on demand. Keep test-asserted strings and formats exact (`adoption mode: verifiable`, `name@version/model`, `N ingested`, the raw review status words). Errors verbatim from backend. No em-dashes in UI strings; hyphens fine. Timestamps: relative (`4m ago`) with absolute ISO on hover/title; mono.
