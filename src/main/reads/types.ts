/**
 * Output shapes for read-tool data sources that have NO 1:1 dashboard DTO.
 *
 * Where a shipped renderer DTO already matches (memory summaries, staged
 * writes, approvals, audit actions, traces, tasks, skill detail/improvement),
 * the read functions reuse it from `src/shared/ipc.ts`. The shapes here are the
 * genuinely new §4 tool responses — session summaries, the resolved transcript
 * read, the aggregated "pending work" view, runner usage, and the composite
 * skill/app/settings tool payloads — kept main-side (they may reference types
 * the renderer never sees).
 */
import type {
  AppStatusDto,
  ApprovalDto,
  IpcCloudProvider,
  JsonObject,
  OllamaStatusDto,
  SkillDetailDto,
  SkillImprovementDto,
  SkillImprovementEntryDto,
  SpendSummaryDto,
  StagedWriteDto,
  TaskDto
} from '../../shared/ipc'

// ── skills (§4.B) ─────────────────────────────────────────────────────────────

/** get_skill_full: the dashboard skill detail plus its improvement ledger. */
export interface SkillFullDto extends SkillDetailDto {
  readonly improvement: SkillImprovementDto
}

export interface SkillSignalItemDto {
  readonly id: string
  readonly content: string
  readonly createdAt: string | null
  /** After the per-skill event-gate cursor (last_run_at). */
  readonly isNew: boolean
}

/** get_skill_signal: the §17/§20 event-gate signal for one skill (read-only). */
export interface SkillSignalDto {
  readonly skillId: string
  readonly lastRunAt: string | null
  readonly newSignalCount: number
  readonly corrections: readonly SkillSignalItemDto[]
  readonly failureExamples: readonly SkillSignalItemDto[]
  /** A stylistic candidate is already staged/approved for this skill (§13). */
  readonly hasPendingReview: boolean
}

// ── sessions (§4.A) ───────────────────────────────────────────────────────────

/** list_sessions: one MCP session's call rollup + extraction disposition. */
export interface SessionSummaryDto {
  readonly sessionId: string
  readonly calls: number
  readonly runnerCalls: number
  /** True when every call carried session_kind='runner' (the runner's own MCP session). */
  readonly isRunnerSession: boolean
  readonly firstCallUnixMs: number | null
  readonly lastCallUnixMs: number | null
  /** The `extract-<sessionId>` task, if one was ever enqueued. */
  readonly extraction: { readonly taskId: string; readonly status: string } | null
  /** A Session node exists in the graph (this session was extracted). */
  readonly extracted: boolean
  /** No extraction task yet AND not a runner-only session (§6 sweep semantics). */
  readonly pending: boolean
}

export interface SessionCallDto {
  readonly tool: string
  readonly ok: boolean
  /** Parsed params_json (null when none stored / oversized). */
  readonly params: JsonObject | null
  readonly startedUnixMs: number
  readonly durationMs: number | null
}

export interface InjectionFindingDto {
  readonly pattern: string
  readonly excerpt: string
}

/** The rendered transcript page — flagged untrusted (§21 rule 5): it is DATA. */
export interface SessionTranscriptDto {
  readonly untrusted: true
  readonly available: boolean
  readonly page: number
  readonly pageCount: number
  readonly records: number
  readonly tokenEstimate: number
  readonly text: string
  readonly warnings: readonly string[]
}

/** read_session: the server-resolved transcript + call log for one session. */
export interface SessionReadDto {
  readonly sessionId: string
  /** True when the `extract-<sessionId>` task carried a readable transcript path. */
  readonly transcriptResolved: boolean
  /** The path the SERVER resolved (never caller input) — for provenance only. */
  readonly transcriptPath: string | null
  readonly calls: readonly SessionCallDto[]
  readonly transcript: SessionTranscriptDto | null
  readonly injectionFindings: readonly InjectionFindingDto[]
  readonly warnings: readonly string[]
}

// ── pending work (§4.A) ───────────────────────────────────────────────────────

