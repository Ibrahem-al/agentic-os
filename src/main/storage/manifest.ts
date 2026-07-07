/**
 * data-manifest.json — the machine-readable "note" (§3 "Updates & migration").
 *
 * A top-level `userData/data-manifest.json`, (re)written atomically on every
 * successful storage boot, records: the app + schema versions the store was
 * last opened with, a cheap inventory of every data asset (path, size, file
 * count, mtime, criticality), and pointers to the latest backup. Its job is
 * "is the data present, plausibly intact, and which schema versions does it
 * carry" — the STRONG integrity checks (VACUUM-INTO validity, PRAGMA
 * integrity_check, sqlite user_version, the graph sidecar) live in the
 * reset/migration paths, not here (hashing a multi-GB graph every boot is not
 * acceptable; size + mtime + file-count is the deliberately cheap signal).
 *
 * Electron-free: every path is a function of `userDataDir`, the same seam the
 * app-side reset/backups use and unit tests drive with a temp dir. This module
 * only READS the store and writes a DERIVED file atomically (tmp + rename); it
 * never mutates user data and never throws boot down (callers wrap it).
 */
import { type Dirent, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import {
  appDataPaths,
  DATA_MANIFEST_FILENAME,
  MCP_SERVERS_CONFIG_FILENAME,
  PRODUCT_NAME,
  TRIGGER_STATE_FILENAME,
  WATCHED_FOLDERS_CONFIG_FILENAME
} from '../config'
import { KEYCHAIN_FILENAME } from '../models/keychain'
import { SETTINGS_FILENAME } from '../models/settings'

/** One recorded data asset under userData. */
export interface ManifestAsset {
  /** Path relative to userDataDir (posix-style; also the on-disk basename). */
  readonly path: string
  readonly kind: 'dir' | 'file'
  readonly exists: boolean
  /** Total bytes (recursive for dirs). */
  readonly bytes: number
  /** File count (dirs only). */
  readonly files?: number
  /** Newest file mtime seen (ms since epoch); 0 when absent/empty. */
  readonly mtimeMs: number
  /** A missing/emptied critical asset is a WARN on the next boot's verify. */
  readonly critical: boolean
  /** Large + checksum-pinned + re-fetchable — not backed up on reset. */
  readonly redownloadable?: boolean
}

export interface DataManifest {
  readonly manifestVersion: 1
  readonly product: string
  readonly appVersion: string
  readonly writtenAt: string
  readonly schema: {
    readonly appdataUserVersion: number
    readonly graphSchemaVersion: number
  }
  readonly assets: readonly ManifestAsset[]
  readonly backups: {
    /** Newest backup dir, relative to userData (e.g. `backups/<stamp>-…`); null when none. */
    readonly latest: string | null
    readonly count: number
  }
  readonly events: {
    readonly lastBootAt: string
    readonly lastBackupAt: string | null
    readonly lastResetAt: string | null
    readonly lastResetBackupDir: string | null
  }
}

/** Inputs the boot supplies that the manifest cannot derive from disk alone. */
export interface WriteManifestInfo {
  readonly appVersion: string
  readonly appdataUserVersion: number
  readonly graphSchemaVersion: number
  readonly lastBackupAt?: string | null
  readonly lastResetAt?: string | null
  readonly lastResetBackupDir?: string | null
}

/** A critical asset the previous manifest recorded present but is now gone/empty. */
export interface ManifestFinding {
  readonly path: string
  readonly kind: 'dir' | 'file'
  readonly detail: string
}

interface AssetSpec {
  readonly path: string
  readonly kind: 'dir' | 'file'
  readonly critical: boolean
  readonly redownloadable?: boolean
}

/**
 * The canonical data-asset inventory (single source of truth for both the
 * manifest and the reset snapshot's "what config files to copy"). graph/,
 * appdata.db and keychain.bin are the irreplaceable crown jewels (critical);
 * models/ is critical:false + redownloadable (checksum-pinned ONNX weights).
 */
const ASSET_SPECS: readonly AssetSpec[] = [
  { path: 'graph', kind: 'dir', critical: true },
  { path: 'appdata.db', kind: 'file', critical: true },
  { path: KEYCHAIN_FILENAME, kind: 'file', critical: true },
  { path: SETTINGS_FILENAME, kind: 'file', critical: false },
  { path: MCP_SERVERS_CONFIG_FILENAME, kind: 'file', critical: false },
  { path: WATCHED_FOLDERS_CONFIG_FILENAME, kind: 'file', critical: false },
  { path: TRIGGER_STATE_FILENAME, kind: 'file', critical: false },
  { path: 'exports', kind: 'dir', critical: false },
  { path: 'models', kind: 'dir', critical: false, redownloadable: true }
]

export function dataManifestPath(userDataDir: string): string {
  return join(userDataDir, DATA_MANIFEST_FILENAME)
}

/** Recursive {bytes, files, newest-mtime} for a directory; zeros if unreadable. */
function dirStats(dir: string): { bytes: number; files: number; mtimeMs: number } {
  let bytes = 0
  let files = 0
  let mtimeMs = 0
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
          const st = statSync(p)
          bytes += st.size
          files += 1
          if (st.mtimeMs > mtimeMs) mtimeMs = st.mtimeMs
        } catch {
          /* raced deletion — ignore */
        }
      }
    }
  }
  return { bytes, files, mtimeMs }
}

