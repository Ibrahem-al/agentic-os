/**
 * Tree-sitter unit extraction (phase 07): meaningful units only — exported
 * functions/classes, route handlers, data models — plus imports, re-exports
 * and doc text, for TS/JS/Python. Offline: the WASM grammars load from
 * node_modules, no network.
 */
import { describe, expect, it } from 'vitest'
import { codeLanguageForExtension, parseCodeFile } from '../../src/main/ingest'

describe('codeLanguageForExtension', () => {
  it('maps the v1 grammar extensions and nothing else', () => {
    expect(codeLanguageForExtension('.ts')).toBe('typescript')
    expect(codeLanguageForExtension('.tsx')).toBe('tsx')
    expect(codeLanguageForExtension('.js')).toBe('javascript')
    expect(codeLanguageForExtension('.jsx')).toBe('javascript')
    expect(codeLanguageForExtension('.mjs')).toBe('javascript')
    expect(codeLanguageForExtension('.py')).toBe('python')
    expect(codeLanguageForExtension('.go')).toBeNull()
    expect(codeLanguageForExtension('.rb')).toBeNull()
  })
})

describe('TypeScript extraction', () => {
  it('extracts exported functions, classes and data models — not plain constants', async () => {
    const parsed = await parseCodeFile(
      'src/a.ts',
      'typescript',
      [
        'export function alpha(x: number): number { return x }',
        'export async function beta(): Promise<void> {}',
        'export class Gamma { run(): void {} }',
        'export abstract class Delta {}',
        'export interface Epsilon { id: string }',
        'export type Zeta = { id: string }',
        'export enum Eta { A, B }',
        'export const theta = (x: number) => x * 2',
        'export const IOTA_LIMIT = 42',
        'export const kappa = { nested: true }',
        'function notExported(): void {}',
        'const alsoNotExported = () => 1'
      ].join('\n')
    )
    const byName = new Map(parsed.units.map((u) => [u.name, u.kind]))
    expect(byName).toEqual(
      new Map([
        ['alpha', 'function'],
        ['beta', 'function'],
        ['Gamma', 'class'],
        ['Delta', 'class'],
        ['Epsilon', 'model'],
        ['Zeta', 'model'],
        ['Eta', 'model'],
        ['theta', 'function']
      ])
    )
    // Plain exported constants and non-exported declarations are not units.
    expect(byName.has('IOTA_LIMIT')).toBe(false)
    expect(byName.has('kappa')).toBe(false)
    expect(byName.has('notExported')).toBe(false)
  })

  it('attaches the JSDoc directly above a unit; per-unit content hashes differ', async () => {
    const parsed = await parseCodeFile(
      'src/doc.ts',
      'typescript',
      [
        '/** Adds two numbers. */',
        'export function add(a: number, b: number): number { return a + b }',
        '',
        '/** Orphaned: a blank line separates this from the next unit. */',
        '',
        'export function sub(a: number, b: number): number { return a - b }'
      ].join('\n')
    )
    const add = parsed.units.find((u) => u.name === 'add')
    const sub = parsed.units.find((u) => u.name === 'sub')
    expect(add?.doc).toBe('Adds two numbers.')
    expect(sub?.doc).toBe('')
    expect(add?.contentHash).toMatch(/^sha256:[0-9a-f]{64}$/)
    expect(add?.contentHash).not.toBe(sub?.contentHash)
  })

  it('merges TS function overloads into one unit whose hash covers all declarations', async () => {
    const parsed = await parseCodeFile(
      'src/over.ts',
      'typescript',
      [
        'export function pick(x: string): string',
        'export function pick(x: number): number',
        'export function pick(x: unknown): unknown { return x }'
      ].join('\n')
    )
    expect(parsed.units).toHaveLength(1)
    const only = parsed.units[0]
    expect(only?.name).toBe('pick')
    expect(only?.text.split('\n')).toHaveLength(3)
  })

  it('detects top-level route registrations as route units', async () => {
    const parsed = await parseCodeFile(
      'src/routes.ts',
      'typescript',
      [
        "import express from 'express'",
        'const app = express()',
        "app.get('/users', (req, res) => res.json([]))",
        "app.post('/users', handler)",
        "app.listen(3000)", // not a route method
        "app.get(prefix, handler)" // first arg not a string literal
      ].join('\n')
    )
    expect(parsed.units.map((u) => `${u.kind} ${u.name}`).sort()).toEqual(['route GET /users', 'route POST /users'])
  })

  it('collects named/default/namespace/aliased imports with their specifiers', async () => {
    const parsed = await parseCodeFile(
      'src/imp.ts',
      'typescript',
      [
        "import def from './a'",
        "import * as ns from './b'",
        "import { one, two as deux } from './c'",
        "import type { OnlyType } from './d'",
        "import 'polyfill'"
      ].join('\n')
    )
    expect(parsed.imports).toEqual([
      { local: 'def', imported: 'default', specifier: './a' },
      { local: 'ns', imported: '*', specifier: './b' },
      { local: 'one', imported: 'one', specifier: './c' },
      { local: 'deux', imported: 'two', specifier: './c' },
      { local: 'OnlyType', imported: 'OnlyType', specifier: './d' }
    ])
  })

  it('collects re-exports (named, aliased, star) — barrels have no units', async () => {
    const parsed = await parseCodeFile(
      'src/index.ts',
      'typescript',
      ["export { alpha, beta as b } from './a'", "export * from './rest'", "export * as ns from './ns'"].join('\n')
    )
    expect(parsed.units).toHaveLength(0)
    expect(parsed.reexports).toEqual([
      { exported: 'alpha', imported: 'alpha', specifier: './a' },
      { exported: 'b', imported: 'beta', specifier: './a' },
      { exported: '*', imported: '*', specifier: './rest' }
    ])
  })

  it('captures function-valued default exports', async () => {
    const parsed = await parseCodeFile('src/def.ts', 'typescript', 'export default function main() { return 1 }')
    expect(parsed.units.map((u) => `${u.kind} ${u.name}`)).toEqual(['function main'])
    const anon = await parseCodeFile('src/anon.ts', 'typescript', 'export default () => 42')
    expect(anon.units.map((u) => `${u.kind} ${u.name}`)).toEqual(['function default'])
  })

  it('parses TSX components as exported functions', async () => {
    const parsed = await parseCodeFile(
      'src/Panel.tsx',
      'tsx',
      'export function Panel(): JSX.Element { return <div className="panel">hi</div> }'
    )
    expect(parsed.units.map((u) => `${u.kind} ${u.name}`)).toEqual(['function Panel'])
  })

  it('never throws on malformed source — extracts what still parses', async () => {
    const parsed = await parseCodeFile(
      'src/broken.ts',
      'typescript',
      'export function ok(): number { return 1 }\nexport function broken(((((\n'
    )
    expect(parsed.units.some((u) => u.name === 'ok')).toBe(true)
  })
})

