/**
 * SqliteCheckpointSaver unit tests against the BaseCheckpointSaver contract
 * (put / getTuple / putWrites / list / deleteThread), mirroring the upstream
 * MemorySaver semantics the LangGraph runtime depends on.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ERROR, type Checkpoint, type CheckpointMetadata } from '@langchain/langgraph-checkpoint'
import { SqliteCheckpointSaver } from '../../src/main/kernel'
import { openAppData, type AppData } from '../../src/main/storage'

let dir: string
let appData: AppData
let saver: SqliteCheckpointSaver

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'agentic-os-ckpt-'))
  appData = openAppData(join(dir, 'appdata.db'))
  saver = new SqliteCheckpointSaver(appData.db)
})

afterEach(() => {
  appData.close()
  rmSync(dir, { recursive: true, force: true })
})

/** Checkpoint ids sort lexicographically (uuid6 in production). */
function checkpoint(id: string, values: Record<string, unknown>): Checkpoint {
  return {
    v: 4,
    id,
    ts: '2026-07-04T00:00:00.000Z',
    channel_values: values,
    channel_versions: { data: 1 },
    versions_seen: {}
  }
}

function metadata(step: number, extra: Record<string, unknown> = {}): CheckpointMetadata {
  return { source: 'loop', step, parents: {}, ...extra } as CheckpointMetadata
}

const thread = (id: string): { configurable: { thread_id: string } } => ({ configurable: { thread_id: id } })

describe('put + getTuple', () => {
  it('round-trips the latest checkpoint with metadata and config', async () => {
    const returned = await saver.put(thread('t1'), checkpoint('0001', { data: { a: 1 } }), metadata(0), { data: 1 })
    expect(returned.configurable).toEqual({ thread_id: 't1', checkpoint_ns: '', checkpoint_id: '0001' })

    const tuple = await saver.getTuple(thread('t1'))
    expect(tuple).toBeDefined()
    expect(tuple!.checkpoint).toEqual(checkpoint('0001', { data: { a: 1 } }))
    expect(tuple!.metadata).toEqual(metadata(0))
    expect(tuple!.config.configurable).toEqual({ thread_id: 't1', checkpoint_ns: '', checkpoint_id: '0001' })
    expect(tuple!.parentConfig).toBeUndefined()
    expect(tuple!.pendingWrites).toEqual([])
  })

  it('links parents and fetches exact checkpoints by id', async () => {
    await saver.put(thread('t1'), checkpoint('0001', { data: { step: 1 } }), metadata(0), {})
    // put() receives the PARENT checkpoint id in config (LangGraph passes the
    // config returned by the previous put).
    await saver.put(
      { configurable: { thread_id: 't1', checkpoint_ns: '', checkpoint_id: '0001' } },
      checkpoint('0002', { data: { step: 2 } }),
      metadata(1),
      {}
    )

    const latest = await saver.getTuple(thread('t1'))
    expect(latest!.checkpoint.id).toBe('0002')
    expect(latest!.parentConfig?.configurable?.['checkpoint_id']).toBe('0001')

    const exact = await saver.getTuple({ configurable: { thread_id: 't1', checkpoint_id: '0001' } })
    expect(exact!.checkpoint.id).toBe('0001')
    expect(exact!.checkpoint.channel_values).toEqual({ data: { step: 1 } })
  })

  it('returns undefined for unknown threads and missing thread_id', async () => {
    expect(await saver.getTuple(thread('nope'))).toBeUndefined()
    expect(await saver.getTuple({ configurable: {} })).toBeUndefined()
  })

  it('requires thread_id on put', async () => {
    await expect(saver.put({ configurable: {} }, checkpoint('0001', {}), metadata(0), {})).rejects.toThrow(/thread_id/)
  })
})

