import { afterEach, describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openAppData } from '../../src/main/storage/appdata'
import {
  backupMarkerPath,
  defaultBackupSettings,
  listBackups,
  loadBackupSettings,
  normalizeBackupSettings,
  performPendingBackup,
  performPendingRestore,
  pruneAutoBackups,
  requestBackup,
  requestRestore,
  RestoreRequestError,
  restoreMarkerPath,
  saveBackupSettings,
  selectAutoBackupsToDelete
} from '../../src/main/storage/backups'

/** Seed a temp userData with a real appdata.db + graph tree + config files. */
function seed(dir: string, opts: { appdataRow?: string; realAppData?: boolean } = {}): void {
  mkdirSync(join(dir, 'graph'), { recursive: true })
  writeFileSync(join(dir, 'graph', 'graph.ryugraph'), 'g'.repeat(2000))
  writeFileSync(join(dir, 'graph', 'schema-version.json'), JSON.stringify({ version: 1 }))
  if (opts.realAppData !== false) {
    const app = openAppData(join(dir, 'appdata.db'))
    app.db.prepare('INSERT INTO tasks (id, kind) VALUES (?, ?)').run(opts.appdataRow ?? 'row-A', 'probe')
    app.close()
  }
  writeFileSync(join(dir, 'keychain.bin'), Buffer.from('secret'))
  writeFileSync(join(dir, 'settings.json'), '{"cloudProvider":"anthropic"}')
}

/** A backup directory with graph/ + appdata.db so it is restorable. */
function fakeBackupDir(dir: string, name: string, opts: { graph?: boolean; appdata?: boolean; file?: boolean } = {}): string {
  const b = join(dir, 'backups', name)
  mkdirSync(b, { recursive: true })
  if (opts.graph !== false) {
    mkdirSync(join(b, 'graph'), { recursive: true })
    writeFileSync(join(b, 'graph', 'graph.ryugraph'), 'x')
  }
  if (opts.appdata) writeFileSync(join(b, 'appdata.db'), 'db')
  if (opts.file !== false) writeFileSync(join(b, 'backup-record.json'), '{}')
  return b
}

const backupNames = (dir: string): string[] =>
  existsSync(join(dir, 'backups')) ? readdirSync(join(dir, 'backups')).sort() : []

describe('backup settings', () => {
  let dir: string
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('defaults: enabled, daily, keep 10; a missing file yields defaults', () => {
    dir = mkdtempSync(join(tmpdir(), 'bk-set-'))
    expect(loadBackupSettings(dir)).toEqual({ enabled: true, intervalHours: 24, keepLast: 10 })
    expect(defaultBackupSettings()).toEqual({ enabled: true, intervalHours: 24, keepLast: 10 })
  })

  it('normalize clamps invalid values and drops keepDays < 1', () => {
    expect(normalizeBackupSettings({ enabled: false, intervalHours: 999, keepLast: 0, keepDays: 0 })).toEqual({
      enabled: false,
      intervalHours: 24, // 999 not a choice → default
      keepLast: 10 // < 1 → default
      // keepDays 0 dropped
    })
    expect(normalizeBackupSettings({ intervalHours: 168, keepLast: 3, keepDays: 30 })).toEqual({
      enabled: true,
      intervalHours: 168,
      keepLast: 3,
      keepDays: 30
    })
  })

  it('save round-trips through disk (atomic tmp+rename)', () => {
    dir = mkdtempSync(join(tmpdir(), 'bk-set2-'))
    const saved = saveBackupSettings(dir, { enabled: false, intervalHours: 6, keepLast: 5, keepDays: 14 })
    expect(saved).toEqual({ enabled: false, intervalHours: 6, keepLast: 5, keepDays: 14 })
    expect(loadBackupSettings(dir)).toEqual(saved)
  })
})

