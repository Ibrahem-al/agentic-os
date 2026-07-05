/**
 * Phase-10 DoD e2e 3: trigger a folder ingest from the UI (watched-folder
 * "scan now" → the phase-06 knowledge pipeline). Needs the local Ollama for
 * bge-m3 embeddings — skipped gracefully when the daemon is down, like the
 * OLLAMA=1 vitest gates.
 */
import { expect, test } from '@playwright/test'
import { launchSeededApp, ollamaAvailable, type LaunchedApp } from './launch'

let ctx: LaunchedApp | undefined

test.beforeAll(async () => {
  if (!(await ollamaAvailable())) return
  ctx = await launchSeededApp('ingest')
})

test.afterAll(async () => {
  await ctx?.close()
})

test('trigger a watched-folder ingest from the UI', async () => {
  test.skip(ctx === undefined, 'local Ollama not running — folder ingest needs bge-m3 embeddings')
  const { page } = ctx as LaunchedApp

  await page.getByTestId('nav-tasks').click()

  // The seeded watched folder ('demo-docs', two markdown files) scans now.
  const scan = page.getByTestId('watch-scan-demo-docs')
  await expect(scan).toBeVisible()
  await scan.click()

  // Both files ingest through the knowledge pipeline (embed + ONE lane job
  // per document); the result surfaces in the panel.
  await expect(page.getByText(/2 ingested/i).first()).toBeVisible({ timeout: 90_000 })

  // The chunks are real graph memory now: Knowledge nodes appear in the
  // memory browser (fixture graph seeds some; the scan adds more sources).
  await page.getByTestId('nav-memory').click()
  await page.getByRole('button', { name: /knowledge/i }).first().click()
  await expect(page.getByText('runbook', { exact: false }).first()).toBeVisible({ timeout: 20_000 })
})
