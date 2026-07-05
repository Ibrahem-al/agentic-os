/**
 * Report-evidence script (bundled + run by hand at phase end, not a test):
 * runs the 3-step demo workflow on a scratch appdata.db and prints the
 * resulting traces rows as a parent-child tree. Usage:
 *   esbuild-bundle → node span-evidence.mjs <scratchDir>
 */
import { join } from 'node:path'
import { allowAllPermissions, Kernel, LangGraphRunner } from '../../src/main/kernel'
import { openAppData } from '../../src/main/storage/appdata'
import { createTelemetry } from '../../src/main/telemetry'
import { DEMO_WORKFLOW_NAME, demoSteps } from './demo-workflow'

const baseDir = process.argv[2]
if (baseDir === undefined) throw new Error('usage: span-evidence <baseDir>')

const appData = openAppData(join(baseDir, 'appdata.db'))
const telemetry = createTelemetry(appData.db)
const runner = new LangGraphRunner({ db: appData.db, telemetry, executor: new Kernel({ telemetry, permissions: allowAllPermissions() }) })
runner.define(DEMO_WORKFLOW_NAME, demoSteps(() => undefined))

const jobId = await runner.run(DEMO_WORKFLOW_NAME, { seed: 42 }, { jobId: 'evidence-1', agentId: 'agent-demo' })
const rows = appData.db
  .prepare('SELECT trace_id, span_id, parent_span_id, name, status, end_unix_ms - start_unix_ms AS ms, attributes_json FROM traces ORDER BY id')
  .all() as {
  trace_id: string
  span_id: string
  parent_span_id: string | null
  name: string
  status: string
  ms: number
  attributes_json: string
}[]

console.log(`job ${jobId} done; traces rows: ${rows.length}`)
for (const row of rows) {
  const attrs = JSON.parse(row.attributes_json) as Record<string, unknown>
  const step = attrs['action.name'] !== undefined ? ` action=${String(attrs['action.name'])}` : ''
  console.log(
    `trace=${row.trace_id.slice(0, 8)}… span=${row.span_id} parent=${row.parent_span_id ?? '(root)'} ${row.name}${step} status=${row.status} ${row.ms}ms`
  )
}
const checkpoints = appData.db.prepare('SELECT count(*) AS c FROM workflow_checkpoints').get() as { c: number }
console.log(`workflow_checkpoints rows: ${checkpoints.c}`)
appData.close()
