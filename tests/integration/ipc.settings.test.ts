/**
 * IPC settings mutators (phase-16b, P1.1). `registerIpcHandlers` is booted with
 * a fully mocked `electron` — only `ipcMain.handle` is exercised at registration,
 * so we capture the wrapped handlers and invoke them directly over a real temp
 * userDataDir (real settings.json I/O through loadModelSettings/saveModelSettings).
 *
 * Covers the phase-16b slice of src/main/ipc.ts and nothing else:
 *  - settings.save MERGES the additive reasoning/runner sections (the explicit
 *    field list would otherwise silently DROP them) and PRESERVES a section a
 *    later patch omits — DEFAULT == TODAY: an absent section stays absent.
 *  - settings.save / setApiKey / clearApiKey fire deps.onSettingsChanged (the
 *    router.invalidate hook — no restart to change provider/key/role) only AFTER
 *    a successful mutation.
 *  - settingsDto (settings.get) surfaces reasoning/runner when present and omits
 *    them on a default install.
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { IpcMainInvokeEvent } from 'electron'

// The registration side only needs ipcMain.handle; the other electron surfaces
// are stubbed so importing ipc.ts (which value-imports `electron`) resolves. The
// captured handler registry rides vi.hoisted so the hoisted factory may close
// over it. process.cwd() only — no imported bindings inside the factory.
const { handlers } = vi.hoisted(() => ({
  handlers: new Map<string, (event: unknown, req: unknown) => unknown>()
}))

vi.mock('electron', () => ({
  app: {
    getVersion: () => '0.0.0-test',
    getPath: () => process.cwd(),
    getAppPath: () => process.cwd(),
    isPackaged: false
  },
  BrowserWindow: { fromWebContents: () => null },
  dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] as string[] }) },
  ipcMain: {
    handle: (channel: string, fn: (event: unknown, req: unknown) => unknown) => {
      handlers.set(channel, fn)
    }
  }
}))

import { registerIpcHandlers, type IpcDeps } from '../../src/main/ipc'
import {
  ProviderRouter,
  loadModelSettings,
  settingsPath,
  type Keychain,
  type OllamaLike,
  type ProviderCloudTier,
  type SubscriptionComplete
} from '../../src/main/models'
import { IPC_INVOKE_PREFIX } from '../../src/shared/ipc'
import type {
  IpcChannel,
  IpcCloudProvider,
  IpcRequest,
  IpcResponse,
  IpcResult,
  ModelSettingsPatchDto,
  SettingsDto
} from '../../src/shared/ipc'

let dir: string
let onSettingsChanged: ReturnType<typeof vi.fn<() => void>>
let setApiKey: ReturnType<typeof vi.fn>
let deleteSecret: ReturnType<typeof vi.fn>

/** A structural Keychain fake — only the methods these handlers touch. */
function fakeKeychain(): Keychain {
  return {
    getApiKey: () => undefined,
    setApiKey,
    deleteSecret
  } as unknown as Keychain
}

const baseNulls = {
  engine: null,
  db: null,
  permissions: null,
  audit: null,
  scanner: null,
  // null ollama → settingsDto uses the daemon-not-running fallback (no real client).
  ollama: null,
  reranker: null,
  mcpUrl: null,
  triggers: null,
  subsystems: { storage: false, models: false, kernel: false, mcp: false, agents: false }
} as const

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'agentic-os-ipc-settings-'))
  onSettingsChanged = vi.fn<() => void>()
  setApiKey = vi.fn()
  deleteSecret = vi.fn()
  handlers.clear()
  const deps: IpcDeps = { ...baseNulls, keychain: fakeKeychain(), userDataDir: dir, onSettingsChanged }
  registerIpcHandlers(deps)
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

async function invoke<C extends IpcChannel>(channel: C, req?: IpcRequest<C>): Promise<IpcResult<IpcResponse<C>>> {
  const fn = handlers.get(`${IPC_INVOKE_PREFIX}${channel}`)
  if (fn === undefined) throw new Error(`no handler registered for ${channel}`)
  return (await fn({} as IpcMainInvokeEvent, req)) as IpcResult<IpcResponse<C>>
}

function dataOf<T>(res: IpcResult<T>): T {
  if (!res.ok) throw new Error(`expected ok, got ${res.code}: ${res.message}`)
  return res.data
}

