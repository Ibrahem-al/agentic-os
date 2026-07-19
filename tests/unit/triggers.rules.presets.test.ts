/**
 * Phase-31 additions to the §17 rule model: no-code PRESET actions (a
 * whitelist of existing safe system task kinds, capabilities AUTO-DERIVED from
 * the trigger), the top-level `enabled` flag (a disabled rule loads/lists but
 * arms nothing and registers no agent), and `analyzeRule` — the single
 * field-addressed validator `parseRuleFile` now delegates to.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { PermissionEngine } from '../../src/main/security'
import { openAppData } from '../../src/main/storage'
import {
  RULE_PRESETS,
  analyzeRule,
  derivePresetCapabilities,
  loadRules,
  registerRuleAgents,
  ruleAgentId,
  type RuleAnalysisCtx
} from '../../src/main/triggers'

let dir: string
let rulesDir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'agentic-os-presets-'))
  rulesDir = join(dir, 'rules')
  mkdirSync(rulesDir)
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

const analyze = (json: unknown, ctx: Partial<RuleAnalysisCtx> = {}) =>
  analyzeRule(json, join(rulesDir, 'x.rule.json'), rulesDir, { entryMode: 'scaffold-ok', ...ctx })

const errorFields = (json: unknown, ctx: Partial<RuleAnalysisCtx> = {}): string[] =>
  analyze(json, ctx).issues.filter((i) => i.severity === 'error').map((i) => i.field)

describe('preset actions', () => {
  it('parses every whitelisted preset to its task kind', () => {
    for (const preset of Object.keys(RULE_PRESETS) as (keyof typeof RULE_PRESETS)[]) {
      const needsFolder = RULE_PRESETS[preset].needsFolder
      const a = analyze(
        {
          id: 'p',
          trigger: { type: 'schedule', cron: '0 3 * * *' },
          action: { kind: 'preset', preset, ...(needsFolder ? { folder: 'notes' } : {}) }
        },
        { watchedFolderNames: new Set(['notes']) }
      )
      expect(a.issues.filter((i) => i.severity === 'error')).toEqual([])
      expect(a.rule?.action).toMatchObject({ kind: 'preset', preset, taskKind: RULE_PRESETS[preset].taskKind })
    }
  })

  it('rejects unknown preset, wrong folder usage, and hand-written capabilities', () => {
    expect(analyze({ id: 'p', trigger: { type: 'schedule', cron: '0 3 * * *' }, action: { kind: 'preset', preset: 'nope' } }).rule).toBeNull()
    expect(errorFields({ id: 'p', trigger: { type: 'schedule', cron: '0 3 * * *' }, action: { kind: 'preset', preset: 'folder-scan' } })).toContain('action.folder')
    expect(
      errorFields({ id: 'p', trigger: { type: 'schedule', cron: '0 3 * * *' }, action: { kind: 'preset', preset: 'memory-export', folder: 'notes' } })
    ).toContain('action.folder')
    expect(
      errorFields({ id: 'p', trigger: { type: 'schedule', cron: '0 3 * * *' }, action: { kind: 'preset', preset: 'memory-export' }, capabilities: {} })
    ).toContain('capabilities')
    expect(
      errorFields(
        { id: 'p', trigger: { type: 'schedule', cron: '0 3 * * *' }, action: { kind: 'preset', preset: 'folder-scan', folder: 'ghost' } },
        { watchedFolderNames: new Set(['notes']) }
      )
    ).toContain('action.folder')
  })

  it('auto-derives minimal detection capabilities from the trigger', () => {
    expect(derivePresetCapabilities({ type: 'watch', path: '/abs/dir' }).fsRead).toEqual([resolve('/abs/dir')])
    expect(derivePresetCapabilities({ type: 'watch', url: 'https://CNN.com/x' }).netDomains).toEqual(['cnn.com'])
    const sched = derivePresetCapabilities({ type: 'schedule', cron: '* * * * *' })
    expect(sched.fsRead).toEqual([])
    expect(sched.netDomains).toEqual([])
    expect(sched.fsWrite).toEqual([])
    expect(sched.maxSpendUSD).toBe(0)
    // A preset url-watch passes the §13 containment check by construction.
    const a = analyze({ id: 'p', trigger: { type: 'watch', url: 'https://cnn.com/rss', intervalMin: 30 }, action: { kind: 'preset', preset: 'memory-export' } })
    expect(a.rule?.capabilities.netDomains).toEqual(['cnn.com'])
  })
})

describe('enabled flag', () => {
  it('loads a disabled rule with enabled:false; registerRuleAgents skips it', () => {
    // A path-watch preset derives fsRead=[watchedDir], so a registered agent can
    // read inside it — the clean "is this agent registered?" probe.
    const watchedDir = join(dir, 'watched')
    mkdirSync(watchedDir)
    const watchedFile = join(watchedDir, 'x.txt')
    writeFileSync(watchedFile, 'x')
    const rule = (id: string, enabled?: boolean): string =>
      JSON.stringify({
        id,
        ...(enabled === false ? { enabled: false } : {}),
        trigger: { type: 'watch', path: watchedDir },
        action: { kind: 'preset', preset: 'memory-export' }
      })

    writeFileSync(join(rulesDir, 'on.rule.json'), rule('on'))
    writeFileSync(join(rulesDir, 'off.rule.json'), rule('off', false))
    const loaded = loadRules(rulesDir)
    expect(loaded.errors).toEqual([])
    expect(loaded.rules.find((r) => r.id === 'on')?.enabled).toBe(true)
    expect(loaded.rules.find((r) => r.id === 'off')?.enabled).toBe(false)

    const appData = openAppData(join(dir, 'appdata.db'))
    try {
      const permissions = new PermissionEngine({ db: appData.db })
      registerRuleAgents(permissions, loaded.rules)
      expect(permissions.check(ruleAgentId('on'), { kind: 'fs-read', name: 'x', paths: [watchedFile] }).allowed).toBe(true)
      expect(permissions.check(ruleAgentId('off'), { kind: 'fs-read', name: 'x', paths: [watchedFile] }).reason).toContain('not registered')
    } finally {
      appData.close()
    }
  })

  it('still validates (and errors) a disabled rule', () => {
    writeFileSync(
      join(rulesDir, 'bad.rule.json'),
      JSON.stringify({ id: 'bad', enabled: false, trigger: { type: 'schedule', cron: 'not a cron' }, action: { kind: 'preset', preset: 'memory-export' } })
    )
    const loaded = loadRules(rulesDir)
    expect(loaded.rules).toEqual([])
    expect(loaded.errors).toHaveLength(1)
  })
})

describe('analyzeRule field mapping', () => {
  it('addresses a bad cron to trigger.cron', () => {
    const fields = errorFields({ id: 'x', trigger: { type: 'schedule', cron: 'not a cron' }, action: { kind: 'preset', preset: 'memory-export' } })
    expect(fields).toContain('trigger.cron')
  })

  it('flags a missing code entry (must-exist) at action.entry', () => {
    const a = analyzeRule(
      { id: 'x', trigger: { type: 'schedule', cron: '0 3 * * *' }, action: { kind: 'code', lang: 'ts', entry: 'missing.ts' } },
      join(rulesDir, 'x.rule.json'),
      rulesDir,
      { entryMode: 'must-exist' }
    )
    expect(a.issues.find((i) => i.field === 'action.entry')).toBeDefined()
  })

  it('scaffold-ok accepts a missing entry inside the rules dir', () => {
    const a = analyze({ id: 'x', trigger: { type: 'schedule', cron: '0 3 * * *' }, action: { kind: 'code', lang: 'ts', entry: 'x.entry.ts' } })
    expect(a.willScaffoldEntry).toBe(true)
    expect(a.issues.filter((i) => i.severity === 'error')).toEqual([])
  })

  it('rejects fsWrite that includes the rules directory', () => {
    const fields = errorFields({
      id: 'x',
      trigger: { type: 'schedule', cron: '0 3 * * *' },
      action: { kind: 'code', lang: 'ts', entry: 'x.entry.ts' },
      capabilities: { fsWrite: [rulesDir] }
    })
    expect(fields).toContain('capabilities.fsWrite')
  })

  it('warns (but does not block) a docker-lane language when docker is down', () => {
    writeFileSync(join(rulesDir, 'act.py'), 'print(1)\n')
    const a = analyze(
      { id: 'x', trigger: { type: 'schedule', cron: '0 3 * * *' }, action: { kind: 'code', lang: 'py', entry: 'act.py' } },
      { dockerAvailable: false }
    )
    expect(a.issues.some((i) => i.field === 'action.lang' && i.severity === 'warning')).toBe(true)
    expect(a.rule).not.toBeNull()
  })
})
