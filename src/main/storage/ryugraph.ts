/**
 * RyuGraphEngine — the sole module that touches the `ryugraph` driver
 * (enforced by ESLint no-restricted-imports/syntax; everything else goes
 * through the StorageEngine interface).
 *
 * Empirical driver constraints this implementation encodes (phase-01 probes):
 * - Vendored vector/FTS extensions load by absolute path only; never INSTALL,
 *   never name-based LOAD (§21 rule 2, phase-00 finding 2).
 * - JS Date params bind as DATE (time truncated) → timestamps travel as
 *   ISO-8601 strings wrapped in `timestamp($p)`; raw Date params are rejected.
 * - Both HNSW and FTS indexes auto-maintain on INSERT and DELETE, and FTS on
 *   UPDATE too — but SET on an HNSW-indexed property is illegal ("Try delete
 *   and then insert"), even via MERGE ON CREATE. So: new nodes are created
 *   with inline property maps; embedding changes on existing nodes run the
 *   drop-index → SET → recreate-index dance inside their lane job.
 * - Index create/drop calls are legal only in auto-transaction mode, so
 *   withWrite provides lane exclusivity, not an explicit DB transaction.
 * - Database.close()/closeSync() poisons process teardown (native fault at
 *   exit). close({skipDatabaseClose: true}) checkpoints and closes only the
 *   connections — the app's quit path; durability via WAL replay is proven.
 * - `CAST($p AS ...)` is illegal as a CALL argument; bare `$p` binds fine.
 */
import { existsSync, mkdirSync, readdirSync, renameSync, statSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import type {
  Connection as RyuConnection,
  Database as RyuDatabase,
  QueryResult as RyuQueryResult,
  RyuValue
} from 'ryugraph'
import { EMBEDDING_DIM, GRAPH_CHECKPOINT_INTERVAL_MS } from '../config'
import type {
  CypherParams,
  EdgeProps,
  NodeProps,
  NodeRef,
  Row,
  StorageEngine,
  TextHit,
  UpsertResult,
  VectorHit,
  WriteTx
} from './engine'
import {
  ftsIndexName,
  isRetrievable,
  nodeTable,
  relTable,
  vectorIndexName,
  writableNodeProperties,
  writableRelProperties,
  type EdgeType,
  type NodeLabel,
  type PropertyType,
  type RetrievableLabel
} from './schema'
import {
  backupGraphDir,
  defaultMigrations,
  GraphSchemaNewerError,
  graphDirHasData,
  readSchemaSidecar,
  validateMigrations,
  writeSchemaSidecar,
  type Migration
} from './migrations'
import { WriteLane } from './writeLane'

const require = createRequire(import.meta.url)

const GRAPH_DB_FILENAME = 'graph.ryugraph'
const MAX_SEARCH_K = 1000

/** Statements the engine refuses in raw cypher — these belong to the engine. */
const DENIED_STATEMENT =
  /\b(install|begin|commit|rollback|checkpoint)\b|\bload\s+extension\b/i
/** Conservative mutation detector: false positives only serialize a read. */
const MUTATING_STATEMENT =
  /\b(create|merge|set|delete|detach|remove|drop|alter|copy|import|export)\b|\bcall\s+(create_|drop_)/i

/**
 * Shared classification for callers that must know whether a raw statement
 * mutates (the phase-09 audit log marks actions containing raw mutating
 * cypher as un-undoable — no generic inverse exists for arbitrary Cypher).
 * Same conservative regex the engine's auto-routing uses.
 */
export function isMutatingCypher(query: string): boolean {
  return MUTATING_STATEMENT.test(query)
}

/**
 * RyuGraph 25.9.1 replays `<graphDir>/graph.ryugraph.wal` on open. The app
 * deliberately leaks the Database handle at quit (closeSync() poisons native
 * teardown — see close()), so a hard kill or crash mid-write can leave a torn
 * WAL. The next open then throws with NO built-in recovery, which disables
 * storage and — through the boot cascade — the whole app. These two helpers let
 * open() detect that SPECIFIC failure and recover to the last checkpoint. Both
 * observed messages match: RyuGraph's "Corrupted wal file. Read out invalid WAL
 * record type." and "Checksum verification failed, the WAL file is corrupted."
 */
function isCorruptWalError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err)
  return /\bwal\b/i.test(message) && /(corrupt|invalid|malformed|checksum|truncat)/i.test(message)
}

/**
 * Lock contention on open: another process (or a still-quitting previous one)
 * holds the exclusive OS lock on `<graphDir>/graph.ryugraph`. Probe-verified on
 * win32 with ryugraph 25.9.1 (scratchpad two-process probe, this branch) — the
 * EXACT message openRyuGraphEngine surfaces is:
 *   "IO exception: Could not set lock on file : <path>\graph.ryugraph
 *    See the docs: https://docs.ryugraph.io/concurrency for more information."
 * Even a read-only second open fails this way (the lock is exclusive). Kept
 * DISTINCT from isCorruptWalError so the corrupt-WAL recovery inside open()
 * still wins for its own errors; this only gates the boot-time open RETRY
 * (openRyuGraphEngineWithLockRetry) — a schema-newer refusal, a missing
 * extension, or a corrupt main db must NEVER be masked by a lock retry.
 * `lock violation` is included as a defensive secondary anchor for any raw
 * ERROR_LOCK_VIOLATION phrasing the driver might surface on a future build.
 */
export function isLockContentionError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err)
  return /could not set lock on file/i.test(message) || /lock violation/i.test(message)
}

/**
 * Move every `graph.ryugraph.wal*` file out of the graph dir into
 * `<backupsDir>/<stamp>-corrupt-wal/` — preserved for forensics, NEVER deleted
 * (the same move-don't-destroy discipline as the pre-migration backups). A
 * rename within the userData volume is atomic and cheap. Returns the created
 * quarantine dir, or null when there was no WAL file to move (so open() knows
 * the corrupt-WAL diagnosis was wrong and re-throws the original error).
 */
