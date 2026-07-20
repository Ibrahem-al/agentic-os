/**
 * `updater.install` background-job awareness (Settings "Restart to update").
 *
 * When a durable-queue job is running, the restart must NOT silently block on the
 * quiesce and then show a vague message — it reports WHICH job is holding it
 * (`blockedByTaskId`) so the UI can offer "pause it and restart now". `force:true`
 * pauses that job first, then drains + installs. `registerIpcHandlers` is booted
 * with a fully mocked `electron`; only the wrapped handlers are exercised, over
 * structural fakes (no real store/queue).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
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
      handlers.set(channel, fn)
    }
  }
}))

import { registerIpcHandlers, type IpcDeps } from '../../src/main/ipc'
import { IPC_INVOKE_PREFIX } from '../../src/shared/ipc'
import type { IpcChannel, IpcRequest, IpcResponse, IpcResult, UpdaterStatusDto } from '../../src/shared/ipc'

/** Minimal UpdaterController: 'downloaded' so install proceeds; quitAndInstall observable. */
function fakeUpdater() {
  const status = (): UpdaterStatusDto => ({ state: 'downloaded', version: '9.9.9' })
  return { status, check: async () => status(), quitAndInstall: vi.fn(), onStatusChange: () => () => {} }
}

/** Queue fake: pause() clears the running task (as a real settle would), so the quiesce drains. */
function fakeQueue(initialRunning: string | null) {
  let running = initialRunning
  return {
    get runningTaskId(): string | null {
      return running
    },
    pause: vi.fn((id: string) => {
      running = null
      return { taskId: id, status: 'paused' as const, wasRunning: true, killedChildren: 0 }
    })
  }
}

/** Engine fake for quiesceForInstall — lane idle immediately, checkpoint resolves. */
const idleEngine = { laneIdle: () => true, checkpoint: vi.fn(async () => {}) }

function makeDeps(runningTaskId: string | null) {
  const updater = fakeUpdater()
  const queue = fakeQueue(runningTaskId)
  const allowNextClose = vi.fn()
  const deps = {
    engine: idleEngine as unknown as IpcDeps['engine'],
    db: null,
    permissions: null,
    audit: null,
    scanner: null,
    ollama: null,
    reranker: null,
    keychain: {} as IpcDeps['keychain'],
    mcpUrl: null,
    triggers: { queue } as unknown as IpcDeps['triggers'],
    updater: updater as unknown as IpcDeps['updater'],
    allowNextClose,
    userDataDir: process.cwd(),
    subsystems: { storage: false, models: false, kernel: false, mcp: false, agents: false }
  } as unknown as IpcDeps
  return { deps, updater, queue, allowNextClose }
}

async function invoke<C extends IpcChannel>(channel: C, req: IpcRequest<C>): Promise<IpcResult<IpcResponse<C>>> {
  const fn = handlers.get(`${IPC_INVOKE_PREFIX}${channel}`)
  if (fn === undefined) throw new Error(`no handler registered for ${channel}`)
  return (await fn({} as IpcMainInvokeEvent, req)) as IpcResult<IpcResponse<C>>
}

function dataOf<T>(res: IpcResult<T>): T {
  if (!res.ok) throw new Error(`expected ok, got ${res.code}: ${res.message}`)
  return res.data
}

describe('updater.install — background-job aware restart', () => {
  beforeEach(() => {
    handlers.clear()
  })

  it('a running job blocks the restart: names the job, and does NOT install or pause', async () => {
    const { deps, updater, queue } = makeDeps('extract-demo-session')
    registerIpcHandlers(deps)
    const dto = dataOf(await invoke('updater.install', {}))
    expect(dto.installDeferred).toBe(true)
    expect(dto.blockedByTaskId).toBe('extract-demo-session')
    expect(dto.detail).toMatch(/background job is running/i)
    expect(queue.pause).not.toHaveBeenCalled()
    expect(updater.quitAndInstall).not.toHaveBeenCalled()
  })

  it('force: pauses the running job first, then drains + installs', async () => {
    const { deps, updater, queue, allowNextClose } = makeDeps('extract-demo-session')
    registerIpcHandlers(deps)
    const dto = dataOf(await invoke('updater.install', { force: true }))
    expect(queue.pause).toHaveBeenCalledWith('extract-demo-session')
    expect(allowNextClose).toHaveBeenCalledTimes(1)
    expect(updater.quitAndInstall).toHaveBeenCalledTimes(1)
    expect(dto.installDeferred).toBeUndefined() // it installed, not deferred
  })

  it('no running job: installs straight away (no pause, no block)', async () => {
    const { deps, updater, queue, allowNextClose } = makeDeps(null)
    registerIpcHandlers(deps)
    await invoke('updater.install', {})
    expect(queue.pause).not.toHaveBeenCalled()
    expect(allowNextClose).toHaveBeenCalledTimes(1)
    expect(updater.quitAndInstall).toHaveBeenCalledTimes(1)
  })
})
