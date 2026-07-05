/**
 * Phase-10 DoD e2e 1: approve a staged write from the review queue and see
 * the graph reflect it in the memory browser (§13 staged → validated →
 * committed, driven end to end through the real UI + IPC + write lane).
 *
 * Ollama-gated like the ingest spec (phase 13): approving a correction that
 * patches a Preference statement re-embeds it at commit (embedOnCommit, real
 * bge-m3) — on a runner without Ollama the commit honestly fails with
 * COMMIT_FAILED. CI keeps staged-approve coverage through the golden path,
 * which approves a staged extraction on scripted models.
 */
import { expect, test } from '@playwright/test'
import { launchSeededApp, ollamaAvailable, type LaunchedApp } from './launch'

let ctx: LaunchedApp | undefined

test.beforeAll(async () => {
  if (await ollamaAvailable()) ctx = await launchSeededApp('review')
})

test.afterAll(async () => {
  await ctx?.close()
})

test('approve a staged correction from the review queue', async () => {
  test.skip(ctx === undefined, 'Ollama not reachable — the approve→commit path re-embeds with real bge-m3')
  const { page, seed } = ctx!

  await page.getByTestId('nav-review').click()

  // The seeded staged correction is listed; open its diff.
  const row = page.locator(`[data-rowkey="${seed.stagedCorrectionId}"]`)
  await expect(row).toBeVisible()
  await row.click()

  // Human-readable diff shows the property change before any commit.
  const diff = page.getByTestId('staged-diff')
  await expect(diff).toBeVisible()
  await expect(diff).toContainText('statement')
  await expect(diff).toContainText('schema linter')

  // Approve → ONE audited lane commit.
  await page.getByTestId('staged-approve').click()

  // The staged list (default filter: staged) no longer shows the row.
  await expect(page.locator(`[data-rowkey="${seed.stagedCorrectionId}"]`)).toHaveCount(0, { timeout: 20_000 })

  // The graph reflects the patch: the Preference's statement changed.
  await page.getByTestId('nav-memory').click()
  await page.getByRole('button', { name: /preference/i }).first().click()
  await expect(page.getByText('schema linter', { exact: false }).first()).toBeVisible({ timeout: 20_000 })
})
