import { afterEach, describe, expect, it } from 'vitest'
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { appDataIntegrityOk, openAppData, snapshotAppDataDb } from '../../src/main/storage/appdata'
import { performPendingReset, resetMarkerPath } from '../../src/main/storage/reset'

const VALID_MARKER = JSON.stringify({ source: 'installer', installerVersion: '0.1.0' })
const PRE_EXISTING_BACKUP = '2026-01-01T00-00-00Z-pre-migration-v1'

/** SQLite user_version lives big-endian at byte offset 60 — read off disk. */
function userVersionOnDisk(dbFile: string): number {
  return readFileSync(dbFile).readUInt32BE(60)
}

/** Seed a temp userData with a real appdata.db + graph tree + config files. */
function seed(dir: string, opts: { realAppData?: boolean } = {}): { graphFiles: number } {
  // graph/ tree (several files incl. the sidecar)
  mkdirSync(join(dir, 'graph'), { recursive: true })
  writeFileSync(join(dir, 'graph', 'graph.ryugraph'), 'g'.repeat(3000))
  writeFileSync(join(dir, 'graph', 'graph.ryugraph.wal'), 'w'.repeat(500))
  writeFileSync(join(dir, 'graph', 'schema-version.json'), JSON.stringify({ version: 1 }))
  const graphFiles = 3

  if (opts.realAppData !== false) {
    const app = openAppData(join(dir, 'appdata.db'))
    app.db.prepare('INSERT INTO tasks (id, kind) VALUES (?, ?)').run('keep-me', 'probe')
    app.close()
  }

  writeFileSync(join(dir, 'keychain.bin'), Buffer.from('secret-ciphertext'))
  writeFileSync(join(dir, 'settings.json'), '{"cloudProvider":"anthropic"}')
  writeFileSync(join(dir, 'trigger-state.json'), '{}')
  mkdirSync(join(dir, 'models'), { recursive: true })
  writeFileSync(join(dir, 'models', 'reranker.onnx'), 'm'.repeat(5000))

  // A pre-existing backup that MUST survive a reset.
  mkdirSync(join(dir, 'backups', PRE_EXISTING_BACKUP), { recursive: true })
  writeFileSync(join(dir, 'backups', PRE_EXISTING_BACKUP, 'graph.ryugraph'), 'old')
  return { graphFiles }
}

const backupDirs = (dir: string): string[] =>
  existsSync(join(dir, 'backups')) ? readdirSync(join(dir, 'backups')).sort() : []
const preResetDir = (dir: string): string | undefined => backupDirs(dir).find((n) => n.endsWith('-pre-reset'))