describe('putWrites', () => {
  const config = { configurable: { thread_id: 't1', checkpoint_ns: '', checkpoint_id: '0001' } }

  beforeEach(async () => {
    await saver.put(thread('t1'), checkpoint('0001', {}), metadata(0), {})
  })

  it('stores pending writes surfaced by getTuple in task/idx order', async () => {
    await saver.putWrites(config, [['data', { x: 1 }], ['data', { y: 2 }]], 'task-a')
    const tuple = await saver.getTuple(thread('t1'))
    expect(tuple!.pendingWrites).toEqual([
      ['task-a', 'data', { x: 1 }],
      ['task-a', 'data', { y: 2 }]
    ])
  })

  it('regular writes are first-write-wins; special channels overwrite', async () => {
    await saver.putWrites(config, [['data', 'first']], 'task-a')
    await saver.putWrites(config, [['data', 'second']], 'task-a')
    let tuple = await saver.getTuple(thread('t1'))
    expect(tuple!.pendingWrites).toEqual([['task-a', 'data', 'first']])

    await saver.putWrites(config, [[ERROR, 'boom-1']], 'task-a')
    await saver.putWrites(config, [[ERROR, 'boom-2']], 'task-a')
    tuple = await saver.getTuple(thread('t1'))
    expect(tuple!.pendingWrites).toContainEqual(['task-a', ERROR, 'boom-2'])
    expect(tuple!.pendingWrites).not.toContainEqual(['task-a', ERROR, 'boom-1'])
  })

  it('requires checkpoint_id', async () => {
    await expect(saver.putWrites(thread('t1'), [['data', 1]], 'task-a')).rejects.toThrow(/checkpoint_id/)
  })
})

describe('list', () => {
  beforeEach(async () => {
    await saver.put(thread('t1'), checkpoint('0001', { data: 1 }), metadata(0), {})
    await saver.put(
      { configurable: { thread_id: 't1', checkpoint_ns: '', checkpoint_id: '0001' } },
      checkpoint('0002', { data: 2 }),
      metadata(1),
      {}
    )
    await saver.put(
      { configurable: { thread_id: 't1', checkpoint_ns: '', checkpoint_id: '0002' } },
      checkpoint('0003', { data: 3 }),
      metadata(2),
      {}
    )
    await saver.put(thread('t2'), checkpoint('9001', { data: 'other' }), metadata(0), {})
  })

  async function collect(config: Parameters<SqliteCheckpointSaver['list']>[0], options?: Parameters<SqliteCheckpointSaver['list']>[1]): Promise<string[]> {
    const ids: string[] = []
    for await (const tuple of saver.list(config, options)) ids.push(tuple.checkpoint.id)
    return ids
  }

  it('lists a thread newest-first', async () => {
    expect(await collect(thread('t1'))).toEqual(['0003', '0002', '0001'])
  })

  it('honors limit and before', async () => {
    expect(await collect(thread('t1'), { limit: 2 })).toEqual(['0003', '0002'])
    expect(await collect(thread('t1'), { before: { configurable: { checkpoint_id: '0003' } } })).toEqual([
      '0002',
      '0001'
    ])
  })

  it('filters on metadata fields', async () => {
    expect(await collect(thread('t1'), { filter: { step: 1 } })).toEqual(['0002'])
  })

  it('lists across threads when no thread_id is given', async () => {
    const ids = await collect({ configurable: {} })
    expect(ids).toContain('9001')
    expect(ids).toHaveLength(4)
  })
})

describe('deleteThread', () => {
  it('removes checkpoints and writes for exactly that thread', async () => {
    await saver.put(thread('t1'), checkpoint('0001', {}), metadata(0), {})
    await saver.putWrites({ configurable: { thread_id: 't1', checkpoint_id: '0001' } }, [['data', 1]], 'task-a')
    await saver.put(thread('t2'), checkpoint('0001', {}), metadata(0), {})

    await saver.deleteThread('t1')
    expect(await saver.getTuple(thread('t1'))).toBeUndefined()
    expect(await saver.getTuple(thread('t2'))).toBeDefined()
    const writeCount = appData.db.prepare('SELECT count(*) AS c FROM workflow_checkpoint_writes').get() as { c: number }
    expect(writeCount.c).toBe(0)
  })
})
