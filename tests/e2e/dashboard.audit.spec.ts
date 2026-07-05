/**
 * Phase-10 DoD e2e 2: undo an audited action from the audit timeline (§13
 * reversible deltas — the recorded inverse applies through the write lane).
 */
import { expect, test } from '@playwright/test'
import { launchSeededApp, type LaunchedApp } from './launch'

let ctx: LaunchedApp

test.beforeAll(async () => {
  ctx = await launchSeededApp('audit')
})

test.afterAll(async () => {
  await ctx?.close()
})

test('undo a reversible graph write from the audit log', async () => {
  const { page, seed } = ctx

  await page.getByTestId('nav-audit').click()

  // The seeded reversible action offers undo; the raw-cypher one must not.
  const undoButton = page.getByTestId(`audit-undo-${seed.undoableActionId}`)
  await expect(undoButton).toBeVisible()
  await undoButton.click()

  // Confirm in the modal (destructive is deliberate).
  await page.getByTestId('audit-undo-confirm').click()

  // The row is now marked undone and its undo affordance is gone.
  await expect(page.getByTestId(`audit-undo-${seed.undoableActionId}`)).toHaveCount(0, { timeout: 20_000 })
  await expect(page.locator('[data-status="undone"]').first()).toBeVisible()

  // The graph reverted: the tag created by the audited write is gone.
  await page.getByTestId('nav-memory').click()
  await page.getByRole('button', { name: /^tag/i }).first().click()
  await expect(page.getByText('runbook', { exact: false })).toHaveCount(0, { timeout: 20_000 })
})
