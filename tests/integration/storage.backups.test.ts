/**
 * Data & backups against a REAL RyuGraph engine. Because RyuGraph holds an OS
 * lock on graph.ryugraph while open (verified — a live file copy fails EBUSY),
 * the file-level backup/restore run against a CLOSED store — exactly the boot
 * conditions performPendingBackup/performPendingRestore rely on.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { type Dirent, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { createBackup, listBackups, openRyuGraphEngine, performPendingRestore, requestRestore } from '../../src/main/storage'
import { openAppData } from '../../src/main/storage/appdata'
import { EXTENSIONS_DIR } from './helpers'

let baseDir: string
afterEach(() => rmSync(baseDir, { recursive: true, force: true }))

const openEngine = () =>
  openRyuGraphEngine({
    graphDir: join(baseDir, 'graph'),
    backupsDir: join(baseDir, 'backups'),
    extensionsDir: EXTENSIONS_DIR,
    checkpointIntervalMs: 0
  })

function countTree(dir: string): { files: number; bytes: number } {
  let files = 0
  let bytes = 0
  const stack = [dir]
  while (stack.length > 0) {
    const cur = stack.pop() as string
    let entries: Dirent[]
    try {
      entries = readdirSync(cur, { withFileTypes: true })
    } catch {
      continue
    }
    for (const e of entries) {
      const p = join(cur, e.name)
      if (e.isDirectory()) stack.push(p)
      else if (e.isFile()) {
        bytes += statSync(p).size
        files += 1
      }
    }
  }
  return { files, bytes }
}

describe('createBackup against a real engine', () => {
  it('write nodes → checkpoint → close → snapshot verifies + counts match the source', async () => {
    baseDir = mkdtempSync(join(tmpdir(), 'bk-int-create-'))
    let engine = await openEngine()
    for (let i = 0; i < 20; i++) await engine.upsertNode('Tag', { id: `t${i}`, name: `n${i}`, is_global: true })
    await engine.checkpoint()
    await engine.close() // releases the graph OS lock → file-level copy is safe

    const dir = createBackup(baseDir, 'manual')

    const record = JSON.parse(readFileSync(join(dir, 'backup-record.json'), 'utf8'))
    expect(record.kind).toBe('manual')
    expect(record.checks.graphCountMatch).toBe(true)
    expect(record.snapshot.graph.files).toBeGreaterThan(0)

    // The copy is byte-for-byte the source graph tree.
    expect(countTree(join(dir, 'graph'))).toEqual(countTree(join(baseDir, 'graph')))

    // The source store is intact — reopens with all 20 nodes.
    engine = await openEngine()
    try {
      const rows = await engine.cypher('MATCH (n:Tag) RETURN count(n) AS c')
      expect(Number(rows[0]?.['c'])).toBe(20)
    } finally {
      await engine.close()
    }
  })
})

describe('full restore round-trip (Electron-free)', () => {
  it('state A → backup → mutate to B → restore → A is back, B snapshotted to pre-restore', async () => {
    baseDir = mkdtempSync(join(tmpdir(), 'bk-int-restore-'))

    // ── State A: appdata row 'A' + Tags A1/A2 ──────────────────────────────
    let app = openAppData(join(baseDir, 'appdata.db'))
    app.db.prepare('INSERT INTO tasks (id, kind) VALUES (?, ?)').run('A', 'probe')
    app.close()
    let engine = await openEngine()
    await engine.upsertNode('Tag', { id: 'A1', name: 'a1', is_global: true })
    await engine.upsertNode('Tag', { id: 'A2', name: 'a2', is_global: true })
    await engine.checkpoint()
    await engine.close()

    const backupName = basename(createBackup(baseDir, 'manual'))

    // ── Mutate to State B: add appdata row 'B' + Tag B1 ────────────────────
    app = openAppData(join(baseDir, 'appdata.db'))
    app.db.prepare('INSERT INTO tasks (id, kind) VALUES (?, ?)').run('B', 'probe')
    app.close()
    engine = await openEngine()
    await engine.upsertNode('Tag', { id: 'B1', name: 'b1', is_global: true })
    await engine.checkpoint()
    await engine.close()

    // ── Restore to A (stores closed = the boot conditions) ─────────────────
    requestRestore(baseDir, backupName)
    const res = performPendingRestore(baseDir)
    expect(res.performed).toBe(true)

    // Graph is back to A1/A2 (B1 gone).
    engine = await openEngine()
    try {
      const ids = (await engine.cypher('MATCH (n:Tag) RETURN n.id AS id ORDER BY id')).map((r) => String(r['id']))
      expect(ids).toEqual(['A1', 'A2'])
    } finally {
      await engine.close()
    }

    // appdata is back to A only.
    app = openAppData(join(baseDir, 'appdata.db'))
    try {
      expect(app.db.prepare("SELECT count(*) AS c FROM tasks WHERE id = 'A'").get()).toEqual({ c: 1 })
      expect(app.db.prepare("SELECT count(*) AS c FROM tasks WHERE id = 'B'").get()).toEqual({ c: 0 })
    } finally {
      app.close()
    }

    // A pre-restore snapshot of state B exists and still carries B.
    const preRestore = listBackups(baseDir).find((b) => b.kind === 'pre-restore')
    expect(preRestore).toBeDefined()
    const preDb = openAppData(join(baseDir, 'backups', (preRestore as { dirName: string }).dirName, 'appdata.db'))
    try {
      expect(preDb.db.prepare("SELECT count(*) AS c FROM tasks WHERE id = 'B'").get()).toEqual({ c: 1 })
    } finally {
      preDb.close()
    }
  })
})
