/**
 * get_runner_status / runner.status shape (phase 17, §4.F). Pins the reads-layer
 * source shared by the MCP tool AND the dashboard IPC handler: the health-cache
 * snapshot + the latest runner_runs row + the agent-mode tombstone count. Also
 * pins the DEFAULT == TODAY reading — a null runner (never booted / off) reports
 * the disabled/unknown shape without erroring, while the durable ledger reads
 * still work off appdata.db.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { getRunnerStatus, type RunnerStatusSource } from '../../src/main/reads'
import type { RunnerHealthSnapshot } from '../../src/main/runner'
import { openAppData, type AppData } from '../../src/main/storage'

let dir: string
let appData: AppData

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'agentic-os-runner-status-'))
  appData = openAppData(join(dir, 'appdata.db'))
})

afterEach(() => {
  appData.close()
  rmSync(dir, { recursive: true, force: true })
})

/** A healthy, enabled runner snapshot (as the health cache would report). */
const HEALTHY: RunnerHealthSnapshot = {
  enabled: true,
  resolved: { path: '/usr/local/bin/claude', command: '/usr/local/bin/claude', prefixArgs: [], strategy: 'well-known' },
  binaryPath: '/usr/local/bin/claude',
  version: '1.2.3',
  versionOk: true,
  state: 'ok',
  checkedAtMs: 1_000_000,
  lastAuthOkAtMs: 1_700_000_000_000,
  lastError: null
}

const sourceOf = (snap: RunnerHealthSnapshot): RunnerStatusSource => ({ healthSnapshot: () => snap })

interface SeedRun {
  id: string
  taskId: string
  mode: string
  model?: string | null
  startedAt: string
  claudeSessionId?: string | null
  inputTokens?: number | null
  outputTokens?: number | null
  shadowCostUsd?: number | null
  isError?: number | null
  exitCode?: number | null
}

function insertRun(r: SeedRun): void {
  appData.db
    .prepare(
      `INSERT INTO runner_runs
         (id, task_id, mode, model, claude_session_id, started_at, duration_ms, num_turns,
          input_tokens, output_tokens, shadow_cost_usd, is_error, exit_code)
       VALUES (@id, @task_id, @mode, @model, @claude_session_id, @started_at, @duration_ms, @num_turns,
          @input_tokens, @output_tokens, @shadow_cost_usd, @is_error, @exit_code)`
    )
    .run({
      id: r.id,
      task_id: r.taskId,
      mode: r.mode,
      model: r.model ?? null,
      claude_session_id: r.claudeSessionId ?? null,
      started_at: r.startedAt,
      duration_ms: 42,
      num_turns: 1,
      input_tokens: r.inputTokens ?? null,
      output_tokens: r.outputTokens ?? null,
      shadow_cost_usd: r.shadowCostUsd ?? null,
      is_error: r.isError ?? null,
      exit_code: r.exitCode ?? null
    })
}

describe('getRunnerStatus (§4.F read shape)', () => {
  it('reports the disabled/unknown shape when no runner booted + an empty ledger', () => {
    const status = getRunnerStatus({ runner: null, db: appData.db })
    expect(status).toEqual({
      enabled: false,
      binaryPath: null,
      version: null,
      versionOk: false,
      state: 'unknown',
      lastAuthOkAt: null,
      lastError: null,
      lastRun: null,
      tombstonedSessions: 0
    })
  })

  it('maps the health snapshot, the latest runner_runs row, and the agent tombstone count', () => {
    // Latest-by-started_at should win regardless of insert order.
    insertRun({ id: 'rr-A', taskId: 'live:sess', mode: 'completion', startedAt: '2026-07-06T10:00:00.000Z' })
    insertRun({
      id: 'rr-B',
      taskId: 'wf-1',
      mode: 'completion',
      model: 'sonnet',
      startedAt: '2026-07-06T11:00:00.000Z',
      claudeSessionId: 'sess-completion', // completion sessions are NOT tombstoned
      inputTokens: 100,
      outputTokens: 50,
      shadowCostUsd: 0.02,
      isError: 0,
      exitCode: 0
    })
    // Agent-mode runs: two rows share one session (distinct count = 1), one has a null id.
    insertRun({ id: 'rr-C', taskId: 'wf-2', mode: 'agent', startedAt: '2026-07-06T09:00:00.000Z', claudeSessionId: 'sess-agent-1' })
    insertRun({ id: 'rr-D', taskId: 'wf-2', mode: 'agent', startedAt: '2026-07-06T08:00:00.000Z', claudeSessionId: 'sess-agent-1' })
    insertRun({ id: 'rr-E', taskId: 'wf-3', mode: 'agent', startedAt: '2026-07-06T07:00:00.000Z', claudeSessionId: null })

    const status = getRunnerStatus({ runner: sourceOf(HEALTHY), db: appData.db })

    expect(status.enabled).toBe(true)
    expect(status.binaryPath).toBe('/usr/local/bin/claude')
    expect(status.version).toBe('1.2.3')
    expect(status.versionOk).toBe(true)
    expect(status.state).toBe('ok')
    expect(status.lastAuthOkAt).toBe(new Date(1_700_000_000_000).toISOString())
    expect(status.lastError).toBeNull()

    // lastRun = the newest by started_at (rr-B), fully mapped.
    expect(status.lastRun).toEqual({
      id: 'rr-B',
      taskId: 'wf-1',
      mode: 'completion',
      model: 'sonnet',
      startedAt: '2026-07-06T11:00:00.000Z',
      durationMs: 42,
      numTurns: 1,
      inputTokens: 100,
      outputTokens: 50,
      shadowCostUsdEstimate: 0.02,
      isError: false,
      exitCode: 0
    })

    // DISTINCT agent claude_session_id only — completion + null excluded.
    expect(status.tombstonedSessions).toBe(1)
  })

  it('surfaces a sticky failure state (quota-exhausted) + its banner detail', () => {
    const status = getRunnerStatus({
      runner: sourceOf({ ...HEALTHY, state: 'quota-exhausted', lastAuthOkAtMs: null, lastError: 'usage limit reached' }),
      db: appData.db
    })
    expect(status.state).toBe('quota-exhausted')
    expect(status.lastAuthOkAt).toBeNull()
    expect(status.lastError).toBe('usage limit reached')
  })

  it('a disabled runner still reads the durable ledger (latest run + tombstones)', () => {
    insertRun({ id: 'rr-only', taskId: 'wf-x', mode: 'agent', startedAt: '2026-07-06T12:00:00.000Z', claudeSessionId: 'sess-z' })
    const status = getRunnerStatus({ runner: null, db: appData.db })
    expect(status.enabled).toBe(false)
    expect(status.state).toBe('unknown')
    expect(status.lastRun?.id).toBe('rr-only')
    expect(status.tombstonedSessions).toBe(1)
  })
})
