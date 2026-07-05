/**
 * DoD 1, the hard half: a REAL process running the 3-step demo workflow is
 * SIGKILLed mid-step-2; a fresh process (this test) re-instantiates the
 * runner over the same appdata.db, calls resume(jobId), and the workflow
 * completes — step 1 is NOT re-executed (its checkpoint survived the kill),
 * step 2+3 run here. Spans from both processes share one trace (DoD 2).
 *
 * The child is tests/fixtures/workflow-kill-child.ts, bundled with esbuild
 * (same pattern as scripts/ci/electron-keychain-check.cjs) and spawned under
 * plain node.
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { allowAllPermissions, Kernel, LangGraphRunner } from '../../src/main/kernel'
import { openAppData, type AppData } from '../../src/main/storage'
import { createTelemetry, type Telemetry } from '../../src/main/telemetry'
import { DEMO_WORKFLOW_NAME, STEP2_HANDSHAKE, demoSteps } from '../fixtures/demo-workflow'
import { spanAttributes, spanRows } from '../fixtures/kernel-helpers'

const repoRoot = fileURLToPath(new URL('../..', import.meta.url))
const JOB_ID = 'kill-resume-1'

let baseDir: string
let childBundle: string
let appData: AppData | undefined
let telemetry: Telemetry | undefined

beforeAll(async () => {
  baseDir = mkdtempSync(join(tmpdir(), 'agentic-os-kill-'))
  // Bundle the child inside the repo so its externalized imports resolve
  // against node_modules; out/ is build output (gitignored).
  const esbuild = await import('esbuild')
  const outDir = join(repoRoot, 'out', 'test-child')
  mkdirSync(outDir, { recursive: true })
  childBundle = join(outDir, 'workflow-kill-child.mjs')
  await esbuild.build({
    entryPoints: [join(repoRoot, 'tests', 'fixtures', 'workflow-kill-child.ts')],
    outfile: childBundle,
    bundle: true,
    platform: 'node',
    format: 'esm',
    packages: 'external',
    logLevel: 'silent'
  })
})

afterAll(async () => {
  await telemetry?.shutdown()
  appData?.close()
  rmSync(baseDir, { recursive: true, force: true })
})

function waitForHandshake(child: ChildProcess, marker: string, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => {
      reject(new Error(`child did not print ${marker} within ${timeoutMs}ms\nstdout: ${stdout}\nstderr: ${stderr}`))
    }, timeoutMs)
    child.stdout!.on('data', (chunk: Buffer) => {
      stdout += chunk.toString()
      if (stdout.includes(marker)) {
        clearTimeout(timer)
        resolve(stdout)
      }
    })
    child.stderr!.on('data', (chunk: Buffer) => {
      stderr += chunk.toString()
    })
    child.on('exit', (code) => {
      clearTimeout(timer)
      reject(new Error(`child exited early (code ${code}) before ${marker}\nstdout: ${stdout}\nstderr: ${stderr}`))
    })
  })
}

describe('kill mid-step-2 → re-instantiate → resume (DoD 1)', () => {
  it('completes the workflow after a real SIGKILL, without re-running step 1', async () => {
    const logFile = join(baseDir, 'steps.log')

    // 1. Child process: starts the demo workflow, blocks inside step 2.
    const child = spawn(process.execPath, [childBundle, baseDir, JOB_ID, logFile], {
      cwd: repoRoot,
      stdio: ['ignore', 'pipe', 'pipe']
    })
    await waitForHandshake(child, STEP2_HANDSHAKE, 20_000)

    // 2. SIGKILL — no cleanup, no checkpoint of step 2.
    child.kill('SIGKILL')
    await new Promise<void>((resolve) => child.on('exit', () => resolve()))

    const logAfterKill = readFileSync(logFile, 'utf8').trim().split('\n')
    expect(logAfterKill).toEqual(['fetch', 'process-start'])

    // 3. Real re-instantiation: fresh db handle, fresh telemetry, fresh
    //    kernel + runner in THIS process; re-register the definition with a
    //    working step 2 and resume.
    appData = openAppData(join(baseDir, 'appdata.db'))
    telemetry = createTelemetry(appData.db)
    const runner = new LangGraphRunner({
      db: appData.db,
      telemetry,
      executor: new Kernel({ telemetry, permissions: allowAllPermissions() })
    })
    const log: string[] = []
    runner.define(DEMO_WORKFLOW_NAME, demoSteps((line) => log.push(line), 'run'))

    const job = await runner.getJob(JOB_ID)
    expect(job).toBeDefined()
    expect(job!.status).toBe('running') // the kill left it mid-flight
    expect(job!.state).toEqual({ seed: 7, fetched: 'payload-7' }) // step 1 checkpoint survived

    await runner.resume(JOB_ID)

    // 4. Completed: steps 2+3 ran HERE, step 1 did not re-run anywhere.
    expect(log).toEqual(['process', 'finalize'])
    const fullLog = readFileSync(logFile, 'utf8').trim().split('\n')
    expect(fullLog.filter((line) => line === 'fetch')).toHaveLength(1)

    const finished = await runner.getJob(JOB_ID)
    expect(finished!.status).toBe('done')
    expect(finished!.attempts).toBe(2)
    expect(finished!.nextSteps).toEqual([])
    expect(finished!.state).toEqual({
      seed: 7,
      fetched: 'payload-7',
      processed: 'payload-7-processed',
      finalized: true,
      summary: 'payload-7-processed-done'
    })

    // 5. One trace across both processes (DoD 2): the child's step-1 span and
    //    this process's resume + step spans share the trace id; the resume
    //    span is parented on the child's (never-ended, hence row-less) root
    //    span, whose id the step-1 span recorded as its parent.
    const stepSpans = spanRows(appData, 'kernel.workflow-step')
    const childFetchSpan = stepSpans.find((s) => spanAttributes(s)['action.name'] === 'fetch')
    expect(childFetchSpan).toBeDefined() // written by the killed process
    const resumeSpans = spanRows(appData, 'workflow.resume')
    expect(resumeSpans).toHaveLength(1)
    expect(resumeSpans[0]!.trace_id).toBe(childFetchSpan!.trace_id)
    expect(resumeSpans[0]!.parent_span_id).toBe(childFetchSpan!.parent_span_id)

    const resumedSteps = stepSpans.filter((s) => s.parent_span_id === resumeSpans[0]!.span_id)
    expect(resumedSteps.map((s) => spanAttributes(s)['action.name'])).toEqual(['process', 'finalize'])
    for (const span of resumedSteps) expect(span.trace_id).toBe(childFetchSpan!.trace_id)

    // The child's unfinished workflow.run root never produced a row.
    expect(spanRows(appData, 'workflow.run')).toHaveLength(0)
  }, 30_000)
})
