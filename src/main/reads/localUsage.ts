/**
 * Local-LLM usage read (local-LLM visibility) — the shared source behind BOTH
 * the dashboard `usage.local.summary` IPC handler and the `get_local_usage` MCP
 * read tool. Read-only: aggregates the appdata `local_llm_usage` ledger over a
 * day window and (when an Ollama client is supplied) composes a live resource
 * snapshot on top. Mirrors observability.ts — raw SQL here, DTO out.
 *
 * The live probe is graceful: `ps()` degrades to `[]` on a down daemon and
 * `status()` to 'daemon-not-running'; a probe failure never fails the read. The
 * DB aggregation is exact and TZ-independent (`byDay` keys are the UTC date slice
 * of each row's ts — the renderer derives "today" via
 * new Date().toISOString().slice(0,10) to match).
 */
import type BetterSqlite3 from 'better-sqlite3'
import {
  LOCAL_LLM_USAGE_RECENT_LIMIT,
  LOCAL_LLM_USAGE_SUMMARY_DEFAULT_DAYS,
  LOCAL_LLM_USAGE_SUMMARY_MAX_DAYS
} from '../config'
import type { OllamaClient, OllamaState } from '../models'
import type {
  LocalLoadedModelDto,
  LocalUsageCallDto,
  LocalUsageDayDto,
  LocalUsageRoleDto,
  LocalUsageSummaryDto
} from '../../shared/ipc'

/** The subset of OllamaClient the summary probes — supplied by IPC/MCP, or null when the model layer is absent. */
export type LocalUsageOllama = Pick<OllamaClient, 'ps' | 'status'>

export interface LocalUsageDeps {
  readonly db: BetterSqlite3.Database
  readonly ollama?: LocalUsageOllama | null
}

export interface LocalUsageArgs {
  readonly sinceDays?: number
}

/** Clamp the requested window to [1, MAX]; a non-finite/absent value falls back to the default. */
function clampSinceDays(requested: number | undefined): number {
  const raw = requested ?? LOCAL_LLM_USAGE_SUMMARY_DEFAULT_DAYS
  if (!Number.isFinite(raw)) return LOCAL_LLM_USAGE_SUMMARY_DEFAULT_DAYS
  return Math.min(Math.max(Math.trunc(raw), 1), LOCAL_LLM_USAGE_SUMMARY_MAX_DAYS)
}

/**
 * usage.local.summary / get_local_usage. `sinceDays` windows totals/byRole/byDay;
 * `recent` is always the newest LOCAL_LLM_USAGE_RECENT_LIMIT rows regardless of
 * the window. When `deps.ollama` is present, `loaded`/`ollamaState` come from a
 * live probe (ps + status, in parallel); otherwise `[]` + 'daemon-not-running'.
 */
export async function getLocalUsage(deps: LocalUsageDeps, args: LocalUsageArgs = {}): Promise<LocalUsageSummaryDto> {
  const { db } = deps
  const sinceDays = clampSinceDays(args.sinceDays)
  const cutoff = new Date(Date.now() - sinceDays * 24 * 60 * 60 * 1000).toISOString()

  const totals = db
    .prepare(
      `SELECT COUNT(*) AS calls,
              COALESCE(SUM(prompt_tokens), 0) AS prompt_tokens,
              COALESCE(SUM(eval_tokens), 0) AS eval_tokens,
              COALESCE(SUM(duration_ms), 0) AS compute_ms
       FROM local_llm_usage WHERE ts >= ?`
    )
    .get(cutoff) as { calls: number; prompt_tokens: number; eval_tokens: number; compute_ms: number }

  const byRoleRows = db
    .prepare(
      `SELECT COALESCE(role, 'other') AS role,
              COUNT(*) AS calls,
              COALESCE(SUM(duration_ms), 0) AS compute_ms
       FROM local_llm_usage WHERE ts >= ?
       GROUP BY COALESCE(role, 'other')
       ORDER BY compute_ms DESC, calls DESC, role ASC`
    )
    .all(cutoff) as { role: string; calls: number; compute_ms: number }[]

  const byDayRows = db
    .prepare(
      `SELECT substr(ts, 1, 10) AS day,
              COUNT(*) AS calls,
              COALESCE(SUM(duration_ms), 0) AS compute_ms
       FROM local_llm_usage WHERE ts >= ?
       GROUP BY substr(ts, 1, 10)
       ORDER BY day ASC`
    )
    .all(cutoff) as { day: string; calls: number; compute_ms: number }[]

  const recentRows = db
    .prepare(
      `SELECT id, ts, role, model, prompt_tokens, eval_tokens, duration_ms, ok
       FROM local_llm_usage ORDER BY id DESC LIMIT ?`
    )
    .all(LOCAL_LLM_USAGE_RECENT_LIMIT) as {
    id: number
    ts: string
    role: string | null
    model: string
    prompt_tokens: number | null
    eval_tokens: number | null
    duration_ms: number | null
    ok: number
  }[]

  let loaded: readonly LocalLoadedModelDto[] = []
  let ollamaState: OllamaState = 'daemon-not-running'
  if (deps.ollama) {
    const ollama = deps.ollama
    const [loadedResult, stateResult] = await Promise.all([
      ollama.ps().catch((): LocalLoadedModelDto[] => []),
      ollama
        .status()
        .then((s) => s.state)
        .catch((): OllamaState => 'daemon-not-running')
    ])
    loaded = loadedResult.map(
      (m): LocalLoadedModelDto => ({
        name: m.name,
        sizeBytes: m.sizeBytes,
        sizeVramBytes: m.sizeVramBytes,
        expiresAt: m.expiresAt
      })
    )
    ollamaState = stateResult
  }

  return {
    sinceDays,
    totals: {
      calls: totals.calls,
      promptTokens: totals.prompt_tokens,
      evalTokens: totals.eval_tokens,
      computeMs: totals.compute_ms
    },
    byRole: byRoleRows.map((r): LocalUsageRoleDto => ({ role: r.role, calls: r.calls, computeMs: r.compute_ms })),
    byDay: byDayRows.map((r): LocalUsageDayDto => ({ day: r.day, calls: r.calls, computeMs: r.compute_ms })),
    recent: recentRows.map(
      (r): LocalUsageCallDto => ({
        id: r.id,
        ts: r.ts,
        role: r.role,
        model: r.model,
        promptTokens: r.prompt_tokens,
        evalTokens: r.eval_tokens,
        durationMs: r.duration_ms,
        ok: r.ok === 1
      })
    ),
    loaded,
    ollamaState
  }
}
