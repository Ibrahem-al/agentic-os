/**
 * rebuild:native orchestrator.
 *
 * better-sqlite3 is not N-API, so one binary cannot serve both plain Node
 * (vitest, scripts) and Electron. This script ends in a state where BOTH
 * runtimes work on the same machine, no flip-flopping:
 *   - build/Release/better_sqlite3.node          → plain-Node ABI (default)
 *   - build/Release/better_sqlite3-node.node     → stash of the same
 *   - build/Release/better_sqlite3-electron.node → Electron-ABI stash
 *     (src/main/storage/appdata.ts selects it via the `nativeBinding` option
 *     when running inside Electron)
 *
 * Then delegates to scripts/native/rebuild-ryugraph-electron.cjs (win32
 * delay-load rebuild of the RyuGraph binding; marker-hit runs are seconds).
 *
 * Probes judge strictly by child exit code — Electron stdout is unreliable
 * on Windows.
 */
'use strict'

const fs = require('node:fs')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

const repoRoot = path.join(__dirname, '..', '..')
const bs3Dir = path.join(repoRoot, 'node_modules', 'better-sqlite3')
const buildDir = path.join(bs3Dir, 'build', 'Release')
const defaultBinding = path.join(buildDir, 'better_sqlite3.node')
const nodeStash = path.join(buildDir, 'better_sqlite3-node.node')
const electronStash = path.join(buildDir, 'better_sqlite3-electron.node')

const PROBE_SCRIPT = [
  "const p = process.env.BS3_BINDING || null;",
  "const D = require(process.env.BS3_DIR);",
  "const db = p ? new D(':memory:', { nativeBinding: p }) : new D(':memory:');",
  "const r = db.prepare('SELECT 1 AS one').get();",
  "if (!r || r.one !== 1) throw new Error('probe query failed');",
  'db.close();'
].join(' ')

function log(message) {
  console.log(`[rebuild:native] ${message}`)
}

function electronBinary() {
  // In a plain Node process, require('electron') resolves to the binary path.
  return require(path.join(repoRoot, 'node_modules', 'electron'))
}

function probe(executable, bindingPath, extraEnv) {
  const result = spawnSync(executable, ['-e', PROBE_SCRIPT], {
    env: {
      ...process.env,
      ...extraEnv,
      BS3_DIR: bs3Dir,
      BS3_BINDING: bindingPath || ''
    },
    stdio: 'ignore',
    timeout: 120000
  })
  return result.status === 0
}

function probeNode(bindingPath) {
  return probe(process.execPath, bindingPath, {})
}

function probeElectron(bindingPath) {
  return probe(electronBinary(), bindingPath, {
    ELECTRON_RUN_AS_NODE: '1',
    ELECTRON_NO_ATTACH_CONSOLE: '1'
  })
}

function runElectronRebuild() {
  const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, 'node_modules', '@electron', 'rebuild', 'package.json'), 'utf8'))
  const bin = typeof pkg.bin === 'string' ? pkg.bin : pkg.bin['electron-rebuild']
  const cli = path.join(repoRoot, 'node_modules', '@electron', 'rebuild', bin)
  log('running electron-rebuild -f -w better-sqlite3 …')
  const result = spawnSync(process.execPath, [cli, '-f', '-w', 'better-sqlite3'], {
    cwd: repoRoot,
    stdio: 'inherit',
    timeout: 1800000
  })
  if (result.status !== 0) throw new Error(`electron-rebuild failed with exit code ${result.status}`)
}

function runNpmRebuild() {
  log('running npm rebuild better-sqlite3 (restores the plain-Node prebuilt) …')
  const result = spawnSync('npm rebuild better-sqlite3', {
    cwd: repoRoot,
    stdio: 'inherit',
    shell: true,
    timeout: 1800000
  })
  if (result.status !== 0) throw new Error(`npm rebuild better-sqlite3 failed with exit code ${result.status}`)
}

function main() {
  if (!fs.existsSync(defaultBinding)) {
    log(`default binding missing at ${defaultBinding}; running npm rebuild first`)
    runNpmRebuild()
  }

  // Classify the current default binary and stash it accordingly.
  if (probeNode(defaultBinding)) {
    log('default binding loads under plain Node → stashing as better_sqlite3-node.node')
    fs.copyFileSync(defaultBinding, nodeStash)
  } else if (probeElectron(defaultBinding)) {
    log('default binding loads under Electron → stashing as better_sqlite3-electron.node')
    fs.copyFileSync(defaultBinding, electronStash)
  } else {
    log('default binding loads under neither runtime (stale build?) — it will be rebuilt')
  }

  // Ensure a valid Electron stash.
  if (!fs.existsSync(electronStash) || !probeElectron(electronStash)) {
    runElectronRebuild()
    fs.copyFileSync(defaultBinding, electronStash)
    if (!probeElectron(electronStash)) {
      throw new Error('electron-rebuild output does not load under Electron — aborting')
    }
  }
  log('Electron-ABI stash OK')

  // Ensure a valid plain-Node stash.
  if (!fs.existsSync(nodeStash) || !probeNode(nodeStash)) {
    runNpmRebuild()
    if (!probeNode(defaultBinding)) {
      throw new Error('npm rebuild output does not load under plain Node — aborting')
    }
    fs.copyFileSync(defaultBinding, nodeStash)
  }
  log('plain-Node ABI stash OK')

  // Final state: default = plain-Node ABI.
  fs.copyFileSync(nodeStash, defaultBinding)
  if (!probeNode(defaultBinding)) throw new Error('final verification failed: default binding under plain Node')
  if (!probeElectron(electronStash)) throw new Error('final verification failed: Electron stash under Electron')
  log('better-sqlite3 ready: default=plain-Node ABI, better_sqlite3-electron.node=Electron ABI')

  // RyuGraph Electron-safety rebuild (no-ops in seconds on marker hit).
  const ryu = spawnSync(process.execPath, [path.join(__dirname, 'rebuild-ryugraph-electron.cjs')], {
    cwd: repoRoot,
    stdio: 'inherit'
  })
  if (ryu.status !== 0) throw new Error(`rebuild-ryugraph-electron failed with exit code ${ryu.status}`)
  log('done')
}

try {
  main()
} catch (err) {
  console.error(`[rebuild:native] FAILED: ${err && err.message ? err.message : err}`)
  process.exit(1)
}
