/**
 * Typed IPC contract (spec §21 rule 8): the single shared vocabulary between
 * the Electron main process and the renderer. This file is included by BOTH
 * tsconfig.node.json and tsconfig.web.json, so it must stay dependency-free —
 * plain JSON-serializable types only, no Node, no Electron, no main-process
 * imports. Main-side handlers (src/main/ipc.ts) convert real store rows into
 * these DTOs; the preload bridge (src/preload) exposes one method per channel.
 *
 * Every response crosses the boundary as an IpcResult envelope so backend
 * errors arrive structured (stable code + operator-readable message) instead
 * of as Electron's mangled rejection strings.
 */

/** Any JSON-serializable value (no `any` in the contract — spec/phase DoD). */
export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue }
export type JsonObject = { [key: string]: JsonValue }

export type IpcResult<T> = { ok: true; data: T } | { ok: false; code: string; message: string }

// ── shared vocabulary (mirrors main-process types structurally) ──────────────

export const IPC_NODE_LABELS = [
  'Session',
  'Project',
  'Skill',
  'SkillVersion',
  'Example',
  'Correction',
  'Preference',
  'MCP',
  'Plugin',
  'Component',
  'Document',
  'Knowledge',
  'Tag'
] as const
export type IpcNodeLabel = (typeof IPC_NODE_LABELS)[number]

export const IPC_RETRIEVABLE_LABELS = ['Project', 'Skill', 'Preference', 'Knowledge'] as const

export const IPC_CLOUD_PROVIDERS = ['anthropic', 'openai', 'gemini', 'openrouter'] as const
export type IpcCloudProvider = (typeof IPC_CLOUD_PROVIDERS)[number]

// ── app ───────────────────────────────────────────────────────────────────────

export interface AppStatusDto {
  readonly version: string
  readonly platform: string
  readonly userDataDir: string
  /** Which boot stages produced live singletons this launch. */
  readonly subsystems: {
    readonly storage: boolean
    readonly models: boolean
    readonly kernel: boolean
    readonly mcp: boolean
    readonly agents: boolean
  }
  /** MCP server URL when it is listening (null: disabled this launch). */
  readonly mcpUrl: string | null
}

// ── memory browser ────────────────────────────────────────────────────────────

export interface LabelCountDto {
  readonly label: IpcNodeLabel
  readonly count: number
}

export interface MemoryNodeSummaryDto {
  readonly label: IpcNodeLabel
  readonly id: string
  /** One-line human handle (name / statement / content head, label-specific). */
  readonly display: string
  readonly updatedAt: string | null
}

export interface MemorySearchHitDto {
  readonly label: IpcNodeLabel
  readonly id: string
  readonly text: string
  readonly rerankScore: number
  readonly fusedScore: number
  readonly signals: { readonly vector: number; readonly keyword: number; readonly graph: number }
}

export interface MemoryEdgeDto {
  readonly type: string
  readonly direction: 'out' | 'in'
  readonly label: IpcNodeLabel
  readonly id: string
  readonly display: string
  /** Edge properties (provenance stamps ride here). */
  readonly props: JsonObject
}

export interface MemoryNodeDetailDto {
  readonly label: IpcNodeLabel
  readonly id: string
  /** Node properties minus the embedding vector (never shipped to the UI). */
  readonly props: JsonObject
  readonly outgoing: readonly MemoryEdgeDto[]
  readonly incoming: readonly MemoryEdgeDto[]
}

// ── review queue ──────────────────────────────────────────────────────────────

export type StagedWriteStatusDto = 'staged' | 'approved' | 'rejected' | 'committed'

export interface StagedWriteDto {
  readonly id: string
  readonly proposedBy: string
  readonly kind: string
  readonly targetLabel: string | null
  readonly targetId: string | null
  readonly payload: JsonObject
  readonly status: StagedWriteStatusDto
  readonly validation: JsonObject | null
  readonly createdAt: string
  readonly decidedAt: string | null
  readonly committedAt: string | null
}

export interface ApprovalDto {
  readonly id: string
  readonly agentId: string
  readonly actionKind: string
  readonly actionName: string
  readonly tier: string
  readonly details: JsonObject
  readonly status: 'pending' | 'approved' | 'denied'
  readonly requestedAt: string
  readonly decidedAt: string | null
  readonly decidedBy: string | null
}

export interface InjectionFlagDto {
  readonly id: string
  readonly source: string
  readonly detector: 'regex' | 'llm'
  readonly pattern: string
  readonly excerpt: string
  readonly createdAt: string
}

