/**
 * Design tokens (phase 10) — the committed visual system from DESIGN.md.
 * Dials: VARIANCE 4 · MOTION 2 · DENSITY 7. Dark, locked.
 *
 * The CSS side of these tokens lives in assets/main.css as a Tailwind v4
 * `@theme` block (bg/surface/raised/line/ink/accent/ok/warn/err/undo — use
 * the utilities: `bg-surface`, `text-ink-mute`, `border-line`, …). This
 * module re-exports the same values for the few places that need them as
 * JavaScript (canvas-free SVG bars in the trace waterfall, inline meter
 * widths). If a value changes, change it in BOTH places — the comment in
 * main.css points back here.
 */

export const color = {
  bg: 'oklch(0.145 0 0)',
  surface: 'oklch(0.185 0 0)',
  raised: 'oklch(0.225 0 0)',
  line: 'oklch(1 0 0 / 9%)',
  lineStrong: 'oklch(1 0 0 / 16%)',
  ink: 'oklch(0.93 0 0)',
  inkMute: 'oklch(0.72 0 0)',
  inkFaint: 'oklch(0.62 0 0)',
  accent: 'oklch(0.68 0.14 268)',
  accentInk: 'oklch(0.97 0.01 268)',
  ok: 'oklch(0.75 0.15 155)',
  warn: 'oklch(0.8 0.14 85)',
  err: 'oklch(0.7 0.19 25)',
  undo: 'oklch(0.72 0.12 315)'
} as const

/**
 * Status → color-token mapping: the single grammar every panel shares
 * (PRODUCT.md principle 5). Keys are the literal status strings the backend
 * emits; anything unmapped renders neutral.
 */
export const statusColor: Readonly<Record<string, keyof typeof color>> = {
  // staged writes
  staged: 'warn',
  approved: 'warn',
  committed: 'ok',
  rejected: 'err',
  // approvals
  pending: 'warn',
  denied: 'err',
  // tasks
  running: 'accent',
  done: 'ok',
  failed: 'err',
  deferred: 'warn',
  // audit / traces / generic
  ok: 'ok',
  error: 'err',
  undone: 'undo',
  // ingest
  created: 'ok',
  replaced: 'accent',
  unchanged: 'ok',
  updated: 'accent',
  flagged: 'err',
  // ollama / subsystems
  ready: 'ok',
  'models-missing': 'warn',
  'daemon-not-running': 'err',
  // runner health (phase 17) — 'unknown' stays unmapped (neutral)
  'not-installed': 'warn',
  'auth-expired': 'err',
  'quota-exhausted': 'warn',
  // runner fallback (phase 21) — subscription down, reasoning degraded-but-working (NOT err)
  fallback: 'warn',
  // app updater (Settings "Updates") — 'idle'/'disabled' stay unmapped (neutral)
  checking: 'accent',
  'up-to-date': 'ok',
  downloading: 'accent',
  downloaded: 'ok',
  // skill versions
  active: 'ok',
  candidate: 'warn',
  retired: 'undo',
  // skill improvement (phase 12)
  adopted: 'ok',
  'drift-flagged': 'warn',
  'rolled-back': 'undo',
  // examples
  success: 'ok',
  failure: 'err'
}

/** Spacing grid (px). DENSITY 7: table rows 34–36, cell pad 8×10. */
export const space = { grid: 4, rowHeight: 34, cellX: 10, cellY: 8, gutter: 20, section: 24 } as const

/** Type scale (px) — no display sizes; a cockpit has no hero. */
export const text = { meta: 11, table: 12, body: 13, section: 14, panel: 16, page: 20 } as const

/** Semantic z-scale (DESIGN.md — never arbitrary values). */
export const z = { stickyHeader: 10, rail: 20, modalBackdrop: 30, modal: 40, toast: 50 } as const

/** MOTION 2: hover/active feedback only. */
export const motion = { hover: '120ms ease-out', overlay: '80ms ease-out' } as const
