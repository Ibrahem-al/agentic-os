/**
 * Installer-requested "reinstall from scratch" data reset — the APP side.
 *
 * The installer NEVER deletes user data. Its interactive "reinstall from
 * scratch" branch only RECORDS INTENT by writing a sentinel
 * (`reset-data-requested.json`) into userData. This module, called at the very
 * TOP of storage boot (before any store is opened — no file locks, same
 * reasoning as the pre-migration graph backup), turns that intent into a
 * RECOVERABLE reset:
 *
 *   1. No marker           → no-op. (The silent/auto-update invariant: without
 *                            the marker, data is never touched. electron-updater
 *                            never writes one.)
 *   2. Invalid marker      → rename to `.invalid-<stamp>`, warn, no reset.
 *                            (Unknown intent defaults to PRESERVE.)
 *   3. Snapshot            → graph/ (closed-file copy) + appdata.db (VACUUM INTO,
 *                            read-only, WAL-valid) + the config files + exports/
 *                            into `backups/<stamp>-pre-reset/`. models/ and bin/
 *                            are NOT copied (large, checksum-pinned,
 *                            re-downloadable — documented).
 *   4. Verify + record     → appdata snapshot passes PRAGMA integrity_check;
 *                            graph copy matches source file-count + byte-total;
 *                            write `reset-record.json` (inventory + checks).
 *   5. Clear               → delete only an explicit ALLOWLIST of paths. backups/
 *                            is structurally never in the list, so every
 *                            historical backup PLUS the new pre-reset snapshot
 *                            survives.
 *   6. Remove the marker LAST.
 *
 * Fail-safe: any failure in steps 3–4 throws BEFORE anything is deleted → the
 * marker is renamed to `.failed-<stamp>` and ALL user data is left untouched.
 * The clear (step 5) is best-effort per entry and never throws, so a locked
 * file just means that one asset was not reset (still present, still backed up)
 * — never a half-destroyed store with no backup. A crash between 5 and 6
 * re-runs idempotently: the marker is still there, the (now largely empty)
 * store yields an empty snapshot, the allowlist clear is a no-op, the marker is
 * removed.
 *
 * Electron-free: paths are functions of `userDataDir` (the unit-test seam).
 */
