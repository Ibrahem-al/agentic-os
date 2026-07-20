/**
 * Auto-update boot + controller (phase 13, §3 "seamless updates"; extended for
 * the Settings "Updates" section).
 *
 * electron-updater against the GitHub-releases feed declared in
 * electron-builder.yml (publish: github Ibrahem-al/agentic-os). Still fully
 * background by default: this is a cockpit app, so the updater NEVER throws and
 * NEVER shows a native dialog — every event is a '[updater] …' log line, and
 * autoDownload + autoInstallOnAppQuit means an update lands silently and
 * installs when the app quits; the next boot then runs storage migrations behind
 * the pre-migration backup (§3), which the packaged smoke proves end-to-end.
 *
 * On TOP of that background behaviour, bootUpdater now returns a small
 * controller so the Settings panel can (a) read a live snapshot of updater
 * state, (b) trigger a manual check, (c) watch download progress, and (d) ask
 * the user to restart-to-install once an update is downloaded. Every state
 * transition (including throttled download-progress ticks) fires onStatusChange
 * so the main process can push the snapshot to the renderer over IPC — the same
 * shape returned by the `updater.status` / `updater.check` / `updater.install`
 * channels. Errors never cross IPC as rejections; they land in the snapshot.
 *
 * Honest note: the feed is the GitHub releases of a currently-PRIVATE repo.
 * Until the repo (or its releases) is public, the boot check rejects with an
 * auth/404 error on every packaged launch — that rejection is swallowed, logged,
 * and surfaced as the snapshot's 'error' state (harmless by design).
 *
 * Deps are injectable so unit tests can drive a fake updater without Electron
 * (electron-updater is CJS and touches `electron` at require time, so it is
 * loaded lazily through createRequire only on the packaged path).
 */
import { createRequire } from 'node:module'
import type { UpdaterStatusDto } from '../shared/ipc'

const require = createRequire(import.meta.url)

/** electron-updater's AppUpdater events the controller listens to. */
type UpdaterEvent =
  | 'error'
  | 'checking-for-update'
  | 'update-available'
  | 'update-not-available'
  | 'download-progress'
  | 'update-downloaded'

/** The minimal slice of electron-updater's AppUpdater the controller needs. */
export interface UpdaterLike {
  autoDownload: boolean
  autoInstallOnAppQuit: boolean
  on(event: UpdaterEvent, listener: (payload?: unknown) => void): unknown
  /** Background boot check (autoDownload + notify) — the phase-13 behaviour. */
  checkForUpdatesAndNotify(): Promise<unknown>
  /** Manual check driven by the Settings "Check for updates" action. */
  checkForUpdates(): Promise<unknown>
  /** Quit + install a downloaded update (user-confirmed restart). */
  quitAndInstall(): void
}

export interface BootUpdaterDeps {
  /** Default: Electron's app.isPackaged. */
  isPackaged?: boolean
  /** Default: electron-updater's autoUpdater singleton (lazy CJS require). */
  updater?: UpdaterLike
  /** Default: console.log. */
  log?: (line: string) => void
  /** Test seam: monotonic clock for the download-progress throttle. Default Date.now. */
  now?: () => number
}

/**
 * The controller bootUpdater returns. `status()` is the current snapshot;
 * `check()` triggers a manual check (no-op while already checking/downloading);
 * `quitAndInstall()` restarts to install (no-op unless an update is downloaded);
 * `onStatusChange` notifies on every transition and returns an unsubscribe.
 */
export interface UpdaterController {
  status(): UpdaterStatusDto
  check(): Promise<UpdaterStatusDto>
  quitAndInstall(): void
  onStatusChange(cb: (status: UpdaterStatusDto) => void): () => void
}

/** At most ~4 progress pushes/second so IPC does not flood during a download. */
const PROGRESS_MIN_INTERVAL_MS = 250

function versionOf(payload: unknown): string {
  if (typeof payload === 'object' && payload !== null && 'version' in payload) {
    return String((payload as { version: unknown }).version)
  }
  return 'unknown'
}

/** { version } only when the payload carried a real version (else omit — DTO optional). */
function versionField(payload: unknown): { version: string } | Record<string, never> {
  const version = versionOf(payload)
  return version !== 'unknown' ? { version } : {}
}

