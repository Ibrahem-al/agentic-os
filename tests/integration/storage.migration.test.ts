/**
 * DoD: v1→v2 dummy migration runs once, is idempotent, and a file-copy backup
 * of the graph dir exists (taken before the db is opened — §21 rule 9).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MIGRATIONS, openRyuGraphEngine, type Migration } from '../../src/main/storage'
import { EXTENSIONS_DIR } from './helpers'

const dummyV2: Migration = {
  version: 2,
  name: 'dummy-v2',
  async up(ctx) {
    // Idempotent statements + a run counter: runs === applications.
    await ctx.cypher('CREATE NODE TABLE IF NOT EXISTS MigrationProbe(id STRING, runs INT64, PRIMARY KEY(id))')
    await ctx.cypher(
      "MERGE (p:MigrationProbe {id: 'v2'}) ON CREATE SET p.runs = 1 ON MATCH SET p.runs = p.runs + 1"
    )
  }
}

let baseDir: string
let graphDir: string
let backupsDir: string

const open = (migrations: readonly Migration[]) =>
  openRyuGraphEngine({ graphDir, backupsDir, extensionsDir: EXTENSIONS_DIR, migrations })

const backups = (): string[] => (existsSync(backupsDir) ? readdirSync(backupsDir) : [])
const sidecarVersion = (): number =>
  (JSON.parse(readFileSync(join(graphDir, 'schema-version.json'), 'utf8')) as { version: number }).version

beforeAll(() => {
  baseDir = mkdtempSync(join(tmpdir(), 'agentic-os-migration-'))
  graphDir = join(baseDir, 'graph')
  backupsDir = join(baseDir, 'backups')
})
afterAll(() => {
  rmSync(baseDir, { recursive: true, force: true })
})

describe('ordered migrations with pre-migration backup', () => {
  it('v1 on a fresh dir: applies, records version, takes no backup (nothing to copy)', async () => {
    const engine = await open(MIGRATIONS)
    try {
      expect(engine.schemaVersion).toBe(1)
      expect(engine.backupCreated).toBeNull()
      expect(backups()).toHaveLength(0)
      expect(sidecarVersion()).toBe(1)
      const versions = await engine.cypher('MATCH (v:SchemaVersion) RETURN v.version AS v ORDER BY v.version')
      expect(versions.map((r) => Number(r['v']))).toEqual([1])
      // Data that must survive the v2 migration:
      await engine.upsertNode('Tag', { id: 'pre-v2', name: 'survivor', is_global: true })
    } finally {
      await engine.close()
    }
  })

  it('v1→v2: backs up the graph dir first, applies v2 exactly once', async () => {
    const engine = await open([...MIGRATIONS, dummyV2])
    try {
      expect(engine.schemaVersion).toBe(2)
      // Backup exists and is a real file copy of the pre-v2 graph dir.
      expect(engine.backupCreated).not.toBeNull()
      const backupDirs = backups()
      expect(backupDirs).toHaveLength(1)
      expect(backupDirs[0]).toMatch(/pre-migration-v2/)
      expect(existsSync(join(backupsDir, backupDirs[0] as string, 'graph.ryugraph'))).toBe(true)
      expect(existsSync(join(backupsDir, backupDirs[0] as string, 'schema-version.json'))).toBe(true)

      const probe = await engine.cypher("MATCH (p:MigrationProbe {id: 'v2'}) RETURN p.runs AS runs")
      expect(Number(probe[0]?.['runs'])).toBe(1)
      const versions = await engine.cypher('MATCH (v:SchemaVersion) RETURN v.version AS v ORDER BY v.version')
      expect(versions.map((r) => Number(r['v']))).toEqual([1, 2])
      expect(sidecarVersion()).toBe(2)
      // Pre-migration data survived.
      const tag = await engine.cypher("MATCH (t:Tag {id: 'pre-v2'}) RETURN t.name AS name")
      expect(tag[0]?.['name']).toBe('survivor')
    } finally {
      await engine.close()
    }
  })

  it('re-running v1→v2 is a no-op: no re-application, no new backup', async () => {
    const engine = await open([...MIGRATIONS, dummyV2])
    try {
      expect(engine.schemaVersion).toBe(2)
      expect(engine.backupCreated).toBeNull()
      expect(backups()).toHaveLength(1) // still just the one
      const probe = await engine.cypher("MATCH (p:MigrationProbe {id: 'v2'}) RETURN p.runs AS runs")
      expect(Number(probe[0]?.['runs'])).toBe(1) // ran once, ever
    } finally {
      await engine.close()
    }
  })

  it('unknown on-disk version (lost sidecar) → defensive backup, no re-application', async () => {
    writeFileSync(join(graphDir, 'schema-version.json'), 'not json at all')
    const engine = await open([...MIGRATIONS, dummyV2])
    try {
      expect(engine.schemaVersion).toBe(2)
      expect(engine.backupCreated).not.toBeNull() // couldn't prove currency → backed up
      expect(backups()).toHaveLength(2)
      const probe = await engine.cypher("MATCH (p:MigrationProbe {id: 'v2'}) RETURN p.runs AS runs")
      expect(Number(probe[0]?.['runs'])).toBe(1) // graph knew better: still once
      expect(sidecarVersion()).toBe(2) // sidecar restored
    } finally {
      await engine.close()
    }
  })

  it('rejects malformed registries', async () => {
    await expect(open([dummyV2, { ...dummyV2 }])).rejects.toThrow(/duplicate migration version/)
    await expect(open([{ ...dummyV2, version: 0 }])).rejects.toThrow(/positive integer/)
  })
})
