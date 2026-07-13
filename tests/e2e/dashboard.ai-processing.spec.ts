/**
 * Local-LLM control e2e (Stage 3): the Settings "AI processing" section and the
 * Usage panel's "On this computer" section render over the seeded demo profile.
 *
 * No Ollama dependency in the assertions: the backend radio, the "What runs
 * where" role map (reasoning.roles is settings-driven, not daemon-driven), and
 * the sensitive-egress toggle all resolve without a running daemon; the Usage
 * local section renders its live line + stats + charts whether or not a model is
 * loaded (an empty ledger + daemon-down is a valid, asserted-against state).
 */
import { expect, test } from '@playwright/test'
import { launchSeededApp, type LaunchedApp } from './launch'

let ctx: LaunchedApp | undefined

test.beforeAll(async () => {
  ctx = await launchSeededApp('ai-processing')
})

test.afterAll(async () => {
  await ctx?.close()
})

test('Settings: AI processing section renders the backend choice, role map, and consent toggle', async () => {
  const { page } = ctx!
  await page.getByTestId('nav-settings').click()

  // The mini-TOC has the new chip; clicking it scrolls to the section.
  await page.getByRole('button', { name: 'AI processing' }).click()

  // The three plain backend choices; "On this computer" is the default (DEFAULT == TODAY).
  await expect(page.getByTestId('ai-processing-backend-local')).toBeVisible()
  await expect(page.getByTestId('ai-processing-backend-cloud')).toBeVisible()
  await expect(page.getByTestId('ai-processing-backend-subscription')).toBeVisible()
  await expect(page.getByTestId('ai-processing-backend-local').locator('input')).toBeChecked()

  // The honest scope note.
  await expect(
    page.getByText('Search indexing (embeddings) always runs on this computer', { exact: false }).first()
  ).toBeVisible()

  // "What runs where": the live role map, grouped in plain words. On a default
  // install every group resolves to this computer; the sensitive groups carry
  // the lock sentence regardless of backend.
  await expect(page.getByTestId('ai-processing-runs')).toBeVisible()
  await expect(page.getByTestId('ai-processing-role-understanding-your-sessions')).toBeVisible()
  await expect(
    page.getByText('Handles raw session text', { exact: false }).first()
  ).toBeVisible()

  // The sensitive-egress override starts off (no new consent on the default path).
  const sensitive = page.getByTestId('ai-processing-sensitive-toggle')
  await expect(sensitive).toBeVisible()
  await expect(sensitive).toHaveAttribute('aria-checked', 'false')

  // Turning it on opens the consent modal; it does not persist without ack.
  await sensitive.click()
  await expect(page.getByTestId('ai-processing-sensitive-consent')).toBeVisible()
  await expect(page.getByTestId('ai-processing-sensitive-consent-confirm')).toBeDisabled()
  // Cancel via Escape leaves the toggle off (nothing left the computer).
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('ai-processing-sensitive-consent')).toHaveCount(0)
  await expect(sensitive).toHaveAttribute('aria-checked', 'false')
})

test('Usage panel: the "On this computer" section renders with an empty ledger', async () => {
  const { page } = ctx!
  await page.getByTestId('nav-spend').click()

  // The panel is now titled "Usage".
  await expect(page.getByRole('heading', { name: 'Usage', exact: true })).toBeVisible()

  // Local section: live line + the four today/7-day stats + charts + recent list,
  // all present whether or not Ollama is running.
  await expect(page.getByTestId('usage-local')).toBeVisible()
  await expect(page.getByTestId('usage-local-live')).toBeVisible()
  await expect(page.getByTestId('usage-local-calls-today')).toBeVisible()
  await expect(page.getByTestId('usage-local-bars')).toBeVisible()
  await expect(page.getByTestId('usage-local-composition')).toBeVisible()
  await expect(page.getByTestId('usage-local-recent')).toBeVisible()

  // The cloud budget meter still renders below (existing testid preserved).
  await expect(page.getByTestId('spend-meter')).toBeVisible()
})
