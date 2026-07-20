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
      CHECK (status IN ('pending','running','done','failed','deferred','cancelled','paused')),
    attempts INTEGER NOT NULL DEFAULT 0,
    not_before_unix_ms INTEGER,
    priority INTEGER NOT NULL DEFAULT 0,
    waiting_approval_id TEXT,
    last_error TEXT,
    started_at TEXT,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  )`,
  `CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status)`,
  `CREATE TABLE IF NOT EXISTS mcp_calls (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT,
    session_kind TEXT,
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
  // outcome 'pending' (v8): a crash-journaled graph write is inserted 'pending'
  // BEFORE its lane job runs and flipped to ok/error after (security/audit.ts) —
  // a 'pending' row surviving a restart is a write the process died mid-way and
  // the boot sweep rolls back (crashSweep.ts). An EXISTING store's audit_log was
  // created with the two-value CHECK; migrateAuditLogOutcomeCheck() rebuilds it.
  `CREATE TABLE IF NOT EXISTS audit_log (
    id TEXT PRIMARY KEY,
    agent_id TEXT NOT NULL,
    kind TEXT NOT NULL
      CHECK (kind IN ('action','graph-write','file-write','file-delete','undo')),
    description TEXT NOT NULL,
    reversible INTEGER NOT NULL DEFAULT 0,
    inverse_json TEXT,
    backup_dir TEXT,
    outcome TEXT NOT NULL DEFAULT 'ok' CHECK (outcome IN ('ok','error','pending')),
    error TEXT,
    details_json TEXT,
    undone_at TEXT,
    undo_action_id TEXT,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  )`,
  `CREATE INDEX IF NOT EXISTS idx_audit_log_agent ON audit_log(agent_id)`,
  `CREATE INDEX IF NOT EXISTS idx_audit_log_kind ON audit_log(kind)`,
  // Lane-job journal (v8, crash-safety): the storage engine inserts one row per
  // write lane job (jobStarted) and DELETES it on clean finish (jobFinished), so
  // any row present at boot is a lane job the process died mid-execution. The boot
  // sweep flags a non-audited interrupted job (raw ingest withWrite) from these —
  // audited writes are reconciled from their 'pending' audit_log row instead. Tiny
  // and self-pruning (~empty in steady state). finished_at is retained for schema
  // fidelity but stays NULL in practice (a finished job's row is deleted).
  `CREATE TABLE IF NOT EXISTS lane_jobs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    label TEXT,
    started_at TEXT,
    finished_at TEXT
  )`,
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
  `CREATE INDEX IF NOT EXISTS idx_skill_improvements_skill ON skill_improvements(skill_id)`,
  // Headless-runner bookkeeping (phase 14, MCP-COVERAGE spec):
  //  - runner_runs: one row per spawned `claude -p` process — the CallBudget's
  //    DURABLE per-task call ledger (§9.3/P0.2: count survives crash/resume the
  //    way `spend` rows do), the §3.7 usage/window accounting source
  //    (input/output tokens over started_at), and the §10.1 zombie defense's
  //    pid record. shadow_cost_usd is the observability-only price estimate —
  //    subscription runs create NO spend rows.
  //  - runner_submissions: agent-mode result payloads (submit_extraction_items
  //    et al.) captured verbatim before staging, keyed to the spawning task.
  `CREATE TABLE IF NOT EXISTS runner_runs (
    id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL,
    mode TEXT NOT NULL,
    model TEXT,
    claude_session_id TEXT,
    transport_session_id TEXT,
    pid INTEGER,
    started_at TEXT NOT NULL,
    duration_ms INTEGER,
    num_turns INTEGER,
    input_tokens INTEGER,
    output_tokens INTEGER,
    shadow_cost_usd REAL,
    stderr_tail TEXT,
    is_error INTEGER,
    error TEXT,
    exit_code INTEGER
  )`,
  `CREATE INDEX IF NOT EXISTS idx_runner_runs_task ON runner_runs(task_id)`,
  `CREATE INDEX IF NOT EXISTS idx_runner_runs_started ON runner_runs(started_at)`,
  `CREATE TABLE IF NOT EXISTS runner_submissions (
    id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL,
    session_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`,
  `CREATE INDEX IF NOT EXISTS idx_runner_submissions_task ON runner_submissions(task_id)`,
  // Local-LLM usage ledger (v9, local-LLM visibility feature): ONE row per local
  // qwen3 reasoning call through the Ollama generate() chokepoint — the §2.2 role
  // it served (NULL ⇒ a direct deps.llm call with no role context, surfaced as
  // 'other'), the model, Ollama's own counters (prompt_eval_count/eval_count and
  // total_duration → duration_ms) and whether the call succeeded. EMBEDDINGS are
  // deliberately NOT recorded — the embedder (bge-m3) is schema-pinned and out of
  // scope; this ledger is the qwen3 REASONING tier only. Observability only (never
  // a data asset): rows older than LOCAL_LLM_USAGE_RETENTION_DAYS are pruned on
  // boot (storage/localUsage.ts pruneLocalLlmUsage). The recorder NEVER fails the
  // call — a write error is swallowed at the Ollama seam.
  `CREATE TABLE IF NOT EXISTS local_llm_usage (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    role TEXT,
    model TEXT NOT NULL,
    prompt_tokens INTEGER,
    eval_tokens INTEGER,
    duration_ms INTEGER,
    ok INTEGER NOT NULL DEFAULT 1
  )`,
  `CREATE INDEX IF NOT EXISTS idx_local_llm_usage_ts ON local_llm_usage(ts)`,
  // Last COMPLETED background duplicate scan (memory/dedupeController.ts) — a
  // single row (id=1). The scan runs in main and survives the modal closing;
  // reopening (even after a restart) shows `result_json`. `watermark_at` is the
  // scan-START wall-clock of the last completed recent/all scan — the next
  // 'recent' scan compares only nodes changed since it. Not audited: read-only
  // maintenance bookkeeping, like spend/usage rows.
  `CREATE TABLE IF NOT EXISTS dedupe_scans (
    id            INTEGER PRIMARY KEY CHECK (id = 1),
    completed_at  TEXT NOT NULL,
    scope         TEXT NOT NULL,
    options_json  TEXT NOT NULL,
    result_json   TEXT NOT NULL,
    scanned_nodes INTEGER NOT NULL DEFAULT 0,
    watermark_at  TEXT
  )`
]

