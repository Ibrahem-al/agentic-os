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
 *   3+4. Snapshot + verify  → the shared `snapshotUserData` (storage/backups.ts):
 *                            graph/ (closed-file copy) + appdata.db (VACUUM INTO,
 *                            integrity-checked) + config files + exports/ into
 *                            `backups/<stamp>-pre-reset/`, graph copy verified by
 *                            file-count + byte-total. models/ and bin/ are NOT
 *                            copied (large, checksum-pinned, re-downloadable).
 *   5. Clear               → delete only the shared clear ALLOWLIST. backups/ is
 *                            structurally never in the list, so every historical
 *                            backup PLUS the new pre-reset snapshot survives.
 *   6. Remove the marker LAST.
 *
 * Fail-safe: any failure in steps 3–4 throws BEFORE anything is deleted → the
 * marker is renamed to `.failed-<stamp>` and ALL user data is left untouched.
 * The clear (step 5) is best-effort per entry and never throws. A crash between
 * 5 and 6 re-runs idempotently.
 *
 * The snapshot/verify + clear machinery is shared verbatim with the manual/auto
 * backup and restore paths (storage/backups.ts) — reset is just the caller that
 * also stamps a marker record and clears afterwards.
 *
 * Electron-free: paths are functions of `userDataDir` (the unit-test seam).
 */
import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { appDataPaths, PRE_RESET_BACKUP_LABEL, RESET_MARKER_FILENAME } from '../config'
import { clearAllowlist, snapshotUserData, stampNow } from './backups'

/** Single-arg logger (boot passes `console.log`). */
export type ResetLogger = (message: string) => void

export type ResetResult =
  | { performed: false; reason: 'no-marker' | 'invalid-marker' | 'failed'; detail?: string }
  | { performed: true; backupDir: string }

export function resetMarkerPath(userDataDir: string): string {
  return join(userDataDir, RESET_MARKER_FILENAME)
}

/** A valid reset request is a JSON object with a string `source`. */
function isValidMarker(x: unknown): x is { source: string; [k: string]: unknown } {
  return typeof x === 'object' && x !== null && typeof (x as { source?: unknown }).source === 'string'
}

/**
 * Stage a reset request from the Settings UI. Writes the SAME marker the
 * installer's "reinstall from scratch" branch writes, so the proven, recoverable
 * performPendingReset path runs at the next boot (the app relaunches after).
 * performPendingReset only requires a string `source`.
 */
export function requestReset(userDataDir: string): void {
  writeFileSync(
    resetMarkerPath(userDataDir),
    `${JSON.stringify({ source: 'settings-ui', requestedAt: new Date().toISOString() }, null, 2)}\n`
  )
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
    // 3+4. Snapshot + verify (shared with the backup/restore paths). Throws
    // BEFORE anything is cleared on a verify failure → all user data intact.
    const snap = snapshotUserData(userDataDir, backupDir, log, { kind: PRE_RESET_BACKUP_LABEL })

    // Reset-specific record: the shared snapshot inventory + the marker intent.
    const record = {
      recordVersion: 1,
      performedAt: new Date().toISOString(),
      backupDir,
      marker: markerContent,
      snapshot: { graph: snap.graph, appdata: snap.appdata, files: snap.files },
      checks: snap.checks
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