function quarantineGraphWal(graphDir: string, backupsDir: string): string | null {
  let walFiles: string[]
  try {
    walFiles = readdirSync(graphDir).filter((name) => name.startsWith(`${GRAPH_DB_FILENAME}.wal`))
  } catch {
    return null
  }
  if (walFiles.length === 0) return null
  mkdirSync(backupsDir, { recursive: true })
  const stamp = new Date().toISOString().replaceAll(':', '-').replace(/\.\d+Z$/, 'Z')
  let dest = join(backupsDir, `${stamp}-corrupt-wal`)
  for (let n = 2; existsSync(dest); n++) dest = join(backupsDir, `${stamp}-corrupt-wal-${n}`)
  mkdirSync(dest, { recursive: true })
  for (const name of walFiles) renameSync(join(graphDir, name), join(dest, name))
  return dest
}

interface RyuModule {
  Database: typeof RyuDatabase
  Connection: typeof RyuConnection
  VERSION: string
}

export interface RyuGraphEngineOptions {
  /** Directory holding the RyuGraph database files (config appDataPaths().graphDir). */
  graphDir: string
  /** Directory receiving pre-migration backups (config appDataPaths().backupsDir). */
  backupsDir: string
  /**
   * Absolute path to the vendored extension root for the pinned version,
   * e.g. `<repo>/resources/extensions/v25.9.0`. Extensions are loaded from
   * here by absolute path — never fetched (§21 rule 2).
   */
  extensionsDir: string
  /** Migration registry override (tests); defaults to MIGRATIONS. */
  migrations?: readonly Migration[]
  /** Write-lane journal capacity override (tests). */
  laneJournalCapacity?: number
  /**
   * Periodic WAL→db checkpoint cadence in ms; defaults to
   * GRAPH_CHECKPOINT_INTERVAL_MS. 0 (or negative) disables the timer — used by
   * tests that don't want a background checkpoint, or to override the cadence.
   */
  checkpointIntervalMs?: number
}

/** RyuGraph's platform directory name for this process. */
export function ryuPlatformDir(): string {
  const os = { win32: 'win', darwin: 'osx', linux: 'linux' }[process.platform as string]
  const arch = { x64: 'amd64', arm64: 'arm64' }[process.arch as string]
  if (!os || !arch) throw new Error(`unsupported platform ${process.platform}/${process.arch}`)
  return `${os}_${arch}`
}

function extensionFilePath(extensionsDir: string, name: 'vector' | 'fts'): string {
  return join(extensionsDir, ryuPlatformDir(), name, `lib${name}.ryu_extension`)
}

function cypherStringLiteral(value: string): string {
  return `'${value.replaceAll('\\', '\\\\').replaceAll("'", "\\'")}'`
}

function isoTimestamp(value: unknown, context: string): string {
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) throw new Error(`${context}: invalid Date`)
    return value.toISOString()
  }
  if (typeof value === 'string') {
    if (Number.isNaN(Date.parse(value))) throw new Error(`${context}: unparseable timestamp string "${value}"`)
    return value
  }
  throw new Error(`${context}: expected Date or ISO-8601 string, got ${typeof value}`)
}

function assertFiniteNumbers(values: readonly number[], context: string): void {
  for (const v of values) {
    if (typeof v !== 'number' || !Number.isFinite(v)) {
      throw new Error(`${context}: embeddings must contain only finite numbers`)
    }
  }
}

/** Old embedding comes back float32; compare against float32-rounded new values. */
function embeddingEquals(oldEmb: readonly number[], newEmb: readonly number[]): boolean {
  if (oldEmb.length !== newEmb.length) return false
  for (let i = 0; i < oldEmb.length; i++) {
    if (oldEmb[i] !== Math.fround(newEmb[i] as number)) return false
  }
  return true
}

function validatePropValue(name: string, type: PropertyType, value: unknown, label: string): void {
  if (value === null) return
  switch (type) {
    case 'STRING':
      if (typeof value !== 'string') throw new Error(`${label}.${name}: expected string`)
      return
    case 'BOOLEAN':
      if (typeof value !== 'boolean') throw new Error(`${label}.${name}: expected boolean`)
      return
    case 'INT64':
      if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
        throw new Error(`${label}.${name}: expected safe integer`)
      }
      return
    case 'DOUBLE':
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        throw new Error(`${label}.${name}: expected finite number`)
      }
      return
    case 'TIMESTAMP':
      isoTimestamp(value, `${label}.${name}`)
      return
    case 'EMBEDDING':
      if (!Array.isArray(value)) throw new Error(`${label}.${name}: expected number[]`)
      if (value.length !== EMBEDDING_DIM) {
        throw new Error(`${label}.${name}: expected ${EMBEDDING_DIM} dims, got ${value.length}`)
      }
      assertFiniteNumbers(value as number[], `${label}.${name}`)
      return
  }
}

/**
 * Embeddings are NEVER bound as bare number[] parameters: ryugraph 25.9.1's
 * NAPI layer infers a JS array's list type from element[0] alone — a vector
 * whose first element is integral (0 is common) binds as LIST[INT64] and
 * every fractional element's float64 bits are reinterpreted as int64
 * (~4.6e18 garbage) before the CAST, silently corrupting the stored vector;
 * the corrupted magnitudes then overflow float32 cosine accumulation in a
 * CPU-dependent way (found on CI — the phase-13 report has the mechanism).
 * The lossless, parameter-speed fix: prepend a FRACTIONAL sentinel so
 * element[0] forces LIST[DOUBLE] (every element then binds losslessly) and
 * strip it in Cypher via list_slice (probe-verified against the poison
 * vector; Float64Array binds as a STRUCT and inline literals cost ~90 ms of
 * parse per search — both rejected).
 */
const EMBEDDING_PARAM_SENTINEL = 0.5
/**
 * Per-element half of the workaround. The binding converts each element by
 * its own kind (integral → INT64) and then bit-reinterprets it into the
 * list's inferred type, so inside a LIST[DOUBLE] a non-zero integral element
 * is destroyed (1 → 5e-324) while zeros survive by bit-identity. The nudge
 * `v·(1+2⁻²⁶)` makes such elements fractional at a relative error of
 * 1.5e-8 — BELOW HALF A FLOAT32 ULP, so the stored FLOAT[1024] value rounds
 * back to exactly `v`: provably lossless at column precision. (|v| ≥ 2²⁶
 * stays integral after the multiply; +0.4999999 is float32-invisible there.)
 */
