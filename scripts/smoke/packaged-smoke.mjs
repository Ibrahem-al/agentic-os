/**
 * Packaged-app smoke (phase 13, §21 rule 9 update-path proof).
 *
 * Usage: node scripts/smoke/packaged-smoke.mjs <appExecutablePath>
 *   e.g.: node scripts/smoke/packaged-smoke.mjs dist/win-unpacked/agentic-os.exe
 *
 * Two launches of the PACKAGED build against one scratch userData dir:
 *  1. plain           → fresh store created: every subsystem boot line, the
 *                       "[storage] ryugraph … schema v1" line, the MCP listen
 *                       line; then a GRACEFUL quit (WM_CLOSE via taskkill /
 *                       SIGTERM) so the app's will-quit path runs.
 *  2. AGENTIC_OS_TEST_MIGRATION_V2=1 (storage seam: appends a v1000 probe
 *     migration at open) → the [storage] line shows "pre-migration backup:"
 *     AND "schema v1000", and <userData>/backups/ holds a
 *     *pre-migration-v1000* directory with the copied graph files.
 *
 * Both launches pass AGENTIC_OS_OLLAMA_BASE_URL=http://127.0.0.1:1 (dead
 * port) so the smoke is hermetic and proves the guided-install line
 * "[models] ollama not detected".
 */
