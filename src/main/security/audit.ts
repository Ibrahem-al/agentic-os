/**
 * Audit + undo log (§13, phase 09) — every committed agent action logs a
 * REVERSIBLE DELTA, and `undo(actionId)` applies it:
 *
 *  - graph writes: `graphWrite()` wraps the single write lane with a
 *    recording WriteTx — for each structured op it captures the inverse
 *    (created node → DETACH DELETE; updated node → pre-image of the touched
 *    properties; created edge → DELETE) BEFORE executing it. Raw *mutating*
 *    cypher inside an audited job has no generic inverse, so the whole action
 *    is flagged un-undoable (§13 "irreversible kinds flagged"), never guessed.
 *  - file ops: `fileWrite()`/`fileDelete()` copy the pre-image into
 *    `backups/audit/<actionId>/` first; undo restores it (or removes the file
 *    the action created).
 *  - kernel events: implements the phase-04 AuditHook seam — every mediated
 *    action lands as a durable `kind='action'` row (an observation, not a
 *    state change; reversible = 0 by definition).
 *
 * Undo is per-action, most-recent-first: inverse ops apply in reverse order
 * inside ONE write-lane job (§21 rule 1). Undoing an old action under newer
 * dependent writes is the operator's call — the dashboard shows the trail.
 * The undo itself is audited (kind 'undo', un-undoable in v1 — no redo).
 */
import { randomUUID } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type BetterSqlite3 from 'better-sqlite3'
import {
  EDGE_TYPES,
  NODE_LABELS,
  REL_TABLES,
  isMutatingCypher,
  writableNodeProperties,
  type EdgeProps,
  type EdgeType,
  type NodeLabel,
  type NodeProps,
  type NodeRef,
  type StorageEngine,
  type WriteTx
} from '../storage'
import type { AuditEvent, AuditHook } from '../kernel'

export type UndoErrorCode = 'NOT_FOUND' | 'IRREVERSIBLE' | 'ALREADY_UNDONE' | 'UNDO_FAILED'

export class UndoError extends Error {
  readonly code: UndoErrorCode

  constructor(code: UndoErrorCode, message: string) {
    super(message)
    this.name = 'UndoError'
    this.code = code
  }
}

/** One recorded inverse mutation; applied via the write lane on undo. */
export type GraphInverseOp =
  | { readonly op: 'delete-node'; readonly label: NodeLabel; readonly id: string }
  | {
      readonly op: 'restore-props'
      readonly label: NodeLabel
      readonly id: string
      /** Touched properties at their pre-write values (null = was unset). */
      readonly props: Readonly<Record<string, unknown>>
    }
  | { readonly op: 'delete-edge'; readonly type: EdgeType; readonly from: NodeRef; readonly to: NodeRef }
  | {
      readonly op: 'restore-node'
      readonly label: NodeLabel
      /**
       * Full node pre-image: id + every set writable property (embedding
       * included). Re-created via upsertNode on undo; created_at/updated_at are
       * re-stamped (engine-owned), exactly as restore-props already restamps.
       */
      readonly props: Readonly<Record<string, unknown>>
    }
  | {
      readonly op: 'restore-edge'
      readonly type: EdgeType
      readonly from: NodeRef
      readonly to: NodeRef
      /** Edge props at delete time (extracted_by/confidence); omitted when unset. */
      readonly props?: Readonly<EdgeProps>
    }

export interface AuditActionRow {
  readonly id: string
  readonly agentId: string
  readonly kind: 'action' | 'graph-write' | 'file-write' | 'file-delete' | 'undo'
  readonly description: string
  readonly reversible: boolean
  readonly outcome: 'ok' | 'error'
  readonly error: string | null
  readonly details: Record<string, unknown>
  readonly undoneAt: string | null
  readonly undoActionId: string | null
  readonly createdAt: string
}

export interface AuditLogDeps {
  readonly db: BetterSqlite3.Database
  /** backups/ root (§20 app-data layout); file pre-images live under backups/audit/. */
  readonly backupsDir: string
  /** Required for graphWrite() and for undoing graph actions. */
  readonly engine?: StorageEngine
}

const PROP_NAME_RE = /^[a-zA-Z_][a-zA-Z0-9_]*$/

