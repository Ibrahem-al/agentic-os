/**
 * Child process for the DoD kill/resume test (kernel.kill.test.ts bundles
 * this with esbuild and spawns it under plain node). It boots the real
 * phase-04 stack on the appdata.db the parent test owns, starts the demo
 * workflow with a BLOCKING step 2, prints the handshake, and hangs until the
 * parent SIGKILLs it mid-step-2.
 *
 * usage: node workflow-kill-child.mjs <baseDir> <jobId> <logFile>
 */
import { appendFileSync } from 'node:fs'
import { join } from 'node:path'
import { allowAllPermissions, Kernel, LangGraphRunner } from '../../src/main/kernel'
// The appdata module directly (not the storage barrel): the child must not
// load the RyuGraph engine just to run a workflow against SQLite.
import { openAppData } from '../../src/main/storage/appdata'
import { createTelemetry } from '../../src/main/telemetry'
import { DEMO_WORKFLOW_NAME, demoSteps } from './demo-workflow'

const [, , baseDir, jobId, logFile] = process.argv
if (baseDir === undefined || jobId === undefined || logFile === undefined) {
  console.error('usage: workflow-kill-child <baseDir> <jobId> <logFile>')
  process.exit(2)
}

const appData = openAppData(join(baseDir, 'appdata.db'))
const telemetry = createTelemetry(appData.db)
const kernel = new Kernel({ telemetry, permissions: allowAllPermissions() })
const runner = new LangGraphRunner({ db: appData.db, telemetry, executor: kernel })
runner.define(
  DEMO_WORKFLOW_NAME,
  demoSteps((line) => appendFileSync(logFile, `${line}\n`), 'block')
)
runner.run(DEMO_WORKFLOW_NAME, { seed: 7 }, { jobId }).catch((err: unknown) => {
  console.error('child run failed before kill:', err)
  process.exit(1)
})
// No exit: step 2 hangs forever; the parent SIGKILLs this process.