describe('ipc settings mutators (phase-16b)', () => {
  it('settings.save merges a reasoning patch, persists it, and surfaces it in the DTO', async () => {
    const dto = dataOf(
      await invoke('settings.save', {
        reasoning: { backend: 'subscription-claude', overrides: { 'extraction.verify': 'cloud-api' } }
      })
    )
    const expected = { backend: 'subscription-claude', overrides: { 'extraction.verify': 'cloud-api' } }
    // Persisted to disk (would silently vanish if the explicit field list dropped it).
    expect(loadModelSettings(settingsPath(dir)).reasoning).toEqual(expected)
    // Surfaced back through settingsDto.
    expect(dto.reasoning).toEqual(expected)
  })

  it('settings.save round-trips reasoning.allowSensitiveNonLocal and PRESERVES it across a backend-only patch (Stage 2)', async () => {
    // Grant the sensitive-egress consent.
    const dto = dataOf(
      await invoke('settings.save', { reasoning: { backend: 'subscription-claude', allowSensitiveNonLocal: true } })
    )
    expect(dto.reasoning?.allowSensitiveNonLocal).toBe(true)
    expect(loadModelSettings(settingsPath(dir)).reasoning?.allowSensitiveNonLocal).toBe(true)

    // A later backend-only patch (the runner toggle shape) must NOT drop the flag.
    await invoke('settings.save', { reasoning: { backend: 'local-qwen3' } })
    const onDisk = loadModelSettings(settingsPath(dir))
    expect(onDisk.reasoning).toEqual({ backend: 'local-qwen3', allowSensitiveNonLocal: true })

    // Revoking consent is an explicit false (not an omission) and persists.
    const revoked = dataOf(await invoke('settings.save', { reasoning: { backend: 'local-qwen3', allowSensitiveNonLocal: false } }))
    expect(revoked.reasoning?.allowSensitiveNonLocal).toBe(false)
    expect(loadModelSettings(settingsPath(dir)).reasoning?.allowSensitiveNonLocal).toBe(false)
  })

  it('settings.save preserves an on-disk section when a later patch omits it (DEFAULT == TODAY)', async () => {
    await invoke('settings.save', {
      reasoning: { backend: 'subscription-claude', overrides: { 'skills.rewrite': 'local-qwen3' } }
    })
    // A follow-up save touching only runner must NOT drop the reasoning section.
    await invoke('settings.save', {
      runner: { enabled: true, model: 'sonnet', stageAll: false, mode: 'agent', injectionPolicy: 'proceed' }
    })
    const onDisk = loadModelSettings(settingsPath(dir))
    expect(onDisk.reasoning).toEqual({ backend: 'subscription-claude', overrides: { 'skills.rewrite': 'local-qwen3' } })
    expect(onDisk.runner).toEqual({
      enabled: true,
      model: 'sonnet',
      stageAll: false,
      mode: 'agent',
      injectionPolicy: 'proceed'
    })
  })

  it('settings.save on a default install materializes NEITHER section (byte-clean)', async () => {
    await invoke('settings.save', { cloudProvider: 'openai' })
    const onDisk = loadModelSettings(settingsPath(dir))
    expect(onDisk.reasoning).toBeUndefined()
    expect(onDisk.runner).toBeUndefined()
    expect(onDisk.cloudProvider).toBe('openai')
    // The absent sections must not even appear as keys on disk.
    expect(readFileSync(settingsPath(dir), 'utf8')).not.toMatch(/reasoning|runner/)
  })

  it('settings.save fires onSettingsChanged after persisting', async () => {
    await invoke('settings.save', { reasoning: { backend: 'local-qwen3' } })
    expect(onSettingsChanged).toHaveBeenCalledTimes(1)
  })

  it('settings.setApiKey mutates the keychain and then fires onSettingsChanged', async () => {
    const res = await invoke('settings.setApiKey', { provider: 'anthropic', key: 'sk-test-123' })
    expect(res.ok).toBe(true)
    expect(setApiKey).toHaveBeenCalledWith('anthropic', 'sk-test-123')
    expect(onSettingsChanged).toHaveBeenCalledTimes(1)
  })

  it('settings.clearApiKey deletes the secret and then fires onSettingsChanged', async () => {
    const res = await invoke('settings.clearApiKey', { provider: 'openai' })
    expect(res.ok).toBe(true)
    expect(deleteSecret).toHaveBeenCalledTimes(1)
    expect(onSettingsChanged).toHaveBeenCalledTimes(1)
  })

  it('a rejected setApiKey neither mutates nor fires onSettingsChanged (fires only after success)', async () => {
    const res = await invoke('settings.setApiKey', {
      provider: 'skynet' as unknown as IpcCloudProvider,
      key: 'x'
    })
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.code).toBe('INVALID_INPUT')
    expect(setApiKey).not.toHaveBeenCalled()
    expect(onSettingsChanged).not.toHaveBeenCalled()
  })

  it('settings.get surfaces reasoning/runner once opted in', async () => {
    await invoke('settings.save', {
      reasoning: { backend: 'subscription-claude' },
      runner: { enabled: true, model: 'sonnet', stageAll: false, mode: 'agent', injectionPolicy: 'proceed' }
    })
    const dto = dataOf(await invoke('settings.get'))
    expect(dto.reasoning).toEqual({ backend: 'subscription-claude' })
    expect(dto.runner).toEqual({
      enabled: true,
      model: 'sonnet',
      stageAll: false,
      mode: 'agent',
      injectionPolicy: 'proceed'
    })
  })

  it('settings.get omits both sections on a default install (absent + inert)', async () => {
    const dto: SettingsDto = dataOf(await invoke('settings.get'))
    expect(dto.reasoning).toBeUndefined()
    expect(dto.runner).toBeUndefined()
  })

  // ── Phone/LAN access (network.lanAccess) ─────────────────────────────────────

  it('settings.save persists network.lanAccess and the DTO toggle STATE reflects it immediately (no restart)', async () => {
    // Default install: localhost-only, toggle reads off, no LAN url this launch.
    const before: SettingsDto = dataOf(await invoke('settings.get'))
    expect(before.mcp.lanAccess).toBe(false)
    expect(before.mcp.lanUrl).toBeNull()
    expect(loadModelSettings(settingsPath(dir)).network).toBeUndefined()

    // Enabling: persisted to disk AND surfaced in the DTO toggle state right away,
    // so applyDto(fresh) keeps the checkbox on without waiting for the restart.
    const enabled = dataOf(await invoke('settings.save', { network: { lanAccess: true } }))
    expect(enabled.mcp.lanAccess).toBe(true)
    expect(loadModelSettings(settingsPath(dir)).network?.lanAccess).toBe(true)
    // lanUrl stays null in this rig (no LAN-bound server wired) — it only appears
    // after a real restart binds 0.0.0.0.
    expect(enabled.mcp.lanUrl).toBeNull()

    // Disabling is an explicit false and flips the state straight back.
    const disabled = dataOf(await invoke('settings.save', { network: { lanAccess: false } }))
    expect(disabled.mcp.lanAccess).toBe(false)
    expect(loadModelSettings(settingsPath(dir)).network?.lanAccess).toBe(false)
  })

  it('settings.save preserves network across a patch that omits it, and never materializes it on a default install', async () => {
    await invoke('settings.save', { network: { lanAccess: true } })
    // A later provider-only patch must NOT drop the network section.
    await invoke('settings.save', { cloudProvider: 'openai' })
    expect(loadModelSettings(settingsPath(dir)).network?.lanAccess).toBe(true)

    // And a save that never touches network on a fresh install leaves it absent.
    rmSync(settingsPath(dir), { force: true })
    await invoke('settings.save', { cloudProvider: 'openai' })
    expect(loadModelSettings(settingsPath(dir)).network).toBeUndefined()
    expect(readFileSync(settingsPath(dir), 'utf8')).not.toMatch(/network/)
  })

  it('reasoning.roles enumerates all 15 roles with plain groups + the sensitive flag; effectiveBackend is null with no router wired (DEFAULT == TODAY)', async () => {
    const roles = dataOf(await invoke('reasoning.roles'))
    // Every §2.2 role, canonical order, no dupes.
    expect(roles).toHaveLength(15)
    expect(new Set(roles.map((r) => r.role)).size).toBe(15)
    // The five HARD-local roles are exactly the ones marked sensitive.
    const sensitive = roles.filter((r) => r.sensitive).map((r) => r.role)
    expect(new Set(sensitive)).toEqual(
      new Set(['retrieval.critic', 'retrieval.rewrite', 'scanner.llmVerdict', 'skills.executor', 'skills.grader'])
    )
    // Every row carries a plain group; no router this rig → effectiveBackend null.
    const GROUPS = new Set(['Understanding your sessions', 'Improving skills', 'Search & retrieval', 'Safety scanning', 'Summaries'])
    for (const r of roles) {
      expect(GROUPS.has(r.group), r.role).toBe(true)
      expect(r.effectiveBackend, r.role).toBeNull()
    }
  })
})

