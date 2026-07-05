/**
 * Phase-08 DoD self-test (bundled + run by hand at phase end, not a test):
 * run the extraction agent over a synthetic finished session — real qwen3
 * fuzzy passes (schema-constrained), real bge-m3 resolution embeddings —
 * against a scratch store, then print the session's graph and review queue.
 *
 * Usage:
 *   esbuild-bundle → node extraction-selftest.mjs <scratchDir>
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createExtractionAgent, sessionNodeIdOf } from '../../src/main/agents'
import { RYU_EXTENSION_VERSION_DIR } from '../../src/main/config'
import { Kernel, LangGraphRunner, createAuditLogStub } from '../../src/main/kernel'
import { OllamaClient } from '../../src/main/models'
import { openAppData, openRyuGraphEngine } from '../../src/main/storage'
import { createTelemetry } from '../../src/main/telemetry'

const repoRoot = fileURLToPath(new URL('../..', import.meta.url))

async function main(): Promise<void> {
  const scratchDir = process.argv[2]
  if (!scratchDir) throw new Error('usage: node extraction-selftest.mjs <scratchDir>')
  mkdirSync(scratchDir, { recursive: true })

  const engine = await openRyuGraphEngine({
    graphDir: join(scratchDir, 'graph'),
    backupsDir: join(scratchDir, 'backups'),
    extensionsDir: join(repoRoot, 'resources', 'extensions', RYU_EXTENSION_VERSION_DIR)
  })
  const appData = openAppData(join(scratchDir, 'appdata.db'))
  const telemetry = createTelemetry(appData.db)
  const kernel = new Kernel({ telemetry, audit: createAuditLogStub() })
  const runner = new LangGraphRunner({ db: appData.db, telemetry, executor: kernel })
  const ollama = new OllamaClient()

  // A skill the session uses (extraction matches existing skills only).
  await engine.upsertNode('Skill', {
    id: 's-deploy',
    name: 'deploy-web',
    instructions: 'Deploy web apps safely.',
    embedding: (await ollama.embed(['deploy-web: Deploy web apps safely.']))[0]!
  })

  // Synthetic backbone + transcript for a finished session.
  const sessionId = 'selftest-session'
  const t0 = Date.now() - 30 * 60_000
  const insert = appData.db.prepare(
    `INSERT INTO mcp_calls (session_id, tool, params_json, args_hash, result_status, started_unix_ms, duration_ms)
     VALUES (?, ?, ?, 'sha256:selftest', 'ok', ?, 300)`
  )
  insert.run(sessionId, 'get_context', JSON.stringify({ task: 'payments webhook work' }), t0)
  insert.run(sessionId, 'get_skill', JSON.stringify({ name: 'deploy-web' }), t0 + 60_000)

  const cwd = join(scratchDir, 'shop-backend')
  const records = [
    {
      type: 'user',
      message: {
        role: 'user',
        content:
          'Set up the payments webhook handler route. I prefer pnpm over npm for installing packages in this repo — always use pnpm here.'
      },
      cwd,
      timestamp: new Date(t0).toISOString(),
      sessionId
    },
    {
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [
          { type: 'text', text: 'Using pnpm. I created the payments webhook handler route and wired it to the payment service.' },
          { type: 'tool_use', id: 'toolu_1', name: 'mcp__vercel__deploy', input: { project: 'shop' } },
          { type: 'tool_use', id: 'toolu_2', name: 'Skill', input: { skill: 'deploy-web' } }
        ]
      },
      timestamp: new Date(t0 + 5 * 60_000).toISOString()
    },
    {
      type: 'user',
      message: {
        role: 'user',
        content: 'No, stop putting secrets in the config file — always load secrets from environment variables instead.'
      },
      timestamp: new Date(t0 + 10 * 60_000).toISOString()
    },
    {
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'text', text: 'Understood — secrets move to environment variables.' }] },
      timestamp: new Date(t0 + 11 * 60_000).toISOString()
    }
  ]
  const transcriptPath = join(scratchDir, 'selftest-session.jsonl')
  writeFileSync(transcriptPath, `${records.map((r) => JSON.stringify(r)).join('\n')}\n`, 'utf8')

  const agent = createExtractionAgent({ engine, db: appData.db, runner, embedder: ollama, llm: ollama, cloud: null })

  console.log('[selftest] running extraction (real qwen3 fuzzy passes + bge-m3 resolution)…')
  const started = Date.now()
  const result = await agent.runExtraction(sessionId, { transcriptPath })
  console.log(`[selftest] extraction done in ${((Date.now() - started) / 1000).toFixed(1)}s — job ${result.jobId}`)
  console.log(`[selftest] tier=${result.tier} escalated=${result.escalated} committed=${JSON.stringify(result.committed)}`)
  console.log(`[selftest] staged=${result.staged.count} warnings=${result.warnings.length}`)
  for (const warning of result.warnings) console.log(`[selftest]   warning: ${warning}`)

  const sessionNodeId = sessionNodeIdOf(sessionId)
  const sessionRows = await engine.cypher(
    'MATCH (s:Session {id: $id}) RETURN s.started_at AS sa, s.ended_at AS ea, s.tier AS tier',
    { id: sessionNodeId }
  )
  console.log(`[selftest] Session node: ${JSON.stringify(sessionRows[0])}`)
  for (const [type, to] of [
    ['USED', 'Skill'],
    ['USED', 'MCP'],
    ['PRODUCED', 'Project']
  ] as const) {
    const rows = await engine.cypher(
      `MATCH (s:Session {id: $id})-[r:${type}]->(n:${to}) RETURN n.id AS id, n.name AS name, r.extracted_by AS eb, r.confidence AS c`,
      { id: sessionNodeId }
    )
    for (const row of rows) {
      console.log(`[selftest]   (Session)-[:${type} ${row['eb']} conf=${row['c']}]-> (${to} ${row['id']} '${row['name']}')`)
    }
  }
  for (const label of ['Component', 'Preference', 'Correction'] as const) {
    const prop = label === 'Component' ? 'name' : label === 'Preference' ? 'statement' : 'content'
    const provenance = label === 'Correction' ? '' : ', n.extracted_by AS eb, n.confidence AS c'
    const rows = await engine.cypher(`MATCH (n:${label}) RETURN n.${prop} AS text${provenance}`)
    for (const row of rows) {
      const stamp = label === 'Correction' ? '(provenance on edges)' : `${row['eb']} conf=${row['c']}`
      console.log(`[selftest]   ${label}: '${row['text']}' ${stamp}`)
    }
  }
  const staged = appData.db.prepare(`SELECT target_label, payload_json FROM staged_writes`).all() as {
    target_label: string
    payload_json: string
  }[]
  for (const row of staged) {
    const payload = JSON.parse(row.payload_json) as { node?: { props?: Record<string, unknown> }; reason?: string }
    console.log(`[selftest]   staged ${row.target_label}: ${JSON.stringify(payload.node?.props)} — ${payload.reason}`)
  }

  await telemetry.shutdown()
  appData.close()
  // Same close discipline as the app quit path: ryugraph 25.9.1 segfaults in
  // native teardown after Database.close(); leaking the handle at process
  // exit is safe (phase-01) and keeps this demo's exit code clean.
  await engine.close({ skipDatabaseClose: true })
  console.log('[selftest] done')
}

main().catch((err) => {
  console.error('[selftest] FAILED', err)
  process.exitCode = 1
})