describe('selectAutoBackupsToDelete (pure retention math)', () => {
  const autos = (ages: number[]): { dirName: string; createdAtMs: number | null }[] =>
    ages.map((h, i) => ({ dirName: `b${i}`, createdAtMs: Date.now() - h * 3600_000 }))

  it('keepLast: keeps the newest N, deletes the rest', () => {
    const list = autos([1, 2, 3, 4, 5]) // newest first already
    const doomed = selectAutoBackupsToDelete(list, { keepLast: 2 }, Date.now())
    expect(doomed.sort()).toEqual(['b2', 'b3', 'b4'])
  })

  it('keepDays: keeps younger than the cutoff, deletes older', () => {
    const list = autos([1, 10, 50, 100]) // hours old
    const doomed = selectAutoBackupsToDelete(list, { keepDays: 1 }, Date.now()) // 24h cutoff
    expect(doomed.sort()).toEqual(['b2', 'b3'])
  })

  it('keepLast OR keepDays: a backup survives if EITHER keeps it', () => {
    const list = autos([1, 2, 100, 200]) // b2/b3 are old
    // keepLast 1 keeps b0; keepDays 1 keeps b0+b1 (both < 24h). Union keeps b0,b1.
    const doomed = selectAutoBackupsToDelete(list, { keepLast: 1, keepDays: 1 }, Date.now())
    expect(doomed.sort()).toEqual(['b2', 'b3'])
  })

  it('no bounds → delete nothing', () => {
    expect(selectAutoBackupsToDelete(autos([1, 2, 3]), {}, Date.now())).toEqual([])
  })

  it('null createdAt sorts oldest and is pruned first beyond keepLast', () => {
    const list = [
      { dirName: 'newest', createdAtMs: Date.now() },
      { dirName: 'nostamp', createdAtMs: null }
    ]
    expect(selectAutoBackupsToDelete(list, { keepLast: 1 }, Date.now())).toEqual(['nostamp'])
  })
})

describe('listBackups (kind parsing + restorable)', () => {
  let dir: string
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('classifies every label and flags restorable correctly, newest first', () => {
    dir = mkdtempSync(join(tmpdir(), 'bk-list-'))
    fakeBackupDir(dir, '2026-01-01T00-00-00Z-manual', { graph: true })
    fakeBackupDir(dir, '2026-02-01T00-00-00Z-auto', { graph: true })
    fakeBackupDir(dir, '2026-03-01T00-00-00Z-pre-reset', { graph: true })
    fakeBackupDir(dir, '2026-04-01T00-00-00Z-pre-restore', { graph: false, appdata: true })
    fakeBackupDir(dir, '2026-05-01T00-00-00Z-pre-migration-v1', { graph: true })
    fakeBackupDir(dir, '2026-06-01T00-00-00Z-pre-appdata-v7', { graph: false, appdata: true })
    // corrupt-wal: only WAL fragments, no graph/ dir, no appdata.db → NOT restorable.
    const wal = join(dir, 'backups', '2026-07-01T00-00-00Z-corrupt-wal')
    mkdirSync(wal, { recursive: true })
    writeFileSync(join(wal, 'graph.ryugraph.wal'), 'w')
    fakeBackupDir(dir, '2026-08-01T00-00-00Z-somethingelse', { graph: false, appdata: false, file: true })

    const list = listBackups(dir)
    const byName = new Map(list.map((b) => [b.dirName, b]))
    expect(byName.get('2026-01-01T00-00-00Z-manual')?.kind).toBe('manual')
    expect(byName.get('2026-02-01T00-00-00Z-auto')?.kind).toBe('auto')
    expect(byName.get('2026-03-01T00-00-00Z-pre-reset')?.kind).toBe('pre-reset')
    expect(byName.get('2026-04-01T00-00-00Z-pre-restore')?.kind).toBe('pre-restore')
    expect(byName.get('2026-05-01T00-00-00Z-pre-migration-v1')?.kind).toBe('pre-migration')
    expect(byName.get('2026-06-01T00-00-00Z-pre-appdata-v7')?.kind).toBe('pre-migration')
    expect(byName.get('2026-07-01T00-00-00Z-corrupt-wal')?.kind).toBe('corrupt-wal')
    expect(byName.get('2026-08-01T00-00-00Z-somethingelse')?.kind).toBe('unknown')

    // restorable = contains graph/ or appdata.db (corrupt-wal + empty → false).
    expect(byName.get('2026-02-01T00-00-00Z-auto')?.restorable).toBe(true)
    expect(byName.get('2026-06-01T00-00-00Z-pre-appdata-v7')?.restorable).toBe(true)
    expect(byName.get('2026-07-01T00-00-00Z-corrupt-wal')?.restorable).toBe(false)
    expect(byName.get('2026-08-01T00-00-00Z-somethingelse')?.restorable).toBe(false)

    // Newest first.
    expect(list[0]?.dirName).toBe('2026-08-01T00-00-00Z-somethingelse')
    // createdAt parsed back to ISO.
    expect(byName.get('2026-02-01T00-00-00Z-auto')?.createdAt).toBe('2026-02-01T00:00:00.000Z')
  })

  it('no backups dir → empty list', () => {
    dir = mkdtempSync(join(tmpdir(), 'bk-list2-'))
    expect(listBackups(dir)).toEqual([])
  })
})

