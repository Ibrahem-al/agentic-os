import { afterEach, describe, expect, it } from 'vitest'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openAppData } from '../../src/main/storage/appdata'

const TABLES = ['traces', 'tasks', 'mcp_calls', 'staged_writes', 'spend'] as const

describe('appdata.db (SQLite side of §20 app data)', () => {
  let dir: string
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('creates the db in WAL mode with all five tables and user_version 1', () => {
    dir = mkdtempSync(join(tmpdir(), 'appdata-'))
    const appData = openAppData(join(dir, 'nested', 'appdata.db'))
    try {
      expect(existsSync(appData.path)).toBe(true)
      expect(appData.db.pragma('journal_mode', { simple: true })).toBe('wal')
      expect(appData.db.pragma('user_version', { simple: true })).toBe(1)
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
      db.prepare('INSERT INTO mcp_calls (session_id, tool, started_unix_ms, duration_ms) VALUES (?, ?, ?, ?)').run(
        'sess-1',
        'retrieve_context',
        2000,
        42
      )
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
      expect(
        (db.prepare('SELECT tool FROM mcp_calls WHERE session_id = ?').get('sess-1') as { tool: string }).tool
      ).toBe('retrieve_context')
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
      expect(second.db.pragma('user_version', { simple: true })).toBe(1)
      expect((second.db.prepare('SELECT count(*) AS c FROM tasks').get() as { c: number }).c).toBe(1)
    } finally {
      second.close()
    }
  })
})
