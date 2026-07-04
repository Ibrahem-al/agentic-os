/**
 * Structure-aware chunker (§20: split on headings/code fences, ~512 tokens,
 * 64 overlap). Pure unit tests — no storage, no models.
 */
import { describe, expect, it } from 'vitest'
import { chunkDocument } from '../../src/main/ingest'
import { CHUNK_OVERLAP_TOKENS, CHUNK_TARGET_TOKENS } from '../../src/main/config'
import { estimatingTokenCounter } from '../../src/main/retrieval'

const counter = estimatingTokenCounter()

/** ~n estimated tokens of distinct alphabetic filler, one sentence per line. */
function filler(n: number, seed: string): string {
  const lines: string[] = []
  let tokens = 0
  let i = 0
  while (tokens < n) {
    const line = `the ${seed} pipeline processes batch ${'x'.repeat((i % 5) + 2)} of records during stage ${seed}${i} without pause`
    lines.push(line)
    tokens += counter.count(line) + 1
    i += 1
  }
  return lines.join('\n')
}

describe('markdown structure', () => {
  it('every heading starts a new chunk (headings are chunk boundaries)', () => {
    const md = [
      'Intro paragraph before any heading.',
      '',
      '# Guide',
      'Alpha section body.',
      '',
      '## Setup',
      'Beta section body.',
      '',
      '## Usage',
      'Gamma section body.'
    ].join('\n')
    const chunks = chunkDocument(md)
    expect(chunks.map((c) => c.text.split('\n')[0])).toEqual(['Intro paragraph before any heading.', '# Guide', '## Setup', '## Usage'])
    expect(chunks.map((c) => c.index)).toEqual([0, 1, 2, 3])
  })

  it('tracks the heading trail (outermost first)', () => {
    const md = ['# Guide', 'a', '## Setup', 'b', '### Windows', 'c', '## Usage', 'd'].join('\n')
    const chunks = chunkDocument(md)
    expect(chunks.map((c) => [...c.headingTrail])).toEqual([
      ['Guide'],
      ['Guide', 'Setup'],
      ['Guide', 'Setup', 'Windows'],
      ['Guide', 'Usage']
    ])
  })

  it('keeps a code fence atomic when it fits the target', () => {
    const code = ['```ts', ...Array.from({ length: 20 }, (_, i) => `const value${i} = compute(${i})`), '```'].join('\n')
    const md = `# Code\nBefore the fence.\n\n${code}\n\nAfter the fence.`
    const chunks = chunkDocument(md)
    const withFence = chunks.filter((c) => c.text.includes('```ts'))
    expect(withFence).toHaveLength(1)
    // The opening fence's chunk also holds the closing fence — never split.
    expect((withFence[0]?.text.match(/```/g) ?? []).length).toBe(2)
  })

  it('splits an oversized code fence by lines, re-wrapping every piece in fences', () => {
    const lines = Array.from({ length: 400 }, (_, i) => `execute step number ${'y'.repeat((i % 7) + 1)} in job queue`)
    const md = ['```sh', ...lines, '```'].join('\n')
    const chunks = chunkDocument(md)
    expect(chunks.length).toBeGreaterThan(1)
    for (const chunk of chunks) {
      expect(chunk.text.startsWith('```sh')).toBe(true)
      expect(chunk.text.endsWith('```')).toBe(true)
      expect(chunk.tokens).toBeLessThanOrEqual(CHUNK_TARGET_TOKENS + CHUNK_OVERLAP_TOKENS)
    }
  })
})

describe('token target + overlap (§20: ~512 tokens, 64 overlap)', () => {
  it('packs a long section into ~target chunks with line-granular overlap', () => {
    const body = filler(1600, 'harvest')
    const chunks = chunkDocument(`# Long\n${body}`)
    expect(chunks.length).toBeGreaterThanOrEqual(3)
    for (const chunk of chunks) {
      expect(chunk.tokens).toBeLessThanOrEqual(CHUNK_TARGET_TOKENS + CHUNK_OVERLAP_TOKENS)
    }
    // Consecutive size-split chunks share overlap: the next chunk starts with
    // trailing lines of the previous one.
    for (let i = 1; i < chunks.length; i++) {
      const prevLines = (chunks[i - 1]?.text ?? '').split('\n')
      const firstLine = (chunks[i]?.text ?? '').split('\n')[0]
      expect(prevLines).toContain(firstLine)
    }
  })

  it('never carries overlap across a heading boundary', () => {
    const md = `# One\n${filler(100, 'apple')}\n\n# Two\nfresh start line`
    const chunks = chunkDocument(md)
    const two = chunks.find((c) => c.text.startsWith('# Two'))
    expect(two).toBeDefined()
    expect(two?.text).not.toContain('apple')
  })

  it('hard-splits a single pathological line without stalling', () => {
    const oneLine = 'z'.repeat(20_000)
    const chunks = chunkDocument(oneLine, { format: 'plain' })
    expect(chunks.length).toBeGreaterThan(1)
    expect(chunks.map((c) => c.text).join('')).toContain('zzzz')
    for (const chunk of chunks) expect(chunk.tokens).toBeLessThanOrEqual(CHUNK_TARGET_TOKENS + CHUNK_OVERLAP_TOKENS)
  })
})

describe('plain format', () => {
  it('does not treat # lines as structure (source-file comments stay inline)', () => {
    const py = ['# not a heading, a python comment', 'value = 1', '', 'other = 2'].join('\n')
    const chunks = chunkDocument(py, { format: 'plain' })
    expect(chunks).toHaveLength(1)
    expect(chunks[0]?.text).toContain('# not a heading')
  })

  it('splits on blank-line paragraphs when the target fills', () => {
    const text = `${filler(400, 'quartz')}\n\n${filler(400, 'basalt')}`
    const chunks = chunkDocument(text, { format: 'plain' })
    expect(chunks.length).toBeGreaterThanOrEqual(2)
  })
})

describe('edge cases + validation', () => {
  it('returns [] for empty/whitespace content', () => {
    expect(chunkDocument('')).toEqual([])
    expect(chunkDocument('  \n\n\t')).toEqual([])
  })

  it('normalizes CRLF', () => {
    const chunks = chunkDocument('# A\r\nline one\r\n\r\n# B\r\nline two')
    expect(chunks).toHaveLength(2)
    expect(chunks[0]?.text).not.toContain('\r')
  })

  it('rejects dishonest options loudly', () => {
    expect(() => chunkDocument('x', { targetTokens: 4 })).toThrow(/targetTokens/)
    expect(() => chunkDocument('x', { overlapTokens: 600 })).toThrow(/overlapTokens/)
    expect(() => chunkDocument('x', { targetTokens: 100, overlapTokens: 100 })).toThrow(/overlapTokens/)
  })

  it('token counts are the estimating counter on the exact chunk text', () => {
    const chunks = chunkDocument('# T\nshort body text')
    expect(chunks[0]?.tokens).toBe(counter.count(chunks[0]?.text ?? ''))
  })
})
