/**
 * Gitignore-respecting walk (phase 07): full pattern semantics via `ignore`
 * (negation, dir-only, nesting), always-pruned directories, binary sniffing
 * and the 1 MB cap.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { INGEST_MAX_FILE_BYTES } from '../../src/main/config'
import { walkCodebase, type CodebaseWalkResult } from '../../src/main/ingest'

let root: string
let result: CodebaseWalkResult

function write(relPath: string, content: string | Buffer): void {
  const path = join(root, ...relPath.split('/'))
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, content)
}

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'agentic-os-walk-'))
  write('.gitignore', 'ignored.ts\nbuild/\n*.log\nsecret*.md\n!keepme.md\n')
  write('app.ts', 'export function main() { return 1 }\n')
  write('README.md', '# hello\n')
  write('ignored.ts', 'export function no() {}\n')
  write('build/generated.ts', 'export function alsoNo() {}\n')
  write('notes.log', 'log file\n')
  write('secretdraft.md', '# no\n')
  write('keepme.md', '# yes — negation re-includes me\n')
  write('sub/lib.py', 'def visible():\n    return 1\n')
  write('sub/.gitignore', 'scratch.py\n')
  write('sub/scratch.py', 'def no():\n    return 0\n')
  write('node_modules/pkg/index.js', 'module.exports = 1\n')
  write('.git/config', '[core]\n')
  write('.hidden/inside.ts', 'export function hidden() {}\n')
  write('data.csv', 'a,b\n1,2\n')
  write('binary.py', Buffer.from([0x64, 0x65, 0x66, 0x00, 0x01, 0x02]))
  write('huge.md', `# big\n${'x'.repeat(INGEST_MAX_FILE_BYTES)}\n`)
  result = walkCodebase(root)
})

afterAll(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('walkCodebase', () => {
  it('keeps code and markdown files, honoring gitignore negation', () => {
    expect(result.codeFiles.map((f) => f.relPath).sort()).toEqual(['app.ts', 'sub/lib.py'])
    expect(result.docFiles.map((f) => f.relPath).sort()).toEqual(['README.md', 'keepme.md'])
  })

  it('gitignored files and directories never surface (root and nested scopes)', () => {
    const seen = [
      ...result.codeFiles.map((f) => f.relPath),
      ...result.docFiles.map((f) => f.relPath),
      ...result.skipped.map((s) => s.relPath)
    ]
    for (const forbidden of [
      'ignored.ts',
      'build/generated.ts',
      'notes.log',
      'secretdraft.md',
      'sub/scratch.py',
      'node_modules/pkg/index.js',
      '.git/config',
      '.hidden/inside.ts'
    ]) {
      expect(seen).not.toContain(forbidden)
    }
  })

  it('skips binaries and oversized files with reasons', () => {
    const reasons = new Map(result.skipped.map((s) => [s.relPath, s.reason]))
    expect(reasons.get('binary.py')).toContain('binary')
    expect(reasons.get('huge.md')).toContain('exceeds')
    expect(reasons.get('data.csv')).toContain('not code')
  })
})