function sanitizeVectorElements(value: readonly number[]): number[] {
  return value.map((v) => {
    if (v === 0 || !Number.isInteger(v)) return v
    const nudged = v * (1 + 2 ** -26)
    return Number.isInteger(nudged) ? v + 0.4999999 : nudged
  })
}
function embeddingParam(value: unknown, context: string): number[] {
  if (!Array.isArray(value)) throw new Error(`${context}: embedding must be a number[]`)
  for (const v of value) {
    if (typeof v !== 'number' || !Number.isFinite(v)) {
      throw new Error(`${context}: embedding elements must be finite numbers`)
    }
  }
  // The fractional sentinel pins the list's inferred type to DOUBLE (it is
  // taken from element[0] alone); sanitize protects the other elements.
  return [EMBEDDING_PARAM_SENTINEL, ...sanitizeVectorElements(value as number[])]
}
/** The Cypher expression recovering the real vector from a sentinel param. */
function embeddingParamExpr(key: string): string {
  // list_slice is 1-based and inclusive: elements 2..DIM+1 = the vector.
  return `CAST(list_slice($${key}, 2, ${EMBEDDING_DIM + 1}) AS FLOAT[${EMBEDDING_DIM}])`
}
/**
 * QUERY-side twin of embeddingParam: QUERY_VECTOR_INDEX arguments accept only
 * LITERAL/PARAMETER/PATTERN — no list_slice expression, so no sentinel.
 * Elements are sanitized the same lossless way; a zero first element (the
 * one case sanitize leaves integral) becomes 1e-8, a query-side-only
 * perturbation shifting cosine distances by ~1e-16. Nothing stored changes.
 */
function queryVectorParam(embedding: readonly number[]): number[] {
  const q = sanitizeVectorElements(embedding)
  if (q.length > 0 && q[0] === 0) q[0] = 1e-8
  return q
}

/**
 * Property-map / SET fragment builder. Returns the Cypher expression for a
 * validated property and appends its encoded parameter to `params`.
 */
function propExpression(
  name: string,
  type: PropertyType,
  value: unknown,
  params: Record<string, unknown>
): string {
  if (value === null) return 'NULL'
  const key = `p_${name}`
  if (type === 'TIMESTAMP') {
    params[key] = isoTimestamp(value, name)
    return `timestamp($${key})`
  }
  if (type === 'EMBEDDING') {
    // See embeddingParam: a bare number[] here corrupts the stored vector.
    params[key] = embeddingParam(value, `property "${name}"`)
    return embeddingParamExpr(key)
  }
  params[key] = value
  return `$${key}`
}

export class RyuGraphEngine implements StorageEngine {
  readonly lane: WriteLane
  private readonly db: RyuDatabase
  private readonly readConn: RyuConnection
  private readonly writeConn: RyuConnection
  private readonly graphDir: string
  private schemaVersionValue = 0
  private closed = false
  /** Periodic WAL→db checkpoint (started on open, cleared on close); unref'd. */
  private checkpointTimer: ReturnType<typeof setInterval> | null = null
  /** Set by any write; gates the periodic checkpoint so an idle app never flushes. */
  private dirtySinceCheckpoint = false
  /** Count of periodic checkpoints that actually ran (test observability). */
  private periodicCheckpointCount = 0
  /** In-flight vector-index rebuilds, per label (searches await these). */
  private readonly vectorRebuilds = new Map<RetrievableLabel, Promise<void>>()
  /** Backup taken by this open (null when none was needed). */
  readonly backupCreated: string | null
  /**
   * Quarantine dir for a corrupt WAL this open recovered from (null on a clean
   * open). Boot surfaces it as a loud WARN — the store reopened at its last
   * checkpoint, so writes since that checkpoint were lost.
   */
  readonly walQuarantined: string | null

  private constructor(
    db: RyuDatabase,
    writeConn: RyuConnection,
    readConn: RyuConnection,
    graphDir: string,
    backupCreated: string | null,
    walQuarantined: string | null,
    laneJournalCapacity?: number
  ) {
    this.db = db
    this.writeConn = writeConn
    this.readConn = readConn
    this.graphDir = graphDir
    this.backupCreated = backupCreated
    this.walQuarantined = walQuarantined
    this.lane = new WriteLane(laneJournalCapacity)
  }

  get schemaVersion(): number {
    return this.schemaVersionValue
  }

  /** Periodic checkpoints that have run since open (test observability). */
  get periodicCheckpoints(): number {
    return this.periodicCheckpointCount
  }

