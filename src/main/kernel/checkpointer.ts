/**
 * SqliteCheckpointSaver — LangGraph checkpointer over appdata.db (§9, §10).
 *
 * Implemented in-house (rather than installing @langchain/langgraph-
 * checkpoint-sqlite) so checkpoints live in the same appdata.db the rest of
 * the app owns, through the same dual-ABI better-sqlite3 handle. Semantics
 * mirror the upstream savers — MemorySaver (bundled reference) and the
 * official SQLite saver schema — against @langchain/langgraph-checkpoint's
 * BaseCheckpointSaver contract:
 *
 * - `put` stores the serde-serialized checkpoint + metadata keyed
 *   (thread_id, checkpoint_ns, checkpoint_id) with the parent checkpoint id.
 * - `putWrites` stores pending channel writes; special channels (ERROR,
 *   INTERRUPT, …) map to negative idx and overwrite, regular writes are
 *   INSERT OR IGNORE (first write wins on replay).
 * - `getTuple` returns the exact or latest checkpoint (checkpoint ids are
 *   uuid6 — lexicographically time-ordered) plus its pending writes and
 *   parent config.
 *
 * Checkpoint format note: this saver was born on checkpoint format v4
 * (langgraph 1.4.x) and its tables start empty, so the pre-v4 pendingSends
 * migration in upstream savers is deliberately absent.
 *
 * Writes are synchronous better-sqlite3 statements: committed before the
 * next graph step starts (the runner invokes with durability 'sync'), which
 * is what makes kill-mid-step resume (§10) work.
 */
import type BetterSqlite3 from 'better-sqlite3'
import {
  BaseCheckpointSaver,
  WRITES_IDX_MAP,
  copyCheckpoint,
  type ChannelVersions,
  type Checkpoint,
  type CheckpointListOptions,
  type CheckpointMetadata,
  type CheckpointPendingWrite,
  type CheckpointTuple,
  type PendingWrite
} from '@langchain/langgraph-checkpoint'
import type { RunnableConfig } from '@langchain/core/runnables'

interface CheckpointRow {
  thread_id: string
  checkpoint_ns: string
  checkpoint_id: string
  parent_checkpoint_id: string | null
  type: string | null
  checkpoint: Buffer
  metadata: Buffer
}

interface WriteRow {
  task_id: string
  channel: string
  type: string | null
  value: Buffer | null
}

export class SqliteCheckpointSaver extends BaseCheckpointSaver {
  private readonly selectOne: BetterSqlite3.Statement
  private readonly selectLatest: BetterSqlite3.Statement
  private readonly selectWrites: BetterSqlite3.Statement
  private readonly insertCheckpoint: BetterSqlite3.Statement
  private readonly insertWriteIgnore: BetterSqlite3.Statement
  private readonly insertWriteReplace: BetterSqlite3.Statement
  private readonly deleteThreadCheckpoints: BetterSqlite3.Statement
  private readonly deleteThreadWrites: BetterSqlite3.Statement
  private readonly db: BetterSqlite3.Database

