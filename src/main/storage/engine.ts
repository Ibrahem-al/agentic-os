/**
 * StorageEngine — the thin storage-abstraction layer of spec §5.
 *
 * Everything outside src/main/storage/ talks to the graph exclusively through
 * this interface; only ryugraph.ts touches the driver, so the engine stays
 * swappable (SQLite longevity fallback, Vela contention fallback).
 *
 * Write policy (§21 rule 1): every mutation flows through the single write
 * lane. `upsertNode` / `createEdge` enqueue themselves; `cypher()` detects
 * mutating statements and auto-routes them through the lane; `withWrite`
 * reserves the lane for a multi-statement job and hands the caller a WriteTx
 * whose operations run inside that reservation. Reads are direct.
 *
 * `withWrite` provides lane exclusivity (no interleaved writers), NOT a
 * multi-statement database transaction: each statement auto-commits, because
 * index maintenance calls (CREATE/DROP_VECTOR_INDEX during embedding updates)
 * are only legal in auto-transaction mode. Explicit BEGIN/COMMIT/ROLLBACK are
 * therefore rejected in cypher().
 */
import type { EdgeType, NodeLabel, RetrievableLabel } from './schema'
import type { WriteLane } from './writeLane'

/** A result row: column name → engine-decoded value (timestamps as Date). */
export type Row = Record<string, unknown>

/** Parameter bag for cypher(); values are encoded by the engine. */
export type CypherParams = Record<string, unknown>

export interface NodeRef {
  readonly label: NodeLabel
  readonly id: string
}

/**
 * Properties accepted by upsertNode: the label's §18 domain properties, plus
 * `extracted_by`/`confidence` on extraction-written labels, plus `embedding`
 * (number[] of EMBEDDING_DIM) on retrievable labels. TIMESTAMP columns accept
 * Date or ISO-8601 string. `created_at`/`updated_at` are engine-stamped and
 * must not be supplied.
 */
export type NodeProps = Record<string, unknown>

export interface UpsertResult {
  readonly id: string
  /** True when the node was created, false when an existing node was updated. */
  readonly created: boolean
  /** True when an embedding change forced a vector-index rebuild. */
  readonly embeddingRebuilt: boolean
}

export interface EdgeProps {
  /** Extraction provenance (§21 rule 4); stamped verbatim on the edge. */
  readonly extracted_by?: string
  readonly confidence?: number
}

export interface VectorHit {
  readonly id: string
  /** Cosine distance (index metric default) — smaller is closer. */
  readonly distance: number
}

export interface TextHit {
  readonly id: string
  /** FTS relevance score — larger is better. */
  readonly score: number
}

/** Mutation surface handed to a withWrite job; runs inside the lane reservation. */
export interface WriteTx {
  cypher(query: string, params?: CypherParams): Promise<Row[]>
  upsertNode(label: NodeLabel, props: NodeProps): Promise<UpsertResult>
  createEdge(type: EdgeType, from: NodeRef, to: NodeRef, props?: EdgeProps): Promise<void>
}

export interface StorageEngine {
  /**
   * Run a Cypher statement. Read-only statements execute immediately on the
   * read connection; mutating statements are auto-routed through the write
   * lane. BEGIN/COMMIT/ROLLBACK/CHECKPOINT and INSTALL/LOAD EXTENSION are
   * rejected — transaction boundaries and extension loading belong to the
   * engine.
   */
  cypher(query: string, params?: CypherParams): Promise<Row[]>

  /**
   * Create-or-update a node by id (lane-serialized). Creation stamps
   * created_at+updated_at; update re-stamps updated_at and only touches the
   * supplied properties. Changing a retrievable node's embedding triggers the
   * drop→set→recreate vector-index dance (HNSW-indexed properties cannot be
   * SET in place).
   */
  upsertNode(label: NodeLabel, props: NodeProps): Promise<UpsertResult>

  /**
   * Idempotently create an edge (lane-serialized): MERGE on (from, to, type),
   * stamping created_at/updated_at and any provenance props. Throws if the
   * (type, from.label, to.label) pair is not in the §18 schema or either
   * endpoint node does not exist.
   */
  createEdge(type: EdgeType, from: NodeRef, to: NodeRef, props?: EdgeProps): Promise<void>

  /** k-nearest-neighbor search over a retrievable label's HNSW index (direct read). */
  vectorSearch(label: RetrievableLabel, embedding: readonly number[], k: number): Promise<VectorHit[]>

  /** Keyword search over a retrievable label's FTS index (direct read). */
  textSearch(label: RetrievableLabel, query: string, k: number): Promise<TextHit[]>

  /** Reserve the write lane for a multi-statement mutation job. */
  withWrite<T>(fn: (tx: WriteTx) => Promise<T>): Promise<T>

  /** Force a storage checkpoint (WAL compaction); lane-serialized. */
  checkpoint(): Promise<void>

  /**
   * Close connections (and by default the database handle). The app's quit
   * path uses { skipDatabaseClose: true } after checkpoint(): ryugraph 25.9.1
   * has a native teardown fault after Database.close() that would turn a clean
   * Electron exit into a crash; leaking the handle at process exit is safe
   * (WAL replay proven) and exits cleanly. Tests use the full close.
   */
  close(options?: { skipDatabaseClose?: boolean }): Promise<void>

  /** Applied schema version (max migration version; 0 = empty). */
  readonly schemaVersion: number

  /** The single write lane (exposed for ordering assertions + telemetry). */
  readonly lane: WriteLane
}
