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
import { existsSync, mkdirSync, statSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import type {
  Connection as RyuConnection,
  Database as RyuDatabase,
  QueryResult as RyuQueryResult,
  RyuValue
} from 'ryugraph'
import { EMBEDDING_DIM } from '../config'
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
  graphDirHasData,
  MIGRATIONS,
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
    params[key] = value
    return `CAST($${key} AS FLOAT[${EMBEDDING_DIM}])`
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
  /** In-flight vector-index rebuilds, per label (searches await these). */
  private readonly vectorRebuilds = new Map<RetrievableLabel, Promise<void>>()
  /** Backup taken by this open (null when none was needed). */
  readonly backupCreated: string | null

  private constructor(
    db: RyuDatabase,
    writeConn: RyuConnection,
    readConn: RyuConnection,
    graphDir: string,
    backupCreated: string | null,
    laneJournalCapacity?: number
  ) {
    this.db = db
    this.writeConn = writeConn
    this.readConn = readConn
    this.graphDir = graphDir
    this.backupCreated = backupCreated
    this.lane = new WriteLane(laneJournalCapacity)
  }

  get schemaVersion(): number {
    return this.schemaVersionValue
  }

  /** Open (creating/migrating as needed). The only way to construct an engine. */
  static async open(options: RyuGraphEngineOptions): Promise<RyuGraphEngine> {
    const migrations = validateMigrations(options.migrations ?? MIGRATIONS)
    const latest = migrations.length > 0 ? (migrations[migrations.length - 1] as Migration).version : 0

    if (existsSync(options.graphDir) && !statSync(options.graphDir).isDirectory()) {
      throw new Error(
        `graph path ${options.graphDir} exists but is not a directory — it belongs to another tool or an older build; move it aside before starting`
      )
    }

    // §21 rule 9: back up BEFORE the db is opened/locked. The sidecar tells us
    // the version without opening; missing sidecar with data present → back up
    // defensively.
    const sidecarVersion = readSchemaSidecar(options.graphDir)
    let backupCreated: string | null = null
    if (graphDirHasData(options.graphDir) && (sidecarVersion === null || sidecarVersion < latest)) {
      backupCreated = backupGraphDir(options.graphDir, options.backupsDir, latest)
    }

    mkdirSync(options.graphDir, { recursive: true })
    const ryu = require('ryugraph') as RyuModule
    const db = new ryu.Database(join(options.graphDir, GRAPH_DB_FILENAME))
    const writeConn = new ryu.Connection(db)
    const readConn = new ryu.Connection(db)

    const engine = new RyuGraphEngine(
      db,
      writeConn,
      readConn,
      options.graphDir,
      backupCreated,
      options.laneJournalCapacity
    )
    await engine.loadExtensions(options.extensionsDir)
    await engine.migrate(migrations)
    return engine
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
    const current = await this.readSchemaVersionFromGraph()
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
      if (Array.isArray(value)) assertFiniteNumbersIfNumeric(value, key)
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
    const query = `CALL QUERY_VECTOR_INDEX('${label}', '${vectorIndexName(label)}', $q, $k) RETURN node.id AS id, distance ORDER BY distance, id`
    const params = { q: [...embedding], k }
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
    return this.lane.enqueue(`upsertNode:${label}`, () => this.upsertNodeInLane(label, id, props))
  }

  async createEdge(type: EdgeType, from: NodeRef, to: NodeRef, props?: EdgeProps): Promise<void> {
    this.assertOpen()
    this.validateEdge(type, from, to, props)
    return this.lane.enqueue(`createEdge:${type}`, () => this.createEdgeInLane(type, from, to, props))
  }

  async withWrite<T>(fn: (tx: WriteTx) => Promise<T>): Promise<T> {
    this.assertOpen()
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
        const expr = embedding === null ? 'NULL' : `CAST($e AS FLOAT[${EMBEDDING_DIM}])`
        const params: Record<string, unknown> = { id, __now: nowIso }
        if (embedding !== null) params['e'] = [...embedding]
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
    }
    const rebuild = doRebuild()
    this.vectorRebuilds.set(label, rebuild)
    try {
      await rebuild
    } finally {
      if (this.vectorRebuilds.get(label) === rebuild) this.vectorRebuilds.delete(label)
    }
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
}

function assertFiniteNumbersIfNumeric(values: readonly unknown[], key: string): void {
  for (const v of values) {
    if (typeof v === 'number' && !Number.isFinite(v)) {
      throw new Error(`cypher param $${key}: non-finite number in array`)
    }
  }
}

/** Open the embedded graph store (§5): backup-if-migrating, open, migrate. */
export async function openRyuGraphEngine(options: RyuGraphEngineOptions): Promise<RyuGraphEngine> {
  return RyuGraphEngine.open(options)
}
