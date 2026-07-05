/**
 * Boot smoke (phase 11 →, committed in phase 13): launch the PRODUCTION BUILD
 * (`npm run build` first) from the repo under scratch userData + dot dirs,
 * seed one spooled session, and assert every subsystem boot line plus the
 * spool drain. Run: npm run smoke:boot
 */
import { spawn } from 'node:child_process'
import console from 'node:console'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import process from 'node:process'
import { clearInterval, setInterval, setTimeout } from 'node:timers'
import { fileURLToPath, URL } from 'node:url'

const repoRoot = resolve(fileURLToPath(new URL('../..', import.meta.url)))

/** Cross-platform electron dev binary inside node_modules. */
function electronBinary() {
  const dist = join(repoRoot, 'node_modules', 'electron', 'dist')
  if (process.platform === 'win32') return join(dist, 'electron.exe')
  if (process.platform === 'darwin') return join(dist, 'Electron.app', 'Contents', 'MacOS', 'Electron')
  return join(dist, 'electron')
}

const REQUIRED_LINES = ['[storage]', '[models]', '[kernel]', '[security]', '[mcp]', '[agents]', '[triggers]', '[ipc]']
const SPOOL_DRAINED = /spool drained \(1 new/
const TIMEOUT_MS = 45_000

const electron = electronBinary()
if (!existsSync(electron)) {
  console.error(`[smoke] FAIL — electron binary not found at ${electron} (run npm install)`)
  process.exit(1)
}
if (!existsSync(join(repoRoot, 'out', 'main', 'index.js'))) {
  console.error('[smoke] FAIL — out/main/index.js missing (run `npm run build` first)')
  process.exit(1)
}

// Scratch dirs: the smoke must never touch real userData, the real spool, or
// real rules (AGENTIC_OS_USER_DATA_DIR + AGENTIC_OS_DOT_DIR hermeticity seams).
const userDataDir = mkdtempSync(join(tmpdir(), 'agentic-os-smoke-'))
const dotDir = join(userDataDir, 'dot-agentic-os')
mkdirSync(join(dotDir, 'pending-sessions'), { recursive: true })
// Seed one spool file so the drain line shows real work.
writeFileSync(
  join(dotDir, 'pending-sessions', 'smoke.json'),
  JSON.stringify({ session_id: 'smoke-spooled-session' }),
  'utf8'
)

const child = spawn(electron, [repoRoot], {
  cwd: repoRoot,
  env: { ...process.env, AGENTIC_OS_USER_DATA_DIR: userDataDir, AGENTIC_OS_DOT_DIR: dotDir },
  stdio: ['ignore', 'pipe', 'pipe']
})

let out = ''
child.stdout.on('data', (c) => {
  out += c.toString()
  process.stdout.write(c)
})
child.stderr.on('data', (c) => process.stderr.write(c))

const started = Date.now()
let finished = false

function cleanupAndExit(code) {
  if (finished) return
  finished = true
  clearInterval(poll)
  child.once('exit', () => {
    // Best-effort scratch cleanup; locked files on Windows are non-fatal.
    try {
      rmSync(userDataDir, { recursive: true, force: true, maxRetries: 3 })
    } catch {
      /* scratch dir left behind in tmp — harmless */
    }
    process.exit(code)
  })
  child.kill()
  // Kill can race a wedged child; don't hang the smoke on it.
  setTimeout(() => process.exit(code), 10_000).unref()
}

function verdict(force) {
  const missing = REQUIRED_LINES.filter((tag) => !out.includes(tag))
  const spoolOk = SPOOL_DRAINED.test(out)
  if (missing.length === 0 && spoolOk) {
    console.log('\n[smoke] --- verdict ---')
    console.log('[smoke] PASS — all subsystem boot lines present; spool drained (1 new)')
    cleanupAndExit(0)
    return
  }
  if (force) {
    console.log('\n[smoke] --- verdict ---')
    if (missing.length > 0) console.log(`[smoke] FAIL — missing boot lines after ${TIMEOUT_MS / 1000}s: ${missing.join(', ')}`)
    if (!spoolOk) console.log('[smoke] FAIL — spool drain line "(1 new" NOT SEEN')
    cleanupAndExit(1)
  }
}

const poll = setInterval(() => {
  verdict(Date.now() - started >= TIMEOUT_MS)
}, 500)

child.on('exit', (code) => {
  if (!finished) {
    console.log(`\n[smoke] FAIL — app exited early (code ${code}) before all boot lines appeared`)
    finished = true
    clearInterval(poll)
    process.exit(1)
  }
})
