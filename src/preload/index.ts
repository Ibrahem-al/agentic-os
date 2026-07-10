import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import {
  IPC_EVENT_INGEST_PROGRESS,
  IPC_EVENT_OLLAMA_PULL,
  IPC_EVENT_UPDATER_STATUS,
  IPC_EVENT_WINDOW_MAXIMIZE,
  IPC_INVOKE_PREFIX,
  IPC_WINDOW_CLOSE,
  IPC_WINDOW_IS_MAXIMIZED,
  IPC_WINDOW_MINIMIZE,
  IPC_WINDOW_TOGGLE_MAXIMIZE,
  type IngestProgressEventDto,
  type IpcChannel,
  type IpcRequest,
  type IpcResponse,
  type IpcResult,
  type OllamaPullProgressDto,
  type UpdaterStatusDto
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

// NOTE: no appVersion here — npm_package_version is absent in packaged builds
// and would freeze a stale string. The real version crosses via `app.status`
// (the rail footer renders it); nothing in the renderer read the preload copy.
const api = {
  platform: process.platform,
  invoke,
  /** Subscribe to codebase-ingest progress pushes; returns unsubscribe. */
  onIngestProgress: subscribe<IngestProgressEventDto>(IPC_EVENT_INGEST_PROGRESS),
  /** Subscribe to Ollama model-pull progress pushes; returns unsubscribe. */
  onOllamaPull: subscribe<OllamaPullProgressDto>(IPC_EVENT_OLLAMA_PULL),
  /** Subscribe to auto-updater status pushes (Settings "Updates"); returns unsubscribe. */
  onUpdaterStatus: subscribe<UpdaterStatusDto>(IPC_EVENT_UPDATER_STATUS),
  /**
   * Window-chrome commands for the frameless title bar. Bespoke channels (not
   * the IpcChannels invoke map): OS window commands + chrome state, not DTOs.
   */
  window: {
    minimize: (): void => ipcRenderer.send(IPC_WINDOW_MINIMIZE),
    toggleMaximize: (): void => ipcRenderer.send(IPC_WINDOW_TOGGLE_MAXIMIZE),
    close: (): void => ipcRenderer.send(IPC_WINDOW_CLOSE),
    /** Current maximize state (seed for the restore icon). */
    isMaximized: (): Promise<boolean> => ipcRenderer.invoke(IPC_WINDOW_IS_MAXIMIZED) as Promise<boolean>,
    /** Subscribe to maximize-state pushes; returns unsubscribe. */
    onMaximizeChange: subscribe<boolean>(IPC_EVENT_WINDOW_MAXIMIZE)
  }
} as const

export type PreloadApi = typeof api

contextBridge.exposeInMainWorld('agenticOS', api)