import { execFileSync, spawn } from 'node:child_process'
import console from 'node:console'
import { existsSync, mkdtempSync, mkdirSync, readdirSync, rmSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import process from 'node:process'
import { clearInterval, setInterval, setTimeout } from 'node:timers'

const TIMEOUT_MS = 60_000
const QUIT_GRACE_MS = 15_000

const exeArg = process.argv[2]
if (!exeArg) {
  console.error('[packaged-smoke] usage: node scripts/smoke/packaged-smoke.mjs <appExecutablePath>')
  process.exit(1)
}
const exe = resolve(exeArg)
if (!existsSync(exe)) {
  console.error(`[packaged-smoke] FAIL — app executable not found: ${exe}`)
  process.exit(1)
}

// One scratch userData dir shared by BOTH launches: launch 2 must migrate the
// store launch 1 created. Dot dir keeps the spool/rules hermetic.
const userDataDir = mkdtempSync(join(tmpdir(), 'agentic-os-pkg-smoke-'))
const dotDir = join(userDataDir, 'dot-agentic-os')
mkdirSync(dotDir, { recursive: true })
const baseEnv = {
  ...process.env,
  AGENTIC_OS_USER_DATA_DIR: userDataDir,
  AGENTIC_OS_DOT_DIR: dotDir,
  // Hermetic: a dead port proves the guided-install detection line.
  AGENTIC_OS_OLLAMA_BASE_URL: 'http://127.0.0.1:1'
}

/** Ask the app to quit the way a user would, so will-quit runs. */
function requestQuit(child) {
  if (process.platform === 'win32') {
    // taskkill WITHOUT /F posts WM_CLOSE → close → window-all-closed →
    // app.quit() → will-quit. child.kill() would TerminateProcess and skip
    // it. Deliberately NOT /T: WM_CLOSE-ing the Chromium children mid-quit
    // makes the browser process exit before flushing 'Local State' (the
    // safeStorage key), corrupting the keychain for the next launch (found
    // live). Helpers that outlive the root and keep the MCP port bound are
    // reaped by waitForMcpPortFree before the next launch.
    try {
      execFileSync('taskkill', ['/pid', String(child.pid)], { stdio: 'ignore' })
      return
    } catch {
      /* fall through to force kill below */
    }
  } else {
    try {
      child.kill('SIGTERM')
      return
    } catch {
      /* fall through */
    }
  }
  forceKill(child)
}

function forceKill(child) {
  if (process.platform === 'win32') {
    try {
      execFileSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
    } catch {
      /* already gone */
    }
  } else {
    try {
      child.kill('SIGKILL')
    } catch {
      /* already gone */
    }
  }
}

/**
 * Launch the packaged app, wait until every pattern matches (or timeout),
 * then quit gracefully and wait for exit. Returns { ok, output, missing }.
 */
/** The app binds MCP to a FIXED port; a lingering instance (this smoke's
 * previous launch's orphaned helper — Windows children can inherit the
 * listening socket handle —, an e2e orphan, the user's real app) would make
 * the next launch boot without its [mcp] line. Wait for the port to free;
 * on Windows, reap the specific port holder as a last resort. */
async function waitForMcpPortFree(maxMs = 15_000) {
  const isFree = () =>
    new Promise((res) => {
      const probe = createServer()
      probe.once('error', () => res(false))
      probe.listen(4517, '127.0.0.1', () => probe.close(() => res(true)))
    })
  const started = Date.now()
  for (;;) {
    if (await isFree()) return true
    if (Date.now() - started >= maxMs) break
    await new Promise((r) => setTimeout(r, 500))
  }
  if (process.platform === 'win32') {
    try {
      execFileSync(
        'powershell',
        ['-NoProfile', '-Command', '(Get-NetTCPConnection -LocalPort 4517 -State Listen -ErrorAction Stop).OwningProcess | ForEach-Object { Stop-Process -Id $_ -Force }'],
        { stdio: 'ignore' }
      )
      console.warn('[packaged-smoke] WARNING: killed a lingering process holding port 4517')
      await new Promise((r) => setTimeout(r, 1000))
      if (await isFree()) return true
    } catch {
      /* nothing held it after all, or the kill failed — fall through */
    }
  }
  console.warn('[packaged-smoke] WARNING: port 4517 is still bound by another process — the [mcp] line will fail')
  return false
}

async function runLaunch(label, extraEnv, patterns) {
  await waitForMcpPortFree()
  return new Promise((resolvePromise) => {
    console.log(`\n[packaged-smoke] --- launch ${label} ---`)
    const child = spawn(exe, [], {
      env: { ...baseEnv, ...extraEnv },
      stdio: ['ignore', 'pipe', 'pipe']
    })
    let output = ''
    let settled = false
    child.stdout.on('data', (c) => {
      output += c.toString()
      process.stdout.write(c)
    })
    child.stderr.on('data', (c) => process.stderr.write(c))

    const unmatched = () => patterns.filter((p) => !p.re.test(output))

    const finish = (ok) => {
      if (settled) return
      settled = true
      clearInterval(poll)
      let exited = false
      child.once('exit', () => {
        exited = true
        resolvePromise({ ok, output, missing: unmatched().map((p) => p.name) })
      })
      requestQuit(child)
      setTimeout(() => {
        if (!exited) {
          console.log(`[packaged-smoke] ${label}: graceful quit timed out after ${QUIT_GRACE_MS / 1000}s — force killing`)
          forceKill(child)
        }
      }, QUIT_GRACE_MS).unref()
      // Absolute backstop so the smoke can never hang.
      setTimeout(() => {
        if (!exited) resolvePromise({ ok: false, output, missing: unmatched().map((p) => p.name) })
      }, QUIT_GRACE_MS + 10_000).unref()
    }

    const started = Date.now()
    const poll = setInterval(() => {
      if (unmatched().length === 0) {
        finish(true)
      } else if (Date.now() - started >= TIMEOUT_MS) {
        finish(false)
      }
    }, 500)

    child.on('exit', (code) => {
      if (!settled) {
        settled = true
        clearInterval(poll)
        console.log(`[packaged-smoke] ${label}: app exited early (code ${code})`)
        resolvePromise({ ok: false, output, missing: unmatched().map((p) => p.name) })
      }
    })
  })
}

function report(label, result) {
  if (result.ok) {
    console.log(`[packaged-smoke] ${label}: PASS`)
  } else {
    console.log(`[packaged-smoke] ${label}: FAIL — missing: ${result.missing.join(', ')}`)
  }
  return result.ok
}

const failures = []

// ── Launch 1: plain — fresh store, full boot, graceful quit ────────────────
const launch1 = await runLaunch('1 (fresh store)', {}, [
  { name: '[storage] appdata line', re: /\[storage\] appdata\.db open/ },
  { name: '[storage] ryugraph schema v1', re: /\[storage\] ryugraph .*schema v1,/ },
  { name: '[models] ollama not detected (dead port)', re: /\[models\] ollama not detected/ },
  { name: '[kernel]', re: /\[kernel\]/ },
  { name: '[security]', re: /\[security\]/ },
  { name: '[mcp] server listening', re: /\[mcp\] server listening at/ },
  { name: '[agents]', re: /\[agents\]/ },
  { name: '[triggers]', re: /\[triggers\]/ },
  { name: '[ipc]', re: /\[ipc\]/ }
])
if (!report('launch 1', launch1)) failures.push('launch 1 boot lines')

// ── Launch 2: v1000 probe migration → pre-migration backup + schema v1000 ──
const launch2 = await runLaunch('2 (update path: v1000 probe migration)', { AGENTIC_OS_TEST_MIGRATION_V2: '1' }, [
  { name: '[storage] pre-migration backup', re: /\[storage\] ryugraph .*pre-migration backup:/ },
  { name: '[storage] schema v1000', re: /\[storage\] ryugraph .*schema v1000,/ },
  { name: '[models] ollama not detected (dead port)', re: /\[models\] ollama not detected/ },
  { name: '[ipc]', re: /\[ipc\]/ }
])
if (!report('launch 2', launch2)) failures.push('launch 2 migration lines')

// On-disk proof: backups/<stamp>-pre-migration-v1000/ holds the copied graph.
const backupsDir = join(userDataDir, 'backups')
let backupOk = false
try {
  const backupDirs = readdirSync(backupsDir).filter((name) => name.includes('pre-migration-v1000'))
  for (const dir of backupDirs) {
    const files = readdirSync(join(backupsDir, dir))
    if (files.length > 0) {
      console.log(`[packaged-smoke] backup on disk: backups/${dir} (${files.length} graph file(s))`)
      backupOk = true
    }
  }
  if (backupDirs.length === 0) console.log(`[packaged-smoke] no *pre-migration-v1000* dir under ${backupsDir}`)
} catch (err) {
  console.log(`[packaged-smoke] backups dir unreadable: ${String(err)}`)
}
if (!backupOk) failures.push('pre-migration-v1000 backup dir with graph files')

// ── Verdict ─────────────────────────────────────────────────────────────────
console.log('\n[packaged-smoke] --- verdict ---')
try {
  rmSync(userDataDir, { recursive: true, force: true, maxRetries: 3 })
} catch {
  /* scratch dir left behind in tmp — harmless */
}
if (failures.length > 0) {
  console.log(`[packaged-smoke] FAIL — ${failures.join('; ')}`)
  process.exit(1)
}
console.log('[packaged-smoke] PASS — fresh boot, graceful quit, v1000 migration with pre-migration backup proven on the packaged build')
process.exit(0)
