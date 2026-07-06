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
import { loadModelSettings, settingsPath, type Keychain } from '../../src/main/models'
import { IPC_INVOKE_PREFIX } from '../../src/shared/ipc'
import type {
  IpcChannel,
  IpcCloudProvider,
  IpcRequest,
  IpcResponse,
  IpcResult,
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
})
