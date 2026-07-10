/**
 * Data & backups — the app's user-facing "version history of its own data"
 * (Settings → Data & backups). Manual + automatic backups, restore-to-a-point,
 * a data export, and a "reset to defaults" that keeps every backup.
 *
 * THE HARD CONSTRAINT (empirically verified, this repo, Windows): while the app
 * runs, RyuGraph holds an OS lock on `graph/graph.ryugraph` — even a raw
 * `readSync` at offset 0 fails EBUSY, so the graph directory CANNOT be
 * file-copied live. Every graph-inclusive snapshot is therefore STAGED and
 * executed at BOOT, before the engine opens (the graph is unlocked there) — the
 * exact discipline `performPendingReset` already uses. Concretely:
 *   - Manual "Backup now" / Restore / Reset write a marker + relaunch; boot
 *     performs the graph-safe operation before opening the store.
 *   - Auto-backups run as a boot-time catch-up (newest `-auto` older than the
 *     interval → snapshot, then prune); the running-app scheduler can only STAGE
 *     a marker for the next boot (it cannot copy the locked graph live).
 *   - `exportData` is the one LIVE path: it dumps the graph LOGICALLY through
 *     the engine (exportGraph — read-only, lane-quiesced) plus a VACUUM-INTO of
 *     appdata.db, so it needs no file lock.
 *
 * This module owns the shared snapshot primitive (`snapshotUserData`) that
 * `reset.ts` also calls — same verified copy (graph closed-file cpSync + appdata
 * VACUUM INTO + integrity_check + graph count match) — plus the clear ALLOWLIST
 * both reset and restore delete through (restore uses RESTORE_CLEAR_ENTRIES, the
 * same list minus the re-downloadable models/ and bin/). `backups/` is
 * structurally never in either list, so historical backups always survive a
 * reset or a restore.
 *
 * Electron-free: every path is a function of `userDataDir`, the unit-test seam.
 */
