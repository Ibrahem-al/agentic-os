# Design

Visual system for the Agentic OS dashboard (phase 10). Register: product. Dials: VARIANCE 4 · MOTION 2 · DENSITY 7.
Theme: **dark, locked** (single-theme app; scene: operator's second monitor, low ambient light, long sessions). No light mode in v1 — the window itself declares `color-scheme: dark`.

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

- App shell: fixed left rail 216px (nav: 9 panels + boot status footer), content area `min-w-0` with per-panel header row (title + primary action) and scrollable body. Content max-width none — density wins, tables stretch.
- Spacing grid 4px. Table rows 34–36px; cell padding 8×10px; panel gutter 16–20px; section gaps 24px (VARIANCE 4: left-aligned headers over full-bleed data, occasional 2fr/1fr master-detail splits — no perfect symmetry, no masonry).
- Cards banned for data (DENSITY 7): tables + hairlines + background tint zones. The only rounded containers: inputs, badges, buttons, modals (radius 6px everywhere — one radius system; badges pill).
- z-scale: `sticky-header 10 · rail 20 · modal-backdrop 30 · modal 40 · toast 50`.

## Components

- **Table**: sticky header row (surface bg, 11px mono uppercase-free labels, `ink-mute`), hairline row dividers, hover `raised`, selected row 2px accent inset-left via box-shadow (not border-left-stripe), numeric/id cells mono right-or-left per column, empty state = centered 13px `ink-mute` sentence + the action that populates it.
- **Badge**: 11px mono lowercase status word, pill, tinted bg `color / 0.14` + colored text — always text + color, never dot-only.
- **Confidence**: mono number `0.87` + 32×3px inline meter (no background track — filled portion only against `line`).
- **Buttons**: primary = accent fill; danger = err fill (approve/undo confirm); ghost = hairline border. 28px tall dense, 32px default. `:active` translate-y 1px.
- **Diff view**: mono 12px, `+` lines `ok`-tinted bg `ok/0.08`, `~` lines `warn/0.08`, `−` lines `err/0.08`; property diffs as `key: old → new` (the arrow is the backend's own rendering).
- **Trace waterfall**: rows 24px; span bars 8px tall, accent for ok / err for error spans, offset+width % of trace wall-clock; mono duration right-aligned.
- **Timeline (audit)**: 8px status square + action row; undone rows get `undo` badge and strikethrough-free dimming (`ink-mute`).
- **Toasts**: bottom-right, surface bg + hairline, status-colored 3px top edge, auto-dismiss 5s except errors (sticky).
- **Focus**: 2px accent ring, 2px offset, on every interactive element. Keyboard: arrow-row navigation in tables is nice-to-have; tab order strict.

## Motion (MOTION 2)

Hover/active/focus transitions only: `background-color, border-color, opacity 120ms ease-out`. Modal/toast: 80ms fade + 4px translate. No entrance animations, no staggers, no loops, no parallax. `prefers-reduced-motion: reduce` → transitions 0ms.

## Voice

Labels are lowercase-sentence, terse, concrete: "approve", "undo", "12 staged", "no pending approvals — agent actions that need consent will queue here". Errors verbatim from backend. No em-dashes in UI strings; hyphens fine. Timestamps: relative (`4m ago`) with absolute ISO on hover/title; mono.
