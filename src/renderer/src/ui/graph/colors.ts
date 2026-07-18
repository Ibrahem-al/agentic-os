/**
 * Per-label node colors for the knowledge-graph visualization. Obsidian assigns
 * each group a distinct hue; here every §18 node label gets one, drawn from the
 * same OKLCH family as the dark theme (design-tokens.ts) — uniform lightness and
 * chroma so no color screams, distinct hues so labels stay tellable apart. Tag
 * is intentionally neutral gray (a structural label, not a content type).
 *
 * The Record over IpcNodeLabel keeps this exhaustive: a new node label fails the
 * build until it is given a color here.
 */
import type { IpcNodeLabel } from '../../../../shared/ipc'

const L = 0.72
const C = 0.14

/** OKLCH at the shared lightness/chroma, varying only hue. */
const hue = (h: number): string => `oklch(${L} ${C} ${h})`

export const GRAPH_LABEL_COLOR: Readonly<Record<IpcNodeLabel, string>> = {
  Session: hue(268), // blue (the theme accent family)
  Project: hue(150), // green
  Skill: hue(300), // violet
  SkillVersion: hue(330), // magenta
  Example: hue(85), // amber
  Correction: hue(25), // red
  Preference: hue(350), // pink
  MCP: hue(220), // azure
  Plugin: hue(195), // cyan
  Component: hue(135), // emerald
  Document: hue(65), // gold
  Knowledge: hue(250), // indigo
  Tag: `oklch(0.68 0 0)` // neutral gray
}

/** Color for a label, falling back to a mid gray for anything unmapped. */
export function colorForLabel(label: string): string {
  return GRAPH_LABEL_COLOR[label as IpcNodeLabel] ?? 'oklch(0.68 0 0)'
}

/**
 * Same color at a given alpha (for dimming un-highlighted nodes/edges). Our
 * palette strings are always `oklch(L C H)` — inject the `/ a` slot before `)`.
 */
export function withAlpha(oklch: string, alpha: number): string {
  const a = Math.max(0, Math.min(1, alpha))
  return oklch.replace(/\)\s*$/, ` / ${a})`)
}
