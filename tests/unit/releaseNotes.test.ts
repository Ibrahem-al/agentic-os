/**
 * The pure patch-notes parser (renderer lib) — the block grammar only; the React
 * rendering is exercised implicitly (every node has string children). This pins
 * the closed grammar and the SAFETY property that a link's URL is discarded.
 */
import { describe, expect, it } from 'vitest'
import { parseReleaseNotes } from '../../src/renderer/src/lib/releaseNotesParser'

describe('parseReleaseNotes', () => {
  it('empty / whitespace input yields no blocks', () => {
    expect(parseReleaseNotes('')).toEqual([])
    expect(parseReleaseNotes('\n\n  \n')).toEqual([])
  })

  it('headings of any level become a single heading block with the marker stripped', () => {
    expect(parseReleaseNotes('# Big')).toEqual([{ kind: 'heading', text: 'Big' }])
    expect(parseReleaseNotes('### Smaller title')).toEqual([{ kind: 'heading', text: 'Smaller title' }])
  })

  it('consecutive -/*/+/numbered bullets group into one flat list', () => {
    const blocks = parseReleaseNotes('- one\n* two\n+ three\n1. four')
    expect(blocks).toEqual([{ kind: 'list', items: ['one', 'two', 'three', 'four'] }])
  })

  it('a blank line separates a list from a following paragraph', () => {
    const blocks = parseReleaseNotes('- a\n- b\n\nAfter the list')
    expect(blocks).toEqual([
      { kind: 'list', items: ['a', 'b'] },
      { kind: 'para', text: 'After the list' }
    ])
  })

  it('fenced blocks are captured verbatim (inline OFF)', () => {
    const blocks = parseReleaseNotes('```\nnpm run **build**\n```')
    expect(blocks).toEqual([{ kind: 'code', text: 'npm run **build**' }])
  })

  it('an unterminated fence still closes gracefully', () => {
    const blocks = parseReleaseNotes('```\nline1\nline2')
    expect(blocks).toEqual([{ kind: 'code', text: 'line1\nline2' }])
  })

  it('plain lines each become their own paragraph; blanks are separators', () => {
    expect(parseReleaseNotes('first line\n\nsecond line')).toEqual([
      { kind: 'para', text: 'first line' },
      { kind: 'para', text: 'second line' }
    ])
  })

  it('a realistic release body parses into the expected block sequence', () => {
    const body = ['## 0.1.16', '', 'Fixes:', '- fixed a crash', '- **faster** startup', '', 'See `config.ts`.'].join('\n')
    expect(parseReleaseNotes(body)).toEqual([
      { kind: 'heading', text: '0.1.16' },
      { kind: 'para', text: 'Fixes:' },
      { kind: 'list', items: ['fixed a crash', '**faster** startup'] },
      { kind: 'para', text: 'See `config.ts`.' }
    ])
  })
})
