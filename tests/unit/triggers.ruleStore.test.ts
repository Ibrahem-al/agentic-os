/**
 * RuleStore (phase 31) — the dashboard authoring surface. Pins the three
 * disciplines: never-write-invalid (validated before any byte hits disk),
 * audited mutations (through the fileWrite/fileDelete primitives), and raw
 * preservation (unknown keys + ~/ forms survive an edit). Plus dup-id guards,
 * entry scaffolding, and the awaited onMutation reload hook.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { RuleStore, RuleStoreError, type RuleReloadResult } from '../../src/main/triggers'

let dir: string
let rulesDir: string
let auditN = 0

const RELOAD: RuleReloadResult = { added: [], removed: [], changed: [], unchanged: 0, errors: [] }

const makeAudit = () => {
  const writes: { path: string; content: string }[] = []
  const deletes: string[] = []
  const audit = {
    fileWrite(_agent: string, path: string, content: string | Buffer): { actionId: string } {
      mkdirSync(dirname(path), { recursive: true })
      writeFileSync(path, content)
      writes.push({ path, content: content.toString() })
      return { actionId: `w-${++auditN}` }
    },
    fileDelete(_agent: string, path: string): { actionId: string } {
      rmSync(path)
      deletes.push(path)
      return { actionId: `d-${++auditN}` }
    }
  }
  return { audit, writes, deletes }
}

const makeStore = (over: Partial<ConstructorParameters<typeof RuleStore>[0]> = {}) => {
  const { audit, writes, deletes } = makeAudit()
  const state = { mutations: 0 }
  const store = new RuleStore({
    rulesDir,
    audit,
    actor: 'user:dashboard',
    watchedFolderNames: () => ['notes'],
    dockerAvailable: () => true,
    onMutation: async () => {
      state.mutations++
      return RELOAD
    },
    ...over
  })
  return { store, writes, deletes, state }
}

const preset = (id: string, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  id,
  trigger: { type: 'schedule', cron: '0 9 * * *' },
  action: { kind: 'preset', preset: 'memory-export' },
  ...extra
})

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'agentic-os-rulestore-'))
  rulesDir = join(dir, 'rules')
  mkdirSync(rulesDir)
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

describe('create', () => {
  it('writes the canonical file, loadRules round-trips, onMutation fires once', async () => {
    const { store, state } = makeStore()
    const out = await store.create(preset('daily'))
    expect(out.rule.id).toBe('daily')
    expect(out.reload).toEqual(RELOAD)
    expect(existsSync(join(rulesDir, 'daily.rule.json'))).toBe(true)
    expect(state.mutations).toBe(1)
    expect(store.list().entries.map((e) => e.rule.id)).toEqual(['daily'])
  })

  it('rejects a duplicate id without writing or mutating', async () => {
    const { store, state } = makeStore()
    await store.create(preset('dup'))
    await expect(store.create(preset('dup'))).rejects.toThrow(/already exists/)
    expect(state.mutations).toBe(1)
  })

  it('never clobbers an unparseable file already at the canonical name', async () => {
    const { store } = makeStore()
    writeFileSync(join(rulesDir, 'broken.rule.json'), '{ not json')
    await expect(store.create(preset('broken'))).rejects.toBeInstanceOf(RuleStoreError)
    expect(readFileSync(join(rulesDir, 'broken.rule.json'), 'utf8')).toBe('{ not json')
  })

  it('a validation failure writes nothing and does not mutate', async () => {
    const { store, state } = makeStore()
    await expect(
      store.create({ id: 'x', trigger: { type: 'schedule', cron: 'not a cron' }, action: { kind: 'preset', preset: 'memory-export' } })
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' })
    expect(existsSync(join(rulesDir, 'x.rule.json'))).toBe(false)
    expect(state.mutations).toBe(0)
  })

  it('scaffolds a missing code entry inside the rules dir, and refuses one outside', async () => {
    const { store } = makeStore()
    await store.create({ id: 'c1', trigger: { type: 'schedule', cron: '0 9 * * *' }, action: { kind: 'code', lang: 'ts', entry: 'c1.entry.ts' }, capabilities: {} })
    expect(existsSync(join(rulesDir, 'c1.entry.ts'))).toBe(true) // scaffolded
    expect(existsSync(join(rulesDir, 'c1.rule.json'))).toBe(true)

    await expect(
      store.create({ id: 'c2', trigger: { type: 'schedule', cron: '0 9 * * *' }, action: { kind: 'code', lang: 'ts', entry: '../outside.ts' }, capabilities: {} })
    ).rejects.toThrow()
    expect(existsSync(join(rulesDir, 'c2.rule.json'))).toBe(false)
    expect(existsSync(join(dir, 'outside.ts'))).toBe(false)
  })

  it('scaffolds a language-appropriate starter (shell, not Python, for a shell rule)', async () => {
    const { store } = makeStore()
    await store.create({ id: 'sh1', trigger: { type: 'schedule', cron: '0 9 * * *' }, action: { kind: 'code', lang: 'sh', entry: 'sh1.entry.sh' }, capabilities: {} })
    const content = readFileSync(join(rulesDir, 'sh1.entry.sh'), 'utf8')
    expect(content).toContain('#!/bin/sh')
    expect(content).not.toContain('import sys')
  })

  it('cleans up an orphaned scaffold when the rule-file write fails', async () => {
    // onMutation is the last step; make the audit fail the SECOND write (the rule file).
    let writes = 0
    const failingAudit = {
      fileWrite(_a: string, path: string, content: string | Buffer): { actionId: string } {
        writes++
        if (writes === 2) throw new Error('disk full')
        mkdirSync(dirname(path), { recursive: true })
        writeFileSync(path, content)
        return { actionId: `w-${writes}` }
      },
      fileDelete(_a: string, path: string): { actionId: string } {
        rmSync(path)
        return { actionId: 'd' }
      }
    }
    const { store } = makeStore({ audit: failingAudit })
    await expect(
      store.create({ id: 'orphan', trigger: { type: 'schedule', cron: '0 9 * * *' }, action: { kind: 'code', lang: 'ts', entry: 'orphan.entry.ts' }, capabilities: {} })
    ).rejects.toThrow('disk full')
    expect(existsSync(join(rulesDir, 'orphan.entry.ts'))).toBe(false) // orphan removed
  })
})

describe('update (raw preservation)', () => {
  it('preserves unknown keys and ~/ forms while applying the change', async () => {
    writeFileSync(
      join(rulesDir, 'u.rule.json'),
      JSON.stringify({ id: 'u', note: 'keep me', trigger: { type: 'watch', path: '~/notes' }, action: { kind: 'preset', preset: 'memory-export' } })
    )
    const { store } = makeStore()
    await store.update('u', { id: 'u', trigger: { type: 'watch', path: '~/notes' }, action: { kind: 'preset', preset: 'graph-prune' } })
    const raw = JSON.parse(readFileSync(join(rulesDir, 'u.rule.json'), 'utf8'))
    expect(raw.note).toBe('keep me') // unknown key carried through
    expect(raw.trigger.path).toBe('~/notes') // ~/ form not resolved to an absolute path
    expect(raw.action.preset).toBe('graph-prune') // the actual edit
  })

  it('rejects a changed id (rename is not allowed)', async () => {
    writeFileSync(join(rulesDir, 'u.rule.json'), JSON.stringify(preset('u')))
    const { store } = makeStore()
    await expect(store.update('u', preset('different'))).rejects.toMatchObject({ code: 'INVALID_INPUT' })
  })

  it('preserves a hand-authored modelTier through an edit that omits it (no UI control)', async () => {
    writeFileSync(join(rulesDir, 'm.rule.json'), JSON.stringify(preset('m', { modelTier: 'cloud' })))
    const { store } = makeStore()
    await store.update('m', { id: 'm', trigger: { type: 'schedule', cron: '0 10 * * *' }, action: { kind: 'preset', preset: 'memory-export' } })
    expect(JSON.parse(readFileSync(join(rulesDir, 'm.rule.json'), 'utf8')).modelTier).toBe('cloud')
  })
})

describe('setEnabled', () => {
  it('adds enabled:false, then clears the key when re-enabled', async () => {
    writeFileSync(join(rulesDir, 's.rule.json'), JSON.stringify(preset('s')))
    const { store } = makeStore()
    await store.setEnabled('s', false)
    expect(JSON.parse(readFileSync(join(rulesDir, 's.rule.json'), 'utf8')).enabled).toBe(false)
    await store.setEnabled('s', true)
    expect('enabled' in JSON.parse(readFileSync(join(rulesDir, 's.rule.json'), 'utf8'))).toBe(false)
  })
})

describe('delete', () => {
  it('removes only the .rule.json and returns the untouched code entry path', async () => {
    const { store } = makeStore()
    await store.create({ id: 'd', trigger: { type: 'schedule', cron: '0 9 * * *' }, action: { kind: 'code', lang: 'ts', entry: 'd.entry.ts' }, capabilities: {} })
    const res = await store.delete('d')
    expect(existsSync(join(rulesDir, 'd.rule.json'))).toBe(false)
    expect(existsSync(join(rulesDir, 'd.entry.ts'))).toBe(true) // entry NOT deleted
    expect(res.entryFile).toBe(join(rulesDir, 'd.entry.ts'))
  })

  it('NOT_FOUND for an unknown id', async () => {
    const { store } = makeStore()
    await expect(store.delete('ghost')).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })

  it('deleteInvalidFile removes a broken rule file but refuses outside/non-rule paths', async () => {
    const { store } = makeStore()
    await expect(store.deleteInvalidFile(join(dir, 'outside.rule.json'))).rejects.toMatchObject({ code: 'INVALID_INPUT' })
    await expect(store.deleteInvalidFile(join(rulesDir, 'nope.txt'))).rejects.toMatchObject({ code: 'INVALID_INPUT' })
    writeFileSync(join(rulesDir, 'bad.rule.json'), '{ nope')
    const res = await store.deleteInvalidFile(join(rulesDir, 'bad.rule.json'))
    expect(existsSync(join(rulesDir, 'bad.rule.json'))).toBe(false)
    expect(res.auditActionId).toMatch(/^d-/)
  })
})