import {
  cpSync,
  type Dirent,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { basename, dirname, join } from 'node:path'
import {
  appDataPaths,
  AUTO_BACKUP_LABEL,
  BACKUP_DEFAULT_ENABLED,
  BACKUP_DEFAULT_INTERVAL_HOURS,
  BACKUP_DEFAULT_KEEP_LAST,
  BACKUP_INTERVAL_HOURS_CHOICES,
  BACKUP_MARKER_FILENAME,
  BACKUP_SETTINGS_FILENAME,
  MANUAL_BACKUP_LABEL,
  MCP_SERVERS_CONFIG_FILENAME,
  PRE_RESTORE_BACKUP_LABEL,
  RESTORE_MARKER_FILENAME,
  TRIGGER_STATE_FILENAME,
  WATCHED_FOLDERS_CONFIG_FILENAME
} from '../config'
import { KEYCHAIN_FILENAME } from '../models/keychain'
import { SETTINGS_FILENAME } from '../models/settings'
import { appDataIntegrityOk, snapshotAppDataDb } from './appdata'
import type { StorageEngine } from './engine'
import { exportGraph } from './export'
import { graphDirHasData } from './migrations'

/** Single-arg logger (boot passes `console.log`). */
export type BackupLogger = (message: string) => void

/** The classified kind of a directory under `backups/`. */
export type BackupKind =
  | 'manual'
  | 'auto'
  | 'pre-reset'
  | 'pre-restore'
  | 'pre-migration'
  | 'corrupt-wal'
  | 'unknown'

/** One directory under `backups/`, as the Settings list shows it. */
export interface BackupEntry {
  readonly dirName: string
  readonly kind: BackupKind
  /** Parsed from the directory-name stamp; null when unparseable. */
  readonly createdAt: string | null
  readonly bytes: number
  readonly files: number
  /** Contains a graph copy or an appdata.db → can be restored to. */
  readonly restorable: boolean
}

/** Persisted auto-backup preferences (see config.ts for the rule-12 defaults). */
export interface BackupSettings {
  readonly enabled: boolean
  readonly intervalHours: number
  readonly keepLast: number
  readonly keepDays?: number
}

/** Result of one snapshot — reused verbatim in reset-record.json / backup-record.json. */
export interface SnapshotResult {
  readonly backupDir: string
  readonly graph: { files: number; bytes: number } | null
  readonly appdata: boolean
  readonly files: string[]
  readonly checks: { appdataIntegrity: 'ok' | 'skipped'; graphCountMatch: true | 'skipped' }
}

// ── stamps / paths ────────────────────────────────────────────────────────────

/** The lexicographically-sortable stamp the backup dirs share (ISO, ':'→'-'). */
export function stampNow(): string {
  return new Date().toISOString().replaceAll(':', '-').replace(/\.\d+Z$/, 'Z')
}

export function backupMarkerPath(userDataDir: string): string {
  return join(userDataDir, BACKUP_MARKER_FILENAME)
}

export function restoreMarkerPath(userDataDir: string): string {
  return join(userDataDir, RESTORE_MARKER_FILENAME)
}

/** A fresh, non-colliding `backups/<stamp>-<label>/` path (a `-2`, `-3` … suffix
 * on the astronomically-unlikely same-second collision). Not yet created. */
function uniqueBackupDir(backupsDir: string, label: string): string {
  const base = join(backupsDir, `${stampNow()}-${label}`)
  let dir = base
  for (let n = 2; existsSync(dir); n++) dir = `${base}-${n}`
  return dir
}

// ── shared snapshot primitive (reset.ts + createBackup + restore all use it) ──

/**
 * Config files copied into a snapshot. The crown jewels (graph/, appdata.db) are
 * handled separately with their format-aware copies; these are small flat files.
 * models/ and bin/ are deliberately absent — large, checksum-pinned,
 * re-downloadable (documented). keychain.bin IS included (api keys + the MCP
 * token are part of a restore point) — but never in the user-facing EXPORT.
 */
export const SNAPSHOT_FILES: readonly string[] = [
  KEYCHAIN_FILENAME,
  SETTINGS_FILENAME,
  BACKUP_SETTINGS_FILENAME,
  MCP_SERVERS_CONFIG_FILENAME,
  WATCHED_FOLDERS_CONFIG_FILENAME,
  TRIGGER_STATE_FILENAME
]

/**
 * The explicit clear ALLOWLIST — every user-data path a RESET removes, and
 * NOTHING else. `backups/`, `data-manifest.json` and the markers are
 * deliberately absent: backups (incl. the just-written pre-reset/pre-restore
 * snapshot) must survive, the manifest is rewritten by boot, and the marker is
 * removed last. Never `rm(userDataDir)`.
 */
export const CLEAR_ENTRIES: readonly string[] = [
  'graph',
  'appdata.db',
  'appdata.db-wal',
  'appdata.db-shm',
  'models',
  'bin',
  'exports',
  'runner',
  KEYCHAIN_FILENAME,
  SETTINGS_FILENAME,
  BACKUP_SETTINGS_FILENAME,
  MCP_SERVERS_CONFIG_FILENAME,
  WATCHED_FOLDERS_CONFIG_FILENAME,
  TRIGGER_STATE_FILENAME,
  '.mcp.json'
]

/**
 * What a RESTORE clears: the shared allowlist MINUS models/ and bin/. Backups
 * never contain them (large, checksum-pinned, re-downloadable), so clearing
 * them on restore serves no purpose and would only cost the user a ~570 MB
 * model re-download after every restore. Reset keeps the FULL list — reset
 * means back-to-defaults, and a fresh install has no models/ or bin/ either.
 */
export const RESTORE_CLEAR_ENTRIES: readonly string[] = CLEAR_ENTRIES.filter(
  (entry) => entry !== 'models' && entry !== 'bin'
)

/** Recursive {files, bytes} of a directory tree (for the graph copy check). */
export function countTree(dir: string): { files: number; bytes: number } {
  let files = 0
  let bytes = 0
  const stack: string[] = [dir]
  while (stack.length > 0) {
    const cur = stack.pop() as string
    let entries: Dirent[]
    try {
      entries = readdirSync(cur, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      const p = join(cur, entry.name)
      if (entry.isDirectory()) {
        stack.push(p)
      } else if (entry.isFile()) {
        try {
          bytes += statSync(p).size
          files += 1
        } catch {
          /* raced deletion — ignore */
        }
      }
    }
  }
  return { files, bytes }
}

/**
 * Best-effort recursive delete of each allowlist entry; never throws. Defaults
 * to the full reset list; restore passes RESTORE_CLEAR_ENTRIES (models/ and
 * bin/ kept — see that constant).
 */
export function clearAllowlist(userDataDir: string, log: BackupLogger, entries: readonly string[] = CLEAR_ENTRIES): void {
  for (const rel of entries) {
    try {
      rmSync(join(userDataDir, rel), { recursive: true, force: true })
    } catch (err) {
      // A locked file just means that one asset was not cleared — it is still
      // present AND fully backed up. Log and keep going.
      log(`[storage] backups: could not clear ${rel} (${String(err)}); left in place (still backed up)`)
    }
  }
}

/**
 * Snapshot the live user data into `backupDir` and VERIFY it, writing a
 * `backup-record.json` inventory. Copies:
 *   - graph/  (closed-file cpSync — the caller MUST guarantee the engine is not
 *     open, i.e. this runs at boot before openRyuGraphEngine or against a closed
 *     store; the graph is OS-locked while the engine holds it — verified),
 *   - appdata.db (VACUUM INTO — read-only, WAL-valid, online-safe),
 *   - the config files that exist, and exports/.
 * Verifies BEFORE returning: the appdata snapshot passes PRAGMA integrity_check
 * and the graph copy matches the source file-count + byte-total. THROWS on a
 * verify failure (so a caller that clears afterwards — reset/restore — aborts
 * with the live data still intact). Idempotent-safe: an empty store yields an
 * empty (but valid) snapshot.
 */
export function snapshotUserData(
  userDataDir: string,
  backupDir: string,
  log: BackupLogger,
  opts: { kind: string }
): SnapshotResult {
  const paths = appDataPaths(userDataDir)
  mkdirSync(backupDir, { recursive: true })

  // Snapshot ------------------------------------------------------------------
  let graph: { files: number; bytes: number } | null = null
  if (graphDirHasData(paths.graphDir)) {
    cpSync(paths.graphDir, join(backupDir, 'graph'), { recursive: true })
    graph = countTree(join(backupDir, 'graph'))
  }

  let appdata = false
  if (existsSync(paths.appDb)) {
    snapshotAppDataDb(paths.appDb, join(backupDir, 'appdata.db'))
    appdata = true
  }

  const files: string[] = []
  for (const rel of SNAPSHOT_FILES) {
    const src = join(userDataDir, rel)
    if (existsSync(src)) {
      cpSync(src, join(backupDir, rel))
      files.push(rel)
    }
  }
  if (existsSync(paths.exportsDir)) {
    cpSync(paths.exportsDir, join(backupDir, 'exports'), { recursive: true })
    files.push('exports')
  }

  // Verify BEFORE the record is written (and before any caller clears) --------
  if (appdata && !appDataIntegrityOk(join(backupDir, 'appdata.db'))) {
    throw new Error('appdata.db snapshot failed PRAGMA integrity_check')
  }
  if (graph !== null) {
    const source = countTree(paths.graphDir)
    if (source.files !== graph.files || source.bytes !== graph.bytes) {
      throw new Error(
        `graph snapshot mismatch — source ${source.files} files / ${source.bytes} bytes, copy ${graph.files} files / ${graph.bytes} bytes`
      )
    }
  }

  const checks = {
    appdataIntegrity: (appdata ? 'ok' : 'skipped') as 'ok' | 'skipped',
    graphCountMatch: (graph !== null ? true : 'skipped') as true | 'skipped'
  }
  const record = {
    recordVersion: 1,
    kind: opts.kind,
    createdAt: new Date().toISOString(),
    backupDir,
    snapshot: { graph, appdata, files },
    checks
  }
  writeFileSync(join(backupDir, 'backup-record.json'), `${JSON.stringify(record, null, 2)}\n`)
  log(`[storage] backup snapshot written to ${backupDir} (kind ${opts.kind})`)
  return { backupDir, graph, appdata, files, checks }
}

// ── settings ──────────────────────────────────────────────────────────────────

export function backupSettingsPath(userDataDir: string): string {
  return join(userDataDir, BACKUP_SETTINGS_FILENAME)
}

/** The rule-12 default backup preferences (auto-on, daily, keep 10). */
export function defaultBackupSettings(): BackupSettings {
  return {
    enabled: BACKUP_DEFAULT_ENABLED,
    intervalHours: BACKUP_DEFAULT_INTERVAL_HOURS,
    keepLast: BACKUP_DEFAULT_KEEP_LAST
  }
}

/** Clamp/normalize an arbitrary object into valid BackupSettings (never throws). */
export function normalizeBackupSettings(value: unknown): BackupSettings {
  const d = defaultBackupSettings()
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return d
  const v = value as Record<string, unknown>
  const enabled = typeof v['enabled'] === 'boolean' ? (v['enabled'] as boolean) : d.enabled
  const intervalHours = (BACKUP_INTERVAL_HOURS_CHOICES as readonly number[]).includes(v['intervalHours'] as number)
    ? (v['intervalHours'] as number)
    : d.intervalHours
  const keepLast =
    typeof v['keepLast'] === 'number' && Number.isFinite(v['keepLast']) && (v['keepLast'] as number) >= 1
      ? Math.floor(v['keepLast'] as number)
      : d.keepLast
  const keepDaysRaw = v['keepDays']
  const keepDays =
    typeof keepDaysRaw === 'number' && Number.isFinite(keepDaysRaw) && keepDaysRaw >= 1
      ? Math.floor(keepDaysRaw)
      : undefined
  return { enabled, intervalHours, keepLast, ...(keepDays !== undefined ? { keepDays } : {}) }
}

/** Load backup preferences; a missing/malformed file yields defaults (logged). */
export function loadBackupSettings(userDataDir: string, log: BackupLogger = () => {}): BackupSettings {
  let raw: string
  try {
    raw = readFileSync(backupSettingsPath(userDataDir), 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return defaultBackupSettings()
    log(`[storage] backup-settings unreadable (${String(err)}); using defaults`)
    return defaultBackupSettings()
  }
  try {
    return normalizeBackupSettings(JSON.parse(raw))
  } catch (err) {
    log(`[storage] backup-settings malformed (${String(err)}); using defaults`)
    return defaultBackupSettings()
  }
}

/** Atomic write (tmp + rename), matching settings.ts's crash discipline. */
export function saveBackupSettings(userDataDir: string, settings: BackupSettings): BackupSettings {
  const normalized = normalizeBackupSettings(settings)
  const filePath = backupSettingsPath(userDataDir)
  mkdirSync(dirname(filePath), { recursive: true })
  const tmp = `${filePath}.tmp`
  try {
    writeFileSync(tmp, `${JSON.stringify(normalized, null, 2)}\n`, 'utf8')
    renameSync(tmp, filePath)
  } catch (err) {
    rmSync(tmp, { force: true })
    throw err
  }
  return normalized
}

// ── listing ─────────────────────────────────────────────────────────────────

const STAMP_RE = /^(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}Z)-(.+)$/

/** Parse a `<stamp>-<label>` dir name into an ISO createdAt + the label. */
function parseDirName(dirName: string): { createdAt: string | null; label: string } {
  const m = STAMP_RE.exec(dirName)
  if (m === null) return { createdAt: null, label: dirName }
  const stamp = m[1] as string
  const label = m[2] as string
  // Reverse ':'→'-' on the TIME part only: date is YYYY-MM-DD, time is HH-MM-SS.
  const iso = `${stamp.slice(0, 10)}T${stamp.slice(11, 19).replaceAll('-', ':')}Z`
  const parsed = Date.parse(iso)
  return { createdAt: Number.isNaN(parsed) ? null : new Date(parsed).toISOString(), label }
}

/** Classify a directory label into a BackupKind. */
function classifyLabel(label: string): BackupKind {
  if (label.startsWith(MANUAL_BACKUP_LABEL)) return 'manual'
  if (label.startsWith(AUTO_BACKUP_LABEL)) return 'auto'
  if (label.startsWith('pre-reset')) return 'pre-reset'
  if (label.startsWith(PRE_RESTORE_BACKUP_LABEL)) return 'pre-restore'
  if (label.startsWith('pre-migration') || label.startsWith('pre-appdata')) return 'pre-migration'
  if (label.startsWith('corrupt-wal')) return 'corrupt-wal'
  return 'unknown'
}

/** A dir is restorable when it carries a graph copy or an appdata.db snapshot. */
function isRestorableDir(dir: string): boolean {
  return graphDirHasData(join(dir, 'graph')) || existsSync(join(dir, 'appdata.db'))
}

/** Every directory under `backups/`, classified, newest first. */
export function listBackups(userDataDir: string): BackupEntry[] {
  const backupsDir = appDataPaths(userDataDir).backupsDir
  let names: string[]
  try {
    names = readdirSync(backupsDir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
  } catch {
    return []
  }
  const entries = names.map((dirName): BackupEntry => {
    const dir = join(backupsDir, dirName)
    const { createdAt, label } = parseDirName(dirName)
    const kind = classifyLabel(label)
    const { files, bytes } = countTree(dir)
    // A corrupt-wal quarantine is never a restore point (WAL fragments only).
    const restorable = kind !== 'corrupt-wal' && isRestorableDir(dir)
    return { dirName, kind, createdAt, bytes, files, restorable }
  })
  // Newest first: the stamp sorts lexicographically; fall back to the raw name.
  return entries.sort((a, b) => b.dirName.localeCompare(a.dirName))
}

// ── create + prune ────────────────────────────────────────────────────────────

/**
 * Create `backups/<stamp>-<kind>/` from the LIVE user data. MUST run when the
 * graph is unlocked (boot, before the engine opens, or against a closed store) —
 * the graph directory is OS-locked while the engine holds it. Returns the
 * created directory. THROWS (via snapshotUserData) if the snapshot fails to
 * verify — nothing else is touched.
 */
export function createBackup(userDataDir: string, kind: 'manual' | 'auto', log: BackupLogger = () => {}): string {
  const backupsDir = appDataPaths(userDataDir).backupsDir
  const dir = uniqueBackupDir(backupsDir, kind)
  snapshotUserData(userDataDir, dir, log, { kind })
  return dir
}

/**
 * Pure retention math (unit-tested). An auto-backup is KEPT when it is within
 * the newest `keepLast` OR younger than `keepDays`; it is deleted only when it
 * violates BOTH. Undefined bounds don't constrain (both undefined → delete
 * nothing). Operates ONLY on the passed auto-backups list — the caller has
 * already excluded every non-auto kind.
 */
export function selectAutoBackupsToDelete(
  autoBackups: readonly { dirName: string; createdAtMs: number | null }[],
  retention: { keepLast?: number; keepDays?: number },
  nowMs: number
): string[] {
  const { keepLast, keepDays } = retention
  if (keepLast === undefined && keepDays === undefined) return []
  // Newest first (unknown createdAt sorts oldest so it is the first pruned).
  const ordered = [...autoBackups].sort((a, b) => (b.createdAtMs ?? -1) - (a.createdAtMs ?? -1))
  const cutoffMs = keepDays !== undefined ? nowMs - keepDays * 24 * 60 * 60 * 1000 : null
  const doomed: string[] = []
  ordered.forEach((entry, index) => {
    const withinCount = keepLast !== undefined && index < keepLast
    const withinAge = cutoffMs !== null && entry.createdAtMs !== null && entry.createdAtMs >= cutoffMs
    if (!withinCount && !withinAge) doomed.push(entry.dirName)
  })
  return doomed
}

/**
 * Delete ONLY `-auto` backups that fall outside retention. Never touches
 * manual / pre-reset / pre-restore / pre-migration / corrupt-wal directories.
 * Best-effort per directory; never throws. Returns the deleted dir names.
 */
export function pruneAutoBackups(
  userDataDir: string,
  retention: { keepLast?: number; keepDays?: number },
  log: BackupLogger = () => {}
): string[] {
  const backupsDir = appDataPaths(userDataDir).backupsDir
  const autos = listBackups(userDataDir)
    .filter((b) => b.kind === 'auto')
    .map((b) => ({ dirName: b.dirName, createdAtMs: b.createdAt !== null ? Date.parse(b.createdAt) : null }))
  const doomed = selectAutoBackupsToDelete(autos, retention, Date.now())
  const deleted: string[] = []
  for (const dirName of doomed) {
    try {
      rmSync(join(backupsDir, dirName), { recursive: true, force: true })
      deleted.push(dirName)
    } catch (err) {
      log(`[storage] backups: could not prune ${dirName} (${String(err)}); left in place`)
    }
  }
  if (deleted.length > 0) log(`[storage] pruned ${deleted.length} auto-backup(s): ${deleted.join(', ')}`)
  return deleted
}

// ── markers: request (settings-ui) ─────────────────────────────────────────────

/** True when the parsed marker is a JSON object with a string `source`. */
function hasStringSource(x: unknown): x is { source: string; [k: string]: unknown } {
  return typeof x === 'object' && x !== null && typeof (x as { source?: unknown }).source === 'string'
}

/** Reject a backup dir name that could escape `backups/` (traversal guard). */
function isSafeDirName(name: string): boolean {
  return (
    typeof name === 'string' &&
    name.length > 0 &&
    !name.includes('/') &&
    !name.includes('\\') &&
    name !== '.' &&
    name !== '..' &&
    !name.includes('..')
  )
}

/** Stage a backup request (manual/auto) — performed at the next boot. */
export function requestBackup(userDataDir: string, kind: 'manual' | 'auto'): void {
  writeFileSync(
    backupMarkerPath(userDataDir),
    `${JSON.stringify({ source: 'settings-ui', kind, requestedAt: new Date().toISOString() }, null, 2)}\n`
  )
}

/** True when a backup request is already pending (avoids double-staging). */
export function backupRequestPending(userDataDir: string): boolean {
  return existsSync(backupMarkerPath(userDataDir))
}

export class RestoreRequestError extends Error {
  constructor(
    readonly code: 'NOT_FOUND' | 'INVALID_INPUT' | 'INVALID_STATE',
    message: string
  ) {
    super(message)
    this.name = 'RestoreRequestError'
  }
}

/**
 * Stage a restore request — validated NOW (the dir must be a real, restorable
 * backup) so a bad request fails in the UI instead of silently at next boot.
 */
export function requestRestore(userDataDir: string, backupDirName: string): void {
  if (!isSafeDirName(backupDirName)) {
    throw new RestoreRequestError('INVALID_INPUT', `invalid backup name '${backupDirName}'`)
  }
  const dir = join(appDataPaths(userDataDir).backupsDir, backupDirName)
  if (!existsSync(dir) || !statSync(dir).isDirectory()) {
    throw new RestoreRequestError('NOT_FOUND', `backup '${backupDirName}' does not exist`)
  }
  if (!isRestorableDir(dir)) {
    throw new RestoreRequestError('INVALID_STATE', `backup '${backupDirName}' has nothing restorable (no graph or appdata.db)`)
  }
  writeFileSync(
    restoreMarkerPath(userDataDir),
    `${JSON.stringify(
      { source: 'settings-ui', backupDirName, requestedAt: new Date().toISOString() },
      null,
      2
    )}\n`
  )
}

// ── boot: perform a pending backup (marker + auto catch-up) ────────────────────

export interface PendingBackupResult {
  /** The backup dir a pending marker produced (null when no marker). */
  readonly markerBackup: string | null
  /** The backup dir the auto catch-up produced (null when not due/disabled). */
  readonly autoBackup: string | null
  readonly pruned: readonly string[]
}

/** Newest `-auto` backup's createdAt (ms), or null when there is none. */
function newestAutoBackupMs(userDataDir: string): number | null {
  const autos = listBackups(userDataDir).filter((b) => b.kind === 'auto' && b.createdAt !== null)
  if (autos.length === 0) return null
  // listBackups is newest-first; find the newest with a parseable stamp.
  let newest = -Infinity
  for (const b of autos) {
    const ms = Date.parse(b.createdAt as string)
    if (!Number.isNaN(ms) && ms > newest) newest = ms
  }
  return newest === -Infinity ? null : newest
}

/** True when there is any user data worth backing up (graph or appdata). */
function hasBackupableData(userDataDir: string): boolean {
  const paths = appDataPaths(userDataDir)
  return graphDirHasData(paths.graphDir) || existsSync(paths.appDb)
}

/**
 * True when an auto-backup is due per `settings`: enabled, there is data to back
 * up, AND (no `-auto` backup yet OR the newest is older than the configured
 * interval). The data check keeps a fresh install (nothing on disk yet) from
 * minting an empty first-boot backup.
 */
export function autoBackupDue(userDataDir: string, settings: BackupSettings): boolean {
  if (!settings.enabled || !hasBackupableData(userDataDir)) return false
  const newest = newestAutoBackupMs(userDataDir)
  return newest === null || Date.now() - newest >= settings.intervalHours * 60 * 60 * 1000
}

/** The running-app scheduler's due check (loads settings itself). */
export function isAutoBackupDue(userDataDir: string): boolean {
  return autoBackupDue(userDataDir, loadBackupSettings(userDataDir))
}

/**
 * BOOT step (run BEFORE the engine opens, alongside performPendingReset /
 * performPendingRestore — the graph is unlocked there). Two jobs:
 *   1. Consume a `backup-requested.json` marker (manual "Backup now" or a
 *      scheduler-staged auto request) → createBackup(kind), remove the marker.
 *   2. Auto catch-up: if enabled and the newest `-auto` is older than the
 *      configured interval (or none exists), createBackup('auto').
 * Any auto backup is followed by a prune. NEVER throws — a backup only ADDS a
 * directory; a failed snapshot leaves a (partial) dir + the marker renamed
 * `.failed-*`, and the live store is never modified by this path.
 */
export function performPendingBackup(userDataDir: string, log: BackupLogger = () => {}): PendingBackupResult {
  const settings = loadBackupSettings(userDataDir, log)
  let markerBackup: string | null = null
  let autoBackup: string | null = null
  let madeAuto = false

  // 1. Marker ----------------------------------------------------------------
  const marker = backupMarkerPath(userDataDir)
  if (existsSync(marker)) {
    let parsed: unknown
    try {
      parsed = JSON.parse(readFileSync(marker, 'utf8'))
    } catch {
      parsed = undefined
    }
    const kind = hasStringSource(parsed) ? (parsed as { kind?: unknown }).kind : undefined
    if (!hasStringSource(parsed) || (kind !== 'manual' && kind !== 'auto')) {
      const invalid = `${marker}.invalid-${stampNow()}`
      try {
        renameSync(marker, invalid)
      } catch {
        /* leave it; no backup */
      }
      log(`[storage] backup marker is not a valid request (renamed to ${basename(invalid)}); no backup performed`)
    } else {
      try {
        markerBackup = createBackup(userDataDir, kind, log)
        rmSync(marker, { force: true })
        if (kind === 'auto') madeAuto = true
        log(`[storage] performed staged ${kind} backup → ${markerBackup}`)
      } catch (err) {
        const failed = `${marker}.failed-${stampNow()}`
        try {
          renameSync(marker, failed)
        } catch {
          /* keep the marker; boot continues on intact data regardless */
        }
        log(`[storage] staged backup FAILED (${String(err)}); live data untouched, marker → ${basename(failed)}`)
      }
    }
  }

  // 2. Auto catch-up ---------------------------------------------------------
  if (autoBackupDue(userDataDir, settings)) {
    try {
      autoBackup = createBackup(userDataDir, 'auto', log)
      madeAuto = true
      log(`[storage] auto-backup (boot catch-up) → ${autoBackup}`)
    } catch (err) {
      log(`[storage] auto-backup catch-up FAILED (${String(err)}); live data untouched`)
    }
  }

  // 3. Prune after any auto backup ------------------------------------------
  let pruned: readonly string[] = []
  if (madeAuto) {
    pruned = pruneAutoBackups(
      userDataDir,
      { keepLast: settings.keepLast, ...(settings.keepDays !== undefined ? { keepDays: settings.keepDays } : {}) },
      log
    )
  }
  return { markerBackup, autoBackup, pruned }
}

// ── boot: perform a pending restore ────────────────────────────────────────────

export type RestoreResult =
  | { performed: false; reason: 'no-marker' | 'invalid-marker' | 'superseded' | 'failed'; detail?: string }
  | { performed: true; restoredFrom: string; preRestoreBackup: string }

/**
 * BOOT step, run RIGHT AFTER performPendingReset (before the engine opens). The
 * fail-safe mirror of reset:
 *   1. No marker → no-op.
 *   2. Reset just ran (both markers present) → RESET WINS: the restore marker is
 *      defused (renamed `.superseded-by-reset-*`), no restore.
 *   3. Invalid marker / missing-or-non-restorable backup dir → rename
 *      `.invalid-*`, no restore, data intact.
 *   4. Snapshot the CURRENT state into `backups/<stamp>-pre-restore/` (verified);
 *      a failure here → rename `.failed-*`, data UNTOUCHED.
 *   5. Clear RESTORE_CLEAR_ENTRIES (the reset allowlist minus models/ and bin/
 *      — backups never contain them, so clearing them would only force a
 *      pointless ~570 MB re-download), copy the chosen backup's graph/,
 *      appdata.db and config files into place, write restore-record.json inside
 *      the backup dir, remove the marker LAST.
 * `backups/` is never cleared, so the source backup + the pre-restore snapshot
 * both survive.
 */
export function performPendingRestore(
  userDataDir: string,
  log: BackupLogger = () => {},
  opts: { resetJustPerformed?: boolean } = {}
): RestoreResult {
  const marker = restoreMarkerPath(userDataDir)
  if (!existsSync(marker)) return { performed: false, reason: 'no-marker' }

  // Reset wins over a co-pending restore (the data it would restore over was
  // just wiped; honoring both is incoherent — §21: prefer the safe intent).
  if (opts.resetJustPerformed === true) {
    const superseded = `${marker}.superseded-by-reset-${stampNow()}`
    try {
      renameSync(marker, superseded)
    } catch {
      /* leave it; the next boot will no-op it since reset already cleared */
    }
    log(`[storage] restore request superseded by a reset performed the same boot (marker → ${basename(superseded)})`)
    return { performed: false, reason: 'superseded' }
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(marker, 'utf8'))
  } catch {
    parsed = undefined
  }
  const backupDirName = hasStringSource(parsed) ? (parsed as { backupDirName?: unknown }).backupDirName : undefined
  const backupsDir = appDataPaths(userDataDir).backupsDir
  const invalid = (): RestoreResult => {
    const renamed = `${marker}.invalid-${stampNow()}`
    try {
      renameSync(marker, renamed)
    } catch {
      /* leave it */
    }
    log(`[storage] restore marker invalid (renamed to ${basename(renamed)}); NO restore performed, data untouched`)
    return { performed: false, reason: 'invalid-marker' }
  }
  if (typeof backupDirName !== 'string' || !isSafeDirName(backupDirName)) return invalid()
  const source = join(backupsDir, backupDirName)
  if (!existsSync(source) || !statSync(source).isDirectory() || !isRestorableDir(source)) return invalid()

  // 4. Snapshot the CURRENT state first (fail-safe boundary — like reset). Any
  // failure here throws BEFORE the clear, so the live store is untouched.
  const preRestoreDir = uniqueBackupDir(backupsDir, PRE_RESTORE_BACKUP_LABEL)
  try {
    snapshotUserData(userDataDir, preRestoreDir, log, { kind: PRE_RESTORE_BACKUP_LABEL })
  } catch (err) {
    const failed = `${marker}.failed-${stampNow()}`
    try {
      renameSync(marker, failed)
    } catch {
      /* keep the marker; boot continues on intact data regardless */
    }
    log(`[storage] restore ABORTED — pre-restore snapshot failed (${String(err)}); ALL data untouched, marker → ${basename(failed)}`)
    return { performed: false, reason: 'failed', detail: String(err) }
  }

  // 5. Clear + copy the chosen backup into place. models/ and bin/ are kept
  // (RESTORE_CLEAR_ENTRIES) — no backup carries them, so clearing them would
  // only cost a re-download; reset alone uses the full list.
  try {
    clearAllowlist(userDataDir, log, RESTORE_CLEAR_ENTRIES)

    if (graphDirHasData(join(source, 'graph'))) {
      cpSync(join(source, 'graph'), join(userDataDir, 'graph'), { recursive: true })
    }
    if (existsSync(join(source, 'appdata.db'))) {
      cpSync(join(source, 'appdata.db'), join(userDataDir, 'appdata.db'))
    }
    for (const rel of SNAPSHOT_FILES) {
      const src = join(source, rel)
      if (existsSync(src)) cpSync(src, join(userDataDir, rel))
    }

    writeFileSync(
      join(source, 'restore-record.json'),
      `${JSON.stringify(
        {
          recordVersion: 1,
          restoredAt: new Date().toISOString(),
          from: backupDirName,
          preRestoreBackup: basename(preRestoreDir)
        },
        null,
        2
      )}\n`
    )

    rmSync(marker, { force: true })
    log(`[storage] restore complete — restored from ${backupDirName}; prior state snapshotted to ${basename(preRestoreDir)}`)
    return { performed: true, restoredFrom: backupDirName, preRestoreBackup: basename(preRestoreDir) }
  } catch (err) {
    // A failure AFTER the clear leaves a partially-restored store — but the
    // pre-restore snapshot holds the exact prior state and the source backup is
    // intact, so nothing is lost, only not-yet-reassembled. Defuse the marker so
    // boot does not loop; the user can re-restore from the list.
    const failed = `${marker}.failed-${stampNow()}`
    try {
      renameSync(marker, failed)
    } catch {
      /* keep the marker */
    }
    log(
      `[storage] restore FAILED after the clear (${String(err)}) — your prior state is preserved in ${basename(
        preRestoreDir
      )} and the chosen backup is intact; retry from Settings. Marker → ${basename(failed)}`
    )
    return { performed: false, reason: 'failed', detail: String(err) }
  }
}

// ── data export (LIVE — the one path that needs no marker) ─────────────────────

/** Config files carried into a user-facing export. keychain.bin is EXCLUDED —
 * it is machine-bound safeStorage ciphertext (useless off-machine, and a secret). */
const EXPORT_FILES: readonly string[] = [
  SETTINGS_FILENAME,
  BACKUP_SETTINGS_FILENAME,
  MCP_SERVERS_CONFIG_FILENAME,
  WATCHED_FOLDERS_CONFIG_FILENAME,
  TRIGGER_STATE_FILENAME
]

export interface ExportResult {
  readonly dir: string
  readonly graphNodes: number
  readonly graphRels: number
  readonly appdata: boolean
  readonly files: readonly string[]
}

/**
 * Copy a fresh, portable export of the data into a NEW
 * `agentic-os-export-<stamp>/` folder under `destParentDir`. LIVE-safe: the
 * graph is dumped LOGICALLY through the engine (exportGraph — read-only, lane-
 * quiesced CSV + Cypher), appdata.db via VACUUM INTO, plus the non-secret config
 * files. (The graph file itself cannot be copied while the engine holds its OS
 * lock — hence the logical dump. The dialog + directory picking live in the IPC
 * layer, not here — this stays Electron-free.)
 */
export async function exportData(
  deps: { engine: StorageEngine; userDataDir: string },
  destParentDir: string,
  log: BackupLogger = () => {}
): Promise<ExportResult> {
  const paths = appDataPaths(deps.userDataDir)
  const base = join(destParentDir, `agentic-os-export-${stampNow()}`)
  let dir = base
  for (let n = 2; existsSync(dir); n++) dir = `${base}-${n}`
  mkdirSync(dir, { recursive: true })

  const graph = await exportGraph(deps.engine, join(dir, 'graph'))
  const graphNodes = Object.values(graph.nodeCounts).reduce((a, b) => a + b, 0)
  const graphRels = Object.values(graph.relCounts).reduce((a, b) => a + b, 0)

  let appdata = false
  if (existsSync(paths.appDb)) {
    snapshotAppDataDb(paths.appDb, join(dir, 'appdata.db'))
    appdata = true
  }

  const files: string[] = []
  for (const rel of EXPORT_FILES) {
    const src = join(deps.userDataDir, rel)
    if (existsSync(src)) {
      cpSync(src, join(dir, rel))
      files.push(rel)
    }
  }

  writeFileSync(
    join(dir, 'export-record.json'),
    `${JSON.stringify(
      { recordVersion: 1, kind: 'export', exportedAt: new Date().toISOString(), graphNodes, graphRels, appdata, files },
      null,
      2
    )}\n`
  )
  log(`[storage] data exported to ${dir} (${graphNodes} nodes, ${graphRels} rels, appdata ${appdata})`)
  return { dir, graphNodes, graphRels, appdata, files }
}