// ── phase-22: enabling the runner engages reasoning.backend ───────────────────
//
// SettingsPanel.tsx's saveRunner sends an enable/disable as ONE atomic
// settings.save that pairs runner.enabled with the GLOBAL reasoning backend
// (subscription-claude on enable, local-qwen3 on disable). Rationale: the
// subscription tier is only ROUTED to when reasoning.backend ===
// 'subscription-claude', so flipping runner.enabled alone leaves it "available
// but unused"; and a stale 'subscription-claude' with the runner OFF would fall
// through to the paid cloud-api tier for the subscribable roles (§11.4), so the
// disable reverts unconditionally. These pin the main-side contract the renderer
// coupling depends on: the merge persists BOTH fields, and the persisted backend
// actually reroutes the subscribable roles.

/** RUNNER_DEFAULTS mirrored from SettingsPanel.tsx (the keyless opt-in shape). */
const RUNNER_DEFAULTS = {
  enabled: false,
  model: 'sonnet',
  stageAll: true,
  mode: 'completion',
  injectionPolicy: 'downgrade'
} as const

/** Exactly the ModelSettingsPatchDto saveRunner builds for an enable/disable. */
function runnerTogglePatch(enabled: boolean): ModelSettingsPatchDto {
  return {
    runner: { ...RUNNER_DEFAULTS, enabled },
    reasoning: { backend: enabled ? 'subscription-claude' : 'local-qwen3' }
  }
}

