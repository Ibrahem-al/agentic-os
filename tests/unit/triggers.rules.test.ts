/**
 * User rules (§17 agent #5, phase 11): the *.rule.json loader — the §17
 * example shape end to end, scope coherence (a rule may only watch what its
 * capabilities declare, §13), the v1 condition DSL, §7 lane mapping,
 * per-file fail-fast validation, and registerRuleAgents wiring loaded rules
 * into the REAL §13 permission engine with NO standing grants (phase-09
 * decision: user rules queue pending approvals for every gated tier).
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { PermissionEngine } from '../../src/main/security'
import { openAppData } from '../../src/main/storage'
import {
  RULE_FILE_SUFFIX,
  evaluateRuleCondition,
  loadRules,
  parseRuleCondition,
  parseRuleFile,
  registerRuleAgents,
  ruleAgentId,
  type LoadedRule,
  type RuleLoadError,
  type RuleLoadResult
} from '../../src/main/triggers'

let dir: string
let rulesDir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'agentic-os-rules-'))
  rulesDir = join(dir, 'rules')
  mkdirSync(rulesDir)
  // Default entry file most rules point at (action.entry resolves against the
  // rules dir and must exist). Also an implicit pin: non-*.rule.json files in
  // the rules dir are ignored by the loader, never parse errors.
  writeFileSync(join(rulesDir, 'action.ts'), '// rule action entry\n')
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

const baseAction = { kind: 'code', lang: 'ts', entry: 'action.ts' }

const writeRule = (base: string, rule: unknown): string => {
  const file = join(rulesDir, `${base}${RULE_FILE_SUFFIX}`)
  writeFileSync(file, typeof rule === 'string' ? rule : JSON.stringify(rule, null, 2))
  return file
}

const soleRule = (result: RuleLoadResult): LoadedRule => {
  expect(result.errors).toEqual([])
  expect(result.rules).toHaveLength(1)
  const rule = result.rules[0]
  if (rule === undefined) throw new Error('unreachable: length asserted above')
  return rule
}

const soleError = (result: RuleLoadResult): RuleLoadError => {
  expect(result.rules).toEqual([])
  expect(result.errors).toHaveLength(1)
  const error = result.errors[0]
  if (error === undefined) throw new Error('unreachable: length asserted above')
  return error
}

describe('user rules (§17 shape + §13 scope coherence)', () => {
  it('loads the §17 example shape (url watch → deno lane, normalized capabilities)', () => {
    writeFileSync(join(rulesDir, 'summarize.ts'), '// summarize entry\n')
    writeRule('cnn-ai-watch', {
      id: 'cnn-ai-watch',
      trigger: { type: 'watch', url: 'https://cnn.com/rss', intervalMin: 30 },
      condition: "item.title contains 'AI'",
      action: { kind: 'code', lang: 'ts', entry: 'summarize.ts' },
      modelTier: 'local',
      capabilities: { fsRead: [], fsWrite: ['~/agentic-out'], netDomains: ['cnn.com'], maxSpendUSD: 0.1 }
    })
    const rule = soleRule(loadRules(rulesDir))
    expect(rule.id).toBe('cnn-ai-watch')
    expect(rule.file).toBe(join(rulesDir, `cnn-ai-watch${RULE_FILE_SUFFIX}`))
    expect(rule.trigger).toEqual({ type: 'watch', url: 'https://cnn.com/rss', intervalMin: 30 })
    expect(rule.condition).toEqual({
      source: "item.title contains 'AI'",
      path: ['item', 'title'],
      needle: 'AI'
    })
    expect(rule.action.lane).toBe('deno')
    expect(isAbsolute(rule.action.entry)).toBe(true)
    expect(rule.action.entry).toBe(join(rulesDir, 'summarize.ts'))
    expect(existsSync(rule.action.entry)).toBe(true)
    expect(rule.modelTier).toBe('local')
    // parseCapabilities semantics: ~ expanded to an absolute path, defaults
    // filled deny-empty, netDomains lowercased host form.
    expect(rule.capabilities).toEqual({
      fsRead: [],
      fsWrite: [join(homedir(), 'agentic-out')],
      netDomains: ['cnn.com'],
      tools: [],
      maxSpendUSD: 0.1
    })
    expect(isAbsolute(rule.capabilities.fsWrite[0] ?? '')).toBe(true)
  })

  it('loads a file watch whose path sits inside fsRead, resolved absolute', () => {
    const watchedDir = join(dir, 'watched')
    mkdirSync(watchedDir)
    const watched = join(watchedDir, 'notes.txt')
    writeFileSync(watched, 'hello')
    writeRule('file-watch', {
      id: 'file-watch',
      trigger: { type: 'watch', path: watched },
      action: baseAction,
      capabilities: { fsRead: [watchedDir] }
    })
    const rule = soleRule(loadRules(rulesDir))
    expect(rule.trigger).toEqual({ type: 'watch', path: watched })
    expect(rule.condition).toBeNull()
    expect(rule.modelTier).toBe('local') // the default tier
  })

  it('rejects a watch path outside the declared fsRead scope (§13 coherence)', () => {
    writeRule('scope-breach', {
      id: 'scope-breach',
      trigger: { type: 'watch', path: join(dir, 'elsewhere', 'x.txt') },
      action: baseAction,
      capabilities: { fsRead: [join(dir, 'allowed')] }
    })
    const error = soleError(loadRules(rulesDir))
    expect(error.error).toContain('fsRead')
  })

  it("rejects a url watch whose host is missing from netDomains", () => {
    writeRule('bad-host', {
      id: 'bad-host',
      trigger: { type: 'watch', url: 'https://cnn.com/rss', intervalMin: 30 },
      action: baseAction,
      capabilities: { netDomains: ['example.com'] }
    })
    const error = soleError(loadRules(rulesDir))
    expect(error.error).toContain('netDomains')
    expect(error.error).toContain('cnn.com')
  })

  it('rejects a url watch without intervalMin', () => {
    writeRule('no-interval', {
      id: 'no-interval',
      trigger: { type: 'watch', url: 'https://cnn.com/rss' },
      action: baseAction,
      capabilities: { netDomains: ['cnn.com'] }
    })
    const error = soleError(loadRules(rulesDir))
    expect(error.error).toContain('intervalMin')
  })

  it('rejects a watch trigger with both url and path, and with neither', () => {
    writeRule('both-watch', {
      id: 'both-watch',
      trigger: { type: 'watch', url: 'https://cnn.com/rss', path: join(dir, 'x.txt'), intervalMin: 5 },
      action: baseAction,
      capabilities: { fsRead: [dir], netDomains: ['cnn.com'] }
    })
    writeRule('neither-watch', {
      id: 'neither-watch',
      trigger: { type: 'watch' },
      action: baseAction
    })
    const result = loadRules(rulesDir)
    expect(result.rules).toEqual([])
    expect(result.errors).toHaveLength(2)
    for (const error of result.errors) {
      expect(error.error).toContain("exactly one of 'url' or 'path'")
    }
  })

  it('loads a schedule trigger; an invalid cron is rejected naming the expression', () => {
    writeRule('every-5', {
      id: 'every-5',
      trigger: { type: 'schedule', cron: '*/5 * * * *' },
      action: baseAction
    })
    writeRule('bad-cron', {
      id: 'bad-cron',
      trigger: { type: 'schedule', cron: 'not a cron' },
      action: baseAction
    })
    const result = loadRules(rulesDir)
    expect(result.rules).toHaveLength(1)
    expect(result.rules[0]?.trigger).toEqual({ type: 'schedule', cron: '*/5 * * * *' })
    expect(result.errors).toHaveLength(1)
    expect(result.errors[0]?.error).toContain("'not a cron'")
  })

  it("parses the v1 condition grammar and rejects everything else", () => {
    expect(parseRuleCondition("item.title contains 'AI'")).toEqual({
      source: "item.title contains 'AI'",
      path: ['item', 'title'],
      needle: 'AI'
    })
    expect(() => parseRuleCondition("item.title == 'AI'")).toThrow(/unsupported condition/)
    expect(() => parseRuleCondition('contains')).toThrow(/unsupported condition/)
    expect(() => parseRuleCondition('')).toThrow(/unsupported condition/)
    expect(() => parseRuleCondition('   ')).toThrow(/unsupported condition/)
  })

  it('evaluates conditions against trigger events (missing path ⇒ false, leaves coerced)', () => {
    const cond = parseRuleCondition("item.title contains 'AI'")
    expect(evaluateRuleCondition(cond, { item: { title: 'Big AI news' } })).toBe(true)
    expect(evaluateRuleCondition(cond, { item: { title: 'weather report' } })).toBe(false)
    expect(evaluateRuleCondition(cond, {})).toBe(false) // missing path
    expect(evaluateRuleCondition(cond, { item: {} })).toBe(false) // missing leaf
    // Non-string leaf coerced via String.
    const numeric = parseRuleCondition("count contains '42'")
    expect(evaluateRuleCondition(numeric, { count: 421 })).toBe(true)
    expect(evaluateRuleCondition(numeric, { count: 7 })).toBe(false)
    // Object leaf coerced via JSON.stringify.
    expect(evaluateRuleCondition(cond, { item: { title: { headline: 'AI rules' } } })).toBe(true)
  })

  it("rejects unknown action kinds and entry files that don't exist", () => {
    writeRule('skill-kind', {
      id: 'skill-kind',
      trigger: { type: 'schedule', cron: '0 4 * * *' },
      action: { kind: 'skill', lang: 'ts', entry: 'action.ts' }
    })
    writeRule('no-entry', {
      id: 'no-entry',
      trigger: { type: 'schedule', cron: '0 4 * * *' },
      action: { kind: 'code', lang: 'ts', entry: 'missing.ts' }
    })
    const result = loadRules(rulesDir)
    expect(result.rules).toEqual([])
    expect(result.errors).toHaveLength(2)
    const byFile = new Map(result.errors.map((e) => [e.file, e.error]))
    expect(byFile.get(join(rulesDir, `skill-kind${RULE_FILE_SUFFIX}`))).toContain('action.kind')
    expect(byFile.get(join(rulesDir, `no-entry${RULE_FILE_SUFFIX}`))).toContain('does not resolve to a file')
  })

  it('maps non-JS/TS languages to the docker lane (§7)', () => {
    writeFileSync(join(rulesDir, 'act.py'), 'print("hi")\n')
    const make = (lang: string): LoadedRule =>
      parseRuleFile(
        join(rulesDir, `lane-probe${RULE_FILE_SUFFIX}`),
        JSON.stringify({
          id: 'lane-probe',
          trigger: { type: 'schedule', cron: '0 4 * * *' },
          action: { kind: 'code', lang, entry: 'act.py' }
        }),
        rulesDir
      )
    expect(make('py').action.lane).toBe('docker')
    expect(make('js').action.lane).toBe('deno')
    expect(make('typescript').action.lane).toBe('deno')
    expect(make('TS').action.lane).toBe('deno') // lang is case-folded
  })

  it('keeps the first file for a duplicate rule id and rejects the later one', () => {
    const ruleBody = {
      id: 'dup-rule',
      trigger: { type: 'schedule', cron: '0 4 * * *' },
      action: baseAction
    }
    writeRule('a', ruleBody)
    writeRule('b', ruleBody)
    const result = loadRules(rulesDir)
    expect(result.rules).toHaveLength(1)
    expect(result.rules[0]?.file).toBe(join(rulesDir, `a${RULE_FILE_SUFFIX}`))
    expect(result.errors).toHaveLength(1)
    expect(result.errors[0]?.file).toBe(join(rulesDir, `b${RULE_FILE_SUFFIX}`))
    expect(result.errors[0]?.error).toContain("duplicate rule id 'dup-rule'")
  })

  it('reports invalid JSON per-file without blocking valid rules; a missing dir is empty', () => {
    expect(RULE_FILE_SUFFIX).toBe('.rule.json')
    writeRule('broken', '{ this is not json')
    writeRule('good', {
      id: 'good',
      trigger: { type: 'schedule', cron: '0 4 * * *' },
      action: baseAction
    })
    // Wrong suffix → ignored entirely, never a parse error.
    writeFileSync(join(rulesDir, 'ignored.json'), 'also not json')
    const result = loadRules(rulesDir)
    expect(result.rules.map((r) => r.id)).toEqual(['good'])
    expect(result.errors).toHaveLength(1)
    expect(result.errors[0]?.file).toBe(join(rulesDir, `broken${RULE_FILE_SUFFIX}`))
    expect(result.errors[0]?.error).toContain('not valid JSON')
    expect(loadRules(join(dir, 'does-not-exist'))).toEqual({ rules: [], errors: [] })
  })

  it('rejects capability declarations with relative paths', () => {
    writeRule('bad-caps', {
      id: 'bad-caps',
      trigger: { type: 'schedule', cron: '0 4 * * *' },
      action: baseAction,
      capabilities: { fsWrite: ['relative/path'] }
    })
    const error = soleError(loadRules(rulesDir))
    expect(error.error).toContain('capabilities')
    expect(error.error).toContain('not absolute')
  })

  it('registerRuleAgents: default-deny agents with NO standing grants (phase-09 §13)', () => {
    const watchedDir = join(dir, 'watched')
    mkdirSync(watchedDir)
    const watchedFile = join(watchedDir, 'inbox.txt')
    writeFileSync(watchedFile, 'x')
    writeRule('agent-rule', {
      id: 'agent-rule',
      trigger: { type: 'watch', path: watchedFile },
      action: baseAction,
      capabilities: { fsRead: [watchedDir], fsWrite: [join(dir, 'out')] }
    })
    const result = loadRules(rulesDir)
    const rule = soleRule(result)
    expect(ruleAgentId('agent-rule')).toBe('rule:agent-rule')

    const appData = openAppData(join(dir, 'appdata.db'))
    try {
      const permissions = new PermissionEngine({ db: appData.db })
      registerRuleAgents(permissions, result.rules)

      // Reading the watched path is inside the declared fsRead scope → allowed.
      const read = permissions.check(ruleAgentId('agent-rule'), {
        kind: 'fs-read',
        name: 'x',
        paths: [watchedFile]
      })
      expect(read.allowed).toBe(true)

      // A side-effecting sandbox run (fsWrite non-empty) has NO standing grant
      // for user rules — it must queue a pending approval, not execute.
      const run = permissions.check(ruleAgentId('agent-rule'), {
        kind: 'sandbox-run',
        name: 'x',
        sandbox: { capabilities: rule.capabilities }
      })
      expect(run.allowed).toBe(false)
      expect(typeof run.pendingApprovalId).toBe('string')
      expect(run.reason).toContain('queued for approval')

      // Unregistered rule ids are hard-blocked (§13 default-deny).
      const stranger = permissions.check('rule:unregistered', {
        kind: 'fs-read',
        name: 'x',
        paths: [watchedFile]
      })
      expect(stranger.allowed).toBe(false)
      expect(stranger.reason).toContain('not registered')
    } finally {
      appData.close()
    }
  })
})
