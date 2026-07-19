/**
 * RuleRuntime live reload (phase 31). Pins the delta computation and the
 * ORDER-based safety invariants: added/changed agents registered, removed
 * agents unregistered, watcher re-armed with the active set, baselines reset
 * for disk-removed / trigger-changed rules but PRESERVED on a plain disable,
 * and concurrent reloads coalescing latest-wins.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PermissionEngine } from '../../src/main/security'
import { openAppData, type AppData } from '../../src/main/storage'
import { RuleRuntime, loadRules, registerRuleAgents, ruleAgentId, type LoadedRule } from '../../src/main/triggers'

let dir: string
let rulesDir: string
let appData: AppData

const scheduleRule = (id: string, cron = '0 9 * * *', extra: Record<string, unknown> = {}): void =>
  writeFileSync(
    join(rulesDir, `${id}.rule.json`),
    JSON.stringify({ id, trigger: { type: 'schedule', cron }, action: { kind: 'preset', preset: 'memory-export' }, ...extra })
  )

const makeWatchers = () => {
  const calls: { rules: string[]; reset: string[] }[] = []
  const applyRules = vi.fn(async (rules: readonly LoadedRule[], reset: readonly string[]) => {
    calls.push({ rules: rules.map((r) => r.id), reset: [...reset] })
  })
  return { applyRules, calls }
}

const setup = () => {
  const permissions = new PermissionEngine({ db: appData.db })
  const watchers = makeWatchers()
  const initial = loadRules(rulesDir)
  registerRuleAgents(permissions, initial.rules) // boot seeds the initial agents
  const regSpy = vi.spyOn(permissions, 'registerAgent')
  const unregSpy = vi.spyOn(permissions, 'unregisterAgent')
  const rt = new RuleRuntime(
    { rulesDir, permissions, watchers, detectDockerImpl: async () => ({ available: false }) },
    initial,
    false
  )
  return { rt, permissions, watchers, regSpy, unregSpy }
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'agentic-os-reload-'))
  rulesDir = join(dir, 'rules')
  mkdirSync(rulesDir)
  appData = openAppData(join(dir, 'appdata.db'))
})
afterEach(() => {
  appData.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('reload diff', () => {
  it('no on-disk change → all unchanged, no (un)registration', async () => {
    scheduleRule('a')
    const { rt, watchers, regSpy, unregSpy } = setup()
    const res = await rt.reload()
    expect(res).toMatchObject({ added: [], removed: [], changed: [], unchanged: 1 })
    expect(regSpy).not.toHaveBeenCalled()
    expect(unregSpy).not.toHaveBeenCalled()
    expect(watchers.calls.at(-1)?.rules).toEqual(['a'])
  })

  it('a new rule is added, its agent registered, and the watcher re-armed with both', async () => {
    scheduleRule('a')
    const { rt, watchers, regSpy } = setup()
    scheduleRule('b')
    const res = await rt.reload()
    expect(res.added).toEqual(['b'])
    expect(regSpy).toHaveBeenCalledWith(ruleAgentId('b'), expect.anything())
    expect(watchers.calls.at(-1)?.rules.sort()).toEqual(['a', 'b'])
  })

  it('a deleted rule is removed, its agent unregistered, and its baseline reset', async () => {
    scheduleRule('a')
    scheduleRule('b')
    const { rt, watchers, unregSpy, permissions } = setup()
    rmSync(join(rulesDir, 'b.rule.json'))
    const res = await rt.reload()
    expect(res.removed).toEqual(['b'])
    expect(unregSpy).toHaveBeenCalledWith(ruleAgentId('b'))
    expect(watchers.calls.at(-1)?.reset).toContain('b') // removed from disk → baseline reset
    // §13 default-deny applies once unregistered.
    expect(permissions.check(ruleAgentId('b'), { kind: 'fs-read', name: 'x', paths: [] }).reason).toContain('not registered')
  })

  it('a capability/trigger change re-registers and (for trigger) resets the baseline', async () => {
    scheduleRule('a', '0 9 * * *')
    const { rt, watchers, regSpy } = setup()
    scheduleRule('a', '0 10 * * *') // trigger changed
    const res = await rt.reload()
    expect(res.changed).toEqual(['a'])
    expect(regSpy).toHaveBeenCalledWith(ruleAgentId('a'), expect.anything())
    expect(watchers.calls.at(-1)?.reset).toContain('a')
  })

  it('a plain DISABLE removes from the armed set but PRESERVES the baseline', async () => {
    scheduleRule('a')
    const { rt, watchers } = setup()
    scheduleRule('a', '0 9 * * *', { enabled: false })
    const res = await rt.reload()
    expect(res.removed).toContain('a') // no longer armed
    expect(watchers.calls.at(-1)?.rules).toEqual([]) // nothing active
    expect(watchers.calls.at(-1)?.reset).not.toContain('a') // still on disk → baseline kept
  })
})

describe('resilience', () => {
  it('a reload whose applyRules throws does not wedge the machinery — the next reload succeeds', async () => {
    scheduleRule('a')
    const permissions = new PermissionEngine({ db: appData.db })
    let throwOnce = true
    const applyRules = vi.fn(async () => {
      if (throwOnce) {
        throwOnce = false
        throw new Error('boom')
      }
    })
    const initial = loadRules(rulesDir)
    const rt = new RuleRuntime(
      { rulesDir, permissions, watchers: { applyRules }, detectDockerImpl: async () => ({ available: false }) },
      initial,
      false
    )
    await expect(rt.reload()).rejects.toThrow('boom')
    // inFlight must have cleared (finally), so a fresh reload runs rather than
    // coalescing onto the dead rejected promise.
    const res = await rt.reload()
    expect(res).toMatchObject({ unchanged: 1 })
    expect(applyRules).toHaveBeenCalledTimes(2)
  })
})

describe('coalescing', () => {
  it('concurrent reloads run loadRules a bounded number of times and settle on the final state', async () => {
    scheduleRule('a')
    const { rt } = setup()
    const impl = vi.fn(loadRules)
    // Swap in a counting loader by constructing a fresh runtime around it.
    const permissions = new PermissionEngine({ db: appData.db })
    const watchers = makeWatchers()
    const initial = loadRules(rulesDir)
    const rt2 = new RuleRuntime(
      { rulesDir, permissions, watchers, loadRulesImpl: impl, detectDockerImpl: async () => ({ available: false }) },
      initial,
      false
    )
    const [r1, r2, r3] = await Promise.all([rt2.reload(), rt2.reload(), rt2.reload()])
    // Coalesced: at most two disk reads (one in flight + one trailing), never three.
    expect(impl.mock.calls.length).toBeLessThanOrEqual(2)
    expect(r1).toEqual(r2)
    expect(r2).toEqual(r3)
    void rt
  })
})