/**
 * Current SQLite schema version. Exported so the boot-time data manifest can
 * record which schema the on-disk store carries (docs/DATA-MIGRATION.md).
 * v12: the additive `dedupe_scans` background-scan cache (a new table, so the
 * version ticks — same discipline as v9's `local_llm_usage`; the CREATE IF NOT
 * EXISTS in APPDATA_SCHEMA creates it for fresh + upgrading stores alike).
 */
export const APPDATA_USER_VERSION = 12

/**
 * Column additions to tables that predate them (CREATE IF NOT EXISTS skips an
 * existing table, so new columns need a guarded ALTER). Applied idempotently:
 * the column is added only when pragma table_info says it is missing.
 * v3 (phase 05): mcp_calls.args_hash — the call log keeps a stable hash of
 * every tool call's arguments even when the args JSON is too large to store.
 * v5 (phase 11): tasks.priority (the §8 queue mirror lists priority as a
 * column) and tasks.waiting_approval_id (a task deferred behind a §13
 * pending-approval row retries when the approval is decided).
 * v7 (phase 14): mcp_calls.session_kind — 'runner' rows let the §6 inactivity
 * sweep skip a headless runner's own MCP session (MCP-COVERAGE §10.2, P0.5).
 * Nullable: interactive callers pass nothing.
 */
const APPDATA_COLUMN_ADDITIONS: readonly { table: string; column: string; ddl: string }[] = [
  { table: 'mcp_calls', column: 'args_hash', ddl: 'ALTER TABLE mcp_calls ADD COLUMN args_hash TEXT' },
  { table: 'tasks', column: 'priority', ddl: 'ALTER TABLE tasks ADD COLUMN priority INTEGER NOT NULL DEFAULT 0' },
  { table: 'tasks', column: 'waiting_approval_id', ddl: 'ALTER TABLE tasks ADD COLUMN waiting_approval_id TEXT' },
  { table: 'mcp_calls', column: 'session_kind', ddl: 'ALTER TABLE mcp_calls ADD COLUMN session_kind TEXT' }
]