describe('performPendingReset (installer-requested, recoverable, backup-first)', () => {
  let dir: string
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('(a) NO marker → no-op; nothing is touched (silent/auto-update invariant)', () => {
    dir = mkdtempSync(join(tmpdir(), 'reset-a-'))
    seed(dir)
    const before = {
      graph: readFileSync(join(dir, 'graph', 'graph.ryugraph')),
      keychain: readFileSync(join(dir, 'keychain.bin')),
      appdata: existsSync(join(dir, 'appdata.db'))
    }

    const result = performPendingReset(dir)

    expect(result).toEqual({ performed: false, reason: 'no-marker' })
    expect(readFileSync(join(dir, 'graph', 'graph.ryugraph'))).toEqual(before.graph)
    expect(readFileSync(join(dir, 'keychain.bin'))).toEqual(before.keychain)
    expect(existsSync(join(dir, 'appdata.db'))).toBe(before.appdata)
    // No pre-reset backup was created; the pre-existing one is the only dir.
    expect(backupDirs(dir)).toEqual([PRE_EXISTING_BACKUP])
  })

  it('(b) valid marker → backup-first snapshot, verified, recorded, then cleared', () => {
    dir = mkdtempSync(join(tmpdir(), 'reset-b-'))
    const { graphFiles } = seed(dir)
    writeFileSync(resetMarkerPath(dir), VALID_MARKER)

    const result = performPendingReset(dir)
    expect(result.performed).toBe(true)
    if (!result.performed) throw new Error('unreachable')

    // The pre-reset backup dir exists (alongside the surviving pre-existing one).
    const stampDir = preResetDir(dir)
    expect(stampDir).toBeDefined()
    expect(backupDirs(dir)).toContain(PRE_EXISTING_BACKUP)
    expect(readFileSync(join(dir, 'backups', PRE_EXISTING_BACKUP, 'graph.ryugraph'), 'utf8')).toBe('old')
    const backup = result.backupDir

    // graph copied with matching file-count.
    expect(existsSync(join(backup, 'graph'))).toBe(true)
    expect(readdirSync(join(backup, 'graph')).length).toBe(graphFiles)

    // appdata snapshot: valid, integrity ok, user_version preserved (== 11).
    const snap = join(backup, 'appdata.db')
    expect(existsSync(snap)).toBe(true)
    expect(appDataIntegrityOk(snap)).toBe(true)
    expect(userVersionOnDisk(snap)).toBe(11)
    // The snapshot really carries the row we seeded (open a scratch copy so the
    // backup file itself is never mutated).
    const scratch = join(dir, 'restore-check', 'appdata.db')
    mkdirSync(join(dir, 'restore-check'), { recursive: true })
    copyFileSync(snap, scratch)
    const reopened = openAppData(scratch)
    try {
      expect(
        (reopened.db.prepare("SELECT kind FROM tasks WHERE id = 'keep-me'").get() as { kind: string }).kind
      ).toBe('probe')
    } finally {
      reopened.close()
    }

    // config files snapshotted.
    expect(existsSync(join(backup, 'keychain.bin'))).toBe(true)
    expect(existsSync(join(backup, 'settings.json'))).toBe(true)

    // reset-record.json inventory + check results.
    const record = JSON.parse(readFileSync(join(backup, 'reset-record.json'), 'utf8'))
    expect(record.recordVersion).toBe(1)
    expect(record.marker.source).toBe('installer')
    expect(record.checks.appdataIntegrity).toBe('ok')
    expect(record.checks.graphCountMatch).toBe(true)
    expect(record.snapshot.files).toEqual(expect.arrayContaining(['keychain.bin', 'settings.json']))

    // Live store CLEARED (allowlist), backups/ untouched, marker gone.
    expect(existsSync(join(dir, 'graph'))).toBe(false)
    expect(existsSync(join(dir, 'appdata.db'))).toBe(false)
    expect(existsSync(join(dir, 'models'))).toBe(false)
    expect(existsSync(join(dir, 'keychain.bin'))).toBe(false)
    expect(existsSync(join(dir, 'settings.json'))).toBe(false)
    expect(existsSync(resetMarkerPath(dir))).toBe(false)
    // backups/ is structurally never cleared.
    expect(existsSync(join(dir, 'backups'))).toBe(true)
  })

  it('(c) malformed marker → renamed .invalid-*, no reset, all data intact', () => {
    dir = mkdtempSync(join(tmpdir(), 'reset-c-'))
    seed(dir)
    writeFileSync(resetMarkerPath(dir), '{ this is : not valid json')

    const result = performPendingReset(dir)
    expect(result).toMatchObject({ performed: false, reason: 'invalid-marker' })

    expect(existsSync(resetMarkerPath(dir))).toBe(false)
    const invalid = readdirSync(dir).filter((n) => n.startsWith('reset-data-requested.json.invalid-'))
    expect(invalid).toHaveLength(1)
    // Data untouched, no backup made.
    expect(existsSync(join(dir, 'graph'))).toBe(true)
    expect(existsSync(join(dir, 'appdata.db'))).toBe(true)
    expect(backupDirs(dir)).toEqual([PRE_EXISTING_BACKUP])
  })

  it('(c2) valid JSON but no string source → treated as invalid, data intact', () => {
    dir = mkdtempSync(join(tmpdir(), 'reset-c2-'))
    seed(dir)
    writeFileSync(resetMarkerPath(dir), JSON.stringify({ notSource: true }))
    const result = performPendingReset(dir)
    expect(result).toMatchObject({ performed: false, reason: 'invalid-marker' })
    expect(existsSync(join(dir, 'graph'))).toBe(true)
    expect(existsSync(join(dir, 'appdata.db'))).toBe(true)
  })

  it('(d) snapshot failure (corrupt appdata.db) → marker .failed-*, all data intact', () => {
    dir = mkdtempSync(join(tmpdir(), 'reset-d-'))
    seed(dir, { realAppData: false })
    // A corrupt (non-SQLite) appdata.db makes the VACUUM INTO snapshot throw
    // BEFORE any clear runs — the reset must abort with everything intact.
    writeFileSync(join(dir, 'appdata.db'), Buffer.from('NOT A SQLITE DATABASE AT ALL'))
    writeFileSync(resetMarkerPath(dir), VALID_MARKER)

    const result = performPendingReset(dir)
    expect(result).toMatchObject({ performed: false, reason: 'failed' })

    // Marker defused, data untouched (graph + the corrupt appdata still present).
    expect(existsSync(resetMarkerPath(dir))).toBe(false)
    expect(readdirSync(dir).filter((n) => n.startsWith('reset-data-requested.json.failed-'))).toHaveLength(1)
    expect(existsSync(join(dir, 'graph'))).toBe(true)
    expect(existsSync(join(dir, 'appdata.db'))).toBe(true)
    expect(existsSync(join(dir, 'keychain.bin'))).toBe(true)
    expect(existsSync(join(dir, 'models'))).toBe(true)
  })

  it('(e) crash-window idempotency: marker present but store already cleared → completes, no throw', () => {
    dir = mkdtempSync(join(tmpdir(), 'reset-e-'))
    // Simulate a crash between clear and marker-delete: graph/appdata already gone.
    mkdirSync(join(dir, 'backups', PRE_EXISTING_BACKUP), { recursive: true })
    writeFileSync(join(dir, 'backups', PRE_EXISTING_BACKUP, 'x'), '1')
    writeFileSync(resetMarkerPath(dir), VALID_MARKER)

    let result: ReturnType<typeof performPendingReset> | undefined
    expect(() => {
      result = performPendingReset(dir)
    }).not.toThrow()
    expect(result?.performed).toBe(true)
    // Marker removed; pre-existing backup survives; a (near-empty) pre-reset dir written.
    expect(existsSync(resetMarkerPath(dir))).toBe(false)
    expect(backupDirs(dir)).toContain(PRE_EXISTING_BACKUP)
    expect(preResetDir(dir)).toBeDefined()
  })

  it('(f) snapshotAppDataDb preserves a NEWER user_version and never touches the source (downgrade guard intact)', () => {
    dir = mkdtempSync(join(tmpdir(), 'reset-f-'))
    const dbPath = join(dir, 'appdata.db')
    const app = openAppData(dbPath)
    app.db.pragma('user_version = 99') // newer than this build understands
    app.close()

    const snap = join(dir, 'snap', 'appdata.db')
    snapshotAppDataDb(dbPath, snap)

    // Snapshot is a valid db frozen at the newer version…
    expect(existsSync(snap)).toBe(true)
    expect(appDataIntegrityOk(snap)).toBe(true)
    expect(userVersionOnDisk(snap)).toBe(99)
    // …the SOURCE is untouched (still 99)…
    expect(userVersionOnDisk(dbPath)).toBe(99)
    // …and openAppData still REFUSES the newer source (guard unweakened).
    expect(() => openAppData(dbPath)).toThrow(/newer than this build/)
  })
})
