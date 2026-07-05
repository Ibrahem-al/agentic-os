/**
 * Auto-update boot (phase 13, §3 "seamless updates").
 *
 * electron-updater against the GitHub-releases feed declared in
 * electron-builder.yml (publish: github Ibrahem-al/agentic-os). Fully
 * background: this is a cockpit app, so the updater NEVER throws and NEVER
 * shows a dialog — every event is a '[updater] …' log line. autoDownload +
 * autoInstallOnAppQuit means an update lands silently and installs when the
 * app quits; the next boot then runs storage migrations behind the
 * pre-migration backup (§3), which the packaged smoke proves end-to-end.
 *
 * Honest note: the feed is the GitHub releases of a currently-PRIVATE repo.
 * Until the repo (or its releases) is public, checkForUpdatesAndNotify()
 * rejects with an auth/404 error on every packaged boot — that rejection is
 * swallowed and logged here, so it is harmless by design.
 *
 * Deps are injectable so unit tests can drive a fake updater without Electron
 * (electron-updater is CJS and touches `electron` at require time, so it is
 * loaded lazily through createRequire only on the packaged path).
 */
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)

/** The minimal slice of electron-updater's AppUpdater that boot needs. */
export interface UpdaterLike {
  autoDownload: boolean
  autoInstallOnAppQuit: boolean
  on(event: 'error' | 'update-available' | 'update-downloaded', listener: (payload?: unknown) => void): unknown
  checkForUpdatesAndNotify(): Promise<unknown>
}

export interface BootUpdaterDeps {
  /** Default: Electron's app.isPackaged. */
  isPackaged?: boolean
  /** Default: electron-updater's autoUpdater singleton (lazy CJS require). */
  updater?: UpdaterLike
  /** Default: console.log. */
  log?: (line: string) => void
}

function versionOf(payload: unknown): string {
  if (typeof payload === 'object' && payload !== null && 'version' in payload) {
    return String((payload as { version: unknown }).version)
  }
  return 'unknown'
}

export function bootUpdater(deps: BootUpdaterDeps = {}): void {
  const log = deps.log ?? console.log
  try {
    const isPackaged =
      deps.isPackaged ?? (require('electron') as { app: { isPackaged: boolean } }).app.isPackaged
    if (!isPackaged) {
      log('[updater] dev build — auto-update disabled')
      return
    }
    const updater =
      deps.updater ?? (require('electron-updater') as { autoUpdater: UpdaterLike }).autoUpdater
    updater.autoDownload = true
    updater.autoInstallOnAppQuit = true
    updater.on('error', (err) => log(`[updater] error: ${String(err)}`))
    updater.on('update-available', (info) => log(`[updater] update available: v${versionOf(info)} — downloading in background`))
    updater.on('update-downloaded', (info) => log(`[updater] update downloaded: v${versionOf(info)} — installs on quit`))
    log('[updater] packaged build — checking GitHub releases (Ibrahem-al/agentic-os)')
    updater.checkForUpdatesAndNotify().catch((err: unknown) => log(`[updater] update check failed: ${String(err)}`))
  } catch (err) {
    // Never let the updater take the boot down.
    log(`[updater] unavailable: ${String(err)} — auto-update disabled this launch`)
  }
}