// ── audit / undo ──────────────────────────────────────────────────────────────

export type AuditKindDto = 'action' | 'graph-write' | 'file-write' | 'file-delete' | 'undo'

export interface AuditActionDto {
  readonly id: string
  readonly agentId: string
  readonly kind: AuditKindDto
  readonly description: string
  readonly reversible: boolean
  readonly outcome: 'ok' | 'error'
  readonly error: string | null
  readonly details: JsonObject
  readonly undoneAt: string | null
  readonly undoActionId: string | null
  readonly createdAt: string
}

// ── spend ─────────────────────────────────────────────────────────────────────

export interface SpendEntryDto {
  readonly id: number
  readonly taskId: string | null
  readonly provider: string | null
  readonly model: string | null
  readonly inputTokens: number | null
  readonly outputTokens: number | null
  readonly usd: number
  readonly createdAt: string
}

export interface SpendTaskAggregateDto {
  readonly taskId: string
  readonly usd: number
  readonly calls: number
  readonly lastAt: string
}

export interface SpendSummaryDto {
  readonly totalUsd: number
  readonly last24hUsd: number
  readonly ceilingUsd: number
  readonly byTask: readonly SpendTaskAggregateDto[]
  readonly recent: readonly SpendEntryDto[]
}

// ── tasks & watched folders ───────────────────────────────────────────────────

export interface TaskDto {
  readonly id: string
  readonly kind: string
  readonly status: 'pending' | 'running' | 'done' | 'failed' | 'deferred'
  readonly attempts: number
  readonly notBeforeUnixMs: number | null
  readonly lastError: string | null
  readonly createdAt: string
  readonly updatedAt: string
}

export interface WatchedFolderDto {
  readonly name: string
  readonly path: string
  readonly tags: readonly string[]
  readonly extensions?: readonly string[]
  readonly enabled: boolean
}

export interface WatchScanResultDto {
  readonly folder: string
  readonly path: string
  readonly scannedFiles: number
  readonly ingested: readonly { readonly file: string; readonly status: string; readonly chunkCount: number }[]
  readonly skipped: readonly { readonly file: string; readonly reason: string }[]
  readonly failed: readonly { readonly file: string; readonly error: string }[]
}

// ── traces ────────────────────────────────────────────────────────────────────

export interface TraceSummaryDto {
  readonly traceId: string
  readonly rootName: string
  readonly startUnixMs: number
  readonly durationMs: number | null
  readonly spanCount: number
  readonly errorCount: number
}

export interface TraceSpanDto {
  readonly spanId: string
  readonly parentSpanId: string | null
  readonly name: string
  readonly kind: string | null
  readonly startUnixMs: number
  readonly endUnixMs: number | null
  readonly status: string | null
  readonly attributes: JsonObject
}

// ── skills ────────────────────────────────────────────────────────────────────

export interface SkillSummaryDto {
  readonly id: string
  readonly name: string
  readonly currentVersion: string | null
  readonly versionCount: number
  readonly exampleCount: number
  readonly failureExampleCount: number
  readonly correctionCount: number
  readonly sessionUseCount: number
  readonly activeBenchmarkScore: number | null
}

export interface SkillVersionDto {
  readonly id: string
  readonly status: string
  readonly benchmarkScore: number | null
  readonly instructions: string
  readonly createdAt: string | null
}

export interface SkillDetailDto {
  readonly id: string
  readonly name: string
  readonly instructions: string
  readonly currentVersion: string | null
  readonly versions: readonly SkillVersionDto[]
  readonly examples: readonly { readonly id: string; readonly kind: string; readonly content: string }[]
  readonly corrections: readonly { readonly id: string; readonly content: string }[]
}

// ── skill improvement (§17 agent #4, phase 12) ────────────────────────────────

export type SkillAdoptionModeDto = 'verifiable' | 'stylistic'

export interface SkillImprovementSettingsDto {
  /** verifiable = auto-adopt behind the no-regression gate; stylistic = review queue. */
  readonly mode: SkillAdoptionModeDto
  /** §20 drift watch: auto-revert on a worse-than-predecessor verdict (default off). */
  readonly autoRevert: boolean
  /** Event-gate cursor: corrections/examples after this are "new signal". */
  readonly lastRunAt: string | null
}

export interface SkillImprovementEntryDto {
  readonly id: string
  readonly candidateVersionId: string
  readonly predecessorVersionId: string | null
  readonly mode: SkillAdoptionModeDto
  readonly outcome: 'adopted' | 'rejected' | 'staged'
  readonly reason: string | null
  readonly createdAt: string
  readonly adoptedAt: string | null
  readonly rolledBackAt: string | null
  readonly driftFlaggedAt: string | null
  readonly driftResolvedAt: string | null
  /** BenchmarkSummary JSON (held-out scores / A-B tallies / regressions / notes). */
  readonly benchmark: JsonObject
  readonly drift: JsonObject | null
}