/** Stat every asset in ASSET_SPECS against disk (cheap: size + mtime + count). */
export function collectAssets(userDataDir: string): ManifestAsset[] {
  return ASSET_SPECS.map((spec) => {
    const abs = join(userDataDir, spec.path)
    const redownloadable = spec.redownloadable === true ? { redownloadable: true } : {}
    try {
      const st = statSync(abs)
      if (spec.kind === 'dir') {
        if (!st.isDirectory()) return { path: spec.path, kind: 'dir', exists: false, bytes: 0, files: 0, mtimeMs: 0, critical: spec.critical, ...redownloadable }
        const agg = dirStats(abs)
        return { path: spec.path, kind: 'dir', exists: true, bytes: agg.bytes, files: agg.files, mtimeMs: agg.mtimeMs, critical: spec.critical, ...redownloadable }
      }
      if (!st.isFile()) return { path: spec.path, kind: 'file', exists: false, bytes: 0, mtimeMs: 0, critical: spec.critical, ...redownloadable }
      return { path: spec.path, kind: 'file', exists: true, bytes: st.size, mtimeMs: st.mtimeMs, critical: spec.critical, ...redownloadable }
    } catch {
      return spec.kind === 'dir'
        ? { path: spec.path, kind: 'dir', exists: false, bytes: 0, files: 0, mtimeMs: 0, critical: spec.critical, ...redownloadable }
        : { path: spec.path, kind: 'file', exists: false, bytes: 0, mtimeMs: 0, critical: spec.critical, ...redownloadable }
    }
  })
}

/** Newest backup dir (relative to userData) + count; stamps sort lexicographically. */
function latestBackup(userDataDir: string): { latest: string | null; count: number } {
  const backupsDir = appDataPaths(userDataDir).backupsDir
  let names: string[]
  try {
    names = readdirSync(backupsDir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
  } catch {
    return { latest: null, count: 0 }
  }
  if (names.length === 0) return { latest: null, count: 0 }
  names.sort()
  const newest = names[names.length - 1] as string
  return { latest: `backups/${newest}`, count: names.length }
}

/** Read the current manifest, or null when absent/unparseable (never throws). */
export function readDataManifest(userDataDir: string): DataManifest | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(dataManifestPath(userDataDir), 'utf8'))
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      (parsed as { manifestVersion?: unknown }).manifestVersion === 1 &&
      Array.isArray((parsed as { assets?: unknown }).assets)
    ) {
      return parsed as DataManifest
    }
    return null
  } catch {
    return null
  }
}

/**
 * Compare the PREVIOUS manifest's critical assets against disk. Returns a
 * finding for each critical asset that the manifest recorded present + non-empty
 * but is now missing or emptied — the "did an update/reinstall lose the crown
 * jewels?" signal. Pure read; returns [] when there is no prior manifest.
 * The caller logs the findings; this never blocks and never mutates.
 */
export function verifyDataManifest(userDataDir: string): ManifestFinding[] {
  const prev = readDataManifest(userDataDir)
  if (prev === null) return []
  const current = new Map(collectAssets(userDataDir).map((a) => [a.path, a]))
  const findings: ManifestFinding[] = []
  for (const rec of prev.assets) {
    if (!rec.critical) continue
    if (!rec.exists || rec.bytes <= 0) continue // wasn't there before → nothing lost
    const now = current.get(rec.path)
    if (now === undefined || !now.exists) {
      findings.push({ path: rec.path, kind: rec.kind, detail: `critical asset recorded at ${rec.bytes} bytes on ${prev.writtenAt} is now MISSING` })
    } else if (now.bytes <= 0) {
      findings.push({ path: rec.path, kind: rec.kind, detail: `critical asset recorded at ${rec.bytes} bytes on ${prev.writtenAt} is now EMPTY` })
    }
  }
  return findings
}

/**
 * Build and atomically write (tmp + rename) the manifest, filling backups +
 * writtenAt/lastBootAt from live state. Returns what was written.
 */
export function writeDataManifest(userDataDir: string, info: WriteManifestInfo): DataManifest {
  const now = new Date().toISOString()
  const { latest, count } = latestBackup(userDataDir)
  const manifest: DataManifest = {
    manifestVersion: 1,
    product: PRODUCT_NAME,
    appVersion: info.appVersion,
    writtenAt: now,
    schema: {
      appdataUserVersion: info.appdataUserVersion,
      graphSchemaVersion: info.graphSchemaVersion
    },
    assets: collectAssets(userDataDir),
    backups: { latest, count },
    events: {
      lastBootAt: now,
      lastBackupAt: info.lastBackupAt ?? null,
      lastResetAt: info.lastResetAt ?? null,
      lastResetBackupDir: info.lastResetBackupDir ?? null
    }
  }
  const dest = dataManifestPath(userDataDir)
  mkdirSync(dirname(dest), { recursive: true })
  const tmp = `${dest}.tmp-${process.pid}-${Date.now()}`
  writeFileSync(tmp, `${JSON.stringify(manifest, null, 2)}\n`)
  renameSync(tmp, dest)
  return manifest
}
