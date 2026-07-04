/**
 * appdata.db — the SQLite side of app data (§20): `traces`, `tasks`,
 * `mcp_calls`, `staged_writes`, `spend`. Schemas live here in code; WAL mode.
 * Later phases populate these tables; this module owns creation and access.
 *
 * Dual-ABI native binding: better-sqlite3 is not N-API, so one binary cannot
 * serve both plain Node (vitest, scripts) and Electron. `npm run
 * rebuild:native` (scripts/native/rebuild-native.cjs) leaves the plain-Node
 * binary at better-sqlite3's default location and stashes an Electron-ABI
 * build alongside as `better_sqlite3-electron.node`; openAppData() picks
 * whichever loads in the current runtime via the documented `nativeBinding`
 * option and remembers the winner.
 */
import { mkdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import type BetterSqlite3 from 'better-sqlite3'

const require = createRequire(import.meta.url)

export interface AppData {
  readonly db: BetterSqlite3.Database
  readonly path: string
  close(): void
}

/** One statement per table/index; every statement idempotent. */
const APPDATA_SCHEMA: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS traces (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    trace_id TEXT NOT NULL,
    span_id TEXT NOT NULL,
    parent_span_id TEXT,
    name TEXT NOT NULL,
    kind TEXT,
    start_unix_ms INTEGER NOT NULL,
    end_unix_ms INTEGER,
    status TEXT,
    attributes_json TEXT,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  )`,
  `CREATE INDEX IF NOT EXISTS idx_traces_trace_id ON traces(trace_id)`,
  `CREATE TABLE IF NOT EXISTS tasks (
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
  )`,
  `CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status)`,
  `CREATE TABLE IF NOT EXISTS mcp_calls (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT,
    tool TEXT NOT NULL,
    params_json TEXT,
    result_status TEXT,
    error TEXT,
    started_unix_ms INTEGER NOT NULL,
    duration_ms INTEGER,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  )`,
  `CREATE INDEX IF NOT EXISTS idx_mcp_calls_session ON mcp_calls(session_id)`,
  `CREATE TABLE IF NOT EXISTS staged_writes (
    id TEXT PRIMARY KEY,
    proposed_by TEXT NOT NULL,
    kind TEXT NOT NULL,
    target_label TEXT,
    target_id TEXT,
    payload_json TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'staged'
      CHECK (status IN ('staged','approved','rejected','committed')),
    validation_json TEXT,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    decided_at TEXT,
    committed_at TEXT
  )`,
  `CREATE INDEX IF NOT EXISTS idx_staged_writes_status ON staged_writes(status)`,
  `CREATE TABLE IF NOT EXISTS spend (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id TEXT,
    provider TEXT,
    model TEXT,
    input_tokens INTEGER,
    output_tokens INTEGER,
    usd REAL NOT NULL,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  )`,
  `CREATE INDEX IF NOT EXISTS idx_spend_task ON spend(task_id)`
]

const APPDATA_USER_VERSION = 1

/** The binding that loaded successfully in this runtime (cached). */
let resolvedBinding: string | null | undefined

function isAbiMismatch(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err)
  const code = (err as { code?: string }).code
  return (
    code === 'ERR_DLOPEN_FAILED' ||
    /NODE_MODULE_VERSION|was compiled against a different Node\.js version|specified procedure could not be found/i.test(
      message
    )
  )
}

/**
 * Open a database, trying the default binding and the Electron-ABI stash in
 * runtime-appropriate order. Non-ABI errors propagate untouched.
 */
function openWithBinding(
  Database: typeof BetterSqlite3,
  dbPath: string,
  electronStash: string
): BetterSqlite3.Database {
  if (resolvedBinding !== undefined) {
    return resolvedBinding === null
      ? new Database(dbPath)
      : new Database(dbPath, { nativeBinding: resolvedBinding })
  }
  // null = better-sqlite3's own default resolution.
  const candidates: (string | null)[] = process.versions.electron ? [electronStash, null] : [null, electronStash]
  let lastAbiError: unknown
  for (const candidate of candidates) {
    try {
      const db = candidate === null ? new Database(dbPath) : new Database(dbPath, { nativeBinding: candidate })
      resolvedBinding = candidate
      return db
    } catch (err) {
      if (!isAbiMismatch(err)) throw err
      lastAbiError = err
    }
  }
  throw new Error(
    `better-sqlite3 has no native binding matching this runtime (tried default and the Electron stash) — run \`npm run rebuild:native\`. Last error: ${
      lastAbiError instanceof Error ? lastAbiError.message : String(lastAbiError)
    }`
  )
}

/** Open (creating if needed) appdata.db, apply pragmas + schema idempotently. */
export function openAppData(dbPath: string): AppData {
  mkdirSync(dirname(dbPath), { recursive: true })
  const Database = require('better-sqlite3') as typeof BetterSqlite3
  const bs3Dir = dirname(require.resolve('better-sqlite3/package.json'))
  const electronStash = join(bs3Dir, 'build', 'Release', 'better_sqlite3-electron.node')

  const db = openWithBinding(Database, dbPath, electronStash)
  const existingVersion = db.pragma('user_version', { simple: true }) as number
  if (existingVersion > APPDATA_USER_VERSION) {
    db.close()
    throw new Error(
      `${dbPath} has user_version ${existingVersion}, newer than this build understands (${APPDATA_USER_VERSION}) — it belongs to a different build; refusing to touch it`
    )
  }
  db.pragma('journal_mode = WAL')
  db.pragma('synchronous = NORMAL')
  db.pragma('foreign_keys = ON')
  for (const statement of APPDATA_SCHEMA) db.exec(statement)
  if (existingVersion === 0) {
    db.pragma(`user_version = ${APPDATA_USER_VERSION}`)
  }
  return {
    db,
    path: dbPath,
    close: () => {
      db.close()
    }
  }
}