const assertLabel = (label: string): NodeLabel => {
  if (!(NODE_LABELS as readonly string[]).includes(label)) throw new Error(`unknown node label '${label}'`)
  return label as NodeLabel
}
const assertEdgeType = (type: string): EdgeType => {
  if (!(EDGE_TYPES as readonly string[]).includes(type)) throw new Error(`unknown edge type '${type}'`)
  return type as EdgeType
}

export class AuditLog implements AuditHook {
  private readonly db: BetterSqlite3.Database
  private readonly backupsDir: string
  private readonly engine: StorageEngine | undefined

  constructor(deps: AuditLogDeps) {
    this.db = deps.db
    this.backupsDir = deps.backupsDir
    this.engine = deps.engine
  }

  // ── AuditHook (kernel-mediated action trail) ───────────────────────────────

  record(event: AuditEvent): void {
    this.insertRow({
      id: randomUUID(),
      agentId: event.agentId,
      kind: 'action',
      description: `${event.action.kind} '${event.action.name}' — ${event.decision.allowed ? 'allowed' : 'denied'}`,
      reversible: false,
      inverse: null,
      backupDir: null,
      outcome: event.outcome,
      error: event.error ?? null,
      details: {
        actionKind: event.action.kind,
        actionName: event.action.name,
        decision: event.decision.reason,
        durationMs: Math.round(event.durationMs)
      }
    })
  }

  // ── Reversible graph writes ────────────────────────────────────────────────

  /**
   * Run a whole-mutation job through the single write lane (§21 rule 1),
   * recording inverse ops for every structured operation. Returns the job's
   * result plus the audit action id.
   *
   * Crash-journaled (§21.9): the lane is exclusive, NOT transactional — each
   * statement auto-commits, so a crash mid-job leaves a durable PARTIAL write.
   * To make that recoverable, the audit row is written 'pending' with empty
   * inverses BEFORE the lane job starts, and its inverse_json is re-persisted
   * (newest-first, roll-back-ready) after every recorded op and BEFORE the
   * matching forward mutation runs. So a row still 'pending' at the next boot is
   * a write the process died mid-way, and its inverse_json rolls back exactly the
   * committed prefix (crashSweep.ts). On success the row flips to 'ok'; a caught
   * error keeps today's 'error' semantics (outcome 'error' + the inverses so far,
   * so a partial write can still be rolled back from the dashboard).
   */
  async graphWrite<T>(
    agentId: string,
    description: string,
    fn: (tx: WriteTx) => Promise<T>
  ): Promise<{ result: T; actionId: string; reversible: boolean }> {
    const engine = this.requireEngine()
    const actionId = randomUUID()
    const inverse: GraphInverseOp[] = []
    let rawMutations = 0

    // Write-intent journal: the 'pending' row lands BEFORE the lane job runs.
    this.insertPendingGraphWrite(actionId, agentId, description)
    // Keep the crash-recovery inverse current after every recorded op (sync
    // better-sqlite3 update — fine at this op volume). newest-first == undo order.
    const persistInverse = (): void => {
      this.db
        .prepare('UPDATE audit_log SET inverse_json = ? WHERE id = ?')
        .run(JSON.stringify([...inverse].reverse()), actionId)
    }
    const finalize = (outcome: 'ok' | 'error', error?: string): void => {
      this.db
        .prepare(
          `UPDATE audit_log SET outcome = ?, reversible = ?, inverse_json = ?, error = ?, details_json = ? WHERE id = ?`
        )
        .run(
          outcome,
          rawMutations === 0 ? 1 : 0,
          JSON.stringify([...inverse].reverse()),
          error ?? null,
          JSON.stringify({ ops: inverse.length, rawMutations }),
          actionId
        )
    }

    try {
      const result = await engine.withWrite(async (tx) => {
        const recording: WriteTx = {
          cypher: async (query, params) => {
            if (isMutatingCypher(query)) {
              // No generic inverse for arbitrary Cypher — the ACTION becomes
              // un-undoable rather than silently half-reversible (§13). Nothing
              // to persist (there is no inverse to record).
              rawMutations += 1
            }
            return tx.cypher(query, params)
          },
          upsertNode: async (label, props) => {
            inverse.push(await preImageOf(tx, label, props))
            persistInverse() // record the undo BEFORE the forward write
            return tx.upsertNode(label, props)
          },
          createEdge: async (type, from, to, props?: EdgeProps) => {
            const exists = await edgeExists(tx, type, from, to)
            // MERGE on an existing edge only restamps updated_at — nothing to
            // invert; a newly created edge is deleted on undo.
            if (!exists) inverse.push({ op: 'delete-edge', type, from, to })
            persistInverse()
            return tx.createEdge(type, from, to, props)
          },
          deleteNode: async (label, id) => {
            // Capture the full pre-image BEFORE the DETACH delete: the node's
            // properties (embedding included) plus every incident edge, so undo
            // can rebuild the node and reconnect it. Ordering matters — the
            // node restore must apply BEFORE its edge restores (createEdge needs
            // both endpoints to exist). undo replays newest-pushed-first (the
            // whole inverse array is reversed at persist/finalize), so push the
            // incident edges FIRST and the node restore LAST: after the reversal
            // the node is restored first, then its edges. A missing node →
            // nothing captured, nothing to delete.
            const node = await nodePreImageForDelete(tx, label, id)
            if (node !== null) {
              inverse.push(...(await incidentEdgesOf(tx, label, id)))
              inverse.push(node)
            }
            persistInverse()
            return tx.deleteNode(label, id)
          },
          deleteEdge: async (type, from, to) => {
            const op = await edgePreImageForDelete(tx, type, from, to)
            if (op !== null) inverse.push(op)
            persistInverse()
            return tx.deleteEdge(type, from, to)
          }
        }
        return fn(recording)
      }, `graph-write:${actionId}`)
      finalize('ok')
      return { result, actionId, reversible: rawMutations === 0 }
    } catch (err) {
      finalize('error', err instanceof Error ? err.message : String(err))
      throw err
    }
  }