export interface SkillImprovementDto {
  readonly skillId: string
  readonly settings: SkillImprovementSettingsDto
  /** Ledger, newest first. */
  readonly history: readonly SkillImprovementEntryDto[]
  /** True when a standing adoption exists for rollbackSkill to undo. */
  readonly canRollback: boolean
}

// ── ingestion ─────────────────────────────────────────────────────────────────

export interface IngestDocumentResultDto {
  readonly source: string
  readonly status: 'created' | 'replaced' | 'unchanged'
  readonly chunkCount: number
  readonly tags: readonly { readonly id: string; readonly name: string; readonly created: boolean }[]
  readonly injectionFlagged: boolean
  readonly warnings: readonly string[]
}

export interface IngestCodebaseResultDto {
  readonly root: string
  readonly projectId: string
  readonly projectName: string
  readonly projectCreated: boolean
  readonly status: 'created' | 'updated' | 'unchanged'
  readonly filesWalked: number
  readonly codeFilesParsed: number
  readonly components: { readonly total: number; readonly created: number; readonly deleted: number; readonly unchanged: number }
  readonly dependsOn: { readonly total: number; readonly created: number; readonly deleted: number }
  readonly knowledgeDocuments: number
  readonly knowledgePruned: number
  readonly knowledgeFailed: readonly { readonly file: string; readonly error: string }[]
  readonly skipped: number
}

/** Pushed over IPC_EVENT_INGEST_PROGRESS while ingest.codebase runs. */
export interface IngestProgressEventDto {
  readonly runId: string
  readonly phase: 'walking' | 'parsing' | 'writing' | 'knowledge'
  readonly filesWalked: number
  readonly codeFilesParsed: number
  readonly componentsFound: number
  readonly currentFile?: string
}

// ── settings ──────────────────────────────────────────────────────────────────

export interface OllamaStatusDto {
  readonly state: 'daemon-not-running' | 'models-missing' | 'ready'
  readonly installedModels: readonly string[]
  readonly missingModels: readonly string[]
  readonly installUrl: string
}

/** Renderer-safe mirror of models/provider.ts ReasoningBackend (phase 16). */
export type IpcReasoningBackend = 'local-qwen3' | 'cloud-api' | 'subscription-claude'

/** Renderer-safe mirror of ReasoningSettings (§2.1/§11.4). Role keys are the
 * §2.2 dotted strings; the main-side settings validator owns strictness. */
export interface ReasoningSettingsDto {
  readonly backend: IpcReasoningBackend
  readonly overrides?: Readonly<Record<string, IpcReasoningBackend>>
  readonly models?: Readonly<Record<string, string>>
}

/** Renderer-safe mirror of RunnerSettings (headless runner / subscription). */
export interface RunnerSettingsDto {
  readonly enabled: boolean
  readonly model: string
  readonly stageAll: boolean
  readonly mode: 'completion' | 'agent'
  readonly injectionPolicy: 'downgrade' | 'proceed'
  readonly verifierModel?: string
  readonly binaryPath?: string
}

export interface SettingsDto {
  readonly cloudProvider: IpcCloudProvider
  readonly cloudModels: Partial<Record<IpcCloudProvider, string>>
  readonly smallLlmModel: string | null
  readonly providers: readonly IpcCloudProvider[]
  readonly defaultModels: Readonly<Record<IpcCloudProvider, string>>
  /** Presence only — key material never crosses this boundary (§21 rule 7). */
  readonly apiKeysPresent: Readonly<Record<IpcCloudProvider, boolean>>
  readonly ollama: OllamaStatusDto
  readonly mcp: {
    readonly url: string | null
    /** The `claude mcp add` command with the <token> placeholder. */
    readonly connectCommand: string
    readonly sampleConfigPath: string
  }
  /**
   * Phase-16 sections — present only once the user opts in (absent on a default
   * install). Phase-16b's `settings.get` assembly fills these from
   * ModelSettings.reasoning/runner; today they are undefined and inert.
   */
  readonly reasoning?: ReasoningSettingsDto
  readonly runner?: RunnerSettingsDto
}

