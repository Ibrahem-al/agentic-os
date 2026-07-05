import { execSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = fileURLToPath(new URL('../..', import.meta.url))

/**
 * The e2e drives the production build (out/). Build once per run; skip only
 * when AGENTIC_OS_E2E_SKIP_BUILD=1 (local iteration where out/ is fresh).
 */
export default function globalSetup(): void {
  if (process.env['AGENTIC_OS_E2E_SKIP_BUILD'] === '1' && existsSync(join(repoRoot, 'out', 'main', 'index.js'))) {
    console.log('[e2e] AGENTIC_OS_E2E_SKIP_BUILD=1 — reusing existing out/ build')
  } else {
    console.log('[e2e] building the app (electron-vite build)…')
    execSync('npm run build', { cwd: repoRoot, stdio: 'inherit' })
  }
  // The seed runs as a child process per spec (see launch.ts) — bundle it.
  console.log('[e2e] bundling the dashboard seed…')
  execSync(
    'npx esbuild tests/fixtures/dashboard-seed.ts --bundle --platform=node --format=esm --outfile=out/smoke/dashboard-seed.mjs --log-level=warning',
    { cwd: repoRoot, stdio: 'inherit' }
  )
}
