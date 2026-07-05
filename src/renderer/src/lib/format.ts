/** Shared formatting grammar (DESIGN.md voice: terse, mono numerals). */

/** Relative time ("4m ago"); pair with `title={iso}` for the absolute form. */
export function relTime(iso: string | null | undefined): string {
  if (iso == null || iso === '') return ''
  const then = Date.parse(iso)
  if (Number.isNaN(then)) return iso
  const seconds = Math.round((Date.now() - then) / 1000)
  if (seconds < 0) return 'now'
  if (seconds < 60) return `${seconds}s ago`
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.round(minutes / 60)
  if (hours < 48) return `${hours}h ago`
  const days = Math.round(hours / 24)
  if (days < 60) return `${days}d ago`
  return iso.slice(0, 10)
}

export function relTimeMs(unixMs: number): string {
  return relTime(new Date(unixMs).toISOString())
}

/** USD with sub-cent precision (spend rows are fractions of a cent). */
export function usd(value: number): string {
  if (value === 0) return '$0.00'
  return value < 0.01 ? `$${value.toFixed(4)}` : `$${value.toFixed(2)}`
}

/** Milliseconds with unit collapse: 840ms · 2.3s · 4m 12s. */
export function duration(ms: number | null | undefined): string {
  if (ms == null) return '…'
  if (ms < 1000) return `${Math.round(ms)}ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`
  const minutes = Math.floor(ms / 60_000)
  const seconds = Math.round((ms % 60_000) / 1000)
  return `${minutes}m ${seconds}s`
}

export function truncate(text: string, max = 120): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text
}

/** Confidence as the backend writes it: two decimals, mono. */
export function conf(value: number | null | undefined): string {
  return value == null ? '' : value.toFixed(2)
}

export function count(n: number, singular: string, plural = `${singular}s`): string {
  return `${n} ${n === 1 ? singular : plural}`
}
