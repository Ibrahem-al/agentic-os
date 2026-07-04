/**
 * Phase-07 DoD self-test (bundled + run by hand at phase end, not a test):
 * ingest THIS VERY REPO into a scratch store with the REAL local models
 * (bge-m3 embeddings, qwen3 README summary, int8 reranker for retrieval),
 * then report node/edge counts, sample DEPENDS_ON rows, and a
 * retrieve("how does ingestion work") bundle that must surface Components.
 *
 * Usage:
 *   esbuild-bundle → node codebase-selftest.mjs <scratchDir> <realModelsDir>
 */
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { RYU_EXTENSION_VERSION_DIR } from '../../src/main/config'
import { ingestCodebase } from '../../src/main/ingest'
import { OllamaClient, Reranker } from '../../src/main/models'
import { createRetriever } from '../../src/main/retrieval'
import { EDGE_TYPES, NODE_LABELS, openRyuGraphEngine } from '../../src/main/storage'

const repoRoot = fileURLToPath(new URL('../..', import.meta.url))

async function main(): Promise<void> {
  const scratchDir = process.argv[2]
  const modelsDir = process.argv[3]
  if (!scratchDir || !modelsDir) {
    throw new Error('usage: node codebase-selftest.mjs <scratchDir> <realModelsDir>')
  }

  const engine = await openRyuGraphEngine({
    graphDir: join(scratchDir, 'graph'),
    backupsDir: join(scratchDir, 'backups'),
    extensionsDir: join(repoRoot, 'resources', 'extensions', RYU_EXTENSION_VERSION_DIR)
  })
  const ollama = new OllamaClient()

  console.log(`[selftest] ingesting ${repoRoot} (real bge-m3 + qwen3 summary)`)
  const started = Date.now()
  const result = await ingestCodebase({ engine, embedder: ollama, llm: ollama }, repoRoot)
  console.log(`[selftest] ingest done in ${((Date.now() - started) / 1000).toFixed(1)}s`)
  console.log(
    `[selftest] project ${result.projectName} (${result.projectId}) status=${result.status} — ` +
      `${result.filesWalked} files walked, ${result.codeFilesParsed} code files parsed`
  )
  console.log(
    `[selftest] components: ${JSON.stringify(result.components)} — dependsOn: ${JSON.stringify(result.dependsOn)}`
  )
  console.log(
    `[selftest] knowledge: ${result.knowledge.documents.length} documents ` +
      `(${result.knowledge.documents.reduce((n, d) => n + d.chunkCount, 0)} chunks), ` +
      `${result.knowledge.failed.length} failed, ${result.skipped.length} files skipped`
  )
  const summary = await engine.cypher('MATCH (p:Project {id: $id}) RETURN p.summary AS s', { id: result.projectId })
  console.log(`[selftest] qwen3 summary: ${String(summary[0]?.['s'])}`)

  // Node/edge counts (the report's numbers).
  const nodeCounts: string[] = []
  for (const nodeLabel of NODE_LABELS) {
    const rows = await engine.cypher(`MATCH (n:${nodeLabel}) RETURN count(n) AS c`)
    const count = Number(rows[0]?.['c'] ?? 0)
    if (count > 0) nodeCounts.push(`${nodeLabel}=${count}`)
  }
  console.log('[selftest] node counts:', nodeCounts.join(' '))
  const edgeCounts: string[] = []
  for (const edgeType of EDGE_TYPES) {
    const rows = await engine.cypher(`MATCH ()-[r:${edgeType}]->() RETURN count(r) AS c`)
    const count = Number(rows[0]?.['c'] ?? 0)
    if (count > 0) edgeCounts.push(`${edgeType}=${count}`)
  }
  console.log('[selftest] edge counts:', edgeCounts.join(' '))

  // 3 sample DEPENDS_ON rows (DoD).
  const samples = await engine.cypher(
    `MATCH (c:Component)-[:DEPENDS_ON]->(d:Component)
     RETURN c.name AS f, d.name AS t ORDER BY c.name, d.name LIMIT 3`
  )
  console.log('[selftest] sample MATCH (c:Component)-[:DEPENDS_ON]->(d):')
  for (const row of samples) console.log(`[selftest]   ${String(row['f'])}  -[:DEPENDS_ON]->  ${String(row['t'])}`)

  // retrieve("how does ingestion work") must surface relevant Components (DoD).
  const reranker = new Reranker({ modelsDir })
  const retriever = createRetriever({ engine, embedder: ollama, reranker, llm: ollama })
  const bundle = await retriever.retrieve('how does ingestion work', [])
  console.log(
    `[selftest] retrieve("how does ingestion work") → confidence=${bundle.confidence} ` +
      `iterations=${bundle.iterations} items=${bundle.items.length}`
  )
  for (const item of bundle.items) {
    console.log(`[selftest]   ${item.label.padEnd(10)} ${item.id}  ${item.text.replace(/\s+/g, ' ').slice(0, 90)}`)
  }
  const componentCount = bundle.items.filter((i) => i.label === 'Component').length
  console.log(`[selftest] components in bundle: ${componentCount} ${componentCount > 0 ? 'PASS' : 'FAIL'}`)

  await reranker.unload()
  await engine.close()
}

main().catch((err) => {
  console.error(err)
  process.exitCode = 1
})