describe('Python extraction', () => {
  it('extracts top-level defs and classes; underscore names are private', async () => {
    const parsed = await parseCodeFile(
      'pkg/mod.py',
      'python',
      [
        'def visible(x):',
        '    """Doc line."""',
        '    return x',
        '',
        'def _hidden():',
        '    return None',
        '',
        'class Widget:',
        '    """A widget."""',
        '    def method(self):',
        '        return 1'
      ].join('\n')
    )
    const byName = new Map(parsed.units.map((u) => [u.name, u]))
    expect([...byName.keys()].sort()).toEqual(['Widget', 'visible'])
    expect(byName.get('visible')?.kind).toBe('function')
    expect(byName.get('visible')?.doc).toBe('Doc line.')
    expect(byName.get('Widget')?.kind).toBe('class')
    expect(byName.get('Widget')?.doc).toBe('A widget.')
  })

  it('classifies dataclasses and typed-dict/pydantic-style bases as models', async () => {
    const parsed = await parseCodeFile(
      'pkg/models.py',
      'python',
      [
        'from dataclasses import dataclass',
        'from typing import TypedDict',
        '',
        '@dataclass',
        'class Order:',
        '    total: float',
        '',
        'class Reading(TypedDict):',
        '    value: float',
        '',
        'class Plain:',
        '    pass'
      ].join('\n')
    )
    const kinds = new Map(parsed.units.map((u) => [u.name, u.kind]))
    expect(kinds.get('Order')).toBe('model')
    expect(kinds.get('Reading')).toBe('model')
    expect(kinds.get('Plain')).toBe('class')
  })

  it('detects decorated route handlers (flask/fastapi style)', async () => {
    const parsed = await parseCodeFile(
      'pkg/api.py',
      'python',
      [
        '@app.get("/things")',
        'def list_things():',
        '    return []',
        '',
        '@app.route("/legacy")',
        'def legacy_view():',
        '    return None',
        '',
        '@cached',
        'def not_a_route():',
        '    return 1'
      ].join('\n')
    )
    const kinds = new Map(parsed.units.map((u) => [u.name, u.kind]))
    expect(kinds.get('GET /things')).toBe('route')
    expect(kinds.get('ROUTE /legacy')).toBe('route')
    expect(kinds.get('not_a_route')).toBe('function')
  })

  it('collects from-imports (plain, aliased, relative, wildcard) and module imports', async () => {
    const parsed = await parseCodeFile(
      'pkg/imp.py',
      'python',
      [
        'from utils import helper',
        'from .sibling import thing as renamed',
        'from ..parent import other',
        'from noisy import *',
        'import json',
        'import package.module as pm'
      ].join('\n')
    )
    expect(parsed.imports).toEqual([
      { local: 'helper', imported: 'helper', specifier: 'utils' },
      { local: 'renamed', imported: 'thing', specifier: '.sibling' },
      { local: 'other', imported: 'other', specifier: '..parent' },
      { local: '*', imported: '*', specifier: 'noisy' },
      { local: 'json', imported: '*', specifier: 'json' },
      { local: 'pm', imported: '*', specifier: 'package.module' }
    ])
  })
})