describe('pruneAutoBackups (only -auto, retention-bounded)', () => {
  let dir: string
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('deletes only auto beyond keepLast; every other kind is untouched', () => {
    dir = mkdtempSync(join(tmpdir(), 'bk-prune-'))
    fakeBackupDir(dir, '2026-01-01T00-00-00Z-auto')
    fakeBackupDir(dir, '2026-02-01T00-00-00Z-auto')
    fakeBackupDir(dir, '2026-03-01T00-00-00Z-auto')
    fakeBackupDir(dir, '2026-04-01T00-00-00Z-auto')
    fakeBackupDir(dir, '2026-01-15T00-00-00Z-manual')
    fakeBackupDir(dir, '2026-01-16T00-00-00Z-pre-reset')
    fakeBackupDir(dir, '2026-01-17T00-00-00Z-pre-restore')

    const deleted = pruneAutoBackups(dir, { keepLast: 2 })
    expect(deleted.sort()).toEqual(['2026-01-01T00-00-00Z-auto', '2026-02-01T00-00-00Z-auto'])

    const remaining = backupNames(dir)
    // The 2 newest autos survive, plus every non-auto kind.
    expect(remaining).toContain('2026-03-01T00-00-00Z-auto')
    expect(remaining).toContain('2026-04-01T00-00-00Z-auto')
    expect(remaining).toContain('2026-01-15T00-00-00Z-manual')
    expect(remaining).toContain('2026-01-16T00-00-00Z-pre-reset')
    expect(remaining).toContain('2026-01-17T00-00-00Z-pre-restore')
    expect(remaining).not.toContain('2026-01-01T00-00-00Z-auto')
  })
})

describe('requestRestore (validated at request time)', () => {
  let dir: string
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('rejects traversal names, missing dirs, and non-restorable dirs', () => {
    dir = mkdtempSync(join(tmpdir(), 'bk-req-'))
    mkdirSync(join(dir, 'backups'), { recursive: true })
    expect(() => requestRestore(dir, '../evil')).toThrow(RestoreRequestError)
    expect(() => requestRestore(dir, 'nope')).toThrow(/does not exist/)
    // an empty (non-restorable) dir
    mkdirSync(join(dir, 'backups', 'empty'), { recursive: true })
    expect(() => requestRestore(dir, 'empty')).toThrow(/nothing restorable/)
    // a valid restorable backup writes the marker
    fakeBackupDir(dir, 'good-backup', { graph: true })
    requestRestore(dir, 'good-backup')
    const marker = JSON.parse(readFileSync(restoreMarkerPath(dir), 'utf8'))
    expect(marker.backupDirName).toBe('good-backup')
    expect(marker.source).toBe('settings-ui')
  })
})