  constructor(db: BetterSqlite3.Database) {
    super()
    this.db = db
    this.selectOne = db.prepare(
      `SELECT thread_id, checkpoint_ns, checkpoint_id, parent_checkpoint_id, type, checkpoint, metadata
       FROM workflow_checkpoints WHERE thread_id = ? AND checkpoint_ns = ? AND checkpoint_id = ?`
    )
    this.selectLatest = db.prepare(
      `SELECT thread_id, checkpoint_ns, checkpoint_id, parent_checkpoint_id, type, checkpoint, metadata
       FROM workflow_checkpoints WHERE thread_id = ? AND checkpoint_ns = ?
       ORDER BY checkpoint_id DESC LIMIT 1`
    )
    this.selectWrites = db.prepare(
      `SELECT task_id, channel, type, value FROM workflow_checkpoint_writes
       WHERE thread_id = ? AND checkpoint_ns = ? AND checkpoint_id = ?
       ORDER BY task_id, idx`
    )
    this.insertCheckpoint = db.prepare(
      `INSERT OR REPLACE INTO workflow_checkpoints
         (thread_id, checkpoint_ns, checkpoint_id, parent_checkpoint_id, type, checkpoint, metadata)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    this.insertWriteIgnore = db.prepare(
      `INSERT OR IGNORE INTO workflow_checkpoint_writes
         (thread_id, checkpoint_ns, checkpoint_id, task_id, idx, channel, type, value)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    this.insertWriteReplace = db.prepare(
      `INSERT OR REPLACE INTO workflow_checkpoint_writes
         (thread_id, checkpoint_ns, checkpoint_id, task_id, idx, channel, type, value)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    this.deleteThreadCheckpoints = db.prepare(`DELETE FROM workflow_checkpoints WHERE thread_id = ?`)
    this.deleteThreadWrites = db.prepare(`DELETE FROM workflow_checkpoint_writes WHERE thread_id = ?`)
  }

  private async loadPendingWrites(threadId: string, checkpointNs: string, checkpointId: string): Promise<CheckpointPendingWrite[]> {
    const rows = this.selectWrites.all(threadId, checkpointNs, checkpointId) as WriteRow[]
    return Promise.all(
      rows.map(async (row): Promise<CheckpointPendingWrite> => {
        const value = row.value === null ? undefined : await this.serde.loadsTyped(row.type ?? 'json', row.value)
        return [row.task_id, row.channel, value]
      })
    )
  }

  private async rowToTuple(row: CheckpointRow, config?: RunnableConfig): Promise<CheckpointTuple> {
    const checkpoint = (await this.serde.loadsTyped(row.type ?? 'json', row.checkpoint)) as Checkpoint
    const metadata = (await this.serde.loadsTyped(row.type ?? 'json', row.metadata)) as CheckpointMetadata
    const tuple: CheckpointTuple = {
      config: config ?? {
        configurable: {
          thread_id: row.thread_id,
          checkpoint_ns: row.checkpoint_ns,
          checkpoint_id: row.checkpoint_id
        }
      },
      checkpoint,
      metadata,
      pendingWrites: await this.loadPendingWrites(row.thread_id, row.checkpoint_ns, row.checkpoint_id)
    }
    if (row.parent_checkpoint_id !== null) {
      tuple.parentConfig = {
        configurable: {
          thread_id: row.thread_id,
          checkpoint_ns: row.checkpoint_ns,
          checkpoint_id: row.parent_checkpoint_id
        }
      }
    }
    return tuple
  }

  async getTuple(config: RunnableConfig): Promise<CheckpointTuple | undefined> {
    const threadId = config.configurable?.['thread_id'] as string | undefined
    if (threadId === undefined) return undefined
    const checkpointNs = (config.configurable?.['checkpoint_ns'] as string | undefined) ?? ''
    const checkpointId = config.configurable?.['checkpoint_id'] as string | undefined

    if (checkpointId !== undefined && checkpointId !== '') {
      const row = this.selectOne.get(threadId, checkpointNs, checkpointId) as CheckpointRow | undefined
      if (row === undefined) return undefined
      return this.rowToTuple(row, config)
    }
    const row = this.selectLatest.get(threadId, checkpointNs) as CheckpointRow | undefined
    if (row === undefined) return undefined
    return this.rowToTuple(row)
  }

  async *list(config: RunnableConfig, options?: CheckpointListOptions): AsyncGenerator<CheckpointTuple> {
    const { limit, before, filter } = options ?? {}
    const threadId = config.configurable?.['thread_id'] as string | undefined
    const checkpointNs = config.configurable?.['checkpoint_ns'] as string | undefined
    const checkpointId = config.configurable?.['checkpoint_id'] as string | undefined
    const beforeId = before?.configurable?.['checkpoint_id'] as string | undefined

    const clauses: string[] = []
    const params: unknown[] = []
    if (threadId !== undefined) {
      clauses.push('thread_id = ?')
      params.push(threadId)
    }
    if (checkpointNs !== undefined) {
      clauses.push('checkpoint_ns = ?')
      params.push(checkpointNs)
    }
    if (checkpointId !== undefined && checkpointId !== '') {
      clauses.push('checkpoint_id = ?')
      params.push(checkpointId)
    }
    if (beforeId !== undefined) {
      clauses.push('checkpoint_id < ?')
      params.push(beforeId)
    }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : ''
    const stmt = this.db.prepare(
      `SELECT thread_id, checkpoint_ns, checkpoint_id, parent_checkpoint_id, type, checkpoint, metadata
       FROM workflow_checkpoints ${where}
       ORDER BY thread_id, checkpoint_ns, checkpoint_id DESC`
    )

    let remaining = limit ?? Infinity
    for (const rowUntyped of stmt.iterate(...params)) {
      if (remaining <= 0) break
      const tuple = await this.rowToTuple(rowUntyped as CheckpointRow)
      if (filter !== undefined) {
        const metadata = (tuple.metadata ?? {}) as Record<string, unknown>
        if (!Object.entries(filter).every(([key, value]) => metadata[key] === value)) continue
      }
      remaining -= 1
      yield tuple
    }
  }

  async put(
    config: RunnableConfig,
    checkpoint: Checkpoint,
    metadata: CheckpointMetadata,
    _newVersions: ChannelVersions
  ): Promise<RunnableConfig> {
    const threadId = config.configurable?.['thread_id'] as string | undefined
    if (threadId === undefined) {
      throw new Error('SqliteCheckpointSaver.put: config.configurable.thread_id is required')
    }
    const checkpointNs = (config.configurable?.['checkpoint_ns'] as string | undefined) ?? ''
    const parentCheckpointId = (config.configurable?.['checkpoint_id'] as string | undefined) ?? null

    const prepared = copyCheckpoint(checkpoint)
    const [[checkpointType, serializedCheckpoint], [, serializedMetadata]] = await Promise.all([
      this.serde.dumpsTyped(prepared),
      this.serde.dumpsTyped(metadata)
    ])
    this.insertCheckpoint.run(
      threadId,
      checkpointNs,
      checkpoint.id,
      parentCheckpointId,
      checkpointType,
      Buffer.from(serializedCheckpoint),
      Buffer.from(serializedMetadata)
    )
    return { configurable: { thread_id: threadId, checkpoint_ns: checkpointNs, checkpoint_id: checkpoint.id } }
  }

  async putWrites(config: RunnableConfig, writes: PendingWrite[], taskId: string): Promise<void> {
    const threadId = config.configurable?.['thread_id'] as string | undefined
    const checkpointId = config.configurable?.['checkpoint_id'] as string | undefined
    if (threadId === undefined) {
      throw new Error('SqliteCheckpointSaver.putWrites: config.configurable.thread_id is required')
    }
    if (checkpointId === undefined) {
      throw new Error('SqliteCheckpointSaver.putWrites: config.configurable.checkpoint_id is required')
    }
    const checkpointNs = (config.configurable?.['checkpoint_ns'] as string | undefined) ?? ''

    const rows = await Promise.all(
      writes.map(async ([channel, value], idx) => {
        const mappedIdx = WRITES_IDX_MAP[channel] ?? idx
        const [type, serialized] = await this.serde.dumpsTyped(value)
        return { mappedIdx, channel, type, serialized }
      })
    )
    const insertAll = this.db.transaction(() => {
      for (const row of rows) {
        const stmt = row.mappedIdx < 0 ? this.insertWriteReplace : this.insertWriteIgnore
        stmt.run(threadId, checkpointNs, checkpointId, taskId, row.mappedIdx, row.channel, row.type, Buffer.from(row.serialized))
      }
    })
    insertAll()
  }

  async deleteThread(threadId: string): Promise<void> {
    const wipe = this.db.transaction(() => {
      this.deleteThreadCheckpoints.run(threadId)
      this.deleteThreadWrites.run(threadId)
    })
    wipe()
  }
}
