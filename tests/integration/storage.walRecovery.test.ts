/**
 * Regression: a torn `graph.ryugraph.wal` from an unclean shutdown must not
 * brick storage (and, via the boot cascade, the whole app). openRyuGraphEngine
 * must quarantine the corrupt WAL and recover to the last checkpoint — the fix
 * for the "Corrupted wal file. Read out invalid WAL record type." field failure
 * that disconnected the database, MCP server, and every downstream subsystem.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { existsSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openRyuGraphEngine } from '../../src/main/storage'
import { EXTENSIONS_DIR } from './helpers'

let baseDir: string
let graphDir: string
let backupsDir: string

const open = (extensionsDir = EXTENSIONS_DIR) => openRyuGraphEngine({ graphDir, backupsDir, extensionsDir })
const walPath = () => join(graphDir, 'graph.ryugraph.wal')
const corruptWalDirs = () =>
  existsSync(backupsDir) ? readdirSync(backupsDir).filter((n) => n.endsWith('-corrupt-wal')) : []

/** Seed a real graph with a checkpointed survivor node, then close cleanly. */
async function seedGraph(): Promise<void> {
  const engine = await open()
  await engine.upsertNode('Tag', { id: 'survivor', name: 'kept-across-recovery', is_global: true })
  await engine.close() // checkpoints, then removes the WAL
  expect(existsSync(walPath())).toBe(false)
}

beforeEach(() => {
  baseDir = mkdtempSync(join(tmpdir(), 'agentic-os-walrec-'))
  graphDir = join(baseDir, 'graph')
  backupsDir = join(baseDir, 'backups')
})
afterEach(() => {
  rmSync(baseDir, { recursive: true, force: true })
})

describe('corrupt-WAL recovery on open', () => {
  it('quarantines a torn WAL and reopens at the last checkpoint', async () => {
    await seedGraph()
    // Simulate the crash artifact: a checksum-invalid WAL beside the good db.
    writeFileSync(walPath(), Buffer.alloc(8192, 0xff))

    const engine = await open() // WITHOUT the fix this rejects with "Corrupted wal file"
    try {
      // Recovered: the checkpointed data is intact.
      const survivor = await engine.cypher("MATCH (t:Tag {id: 'survivor'}) RETURN t.name AS name")
      expect(survivor[0]?.['name']).toBe('kept-across-recovery')

      // The torn WAL was quarantined (preserved, not deleted): the exact
      // 8192-byte file we planted now lives under backups/, moved out of the
      // graph dir so the reopen could recover. (The live engine writes a fresh,
      // valid WAL back into the graph dir — that one is expected.)
      expect(engine.walQuarantined).not.toBeNull()
      expect(engine.walQuarantined as string).toMatch(/-corrupt-wal$/)
      const quarantinedWal = join(engine.walQuarantined as string, 'graph.ryugraph.wal')
      expect(existsSync(quarantinedWal)).toBe(true)
      expect(statSync(quarantinedWal).size).toBe(8192)
      expect(corruptWalDirs()).toHaveLength(1)
    } finally {
      await engine.close()
    }
  })

  it('a clean reopen sets walQuarantined to null (no false quarantine)', async () => {
    await seedGraph()
    const engine = await open()
    try {
      expect(engine.walQuarantined).toBeNull()
      expect(corruptWalDirs()).toHaveLength(0)
    } finally {
      await engine.close()
    }
  })

  it('does NOT quarantine on a non-WAL open failure (a missing extension propagates)', async () => {
    await seedGraph()
    // The graph is intact (no corrupt WAL); the failure is a missing vendored
    // extension. Recovery is gated on the error being a corrupt-WAL error, so
    // this must propagate untouched and create no quarantine dir.
    await expect(open(join(baseDir, 'no-such-extensions'))).rejects.toThrow(/extension missing/i)
    expect(corruptWalDirs()).toHaveLength(0)
  })
})
