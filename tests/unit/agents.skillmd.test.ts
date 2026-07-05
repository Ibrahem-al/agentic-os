/**
 * SKILL.md format (phase 12) — the vendored skill-creator rules,
 * reimplemented and pinned: frontmatter fences, allowed keys, kebab-case
 * name ≤ 64, description ≤ 1024 without angle brackets, multiline
 * description indicators, legacy wrapping, and the DoD's byte-lossless disk
 * round-trip.
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import {
  ensureSkillMd,
  exportSkillMdFile,
  importSkillMdFile,
  looksLikeSkillMd,
  parseSkillMd,
  serializeSkillMd,
  SkillMdError,
  skillMdNameOf
} from '../../src/main/agents'

const VALID = `---
name: deploy-check
description: Use this skill when deploying anything user-facing.
---

# Deploy check

Run the smoke suite before any deploy.
`

const scratch = mkdtempSync(join(tmpdir(), 'agentic-os-skillmd-'))
afterAll(() => rmSync(scratch, { recursive: true, force: true }))

describe('parseSkillMd (reference: utils.py + quick_validate.py)', () => {
  it('parses name, description, body and keeps the raw text verbatim', () => {
    const parsed = parseSkillMd(VALID)
    expect(parsed.name).toBe('deploy-check')
    expect(parsed.description).toBe('Use this skill when deploying anything user-facing.')
    expect(parsed.body).toContain('# Deploy check')
    expect(parsed.raw).toBe(VALID)
  })

  it('rejects text without an opening fence', () => {
    expect(() => parseSkillMd('name: x\ndescription: y')).toThrow(/no opening ---/)
  })

  it('rejects a missing closing fence', () => {
    expect(() => parseSkillMd('---\nname: x\ndescription: y\nbody')).toThrow(/no closing ---/)
  })

  it('rejects unexpected frontmatter keys with the allowed list named', () => {
    const text = '---\nname: a\ndescription: b\nauthor: me\n---\nbody'
    expect(() => parseSkillMd(text)).toThrow(/Unexpected key\(s\).*author.*Allowed properties/s)
  })

  it('accepts every allowed key incl. nested metadata (indented lines are not keys)', () => {
    const text = [
      '---',
      'name: full-skill',
      'description: Everything allowed.',
      'license: MIT',
      'allowed-tools: Bash',
      'metadata:',
      '  team: infra',
      'compatibility: Needs git.',
      '---',
      'body'
    ].join('\n')
    const parsed = parseSkillMd(text)
    expect(parsed.name).toBe('full-skill')
  })

  it('rejects missing name / missing description', () => {
    expect(() => parseSkillMd('---\ndescription: y\n---\nbody')).toThrow(/Missing 'name'/)
    expect(() => parseSkillMd('---\nname: x\n---\nbody')).toThrow(/Missing 'description'/)
  })

  it('enforces kebab-case names without edge/double hyphens, max 64 chars', () => {
    const md = (name: string): string => `---\nname: ${name}\ndescription: d\n---\nbody`
    expect(() => parseSkillMd(md('Has Spaces'))).toThrow(/kebab-case/)
    expect(() => parseSkillMd(md('-leading'))).toThrow(/start\/end with hyphen/)
    expect(() => parseSkillMd(md('double--hyphen'))).toThrow(/consecutive hyphens/)
    expect(() => parseSkillMd(md('a'.repeat(65)))).toThrow(/too long \(65 characters\)/)
    expect(parseSkillMd(md('a'.repeat(64))).name).toHaveLength(64)
  })

  it('enforces the description rules: ≤1024 chars, no angle brackets', () => {
    const md = (description: string): string => `---\nname: x\ndescription: ${description}\n---\nbody`
    expect(() => parseSkillMd(md('uses <tags>'))).toThrow(/angle brackets/)
    expect(() => parseSkillMd(md('d'.repeat(1025)))).toThrow(/too long \(1025 characters\)/)
  })

  it('reads YAML multiline description indicators (>-) as joined lines', () => {
    const text = ['---', 'name: multi', 'description: >-', '  first line', '  second line', '---', 'body'].join('\n')
    expect(parseSkillMd(text).description).toBe('first line second line')
  })

  it('caps compatibility at 500 chars', () => {
    const text = `---\nname: x\ndescription: d\ncompatibility: ${'c'.repeat(501)}\n---\nbody`
    expect(() => parseSkillMd(text)).toThrow(/Compatibility is too long/)
  })
})

describe('ensureSkillMd / serializeSkillMd', () => {
  it('passes valid SKILL.md through byte-verbatim', () => {
    expect(ensureSkillMd('deploy check', VALID)).toBe(VALID)
  })

  it('wraps legacy plain instructions with synthesized, rule-clean frontmatter', () => {
    const wrapped = ensureSkillMd('Postgres Migration!', 'Take a <backup> first.\nThen migrate.')
    const parsed = parseSkillMd(wrapped)
    expect(parsed.name).toBe('postgres-migration') // kebab-cased, punctuation dropped
    expect(parsed.description).toBe('Take a backup first.') // first line, angle brackets stripped
    expect(parsed.body).toBe('Take a <backup> first.\nThen migrate.') // body untouched
  })

  it('throws (with the exact rule) when text LOOKS like SKILL.md but is invalid', () => {
    expect(() => ensureSkillMd('x', '---\nname: Bad Name\ndescription: d\n---\nbody')).toThrow(SkillMdError)
  })

  it('skillMdNameOf produces valid names from arbitrary display names', () => {
    expect(skillMdNameOf('Render Charts (v2)')).toBe('render-charts-v2')
    expect(skillMdNameOf('***')).toBe('skill')
    expect(() => parseSkillMd(serializeSkillMd({ name: skillMdNameOf('A B'), description: 'd', body: 'b' }))).not.toThrow()
  })
})

describe('disk round-trip (DoD 4: lossless to a SKILL.md file)', () => {
  it('a SKILL.md-form skill round-trips byte-losslessly: graph → disk → graph', () => {
    const path = exportSkillMdFile(scratch, 'deploy check', VALID)
    expect(path.replaceAll('\\', '/')).toContain('/deploy-check/SKILL.md')
    expect(readFileSync(path, 'utf8')).toBe(VALID) // disk bytes = stored instructions
    const imported = importSkillMdFile(path)
    expect(imported.raw).toBe(VALID) // re-imported instructions = original, byte for byte
    expect(imported.name).toBe('deploy-check')
  })

  it('a legacy plain-text skill exports as a valid file whose body preserves the instructions', () => {
    const legacy = 'inspect diffs for regressions\nrun linters before approving'
    const path = exportSkillMdFile(scratch, 'review pull request', legacy)
    const imported = importSkillMdFile(path)
    expect(imported.name).toBe('review-pull-request')
    expect(imported.body).toBe(legacy)
    // Second export of the now-canonical form is byte-stable.
    const again = exportSkillMdFile(scratch, 'review pull request', imported.raw)
    expect(readFileSync(again, 'utf8')).toBe(imported.raw)
  })

  it('looksLikeSkillMd distinguishes the two stored forms', () => {
    expect(looksLikeSkillMd(VALID)).toBe(true)
    expect(looksLikeSkillMd('plain instructions')).toBe(false)
  })
})
