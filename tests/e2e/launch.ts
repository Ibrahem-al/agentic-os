/**
 * Shared e2e launcher: seed a scratch userData dir (in the system tmpdir —
 * OneDrive paths break native file locking), launch the built app against
 * it with Playwright's Electron driver, wait for the shell to render.
 */
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { _electron, type ElectronApplication, type Page } from '@playwright/test'
import type { DashboardSeedResult } from '../fixtures/dashboard-seed'

// resolve() strips the trailing separator fileURLToPath leaves on directory
// URLs — a trailing backslash escapes the closing quote in the Windows spawn
// command line and Electron never boots (found live: silent 120s hang).
const repoRoot = resolve(fileURLToPath(new URL('../..', import.meta.url)))

/**
 * Seed in a CHILD process (the bundle global-setup built): the seed keeps
 * its ryugraph handle open to dodge the 25.9.1 close() teardown fault, so
 * only its process exit releases the graph lock for the app under test.
 */
function seedInChild(userDataDir: string): DashboardSeedResult {
  const stdout = execFileSync(
    process.execPath,
    [join(repoRoot, 'out', 'smoke', 'dashboard-seed.mjs'), userDataDir, '--json'],
    { cwd: repoRoot, encoding: 'utf8' }
  )
  const jsonLine = stdout
    .split(/\r?\n/)
    .filter((line) => line.startsWith('{'))
    .at(-1)
  if (jsonLine === undefined) throw new Error(`dashboard-seed produced no JSON result:\n${stdout}`)
  return JSON.parse(jsonLine) as DashboardSeedResult
}

export interface LaunchedApp {
  readonly app: ElectronApplication
  readonly page: Page
  readonly seed: DashboardSeedResult
  readonly userDataDir: string
  close(): Promise<void>
}

export async function launchSeededApp(prefix: string): Promise<LaunchedApp> {
  const userDataDir = mkdtempSync(join(tmpdir(), `agentic-os-e2e-${prefix}-`))
  console.log(`[e2e] seeding ${userDataDir}…`)
  const seed = seedInChild(userDataDir)
  console.log('[e2e] seeded; launching electron…')

  const app = await _electron.launch({
    // Launch the APP DIRECTORY (package.json main → out/main/index.js), not
    // the script file: app.getAppPath() must be the repo root or bootStorage
    // cannot resolve node_modules/ryugraph and storage stays down.
    args: [repoRoot],
    cwd: repoRoot,
    env: {
      ...process.env,
      AGENTIC_OS_USER_DATA_DIR: userDataDir
    }
  })
  const page = await app.firstWindow()
  // The rail renders as soon as React mounts; storage boot is already done
  // (boot precedes createWindow in main).
  await page.waitForSelector('[data-testid="nav-review"]', { timeout: 30_000 })

  return {
    app,
    page,
    seed,
    userDataDir,
    close: async () => {
      await app.close()
      // Windows: native handles release asynchronously after exit.
      for (let attempt = 0; attempt < 5; attempt++) {
        try {
          rmSync(userDataDir, { recursive: true, force: true })
          break
        } catch {
          await new Promise((resolve) => setTimeout(resolve, 500))
        }
      }
    }
  }
}

/** True when the local Ollama daemon answers (folder ingest needs bge-m3). */
export async function ollamaAvailable(): Promise<boolean> {
  try {
    const response = await fetch('http://127.0.0.1:11434/api/tags', { signal: AbortSignal.timeout(1500) })
    return response.ok
  } catch {
    return false
  }
}
