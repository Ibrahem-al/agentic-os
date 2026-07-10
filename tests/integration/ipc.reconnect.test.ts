/**
 * IPC reconnect wiring (fix/stack-reconnect). Two contracts:
 *  - app.reconnect awaits deps.reconnect (boot's rebootStack) and returns the
 *    FRESH AppStatusDto it produces; absent reconnect reports current status.
 *  - unregisterIpcHandlers + re-register is the re-wire a reconnect performs so
 *    handlers stop pointing at the stale (null) deps captured at first boot.
 *    ipcMain.handle throws on a duplicate channel, so the unregister-first step
 *    is load-bearing — pinned here.
 * electron is mocked to just capture handlers (mirrors ipc.settings.test.ts),
 * with a removeHandler that deletes and a handle that throws on duplicates
 * exactly as Electron does.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { IpcMainInvokeEvent } from 'electron'

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
      if (handlers.has(channel)) throw new Error(`Attempted to register a second handler for '${channel}'`)
      handlers.set(channel, fn)
    },
    removeHandler: (channel: string) => {
      handlers.delete(channel)
    }
  }
}))

import { registerIpcHandlers, unregisterIpcHandlers, type IpcDeps } from '../../src/main/ipc'
import { IPC_INVOKE_PREFIX } from '../../src/shared/ipc'
import type { AppStatusDto, IpcChannel, IpcRequest, IpcResponse, IpcResult } from '../../src/shared/ipc'

let dir: string

const baseNulls = {
  engine: null,
  db: null,
  permissions: null,
  audit: null,
  scanner: null,
  ollama: null,
  reranker: null,
  keychain: null,
  mcpUrl: null,
  triggers: null
} as const

const allFalse = { storage: false, models: false, kernel: false, mcp: false, agents: false }
const allTrue = { storage: true, models: true, kernel: true, mcp: true, agents: true }

function makeDeps(overrides: Partial<IpcDeps>): IpcDeps {
  return { ...baseNulls, userDataDir: dir, subsystems: allFalse, ...overrides }
}

async function invoke<C extends IpcChannel>(channel: C, req?: IpcRequest<C>): Promise<IpcResult<IpcResponse<C>>> {
  const fn = handlers.get(`${IPC_INVOKE_PREFIX}${channel}`)
  if (fn === undefined) throw new Error(`no handler registered for ${channel}`)
  return (await fn({} as IpcMainInvokeEvent, req)) as IpcResult<IpcResponse<C>>
}

function dataOf<T>(res: IpcResult<T>): T {
  if (!res.ok) throw new Error(`expected ok, got ${res.code}: ${res.message}`)
  return res.data
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'agentic-os-ipc-reconnect-'))
  handlers.clear()
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('app.reconnect', () => {
  it('awaits deps.reconnect and returns the fresh AppStatusDto it produces', async () => {
    const fresh: AppStatusDto = {
      version: '0.0.0-test',
      platform: 'test',
      userDataDir: dir,
      subsystems: allTrue,
      mcpUrl: 'http://127.0.0.1:4517/mcp',
      diagnostics: [{ subsystem: 'storage', level: 'ok', detail: 'graph + appdata open' }]
    }
    const reconnect = vi.fn(async () => fresh)
    registerIpcHandlers(makeDeps({ reconnect }))

    const res = await invoke('app.reconnect')
    expect(reconnect).toHaveBeenCalledTimes(1)
    expect(dataOf(res)).toEqual(fresh)
  })

  it('with no reconnect wired (test rig), reports the current status unchanged', async () => {
    registerIpcHandlers(makeDeps({ subsystems: allFalse, mcpUrl: null }))
    const res = dataOf(await invoke('app.reconnect'))
    expect(res.subsystems).toEqual(allFalse)
    expect(res.mcpUrl).toBeNull()
  })
})

describe('unregisterIpcHandlers re-wire (the reconnect swap)', () => {
  it('re-registering WITHOUT unregister throws — the reconnect must unregister first', () => {
    registerIpcHandlers(makeDeps({}))
    expect(() => registerIpcHandlers(makeDeps({}))).toThrow(/second handler/i)
  })

  it('unregister + re-register swaps stale deps for fresh ones (app.status reflects recovery)', async () => {
    registerIpcHandlers(makeDeps({ subsystems: allFalse }))
    expect(dataOf(await invoke('app.status')).subsystems.storage).toBe(false)

    unregisterIpcHandlers()
    registerIpcHandlers(makeDeps({ subsystems: allTrue, mcpUrl: 'http://127.0.0.1:4517/mcp' }))

    const after = dataOf(await invoke('app.status'))
    expect(after.subsystems).toEqual(allTrue)
    expect(after.mcpUrl).toBe('http://127.0.0.1:4517/mcp')
  })
})
