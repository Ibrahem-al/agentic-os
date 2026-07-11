/**
 * Stage-4 DoD e2e (feature B — user CRUD over the graph): add a memory, see it
 * in the list, delete it with a confirm, then undo the delete from History and
 * see it return. Every step drives the REAL UI → typed IPC → the single audited
 * write lane (§13/§21.11), so this exercises the whole reversible-mutation spine.
 *
 * Offline-friendly by construction: a Tag is NON-retrievable, so creating and
 * deleting one never touches the embedder (no Ollama needed) — unlike the review
 * / ingest specs, this one is unconditional, like dashboard.audit.spec.
 */
import { expect, test } from '@playwright/test'
import { launchSeededApp, type LaunchedApp } from './launch'

let ctx: LaunchedApp

// A name unlikely to collide with any seeded Tag ('runbook', fixture tags).
const TAG_NAME = 'zzz-e2e-edit-tag'

test.beforeAll(async () => {
  ctx = await launchSeededApp('memory-edit')
})

test.afterAll(async () => {
  await ctx?.close()
})

test('add a Tag, delete it with confirm, then undo the delete from History', async () => {
  const { page } = ctx

  await page.getByTestId('nav-memory').click()

  // ── add a Tag (non-retrievable: no embedder) ────────────────────────────────
  await page.getByTestId('memory-add').click()
  await page.getByTestId('memory-add-label-Tag').click()
  await page.getByTestId('memory-field-name').fill(TAG_NAME)
  await page.getByTestId('memory-add-submit').click()

  // The confirmation toast offers an inline Undo (used elsewhere; here we go via
  // History per the DoD).
  await expect(page.getByTestId('toasts')).toContainText('Saved', { timeout: 20_000 })

  // The create switched the browser to the Tag category; the new row is listed.
  const tagRow = page.locator('[data-rowkey^="Tag:"]', { hasText: TAG_NAME })
  await expect(tagRow).toBeVisible({ timeout: 20_000 })

  // ── delete it, with the deliberate confirm (destructive is deliberate) ──────
  await tagRow.click()
  await expect(page.getByTestId('memory-inspector')).toContainText(TAG_NAME)
  await page.getByTestId('memory-delete').click()
  await page.getByTestId('memory-delete-confirm').click()

  // The row is gone from the list.
  await expect(page.locator('[data-rowkey^="Tag:"]', { hasText: TAG_NAME })).toHaveCount(0, { timeout: 20_000 })

  // ── undo the delete from History (§13 reversible delta) ─────────────────────
  await page.getByTestId('nav-audit').click()
  const deleteEntry = page.locator('li').filter({ hasText: /dashboard: delete Tag/ })
  await expect(deleteEntry).toBeVisible({ timeout: 20_000 })
  await deleteEntry.getByRole('button', { name: 'undo' }).click()
  await page.getByTestId('audit-undo-confirm').click()

  // The action flips to undone.
  await expect(page.locator('[data-status="undone"]').first()).toBeVisible({ timeout: 20_000 })

  // ── the Tag is back in memory ───────────────────────────────────────────────
  await page.getByTestId('nav-memory').click()
  await page.getByRole('button', { name: /^tag/i }).first().click()
  await expect(page.getByText(TAG_NAME, { exact: false }).first()).toBeVisible({ timeout: 20_000 })
})