export interface ModelSettingsPatchDto {
  readonly cloudProvider?: IpcCloudProvider
  readonly cloudModels?: Partial<Record<IpcCloudProvider, string>>
  readonly smallLlmModel?: string | null
  /**
   * Phase-16 sections. NOTE for phase-16b: `settings.save` (ipc.ts) rebuilds
   * `next` from an explicit field list and silently DROPS unknown keys — merge
   * `reasoning`/`runner` there (and fire router.invalidate()) or a saved patch
   * vanishes on write.
   */
  readonly reasoning?: ReasoningSettingsDto
  readonly runner?: RunnerSettingsDto
}

/** Pushed over IPC_EVENT_OLLAMA_PULL while settings.ollamaPull runs. */
export interface OllamaPullProgressDto {
  readonly model: string
  readonly status: string
  readonly completed?: number
  readonly total?: number
  readonly done: boolean
  readonly error?: string
}

// ── runner (headless subscription reasoner, phase 17) ─────────────────────────

/** Renderer-safe mirror of the runner health-cache state (§9.7). */
export type RunnerHealthStateDto = 'ok' | 'not-installed' | 'auth-expired' | 'quota-exhausted' | 'unknown'

/** One runner_runs row projected for get_runner_status / the dashboard (§3.7). */
export interface RunnerRunSummaryDto {
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

/**
 * get_runner_status / runner.status: the runner health cache + latest run (§4.F).
 * OFF by default — a keyless install reports `enabled:false`, `state:'unknown'`,
 * and never spawns claude.
 */
export interface RunnerStatusDto {
  readonly enabled: boolean
  /** Resolved absolute claude path (P1.9/§10.12); null when unresolved/off. */
  readonly binaryPath: string | null
  readonly version: string | null
  readonly versionOk: boolean
  readonly state: RunnerHealthStateDto
  /** ISO-8601; last time a real run/canary authenticated OK (null = never). */
  readonly lastAuthOkAt: string | null
  /** Last classified failure detail (auth/quota/not-installed) — the banner line. */
  readonly lastError: string | null
  readonly lastRun: RunnerRunSummaryDto | null
  /** Agent-mode tombstoned sessions (§3.6/§10.2); 0 in completion mode. */
  readonly tombstonedSessions: number
}

/** runner.testConnection: the manual 1-turn canary outcome (§3.7 — never scheduled). */
export interface RunnerTestConnectionDto {
  readonly ok: boolean
  readonly message: string
}

// ── triggers & automation (phase 11) ─────────────────────────────────────────

export interface ScheduleStatusDto {
  readonly name: string
  readonly cron: string
  readonly taskKind: string
  readonly nextRunAt: string | null
}

export interface TriggersStatusDto {
  /** false = the trigger runtime did not boot this launch. */
  readonly available: boolean
  readonly queue: {
    readonly counts: Readonly<Record<string, number>>
    readonly runningTaskId: string | null
  }
  readonly schedules: readonly ScheduleStatusDto[]
  readonly watchedFolders: readonly { readonly name: string; readonly path: string }[]
  readonly rules: readonly { readonly id: string; readonly trigger: string }[]
  /** Rule files that failed §17 validation, with the exact reason. */
  readonly ruleErrors: readonly { readonly file: string; readonly error: string }[]
  readonly hook: {
    readonly endpoint: string
    readonly spoolDir: string
    readonly settingsPath: string
    /** null = settings.json unreadable; the installer will say more. */
    readonly installed: boolean | null
  }
}

export interface InstallHookResultDto {
  readonly changed: boolean
  readonly command: string
  readonly settingsPath: string
  readonly backupPath: string | null
  readonly diff: string
}

// ── channel map ───────────────────────────────────────────────────────────────

/**
 * Every invokable channel: request payload → response data (wrapped in
 * IpcResult by the transport). Adding a channel here is the ONLY way to add
 * an IPC surface — preload and main both derive from this map.
 */
export interface IpcChannels {
  'app.status': { req: void; res: AppStatusDto }

  'memory.counts': { req: void; res: readonly LabelCountDto[] }
  'memory.list': {
    req: { label: IpcNodeLabel; limit: number; offset: number }
    res: { rows: readonly MemoryNodeSummaryDto[]; total: number }
  }
  'memory.search': {
    req: { query: string; labels?: readonly string[]; k?: number }
    res: readonly MemorySearchHitDto[]
  }
  'memory.node': { req: { label: IpcNodeLabel; id: string }; res: MemoryNodeDetailDto }