  /** Open (creating/migrating as needed). The only way to construct an engine. */
  static async open(options: RyuGraphEngineOptions): Promise<RyuGraphEngine> {
    // Default registry resolved at open time (defaultMigrations reads the
    // AGENTIC_OS_TEST_MIGRATION_V2 seam per open, never at module load).
    const migrations = validateMigrations(options.migrations ?? defaultMigrations())
    const latest = migrations.length > 0 ? (migrations[migrations.length - 1] as Migration).version : 0

    if (existsSync(options.graphDir) && !statSync(options.graphDir).isDirectory()) {
      throw new Error(
        `graph path ${options.graphDir} exists but is not a directory — it belongs to another tool or an older build; move it aside before starting`
      )
    }

    // §3 downgrade guard, layer 1 (sidecar): a store proclaiming a NEWER
    // schema than this registry means the app was rolled back — refuse before
    // the db is opened, before any backup, before any sidecar write (§21
    // rule 9: accumulated memory is never corrupted).
    const sidecarVersion = readSchemaSidecar(options.graphDir)
    if (sidecarVersion !== null && sidecarVersion > latest) {
      throw new GraphSchemaNewerError(options.graphDir, sidecarVersion, latest)
    }

    // §21 rule 9: back up BEFORE the db is opened/locked. The sidecar tells us
    // the version without opening; missing sidecar with data present → back up
    // defensively.
    let backupCreated: string | null = null
    if (graphDirHasData(options.graphDir) && (sidecarVersion === null || sidecarVersion < latest)) {
      backupCreated = backupGraphDir(options.graphDir, options.backupsDir, latest)
    }

    mkdirSync(options.graphDir, { recursive: true })

    try {
      return await RyuGraphEngine.build(options, migrations, backupCreated, null)
    } catch (err) {
      // §3 data-safety: a torn WAL from an unclean shutdown (the app leaks the
      // Database handle at quit — see close()) must not brick storage and, via
      // the boot cascade, the whole app. Quarantine the WAL (preserved, never
      // deleted) and retry the open ONCE — RyuGraph then recovers to the last
      // checkpoint. Only THIS specific failure recovers; a schema-newer refusal,
      // a lock, a missing extension, or a corrupt main db propagates untouched
      // (quarantineGraphWal returns null when there is no WAL, and the retry
      // re-throws when the WAL was not the real problem).
      if (!isCorruptWalError(err)) throw err
      let walQuarantined: string | null
      try {
        walQuarantined = quarantineGraphWal(options.graphDir, options.backupsDir)
      } catch (quarantineErr) {
        // A quarantine fs failure (AV lock, ENOSPC) must not mask the real
        // diagnosis: surface the corrupt-WAL error, not the rename error.
        console.warn('[storage] corrupt-WAL quarantine failed — surfacing the original open error', quarantineErr)
        throw err
      }
      if (walQuarantined === null) throw err
      // Logged HERE, not just on the engine: if the retry below also fails,
      // this launch's log is the only record that a WAL was moved aside.
      console.warn(`[storage] corrupt graph WAL quarantined to ${walQuarantined} — retrying the open at the last checkpoint`)
      return await RyuGraphEngine.build(options, migrations, backupCreated, walQuarantined)
    }
  }

  /**
   * Construct the db + connections and initialise (extensions + migrations).
   * Any failure closes whatever native handles were created before rethrowing:
   * the downgrade guard's layer 2 fires after the db is open, callers and test
   * teardown need the file locks released, and open()'s corrupt-WAL retry must
   * be able to MOVE the WAL out of the graph dir (Windows keeps it locked
   * otherwise). Nothing is written on the failing path, so closing suffices.
   */
  private static async build(
    options: RyuGraphEngineOptions,
    migrations: readonly Migration[],
    backupCreated: string | null,
    walQuarantined: string | null
  ): Promise<RyuGraphEngine> {
    const ryu = require('ryugraph') as RyuModule
    let db: RyuDatabase | undefined
    let writeConn: RyuConnection | undefined
    let readConn: RyuConnection | undefined
    try {
      db = new ryu.Database(join(options.graphDir, GRAPH_DB_FILENAME))
      writeConn = new ryu.Connection(db)
      readConn = new ryu.Connection(db)
      const engine = new RyuGraphEngine(
        db,
        writeConn,
        readConn,
        options.graphDir,
        backupCreated,
        walQuarantined,
        options.laneJournalCapacity
      )
      await engine.loadExtensions(options.extensionsDir)
      await engine.migrate(migrations)
      engine.startCheckpointTimer(options.checkpointIntervalMs ?? GRAPH_CHECKPOINT_INTERVAL_MS)
      return engine
    } catch (err) {
      try {
        readConn?.closeSync()
        writeConn?.closeSync()
        db?.closeSync()
      } catch {
        // Best-effort: the original error is the one that matters.
      }
      throw err
    }
  }

  // ── Bootstrap ──────────────────────────────────────────────────────────────

  private async loadExtensions(extensionsDir: string): Promise<void> {
    const load = async (conn: RyuConnection): Promise<void> => {
      for (const name of ['vector', 'fts'] as const) {
        const file = extensionFilePath(extensionsDir, name)
        if (!existsSync(file)) {
          throw new Error(
            `vendored RyuGraph ${name} extension missing at ${file} — extensions ship in the build and are never fetched at runtime (§21 rule 2)`
          )
        }
        try {
          await this.run(conn, `LOAD EXTENSION ${cypherStringLiteral(file.replaceAll('\\', '/'))}`)
        } catch (err) {
          if (!/already[ _-]?loaded/i.test(err instanceof Error ? err.message : String(err))) throw err
        }
      }
    }
    await load(this.writeConn)
    // Extension loading may be connection-scoped; make the read side whole.
    const loaded = await this.run(this.readConn, 'CALL SHOW_LOADED_EXTENSIONS() RETURN *')
    if (loaded.length < 2) await load(this.readConn)
  }

  private async migrate(migrations: readonly Migration[]): Promise<void> {
    const latest = migrations.length > 0 ? (migrations[migrations.length - 1] as Migration).version : 0
    const current = await this.readSchemaVersionFromGraph()
    // §3 downgrade guard, layer 2 (authoritative SchemaVersion nodes): the
    // sidecar can be lost or stale, so re-check against the graph itself —
    // BEFORE any migration write, and before the sidecar-repair below could
    // rewrite the sidecar to the newer number.
    if (current > latest) throw new GraphSchemaNewerError(this.graphDir, current, latest)
    const pending = migrations.filter((m) => m.version > current)
    let applied = current
    for (const m of pending) {
      await this.lane.enqueue(`migration:v${m.version}:${m.name}`, async () => {
        await m.up({ cypher: (q, p) => this.run(this.writeConn, q, p) })
        await this.run(
          this.writeConn,
          'MERGE (v:SchemaVersion {version: $v}) ON CREATE SET v.name = $name, v.applied_at = timestamp($now)',
          { v: m.version, name: m.name, now: new Date().toISOString() }
        )
      })
      applied = m.version
      writeSchemaSidecar(this.graphDir, applied)
    }
    this.schemaVersionValue = applied
    // Migration writes ride the lane above but never pass through the public
    // write methods, so mark the store dirty ourselves — otherwise an idle
    // post-migration session never flushes the boot burst and the config.ts
    // "loss bounded to one interval" promise would not hold for it.
    if (pending.length > 0) this.dirtySinceCheckpoint = true
    if (pending.length === 0 && readSchemaSidecar(this.graphDir) !== applied) {
      writeSchemaSidecar(this.graphDir, applied)
    }
  }