/**
 * Bound on normalized release-notes text carried in every updater snapshot push
 * (including throttled download-progress ticks) so a giant GitHub release body
 * can never bloat IPC. Truncated notes end with a "…" line. Rule-12 pick.
 */
const RELEASE_NOTES_MAX_CHARS = 10_000

/**
 * Strip HTML from a release body (electron-updater's GitHub provider delivers
 * HTML in some versions) — the notes are UNTRUSTED. Block-closing tags become
 * newlines, every other tag is deleted, then the five common entities are
 * decoded (&amp; LAST so a decoded tag can't re-form one). Pure string ops — the
 * renderer additionally escapes the result, so this is defense-in-depth, not the
 * sole guard. Any leftover encoded tag simply shows as literal text.
 */
function stripReleaseHtml(text: string): string {
  return text
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|h[1-6])>/gi, '\n')
    .replace(/<[^>]*>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/\n{3,}/g, '\n\n')
}

/**
 * Normalize electron-updater's `UpdateInfo.releaseNotes` (string | Array<{version,
 * note}> | null | odd shapes) into one UNTRUSTED string, newest-version-first.
 * Defensive: never throws on a malformed payload (the updater must not crash).
 * HTML-stripped + length-capped here; the renderer escapes it as text too.
 */
function releaseNotesOf(payload: unknown): string | undefined {
  if (typeof payload !== 'object' || payload === null || !('releaseNotes' in payload)) return undefined
  const raw = (payload as { releaseNotes: unknown }).releaseNotes
  let text: string
  if (typeof raw === 'string') {
    text = raw
  } else if (Array.isArray(raw)) {
    // Array<{ version, note }> for several skipped versions — keep the feed's
    // order (electron-updater lists newest first) and label each block.
    text = raw
      .map((entry) => {
        const e = (typeof entry === 'object' && entry !== null ? entry : {}) as Record<string, unknown>
        const v = typeof e['version'] === 'string' ? e['version'] : ''
        const note = typeof e['note'] === 'string' ? e['note'] : ''
        if (note.trim() === '') return ''
        return v !== '' ? `## ${v}\n${note}` : note
      })
      .filter((s) => s !== '')
      .join('\n\n')
  } else {
    return undefined
  }
  const cleaned = stripReleaseHtml(text).trim()
  if (cleaned === '') return undefined
  return cleaned.length > RELEASE_NOTES_MAX_CHARS ? `${cleaned.slice(0, RELEASE_NOTES_MAX_CHARS)}\n\n…` : cleaned
}

/** A string field from the payload, omitted when absent/blank (exactOptional spread). */
function stringField<K extends string>(key: K, payload: unknown, sourceKey: string): Record<K, string> | Record<string, never> {
  if (typeof payload !== 'object' || payload === null) return {}
  const v = (payload as Record<string, unknown>)[sourceKey]
  return typeof v === 'string' && v.trim() !== '' ? ({ [key]: v } as Record<K, string>) : {}
}

/** The release-metadata fields (notes/name/date) for an update-available/downloaded payload. */
function releaseMetaFields(payload: unknown): Partial<UpdaterStatusDto> {
  const notes = releaseNotesOf(payload)
  return {
    ...(notes !== undefined ? { releaseNotes: notes } : {}),
    ...stringField('releaseName', payload, 'releaseName'),
    ...stringField('releaseDate', payload, 'releaseDate')
  }
}

/** Finite-number field extractor for the exactOptionalPropertyTypes spread pattern. */
function numberField<K extends string>(key: K, value: unknown): Record<K, number> | Record<string, never> {
  return typeof value === 'number' && Number.isFinite(value) ? ({ [key]: value } as Record<K, number>) : {}
}