  // ── Reversible file ops (pre-image → backups/audit/<actionId>/) ───────────

  fileWrite(agentId: string, filePath: string, content: string | Buffer): { actionId: string } {
    const actionId = randomUUID()
    const backupDir = this.backupFor(actionId)
    const existed = existsSync(filePath)
    const manifest = { path: filePath, existed }
    if (existed) copyFileSync(filePath, join(backupDir, 'pre-image'))
    writeFileSync(join(backupDir, 'manifest.json'), JSON.stringify(manifest, null, 2))

    try {
      mkdirSync(dirname(filePath), { recursive: true })
      writeFileSync(filePath, content)
    } catch (err) {
      this.insertFileRow(actionId, agentId, 'file-write', filePath, backupDir, 'error', err)
      throw err
    }
    this.insertFileRow(actionId, agentId, 'file-write', filePath, backupDir, 'ok')
    return { actionId }
  }

  fileDelete(agentId: string, filePath: string): { actionId: string } {
    const actionId = randomUUID()
    const backupDir = this.backupFor(actionId)
    copyFileSync(filePath, join(backupDir, 'pre-image')) // throws if missing — caller's bug
    writeFileSync(join(backupDir, 'manifest.json'), JSON.stringify({ path: filePath, existed: true }, null, 2))
    try {
      unlinkSync(filePath)
    } catch (err) {
      this.insertFileRow(actionId, agentId, 'file-delete', filePath, backupDir, 'error', err)
      throw err
    }
    this.insertFileRow(actionId, agentId, 'file-delete', filePath, backupDir, 'ok')
    return { actionId }
  }

  // ── Undo ───────────────────────────────────────────────────────────────────

  async undo(actionId: string, undoneBy = 'user'): Promise<void> {
    const row = this.getAction(actionId)
    if (row === undefined) throw new UndoError('NOT_FOUND', `audit action ${actionId} does not exist`)
    if (!row.reversible) {
      throw new UndoError(
        'IRREVERSIBLE',
        `audit action ${actionId} (${row.kind}) is flagged un-undoable — ` +
          (row.kind === 'action' || row.kind === 'undo'
            ? 'it records an observation, not a reversible state change'
            : 'it contains raw mutating cypher with no recorded inverse')
      )
    }
    if (row.undoneAt !== null) {
      throw new UndoError('ALREADY_UNDONE', `audit action ${actionId} was already undone at ${row.undoneAt}`)
    }

    try {
      if (row.kind === 'graph-write') {
        await this.undoGraph(actionId)
      } else if (row.kind === 'file-write' || row.kind === 'file-delete') {
        this.undoFile(row)
      } else {
        throw new UndoError('IRREVERSIBLE', `audit kind '${row.kind}' has no undo executor`)
      }
    } catch (err) {
      if (err instanceof UndoError) throw err
      throw new UndoError('UNDO_FAILED', `undo of ${actionId} failed: ${err instanceof Error ? err.message : String(err)}`)
    }

    const undoId = randomUUID()
    this.insertRow({
      id: undoId,
      agentId: undoneBy,
      kind: 'undo',
      description: `undo of ${row.kind} ${actionId} (${row.description})`,
      reversible: false, // no redo in v1 — recorded decision
      inverse: null,
      backupDir: null,
      outcome: 'ok',
      error: null,
      details: { undoes: actionId }
    })
    this.db
      .prepare(`UPDATE audit_log SET undone_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'), undo_action_id = ? WHERE id = ?`)
      .run(undoId, actionId)
  }