  private async readSchemaVersionFromGraph(): Promise<number> {
    try {
      const rows = await this.run(this.readConn, 'MATCH (v:SchemaVersion) RETURN max(v.version) AS v')
      const v = rows[0]?.['v']
      if (v === null || v === undefined) return 0
      return Number(v)
    } catch (err) {
      if (/does not exist/i.test(err instanceof Error ? err.message : String(err))) return 0
      throw err
    }
  }

  /**
   * Start the periodic WAL→db checkpoint. Dirty-gated (an idle app never
   * flushes) and lane-serialized (never races a write or a vector-index
   * rebuild; reads on readConn DO proceed concurrently — probe-verified safe on
   * 25.9.1: CHECKPOINT succeeds alongside in-flight reads, provided a
   * QueryResult is never held unmaterialized across it, which run() guarantees
   * by calling getAll() in the same microtask chain). unref'd so it can never
   * hold the process open, and cleared in close(). A failed checkpoint is
   * non-fatal — WAL replay still recovers on the next open — so it re-marks
   * dirty and retries on the next tick. This keeps the WAL small so a hard kill
   * loses at most one interval of writes, and reduces the torn-WAL exposure the
   * open-time recovery guards against.
   */
  private startCheckpointTimer(intervalMs: number): void {
    if (!Number.isFinite(intervalMs) || intervalMs <= 0) return
    this.checkpointTimer = setInterval(() => {
      if (this.closed || !this.dirtySinceCheckpoint) return
      this.dirtySinceCheckpoint = false
      void this.lane
        .enqueue('checkpoint:periodic', () => this.run(this.writeConn, 'CHECKPOINT'))
        .then(() => {
          this.periodicCheckpointCount += 1
        })
        .catch((err) => {
          this.dirtySinceCheckpoint = true // retry next tick rather than drop the flush
          console.warn('[storage] periodic checkpoint failed (will retry next tick)', err)
        })
    }, intervalMs)
    this.checkpointTimer.unref()
  }

  // ── Query plumbing ─────────────────────────────────────────────────────────

