/**
 * Tiny inline-SVG/token chart kit for the plain-language redesign. Hand-rolled
 * (no chart dependency), tokens only, all numerals mono, every chart carries a
 * role="img" + aria-label stating the takeaway and a plain-words empty state.
 * Follows DESIGN.md: dark locked, MOTION 2 (no load motion), hairline strips
 * over cards. Bar/meter/composition fills reuse the kit's div-bar idiom (see
 * Confidence in kit.tsx and the trace waterfall) so rounded corners stay crisp
 * at any width; Sparkline is the one true SVG (it needs a polyline).
 */

// ── tint → token maps (literal class strings so Tailwind's scanner keeps them) ──

type BarTint = 'accent' | 'ok' | 'warn' | 'err'
type CompTint = 'accent' | 'ok' | 'warn' | 'err' | 'undo' | 'mute'
type StatTone = 'ok' | 'warn' | 'err'

const BAR_BG: Record<BarTint, string> = {
  accent: 'bg-accent',
  ok: 'bg-ok',
  warn: 'bg-warn',
  err: 'bg-err'
}

const COMP_BG: Record<CompTint, string> = {
  accent: 'bg-accent',
  ok: 'bg-ok',
  warn: 'bg-warn',
  err: 'bg-err',
  undo: 'bg-undo',
  mute: 'bg-ink-mute'
}

const STAT_TONE: Record<StatTone, string> = {
  ok: 'text-ok',
  warn: 'text-warn',
  err: 'text-err'
}

// ── sparkline ───────────────────────────────────────────────────────────────

/**
 * Trend line for a stat: accent 1.5px stroke + a dot on the last point. Under
 * two points there is no trend to draw, so it renders a muted em-dash instead
 * of an empty box.
 */
export function Sparkline({
  values,
  width = 60,
  height = 20,
  ariaLabel
}: {
  values: readonly number[]
  width?: number
  height?: number
  ariaLabel: string
}): React.JSX.Element {
  if (values.length < 2) {
    return (
      <span
        role="img"
        aria-label={ariaLabel}
        className="inline-block text-center font-mono text-[11px] text-ink-mute"
        style={{ width, height, lineHeight: `${height}px` }}
      >
        —
      </span>
    )
  }
  const pad = 2 // room for the 1.5px stroke and the end dot
  const min = Math.min(...values)
  const max = Math.max(...values)
  const span = max - min
  const innerW = width - pad * 2
  const innerH = height - pad * 2
  const x = (i: number): number => pad + (i / (values.length - 1)) * innerW
  // Flat series sit on the mid-line; otherwise higher value = higher on screen.
  const y = (v: number): number => pad + (span === 0 ? innerH / 2 : (1 - (v - min) / span) * innerH)
  const points = values.map((v, i) => `${x(i).toFixed(2)},${y(v).toFixed(2)}`).join(' ')
  const lastValue = values[values.length - 1] ?? 0
  return (
    <svg
      role="img"
      aria-label={ariaLabel}
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
    >
      <polyline
        points={points}
        fill="none"
        className="stroke-accent"
        strokeWidth={1.5}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <circle cx={x(values.length - 1)} cy={y(lastValue)} r={1.75} className="fill-accent" />
    </svg>
  )
}

// ── bar chart ───────────────────────────────────────────────────────────────

/**
 * Vertical bars with a 2px-rounded top; hover shows the value via the native
 * title tooltip. Only the first and last x labels print (sparse ticks). Empty
 * input renders a plain sentence, never an empty frame.
 */
export function BarChart({
  bars,
  height = 48,
  ariaLabel,
  formatValue
}: {
  bars: readonly { label: string; value: number; tint?: BarTint }[]
  height?: number
  ariaLabel: string
  formatValue?: (v: number) => string
}): React.JSX.Element {
  if (bars.length === 0) {
    return <div className="text-[12px] text-ink-mute">No activity yet.</div>
  }
  const fmt = formatValue ?? ((v: number): string => String(v))
  const max = Math.max(...bars.map((b) => b.value), 0)
  const first = bars[0]
  const last = bars[bars.length - 1]
  return (
    <figure role="img" aria-label={ariaLabel} className="flex flex-col gap-1">
      <div className="flex items-end gap-1" style={{ height }}>
        {bars.map((bar, i) => {
          const pct = max > 0 ? Math.max(0, bar.value / max) * 100 : 0
          // Non-zero days keep a 3px floor so a small value is still visible; a
          // true zero draws no fill and reads as an empty track, not a bar.
          const fillHeight = bar.value <= 0 ? '0px' : `max(3px, ${pct.toFixed(2)}%)`
          return (
            <div key={`${bar.label}-${i}`} className="flex h-full min-w-0 flex-1 items-end justify-center">
              {/* Subtle full-height track (bg-line, matching MeterBar) gives every
                  slot a consistent floor, so a zero day reads as "zero" instead of
                  a broken bar; the fill is capped at 28px and centred in the slot. */}
              <div
                title={`${bar.label}: ${fmt(bar.value)}`}
                className="relative flex h-full w-full max-w-[28px] items-end overflow-hidden rounded-t-[2px] bg-line"
              >
                <div
                  className={`w-full rounded-t-[2px] ${BAR_BG[bar.tint ?? 'accent']}`}
                  style={{ height: fillHeight }}
                />
              </div>
            </div>
          )
        })}
      </div>
      <div className="flex justify-between gap-2 font-mono text-[11px] text-ink-mute">
        <span className="truncate">{first?.label}</span>
        {bars.length > 1 && <span className="truncate">{last?.label}</span>}
      </div>
    </figure>
  )
}

