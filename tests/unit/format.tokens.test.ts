/**
 * The shared `tokens()` formatter (lib/format) — the tokens-first cost metric's
 * display grammar: plain integers below 1k, one-decimal k, one-decimal M, and
 * '—' for absent counts.
 */
import { describe, expect, it } from 'vitest'
import { tokens } from '../../src/renderer/src/lib/format'

describe('tokens()', () => {
  it("renders '—' for null/undefined", () => {
    expect(tokens(null)).toBe('—')
    expect(tokens(undefined)).toBe('—')
  })

  it('prints plain integers below 1000', () => {
    expect(tokens(0)).toBe('0')
    expect(tokens(1)).toBe('1')
    expect(tokens(999)).toBe('999')
  })

  it('collapses thousands to one-decimal k', () => {
    expect(tokens(1000)).toBe('1.0k')
    expect(tokens(1200)).toBe('1.2k')
    expect(tokens(999_949)).toBe('999.9k') // top of the k range
  })

  it('collapses millions to one-decimal M, rolling over cleanly at ~1M', () => {
    // Values that would round to "1000.0k" promote to "1.0M" (no four-digit k).
    expect(tokens(999_950)).toBe('1.0M')
    expect(tokens(999_999)).toBe('1.0M')
    expect(tokens(1_000_000)).toBe('1.0M')
    expect(tokens(1_420_000)).toBe('1.4M')
    expect(tokens(15_500_000)).toBe('15.5M')
  })
})
