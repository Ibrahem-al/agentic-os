import { afterEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  collectAssets,
  dataManifestPath,
  readDataManifest,
  verifyDataManifest,
  writeDataManifest,
  type ManifestAsset
} from '../../src/main/storage/manifest'

/**
 * Drives the electron-free manifest module against a mkdtemp dir — the twin of
 * the AGENTIC_OS_USER_DATA_DIR seam. Never touches real userData.
 */
function seedUserData(dir: string): void {
  mkdirSync(join(dir, 'graph'), { recursive: true })
  writeFileSync(join(dir, 'graph', 'graph.ryugraph'), 'x'.repeat(4096))
  writeFileSync(join(dir, 'graph', 'schema-version.json'), JSON.stringify({ version: 1 }))
  writeFileSync(join(dir, 'appdata.db'), Buffer.alloc(2048, 7))
  writeFileSync(join(dir, 'keychain.bin'), Buffer.from('ciphertext'))
  writeFileSync(join(dir, 'settings.json'), '{}')
  mkdirSync(join(dir, 'models'), { recursive: true })
  writeFileSync(join(dir, 'models', 'reranker.onnx'), 'y'.repeat(10_000))
}

const asset = (assets: readonly ManifestAsset[], path: string): ManifestAsset => {
  const a = assets.find((x) => x.path === path)
  if (a === undefined) throw new Error(`no asset ${path}`)
  return a
}

describe('data-manifest.json (§3 machine-readable note)', () => {
  let dir: string
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('write→read roundtrip preserves schema versions + asset inventory', () => {
    dir = mkdtempSync(join(tmpdir(), 'manifest-'))
    seedUserData(dir)
    const written = writeDataManifest(dir, { appVersion: '0.1.0', appdataUserVersion: 7, graphSchemaVersion: 1 })
    expect(written.manifestVersion).toBe(1)
    expect(written.product).toBe('agentic-os')

    const read = readDataManifest(dir)
    expect(read).not.toBeNull()
    expect(read?.schema).toEqual({ appdataUserVersion: 7, graphSchemaVersion: 1 })
    expect(read?.appVersion).toBe('0.1.0')
    // Inventory carries the seeded assets with live sizes.
    const graph = asset(read?.assets ?? [], 'graph')
    expect(graph).toMatchObject({ kind: 'dir', exists: true })
    expect(graph.files).toBe(2)
    expect(graph.bytes).toBeGreaterThan(4096)
    expect(asset(read?.assets ?? [], 'appdata.db')).toMatchObject({ kind: 'file', exists: true, bytes: 2048 })
    // A file that was never created is recorded absent, not omitted.
    expect(asset(read?.assets ?? [], 'mcp-servers.json')).toMatchObject({ exists: false, bytes: 0 })
    expect(read?.events.lastResetAt).toBeNull()
    expect(read?.events.lastResetBackupDir).toBeNull()
  })

  it('marks graph/appdata.db/keychain.bin critical and models redownloadable', () => {
    dir = mkdtempSync(join(tmpdir(), 'manifest-'))
    seedUserData(dir)
    const assets = collectAssets(dir)
    expect(asset(assets, 'graph').critical).toBe(true)
    expect(asset(assets, 'appdata.db').critical).toBe(true)
    expect(asset(assets, 'keychain.bin').critical).toBe(true)
    expect(asset(assets, 'settings.json').critical).toBe(false)
    const models = asset(assets, 'models')
    expect(models.critical).toBe(false)
    expect(models.redownloadable).toBe(true)
    // Only models is redownloadable.
    expect(assets.filter((a) => a.redownloadable === true).map((a) => a.path)).toEqual(['models'])
  })

  it('backups.latest picks the lexicographically newest stamp dir', () => {
    dir = mkdtempSync(join(tmpdir(), 'manifest-'))
    seedUserData(dir)
    mkdirSync(join(dir, 'backups', '2026-01-01T00-00-00Z-pre-migration-v1'), { recursive: true })
    mkdirSync(join(dir, 'backups', '2026-07-06T11-59-00Z-pre-reset'), { recursive: true })
    mkdirSync(join(dir, 'backups', '2026-03-15T08-30-00Z-pre-appdata-v7'), { recursive: true })
    const m = writeDataManifest(dir, { appVersion: '0.1.0', appdataUserVersion: 7, graphSchemaVersion: 1 })
    expect(m.backups.count).toBe(3)
    expect(m.backups.latest).toBe('backups/2026-07-06T11-59-00Z-pre-reset')
  })

  it('writes atomically — no tmp file survives', () => {
    dir = mkdtempSync(join(tmpdir(), 'manifest-'))
    seedUserData(dir)
    writeDataManifest(dir, { appVersion: '0.1.0', appdataUserVersion: 7, graphSchemaVersion: 1 })
    const leftovers = readdirSync(dir).filter((n) => n.startsWith('data-manifest.json.tmp'))
    expect(leftovers).toEqual([])
    // The real file exists.
    expect(readdirSync(dir)).toContain('data-manifest.json')
  })

  it('records lastResetAt/lastResetBackupDir when a reset just happened', () => {
    dir = mkdtempSync(join(tmpdir(), 'manifest-'))
    seedUserData(dir)
    const m = writeDataManifest(dir, {
      appVersion: '0.1.0',
      appdataUserVersion: 7,
      graphSchemaVersion: 1,
      lastResetAt: '2026-07-06T12:00:00.000Z',
      lastResetBackupDir: '/x/backups/2026-07-06T11-59-00Z-pre-reset'
    })
    expect(m.events.lastResetAt).toBe('2026-07-06T12:00:00.000Z')
    expect(m.events.lastResetBackupDir).toBe('/x/backups/2026-07-06T11-59-00Z-pre-reset')
  })

  describe('verifyDataManifest', () => {
    it('returns [] on a fresh dir with no prior manifest', () => {
      dir = mkdtempSync(join(tmpdir(), 'manifest-'))
      seedUserData(dir)
      expect(verifyDataManifest(dir)).toEqual([])
    })

    it('flags a critical asset the manifest recorded present but is now gone', () => {
      dir = mkdtempSync(join(tmpdir(), 'manifest-'))
      seedUserData(dir)
      writeDataManifest(dir, { appVersion: '0.1.0', appdataUserVersion: 7, graphSchemaVersion: 1 })
      // Simulate a bad update that lost the graph.
      rmSync(join(dir, 'graph'), { recursive: true, force: true })
      const findings = verifyDataManifest(dir)
      expect(findings).toHaveLength(1)
      expect(findings[0]?.path).toBe('graph')
      expect(findings[0]?.detail).toMatch(/MISSING/)
    })

    it('does NOT flag a non-critical asset that disappeared', () => {
      dir = mkdtempSync(join(tmpdir(), 'manifest-'))
      seedUserData(dir)
      writeDataManifest(dir, { appVersion: '0.1.0', appdataUserVersion: 7, graphSchemaVersion: 1 })
      rmSync(join(dir, 'models'), { recursive: true, force: true }) // redownloadable, non-critical
      expect(verifyDataManifest(dir)).toEqual([])
    })
  })

  it('readDataManifest returns null on garbage JSON', () => {
    dir = mkdtempSync(join(tmpdir(), 'manifest-'))
    writeFileSync(dataManifestPath(dir), 'this is not json {{{')
    expect(readDataManifest(dir)).toBeNull()
  })
})