// ── meter bar ───────────────────────────────────────────────────────────────

/**
 * Horizontal capacity meter: comfortable fill under 70%, watch at 70–90%, over
 * budget at 90%+. Right-aligned mono "X of Y" readout; a non-positive max means
 * there is no ceiling to measure against.
 */
export function MeterBar({
  value,
  max,
  label,
  formatValue,
  testId
}: {
  value: number
  max: number
  label: string
  formatValue?: (v: number) => string
  testId?: string
}): React.JSX.Element {
  const fmt = formatValue ?? ((v: number): string => String(v))
  const hasLimit = max > 0
  const ratio = hasLimit ? Math.max(0, Math.min(1, value / max)) : 0
  const fillCls = ratio >= 0.9 ? 'bg-err' : ratio >= 0.7 ? 'bg-warn' : 'bg-ok'
  const readout = hasLimit ? `${fmt(value)} of ${fmt(max)}` : 'no limit set'
  return (
    <div className="flex flex-col gap-1" {...(testId !== undefined ? { 'data-testid': testId } : {})}>
      <div className="flex items-baseline justify-between gap-3">
        <span className="text-[12px] text-ink-mute">{label}</span>
        <span className="font-mono text-[12px] text-ink">{readout}</span>
      </div>
      <div
        className="h-2 w-full overflow-hidden rounded-full bg-line"
        role="img"
        aria-label={`${label}: ${readout}`}
      >
        {hasLimit && (
          <div className={`h-full rounded-full ${fillCls}`} style={{ width: `${Math.round(ratio * 100)}%` }} />
        )}
      </div>
    </div>
  )
}

// ── composition bar ─────────────────────────────────────────────────────────

/**
 * One stacked horizontal bar for part-of-whole (the preferred alternative to a
 * pie) plus a wrapping legend of "swatch label count". Zero total renders a
 * plain empty line.
 */
export function CompositionBar({
  segments,
  ariaLabel,
  showLegend = true
}: {
  segments: readonly { label: string; count: number; tint: CompTint }[]
  ariaLabel: string
  showLegend?: boolean
}): React.JSX.Element {
  const visible = segments.filter((s) => s.count > 0)
  const total = visible.reduce((sum, s) => sum + s.count, 0)
  if (total === 0) {
    return <div className="text-[12px] text-ink-mute">Nothing to show yet.</div>
  }
  return (
    <div className="flex flex-col gap-2">
      <div className="flex h-2 w-full overflow-hidden rounded-full bg-line" role="img" aria-label={ariaLabel}>
        {visible.map((s, i) => (
          <div
            key={`${s.label}-${i}`}
            className={COMP_BG[s.tint]}
            style={{ width: `${(s.count / total) * 100}%` }}
            title={`${s.label}: ${s.count}`}
          />
        ))}
      </div>
      {showLegend && (
        <div className="flex flex-wrap gap-x-4 gap-y-1 text-[12px]">
          {visible.map((s, i) => (
            <span key={`${s.label}-${i}`} className="inline-flex items-center gap-1.5">
              <span aria-hidden="true" className={`inline-block size-2 rounded-[2px] ${COMP_BG[s.tint]}`} />
              <span className="text-ink-mute">{s.label}</span>
              <span className="font-mono text-ink">{s.count}</span>
            </span>
          ))}
        </div>
      )}
    </div>
  )
}

// ── stat strip ──────────────────────────────────────────────────────────────

/**
 * Hairline-separated horizontal strip of headline numbers (wraps on narrow
 * widths) — the calm replacement for hero-metric cards. Each stat: a 20px mono
 * value (toned when a state tone is set), a sentence-case label, and an
 * optional trailing sparkline and hint line.
 */
export function StatStrip({
  stats
}: {
  stats: readonly {
    label: string
    value: string
    hint?: string
    spark?: readonly number[]
    tone?: StatTone
    testId?: string
  }[]
}): React.JSX.Element {
  return (
    <div className="flex flex-wrap">
      {stats.map((stat, i) => (
        <div
          key={`${stat.label}-${i}`}
          className={`flex flex-col gap-0.5 py-2 pr-5 ${i > 0 ? 'border-l border-line pl-5' : ''}`}
          {...(stat.testId !== undefined ? { 'data-testid': stat.testId } : {})}
        >
          <div className="flex items-center gap-2">
            <span
              className={`font-mono text-[20px] leading-6 ${stat.tone !== undefined ? STAT_TONE[stat.tone] : 'text-ink'}`}
            >
              {stat.value}
            </span>
            {stat.spark !== undefined && (
              <Sparkline values={stat.spark} ariaLabel={`${stat.label} trend`} />
            )}
          </div>
          <span className="text-[12px] text-ink-mute">{stat.label}</span>
          {stat.hint !== undefined && <span className="text-[12px] text-ink-mute">{stat.hint}</span>}
        </div>
      ))}
    </div>
  )
}