/**
 * v8 (this build): audit_log.outcome gains 'pending' as a legal value. SQLite
 * cannot ALTER a column CHECK, so an EXISTING store's audit_log (created with the
 * v4 two-value CHECK) is rebuilt in place — copy every row into a table carrying
 * the widened CHECK, swap, recreate the indexes — inside one transaction so a
 * crash mid-rebuild rolls back to the original table (the pre-upgrade snapshot in
 * openAppData is the outer safety net). Guarded + idempotent: it runs only when
 * the on-disk CHECK still lacks 'pending' (a fresh install already carries it from
 * APPDATA_SCHEMA, so this is a no-op there). audit_log has no incoming foreign
 * keys, so the DROP+RENAME is safe with foreign_keys ON.
 */
function migrateAuditLogOutcomeCheck(db: BetterSqlite3.Database): void {
  const row = db.prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'audit_log'`).get() as
    | { sql: string }
    | undefined
  if (row === undefined) return // fresh install — the schema loop already created it with 'pending'
  if (/'pending'/.test(row.sql)) return // already widened (fresh v8, or a prior upgrade)
  db.transaction(() => {
    db.exec(`CREATE TABLE audit_log_v8 (
      id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL,
      kind TEXT NOT NULL
        CHECK (kind IN ('action','graph-write','file-write','file-delete','undo')),
      description TEXT NOT NULL,
      reversible INTEGER NOT NULL DEFAULT 0,
      inverse_json TEXT,
      backup_dir TEXT,
      outcome TEXT NOT NULL DEFAULT 'ok' CHECK (outcome IN ('ok','error','pending')),
      error TEXT,
      details_json TEXT,
      undone_at TEXT,
      undo_action_id TEXT,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    )`)
    db.exec(`INSERT INTO audit_log_v8
      (id, agent_id, kind, description, reversible, inverse_json, backup_dir, outcome, error, details_json, undone_at, undo_action_id, created_at)
      SELECT id, agent_id, kind, description, reversible, inverse_json, backup_dir, outcome, error, details_json, undone_at, undo_action_id, created_at
      FROM audit_log`)
    db.exec(`DROP TABLE audit_log`)
    db.exec(`ALTER TABLE audit_log_v8 RENAME TO audit_log`)
    db.exec(`CREATE INDEX IF NOT EXISTS idx_audit_log_agent ON audit_log(agent_id)`)
    db.exec(`CREATE INDEX IF NOT EXISTS idx_audit_log_kind ON audit_log(kind)`)
  })()
}

/**
 * v10 (this build): tasks.status gains 'cancelled' as a legal value (the §8 queue
 * can now cancel a running/queued task). Same guarded in-place rebuild as
 * migrateAuditLogOutcomeCheck — SQLite cannot ALTER a column CHECK — copying every
 * row (explicit 11-column list: the v5 ADD-COLUMNs mean column ORDER varies across
 * old stores, so `SELECT *` is unsafe) into a table carrying the widened CHECK,
 * swapping, and recreating idx_tasks_status, inside one transaction (the pre-upgrade
 * VACUUM snapshot in openAppData is the outer net). Guarded + idempotent: it runs
 * only when the on-disk CHECK still lacks 'cancelled'. `tasks` has no incoming
 * foreign keys (workflow_checkpoints.thread_id is a naming convention, not an FK),
 * so DROP+RENAME is safe with foreign_keys ON.
 */
function migrateTasksStatusCheck(db: BetterSqlite3.Database): void {
  const row = db.prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'tasks'`).get() as
    | { sql: string }
    | undefined
  if (row === undefined) return // fresh install — the schema loop already created it with 'cancelled'
  if (/'cancelled'/.test(row.sql)) return // already widened (fresh v10, or a prior upgrade)
  db.transaction(() => {
    db.exec(`CREATE TABLE tasks_v10 (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      payload_json TEXT,
      status TEXT NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending','running','done','failed','deferred','cancelled')),
      attempts INTEGER NOT NULL DEFAULT 0,
      not_before_unix_ms INTEGER,
      priority INTEGER NOT NULL DEFAULT 0,
      waiting_approval_id TEXT,
      last_error TEXT,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    )`)
    db.exec(`INSERT INTO tasks_v10
      (id, kind, payload_json, status, attempts, not_before_unix_ms, priority, waiting_approval_id, last_error, created_at, updated_at)
      SELECT id, kind, payload_json, status, attempts, not_before_unix_ms, priority, waiting_approval_id, last_error, created_at, updated_at
      FROM tasks`)
    db.exec(`DROP TABLE tasks`)
    db.exec(`ALTER TABLE tasks_v10 RENAME TO tasks`)
    db.exec(`CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status)`)
  })()
}

