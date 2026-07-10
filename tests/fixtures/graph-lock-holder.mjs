/**
 * Test fixture (fix/stack-reconnect): a throwaway child process that opens the
 * RyuGraph database and HOLDS the exclusive OS lock, so a parent test can
 * reproduce the boot-time lock-contention the retry wrapper recovers from.
 * RyuGraph acquires the exclusive file lock on the first WRITE (WAL creation) —
 * exactly how the real engine holds it after its migration write — so the holder
 * runs a trivial write against the seeded schema. Prints "LOCKED" once held;
 * releases the lock by exiting (the OS drops file locks on process exit) on a
 * "CLOSE" line over stdin or after a safety timeout. Uses the driver directly —
 * no TS/engine build needed.
 *
 * argv[2] = absolute path to <graphDir>/graph.ryugraph (schema already seeded)
 */
import { createRequire } from 'node:module'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import process from 'node:process'
import { setTimeout } from 'node:timers'

const require = createRequire(import.meta.url)
const file = process.argv[2]
if (!file) {
  process.stderr.write('graph-lock-holder: missing graph file path arg\n')
  process.exit(2)
}

// Module-level bindings keep the handles (and the OS lock) alive; never GC'd.
let db
let conn
try {
  mkdirSync(dirname(file), { recursive: true })
  const ryu = require('ryugraph')
  db = new ryu.Database(file)
  conn = new ryu.Connection(db)
  // A write takes the exclusive lock (the read/connection alone does not).
  await conn.query(
    "CREATE (:Tag {id: 'graph-lock-holder', created_at: timestamp('2020-01-01T00:00:00Z'), updated_at: timestamp('2020-01-01T00:00:00Z'), name: 'lock'})"
  )
  process.stdout.write('LOCKED\n')
} catch (err) {
  process.stdout.write(`HOLDER_ERROR ${err instanceof Error ? err.message : String(err)}\n`)
  process.exit(1)
}

// Release the lock on demand (exit drops the OS lock without a native close,
// dodging the ryugraph 25.9.1 teardown segfault).
process.stdin.on('data', (buf) => {
  if (buf.toString().includes('CLOSE')) process.exit(0)
})
// Safety net so a stray holder never lingers past a test run.
setTimeout(() => process.exit(0), 25_000)