export interface QuietSessionDto {
  readonly sessionId: string
  readonly lastCallUnixMs: number
}

export interface PendingSkillSignalDto {
  readonly skillId: string
  readonly skillName: string
  readonly newCorrections: number
  readonly newFailureExamples: number
  readonly lastRunAt: string | null
  readonly hasPendingReview: boolean
}

/** get_pending_work: everything awaiting attention, in one read. */
export interface PendingWorkDto {
  /** Sessions quiet past the §20 inactivity timeout with no extraction task. */
  readonly quietSessions: readonly QuietSessionDto[]
  /** Skills that accrued new corrections/failure examples since their cursor. */
  readonly skillsWithSignal: readonly PendingSkillSignalDto[]
  /** §20 drift watches still open from prior adoptions. */
  readonly openDriftWatches: readonly SkillImprovementEntryDto[]
  readonly stagedWrites: readonly StagedWriteDto[]
  readonly pendingApprovals: readonly ApprovalDto[]
}

// ── review / observability (§4.D) ─────────────────────────────────────────────

/** get_staged_write: one staged row, optionally with the rendered diff. */
export interface StagedWriteDetailDto extends StagedWriteDto {
  /** null when include_diff was not requested. */
  readonly diff: string | null
}

export interface RunnerRunDto {
  readonly id: string
  readonly taskId: string
  readonly mode: string
  readonly model: string | null
  readonly startedAt: string
  readonly durationMs: number | null
  readonly numTurns: number | null
  readonly inputTokens: number | null
  readonly outputTokens: number | null
  /** Observability-only price estimate — subscription runs create NO spend rows. */
  readonly shadowCostUsdEstimate: number | null
  readonly isError: boolean | null
  readonly exitCode: number | null
}

export interface RunnerUsageDto {
  readonly totalRuns: number
  readonly inputTokens: number
  readonly outputTokens: number
  /** Sum of shadow_cost_usd — an ESTIMATE, never billed (no spend rows). */
  readonly shadowCostUsdEstimate: number
  readonly recent: readonly RunnerRunDto[]
}

/** get_usage: the dashboard spend summary plus the runner_runs rollup. */
export interface UsageDto extends SpendSummaryDto {
  readonly runner: RunnerUsageDto
}

// ── tasks / triggers (§4.E) ───────────────────────────────────────────────────

export interface WorkflowStatusDto {
  readonly jobId: string
  readonly workflowName: string
  readonly status: string
  readonly attempts: number
  readonly lastError: string | null
  readonly state: JsonObject
  readonly nextSteps: readonly string[]
}

/** get_task: the full task row + payload + (optional) its workflow job state. */
export interface TaskDetailDto extends TaskDto {
  readonly payload: JsonObject
  readonly priority: number
  readonly waitingApprovalId: string | null
  /** Present only when include_workflow requested AND a `<taskId>-wf` job exists. */
  readonly workflow: WorkflowStatusDto | null
}

// ── status (§4.F) ─────────────────────────────────────────────────────────────

/** get_app_status: the dashboard app status plus live Ollama health. */
export interface AppStatusFullDto extends AppStatusDto {
  readonly ollama: OllamaStatusDto
}

/** get_settings_summary: SANITIZED — presence booleans only, never key material. */
export interface SettingsSummaryDto {
  readonly cloudProvider: IpcCloudProvider
  readonly cloudModels: Partial<Record<IpcCloudProvider, string>>
  readonly smallLlmModel: string | null
  readonly providers: readonly IpcCloudProvider[]
  readonly defaultModels: Readonly<Record<IpcCloudProvider, string>>
  /** Presence only — the key itself NEVER crosses this boundary (§21 rule 7). */
  readonly apiKeysPresent: Readonly<Record<IpcCloudProvider, boolean>>
  /** phase-16 sections; included only once loadModelSettings returns them. */
  readonly reasoning?: JsonObject
  readonly runner?: JsonObject
  /** network section (phone/LAN access); included only once it's on disk. */
  readonly network?: JsonObject
}