describe('ipc settings — runner enable couples reasoning.backend (phase-22)', () => {
  it('the enable patch round-trips runner.enabled + reasoning.backend to disk and the DTO, firing onSettingsChanged once', async () => {
    const dto = dataOf(await invoke('settings.save', runnerTogglePatch(true)))
    const onDisk = loadModelSettings(settingsPath(dir))
    expect(onDisk.runner?.enabled).toBe(true)
    expect(onDisk.reasoning?.backend).toBe('subscription-claude')
    expect(dto.runner?.enabled).toBe(true)
    expect(dto.reasoning?.backend).toBe('subscription-claude')
    expect(onSettingsChanged).toHaveBeenCalledTimes(1)
  })

  it('a backend-only toggle preserves hand-edited reasoning.overrides/models and flips the backend both ways', async () => {
    // The renderer only ever sends reasoning:{backend}; these escape hatches are
    // hand-edited into settings.json and must survive the backend-only merge.
    const overrides = { 'extraction.verify': 'cloud-api' } as const
    const models = { 'skills.rewrite': 'claude-sonnet-4-5' } as const
    await invoke('settings.save', { reasoning: { backend: 'local-qwen3', overrides, models } })

    await invoke('settings.save', runnerTogglePatch(true))
    const enabled = loadModelSettings(settingsPath(dir))
    expect(enabled.reasoning).toEqual({ backend: 'subscription-claude', overrides, models })
    expect(enabled.runner?.enabled).toBe(true)

    await invoke('settings.save', runnerTogglePatch(false))
    const disabled = loadModelSettings(settingsPath(dir))
    expect(disabled.reasoning).toEqual({ backend: 'local-qwen3', overrides, models })
    expect(disabled.runner?.enabled).toBe(false)
  })

  it('the persisted backend actually routes: enable → subscribable roles hit subscription; disable → today (cloud-api with a key, local keyless); grader stays local', async () => {
    const ollama: OllamaLike = { generate: async () => ({ text: '' }) }
    const subscriptionComplete: SubscriptionComplete = async () => ({ text: '' })
    // resolve() only reads backend+model — it never dereferences the tier, so a
    // structural stand-in is enough to observe the cloud-api resolution.
    let cloudKey: ProviderCloudTier | null = { brain: {}, meter: {} } as unknown as ProviderCloudTier
    const router = new ProviderRouter({
      loadSnapshot: () => loadModelSettings(settingsPath(dir)),
      ollama,
      makeCloud: () => cloudKey,
      subscriptionComplete,
      runnerHealthy: () => true
    })

    // Enabled: the two subscribable extraction roles ride the subscription; the
    // HARD-local grader never follows the global toggle. (Lazy snapshot loads the
    // just-saved enabled state on the first resolve.)
    await invoke('settings.save', runnerTogglePatch(true))
    expect(router.resolve('extraction.fuzzy').backend).toBe('subscription-claude')
    expect(router.resolve('extraction.verify').backend).toBe('subscription-claude')
    expect(router.resolve('skills.grader').backend).toBe('local-qwen3')

    // Disabled: revert to today. extraction.fuzzy is local-today; extraction.verify
    // is cloud-today → cloud-api when a key exists, else falls through to local.
    await invoke('settings.save', runnerTogglePatch(false))
    router.invalidate()
    expect(router.resolve('extraction.fuzzy').backend).toBe('local-qwen3')
    expect(router.resolve('extraction.verify').backend).toBe('cloud-api')
    cloudKey = null // makeCloud is live (only the settings snapshot is cached).
    expect(router.resolve('extraction.verify').backend).toBe('local-qwen3')
    expect(router.resolve('skills.grader').backend).toBe('local-qwen3')
  })
})
