/**
 * Child process for the phase-11 queue kill test (DoD: kill the app with 3
 * queued tasks → restart → all 3 run). Bundled with esbuild and spawned under
 * plain node by tests/integration/triggers.queue.kill.test.ts.
 *
 * Behavior: open the given appdata.db, enqueue 3 'marker' tasks, start the
 * queue. The handler prints a handshake when the FIRST task begins and then
 * blocks forever — the parent SIGKILLs this process mid-task-1, leaving task
 * 1 'running' and tasks 2/3 'pending' in the durable mirror. The parent then
 * drains the same mirror with a fresh queue and asserts all 3 marker files.
 */
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { openAppData } from '../../src/main/storage'
import { DurableTaskQueue } from '../../src/main/triggers'

export const QUEUE_KILL_HANDSHAKE = 'FIRST_TASK_RUNNING'
export const QUEUE_TASK_IDS = ['marker-1', 'marker-2', 'marker-3'] as const

async function main(): Promise<void> {
  const [, , dbPath, outDir] = process.argv
  if (!dbPath || !outDir) throw new Error('usage: queue-kill-child <dbPath> <outDir>')
  const appData = openAppData(dbPath)
  const queue = new DurableTaskQueue({ db: appData.db })
  queue.registerHandler('marker', (payload) => {
    const tag = String(payload['tag'])
    writeFileSync(join(outDir, `${tag}.started`), tag, 'utf8')
    console.log(`${QUEUE_KILL_HANDSHAKE} ${tag}`)
    // Block forever: the parent kills us mid-task. The marker file above
    // proves the task STARTED; completion markers are the parent's job.
    return new Promise(() => undefined)
  })
  for (const id of QUEUE_TASK_IDS) {
    queue.enqueue({ id, kind: 'marker', payload: { tag: id } })
  }
  queue.start()
  // Keep the event loop alive until SIGKILL.
  setInterval(() => undefined, 60_000)
}

main().catch((err: unknown) => {
  console.error(err)
  process.exit(1)
})
