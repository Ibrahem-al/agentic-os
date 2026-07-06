/**
 * Runner status read (§4.F, phase 17) — the shared source behind BOTH the
 * `get_runner_status` MCP tool and the dashboard's `runner.status` IPC handler,
 * so the tool and its settings panel can never drift.
 *
 * It composes two sources: the runner module's in-memory health cache (resolved
 * binary + version + last state, learned from real-run classification — there is
 * no offline "am I logged in" probe, §9.7) and the durable `runner_runs` ledger
 * (the latest row + the agent-mode tombstone count). It is READ-ONLY: it never
 * spawns `claude` (that is the manual test-connection canary, §3.7) and never
 * writes. A default install reports `enabled:false` / `state:'unknown'`.
 */
import type BetterSqlite3 from 'better-sqlite3'
import type { RunnerRunSummaryDto, RunnerStatusDto } from '../../shared/ipc'
// Type-only (no runtime coupling to the runner module from the reads layer).
import type { RunnerHealthSnapshot } from '../runner'

/**
 * The runner facade viewed as a health source (`healthSnapshot()` only). The
 * phase-17 `Runner` satisfies it structurally; a launch where the runner never
 * booted passes `null` and the status degrades to the disabled/unknown shape.
 */
export interface RunnerStatusSource {
  healthSnapshot(): RunnerHealthSnapshot
}

export interface RunnerStatusDeps {
  /** The subscription runner facade; null when it did not boot this launch. */
  readonly runner: RunnerStatusSource | null
  readonly db: BetterSqlite3.Database
}

const iso = (ms: number | null): string | null => (ms === null ? null : new Date(ms).toISOString())

/**
 * get_runner_status (§4.F): the health-cache snapshot + the latest `runner_runs`
 * row + the agent-mode tombstone count. The `state` faithfully surfaces the full
 * five-value health union (incl. `quota-exhausted`, which the abbreviated §4.F
 * output list predates) so the dashboard banner can act on it.
 */
export function getRunnerStatus(deps: RunnerStatusDeps): RunnerStatusDto {
  const snap = deps.runner?.healthSnapshot() ?? null
  return {
    enabled: snap?.enabled ?? false,
    binaryPath: snap?.binaryPath ?? null,
    version: snap?.version ?? null,
    versionOk: snap?.versionOk ?? false,
    state: snap?.state ?? 'unknown',
    lastAuthOkAt: iso(snap?.lastAuthOkAtMs ?? null),
    lastError: snap?.lastError ?? null,
    lastRun: latestRunnerRun(deps.db),
    tombstonedSessions: countTombstonedSessions(deps.db)
  }
}

interface RunnerRunRow {
  id: string
  task_id: string
  mode: string
  model: string | null
  started_at: string
  duration_ms: number | null
  num_turns: number | null
  input_tokens: number | null
  output_tokens: number | null
  shadow_cost_usd: number | null
  is_error: number | null
  exit_code: number | null
}

/** The most recent runner_runs row (null when the ledger is empty). */
function latestRunnerRun(db: BetterSqlite3.Database): RunnerRunSummaryDto | null {
  const row = db
    .prepare(
      `SELECT id, task_id, mode, model, started_at, duration_ms, num_turns, input_tokens, output_tokens,
              shadow_cost_usd, is_error, exit_code
       FROM runner_runs ORDER BY started_at DESC, id DESC LIMIT 1`
    )
    .get() as RunnerRunRow | undefined
  if (row === undefined) return null
  return {
    id: row.id,
    taskId: row.task_id,
    mode: row.mode,
    model: row.model,
    startedAt: row.started_at,
    durationMs: row.duration_ms,
    numTurns: row.num_turns,
    inputTokens: row.input_tokens,
    outputTokens: row.output_tokens,
    shadowCostUsdEstimate: row.shadow_cost_usd,
    isError: row.is_error === null ? null : row.is_error === 1,
    exitCode: row.exit_code
  }
}

/**
 * Agent-mode tombstoned sessions (§3.6/§10.2): distinct claude session ids the
 * runner has recorded under agent mode, each of which gets a `done` tombstone so
 * the runner's own session is never recursively extracted. 0 in completion mode
 * (this phase never runs agent mode) — the count grows only once phase-19 lands,
 * matching the §10.10 "so growth is observable" gauge. Counting off `runner_runs`
 * (not the `tasks` mirror) keeps it unambiguously about the runner: a real user
 * session's `extract-<sid>` `done` row can never be miscounted here.
 */
function countTombstonedSessions(db: BetterSqlite3.Database): number {
  const row = db
    .prepare(
      `SELECT COUNT(DISTINCT claude_session_id) AS c FROM runner_runs
       WHERE mode = 'agent' AND claude_session_id IS NOT NULL`
    )
    .get() as { c: number }
  return row.c
}
