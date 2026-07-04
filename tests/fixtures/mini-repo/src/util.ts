/** Clamp a value into the inclusive range. */
export function clamp(value: number, low: number, high: number): number {
  return Math.min(high, Math.max(low, value))
}

export function formatLabel(name: string): string {
  return name.trim().toUpperCase()
}
