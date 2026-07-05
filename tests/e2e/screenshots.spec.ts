/**
 * Panel screenshot capture (phase-10 design protocol: iterate visually,
 * screenshot every panel for the report). Not a test of behavior — runs only
 * when AGENTIC_OS_E2E_SCREENSHOTS=1:
 *
 *   AGENTIC_OS_E2E_SCREENSHOTS=1 npx playwright test screenshots
 *
 * Output: docs/progress/assets/phase-10/<panel>.png over the seeded demo
 * data, at 1440×900.
 */
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, test } from '@playwright/test'
import { launchSeededApp, type LaunchedApp } from './launch'

const enabled = process.env['AGENTIC_OS_E2E_SCREENSHOTS'] === '1'
const outDir = join(fileURLToPath(new URL('../..', import.meta.url)), 'docs', 'progress', 'assets', 'phase-10')

let ctx: LaunchedApp | undefined

test.beforeAll(async () => {
  if (!enabled) return
  mkdirSync(outDir, { recursive: true })
  ctx = await launchSeededApp('shots')
  await ctx.page.setViewportSize({ width: 1440, height: 900 })
})

test.afterAll(async () => {
  await ctx?.close()
})

test('capture every panel', async () => {
  test.skip(!enabled, 'screenshot capture runs only with AGENTIC_OS_E2E_SCREENSHOTS=1')
  const { page } = ctx as LaunchedApp
  const shoot = async (name: string): Promise<void> => {
    await page.waitForTimeout(400)
    await page.screenshot({ path: join(outDir, `${name}.png`) })
  }

  // memory: browse a label + inspect a node
  await page.getByTestId('nav-memory').click()
  await page.getByRole('button', { name: /preference/i }).first().click()
  await page.waitForTimeout(600)
  const firstRow = page.locator('tbody tr').first()
  if (await firstRow.isVisible().catch(() => false)) await firstRow.click()
  await shoot('memory')

  // review: list + one staged diff modal
  await page.getByTestId('nav-review').click()
  await shoot('review')
  const staged = page.locator('[data-rowkey="sw-demo-extraction"]')
  if (await staged.isVisible().catch(() => false)) {
    await staged.click()
    await expect(page.getByTestId('staged-diff')).toBeVisible()
    await shoot('review-diff')
    await page.keyboard.press('Escape')
  }

  await page.getByTestId('nav-audit').click()
  await shoot('audit')

  await page.getByTestId('nav-spend').click()
  await shoot('spend')

  await page.getByTestId('nav-tasks').click()
  await shoot('tasks')

  // traces: select the extraction trace for the waterfall
  await page.getByTestId('nav-traces').click()
  await page.waitForTimeout(600)
  const traceRow = page.locator('tbody tr').first()
  if (await traceRow.isVisible().catch(() => false)) await traceRow.click()
  await shoot('traces')

  // skills: select one for the detail pane
  await page.getByTestId('nav-skills').click()
  await page.waitForTimeout(600)
  const skillRow = page.locator('tbody tr').first()
  if (await skillRow.isVisible().catch(() => false)) await skillRow.click()
  await shoot('skills')

  await page.getByTestId('nav-ingest').click()
  await shoot('ingest')

  await page.getByTestId('nav-settings').click()
  await shoot('settings')
})