import { cpSync, type Dirent, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import {
  appDataPaths,
  MCP_SERVERS_CONFIG_FILENAME,
  PRE_RESET_BACKUP_LABEL,
  RESET_MARKER_FILENAME,
  TRIGGER_STATE_FILENAME,
  WATCHED_FOLDERS_CONFIG_FILENAME
} from '../config'
import { KEYCHAIN_FILENAME } from '../models/keychain'
import { SETTINGS_FILENAME } from '../models/settings'
import { appDataIntegrityOk, snapshotAppDataDb } from './appdata'
import { graphDirHasData } from './migrations'

/** Single-arg logger (boot passes `console.log`). */
export type ResetLogger = (message: string) => void

export type ResetResult =
  | { performed: false; reason: 'no-marker' | 'invalid-marker' | 'failed'; detail?: string }
  | { performed: true; backupDir: string }

export function resetMarkerPath(userDataDir: string): string {
  return join(userDataDir, RESET_MARKER_FILENAME)
}

/** Same lexicographically-sortable stamp the backup helpers use. */
function stampNow(): string {
  return new Date().toISOString().replaceAll(':', '-').replace(/\.\d+Z$/, 'Z')
}

/** A valid reset request is a JSON object with a string `source`. */
function isValidMarker(x: unknown): x is { source: string; [k: string]: unknown } {
  return typeof x === 'object' && x !== null && typeof (x as { source?: unknown }).source === 'string'
}

/**
 * Config files snapshotted (copied) into the pre-reset backup. The crown jewels
 * (graph/, appdata.db) are handled separately with their format-aware copies;
 * these are small flat files.
 */
const SNAPSHOT_FILES: readonly string[] = [
  KEYCHAIN_FILENAME,
  SETTINGS_FILENAME,
  MCP_SERVERS_CONFIG_FILENAME,
  WATCHED_FOLDERS_CONFIG_FILENAME,
  TRIGGER_STATE_FILENAME
]

/**
 * The explicit clear ALLOWLIST — every user-data path a reset removes, and
 * NOTHING else. `backups/`, `data-manifest.json` and the marker are
 * deliberately absent: backups (incl. the just-written pre-reset snapshot) must
 * survive, the manifest is rewritten by boot, and the marker is removed last.
 * Never `rm(userDataDir)`.
 */
const CLEAR_ENTRIES: readonly string[] = [
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
  MCP_SERVERS_CONFIG_FILENAME,
  WATCHED_FOLDERS_CONFIG_FILENAME,
  TRIGGER_STATE_FILENAME,
  '.mcp.json'
]

/** Recursive {files, bytes} of a directory tree (for the graph copy check). */
function countTree(dir: string): { files: number; bytes: number } {
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

/** Best-effort recursive delete of each allowlist entry; never throws. */
function clearAllowlist(userDataDir: string, log: ResetLogger): void {
  for (const rel of CLEAR_ENTRIES) {
    try {
      rmSync(join(userDataDir, rel), { recursive: true, force: true })
    } catch (err) {
      // A locked file just means that one asset was not reset — it is still
      // present AND fully backed up. Log and keep going.
      log(`[storage] reset: could not clear ${rel} (${String(err)}); left in place (still backed up)`)
    }
  }
}

/**
 * Perform an installer-requested reset if (and only if) the marker is present
 * and valid. Internally fail-safe; every failure path leaves user data intact.
 */
export function performPendingReset(userDataDir: string, log: ResetLogger = () => {}): ResetResult {
  const marker = resetMarkerPath(userDataDir)
  if (!existsSync(marker)) return { performed: false, reason: 'no-marker' }

  // Parse + validate the marker. Unknown/garbage intent → preserve.
  let markerContent: unknown
  try {
    markerContent = JSON.parse(readFileSync(marker, 'utf8'))
  } catch {
    markerContent = undefined
  }
  if (!isValidMarker(markerContent)) {
    const invalid = `${marker}.invalid-${stampNow()}`
    try {
      renameSync(marker, invalid)
    } catch {
      /* leave the marker; still no reset */
    }
    log(`[storage] reset marker is not a valid request (renamed to ${basename(invalid)}); NO reset performed, data untouched`)
    return { performed: false, reason: 'invalid-marker' }
  }

  const paths = appDataPaths(userDataDir)
  const base = join(paths.backupsDir, `${stampNow()}-${PRE_RESET_BACKUP_LABEL}`)
  let backupDir = base
  for (let n = 2; existsSync(backupDir); n++) backupDir = `${base}-${n}`

  try {
    mkdirSync(backupDir, { recursive: true })

    // 3. Snapshot ----------------------------------------------------------
    let graphSnapshot: { files: number; bytes: number } | null = null
    if (graphDirHasData(paths.graphDir)) {
      cpSync(paths.graphDir, join(backupDir, 'graph'), { recursive: true })
      graphSnapshot = countTree(join(backupDir, 'graph'))
    }

    let appdataSnapshot = false
    if (existsSync(paths.appDb)) {
      snapshotAppDataDb(paths.appDb, join(backupDir, 'appdata.db'))
      appdataSnapshot = true
    }

    const copiedFiles: string[] = []
    for (const rel of SNAPSHOT_FILES) {
      const src = join(userDataDir, rel)
      if (existsSync(src)) {
        cpSync(src, join(backupDir, rel))
        copiedFiles.push(rel)
      }
    }
    if (existsSync(paths.exportsDir)) {
      cpSync(paths.exportsDir, join(backupDir, 'exports'), { recursive: true })
      copiedFiles.push('exports')
    }

    // 4. Verify the SNAPSHOT before anything is cleared --------------------
    if (appdataSnapshot && !appDataIntegrityOk(join(backupDir, 'appdata.db'))) {
      throw new Error('appdata.db snapshot failed PRAGMA integrity_check')
    }
    if (graphSnapshot !== null) {
      const source = countTree(paths.graphDir)
      if (source.files !== graphSnapshot.files || source.bytes !== graphSnapshot.bytes) {
        throw new Error(
          `graph snapshot mismatch — source ${source.files} files / ${source.bytes} bytes, copy ${graphSnapshot.files} files / ${graphSnapshot.bytes} bytes`
        )
      }
    }

    // …then record the inventory + check results.
    const record = {
      recordVersion: 1,
      performedAt: new Date().toISOString(),
      backupDir,
      marker: markerContent,
      snapshot: {
        graph: graphSnapshot,
        appdata: appdataSnapshot,
        files: copiedFiles
      },
      checks: {
        appdataIntegrity: appdataSnapshot ? 'ok' : 'skipped',
        graphCountMatch: graphSnapshot !== null ? true : 'skipped'
      }
    }
    writeFileSync(join(backupDir, 'reset-record.json'), `${JSON.stringify(record, null, 2)}\n`)

    // 5. Clear (best-effort allowlist; backups/ never in it) --------------
    clearAllowlist(userDataDir, log)

    // 6. Remove the marker LAST.
    rmSync(marker, { force: true })

    log(`[storage] installer-requested reset complete — data backed up to ${backupDir}, store cleared`)
    return { performed: true, backupDir }
  } catch (err) {
    // Steps 3–4 fail BEFORE any deletion → all user data is intact. Defuse
    // the marker so boot does not retry destructively every launch; the
    // renamed marker + the (possibly partial) backup are left for inspection.
    const failed = `${marker}.failed-${stampNow()}`
    try {
      renameSync(marker, failed)
    } catch {
      /* keep the marker; boot continues on intact data regardless */
    }
    log(`[storage] installer-requested reset FAILED (${String(err)}); ALL user data left untouched, marker → ${basename(failed)}`)
    return { performed: false, reason: 'failed', detail: String(err) }
  }
}