/** Map a download-progress payload → the numeric snapshot fields, carrying the version. */
function progressFields(payload: unknown, version: string | undefined): Partial<UpdaterStatusDto> {
  const p = (typeof payload === 'object' && payload !== null ? payload : {}) as Record<string, unknown>
  return {
    ...(version !== undefined ? { version } : {}),
    ...numberField('percent', p['percent']),
    ...numberField('bytesPerSecond', p['bytesPerSecond']),
    ...numberField('transferred', p['transferred']),
    ...numberField('total', p['total'])
  }
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

// ── install quiesce (§21.9 crash-safety, G5+G6) ──────────────────────────────

/**
 * Total time updater.install waits for in-flight work to drain before it either
 * installs (idle) or defers (still busy). The user already chose to restart, so a
 * short bound keeps the app responsive; the deferred path loses nothing (the
 * update applies on the next quit via autoInstallOnAppQuit).
 */
const UPDATER_QUIESCE_TIMEOUT_MS = 30_000
/** How often the quiesce guard re-checks the queue + write lane while waiting. */
const UPDATER_QUIESCE_POLL_MS = 200

/** Structural slice of the storage engine the install quiesce needs (§21.9). */
export interface QuiesceEngine {
  /** True when the write lane has no pending or running job. */
  laneIdle(): boolean
  /** Force a checkpoint so the on-disk graph is current before the new binary boots. */
  checkpoint(): Promise<void>
}

/** Structural slice of the durable task queue the install quiesce needs. */
export interface QuiesceQueue {
  /** The id of the task executing right now, or null when the queue is idle. */
  readonly runningTaskId: string | null
}

export interface QuiesceForInstallDeps {
  readonly engine: QuiesceEngine | null
  readonly queue: QuiesceQueue | null
  /** Test seams. */
  readonly timeoutMs?: number
  readonly pollMs?: number
  readonly now?: () => number
  readonly sleep?: (ms: number) => Promise<void>
  readonly log?: (line: string) => void
}

export interface QuiesceForInstallResult {
  /** True: the queue + write lane drained (or there was nothing to drain) — safe to install now. */
  readonly idle: boolean
  /** True when a pre-install checkpoint was forced (only on the idle path). */
  readonly checkpointed: boolean
}

/**
 * G5+G6 pre-install quiesce: `quitAndInstall` bypasses the will-quit bounded
 * drain and relaunches into the new binary, which runs storage migrations at its
 * first boot. So before installing, wait (bounded) for the durable queue's
 * running task to finish AND the single write lane to go idle, then force a
 * checkpoint so the graph on disk is current (the new version never falls back to
 * a stale checkpoint). If still busy after the bound, DON'T install — return
 * `idle:false`; the caller defers and autoInstallOnAppQuit applies the update on
 * the next ordinary quit. Never throws (a failed checkpoint is best-effort — WAL
 * replay recovers).
 */
export async function quiesceForInstall(deps: QuiesceForInstallDeps): Promise<QuiesceForInstallResult> {
  const timeoutMs = deps.timeoutMs ?? UPDATER_QUIESCE_TIMEOUT_MS
  const pollMs = deps.pollMs ?? UPDATER_QUIESCE_POLL_MS
  const now = deps.now ?? Date.now
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
  const log = deps.log ?? (() => undefined)

  const busy = (): boolean =>
    (deps.queue?.runningTaskId ?? null) !== null || (deps.engine !== null && !deps.engine.laneIdle())

  const deadline = now() + timeoutMs
  while (busy()) {
    if (now() >= deadline) {
      log('[updater] install deferred — a write is still in flight after the quiesce bound; the update applies on the next quit')
      return { idle: false, checkpointed: false }
    }
    await sleep(pollMs)
  }

  // Idle: checkpoint so the new version boots off a current graph, not a stale one.
  let checkpointed = false
  if (deps.engine !== null) {
    try {
      await deps.engine.checkpoint()
      checkpointed = true
    } catch (err) {
      log(`[updater] pre-install checkpoint failed (WAL replay will recover): ${errorText(err)}`)
    }
  }
  return { idle: true, checkpointed }
}

export function bootUpdater(deps: BootUpdaterDeps = {}): UpdaterController {
  const log = deps.log ?? console.log
  const now = deps.now ?? Date.now

  let snapshot: UpdaterStatusDto = { state: 'idle' }
  const listeners = new Set<(status: UpdaterStatusDto) => void>()
  let lastProgressAt = 0
  // Release notes/name/date captured on update-available, re-applied to every
  // download-progress tick (which only carries numbers) so the notes stay visible
  // right through to the 'downloaded' state where the user reads them before restart.
  let releaseMeta: Partial<UpdaterStatusDto> = {}

  const notify = (): void => {
    for (const cb of listeners) cb(snapshot)
  }

  /**
   * Replace the snapshot and notify. Progress ticks (throttle:true) always
   * update the snapshot (so status() is current) but push at most ~4/second;
   * every other transition — checking, downloading, downloaded, up-to-date,
   * error — always pushes.
   */
  const setSnapshot = (next: UpdaterStatusDto, throttle = false): void => {
    snapshot = next
    if (throttle) {
      const at = now()
      if (at - lastProgressAt < PROGRESS_MIN_INTERVAL_MS) return
      lastProgressAt = at
    }
    notify()
  }

  // Assigned on the packaged path; stays null in dev / when the updater is
  // unavailable, which makes check()/quitAndInstall() clean no-ops.
  let updater: UpdaterLike | null = null

  const controller: UpdaterController = {
    status: () => snapshot,
    check: async (): Promise<UpdaterStatusDto> => {
      if (updater === null) return snapshot // disabled — nothing to check
      if (snapshot.state === 'checking' || snapshot.state === 'downloading') return snapshot
      setSnapshot({ state: 'checking' })
      try {
        await updater.checkForUpdates()
      } catch (err) {
        // Never throw across IPC: the failure is the snapshot. (The 'error'
        // event usually fires too; last-writer-wins, both say error.)
        setSnapshot({ state: 'error', error: errorText(err) })
      }
      return snapshot
    },
    quitAndInstall: (): void => {
      if (updater === null) {
        log('[updater] restart-to-install ignored — auto-update disabled this launch')
        return
      }
      if (snapshot.state !== 'downloaded') {
        log(`[updater] restart-to-install ignored — no update downloaded (state: ${snapshot.state})`)
        return
      }
      log('[updater] restart-to-install confirmed — quitting to apply the update')
      updater.quitAndInstall()
    },
    onStatusChange: (cb): (() => void) => {
      listeners.add(cb)
      return () => listeners.delete(cb)
    }
  }

  try {
    const isPackaged =
      deps.isPackaged ?? (require('electron') as { app: { isPackaged: boolean } }).app.isPackaged
    if (!isPackaged) {
      log('[updater] dev build — auto-update disabled')
      snapshot = { state: 'disabled', detail: 'auto-update runs only in the installed (packaged) app' }
      return controller
    }
    updater = deps.updater ?? (require('electron-updater') as { autoUpdater: UpdaterLike }).autoUpdater
    updater.autoDownload = true
    updater.autoInstallOnAppQuit = true
    // Quiet ticks (no log): checking / not-available / download-progress.
    updater.on('checking-for-update', () => setSnapshot({ state: 'checking' }))
    updater.on('update-not-available', (info) => {
      releaseMeta = {}
      setSnapshot({ state: 'up-to-date', ...versionField(info) })
    })
    updater.on('download-progress', (p) =>
      setSnapshot({ state: 'downloading', ...progressFields(p, snapshot.version), ...releaseMeta }, true)
    )
    // Logged transitions (preserve the phase-13 background log lines).
    updater.on('update-available', (info) => {
      log(`[updater] update available: v${versionOf(info)} — downloading in background`)
      releaseMeta = releaseMetaFields(info) // captured once; re-applied to every progress tick
      setSnapshot({ state: 'downloading', ...versionField(info), ...releaseMeta })
    })
    updater.on('update-downloaded', (info) => {
      log(`[updater] update downloaded: v${versionOf(info)} — installs on quit`)
      // Prefer the downloaded payload's notes; fall back to what update-available captured.
      const downloadedMeta = releaseMetaFields(info)
      releaseMeta = downloadedMeta.releaseNotes !== undefined ? downloadedMeta : { ...releaseMeta, ...downloadedMeta }
      setSnapshot({ state: 'downloaded', percent: 100, ...versionField(info), ...releaseMeta })
    })
    updater.on('error', (err) => {
      log(`[updater] error: ${String(err)}`)
      setSnapshot({ state: 'error', error: errorText(err) })
    })
    log('[updater] packaged build — checking GitHub releases (Ibrahem-al/agentic-os)')
    updater.checkForUpdatesAndNotify().catch((err: unknown) => {
      log(`[updater] update check failed: ${String(err)}`)
      setSnapshot({ state: 'error', error: errorText(err) })
    })
  } catch (err) {
    // Never let the updater take the boot down.
    log(`[updater] unavailable: ${String(err)} — auto-update disabled this launch`)
    updater = null
    snapshot = { state: 'disabled', detail: `updater unavailable: ${errorText(err)}` }
  }
  return controller
}
