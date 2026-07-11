/**
 * Readability addendum R2: friendly graph-property labels. The raw key stays
 * available for the caller's tooltip; the label is what the inspector shows.
 */
import { describe, expect, it } from 'vitest'
import { plainPropLabel } from '../../src/renderer/src/lib/plain'

describe('plainPropLabel', () => {
  it('maps high-traffic keys to plain phrases', () => {
    expect(plainPropLabel('Preference', 'statement')).toBe('what it says')
    expect(plainPropLabel('Skill', 'project_count')).toBe('used in projects')
    expect(plainPropLabel('Document', 'source')).toBe('where it came from')
    expect(plainPropLabel('Skill', 'kind')).toBe('type')
  })

  it('falls back to the key with underscores turned to spaces', () => {
    expect(plainPropLabel('Document', 'content_hash')).toBe('content hash')
    expect(plainPropLabel('Anything', 'some_unmapped_key')).toBe('some unmapped key')
  })
})
