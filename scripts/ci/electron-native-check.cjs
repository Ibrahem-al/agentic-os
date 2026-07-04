/**
 * CI helper: prove better-sqlite3 (after rebuild:native) and onnxruntime-node
 * load under Electron's runtime on Windows, where stdout from the GUI-subsystem
 * binary is unreliable — results are written to %TEMP%\electron-native-check.json.
 */
'use strict'

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const out = path.join(os.tmpdir(), 'electron-native-check.json')

try {
  const BetterSqlite3 = require('better-sqlite3')
  const db = new BetterSqlite3(':memory:')
  const sqliteVersion = db.prepare('SELECT sqlite_version() AS v').get().v
  db.close()
  require('onnxruntime-node')
  fs.writeFileSync(
    out,
    JSON.stringify({
      ok: true,
      electron: process.versions.electron ?? null,
      node: process.versions.node,
      betterSqlite3: require('better-sqlite3/package.json').version,
      sqlite: sqliteVersion,
      onnxruntimeNode: require('onnxruntime-node/package.json').version
    })
  )
  process.exit(0)
} catch (err) {
  fs.writeFileSync(out, JSON.stringify({ ok: false, error: String(err && err.stack ? err.stack : err) }))
  process.exit(1)
}
