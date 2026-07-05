/**
 * Phase-13 GOLDEN-PATH E2E — the release gate (phase doc, hardening & release):
 *
 *   fresh profile → ingest a fixture codebase → MCP client session calls
 *   get_context (Components appear) → session ends via hook → extraction
 *   populates memory → a staged write is approved in the dashboard → seeded
 *   corrections → skill job improves + adopts → an audited file write is
 *   undone. State asserted at EVERY arrow.
 *
 * Runs against the PRODUCTION build (out/, Playwright Electron driver) with
 * SCRIPTED models over HTTP: the fake model server impersonates Ollama AND
 * the OpenAI cloud tier (AGENTIC_OS_OLLAMA_BASE_URL / AGENTIC_OS_CLOUD_BASE_URL
 * seams), the reranker runs the REAL onnxruntime session over a tiny pinned
 * fixture (AGENTIC_OS_RERANKER_FILES) — no Ollama daemon, no real cloud,
 * fully deterministic, CI-runnable. Reranker scores are garbage-but-
 * deterministic by design, so every retrieval assertion is set-membership,
 * never order-specific.
 */
import { cpSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, test, type Page } from '@playwright/test'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { HOOK_SESSION_END_URL, MCP_URL } from '../../src/main/config'
import {
  FakeModelServer,
  GOLDEN_ADOPT_MARKER,
  GOLDEN_COMMITTED_PREFERENCE,
  GOLDEN_SKILL_ID,
  GOLDEN_SKILL_INSTRUCTIONS,
  GOLDEN_SKILL_NAME,
  GOLDEN_STAGED_PREFERENCE,
  writeGoldenRerankerFixture
} from '../fixtures/fake-model-server'
import { assistantRecord, transcriptJsonl, userRecord } from '../fixtures/extraction-fakes'
import { launchGoldenApp, runGoldenSeed, type GoldenApp } from './launch'
import type { GoldenSeedResult } from '../fixtures/golden-seed'

const FIXTURE_MINI_REPO = fileURLToPath(new URL('../fixtures/mini-repo', import.meta.url))

/** Word-overlaps the mini-repo (computeSchedule / WateringSchedule / sensors). */
const GET_CONTEXT_TASK = 'how does the watering schedule engine compute watering minutes from sensor moisture readings'

// The whole gate is one ordered scenario; a red arrow invalidates the rest.
test.describe.configure({ mode: 'serial' })

// ── shared scenario state ─────────────────────────────────────────────────────

const fake = new FakeModelServer()
let scratchDir = ''
let userDataDir = ''
let miniRepoCopy = ''
let seed: GoldenSeedResult
let appEnv: Record<string, string> = {}
let app: GoldenApp | null = null
let mcpBearer = ''
let hookToken = ''
let client: Client | null = null
let sessionId = ''
let anyTestFailed = false

// ── helpers ───────────────────────────────────────────────────────────────────

async function connectMcp(): Promise<{ client: Client; transport: StreamableHTTPClientTransport }> {
  const transport = new StreamableHTTPClientTransport(new URL(MCP_URL), {
    requestInit: { headers: { Authorization: `Bearer ${mcpBearer}` } }
  })
  const c = new Client({ name: 'golden-path-e2e', version: '0.0.1' })
  await c.connect(transport)
  return { client: c, transport }
}

async function callTool(c: Client, name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const result = (await c.callTool({ name, arguments: args })) as {
    content: { type: string; text: string }[]
    isError?: boolean
  }
  const text = result.content[0]?.text ?? ''
  if (result.isError === true) throw new Error(`MCP tool ${name} errored: ${text}`)
  return JSON.parse(text) as Record<string, unknown>
}

/** Re-mount a panel so its IPC queries run fresh (only the active panel renders). */
async function reopenPanel(page: Page, key: string): Promise<void> {
  await page.getByTestId('nav-spend').click()
  await page.getByTestId(`nav-${key}`).click()
}

/** The memory browser's label chip ("Skill 1", "Component 12", …). */
function chip(page: Page, label: string): ReturnType<Page['getByRole']> {
  return page.getByRole('button', { name: new RegExp(`^${label} \\d+$`) })
}

