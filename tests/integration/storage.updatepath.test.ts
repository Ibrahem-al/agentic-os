/**
 * Phase-13 §3 "Updates & migration" proof: the update path runs migrations
 * WITH the pre-migration backup (via the AGENTIC_OS_TEST_MIGRATION_V2 probe
 * seam — registry resolved at open time), and a downgrade REFUSES to touch
 * the store (§21 rule 9).
 *
 * Lives in its own file (not storage.migration.test.ts) because of the
 * phase-08 one-RyuGraph-store-per-test-FILE rule: that file already runs its
 * own store through four open/close cycles; this file gets a fresh dir and
 * follows the same strictly-sequential open → close pattern.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { existsSync, readdirSync, readFileSync, rmSync, statSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { GraphSchemaNewerError, openRyuGraphEngine, UPDATE_PATH_PROBE_ENV } from '../../src/main/storage'
import { EXTENSIONS_DIR } from './helpers'

let baseDir: string
let graphDir: string
let backupsDir: string
let savedEnv: string | undefined

/** NO migrations override — exercises the open-time default registry. */
const openDefault = () => openRyuGraphEngine({ graphDir, backupsDir, extensionsDir: EXTENSIONS_DIR })

const backups = (): string[] => (existsSync(backupsDir) ? readdirSync(backupsDir) : [])
const sidecarPath = (): string => join(graphDir, 'schema-version.json')
const sidecarVersion = (): number =>
  (JSON.parse(readFileSync(sidecarPath(), 'utf8')) as { version: number }).version

/**
 * Untouched-store proof WITHOUT reading the live db files' contents: every
 * file's name + size + mtime, plus the exact bytes of the sidecar (the one
 * file a misbehaving open would legitimately rewrite; tiny JSON the engine
 * itself reads on every open — proven safe). Any write to any store file
 * changes size or mtime; create/delete changes the name list.
 *
 * Recorded phase-13 finding (same driver-fault family as phase-08's
 * one-store-per-file rule): CONTENT-reading the live RyuGraph store files
 * from the test process — readFileSync sweep, or even cpSync + hashing the
 * copies — makes the NEXT open of that store in this process die with a
 * native fault at its first query. Metadata stats do not.
 */
const storeSnapshot = (): string => {
  const parts: string[] = []
  for (const name of (readdirSync(graphDir, { recursive: true }) as string[]).map(String).sort()) {
    const path = join(graphDir, name)
    const stat = statSync(path)
    if (stat.isFile()) parts.push(`${name}|${stat.size}|${stat.mtimeMs}`)
  }
  parts.push(`sidecar:${readFileSync(sidecarPath(), 'utf8')}`)
  return parts.join('\n')
}

beforeAll(() => {
  baseDir = mkdtempSync(join(tmpdir(), 'agentic-os-updatepath-'))
  graphDir = join(baseDir, 'graph')
  backupsDir = join(baseDir, 'backups')
  savedEnv = process.env[UPDATE_PATH_PROBE_ENV]
  delete process.env[UPDATE_PATH_PROBE_ENV]
})
afterAll(() => {
  if (savedEnv === undefined) delete process.env[UPDATE_PATH_PROBE_ENV]
  else process.env[UPDATE_PATH_PROBE_ENV] = savedEnv
  rmSync(baseDir, { recursive: true, force: true })
})

describe('§3 update path (env-seam probe) and downgrade guard', () => {
  it('baseline launch: plain default registry lands the store at v1', async () => {
    const engine = await openDefault()
    try {
      expect(engine.schemaVersion).toBe(1)
      expect(engine.backupCreated).toBeNull()
      expect(backups()).toHaveLength(0)
      expect(sidecarVersion()).toBe(1)
      // Data that must survive "the update" untouched:
      await engine.upsertNode('Tag', { id: 'pre-update', name: 'survivor', is_global: true })
    } finally {
      await engine.close()
    }
  })

  it('"the update" (env set, no override): probe v1000 runs WITH the pre-migration backup', async () => {
    process.env[UPDATE_PATH_PROBE_ENV] = '1'
    try {
      const engine = await openDefault()
      try {
        expect(engine.schemaVersion).toBe(1000)
        expect(engine.backupCreated).not.toBeNull()
        expect(engine.backupCreated).toMatch(/pre-migration-v1000/)
        const backupDirs = backups()
        expect(backupDirs).toHaveLength(1)
        expect(backupDirs[0]).toMatch(/pre-migration-v1000/)
        // The backup is the PRE-update store: graph files + the v1 sidecar.
        const backup = join(backupsDir, backupDirs[0] as string)
        expect(existsSync(join(backup, 'graph.ryugraph'))).toBe(true)
        expect(
          (JSON.parse(readFileSync(join(backup, 'schema-version.json'), 'utf8')) as { version: number }).version
        ).toBe(1)
        // The probe table exists with its one row; the sidecar advanced.
        const probe = await engine.cypher('MATCH (p:UpdatePathProbe) RETURN count(p) AS c')
        expect(Number(probe[0]?.['c'])).toBe(1)
        expect(sidecarVersion()).toBe(1000)
        const tag = await engine.cypher("MATCH (t:Tag {id: 'pre-update'}) RETURN t.name AS name")
        expect(tag[0]?.['name']).toBe('survivor')
      } finally {
        await engine.close()
      }
    } finally {
      delete process.env[UPDATE_PATH_PROBE_ENV]
    }
  })

  it('downgrade (env cleared): refuses to open, store dir + sidecar untouched', async () => {
    const before = storeSnapshot()
    const err: unknown = await openDefault().then(
      () => null,
      (e: unknown) => e
    )
    expect(err).toBeInstanceOf(GraphSchemaNewerError)
    expect(String(err)).toMatch(/schema v1000, newer than this build understands \(v1\)/)
    // Refused BEFORE any write: no new backup, sidecar bytes + every file's
    // size/mtime identical.
    expect(backups()).toHaveLength(1)
    expect(sidecarVersion()).toBe(1000)
    expect(storeSnapshot()).toBe(before)
  })

  it('lost sidecar: the authoritative in-graph version still refuses, without rewriting the sidecar', async () => {
    rmSync(sidecarPath())
    const err: unknown = await openDefault().then(
      () => null,
      (e: unknown) => e
    )
    expect(err).toBeInstanceOf(GraphSchemaNewerError)
    expect(String(err)).toMatch(/schema v1000, newer than this build understands \(v1\)/)
    // The refusal happened before the sidecar-repair write.
    expect(existsSync(sidecarPath())).toBe(false)
    // Missing sidecar + data present → the defensive pre-open backup still ran.
    expect(backups()).toHaveLength(2)
    expect(backups().some((d) => /pre-migration-v1$/.test(d))).toBe(true)
  })

  it('recovery: a registry that understands v1000 reopens the untouched store', async () => {
    process.env[UPDATE_PATH_PROBE_ENV] = '1'
    try {
      const engine = await openDefault()
      try {
        expect(engine.schemaVersion).toBe(1000)
        expect(sidecarVersion()).toBe(1000) // sidecar restored
        const probe = await engine.cypher('MATCH (p:UpdatePathProbe) RETURN count(p) AS c')
        expect(Number(probe[0]?.['c'])).toBe(1) // probe never re-applied
        const tag = await engine.cypher("MATCH (t:Tag {id: 'pre-update'}) RETURN t.name AS name")
        expect(tag[0]?.['name']).toBe('survivor')
      } finally {
        await engine.close()
      }
    } finally {
      delete process.env[UPDATE_PATH_PROBE_ENV]
    }
  })
})
