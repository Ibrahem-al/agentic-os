import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import {
  IPC_EVENT_INGEST_PROGRESS,
  IPC_EVENT_OLLAMA_PULL,
  IPC_INVOKE_PREFIX,
  type IngestProgressEventDto,
  type IpcChannel,
  type IpcRequest,
  type IpcResponse,
  type IpcResult,
  type OllamaPullProgressDto
} from '../shared/ipc'

/**
 * Typed IPC bridge (spec §21 rule 8: renderer has no Node access; all
 * privileged work crosses this contract). One generic `invoke` derived from
 * the shared channel map — the renderer cannot name a channel that does not
 * exist in src/shared/ipc.ts, and every response arrives as an IpcResult
 * envelope with structured errors.
 */
const invoke = <C extends IpcChannel>(channel: C, req: IpcRequest<C>): Promise<IpcResult<IpcResponse<C>>> =>
  ipcRenderer.invoke(`${IPC_INVOKE_PREFIX}${channel}`, req) as Promise<IpcResult<IpcResponse<C>>>

const subscribe = <T>(eventChannel: string) => {
  return (callback: (payload: T) => void): (() => void) => {
    const listener = (_event: IpcRendererEvent, payload: T): void => callback(payload)
    ipcRenderer.on(eventChannel, listener)
    return () => ipcRenderer.removeListener(eventChannel, listener)
  }
}

const api = {
  appVersion: process.env['npm_package_version'] ?? '0.0.1',
  platform: process.platform,
  invoke,
  /** Subscribe to codebase-ingest progress pushes; returns unsubscribe. */
  onIngestProgress: subscribe<IngestProgressEventDto>(IPC_EVENT_INGEST_PROGRESS),
  /** Subscribe to Ollama model-pull progress pushes; returns unsubscribe. */
  onOllamaPull: subscribe<OllamaPullProgressDto>(IPC_EVENT_OLLAMA_PULL)
} as const

export type PreloadApi = typeof api

contextBridge.exposeInMainWorld('agenticOS', api)
