/**
 * Phase-11 DoD 1, the hard way: a REAL process holding a queue with 3
 * enqueued tasks is SIGKILLed while task 1 is mid-run. A fresh queue over the
 * same appdata.db (this test = the "restarted app") reloads the mirror —
 * task 1 was 'running' (crashed mid-run), tasks 2/3 'pending' — and ALL 3
 * run to completion.
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { openAppData, type AppData } from '../../src/main/storage'
import { DurableTaskQueue } from '../../src/main/triggers'

const repoRoot = fileURLToPath(new URL('../..', import.meta.url))
const TASK_IDS = ['marker-1', 'marker-2', 'marker-3'] as const

let baseDir: string
let childBundle: string
let appData: AppData | undefined
let drainQueue: DurableTaskQueue | undefined

beforeAll(async () => {
  baseDir = mkdtempSync(join(tmpdir(), 'agentic-os-queue-kill-'))
  const esbuild = await import('esbuild')
  const outDir = join(repoRoot, 'out', 'test-child')
  mkdirSync(outDir, { recursive: true })
  childBundle = join(outDir, 'queue-kill-child.mjs')
  await esbuild.build({
    entryPoints: [join(repoRoot, 'tests', 'fixtures', 'queue-kill-child.ts')],
    outfile: childBundle,
    bundle: true,
    platform: 'node',
    format: 'esm',
    packages: 'external',
    logLevel: 'silent'
  })
})

afterAll(async () => {
  await drainQueue?.stop(0)
  appData?.close()
  rmSync(baseDir, { recursive: true, force: true })
})

function waitForHandshake(child: ChildProcess, marker: string, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    let stdout = ''
    let stderr = ''
    const timer = setTimeout(
      () => reject(new Error(`no '${marker}' handshake in ${timeoutMs}ms\nstdout: ${stdout}\nstderr: ${stderr}`)),
      timeoutMs
    )
    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString()
      if (stdout.includes(marker)) {
        clearTimeout(timer)
        resolve()
      }
    })
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString()
    })
    child.on('exit', (code) =>
      reject(new Error(`child exited early (code ${code})\nstdout: ${stdout}\nstderr: ${stderr}`))
    )
  })
}

describe('queue survives SIGKILL with queued tasks (§8 durability, phase DoD)', () => {
  it('kill mid-task-1 with 3 enqueued → restart → all 3 run', async () => {
    const dbPath = join(baseDir, 'appdata.db')
    const markersDir = join(baseDir, 'markers')
    mkdirSync(markersDir, { recursive: true })

    // Phase A: the "app" enqueues 3 tasks and dies mid-task-1.
    const child = spawn(process.execPath, [childBundle, dbPath, markersDir], {
      cwd: repoRoot,
      stdio: ['ignore', 'pipe', 'pipe']
    })
    await waitForHandshake(child, 'FIRST_TASK_RUNNING', 30_000)
    child.removeAllListeners('exit')
    child.kill('SIGKILL')
    await new Promise<void>((resolve) => child.on('exit', () => resolve()))

    // The durable mirror holds the crash state: one running, two pending.
    appData = openAppData(dbPath)
    const states = appData.db
      .prepare(`SELECT id, status FROM tasks WHERE kind = 'marker' ORDER BY id`)
      .all() as { id: string; status: string }[]
    expect(states.map((r) => r.id)).toEqual([...TASK_IDS])
    expect(states.map((r) => r.status).sort()).toEqual(['pending', 'pending', 'running'])

    // Phase B: the "restarted app" — a fresh queue over the same db.
    const completed: string[] = []
    drainQueue = new DurableTaskQueue({ db: appData.db })
    drainQueue.registerHandler('marker', (payload) => {
      completed.push(String(payload['tag']))
      return Promise.resolve()
    })
    const { reloaded } = drainQueue.start()
    expect(reloaded).toBe(3)

    const deadline = Date.now() + 15_000
    while (completed.length < 3 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
    expect(completed.sort()).toEqual([...TASK_IDS])
    for (const id of TASK_IDS) {
      const row = appData.db.prepare('SELECT status, attempts FROM tasks WHERE id = ?').get(id) as {
        status: string
        attempts: number
      }
      expect(row.status).toBe('done')
      expect(row.attempts).toBeGreaterThanOrEqual(1)
    }
    // Task 1 really was mid-run when killed (its started marker exists).
    expect(existsSync(join(markersDir, 'marker-1.started'))).toBe(true)
  }, 60_000)
})
