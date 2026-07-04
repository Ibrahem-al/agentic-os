/**
 * Standalone runner for the RyuGraph spike — used by `npm run spike:ryugraph`
 * and by the CI offline extension-load check (where it is executed with
 * networking disabled: `unshare -n` on Linux, `sandbox-exec` deny-network on
 * macOS, an outbound firewall block on Windows).
 *
 * Run under Electron's Node runtime to prove the binding against Electron's
 * ABI:  ELECTRON_RUN_AS_NODE=1 <path-to-electron> scripts/spike/run-spike.cjs
 */
'use strict'

const fs = require('node:fs')
const path = require('node:path')
const { runRyugraphSpike } = require('./ryugraph-spike.cjs')

const dbDir = process.env.SPIKE_DB_DIR || path.join(__dirname, '..', '..', 'spike-data')

// Windows Electron is a GUI-subsystem binary, so stdout can vanish when it is
// used as the runtime (ELECTRON_RUN_AS_NODE) — mirror output to a file too.
const lines = []
const log = (line) => {
  lines.push(line)
  console.log(line)
}
const flush = () => {
  if (process.env.SPIKE_LOG_FILE) fs.writeFileSync(process.env.SPIKE_LOG_FILE, lines.join('\n') + '\n')
}

runRyugraphSpike(dbDir, log)
  .then((summary) => {
    log(`[spike] summary: ${JSON.stringify(summary, (_k, v) => (typeof v === 'bigint' ? Number(v) : v))}`)
    log(`[spike] runtime: electron=${process.versions.electron ?? 'none'} node=${process.versions.node}`)
    log('RYUGRAPH SPIKE PASS')
    flush()
    process.exit(0)
  })
  .catch((err) => {
    log('RYUGRAPH SPIKE FAIL')
    log(String(err && err.stack ? err.stack : err))
    flush()
    process.exit(1)
  })