  private encodeParams(params: CypherParams): Record<string, unknown> {
    const encoded: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(params)) {
      if (value instanceof Date) {
        throw new Error(
          `cypher param $${key}: raw Date params bind as DATE and silently drop the time — pass value.toISOString() and wrap the param as timestamp($${key})`
        )
      }
      if (typeof value === 'number' && !Number.isFinite(value)) {
        throw new Error(`cypher param $${key}: non-finite number`)
      }
      if (Array.isArray(value)) {
        assertFiniteNumbersIfNumeric(value, key)
        // ryugraph 25.9.1 NAPI defect (see embeddingParam): the list type is
        // inferred from element[0], each element converts by its own kind,
        // and mismatches are bit-reinterpreted — an INT64-typed list mangles
        // fractional elements, a DOUBLE-typed list mangles non-zero integral
        // ones (zeros survive by bit-identity). All-integral lists and
        // fractional-with-zeros lists bind losslessly; the poison mixes are
        // refused rather than silently corrupted.
        const first = value[0]
        if (typeof first === 'number') {
          const poisoned = Number.isInteger(first)
            ? value.some((v) => typeof v === 'number' && !Number.isInteger(v))
            : value.some((v) => typeof v === 'number' && v !== 0 && Number.isInteger(v))
          if (poisoned) {
            throw new Error(
              `cypher param $${key}: numeric list mixing integral and fractional elements would be silently corrupted by the ryugraph 25.9.1 binding (type inferred from element[0], mismatched elements bit-reinterpreted) — use the engine's upsertNode/vectorSearch for embeddings, or keep list elements the same numeric kind (zeros are safe)`
            )
          }
        }
      }
      encoded[key] = value === undefined ? null : value
    }
    return encoded
  }

  private async run(conn: RyuConnection, query: string, params?: CypherParams): Promise<Row[]> {
    let results: RyuQueryResult | RyuQueryResult[]
    if (params && Object.keys(params).length > 0) {
      const prepared = await conn.prepare(query)
      if (!prepared.isSuccess()) throw new Error(prepared.getErrorMessage())
      // Values are runtime-validated (encodeParams/validatePropValue).
      results = await conn.execute(prepared, this.encodeParams(params) as Record<string, RyuValue>)
    } else {
      results = await conn.query(query)
    }
    const list = Array.isArray(results) ? results : [results]
    const rows: Row[] = []
    for (const result of list) rows.push(...((await result.getAll()) as Row[]))
    return rows
  }

  private assertOpen(): void {
    if (this.closed) throw new Error('storage engine is closed')
  }

  private assertAllowed(query: string): void {
    const denied = DENIED_STATEMENT.exec(query)
    if (denied) {
      throw new Error(
        `statement contains "${denied[0]}" which is engine-managed — transactions, checkpoints and extension loading are not available through cypher()`
      )
    }
  }

  // ── StorageEngine: reads ───────────────────────────────────────────────────

  async cypher(query: string, params?: CypherParams): Promise<Row[]> {
    this.assertOpen()
    this.assertAllowed(query)
    if (MUTATING_STATEMENT.test(query)) {
      // §21 rule 1: mutations ride the lane, whoever wrote the query.
      this.dirtySinceCheckpoint = true
      return this.lane.enqueue('cypher', () => this.run(this.writeConn, query, params))
    }
    return this.run(this.readConn, query, params)
  }

  async vectorSearch(label: RetrievableLabel, embedding: readonly number[], k: number): Promise<VectorHit[]> {
    this.assertOpen()
    this.validateSearchArgs(label, k)
    if (embedding.length !== EMBEDDING_DIM) {
      throw new Error(`vectorSearch(${label}): expected ${EMBEDDING_DIM}-dim embedding, got ${embedding.length}`)
    }
    assertFiniteNumbers(embedding, `vectorSearch(${label})`)
    // Query vector sanitized against the NAPI list mangle (queryVectorParam).
    const query = `CALL QUERY_VECTOR_INDEX('${label}', '${vectorIndexName(label)}', $q, $k) RETURN node.id AS id, distance ORDER BY distance, id`
    const params = { q: queryVectorParam(embedding), k }
    let rows: Row[]
    try {
      rows = await this.run(this.readConn, query, params)
    } catch (err) {
      // An embedding update may be mid drop→set→recreate; wait it out once.
      const inflight = this.vectorRebuilds.get(label)
      if (!inflight || !/does not exist|not found/i.test(err instanceof Error ? err.message : String(err))) {
        throw err
      }
      await inflight.catch(() => undefined)
      rows = await this.run(this.readConn, query, params)
    }
    return rows.map((r) => ({ id: String(r['id']), distance: Number(r['distance']) }))
  }

  async textSearch(label: RetrievableLabel, query: string, k: number): Promise<TextHit[]> {
    this.assertOpen()
    this.validateSearchArgs(label, k)
    if (query.trim() === '') return []
    const stmt = `CALL QUERY_FTS_INDEX('${label}', '${ftsIndexName(label)}', $needle) RETURN node.id AS id, score ORDER BY score DESC, id LIMIT ${k}`
    const rows = await this.run(this.readConn, stmt, { needle: query })
    return rows.map((r) => ({ id: String(r['id']), score: Number(r['score']) }))
  }

  private validateSearchArgs(label: RetrievableLabel, k: number): void {
    if (!isRetrievable(label)) {
      throw new Error(`search: ${String(label)} is not a retrievable label`)
    }
    if (!Number.isSafeInteger(k) || k < 1 || k > MAX_SEARCH_K) {
      throw new Error(`search: k must be an integer in [1, ${MAX_SEARCH_K}], got ${k}`)
    }
  }

  // ── StorageEngine: writes (lane-serialized) ────────────────────────────────

  async upsertNode(label: NodeLabel, props: NodeProps): Promise<UpsertResult> {
    this.assertOpen()
    const id = this.validateNodeProps(label, props)
    this.dirtySinceCheckpoint = true
    return this.lane.enqueue(`upsertNode:${label}`, () => this.upsertNodeInLane(label, id, props))
  }

  async createEdge(type: EdgeType, from: NodeRef, to: NodeRef, props?: EdgeProps): Promise<void> {
    this.assertOpen()
    this.validateEdge(type, from, to, props)
    this.dirtySinceCheckpoint = true
    return this.lane.enqueue(`createEdge:${type}`, () => this.createEdgeInLane(type, from, to, props))
  }

  async deleteNode(label: NodeLabel, id: string): Promise<void> {
    this.assertOpen()
    this.validateDeleteNode(label, id)
    this.dirtySinceCheckpoint = true
    return this.lane.enqueue(`deleteNode:${label}`, () => this.deleteNodeInLane(label, id))
  }

  async deleteEdge(type: EdgeType, from: NodeRef, to: NodeRef): Promise<void> {
    this.assertOpen()
    this.validateEdge(type, from, to)
    this.dirtySinceCheckpoint = true
    return this.lane.enqueue(`deleteEdge:${type}`, () => this.deleteEdgeInLane(type, from, to))
  }

  async withWrite<T>(fn: (tx: WriteTx) => Promise<T>): Promise<T> {
    this.assertOpen()
    this.dirtySinceCheckpoint = true
    const tx: WriteTx = {
      cypher: (query, params) => {
        this.assertAllowed(query)
        return this.run(this.writeConn, query, params)
      },
      upsertNode: (label, props) => {
        const id = this.validateNodeProps(label, props)
        return this.upsertNodeInLane(label, id, props)
      },
      createEdge: (type, from, to, props) => {
        this.validateEdge(type, from, to, props)
        return this.createEdgeInLane(type, from, to, props)
      },
      deleteNode: (label, id) => {
        this.validateDeleteNode(label, id)
        return this.deleteNodeInLane(label, id)
      },
      deleteEdge: (type, from, to) => {
        this.validateEdge(type, from, to)
        return this.deleteEdgeInLane(type, from, to)
      }
    }
    return this.lane.enqueue('withWrite', () => fn(tx))
  }

  async checkpoint(): Promise<void> {
    this.assertOpen()
    await this.lane.enqueue('checkpoint', () => this.run(this.writeConn, 'CHECKPOINT'))
  }

  async close(options?: { skipDatabaseClose?: boolean }): Promise<void> {
    if (this.closed) return
    this.closed = true
    if (this.checkpointTimer !== null) {
      clearInterval(this.checkpointTimer)
      this.checkpointTimer = null
    }
    await this.lane.onIdle()
    try {
      await this.run(this.writeConn, 'CHECKPOINT')
    } catch {
      // Best-effort: WAL replay recovers anything not checkpointed.
    }
    this.readConn.closeSync()
    this.writeConn.closeSync()
    // ryugraph 25.9.1: Database.close* completes fine but poisons native
    // teardown at process exit (segfault). The Electron quit path skips it —
    // the checkpoint above makes the on-disk state clean, and leaking the
    // handle into process exit is the proven-clean path. Tests do close fully.
    if (!options?.skipDatabaseClose) this.db.closeSync()
  }

  // ── Write internals (must already hold the lane) ───────────────────────────

  private validateNodeProps(label: NodeLabel, props: NodeProps): string {
    const writable = writableNodeProperties(label) // throws on unknown label
    const id = props['id']
    if (typeof id !== 'string' || id.length === 0) {
      throw new Error(`upsertNode(${label}): props.id must be a non-empty string`)
    }
    for (const [name, value] of Object.entries(props)) {
      if (name === 'id') continue
      const type = writable.get(name)
      if (!type) {
        throw new Error(
          `upsertNode(${label}): "${name}" is not a writable property (schema §18; created_at/updated_at are engine-stamped)`
        )
      }
      if (value !== undefined) validatePropValue(name, type, value, label)
    }
    return id
  }

  private async upsertNodeInLane(label: NodeLabel, id: string, props: NodeProps): Promise<UpsertResult> {
    const writable = writableNodeProperties(label)
    const retrievable = isRetrievable(label)
    const nowIso = new Date().toISOString()

    const existing = await this.run(
      this.writeConn,
      retrievable
        ? `MATCH (n:${label} {id: $id}) RETURN n.embedding AS embedding`
        : `MATCH (n:${label} {id: $id}) RETURN 1 AS one`,
      { id }
    )

    const provided = Object.entries(props).filter(([name, value]) => name !== 'id' && value !== undefined)

    if (existing.length === 0) {
      // New node: single CREATE with inline properties (MERGE+SET is illegal on
      // HNSW-indexed properties even on the create branch). Null-valued props
      // are omitted — unset columns are NULL (or their DDL default) anyway.
      const params: Record<string, unknown> = { id, __now: nowIso }
      const fragments = ['id: $id', 'created_at: timestamp($__now)', 'updated_at: timestamp($__now)']
      for (const [name, value] of provided) {
        if (value === null) continue
        fragments.push(`${name}: ${propExpression(name, writable.get(name) as PropertyType, value, params)}`)
      }
      await this.run(this.writeConn, `CREATE (:${label} {${fragments.join(', ')}})`, params)
      return { id, created: true, embeddingRebuilt: false }
    }

    // Existing node: SET scalars; embedding changes need the index dance.
    const scalar = provided.filter(([name]) => name !== 'embedding')
    const params: Record<string, unknown> = { id, __now: nowIso }
    const sets = ['n.updated_at = timestamp($__now)']
    for (const [name, value] of scalar) {
      sets.push(`n.${name} = ${propExpression(name, writable.get(name) as PropertyType, value, params)}`)
    }
    await this.run(this.writeConn, `MATCH (n:${label} {id: $id}) SET ${sets.join(', ')}`, params)

    let embeddingRebuilt = false
    const embeddingEntry = provided.find(([name]) => name === 'embedding')
    if (embeddingEntry && retrievable) {
      const newEmbedding = embeddingEntry[1] as number[] | null
      const oldEmbedding = (existing[0]?.['embedding'] as number[] | null | undefined) ?? null
      const changed =
        newEmbedding === null
          ? oldEmbedding !== null
          : oldEmbedding === null || !embeddingEquals(oldEmbedding, newEmbedding)
      if (changed) {
        embeddingRebuilt = true
        await this.rebuildEmbedding(label as RetrievableLabel, id, newEmbedding, nowIso)
      }
    }
    return { id, created: false, embeddingRebuilt }
  }

  /**
   * SET on an HNSW-indexed property is forbidden, so: drop the label's vector
   * index, SET the embedding, recreate the index. Runs inside the caller's
   * lane job; concurrent vectorSearch calls await `vectorRebuilds`.
   */
  private async rebuildEmbedding(
    label: RetrievableLabel,
    id: string,
    embedding: readonly number[] | null,
    nowIso: string
  ): Promise<void> {
    const doRebuild = async (): Promise<void> => {
      await this.run(this.writeConn, `CALL DROP_VECTOR_INDEX('${label}', '${vectorIndexName(label)}')`)
      try {
        // Sentinel param — see embeddingParam (a bare number[] corrupts).
        const expr = embedding === null ? 'NULL' : embeddingParamExpr('e')
        const params: Record<string, unknown> = { id, __now: nowIso }
        if (embedding !== null) params['e'] = embeddingParam([...embedding], `rebuildEmbedding(${label})`)
        await this.run(
          this.writeConn,
          `MATCH (n:${label} {id: $id}) SET n.embedding = ${expr}, n.updated_at = timestamp($__now)`,
          params
        )
      } finally {
        // Always restore the index, even if the SET failed.
        await this.run(
          this.writeConn,
          `CALL CREATE_VECTOR_INDEX('${label}', '${vectorIndexName(label)}', 'embedding')`
        )
      }
      // Phase-13 hardening: on some hardware RyuGraph 25.9.1's vector
      // extension serves a just-re-embedded vector as zeros — the exact-match
      // query returns the right node at distance EXACTLY 1 (found on CI
      // runners; environment-conditional upstream defect, unreproducible on
      // dev machines — see the phase-13 report). Verify the index actually
      // serves the new embedding; heal once (CHECKPOINT flushes the WAL so
      // the recreate reads on-disk state, then rebuild the index fresh); a
      // second miss fails the caller's lane job LOUDLY — a silently broken
      // index would degrade every retrieval until the next rebuild (§21).
      if (embedding !== null) {
        if (await this.indexServes(label, id, embedding)) return
        await this.run(this.writeConn, 'CHECKPOINT')
        await this.run(this.writeConn, `CALL DROP_VECTOR_INDEX('${label}', '${vectorIndexName(label)}')`)
        await this.run(
          this.writeConn,
          `CALL CREATE_VECTOR_INDEX('${label}', '${vectorIndexName(label)}', 'embedding')`
        )
        if (await this.indexServes(label, id, embedding)) {
          console.warn(
            `[storage] vector index for ${label} healed after a checkpoint+rebuild — ryugraph 25.9.1 re-embed defect (see phase-13 report)`
          )
          return
        }
        throw new Error(
          `rebuildEmbedding(${label}, ${id}): the vector index does not serve the updated embedding even after a checkpoint+rebuild — ryugraph 25.9.1 vector-extension defect on this environment; refusing to leave a silently broken index`
        )
      }
    }
    const rebuild = doRebuild()
    this.vectorRebuilds.set(label, rebuild)
    try {
      await rebuild
    } finally {
      if (this.vectorRebuilds.get(label) === rebuild) this.vectorRebuilds.delete(label)
    }
  }

  /** True when an exact-match query serves this node at float32 tolerance. */
  private async indexServes(label: RetrievableLabel, id: string, embedding: readonly number[]): Promise<boolean> {
    const rows = await this.run(
      this.writeConn,
      `CALL QUERY_VECTOR_INDEX('${label}', '${vectorIndexName(label)}', $q, $k) RETURN node.id AS id, distance ORDER BY distance, id`,
      { q: queryVectorParam(embedding), k: 4 }
    )
    return rows.some((r) => String(r['id']) === id && Number(r['distance']) < 0.001)
  }

  private validateEdge(type: EdgeType, from: NodeRef, to: NodeRef, props?: EdgeProps): void {
    const spec = relTable(type) // throws on unknown type
    const pairOk = spec.pairs.some(([f, t]) => f === from.label && t === to.label)
    if (!pairOk) {
      throw new Error(
        `createEdge(${type}): (${from.label})-[:${type}]->(${to.label}) is not in the §18 schema — allowed: ${spec.pairs
          .map(([f, t]) => `${f}→${t}`)
          .join(', ')}`
      )
    }
    if (typeof from.id !== 'string' || from.id.length === 0 || typeof to.id !== 'string' || to.id.length === 0) {
      throw new Error(`createEdge(${type}): endpoint ids must be non-empty strings`)
    }
    if (props) {
      const writable = writableRelProperties()
      for (const [name, value] of Object.entries(props)) {
        const propType = writable.get(name)
        if (!propType) throw new Error(`createEdge(${type}): "${name}" is not a writable edge property`)
        if (value !== undefined && value !== null) validatePropValue(name, propType, value, type)
      }
    }
  }

  private async createEdgeInLane(type: EdgeType, from: NodeRef, to: NodeRef, props?: EdgeProps): Promise<void> {
    const nowIso = new Date().toISOString()
    const params: Record<string, unknown> = { from: from.id, to: to.id, __now: nowIso }
    const propSets: string[] = []
    if (props) {
      const writable = writableRelProperties()
      for (const [name, value] of Object.entries(props)) {
        if (value === undefined) continue
        propSets.push(`r.${name} = ${propExpression(name, writable.get(name) as PropertyType, value, params)}`)
      }
    }
    const onCreate = ['r.created_at = timestamp($__now)', 'r.updated_at = timestamp($__now)', ...propSets]
    const onMatch = ['r.updated_at = timestamp($__now)', ...propSets]
    const rows = await this.run(
      this.writeConn,
      `MATCH (a:${from.label} {id: $from}), (b:${to.label} {id: $to})
       MERGE (a)-[r:${type}]->(b)
       ON CREATE SET ${onCreate.join(', ')}
       ON MATCH SET ${onMatch.join(', ')}
       RETURN count(r) AS c`,
      params
    )
    if (Number(rows[0]?.['c'] ?? 0) === 0) {
      throw new Error(
        `createEdge(${type}): endpoint(s) missing — ${from.label}:${from.id} → ${to.label}:${to.id}`
      )
    }
  }

  private validateDeleteNode(label: NodeLabel, id: string): void {
    nodeTable(label) // throws on unknown label (guards the interpolated :${label})
    if (typeof id !== 'string' || id.length === 0) {
      throw new Error(`deleteNode(${label}): id must be a non-empty string`)
    }
  }

  private async deleteNodeInLane(label: NodeLabel, id: string): Promise<void> {
    // DETACH DELETE removes the node AND every incident edge in one statement;
    // the HNSW/FTS indexes auto-maintain on DELETE (unlike SET — see class
    // header), so no drop→delete→recreate dance is needed for the delete itself.
    await this.run(this.writeConn, `MATCH (n:${label} {id: $id}) DETACH DELETE n`, { id })
    // ryugraph 25.9.1 caveat: once a vector index is EMPTIED by deletes it enters
    // a degenerate state — a subsequent insert into it is never served by
    // QUERY_VECTOR_INDEX (the query returns no rows at all; probe-verified on this
    // branch, the same vector-extension fragility the phase-13 report hardened
    // `rebuildEmbedding` against). A DROP+CREATE returns the label to a clean,
    // queryable index, so a later insert — e.g. an audit undo restoring the
    // deleted node, or a re-ingest — is served again. Non-empty deletes maintain
    // correctly, so this fires at most once per label (the delete that empties
    // it), keeping bulk cascades cheap.
    if (isRetrievable(label)) {
      const rows = await this.run(this.writeConn, `MATCH (n:${label}) RETURN count(n) AS c`)
      if (Number(rows[0]?.['c'] ?? 0) === 0) await this.rebuildEmptiedVectorIndex(label as RetrievableLabel)
    }
  }

  /**
   * Rebuild a just-emptied retrievable label's vector index (DROP + CREATE from
   * the — now zero — surviving rows). Registered in `vectorRebuilds` so a
   * concurrent vectorSearch awaits it, exactly as rebuildEmbedding does.
   */
  private async rebuildEmptiedVectorIndex(label: RetrievableLabel): Promise<void> {
    const rebuild = (async (): Promise<void> => {
      await this.run(this.writeConn, `CALL DROP_VECTOR_INDEX('${label}', '${vectorIndexName(label)}')`)
      await this.run(this.writeConn, `CALL CREATE_VECTOR_INDEX('${label}', '${vectorIndexName(label)}', 'embedding')`)
    })()
    this.vectorRebuilds.set(label, rebuild)
    try {
      await rebuild
    } finally {
      if (this.vectorRebuilds.get(label) === rebuild) this.vectorRebuilds.delete(label)
    }
  }

  private async deleteEdgeInLane(type: EdgeType, from: NodeRef, to: NodeRef): Promise<void> {
    await this.run(
      this.writeConn,
      `MATCH (a:${from.label} {id: $from})-[r:${type}]->(b:${to.label} {id: $to}) DELETE r`,
      { from: from.id, to: to.id }
    )
  }
}

function assertFiniteNumbersIfNumeric(values: readonly unknown[], key: string): void {
  for (const v of values) {
    if (typeof v === 'number' && !Number.isFinite(v)) {
      throw new Error(`cypher param $${key}: non-finite number in array`)
    }
  }
}

/** Open the embedded graph store (§5): downgrade guard (§3) → backup-if-migrating → open → migrate. */
export async function openRyuGraphEngine(options: RyuGraphEngineOptions): Promise<RyuGraphEngine> {
  return RyuGraphEngine.open(options)
}
