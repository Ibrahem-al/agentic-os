import { afterEach, describe, expect, it } from 'vitest'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { openAppData } from '../../src/main/storage/appdata'

const TABLES = [
  'traces',
  'tasks',
  'mcp_calls',
  'staged_writes',
  'spend',
  'workflow_checkpoints',
  'workflow_checkpoint_writes',
  'approvals',
  'audit_log',
  'injection_flags',
  'skill_settings',
  'skill_improvements'
] as const

describe('appdata.db (SQLite side of §20 app data)', () => {
  let dir: string
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('creates the db in WAL mode with all tables and user_version 6', () => {
    dir = mkdtempSync(join(tmpdir(), 'appdata-'))
    const appData = openAppData(join(dir, 'nested', 'appdata.db'))
    try {
      expect(existsSync(appData.path)).toBe(true)
      expect(appData.db.pragma('journal_mode', { simple: true })).toBe('wal')
      expect(appData.db.pragma('user_version', { simple: true })).toBe(6)
      expect(appData.db.pragma('foreign_keys', { simple: true })).toBe(1)
      const names = appData.db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
        .all()
        .map((r) => (r as { name: string }).name)
      expect(names).toEqual([...TABLES].sort())
    } finally {
      appData.close()
    }
  })

  it('round-trips a row through each table and enforces CHECK constraints', () => {
    dir = mkdtempSync(join(tmpdir(), 'appdata-'))
    const appData = openAppData(join(dir, 'appdata.db'))
    try {
      const { db } = appData
      db.prepare(
        'INSERT INTO traces (trace_id, span_id, name, start_unix_ms, attributes_json) VALUES (?, ?, ?, ?, ?)'
      ).run('t1', 's1', 'boot', 1000, '{"k":1}')
      db.prepare('INSERT INTO tasks (id, kind, status) VALUES (?, ?, ?)').run('task-1', 'extraction', 'pending')
      db.prepare(
        'INSERT INTO mcp_calls (session_id, tool, args_hash, started_unix_ms, duration_ms) VALUES (?, ?, ?, ?, ?)'
      ).run('sess-1', 'get_context', 'sha256:abc', 2000, 42)
      db.prepare('INSERT INTO staged_writes (id, proposed_by, kind, payload_json) VALUES (?, ?, ?, ?)').run(
        'sw-1',
        'claude',
        'propose_correction',
        '{}'
      )
      db.prepare('INSERT INTO spend (task_id, provider, model, usd) VALUES (?, ?, ?, ?)').run(
        'task-1',
        'anthropic',
        'claude-sonnet-5',
        0.01
      )

      expect((db.prepare('SELECT name FROM traces WHERE trace_id = ?').get('t1') as { name: string }).name).toBe('boot')
      const task = db.prepare('SELECT status, attempts, created_at FROM tasks WHERE id = ?').get('task-1') as {
        status: string
        attempts: number
        created_at: string
      }
      expect(task.status).toBe('pending')
      expect(task.attempts).toBe(0)
      expect(Number.isNaN(Date.parse(task.created_at))).toBe(false)
      const call = db
        .prepare('SELECT tool, args_hash FROM mcp_calls WHERE session_id = ?')
        .get('sess-1') as { tool: string; args_hash: string }
      expect(call.tool).toBe('get_context')
      expect(call.args_hash).toBe('sha256:abc')
      expect(
        (db.prepare('SELECT status FROM staged_writes WHERE id = ?').get('sw-1') as { status: string }).status
      ).toBe('staged')
      expect((db.prepare('SELECT usd FROM spend WHERE task_id = ?').get('task-1') as { usd: number }).usd).toBe(0.01)

      expect(() => db.prepare('INSERT INTO tasks (id, kind, status) VALUES (?, ?, ?)').run('bad', 'x', 'nope')).toThrow(
        /CHECK/
      )
      expect(() =>
        db.prepare('INSERT INTO staged_writes (id, proposed_by, kind, payload_json, status) VALUES (?, ?, ?, ?, ?)').run(
          'bad',
          'claude',
          'k',
          '{}',
          'imaginary'
        )
      ).toThrow(/CHECK/)
    } finally {
      appData.close()
    }
  })

  it('reopens idempotently, preserving data', () => {
    dir = mkdtempSync(join(tmpdir(), 'appdata-'))
    const dbPath = join(dir, 'appdata.db')
    const first = openAppData(dbPath)
    first.db.prepare('INSERT INTO tasks (id, kind) VALUES (?, ?)').run('persist-1', 'probe')
    first.close()

    const second = openAppData(dbPath)
    try {
      expect(second.db.pragma('user_version', { simple: true })).toBe(6)
      expect((second.db.prepare('SELECT count(*) AS c FROM tasks').get() as { c: number }).c).toBe(1)
    } finally {
      second.close()
    }
  })

  it('upgrades a v1 db in place (additive tables + columns, v2 kernel / v3 mcp / v4 security / v5 triggers / v6 skills)', () => {
    dir = mkdtempSync(join(tmpdir(), 'appdata-'))
    const dbPath = join(dir, 'appdata.db')
    const first = openAppData(dbPath)
    // Simulate a phase-01..03 database: drop the phase-04 tables, recreate
    // mcp_calls without the phase-05 args_hash column and tasks without the
    // phase-11 priority/waiting_approval_id columns, set v1.
    first.db.exec(`DROP TABLE tasks;
      CREATE TABLE tasks (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        payload_json TEXT,
        status TEXT NOT NULL DEFAULT 'pending'
          CHECK (status IN ('pending','running','done','failed','deferred')),
        attempts INTEGER NOT NULL DEFAULT 0,
        not_before_unix_ms INTEGER,
        last_error TEXT,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      )`)
    first.db.prepare('INSERT INTO tasks (id, kind) VALUES (?, ?)').run('keep-me', 'probe')
    first.db.exec('DROP TABLE workflow_checkpoints; DROP TABLE workflow_checkpoint_writes')
    first.db.exec('DROP TABLE skill_settings; DROP TABLE skill_improvements')
    first.db.exec(`DROP TABLE mcp_calls;
      CREATE TABLE mcp_calls (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT,
        tool TEXT NOT NULL,
        params_json TEXT,
        result_status TEXT,
        error TEXT,
        started_unix_ms INTEGER NOT NULL,
        duration_ms INTEGER,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      )`)
    first.db
      .prepare('INSERT INTO mcp_calls (session_id, tool, started_unix_ms) VALUES (?, ?, ?)')
      .run('old-sess', 'get_context', 1000)
    first.db.pragma('user_version = 1')
    first.close()

    const upgraded = openAppData(dbPath)
    try {
      expect(upgraded.db.pragma('user_version', { simple: true })).toBe(6)
      const names = upgraded.db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
        .all()
        .map((r) => (r as { name: string }).name)
      expect(names).toEqual([...TABLES].sort())
      expect((upgraded.db.prepare('SELECT count(*) AS c FROM tasks').get() as { c: number }).c).toBe(1)
      // The pre-v3 row survives with a NULL args_hash; the column now exists.
      const old = upgraded.db
        .prepare('SELECT tool, args_hash FROM mcp_calls WHERE session_id = ?')
        .get('old-sess') as { tool: string; args_hash: string | null }
      expect(old.tool).toBe('get_context')
      expect(old.args_hash).toBeNull()
      // The pre-v5 task row survives with the default priority + NULL approval.
      const oldTask = upgraded.db
        .prepare('SELECT priority, waiting_approval_id FROM tasks WHERE id = ?')
        .get('keep-me') as { priority: number; waiting_approval_id: string | null }
      expect(oldTask.priority).toBe(0)
      expect(oldTask.waiting_approval_id).toBeNull()
    } finally {
      upgraded.close()
    }
  })

  it('refuses a db with a newer user_version', () => {
    dir = mkdtempSync(join(tmpdir(), 'appdata-'))
    const dbPath = join(dir, 'appdata.db')
    const first = openAppData(dbPath)
    first.db.pragma('user_version = 99')
    first.close()
    expect(() => openAppData(dbPath)).toThrow(/newer than this build/)
  })

  it('snapshots an upgrading db via VACUUM INTO before touching it (§21 rule 9, §3)', () => {
    dir = mkdtempSync(join(tmpdir(), 'appdata-'))
    const dbPath = join(dir, 'appdata.db')
    // Old-version rig (same approach as the v1-upgrade test above): a marker
    // row + a dropped v6 table make the upgrade — and the snapshot — real.
    const first = openAppData(dbPath)
    first.db.prepare('INSERT INTO tasks (id, kind) VALUES (?, ?)').run('pre-upgrade-marker', 'probe')
    first.db.exec('DROP TABLE skill_settings; DROP TABLE skill_improvements')
    first.db.pragma('user_version = 1')
    first.close()

    const upgraded = openAppData(dbPath)
    try {
      // Main db really upgraded in place.
      expect(upgraded.db.pragma('user_version', { simple: true })).toBe(6)
      expect(
        upgraded.db.prepare("SELECT count(*) AS c FROM sqlite_master WHERE name = 'skill_settings'").get()
      ).toEqual({ c: 1 })
      // Snapshot at the derived default location: <db parent>/backups/<stamp>-pre-appdata-v6/appdata.db.
      const snapshot = upgraded.backupCreated
      expect(snapshot).not.toBeNull()
      expect(existsSync(snapshot as string)).toBe(true)
      expect(dirname(snapshot as string)).toMatch(/-pre-appdata-v6$/)
      expect(dirname(dirname(snapshot as string))).toBe(join(dir, 'backups'))
      // The snapshot is a valid sqlite db frozen at the OLD version: header
      // magic + user_version (byte 60, big-endian) read straight off disk —
      // no direct better-sqlite3 construction (dual-ABI: the default binding
      // does not load under the Electron-runtime suite).
      const header = readFileSync(snapshot as string)
      expect(header.subarray(0, 16).toString('latin1')).toBe('SQLite format 3\u0000')
      expect(header.readUInt32BE(60)).toBe(1)
      // …and openable: a copy round-trips through openAppData with the marker intact.
      const copyPath = join(dir, 'snapshot-check', 'appdata.db')
      mkdirSync(dirname(copyPath), { recursive: true })
      copyFileSync(snapshot as string, copyPath)
      const reopened = openAppData(copyPath)
      try {
        expect(
          (reopened.db.prepare('SELECT kind FROM tasks WHERE id = ?').get('pre-upgrade-marker') as { kind: string })
            .kind
        ).toBe('probe')
      } finally {
        reopened.close()
      }
    } finally {
      upgraded.close()
    }
  })

  it('honors an explicit backupsDir over the derived sibling default', () => {
    dir = mkdtempSync(join(tmpdir(), 'appdata-'))
    const dbPath = join(dir, 'appdata.db')
    const first = openAppData(dbPath)
    first.db.pragma('user_version = 5')
    first.close()

    const elsewhere = join(dir, 'elsewhere')
    const upgraded = openAppData(dbPath, elsewhere)
    try {
      expect(upgraded.db.pragma('user_version', { simple: true })).toBe(6)
      expect(upgraded.backupCreated).not.toBeNull()
      expect(dirname(dirname(upgraded.backupCreated as string))).toBe(elsewhere)
      expect(existsSync(upgraded.backupCreated as string)).toBe(true)
      expect(existsSync(join(dir, 'backups'))).toBe(false)
    } finally {
      upgraded.close()
    }
  })

  it('fresh create and current-version reopen take no snapshot (no backups dir)', () => {
    dir = mkdtempSync(join(tmpdir(), 'appdata-'))
    const dbPath = join(dir, 'appdata.db')
    const fresh = openAppData(dbPath)
    expect(fresh.backupCreated).toBeNull()
    fresh.close()
    const reopened = openAppData(dbPath) // already at the current version
    try {
      expect(reopened.backupCreated).toBeNull()
      expect(existsSync(join(dir, 'backups'))).toBe(false)
    } finally {
      reopened.close()
    }
  })
})
