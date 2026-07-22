/**
 * The `memory.dedupe.cleanupStart` IPC handler (phase-41 — the dashboard "clean
 * up with AI" trigger). It enqueues the §8 'graph-cleanup' task (the same enqueue
 * the MCP run_graph_cleanup tool fires) over the trigger runtime's queue:
 *  - a fresh call mirrors a 'graph-cleanup' tasks row carrying the scan scope, and
 *    a same-minute repeat dedups onto the deterministic per-minute id;
 *  - with no trigger runtime this launch it takes the standard UNAVAILABLE path.
 * `electron` is mocked to just capture handlers (mirrors ipc.updater.test.ts); the
 * queue + appdata.db are real (enqueue only mirrors rows — the queue is unstarted).
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
      handlers.set(channel, fn)
    }
  }
}))

import { registerIpcHandlers, type IpcDeps } from '../../src/main/ipc'
import { IPC_INVOKE_PREFIX } from '../../src/shared/ipc'
import type { IpcChannel, IpcRequest, IpcResponse, IpcResult } from '../../src/shared/ipc'
import { DurableTaskQueue } from '../../src/main/triggers'
import { openAppData, type AppData } from '../../src/main/storage'

let dir: string
let appData: AppData

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

function makeDeps(overrides: Partial<IpcDeps>): IpcDeps {
  return { ...baseNulls, userDataDir: dir, subsystems: allFalse, ...overrides } as unknown as IpcDeps
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

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'agentic-os-ipc-cleanup-'))
  appData = openAppData(join(dir, 'appdata.db'))
  handlers.clear()
})
afterEach(() => {
  appData.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('memory.dedupe.cleanupStart', () => {
  it('enqueues a graph-cleanup task carrying the scan scope, deduped per minute', async () => {
    const queue = new DurableTaskQueue({ db: appData.db }) // unstarted — enqueue mirrors rows
    registerIpcHandlers(makeDeps({ triggers: { queue } as unknown as IpcDeps['triggers'] }))

    const first = dataOf(await invoke('memory.dedupe.cleanupStart', { scope: 'count', count: 50 }))
    expect(first.taskId).toMatch(/^graph-cleanup-\d{4}-\d{2}-\d{2}T\d{4}$/)
    expect(first.deduped).toBe(false)

    const row = appData.db.prepare('SELECT kind, payload_json FROM tasks WHERE id = ?').get(first.taskId) as {
      kind: string
      payload_json: string
    }
    expect(row.kind).toBe('graph-cleanup')
    expect(JSON.parse(row.payload_json)).toEqual({ scope: 'count', count: 50 })

    // A second trigger in the same minute collapses onto the same task id.
    const second = dataOf(await invoke('memory.dedupe.cleanupStart', { scope: 'recent' }))
    expect(second.taskId).toBe(first.taskId)
    expect(second.deduped).toBe(true)
  })

  it('takes the UNAVAILABLE path when the trigger runtime did not boot', async () => {
    registerIpcHandlers(makeDeps({ triggers: null }))
    const res = await invoke('memory.dedupe.cleanupStart', { scope: 'recent' })
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.code).toBe('UNAVAILABLE')
  })
})
