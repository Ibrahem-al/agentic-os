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
import type { GoldenSeedResult } from '../fixtures/golden-seed'

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
      AGENTIC_OS_USER_DATA_DIR: userDataDir,
      // Phase 11: keep the trigger runtime hermetic too — the app under test
      // must never drain the real ~/.agentic-os spool or load real rules.
      AGENTIC_OS_DOT_DIR: join(userDataDir, 'dot-agentic-os')
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

// ── Golden-path additions (phase 13) — launchSeededApp stays untouched ───────

/** Run the golden seed bundle in a CHILD process (same lock discipline). */
export function runGoldenSeed(userDataDir: string): GoldenSeedResult {
  const stdout = execFileSync(
    process.execPath,
    [join(repoRoot, 'out', 'smoke', 'golden-seed.mjs'), userDataDir, '--json'],
    { cwd: repoRoot, encoding: 'utf8' }
  )
  const jsonLine = stdout
    .split(/\r?\n/)
    .filter((line) => line.startsWith('{'))
    .at(-1)
  if (jsonLine === undefined) throw new Error(`golden-seed produced no JSON result:\n${stdout}`)
  return JSON.parse(jsonLine) as GoldenSeedResult
}

export interface GoldenLaunchOptions {
  /** Reused across launches for the relaunch-durability arrow. */
  readonly userDataDir: string
  /** Extra env vars (fake model server URLs, reranker pins, token prints…). */
  readonly env?: Record<string, string>
}

export interface GoldenApp {
  readonly app: ElectronApplication
  readonly page: Page
  readonly userDataDir: string
  /** Everything the main process wrote to stdout/stderr so far. */
  stdout(): string
  /** Resolve with the first line matching `pattern` (polls the buffer). */
  waitForStdoutLine(pattern: RegExp, timeoutMs?: number): Promise<string>
  /** keepUserData=true skips the rmSync so a second launch can reuse the profile. */
  close(options?: { keepUserData?: boolean }): Promise<void>
}

/**
 * Launch the built app against an EXISTING userData dir with caller-supplied
 * env and full stdout capture. The golden-path spec runs its own seed and
 * launches twice over the same profile, so seeding/cleanup live with the
 * caller here (unlike launchSeededApp's one-shot lifecycle).
 */
export async function launchGoldenApp(options: GoldenLaunchOptions): Promise<GoldenApp> {
  const { userDataDir } = options
  const app = await _electron.launch({
    // Launch the APP DIRECTORY (package.json main → out/main/index.js), not
    // the script file: app.getAppPath() must be the repo root or bootStorage
    // cannot resolve node_modules/ryugraph and storage stays down.
    args: [repoRoot],
    cwd: repoRoot,
    env: {
      ...process.env,
      AGENTIC_OS_USER_DATA_DIR: userDataDir,
      AGENTIC_OS_DOT_DIR: join(userDataDir, 'dot-agentic-os'),
      ...options.env
    }
  })

  // Attach BEFORE waiting on the window: node streams start paused, so the
  // first 'data' listener receives everything buffered since process start —
  // the boot lines (tokens, agent-ready) all land in `captured`.
  let captured = ''
  const capture = (chunk: Buffer | string): void => {
    captured += typeof chunk === 'string' ? chunk : chunk.toString('utf8')
  }
  app.process().stdout?.on('data', capture)
  app.process().stderr?.on('data', capture)

  const page = await app.firstWindow()
  await page.waitForSelector('[data-testid="nav-review"]', { timeout: 30_000 })

  return {
    app,
    page,
    userDataDir,
    stdout: () => captured,
    waitForStdoutLine: async (pattern: RegExp, timeoutMs = 30_000): Promise<string> => {
      const deadline = Date.now() + timeoutMs
      for (;;) {
        const line = captured.split(/\r?\n/).find((l) => pattern.test(l))
        if (line !== undefined) return line
        if (Date.now() > deadline) {
          throw new Error(
            `timed out (${timeoutMs}ms) waiting for stdout line ${String(pattern)} — captured so far:\n${captured.slice(-4000)}`
          )
        }
        await new Promise((r) => setTimeout(r, 100))
      }
    },
    close: async (closeOptions = {}) => {
      await app.close()
      if (closeOptions.keepUserData === true) return
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