  /**
   * Boot-sweep entry (crashSweep.ts): a graph-write row still 'pending' at boot
   * means the process died mid-write. Apply its accumulated inverses to ROLL BACK
   * the committed prefix (the ops are idempotent — delete-node on an absent node
   * no-ops, restore-node upserts), then flip the row to 'error' with a suffix so
   * it reads as a settled, non-undoable action in the log. Throws if the rollback
   * lane job fails — the sweep then leaves the row and surfaces an error.
   */
  async rollbackInterruptedWrite(actionId: string): Promise<void> {
    await this.applyInverseOps(actionId, `interrupted-rollback:${actionId}`)
    this.db
      .prepare(
        `UPDATE audit_log SET outcome = 'error', error = ?,
         description = description || ' (rolled back after interrupted write)' WHERE id = ?`
      )
      .run('write interrupted by a crash/shutdown; the committed prefix was rolled back at boot', actionId)
  }

  private async undoGraph(actionId: string): Promise<void> {
    await this.applyInverseOps(actionId, `undo:${actionId}`)
  }

  /** Apply a row's recorded inverse ops in ONE lane job (§21 rule 1), newest-first. */
  private async applyInverseOps(actionId: string, label: string): Promise<void> {
    const engine = this.requireEngine()
    const raw = this.db.prepare('SELECT inverse_json FROM audit_log WHERE id = ?').get(actionId) as
      | { inverse_json: string | null }
      | undefined
    const ops = JSON.parse(raw?.inverse_json ?? '[]') as GraphInverseOp[]
    // ONE lane job for the whole rollback (§21 rule 1), ops already newest-first.
    await engine.withWrite(async (tx) => {
      for (const op of ops) {
        if (op.op === 'delete-node') {
          // Structured delete rather than raw DETACH DELETE cypher: identical
          // semantics, but deleteNode also runs the engine's emptied-vector-
          // index rebuild — undoing the CREATE of a label's last retrievable
          // node must not leave its HNSW index degenerate (ryugraph 25.9.1
          // emptied-index caveat; see deleteNodeInLane). Found by the Stage-2
          // memory.edit create→undo round-trip tests.
          await tx.deleteNode(assertLabel(op.label), op.id)
        } else if (op.op === 'restore-props') {
          const label = assertLabel(op.label)
          const entries = Object.entries(op.props)
          const nulls = entries.filter(([, v]) => v === null).map(([k]) => k)
          const values = Object.fromEntries(entries.filter(([, v]) => v !== null))
          if (Object.keys(values).length > 0) {
            // upsertNode handles TIMESTAMP decoding and the HNSW re-index
            // dance for embedding restores; updated_at restamps (engine-owned).
            await tx.upsertNode(label, { id: op.id, ...values } as NodeProps)
          }
          for (const key of nulls) {
            if (!PROP_NAME_RE.test(key)) throw new Error(`unsafe property name '${key}' in inverse op`)
            await tx.cypher(`MATCH (n:${label} {id: $id}) SET n.${key} = NULL`, { id: op.id })
          }
        } else if (op.op === 'restore-node') {
          const label = assertLabel(op.label)
          for (const key of Object.keys(op.props)) {
            if (!PROP_NAME_RE.test(key)) throw new Error(`unsafe property name '${key}' in inverse op`)
          }
          // Re-create the DETACH-deleted node from its full pre-image. The node
          // is gone, so upsertNode takes the CREATE branch — the embedding is set
          // inline and the HNSW/FTS indexes auto-maintain; created_at/updated_at
          // are re-stamped (engine-owned), as restore-props already does.
          await tx.upsertNode(label, { ...op.props } as NodeProps)
        } else if (op.op === 'delete-edge') {
          // Structured twin of the delete-node arm above (same engine path a
          // forward deleteEdge takes; no index implications, just symmetry).
          await tx.deleteEdge(
            assertEdgeType(op.type),
            { label: assertLabel(op.from.label), id: op.from.id },
            { label: assertLabel(op.to.label), id: op.to.id }
          )
        } else {
          // restore-edge: reconnect a deleted edge via the structured createEdge.
          // Both endpoints were restored earlier in THIS rollback (the recorder
          // pushes each incident edge before its node so the reversal restores
          // the node first — see graphWrite's recording deleteNode), or were
          // never deleted, so the MERGE endpoints exist.
          const type = assertEdgeType(op.type)
          const from: NodeRef = { label: assertLabel(op.from.label), id: op.from.id }
          const to: NodeRef = { label: assertLabel(op.to.label), id: op.to.id }
          await tx.createEdge(type, from, to, op.props)
        }
      }
    }, label)
  }

