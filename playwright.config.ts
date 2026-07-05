import { defineConfig } from '@playwright/test'

/**
 * Phase-10 e2e: Playwright drives the REAL packaged-shape app (electron-vite
 * production build in out/) via Playwright's Electron support — no browser
 * download needed. Each spec seeds its own scratch userData dir (off
 * OneDrive: tmpdir) and launches its own app instance.
 *
 * Serial: two app instances would race the fixed MCP port (4517) and the
 * machine's Ollama; the suites are seconds each.
 */
export default defineConfig({
  testDir: 'tests/e2e',
  timeout: 120_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list']],
  globalSetup: './tests/e2e/global-setup.ts'
})
