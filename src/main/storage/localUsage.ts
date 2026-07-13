/**
 * Local-LLM usage ledger (appdata v9) — the WRITE + RETENTION side of the
 * local-LLM visibility feature. One row per local qwen3 reasoning call flows in
 * through the Ollama generate() chokepoint (src/main/models/ollama.ts): the
 * client holds an OPTIONAL `LocalLlmUsageRecorder` and calls `record()` after
 * every generate — success or failure. Absent recorder ⇒ today's byte-identical
 * behavior (every test rig that constructs an OllamaClient without one records
 * nothing). The read/aggregation side lives in src/main/reads/localUsage.ts.
 *
 * Provenance / scope: EMBEDDINGS are never recorded — the embedder (bge-m3) is
 * schema-pinned and out of scope; this ledger is the qwen3 REASONING tier only.
 * The recorder MUST NEVER fail the call: the Ollama seam wraps `record()` in a
 * swallow-and-log, so a full disk / closed handle degrades to a missing row, not
 * a failed completion.
 */
import type BetterSqlite3 from 'better-sqlite3'
import { LOCAL_LLM_USAGE_RETENTION_DAYS } from '../config'

/** One recorded local reasoning call. `role` null ⇒ a direct deps.llm call (no role context). */
export interface LocalLlmUsageEntry {
  /** The §2.2 role the call served, or null when the caller threaded none. */
  readonly role: string | null
  /** Resolved model id (Ollama's reported model, else the requested one). */
  readonly model: string
  /** Ollama prompt_eval_count; null when the daemon reported none (e.g. an error). */
  readonly promptTokens: number | null
  /** Ollama eval_count; null when the daemon reported none. */
  readonly evalTokens: number | null
  /** Ollama total_duration in ms when present, else wall-clock elapsed. */
  readonly durationMs: number
  /** True when generate() returned a completion; false for an errored call. */
  readonly ok: boolean
}

/**
 * The seam OllamaClient.generate calls after each completion. Kept a bare
 * interface so the client depends on a contract, not on SQLite — a test may pass
 * a recording fake, and production passes {@link LocalLlmUsageStore}.
 */
export interface LocalLlmUsageRecorder {
  record(entry: LocalLlmUsageEntry): void
}

/**
 * appdata.db-backed recorder over the v9 `local_llm_usage` table. A single
 * prepared INSERT; `record()` MAY throw (closed handle / disk-full) — the Ollama
 * seam swallows it, so this stays a trivial writer with no error handling of its
 * own (the "never fail the call" guarantee is enforced at the seam, and unit
 * tests pin it there).
 */
export class LocalLlmUsageStore implements LocalLlmUsageRecorder {
  private readonly insert: BetterSqlite3.Statement

  constructor(db: BetterSqlite3.Database) {
    this.insert = db.prepare(
      `INSERT INTO local_llm_usage (role, model, prompt_tokens, eval_tokens, duration_ms, ok)
       VALUES (@role, @model, @promptTokens, @evalTokens, @durationMs, @ok)`
    )
  }

  record(entry: LocalLlmUsageEntry): void {
    this.insert.run({
      role: entry.role,
      model: entry.model,
      promptTokens: entry.promptTokens,
      evalTokens: entry.evalTokens,
      durationMs: entry.durationMs,
      ok: entry.ok ? 1 : 0
    })
  }
}

/**
 * Boot retention: delete usage rows older than `days`
 * (LOCAL_LLM_USAGE_RETENTION_DAYS by default). Returns the number pruned. The
 * ledger is observability only, so this is a plain time-based sweep with no
 * exactly-once tokens to preserve (unlike the task-row prune). Called once per
 * boot from bootModels; cheap (indexed on ts).
 */
export function pruneLocalLlmUsage(db: BetterSqlite3.Database, days: number = LOCAL_LLM_USAGE_RETENTION_DAYS): number {
  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString()
  const info = db.prepare('DELETE FROM local_llm_usage WHERE ts < ?').run(cutoff)
  return info.changes
}