  private undoFile(row: AuditActionRow): void {
    const backupDir = (
      this.db.prepare('SELECT backup_dir FROM audit_log WHERE id = ?').get(row.id) as { backup_dir: string | null }
    ).backup_dir
    if (backupDir === null) throw new UndoError('UNDO_FAILED', `file action ${row.id} has no backup directory`)
    const manifest = JSON.parse(readFileSync(join(backupDir, 'manifest.json'), 'utf8')) as {
      path: string
      existed: boolean
    }
    if (manifest.existed) {
      mkdirSync(dirname(manifest.path), { recursive: true })
      copyFileSync(join(backupDir, 'pre-image'), manifest.path)
    } else {
      // The action created the file; undo removes it.
      rmSync(manifest.path, { force: true })
    }
  }

  // ── Queries (dashboard surface) ────────────────────────────────────────────

  getAction(id: string): AuditActionRow | undefined {
    const row = this.db.prepare('SELECT * FROM audit_log WHERE id = ?').get(id) as RawRow | undefined
    return row === undefined ? undefined : decodeRow(row)
  }

  listActions(filter?: { kind?: AuditActionRow['kind']; agentId?: string }): AuditActionRow[] {
    // 'pending' rows are a transient internal state (a graph write in flight, or
    // one a crash left mid-write until the boot sweep settles it to 'error') — an
    // in-flight, un-undoable, not-yet-real action. They are filtered OUT of the
    // normal history view so the dashboard only ever sees settled ok/error rows
    // (AuditActionRow.outcome stays 'ok'|'error'); the boot sweep reads pending
    // rows directly by outcome (crashSweep.ts).
    const clauses: string[] = [`outcome != 'pending'`]
    const params: unknown[] = []
    if (filter?.kind !== undefined) {
      clauses.push('kind = ?')
      params.push(filter.kind)
    }
    if (filter?.agentId !== undefined) {
      clauses.push('agent_id = ?')
      params.push(filter.agentId)
    }
    const rows = this.db
      .prepare(`SELECT * FROM audit_log WHERE ${clauses.join(' AND ')} ORDER BY created_at, id`)
      .all(...params) as RawRow[]
    return rows.map(decodeRow)
  }

  // ── internals ──────────────────────────────────────────────────────────────

  private requireEngine(): StorageEngine {
    if (this.engine === undefined) {
      throw new Error('AuditLog was constructed without a storage engine — graph auditing is unavailable')
    }
    return this.engine
  }

  private backupFor(actionId: string): string {
    const dir = join(this.backupsDir, 'audit', actionId)
    mkdirSync(dir, { recursive: true })
    return dir
  }

  /**
   * The write-intent journal row for graphWrite: a 'pending' graph-write with
   * empty inverses, inserted BEFORE the lane job runs. graphWrite then keeps its
   * inverse_json current per op and finalizes it to ok/error; a row still
   * 'pending' at the next boot is a crash-interrupted write (crashSweep.ts).
   */
  private insertPendingGraphWrite(actionId: string, agentId: string, description: string): void {
    this.db
      .prepare(
        `INSERT INTO audit_log (id, agent_id, kind, description, reversible, inverse_json, backup_dir, outcome, error, details_json)
         VALUES (?, ?, 'graph-write', ?, 0, NULL, NULL, 'pending', NULL, ?)`
      )
      .run(actionId, agentId, description, JSON.stringify({ ops: 0, rawMutations: 0 }))
  }

