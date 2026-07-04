/**
 * Estimating token counter: conservative (overestimates vs the ~4 chars/token
 * English average) and per-provider, behind the TokenCounter interface the
 * phase-04 context manager will re-implement with real tokenizers.
 */
import { describe, expect, it } from 'vitest'
import { estimatingTokenCounter } from '../../src/main/retrieval'

describe('estimatingTokenCounter', () => {
  it('counts empty text as zero', () => {
    expect(estimatingTokenCounter().count('')).toBe(0)
  })

  it('is conservative: at least chars/4 for every provider', () => {
    const text = 'take a warehouse backup before destructive database operations'
    for (const provider of ['anthropic', 'openai', 'gemini', 'openrouter'] as const) {
      expect(estimatingTokenCounter(provider).count(text)).toBeGreaterThanOrEqual(
        Math.ceil(text.length / 4)
      )
    }
  })

  it('is monotone in text length', () => {
    const counter = estimatingTokenCounter()
    expect(counter.count('short')).toBeLessThan(counter.count('a considerably longer sentence than that one'))
  })

  it('defaults to the default cloud provider (anthropic ratio)', () => {
    const text = 'x'.repeat(330)
    expect(estimatingTokenCounter().count(text)).toBe(estimatingTokenCounter('anthropic').count(text))
    expect(estimatingTokenCounter('anthropic').count(text)).toBe(100)
    expect(estimatingTokenCounter('openai').count(text)).toBe(Math.ceil(330 / 3.6))
  })

  it('bills non-ASCII (CJK etc.) at a token per character so it stays conservative', () => {
    const counter = estimatingTokenCounter()
    const cjk = '数据库表使用蛇形复数命名'
    expect(counter.count(cjk)).toBe(cjk.length)
    expect(counter.count(`abc ${cjk}`)).toBe(Math.ceil(4 / 3.3) + cjk.length)
  })
})