async function chipCount(page: Page, label: string): Promise<number> {
  const text = (await chip(page, label).textContent()) ?? ''
  const match = /(\d+)$/.exec(text.trim())
  if (match === null) throw new Error(`memory chip '${label}' rendered no count (text: '${text}')`)
  return Number(match[1])
}

/** Poll a probe against a freshly re-mounted panel until it holds. */
async function pollPanel(
  page: Page,
  key: string,
  probe: () => Promise<boolean>,
  timeoutMs: number,
  label: string
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    await reopenPanel(page, key)
    await page.waitForTimeout(300) // let the panel's IPC round-trip land
    if (await probe()) return
    if (Date.now() > deadline) throw new Error(`timed out after ${timeoutMs}ms: ${label}`)
    await page.waitForTimeout(700)
  }
}

async function openSkillDetail(page: Page): Promise<void> {
  await page.locator(`[data-rowkey="${GOLDEN_SKILL_ID}"]`).click()
  await expect(page.getByTestId('skill-improvement')).toBeVisible({ timeout: 15_000 })
}

// eslint-disable-next-line no-empty-pattern -- Playwright mandates the object pattern here
test.afterEach(({}, testInfo) => {
  if (testInfo.status !== testInfo.expectedStatus) anyTestFailed = true
})

test.afterAll(async () => {
  test.setTimeout(120_000)
  if (anyTestFailed) {
    // Diagnosability on ANY failure: what the fake models served, what (if
    // anything) went unmatched, and the app's own words.
    console.log('[golden-path] fake server requests:', JSON.stringify(fake.requests, null, 2))
    console.log('[golden-path] fake server UNMATCHED markers:', JSON.stringify(fake.unmatched, null, 2))
    console.log('[golden-path] app stdout tail:\n', app?.stdout().slice(-8000) ?? '(no app)')
  }
  await client?.close().catch(() => undefined)
  client = null
  await app?.close().catch(() => undefined)
  app = null
  await fake.stop()
  if (scratchDir !== '') rmSync(scratchDir, { recursive: true, force: true })
  if (userDataDir !== '') {
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        rmSync(userDataDir, { recursive: true, force: true })
        break
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 500))
      }
    }
  }
})

// ── the golden path ───────────────────────────────────────────────────────────