  private insertFileRow(
    actionId: string,
    agentId: string,
    kind: 'file-write' | 'file-delete',
    filePath: string,
    backupDir: string,
    outcome: 'ok' | 'error',
    err?: unknown
  ): void {
    this.insertRow({
      id: actionId,
      agentId,
      kind,
      description: `${kind === 'file-write' ? 'write' : 'delete'} ${filePath}`,
      reversible: outcome === 'ok',
      inverse: null,
      backupDir,
      outcome,
      error: err === undefined ? null : err instanceof Error ? err.message : String(err),
      details: { path: filePath }
    })
  }

  private insertRow(row: {
    id: string
    agentId: string
    kind: AuditActionRow['kind']
    description: string
    reversible: boolean
    inverse: GraphInverseOp[] | null
    backupDir: string | null
    outcome: 'ok' | 'error'
    error: string | null
    details: Record<string, unknown>
  }): void {
    this.db
      .prepare(
        `INSERT INTO audit_log (id, agent_id, kind, description, reversible, inverse_json, backup_dir, outcome, error, details_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        row.id,
        row.agentId,
        row.kind,
        row.description,
        row.reversible ? 1 : 0,
        row.inverse === null ? null : JSON.stringify(row.inverse),
        row.backupDir,
        row.outcome,
        row.error,
        JSON.stringify(row.details)
      )
  }
}

interface RawRow {
  id: string
  agent_id: string
  kind: AuditActionRow['kind']
  description: string
  reversible: number
  outcome: 'ok' | 'error'
  error: string | null
  details_json: string | null
  undone_at: string | null
  undo_action_id: string | null
  created_at: string
}

function decodeRow(row: RawRow): AuditActionRow {
  return {
    id: row.id,
    agentId: row.agent_id,
    kind: row.kind,
    description: row.description,
    reversible: row.reversible === 1,
    outcome: row.outcome,
    error: row.error,
    details: JSON.parse(row.details_json ?? '{}') as Record<string, unknown>,
    undoneAt: row.undone_at,
    undoActionId: row.undo_action_id,
    createdAt: row.created_at
  }
}

// ── inverse-op capture helpers ────────────────────────────────────────────────

/** Pre-image of the properties an upsert is about to touch. */
async function preImageOf(tx: WriteTx, label: NodeLabel, props: NodeProps): Promise<GraphInverseOp> {
  const id = String(props['id'])
  const touched = Object.keys(props).filter((k) => k !== 'id')
  for (const key of touched) {
    if (!PROP_NAME_RE.test(key)) throw new Error(`unsafe property name '${key}' in audited upsert`)
  }
  const exists = await tx.cypher(`MATCH (n:${label} {id: $id}) RETURN n.id AS id LIMIT 1`, { id })
  if (exists.length === 0) return { op: 'delete-node', label, id }
  if (touched.length === 0) return { op: 'restore-props', label, id, props: {} }
  const returns = touched.map((k) => `n.${k} AS ${k}`).join(', ')
  const rows = await tx.cypher(`MATCH (n:${label} {id: $id}) RETURN ${returns} LIMIT 1`, { id })
  const pre: Record<string, unknown> = {}
  for (const key of touched) {
    const value = rows[0]?.[key]
    // Dates → ISO strings (JSON-stable; upsertNode accepts ISO for TIMESTAMP).
    pre[key] = value instanceof Date ? value.toISOString() : (value ?? null)
  }
  return { op: 'restore-props', label, id, props: pre }
}

async function edgeExists(tx: WriteTx, type: EdgeType, from: NodeRef, to: NodeRef): Promise<boolean> {
  const rows = await tx.cypher(
    `MATCH (a:${from.label} {id: $from})-[r:${type}]->(b:${to.label} {id: $to}) RETURN count(r) AS c`,
    { from: from.id, to: to.id }
  )
  return Number(rows[0]?.['c'] ?? 0) > 0
}

/**
 * Full pre-image of a node about to be DETACH-deleted: id + every SET writable
 * property (embedding included), so undo can re-create it byte-for-byte at
 * column precision. Returns null when the node does not exist (nothing to
 * delete → nothing to record). created_at/updated_at are engine-owned and
 * re-stamped on restore.
 */
async function nodePreImageForDelete(tx: WriteTx, label: NodeLabel, id: string): Promise<GraphInverseOp | null> {
  const names = [...writableNodeProperties(label).keys()]
  for (const key of names) {
    if (!PROP_NAME_RE.test(key)) throw new Error(`unsafe property name '${key}' in node pre-image`)
  }
  const returns = names.length > 0 ? names.map((k) => `n.${k} AS ${k}`).join(', ') : 'n.id AS __exists'
  const rows = await tx.cypher(`MATCH (n:${label} {id: $id}) RETURN ${returns} LIMIT 1`, { id })
  if (rows.length === 0) return null
  const props: Record<string, unknown> = { id }
  for (const key of names) {
    const value = rows[0]?.[key]
    if (value === null || value === undefined) continue
    // Dates → ISO strings (JSON-stable; upsertNode accepts ISO for TIMESTAMP).
    props[key] = value instanceof Date ? value.toISOString() : value
  }
  return { op: 'restore-node', label, props }
}

/**
 * Every edge incident to a node (both directions), as restore-edge inverse ops.
 * Enumerated over the §18 schema pairs (the driver has no generic label()/type()
 * projection — the export job walks pairs the same way): for each rel type where
 * the node's label is a FROM endpoint, capture its outgoing edges; where it is a
 * TO endpoint, its incoming edges. DETACH DELETE removes all of these, so undo
 * must recreate each one.
 */
async function incidentEdgesOf(tx: WriteTx, label: NodeLabel, id: string): Promise<GraphInverseOp[]> {
  const ops: GraphInverseOp[] = []
  for (const spec of REL_TABLES) {
    for (const [fromLabel, toLabel] of spec.pairs) {
      if (fromLabel === label) {
        const rows = await tx.cypher(
          `MATCH (n:${label} {id: $id})-[r:${spec.type}]->(b:${toLabel})
           RETURN b.id AS other, r.extracted_by AS extracted_by, r.confidence AS confidence`,
          { id }
        )
        for (const row of rows) {
          ops.push(restoreEdgeOp(spec.type, { label, id }, { label: toLabel, id: String(row['other']) }, row))
        }
      }
      if (toLabel === label) {
        const rows = await tx.cypher(
          `MATCH (a:${fromLabel})-[r:${spec.type}]->(n:${label} {id: $id})
           RETURN a.id AS other, r.extracted_by AS extracted_by, r.confidence AS confidence`,
          { id }
        )
        for (const row of rows) {
          ops.push(restoreEdgeOp(spec.type, { label: fromLabel, id: String(row['other']) }, { label, id }, row))
        }
      }
    }
  }
  return ops
}

/** Pre-image of a single edge about to be deleted; null when the edge is absent. */
async function edgePreImageForDelete(
  tx: WriteTx,
  type: EdgeType,
  from: NodeRef,
  to: NodeRef
): Promise<GraphInverseOp | null> {
  const rows = await tx.cypher(
    `MATCH (a:${from.label} {id: $from})-[r:${type}]->(b:${to.label} {id: $to})
     RETURN r.extracted_by AS extracted_by, r.confidence AS confidence LIMIT 1`,
    { from: from.id, to: to.id }
  )
  if (rows.length === 0) return null
  return restoreEdgeOp(type, from, to, rows[0] as Record<string, unknown>)
}

/** Build a restore-edge op, carrying only the edge props that were actually set. */
function restoreEdgeOp(type: EdgeType, from: NodeRef, to: NodeRef, row: Record<string, unknown>): GraphInverseOp {
  const props = edgePropsFrom(row)
  return props === undefined ? { op: 'restore-edge', type, from, to } : { op: 'restore-edge', type, from, to, props }
}

/** The stamped edge props (extracted_by/confidence) from a query row, or undefined when unset. */
function edgePropsFrom(row: Record<string, unknown>): EdgeProps | undefined {
  const props: { extracted_by?: string; confidence?: number } = {}
  const extractedBy = row['extracted_by']
  if (typeof extractedBy === 'string') props.extracted_by = extractedBy
  const confidence = row['confidence']
  if (typeof confidence === 'number') props.confidence = confidence
  return Object.keys(props).length > 0 ? props : undefined
}