  'review.staged.list': { req: { status?: StagedWriteStatusDto }; res: readonly StagedWriteDto[] }
  'review.staged.diff': { req: { id: string }; res: string }
  'review.staged.approve': { req: { id: string }; res: { id: string; auditActionId: string } }
  'review.staged.reject': { req: { id: string; reason?: string }; res: null }
  'review.approvals.list': {
    req: { status?: 'pending' | 'approved' | 'denied' }
    res: readonly ApprovalDto[]
  }
  'review.approvals.decide': { req: { id: string; decision: 'approved' | 'denied' }; res: null }
  'review.flags.list': { req: void; res: readonly InjectionFlagDto[] }

  'audit.list': { req: { kind?: AuditKindDto; agentId?: string }; res: readonly AuditActionDto[] }
  'audit.undo': { req: { id: string }; res: { undoActionId: string } }

  'spend.summary': { req: void; res: SpendSummaryDto }

  'tasks.list': { req: void; res: readonly TaskDto[] }
  'watch.list': { req: void; res: readonly WatchedFolderDto[] }
  'watch.add': {
    req: { name: string; path: string; tags: readonly string[]; extensions?: readonly string[] }
    res: WatchedFolderDto
  }
  'watch.remove': { req: { name: string }; res: { removed: boolean } }
  'watch.scan': { req: { name: string }; res: WatchScanResultDto }

  'traces.recent': { req: { limit?: number }; res: readonly TraceSummaryDto[] }
  'traces.spans': { req: { traceId: string }; res: readonly TraceSpanDto[] }

  'skills.list': { req: void; res: readonly SkillSummaryDto[] }
  'skills.detail': { req: { id: string }; res: SkillDetailDto }
  'skills.improvement': { req: { skillId: string }; res: SkillImprovementDto }
  'skills.improvementSettings': {
    req: { skillId: string; mode: SkillAdoptionModeDto; autoRevert: boolean }
    res: SkillImprovementDto
  }
  'skills.improveNow': { req: { skillId: string }; res: { taskId: string; deduped: boolean } }
  'skills.rollback': { req: { skillId: string }; res: SkillImprovementDto }
  /** Open (unresolved, un-reverted) drift flags — the rail badge's source. */
  'skills.driftSummary': { req: void; res: { flagged: number } }

  'ingest.pick': { req: { kind: 'file' | 'folder' }; res: { path: string | null } }
  'ingest.document': {
    req: { path: string; tags?: readonly string[] }
    res: IngestDocumentResultDto
  }
  'ingest.codebase': {
    req: { root: string; project?: string; runId: string }
    res: IngestCodebaseResultDto
  }

  'triggers.status': { req: void; res: TriggersStatusDto }
  'triggers.installHook': { req: void; res: InstallHookResultDto }

  'settings.get': { req: void; res: SettingsDto }
  'settings.save': { req: ModelSettingsPatchDto; res: SettingsDto }
  'settings.setApiKey': { req: { provider: IpcCloudProvider; key: string }; res: null }
  'settings.clearApiKey': { req: { provider: IpcCloudProvider }; res: null }
  'settings.revealMcpToken': { req: void; res: { token: string } }
  'settings.ollamaStatus': { req: void; res: OllamaStatusDto }
  'settings.ollamaPull': { req: { model: string; runId: string }; res: null }

  /** Phase-17 headless subscription runner. Enable/model are saved via settings.save. */
  'runner.status': { req: void; res: RunnerStatusDto }
  /** Manual 1-turn canary — user-triggered only, NEVER scheduled (§3.7). */
  'runner.testConnection': { req: void; res: RunnerTestConnectionDto }
}

export type IpcChannel = keyof IpcChannels
export type IpcRequest<C extends IpcChannel> = IpcChannels[C]['req']
export type IpcResponse<C extends IpcChannel> = IpcChannels[C]['res']

/** Fire-and-forget events pushed main → renderer (webContents.send). */
export const IPC_EVENT_INGEST_PROGRESS = 'event.ingest.progress'
export const IPC_EVENT_OLLAMA_PULL = 'event.ollama.pull'

/** Prefix every invokable channel rides under (namespacing + preload filter). */
export const IPC_INVOKE_PREFIX = 'agentic-os:'

/** Stable error codes the renderer may branch on (message is for display). */
export type IpcErrorCode =
  | 'UNAVAILABLE' // subsystem not booted this launch
  | 'INVALID_INPUT'
  | 'NOT_FOUND'
  | 'INVALID_STATE'
  | 'INVALID_PAYLOAD'
  | 'COMMIT_FAILED'
  | 'IRREVERSIBLE'
  | 'ALREADY_UNDONE'
  | 'UNDO_FAILED'
  | 'OLLAMA_ERROR'
  | 'INTERNAL'