describe('performPendingRestore (fail-safe mirror of reset)', () => {
  let dir: string
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('no marker → no-op', () => {
    dir = mkdtempSync(join(tmpdir(), 'bk-rs-a-'))
    seed(dir)
    expect(performPendingRestore(dir)).toEqual({ performed: false, reason: 'no-marker' })
  })

  it('reset just performed → restore superseded, marker defused, data untouched', () => {
    dir = mkdtempSync(join(tmpdir(), 'bk-rs-super-'))
    seed(dir)
    fakeBackupDir(dir, 'good-backup', { graph: true })
    requestRestore(dir, 'good-backup')
    const res = performPendingRestore(dir, () => {}, { resetJustPerformed: true })
    expect(res).toMatchObject({ performed: false, reason: 'superseded' })
    expect(existsSync(restoreMarkerPath(dir))).toBe(false)
    expect(readdirSync(dir).some((n) => n.includes('restore-requested.json.superseded-by-reset-'))).toBe(true)
    // Current data intact (no clear happened).
    expect(existsSync(join(dir, 'graph', 'graph.ryugraph'))).toBe(true)
  })

  it('invalid marker (backup dir missing) → renamed .invalid, data untouched', () => {
    dir = mkdtempSync(join(tmpdir(), 'bk-rs-inv-'))
    seed(dir)
    mkdirSync(join(dir, 'backups'), { recursive: true })
    writeFileSync(restoreMarkerPath(dir), JSON.stringify({ source: 'settings-ui', backupDirName: 'ghost' }))
    const res = performPendingRestore(dir)
    expect(res).toMatchObject({ performed: false, reason: 'invalid-marker' })
    expect(existsSync(restoreMarkerPath(dir))).toBe(false)
    expect(readdirSync(dir).some((n) => n.includes('restore-requested.json.invalid-'))).toBe(true)
    expect(existsSync(join(dir, 'graph', 'graph.ryugraph'))).toBe(true)
    expect(existsSync(join(dir, 'appdata.db'))).toBe(true)
  })

  it('pre-restore snapshot failure (corrupt current appdata) → marker .failed, data untouched, no clear', () => {
    dir = mkdtempSync(join(tmpdir(), 'bk-rs-fail-'))
    seed(dir, { realAppData: false })
    // A corrupt current appdata.db makes the pre-restore VACUUM INTO throw
    // BEFORE the clear — restore must abort with everything intact.
    writeFileSync(join(dir, 'appdata.db'), Buffer.from('NOT A SQLITE DB'))
    // A valid backup to restore FROM (so we get past validation to the snapshot).
    const backup = fakeBackupDir(dir, 'good-backup', { graph: true, appdata: false })
    writeFileSync(join(backup, 'graph', 'graph.ryugraph'), 'restored-graph')
    writeFileSync(restoreMarkerPath(dir), JSON.stringify({ source: 'settings-ui', backupDirName: 'good-backup' }))

    const res = performPendingRestore(dir)
    expect(res).toMatchObject({ performed: false, reason: 'failed' })
    expect(readdirSync(dir).some((n) => n.includes('restore-requested.json.failed-'))).toBe(true)
    // The CLEAR never ran: current graph is the original, not the backup's.
    expect(readFileSync(join(dir, 'graph', 'graph.ryugraph'), 'utf8')).toBe('g'.repeat(2000))
    expect(existsSync(join(dir, 'appdata.db'))).toBe(true)
    expect(existsSync(join(dir, 'keychain.bin'))).toBe(true)
  })

  it('happy path: snapshots current → pre-restore, copies the backup in, marker gone, record written', () => {
    dir = mkdtempSync(join(tmpdir(), 'bk-rs-ok-'))
    seed(dir, { appdataRow: 'state-B' })
    // Build a restorable backup of a DIFFERENT state (state A) with a real appdata.
    const backup = join(dir, 'backups', '2026-01-01T00-00-00Z-manual')
    mkdirSync(join(backup, 'graph'), { recursive: true })
    writeFileSync(join(backup, 'graph', 'graph.ryugraph'), 'state-A-graph')
    writeFileSync(join(backup, 'graph', 'schema-version.json'), JSON.stringify({ version: 1 }))
    const bdb = openAppData(join(backup, 'appdata.db'))
    bdb.db.prepare('INSERT INTO tasks (id, kind) VALUES (?, ?)').run('state-A', 'probe')
    bdb.close()
    writeFileSync(join(backup, 'settings.json'), '{"cloudProvider":"openai"}')

    requestRestore(dir, '2026-01-01T00-00-00Z-manual')
    const res = performPendingRestore(dir)
    expect(res.performed).toBe(true)
    if (!res.performed) throw new Error('unreachable')

    // Marker gone; a pre-restore snapshot of state B exists; restore-record written.
    expect(existsSync(restoreMarkerPath(dir))).toBe(false)
    const preRestore = backupNames(dir).find((n) => n.endsWith('-pre-restore'))
    expect(preRestore).toBeDefined()
    expect(existsSync(join(backup, 'restore-record.json'))).toBe(true)

    // State A is now live: graph + settings copied in.
    expect(readFileSync(join(dir, 'graph', 'graph.ryugraph'), 'utf8')).toBe('state-A-graph')
    expect(readFileSync(join(dir, 'settings.json'), 'utf8')).toBe('{"cloudProvider":"openai"}')
    // appdata carries state A's row (open a scratch copy to avoid mutating live).
    const reopened = openAppData(join(dir, 'appdata.db'))
    try {
      expect(reopened.db.prepare("SELECT count(*) c FROM tasks WHERE id = 'state-A'").get()).toEqual({ c: 1 })
      expect(reopened.db.prepare("SELECT count(*) c FROM tasks WHERE id = 'state-B'").get()).toEqual({ c: 0 })
    } finally {
      reopened.close()
    }

    // The pre-restore snapshot preserved state B.
    const preDb = openAppData(join(dir, 'backups', preRestore as string, 'appdata.db'))
    try {
      expect(preDb.db.prepare("SELECT count(*) c FROM tasks WHERE id = 'state-B'").get()).toEqual({ c: 1 })
    } finally {
      preDb.close()
    }
  })
})

