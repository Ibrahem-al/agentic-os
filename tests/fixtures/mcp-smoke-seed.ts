/**
 * Manual-smoke seeding script (phase-05 DoD 3; bundled + run by hand at phase
 * end, not a test): seeds the retrieval fixture graph — with REAL bge-m3
 * embeddings via the local Ollama — into a scratch userData dir, so a real
 * Claude Code session connecting to `npm run dev` gets meaningful bundles.
 * Usage:
 *   esbuild-bundle → node mcp-smoke-seed.mjs <scratchUserDataDir>
 */
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { RYU_EXTENSION_VERSION_DIR } from '../../src/main/config'
import { OllamaClient } from '../../src/main/models'
import { openRyuGraphEngine } from '../../src/main/storage'
import { seedFixtureGraph } from './graph-seed'

const repoRoot = fileURLToPath(new URL('../..', import.meta.url))

async function main(): Promise<void> {
  const userDataDir = process.argv[2]
  if (!userDataDir) throw new Error('usage: node mcp-smoke-seed.mjs <scratchUserDataDir>')
  const engine = await openRyuGraphEngine({
    graphDir: join(userDataDir, 'graph'),
    backupsDir: join(userDataDir, 'backups'),
    extensionsDir: join(repoRoot, 'resources', 'extensions', RYU_EXTENSION_VERSION_DIR)
  })
  await seedFixtureGraph(engine, new OllamaClient())
  const counts = await engine.cypher('MATCH (n) RETURN count(n) AS c')
  console.log(`[smoke-seed] fixture graph seeded at ${userDataDir} — ${Number(counts[0]?.['c'] ?? 0)} nodes (real bge-m3 embeddings)`)
  await engine.close()
}

main().catch((err) => {
  console.error(err)
  process.exitCode = 1
})
