/**
 * Local-LLM usage — the IPC channel (`usage.local.summary`) and the MCP read
 * tool (`get_local_usage`) wiring (Stage 1). `registerIpcHandlers` boots with a
 * fully mocked `electron` (only ipcMain.handle is exercised); the captured
 * handler is invoked directly over a real appdata.db (v9). The MCP def is pulled
 * from MCP_TOOLS and its handler driven over a minimal ToolContext. The pure
 * recorder/ps/store/prune/aggregation logic lives in tests/unit/localUsage.test.ts.
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
  app: { getVersion: () => '0.0.0-test', getPath: () => process.cwd(), getAppPath: () => process.cwd(), isPackaged: false },
  BrowserWindow: { fromWebContents: () => null },
  dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] as string[] }) },
  ipcMain: {
    handle: (channel: string, fn: (event: unknown, req: unknown) => unknown) => {
      handlers.set(channel, fn)
    }
  }
}))

import { registerIpcHandlers, type IpcDeps } from '../../src/main/ipc'
import { MCP_TOOLS, type ToolContext } from '../../src/main/mcp/tools'
import { openAppData, type AppData } from '../../src/main/storage/appdata'
import { IPC_INVOKE_PREFIX } from '../../src/shared/ipc'
import type { IpcChannel, IpcRequest, IpcResponse, IpcResult, LocalUsageSummaryDto } from '../../src/shared/ipc'
import type { OllamaClient } from '../../src/main/models'

/** A structural Ollama fake — only the two methods the summary probes. */
const fakeOllama = {
  ps: async () => [{ name: 'qwen3:4b', sizeBytes: 3_200_000_000, sizeVramBytes: 0, expiresAt: '2026-07-13T00:05:00Z' }],
  status: async () => ({ state: 'ready' as const, installedModels: ['qwen3:4b'], missingModels: [], installUrl: 'x' })
} as unknown as OllamaClient

let dir: string
let app: AppData

const seed = (role: string | null, durationMs: number): void => {
  app.db
    .prepare(
      `INSERT INTO local_llm_usage (ts, role, model, prompt_tokens, eval_tokens, duration_ms, ok)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    .run(new Date().toISOString(), role, 'qwen3:4b', 100, 20, durationMs, 1)
}

const baseDeps = (): IpcDeps => ({
  engine: null,
  db: app.db,
  permissions: null,
  audit: null,
  scanner: null,
  ollama: fakeOllama,
  reranker: null,
  keychain: null,
  mcpUrl: null,
  triggers: null,
  userDataDir: dir,
  subsystems: { storage: true, models: true, kernel: false, mcp: false, agents: false }
})

async function invoke<C extends IpcChannel>(channel: C, req?: IpcRequest<C>): Promise<IpcResult<IpcResponse<C>>> {
  const fn = handlers.get(`${IPC_INVOKE_PREFIX}${channel}`)
  if (fn === undefined) throw new Error(`no handler registered for ${channel}`)
  return (await fn({} as IpcMainInvokeEvent, req)) as IpcResult<IpcResponse<C>>
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ipc-local-usage-'))
  app = openAppData(join(dir, 'appdata.db'))
  handlers.clear()
})
afterEach(() => {
  app.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('usage.local.summary IPC channel', () => {
  it('returns the aggregated summary + live snapshot in an ok envelope', async () => {
    seed('extraction.fuzzy', 500)
    seed('context.summarize', 300)
    registerIpcHandlers(baseDeps())

    const res = await invoke('usage.local.summary', { sinceDays: 7 })
    expect(res.ok).toBe(true)
    if (!res.ok) return
    const data: LocalUsageSummaryDto = res.data
    expect(data.sinceDays).toBe(7)
    expect(data.totals.calls).toBe(2)
    expect(data.totals.computeMs).toBe(800)
    expect(data.byRole.map((r) => r.role).sort()).toEqual(['context.summarize', 'extraction.fuzzy'])
    // Live snapshot flowed through from the (fake) Ollama client.
    expect(data.loaded).toHaveLength(1)
    expect(data.ollamaState).toBe('ready')
  })

  it('answers with an empty live snapshot when the model layer is absent (ollama null)', async () => {
    seed('extraction.fuzzy', 500)
    registerIpcHandlers({ ...baseDeps(), ollama: null })

    const res = await invoke('usage.local.summary', {})
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.data.totals.calls).toBe(1)
    expect(res.data.loaded).toEqual([])
    expect(res.data.ollamaState).toBe('daemon-not-running')
    expect(res.data.sinceDays).toBe(30) // default window
  })

  it('is UNAVAILABLE when appdata.db did not boot', async () => {
    registerIpcHandlers({ ...baseDeps(), db: null })
    const res = await invoke('usage.local.summary', {})
    expect(res.ok).toBe(false)
    if (res.ok) return
    expect(res.code).toBe('UNAVAILABLE')
  })
})

describe('get_local_usage MCP read tool', () => {
  const def = MCP_TOOLS.find((t) => t.name === 'get_local_usage')

  it('is registered in the read tier with an input schema', () => {
    expect(def).toBeDefined()
    expect(def?.inputSchema).toBeTypeOf('object')
  })

  it('returns the same summary shape as the IPC channel', async () => {
    seed('scanner.llmVerdict', 250)
    const ctx = { db: app.db, ollama: fakeOllama } as unknown as ToolContext
    const out = (await def!.handle({ since_days: 14 }, ctx)) as LocalUsageSummaryDto
    expect(out.sinceDays).toBe(14)
    expect(out.totals.calls).toBe(1)
    expect(out.byRole[0]?.role).toBe('scanner.llmVerdict')
    expect(out.loaded).toHaveLength(1)
    expect(out.ollamaState).toBe('ready')
  })

  it('answers even with no model layer (ollama absent → empty snapshot)', async () => {
    const ctx = { db: app.db } as unknown as ToolContext
    const out = (await def!.handle({}, ctx)) as LocalUsageSummaryDto
    expect(out.loaded).toEqual([])
    expect(out.ollamaState).toBe('daemon-not-running')
  })

  it('rejects an out-of-range since_days', async () => {
    const ctx = { db: app.db } as unknown as ToolContext
    await expect(def!.handle({ since_days: -1 }, ctx)).rejects.toThrow(/invalid arguments/)
  })
})