describe('performPendingBackup (marker + auto catch-up + prune)', () => {
  let dir: string
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('consumes a manual marker, removes it, creates a -manual backup', () => {
    dir = mkdtempSync(join(tmpdir(), 'bk-pb-m-'))
    seed(dir)
    saveBackupSettings(dir, { enabled: false, intervalHours: 24, keepLast: 10 }) // no catch-up noise
    requestBackup(dir, 'manual')
    const res = performPendingBackup(dir)
    expect(res.markerBackup).not.toBeNull()
    expect(existsSync(backupMarkerPath(dir))).toBe(false)
    expect(backupNames(dir).some((n) => n.endsWith('-manual'))).toBe(true)
    // The backup carries a valid record + the graph copy.
    expect(existsSync(join(res.markerBackup as string, 'backup-record.json'))).toBe(true)
    expect(existsSync(join(res.markerBackup as string, 'graph', 'graph.ryugraph'))).toBe(true)
  })

  it('invalid marker → renamed .invalid, no backup from the marker', () => {
    dir = mkdtempSync(join(tmpdir(), 'bk-pb-inv-'))
    seed(dir)
    saveBackupSettings(dir, { enabled: false, intervalHours: 24, keepLast: 10 })
    writeFileSync(backupMarkerPath(dir), '{ not json')
    const res = performPendingBackup(dir)
    expect(res.markerBackup).toBeNull()
    expect(readdirSync(dir).some((n) => n.includes('backup-requested.json.invalid-'))).toBe(true)
  })

  it('auto catch-up fires when no -auto exists, then prunes to keepLast', () => {
    dir = mkdtempSync(join(tmpdir(), 'bk-pb-auto-'))
    seed(dir)
    saveBackupSettings(dir, { enabled: true, intervalHours: 24, keepLast: 1 })
    // Pre-existing older auto backups that the prune (keepLast 1) must remove.
    fakeBackupDir(dir, '2020-01-01T00-00-00Z-auto')
    fakeBackupDir(dir, '2020-02-01T00-00-00Z-auto')

    const res = performPendingBackup(dir)
    expect(res.autoBackup).not.toBeNull()
    // Newest auto is the just-created one; the two ancient ones are pruned.
    expect([...res.pruned].sort()).toEqual(['2020-01-01T00-00-00Z-auto', '2020-02-01T00-00-00Z-auto'])
    const autos = listBackups(dir).filter((b) => b.kind === 'auto')
    expect(autos).toHaveLength(1)
  })

  it('auto catch-up does NOT fire when a recent -auto already exists', () => {
    dir = mkdtempSync(join(tmpdir(), 'bk-pb-recent-'))
    seed(dir)
    saveBackupSettings(dir, { enabled: true, intervalHours: 24, keepLast: 10 })
    // A fresh auto backup (now) means "not due".
    const stampNow = new Date().toISOString().replaceAll(':', '-').replace(/\.\d+Z$/, 'Z')
    fakeBackupDir(dir, `${stampNow}-auto`)
    const res = performPendingBackup(dir)
    expect(res.autoBackup).toBeNull()
  })
})