test('arrow 0-1: fresh profile boots the production app on scripted models', async () => {
  test.setTimeout(240_000)

  await fake.start()

  // Scratch homes (system tmpdir — OneDrive paths break native file locking).
  scratchDir = mkdtempSync(join(tmpdir(), 'agentic-os-golden-scratch-'))
  userDataDir = mkdtempSync(join(tmpdir(), 'agentic-os-golden-udata-'))

  // Reranker fixture files pre-placed under <userData>/models with matching
  // sha256 pins so the PRODUCTION Reranker verifies and downloads NOTHING.
  const descriptorPath = join(userDataDir, 'reranker-files.json')
  writeGoldenRerankerFixture(join(userDataDir, 'models'), descriptorPath)

  // Seed the fresh profile in a child process (ryugraph lock discipline).
  seed = runGoldenSeed(userDataDir)
  expect(seed.skillId).toBe(GOLDEN_SKILL_ID)

  appEnv = {
    AGENTIC_OS_OLLAMA_BASE_URL: fake.url,
    AGENTIC_OS_CLOUD_BASE_URL: fake.url,
    AGENTIC_OS_RERANKER_FILES: descriptorPath,
    AGENTIC_OS_PRINT_MCP_TOKEN: '1',
    AGENTIC_OS_PRINT_HOOK_TOKEN: '1'
  }
  app = await launchGoldenApp({ userDataDir, env: appEnv })

  // The dev prints carry the real tokens this spec drives MCP + the hook with.
  const mcpLine = await app.waitForStdoutLine(/\[mcp\] dev: .*Authorization: Bearer /, 60_000)
  mcpBearer = /Authorization: Bearer ([^"\s]+)"/.exec(mcpLine)?.[1] ?? ''
  expect(mcpBearer).not.toBe('')
  const hookLine = await app.waitForStdoutLine(/\[triggers\] dev: session-end hook token: /, 60_000)
  hookToken = /session-end hook token: (\S+)/.exec(hookLine)?.[1] ?? ''
  expect(hookToken).not.toBe('')

  // ARROW (fresh profile): exactly the seeded Skill; no sessions, no
  // preferences, no components yet.
  const page = app.page
  await reopenPanel(page, 'memory')
  await expect(chip(page, 'Skill')).toHaveText(/^Skill\s*1$/, { timeout: 20_000 })
  await expect(chip(page, 'Session')).toHaveText(/^Session\s*0$/)
  await expect(chip(page, 'Preference')).toHaveText(/^Preference\s*0$/)
  await expect(chip(page, 'Component')).toHaveText(/^Component\s*0$/)
})

test('arrow 2: ingest_codebase over MCP → Components appear in memory', async () => {
  test.setTimeout(240_000)

  // Work on a COPY (the phase-07 discipline), restoring the checked-in
  // 'gitignore' to its live '.gitignore' name.
  miniRepoCopy = join(scratchDir, 'sprout')
  cpSync(FIXTURE_MINI_REPO, miniRepoCopy, { recursive: true })
  renameSync(join(miniRepoCopy, 'gitignore'), join(miniRepoCopy, '.gitignore'))

  const first = await connectMcp()
  client = first.client
  sessionId = first.transport.sessionId ?? ''
  expect(sessionId).not.toBe('')

  const reply = await callTool(client, 'ingest_codebase', { path: miniRepoCopy })
  expect(reply['status']).toBe('created')
  const components = reply['components'] as { total: number; created: number }
  expect(components.total).toBeGreaterThanOrEqual(12)
  expect(components.created).toBeGreaterThanOrEqual(12)

  // ARROW: the memory browser shows the ingested Component population.
  const page = app!.page
  await reopenPanel(page, 'memory')
  await expect(chip(page, 'Component')).toBeVisible({ timeout: 20_000 })
  expect(await chipCount(page, 'Component')).toBeGreaterThanOrEqual(12)
})

test('arrow 3: get_context assembles a bundle in which Components appear', async () => {
  test.setTimeout(240_000)

  const reply = await callTool(client!, 'get_context', { task: GET_CONTEXT_TASK })
  const items = reply['items'] as { id: string; label: string; text: string }[]
  expect(items.length).toBeGreaterThan(0)
  // Set-membership, never order-specific: the fixture reranker's scores are
  // garbage-but-deterministic; graph proximity is what surfaces Components.
  expect(items.some((item) => item.label === 'Component')).toBe(true)
  // The scripted critic passes on the first pass — the loop resolved cleanly.
  expect(reply['haltReason']).toBe('passed')
  expect(reply['confidence']).toBe('high')
})

test('arrows 4-6: session ends via hook → extraction populates memory', async () => {
  test.setTimeout(240_000)

  // get_skill makes the mcp_calls row that extraction turns into USED→Skill.
  const skillReply = await callTool(client!, 'get_skill', { name: GOLDEN_SKILL_NAME })
  expect(skillReply['id']).toBe(GOLDEN_SKILL_ID)
  expect(skillReply['instructions']).toBe(GOLDEN_SKILL_INSTRUCTIONS)

  // The finished session's transcript (Claude Code JSONL shape).
  const now = Date.now()
  const iso = (offsetMs: number): string => new Date(now + offsetMs).toISOString()
  const extras = (offsetMs: number): { sessionId: string; cwd: string; timestamp: string } => ({
    sessionId,
    cwd: miniRepoCopy,
    timestamp: iso(offsetMs)
  })
  const transcriptPath = join(scratchDir, `transcript-${sessionId}.jsonl`)
  writeFileSync(
    transcriptPath,
    transcriptJsonl([
      userRecord(
        'Please tidy the watering schedule module. I prefer two-space indentation over tabs in this project.',
        extras(0)
      ),
      assistantRecord('Applying two-space indentation across the schedule engine.', [], extras(1000)),
      userRecord('no - when using the golden-writer skill, always state assumptions first', extras(2000)),
      assistantRecord('Understood - I will state assumptions first when using golden-writer.', [], extras(3000))
    ]),
    'utf8'
  )

  // ARROW (hook): the POST is accepted and enqueues the deterministic task.
  const hookResponse = await fetch(HOOK_SESSION_END_URL, {
    method: 'POST',
    headers: { authorization: `Bearer ${hookToken}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      session_id: sessionId,
      transcript_path: transcriptPath,
      cwd: miniRepoCopy,
      reason: 'other'
    })
  })
  expect(hookResponse.status).toBe(200)
  const hookBody = (await hookResponse.json()) as { ok: boolean; taskId: string }
  expect(hookBody.ok).toBe(true)
  expect(hookBody.taskId).toBe(`extract-${sessionId}`)

  const page = app!.page

  // ARROW (extraction ran): the 0.4-confidence preference lands as EXACTLY
  // one staged review row — that implies the write step finished.
  await pollPanel(
    page,
    'review',
    async () => (await page.locator('[data-testid="staged-table"] [data-rowkey]').count()) >= 1,
    120_000,
    'staged extraction row to appear in the review queue'
  )
  expect(await page.locator('[data-testid="staged-table"] [data-rowkey]').count()).toBe(1)
  await expect(page.locator('[data-testid="staged-table"] [data-rowkey]').first()).toContainText('extraction')

  // ARROW (task): the durable queue records the extraction task as done.
  await pollPanel(
    page,
    'tasks',
    async () =>
      (await page.locator(`[data-rowkey="extract-${sessionId}"] [data-status="done"]`).count()) === 1,
    60_000,
    `task extract-${sessionId} to reach status done`
  )

  // ARROW (memory): Session committed; the 0.9 preference committed with
  // provenance; the correction committed (its IMPROVED edge feeds arrow 8).
  await reopenPanel(page, 'memory')
  await expect(chip(page, 'Session')).toHaveText(/^Session\s*1$/, { timeout: 20_000 })
  await expect(chip(page, 'Preference')).toHaveText(/^Preference\s*1$/)
  await expect(chip(page, 'Correction')).toHaveText(/^Correction\s*1$/)

  await chip(page, 'Preference').click()
  const prefRow = page.locator('[data-rowkey^="Preference:"]', { hasText: 'two-space indentation' })
  await expect(prefRow).toBeVisible({ timeout: 20_000 })
  await prefRow.click()
  const inspector = page.getByTestId('memory-inspector')
  await expect(inspector).toContainText('extraction@0.0.1/llm-local', { timeout: 20_000 })
  await expect(inspector).toContainText(GOLDEN_COMMITTED_PREFERENCE)
})

test('arrow 7: the staged write is approved in the dashboard and committed', async () => {
  test.setTimeout(240_000)
  const page = app!.page

  await reopenPanel(page, 'review')
  const row = page.locator('[data-testid="staged-table"] [data-rowkey]').first()
  await expect(row).toBeVisible({ timeout: 20_000 })
  await row.click()

  // Human-readable diff BEFORE any commit (§13).
  const diff = page.getByTestId('staged-diff')
  await expect(diff).toBeVisible({ timeout: 20_000 })
  await expect(diff).toContainText('weak guess preference')

  await page.getByTestId('staged-approve').click()
  await expect(page.getByTestId('toasts')).toContainText('committed', { timeout: 20_000 })
  await expect(page.locator('[data-testid="staged-table"] [data-rowkey]')).toHaveCount(0, { timeout: 20_000 })

  // ARROW: the staged statement is now IN the graph under Preference.
  await reopenPanel(page, 'memory')
  await expect(chip(page, 'Preference')).toHaveText(/^Preference\s*2$/, { timeout: 20_000 })
  await chip(page, 'Preference').click()
  await expect(
    page.locator('[data-rowkey^="Preference:"]', { hasText: GOLDEN_STAGED_PREFERENCE })
  ).toBeVisible({ timeout: 20_000 })
})

test('arrow 8: the audited file write is undone — bytes restored exactly', async () => {
  test.setTimeout(240_000)
  const page = app!.page

  // Pre-condition: the seed really overwrote the file.
  expect(readFileSync(seed.auditedFilePath, 'utf8')).not.toBe(seed.originalContent)

  await reopenPanel(page, 'audit')
  const undoButton = page.getByTestId(`audit-undo-${seed.undoActionId}`)
  await expect(undoButton).toBeVisible({ timeout: 20_000 })
  await undoButton.click()
  await page.getByTestId('audit-undo-confirm').click()

  // The row flips to undone; its undo affordance is gone.
  await expect(page.getByTestId(`audit-undo-${seed.undoActionId}`)).toHaveCount(0, { timeout: 20_000 })
  await expect(page.locator('[data-status="undone"]').first()).toBeVisible()

  // ARROW: byte-for-byte restore, compared in THIS process.
  expect(readFileSync(seed.auditedFilePath).equals(Buffer.from(seed.originalContent, 'utf8'))).toBe(true)
})

test('arrow 9: api key set; relaunch keeps memory and arms the cloud tier', async () => {
  test.setTimeout(240_000)
  const page = app!.page

  await reopenPanel(page, 'settings')
  await expect(page.getByTestId('settings-provider')).toHaveValue('openai', { timeout: 20_000 })
  await page.getByTestId('settings-set-key-openai').click()
  await page.getByTestId('settings-key-input').fill('sk-golden-e2e-fake')
  await page.getByTestId('settings-key-save').click()
  await expect(page.getByTestId('toasts')).toContainText('key saved', { timeout: 20_000 })

  // Relaunch over the SAME profile.
  await client?.close().catch(() => undefined)
  client = null
  await app!.close({ keepUserData: true })
  app = await launchGoldenApp({ userDataDir, env: appEnv })

  // ARROW (durability + cloud tier): the agent boots ARMED on the scripted
  // provider, and the extracted memory survived the restart.
  await app.waitForStdoutLine(/\[agents\] skill-improvement agent ready .*cloud tier: openai/, 60_000)
  const page2 = app.page
  await reopenPanel(page2, 'memory')
  await expect(chip(page2, 'Preference')).toHaveText(/^Preference\s*2$/, { timeout: 20_000 })
  await expect(chip(page2, 'Skill')).toHaveText(/^Skill\s*1$/)
})

test('arrows 10-11: the skill job improves + adopts; get_skill serves the learned version', async () => {
  test.setTimeout(240_000)
  const page = app!.page

  await reopenPanel(page, 'skills')
  await openSkillDetail(page)

  // Verifiable mode: net-positive + zero-regression auto-adopts (§17).
  await page.getByTestId('skill-mode-select').selectOption('verifiable')
  await expect(page.getByTestId('toasts')).toContainText('adoption mode: verifiable', { timeout: 20_000 })

  await page.getByTestId('skill-improve-now').click()
  await expect(page.getByTestId('toasts')).toContainText('improvement task enqueued', { timeout: 20_000 })

  // ARROW (adopt): testset(cloud) → candidate(cloud) → benchmark(local ×3) →
  // audited flip. Poll the ledger for the adopted entry.
  await pollPanel(
    page,
    'skills',
    async () => {
      await openSkillDetail(page)
      return (
        (await page
          .locator('[data-testid="skill-improvement-history"] [data-status="adopted"]')
          .count()) >= 1
      )
    },
    180_000,
    'skill-improvement ledger to record an adoption'
  )

  // The skill detail now serves the ADOPTED instructions.
  await expect(page.getByTestId('skill-detail')).toContainText(GOLDEN_ADOPT_MARKER)

  // ARROW (the loop closes over MCP): a NEW client session reads the adopted
  // instructions through get_skill — the same bearer survives the relaunch.
  const second = await connectMcp()
  client = second.client
  const reply = await callTool(client, 'get_skill', { name: GOLDEN_SKILL_NAME })
  expect(String(reply['instructions'])).toContain(GOLDEN_ADOPT_MARKER)
  const activeVersion = reply['activeVersion'] as { id: string; instructions: string } | null
  expect(activeVersion).not.toBeNull()
  expect(activeVersion?.instructions).toContain(GOLDEN_ADOPT_MARKER)
})