/**
 * v11: widen tasks.status's CHECK to allow 'paused' (user pause/resume) AND add
 * the `started_at` column (per-run execution start, for the Resources "time it
 * took" readout). SQLite cannot ALTER a CHECK, so this is a guarded/idempotent
 * in-place rebuild mirroring migrateTasksStatusCheck; a fresh v11 install already
 * has both, making this a no-op. The 11 pre-v11 columns copy across; started_at
 * defaults NULL for existing rows (their execution time is simply unknown).
 */
function migrateTasksV11(db: BetterSqlite3.Database): void {
  const row = db.prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'tasks'`).get() as
    | { sql: string }
    | undefined
  if (row === undefined) return // fresh install — the schema loop created it in the v11 shape
  if (/'paused'/.test(row.sql)) return // already at the v11 shape
  db.transaction(() => {
    db.exec(`CREATE TABLE tasks_v11 (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      payload_json TEXT,
      status TEXT NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending','running','done','failed','deferred','cancelled','paused')),
      attempts INTEGER NOT NULL DEFAULT 0,
      not_before_unix_ms INTEGER,
      priority INTEGER NOT NULL DEFAULT 0,
      waiting_approval_id TEXT,
      last_error TEXT,
      started_at TEXT,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    )`)
    db.exec(`INSERT INTO tasks_v11
      (id, kind, payload_json, status, attempts, not_before_unix_ms, priority, waiting_approval_id, last_error, created_at, updated_at)
      SELECT id, kind, payload_json, status, attempts, not_before_unix_ms, priority, waiting_approval_id, last_error, created_at, updated_at
      FROM tasks`)
    db.exec(`DROP TABLE tasks`)
    db.exec(`ALTER TABLE tasks_v11 RENAME TO tasks`)
    db.exec(`CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status)`)
  })()
}

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
 * runtime-appropriate order. Non-ABI errors propagate untouched. `options` are
 * merged into the better-sqlite3 constructor (e.g. `{ readonly: true }` for the
 * read-only snapshot/integrity paths); the resolved `nativeBinding` is added on
 * top of them.
 */
function openWithBinding(
  Database: typeof BetterSqlite3,
  dbPath: string,
  electronStash: string,
  options: BetterSqlite3.Options = {}
): BetterSqlite3.Database {
  if (resolvedBinding !== undefined) {
    return resolvedBinding === null
      ? new Database(dbPath, options)
      : new Database(dbPath, { ...options, nativeBinding: resolvedBinding })
  }
  // null = better-sqlite3's own default resolution.
  const candidates: (string | null)[] = process.versions.electron ? [electronStash, null] : [null, electronStash]
  let lastAbiError: unknown
  for (const candidate of candidates) {
    try {
      const db =
        candidate === null ? new Database(dbPath, options) : new Database(dbPath, { ...options, nativeBinding: candidate })
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

/** Resolve the better-sqlite3 class + the Electron-ABI stash path (dual-ABI). */
function loadBetterSqlite3(): { Database: typeof BetterSqlite3; electronStash: string } {
  const Database = require('better-sqlite3') as typeof BetterSqlite3
  const bs3Dir = dirname(require.resolve('better-sqlite3/package.json'))
  const electronStash = join(bs3Dir, 'build', 'Release', 'better_sqlite3-electron.node')
  return { Database, electronStash }
}

/**
 * Read-only snapshot of an appdata.db into `destFile` via `VACUUM INTO` —
 * synchronous, atomic, and valid even against an open-WAL source. Opens the
 * source READ-ONLY, applies NO pragmas and NO schema, and never checks or
 * writes `user_version`: VACUUM INTO reads the source and writes only the
 * destination, so the source store is never modified. That makes it safe to
 * snapshot a store whose `user_version` is NEWER than this build understands —
 * the downgrade guard's "never touch a newer store" promise is preserved, and
 * openAppData's throw-on-newer stays byte-identical. `user_version` and content
 * are carried into the snapshot unchanged. Used by the pre-reset backup.
 */
export function snapshotAppDataDb(dbPath: string, destFile: string): void {
  mkdirSync(dirname(destFile), { recursive: true })
  const { Database, electronStash } = loadBetterSqlite3()
  const db = openWithBinding(Database, dbPath, electronStash, { readonly: true, fileMustExist: true })
  try {
    db.prepare('VACUUM INTO ?').run(destFile)
  } finally {
    db.close()
  }
}

/**
 * Opens `dbPath` READ-ONLY and returns whether `PRAGMA integrity_check` is
 * 'ok'. Used to verify a pre-reset snapshot BEFORE any live data is cleared.
 * Read-only, applies no schema — safe on any store, any version.
 */
export function appDataIntegrityOk(dbPath: string): boolean {
  const { Database, electronStash } = loadBetterSqlite3()
  const db = openWithBinding(Database, dbPath, electronStash, { readonly: true, fileMustExist: true })
  try {
    return (db.pragma('integrity_check', { simple: true }) as string) === 'ok'
  } finally {
    db.close()
  }
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
  const { Database, electronStash } = loadBetterSqlite3()

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
  // v8: widen audit_log.outcome's CHECK to allow 'pending' on stores that predate
  // it (guarded + idempotent — a no-op on a fresh install). Non-additive, so it
  // cannot ride the CREATE-IF-NOT-EXISTS / guarded-ADD-COLUMN lists above.
  migrateAuditLogOutcomeCheck(db)
  // v10: widen tasks.status's CHECK to allow 'cancelled' (same non-additive,
  // guarded, idempotent in-place rebuild).
  migrateTasksStatusCheck(db)
  // v11: widen tasks.status's CHECK to allow 'paused' + add tasks.started_at
  // (same guarded/idempotent in-place rebuild — a CHECK cannot be ALTERed).
  migrateTasksV11(db)
  if (existingVersion < APPDATA_USER_VERSION) {
    // Every schema change is additive (CREATE IF NOT EXISTS tables + guarded ADD
    // COLUMNs above) EXCEPT the v8 audit_log CHECK widening (migrateAuditLogOutcomeCheck,
    // its own guarded/idempotent rebuild), so applying the full list upgrades any
    // older version in place (v1 → v2: workflow_checkpoint* tables, phase 04;
    // v2 → v3: mcp_calls.args_hash, phase 05; v3 → v4: approvals + audit_log +
    // injection_flags, phase 09; v4 → v5: tasks.priority +
    // tasks.waiting_approval_id, phase 11; v5 → v6: skill_settings +
    // skill_improvements, phase 12; v6 → v7: mcp_calls.session_kind +
    // runner_runs + runner_submissions, phase 14; v7 → v8: audit_log.outcome
    // 'pending' + lane_jobs — the crash-safety write-intent journal; v8 → v9:
    // local_llm_usage — the additive local-LLM usage ledger; v9 → v10:
    // tasks.status 'cancelled' — user task-cancel, migrateTasksStatusCheck;
    // v10 → v11: tasks.status 'paused' + tasks.started_at — user pause/resume
    // + the Resources "time it took" readout, migrateTasksV11; v11 → v12:
    // dedupe_scans — the background duplicate-scan result cache, additive).
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
