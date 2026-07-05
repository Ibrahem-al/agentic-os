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
import { existsSync, mkdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import type BetterSqlite3 from 'better-sqlite3'

const require = createRequire(import.meta.url)

export interface AppData {
  readonly db: BetterSqlite3.Database
  readonly path: string
  /** Pre-upgrade snapshot taken by this open (null when none was needed) — mirrors engine.backupCreated. */
  readonly backupCreated: string | null
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
    priority INTEGER NOT NULL DEFAULT 0,
    waiting_approval_id TEXT,
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
    args_hash TEXT,
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
  `CREATE INDEX IF NOT EXISTS idx_spend_task ON spend(task_id)`,
  // Workflow checkpoints (§9/§10, phase 04): LangGraph durable state lives in
  // appdata.db so long jobs survive a restart. Shapes mirror the upstream
  // SQLite saver; serialized blobs come from the checkpointer's serde.
  `CREATE TABLE IF NOT EXISTS workflow_checkpoints (
    thread_id TEXT NOT NULL,
    checkpoint_ns TEXT NOT NULL DEFAULT '',
    checkpoint_id TEXT NOT NULL,
    parent_checkpoint_id TEXT,
    type TEXT,
    checkpoint BLOB NOT NULL,
    metadata BLOB NOT NULL,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    PRIMARY KEY (thread_id, checkpoint_ns, checkpoint_id)
  )`,
  `CREATE TABLE IF NOT EXISTS workflow_checkpoint_writes (
    thread_id TEXT NOT NULL,
    checkpoint_ns TEXT NOT NULL DEFAULT '',
    checkpoint_id TEXT NOT NULL,
    task_id TEXT NOT NULL,
    idx INTEGER NOT NULL,
    channel TEXT NOT NULL,
    type TEXT,
    value BLOB,
    PRIMARY KEY (thread_id, checkpoint_ns, checkpoint_id, task_id, idx)
  )`,
  // Pending approvals (§13 tiered gates, phase 09): write/net/spend-tier
  // actions without a standing grant queue here; the dashboard surfaces the
  // rows (headless they stay queued). A decision persists, so re-running the
  // same action signature after approval succeeds.
  `CREATE TABLE IF NOT EXISTS approvals (
    id TEXT PRIMARY KEY,
    signature TEXT NOT NULL UNIQUE,
    agent_id TEXT NOT NULL,
    action_kind TEXT NOT NULL,
    action_name TEXT NOT NULL,
    tier TEXT NOT NULL,
    details_json TEXT,
    status TEXT NOT NULL DEFAULT 'pending'
      CHECK (status IN ('pending','approved','denied')),
    requested_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    decided_at TEXT,
    decided_by TEXT
  )`,
  `CREATE INDEX IF NOT EXISTS idx_approvals_status ON approvals(status)`,
  // Audit + undo log (§13, phase 09): every committed agent action with a
  // reversible delta — graph inverse ops in inverse_json, file pre-images in
  // backups/<id>/ — plus the kernel's mediated-action trail (kind 'action',
  // not reversible: those rows are observations, not state changes).
  `CREATE TABLE IF NOT EXISTS audit_log (
    id TEXT PRIMARY KEY,
    agent_id TEXT NOT NULL,
    kind TEXT NOT NULL
      CHECK (kind IN ('action','graph-write','file-write','file-delete','undo')),
    description TEXT NOT NULL,
    reversible INTEGER NOT NULL DEFAULT 0,
    inverse_json TEXT,
    backup_dir TEXT,
    outcome TEXT NOT NULL DEFAULT 'ok' CHECK (outcome IN ('ok','error')),
    error TEXT,
    details_json TEXT,
    undone_at TEXT,
    undo_action_id TEXT,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  )`,
  `CREATE INDEX IF NOT EXISTS idx_audit_log_agent ON audit_log(agent_id)`,
  `CREATE INDEX IF NOT EXISTS idx_audit_log_kind ON audit_log(kind)`,
  // Injection-scan findings (§13 detection layer, phase 09): documents whose
  // ingest scan flagged embedded instructions. The content still ingests as
  // inert data (§21 rule 5) — these rows exist for the dashboard review
  // surface, not as a block.
  `CREATE TABLE IF NOT EXISTS injection_flags (
    id TEXT PRIMARY KEY,
    source TEXT NOT NULL,
    detector TEXT NOT NULL CHECK (detector IN ('regex','llm')),
    pattern TEXT NOT NULL,
    excerpt TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  )`,
  `CREATE INDEX IF NOT EXISTS idx_injection_flags_source ON injection_flags(source)`,
  // Skill-improvement operational state (§17 agent #4, phase 12). The graph
  // keeps the §18 ontology (Skill/SkillVersion/Correction/Example); the
  // agent's run bookkeeping lives here like tasks/spend do:
  //  - skill_settings: the §17 per-skill adoption setting (verifiable skills
  //    may auto-adopt; stylistic — the default — always route to the review
  //    queue), the §20 drift auto-revert toggle (off by default) and the
  //    event-gate cursor (last_run_at: corrections/failure examples created
  //    after it are "new signal").
  //  - skill_improvements: one ledger row per candidate attempt — benchmark
  //    detail, adoption/rollback timestamps, the predecessor snapshot rollback
  //    restores, and the §20 drift-watch columns.
  `CREATE TABLE IF NOT EXISTS skill_settings (
    skill_id TEXT PRIMARY KEY,
    mode TEXT NOT NULL DEFAULT 'stylistic' CHECK (mode IN ('verifiable','stylistic')),
    auto_revert INTEGER NOT NULL DEFAULT 0,
    last_run_at TEXT,
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  )`,
  `CREATE TABLE IF NOT EXISTS skill_improvements (
    id TEXT PRIMARY KEY,
    skill_id TEXT NOT NULL,
    candidate_version_id TEXT NOT NULL,
    predecessor_version_id TEXT,
    predecessor_instructions TEXT,
    mode TEXT NOT NULL CHECK (mode IN ('verifiable','stylistic')),
    outcome TEXT NOT NULL CHECK (outcome IN ('adopted','rejected','staged')),
    benchmark_json TEXT NOT NULL,
    reason TEXT,
    job_id TEXT,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    adopted_at TEXT,
    rolled_back_at TEXT,
    drift_flagged_at TEXT,
    drift_json TEXT,
    drift_resolved_at TEXT
  )`,
  `CREATE INDEX IF NOT EXISTS idx_skill_improvements_skill ON skill_improvements(skill_id)`
]

const APPDATA_USER_VERSION = 6

/**
 * Column additions to tables that predate them (CREATE IF NOT EXISTS skips an
 * existing table, so new columns need a guarded ALTER). Applied idempotently:
 * the column is added only when pragma table_info says it is missing.
 * v3 (phase 05): mcp_calls.args_hash — the call log keeps a stable hash of
 * every tool call's arguments even when the args JSON is too large to store.
 * v5 (phase 11): tasks.priority (the §8 queue mirror lists priority as a
 * column) and tasks.waiting_approval_id (a task deferred behind a §13
 * pending-approval row retries when the approval is decided).
 */
const APPDATA_COLUMN_ADDITIONS: readonly { table: string; column: string; ddl: string }[] = [
  { table: 'mcp_calls', column: 'args_hash', ddl: 'ALTER TABLE mcp_calls ADD COLUMN args_hash TEXT' },
  { table: 'tasks', column: 'priority', ddl: 'ALTER TABLE tasks ADD COLUMN priority INTEGER NOT NULL DEFAULT 0' },
  { table: 'tasks', column: 'waiting_approval_id', ddl: 'ALTER TABLE tasks ADD COLUMN waiting_approval_id TEXT' }
]

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

/**
 * Pre-upgrade snapshot of appdata.db into
 * `<backupsDir>/<stamp>-pre-appdata-v<target>/appdata.db` via VACUUM INTO —
 * synchronous, atomic, and valid on an open WAL database. Naming mirrors the
 * graph's `<stamp>-pre-migration-v<N>` backups. Returns the snapshot file.
 */
function backupAppDataDb(db: BetterSqlite3.Database, backupsDir: string): string {
  const stamp = new Date().toISOString().replaceAll(':', '-').replace(/\.\d+Z$/, 'Z')
  const base = join(backupsDir, `${stamp}-pre-appdata-v${APPDATA_USER_VERSION}`)
  let dest = base
  for (let n = 2; existsSync(dest); n++) dest = `${base}-${n}`
  mkdirSync(dest, { recursive: true })
  const file = join(dest, 'appdata.db')
  db.prepare('VACUUM INTO ?').run(file)
  return file
}

/**
 * Open (creating if needed) appdata.db, apply pragmas + schema idempotently.
 *
 * `backupsDir` receives the §21-rule-9 pre-upgrade snapshot (§3 — the same
 * discipline the graph store gets). When omitted it derives to the sibling
 * `backups/` of the db file's parent, which is exactly the boot layout:
 * config.appDataPaths() puts `appdata.db` and `backups/` under the same
 * userData parent, so the derived default and the configured dir coincide.
 */
export function openAppData(dbPath: string, backupsDir?: string): AppData {
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
  // §21 rule 9 applied to the SQLite side (§3): a REAL upgrade of an existing
  // store (0 < on-disk version < target) is snapshotted BEFORE any schema
  // statement — or even a pragma — touches it. Fresh creates (version 0) and
  // already-current stores take no backup.
  let backupCreated: string | null = null
  if (existingVersion > 0 && existingVersion < APPDATA_USER_VERSION) {
    backupCreated = backupAppDataDb(db, backupsDir ?? join(dirname(dbPath), 'backups'))
  }
  db.pragma('journal_mode = WAL')
  db.pragma('synchronous = NORMAL')
  db.pragma('foreign_keys = ON')
  for (const statement of APPDATA_SCHEMA) db.exec(statement)
  for (const addition of APPDATA_COLUMN_ADDITIONS) {
    const columns = db.pragma(`table_info(${addition.table})`) as { name: string }[]
    if (!columns.some((c) => c.name === addition.column)) db.exec(addition.ddl)
  }
  if (existingVersion < APPDATA_USER_VERSION) {
    // Every schema change so far is additive (CREATE IF NOT EXISTS tables +
    // guarded ADD COLUMNs above), so applying the full list upgrades any older
    // version in place (v1 → v2: workflow_checkpoint* tables, phase 04;
    // v2 → v3: mcp_calls.args_hash, phase 05; v3 → v4: approvals + audit_log +
    // injection_flags, phase 09; v4 → v5: tasks.priority +
    // tasks.waiting_approval_id, phase 11; v5 → v6: skill_settings +
    // skill_improvements, phase 12).
    db.pragma(`user_version = ${APPDATA_USER_VERSION}`)
  }
  return {
    db,
    path: dbPath,
    backupCreated,
    close: () => {
      db.close()
    }
  }
}
