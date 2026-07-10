/**
 * Integration regression (fix/stack-reconnect): a relaunch racing a slow quit
 * can hit a transient overlap where a previous process still holds the exclusive
 * OS lock on graph.ryugraph. A raw driver open in a CHILD process reproduces that
 * lock; this pins that (1) openRyuGraphEngine then rejects with the probe-verified
 * "Could not set lock on file" message isLockContentionError recognises, and
 * (2) openRyuGraphEngineWithLockRetry backs off and succeeds once the child
 * releases the lock — so a single transient overlap no longer bricks storage.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { type ChildProcess, spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import {
  isLockContentionError,
  openRyuGraphEngine,
  openRyuGraphEngineWithLockRetry
} from '../../src/main/storage'
import { EXTENSIONS_DIR } from './helpers'

const HOLDER = fileURLToPath(new URL('../fixtures/graph-lock-holder.mjs', import.meta.url))

let baseDir: string
let graphDir: string
let backupsDir: string
let holder: ChildProcess | null = null

const graphFile = (): string => join(graphDir, 'graph.ryugraph')
const open = () => openRyuGraphEngine({ graphDir, backupsDir, extensionsDir: EXTENSIONS_DIR })

/** Seed a real, checkpointed graph (writes the schema sidecar) so the parent
 *  open SKIPS the pre-migration backup and hits the clean lock error path. */
async function seedGraph(): Promise<void> {
  const engine = await open()
  await engine.upsertNode('Tag', { id: 'seed', name: 'seeded', is_global: true })
  await engine.close()
}

/** Spawn the child holder and resolve once it reports the lock is held. */
function spawnHolder(): Promise<ChildProcess> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [HOLDER, graphFile()], { stdio: ['pipe', 'pipe', 'inherit'] })
    let buf = ''
    child.stdout?.on('data', (d: Buffer) => {
      buf += d.toString()
      if (buf.includes('LOCKED')) resolve(child)
      else if (buf.includes('HOLDER_ERROR')) reject(new Error(buf))
    })
    child.on('exit', (code) => {
      if (!buf.includes('LOCKED')) reject(new Error(`holder exited early (code=${code})`))
    })
  })
}

beforeEach(() => {
  baseDir = mkdtempSync(join(tmpdir(), 'agentic-os-lockretry-'))
  graphDir = join(baseDir, 'graph')
  backupsDir = join(baseDir, 'backups')
  holder = null
})
afterEach(() => {
  if (holder !== null && holder.exitCode === null) holder.kill('SIGKILL')
  // A skipDatabaseClose engine leaks the Database handle; force-rm and ignore a
  // Windows EBUSY on the leaked handle (the temp dir goes on the next boot/GC).
  try {
    rmSync(baseDir, { recursive: true, force: true })
  } catch {
    /* best-effort temp cleanup */
  }
})

describe('graph open under lock contention', () => {
  it('a second open while another process holds the graph fails with the pinned lock message', async () => {
    await seedGraph()
    holder = await spawnHolder()

    let captured: unknown
    await expect(open()).rejects.toThrow(/could not set lock on file/i)
    try {
      await open()
    } catch (err) {
      captured = err
    }
    expect(isLockContentionError(captured)).toBe(true)
  })

  it('openRyuGraphEngineWithLockRetry retries and succeeds once the holder releases the lock', async () => {
    await seedGraph()
    holder = await spawnHolder()
    const log = vi.fn()

    // Short backoff so the test is quick; kill the holder mid-retry so a later
    // attempt lands after the OS releases the lock.
    const openPromise = openRyuGraphEngineWithLockRetry(
      { graphDir, backupsDir, extensionsDir: EXTENSIONS_DIR },
      { log, delaysMs: [250, 250, 250, 250, 250, 250] }
    )
    // Release the lock mid-retry so a later attempt lands. Guarded: if the open
    // already resolved and the holder is gone, skip the write (no EPIPE).
    const releaseTimer = setTimeout(() => {
      if (holder !== null && holder.exitCode === null) holder.stdin?.write('CLOSE\n')
    }, 300)

    const engine = await openPromise
    clearTimeout(releaseTimer)
    try {
      // Recovered on the fresh handle: the seeded node is readable.
      const rows = await engine.cypher("MATCH (t:Tag {id: 'seed'}) RETURN t.name AS name")
      expect(rows[0]?.['name']).toBe('seeded')
      // At least one retry was logged (the first attempt hit the held lock).
      expect(log).toHaveBeenCalled()
    } finally {
      // skipDatabaseClose mirrors the app's quit path and dodges the ryugraph
      // 25.9.1 native teardown segfault (Database.closeSync poisons process exit).
      await engine.close({ skipDatabaseClose: true })
    }
  }, 20_000)
})
