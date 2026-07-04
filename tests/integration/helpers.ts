/**
 * Shared setup for storage integration tests: opens a real RyuGraphEngine on
 * a temp directory, loading the vendored extensions from the repo checkout.
 * All graph writes in tests go through the engine (write lane — §21 rule 1).
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { RYU_EXTENSION_VERSION_DIR } from '../../src/main/config'
import type { Migration } from '../../src/main/storage'
import { openRyuGraphEngine } from '../../src/main/storage'

const repoRoot = fileURLToPath(new URL('../..', import.meta.url))

/** Vendored extension root for the pinned version (absolute-path loads only). */
export const EXTENSIONS_DIR = join(repoRoot, 'resources', 'extensions', RYU_EXTENSION_VERSION_DIR)

export interface TestStore {
  engine: Awaited<ReturnType<typeof openRyuGraphEngine>>
  baseDir: string
  graphDir: string
  backupsDir: string
  exportsDir: string
  /** Full engine close + temp-dir removal. */
  cleanup(): Promise<void>
}

export async function openTestStore(migrations?: readonly Migration[]): Promise<TestStore> {
  const baseDir = mkdtempSync(join(tmpdir(), 'agentic-os-storage-'))
  const graphDir = join(baseDir, 'graph')
  const backupsDir = join(baseDir, 'backups')
  const exportsDir = join(baseDir, 'exports')
  const engine = await openRyuGraphEngine({
    graphDir,
    backupsDir,
    extensionsDir: EXTENSIONS_DIR,
    ...(migrations ? { migrations } : {})
  })
  return {
    engine,
    baseDir,
    graphDir,
    backupsDir,
    exportsDir,
    cleanup: async () => {
      await engine.close()
      rmSync(baseDir, { recursive: true, force: true })
    }
  }
}

/** Deterministic synthetic unit embedding: 1 at `axis`, 0 elsewhere. */
export function basisEmbedding(dim: number, axis: number): number[] {
  const v = new Array<number>(dim).fill(0)
  v[axis] = 1
  return v
}

/** Normalized blend of two basis axes (for graded cosine distances). */
export function blendEmbedding(dim: number, axisA: number, axisB: number, weightA: number): number[] {
  const v = new Array<number>(dim).fill(0)
  const weightB = 1 - weightA
  const norm = Math.hypot(weightA, weightB)
  v[axisA] = weightA / norm
  v[axisB] = weightB / norm
  return v
}
