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

/**
 * Renderer-safe mirror of the §18 relationship vocabulary (storage/schema.ts
 * REL_TABLES). This file must stay dependency-free, so — like IPC_NODE_LABELS —
 * it is a hand-kept copy; tests/integration/memory.edit.test.ts pins both
 * constants against the schema so they can never drift. IPC_EDGE_PAIRS drives
 * the memory panel's "Connect to…" picker (only valid (from, to) label pairs
 * are offered) and mirrors the server-side edge validation exactly.
 */
export const IPC_EDGE_TYPES = [
  'PRODUCED',
  'USED',
  'USES',
  'HAS_COMPONENT',
  'DEPENDS_ON',
  'CONNECTS_TO',
  'HAS_VERSION',
  'HAS_EXAMPLE',
  'OBSERVED_IN',
  'IMPROVED',
  'DERIVED_FROM',
  'APPLIES_TO',
  'HAS_CHUNK',
  'EXTRACTED_FROM',
  'TAGGED'
] as const
export type IpcEdgeType = (typeof IPC_EDGE_TYPES)[number]

export const IPC_EDGE_PAIRS: Readonly<Record<IpcEdgeType, readonly (readonly [IpcNodeLabel, IpcNodeLabel])[]>> = {
  PRODUCED: [['Session', 'Project']],
  USED: [
    ['Session', 'Skill'],
    ['Session', 'MCP'],
    ['Session', 'Plugin']
  ],
  USES: [
    ['Project', 'Skill'],
    ['Project', 'MCP'],
    ['Project', 'Plugin']
  ],
  HAS_COMPONENT: [['Project', 'Component']],
  DEPENDS_ON: [['Component', 'Component']],
  CONNECTS_TO: [['Component', 'Component']],
  HAS_VERSION: [['Skill', 'SkillVersion']],
  HAS_EXAMPLE: [['Skill', 'Example']],
  OBSERVED_IN: [['Correction', 'Session']],
  IMPROVED: [['Correction', 'Skill']],
  DERIVED_FROM: [['Preference', 'Correction']],
  APPLIES_TO: [['Preference', 'Tag']],
  HAS_CHUNK: [['Document', 'Knowledge']],
  EXTRACTED_FROM: [
    ['Component', 'Session'],
    ['Preference', 'Session'],
    ['Knowledge', 'Session']
  ],
  TAGGED: [
    ['Project', 'Tag'],
    ['Skill', 'Tag'],
    ['Knowledge', 'Tag']
  ]
}

export const IPC_CLOUD_PROVIDERS = ['anthropic', 'openai', 'gemini', 'openrouter'] as const
export type IpcCloudProvider = (typeof IPC_CLOUD_PROVIDERS)[number]

// ── app ───────────────────────────────────────────────────────────────────────

/**
 * One subsystem's boot outcome + a human-readable reason. `error` = the
 * subsystem did not come up (the detail is why — e.g. a corrupt WAL, a decrypt
 * failure, a port in use); `warn` = up but degraded (e.g. recovered from a
 * corrupt WAL, triggers off); `ok` = healthy. Surfaced in the dashboard so a
 * failed connection shows its cause instead of just a red dot.
 */
export interface BootDiagnosticDto {
  readonly subsystem: string
  readonly level: 'ok' | 'warn' | 'error'
  readonly detail: string
}

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
  /**
   * Per-subsystem boot outcome + reason. Always set in production; optional so
   * test rigs that build an AppStatusDto directly can omit it (consumers treat
   * absent as []).
   */
  readonly diagnostics?: readonly BootDiagnosticDto[]
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

// ── memory editing (feature B: user CRUD — dashboard IPC only, never MCP) ────

/** One edge endpoint in a memory.edge.* request. */
export interface MemoryNodeRefDto {
  readonly label: IpcNodeLabel
  readonly id: string
}

/**
 * memory.node.create / memory.node.update result. Every memory.* mutation
 * returns its audit action id so the UI can offer "Undo" directly (toast
 * action → audit.undo) without a History-panel round trip.
 */
export interface MemoryNodeMutationDto {
  readonly label: IpcNodeLabel
  readonly id: string
  readonly auditActionId: string
}

/** memory.node.delete result: what the structured cascade removed, in plain counts. */
export interface MemoryDeleteResultDto {
  readonly auditActionId: string
  readonly deleted: { readonly nodes: number; readonly edges: number }
}

/** memory.edge.create / memory.edge.delete result. */
export interface MemoryEdgeMutationDto {
  readonly auditActionId: string
}

// ── memory deduplication (dashboard maintenance — scan + audited merge) ──────

/** One member of a duplicate group. */
export interface MemoryDuplicateNodeDto {
  readonly id: string
  /** One-line human handle (truncated render text / Tag name). */
  readonly display: string
  readonly updatedAt: string | null
  /** Incident-edge count — the primary keeper signal. */
  readonly edgeCount: number
}

/**
 * A cluster of duplicate memories the scan found. `reason: 'exact'` is
 * normalized-text/name equality; `'near'` is embedding cosine ≥ the scan
 * threshold (then `similarity` is the group's weakest pairwise cosine). Members
 * are ordered best-keeper-first and `suggestedKeepId` is that keeper (most
 * edges, tie → newest). Merging is a SEPARATE explicit action.
 */
export interface MemoryDuplicateGroupDto {
  readonly label: IpcNodeLabel
  readonly reason: 'exact' | 'near'
  readonly similarity?: number
  readonly nodes: readonly MemoryDuplicateNodeDto[]
  readonly suggestedKeepId: string
}

/** memory.dedupe.scan result — the groups plus a partial-scan flag. */
export interface MemoryDedupeScanResultDto {
  readonly groups: readonly MemoryDuplicateGroupDto[]
  /** True when a label held more nodes than the scan cap (the scan was partial). */
  readonly truncated: boolean
}

/** memory.dedupe.merge result — undoable via `auditActionId`. */
export interface MemoryDedupeMergeResultDto {
  readonly auditActionId: string
  readonly removed: number
  readonly edgesRepointed: number
  readonly edgesDropped: number
}

// ── knowledge graph (visualization) ───────────────────────────────────────────

/**
 * One node in the graph-overview payload. `key` is the graph-wide identity
 * `${label}:${id}` (node ids are unique only within a label table, so the raw
 * id alone is not a safe key); edges reference nodes by this key. `display` is
 * the same one-line human handle the memory browser shows (DISPLAY_PROPS
 * projection); the embedding vector is never included. `degree` is the count of
 * incident edges *within the returned set* — it drives node size.
 */
export interface GraphNodeDto {
  readonly key: string
  readonly label: IpcNodeLabel
  readonly id: string
  readonly display: string
  readonly degree: number
}

/** One directed edge, endpoints referenced by GraphNodeDto.key. */
export interface GraphEdgeDto {
  readonly source: string
  readonly target: string
  readonly type: IpcEdgeType
}

/**
 * graph.overview: the whole §18 graph projected for the visualization — every
 * node (id/label/display/degree) and every edge between the returned nodes.
 * Bounded: when the store holds more than the node cap, the most-recently-updated
 * nodes are kept and `truncated` is true (edges to dropped nodes are omitted).
 * `totalNodes` is the true store-wide node count so the UI can state what it hid.
 */
export interface GraphOverviewDto {
  readonly nodes: readonly GraphNodeDto[]
  readonly edges: readonly GraphEdgeDto[]
  readonly totalNodes: number
  readonly truncated: boolean
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
  /**
   * §9.2 preflight (P1.7): committing this row needs a live embedder — true only
   * for an extraction CREATE that computes an embedding at commit (a new
   * retrievable node). The approve UI reads this to warn, not error, when Ollama
   * is down at click time (esp. under stageAll). False for every other row.
   */
  readonly requiresEmbedder: boolean
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

// ── local-LLM usage (what runs on this computer — local qwen3 reasoning) ──────

/** Windowed totals across the local reasoning ledger. `computeMs` is Ollama's own duration sum. */
export interface LocalUsageTotalsDto {
  readonly calls: number
  readonly promptTokens: number
  readonly evalTokens: number
  readonly computeMs: number
}

/** One §2.2 role's slice of the window (`role` is the plain role key, or 'other' for un-attributed calls). */
export interface LocalUsageRoleDto {
  readonly role: string
  readonly calls: number
  readonly computeMs: number
}

/** One calendar day's slice (`day` is the UTC date `YYYY-MM-DD` of the row's ts). */
export interface LocalUsageDayDto {
  readonly day: string
  readonly calls: number
  readonly computeMs: number
}

/** One recent local reasoning call (newest first). `role` null ⇒ an un-attributed direct call. */
export interface LocalUsageCallDto {
  readonly id: number
  readonly ts: string
  readonly role: string | null
  readonly model: string
  readonly promptTokens: number | null
  readonly evalTokens: number | null
  readonly durationMs: number | null
  readonly ok: boolean
}

/** One currently-loaded model from Ollama's live `/api/ps` snapshot. */
export interface LocalLoadedModelDto {
  readonly name: string
  readonly sizeBytes: number
  readonly sizeVramBytes: number
  /** ISO-8601 idle-unload time, null when the daemon did not report one. */
  readonly expiresAt: string | null
}

/**
 * usage.local.summary / get_local_usage: what the LOCAL qwen3 reasoning tier has
 * done (aggregated over `sinceDays`) plus a live resource snapshot. Search
 * indexing (embeddings) is NOT counted here — that tier always runs locally and
 * is out of this ledger's scope. `loaded`/`ollamaState` come from a live daemon
 * probe (empty + 'daemon-not-running' when the helper is off).
 */
export interface LocalUsageSummaryDto {
  /** The aggregation window actually used (echoes the request; clamped server-side). */
  readonly sinceDays: number
  readonly totals: LocalUsageTotalsDto
  readonly byRole: readonly LocalUsageRoleDto[]
  readonly byDay: readonly LocalUsageDayDto[]
  /** Newest-first, capped (LOCAL_LLM_USAGE_RECENT_LIMIT) — independent of `sinceDays`. */
  readonly recent: readonly LocalUsageCallDto[]
  readonly loaded: readonly LocalLoadedModelDto[]
  /** Live daemon state (the same three-state machine settings.ollamaStatus reports). */
  readonly ollamaState: 'daemon-not-running' | 'models-missing' | 'ready'
}

// ── tasks & watched folders ───────────────────────────────────────────────────

export interface TaskDto {
  readonly id: string
  readonly kind: string
  readonly status: 'pending' | 'running' | 'done' | 'failed' | 'deferred' | 'cancelled'
  readonly attempts: number
  readonly notBeforeUnixMs: number | null
  readonly lastError: string | null
  readonly createdAt: string
  readonly updatedAt: string
}

/** One OS process's live resource use (tasks.processes). */
export interface ProcResourceDto {
  readonly pid: number | null
  /** Percent of one core (may exceed 100 across cores); null when the OS omits it (Windows child CPU). */
  readonly cpuPercent: number | null
  /** Working-set / resident bytes; null when unavailable. */
  readonly memoryBytes: number | null
}

/** The app's own main process — where in-process tasks (extraction, ingest, skills, maintenance) run. */
export interface TaskHostProcessDto extends ProcResourceDto {
  readonly name: string
}

/** A child process a task spawned (today: a runner `claude` child). */
export interface TaskChildProcessDto extends ProcResourceDto {
  /** e.g. 'runner:agent' / 'runner:completion'. */
  readonly role: string
  readonly startedAt: string
  /** Still in flight (an unfinished runner_runs row); a finished child reports last-known stats. */
  readonly live: boolean
}

/**
 * tasks.processes / get_task_processes: what is running for a task and its RAM/CPU.
 * `host` is the app's main process (Electron-measured — cross-platform CPU), where
 * in-process background tasks actually run; `localRuntime` is the SHARED Ollama
 * daemon's loaded models (the local-model work a task drives — memory per model);
 * `children` are the task's own runner child processes. Best-effort telemetry.
 */
export interface TaskProcessesDto {
  /** The task these belong to; null when asked for "the current task" and none is running. */
  readonly taskId: string | null
  /** Is this task the queue's in-flight task right now. */
  readonly running: boolean
  readonly host: TaskHostProcessDto | null
  readonly localRuntime: {
    readonly reachable: boolean
    readonly loadedModels: readonly LocalLoadedModelDto[]
  }
  readonly children: readonly TaskChildProcessDto[]
  /** ISO-8601 sample time. */
  readonly sampledAt: string
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
  /**
   * Stage-3 project skill extraction. `staged`/`revisions` wait in the
   * Approvals queue (nothing is live until a human approves); all zeros when
   * the pass did not run.
   */
  readonly skills: {
    readonly discovered: number
    readonly staged: number
    readonly revisions: number
    readonly skippedExisting: number
    readonly proposalsSkipped: number
  }
  readonly skipped: number
}

/** Pushed over IPC_EVENT_INGEST_PROGRESS while ingest.codebase runs. */
export interface IngestProgressEventDto {
  readonly runId: string
  readonly phase: 'walking' | 'parsing' | 'writing' | 'knowledge' | 'skills'
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
  /**
   * Sensitive-egress consent (Stage 2, extending the §10.7 egress-consent
   * pattern). Absent/false on a default install (DEFAULT == TODAY) — the §11.4
   * HARD-local roles then stay local under EVERY backend setting. Only when the
   * user grants this may a HARD-local (sensitive) role follow a non-local global
   * backend or an explicit per-role override off this computer; the router still
   * clamps local as the final fallback everywhere.
   */
  readonly allowSensitiveNonLocal?: boolean
}

/**
 * A plain, user-facing grouping of the §2.2 reasoning roles for the "What runs
 * where" UI. Derived from the role list — not a spec concept — so the settings
 * panel can present roles in five human categories instead of 14 dotted keys.
 */
export type ReasoningRoleGroupDto =
  | 'Understanding your sessions'
  | 'Improving skills'
  | 'Search & retrieval'
  | 'Safety scanning'
  | 'Summaries'

/**
 * One §2.2 reasoning role projected for the settings "What runs where" table
 * (reasoning.roles). `sensitive` marks the §11.4 HARD-local roles (raw session
 * text / scanned content — kept on this computer unless the user allows
 * otherwise). `effectiveBackend` is the LIVE router.resolve() result — where the
 * role runs right now given settings + key/health; null only when no router
 * booted this launch (a degraded state the renderer reads as the local default).
 */
export interface ReasoningRoleDto {
  readonly role: string
  readonly group: ReasoningRoleGroupDto
  readonly sensitive: boolean
  readonly effectiveBackend: IpcReasoningBackend | null
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
  /** True when the runner is enabled but the subscription tier is unavailable (same isHealthy() the router consults) — reasoning that would ride the subscription is falling back. Always false when disabled (local/cloud is then the CONFIGURED tier). */
  readonly fallbackActive: boolean
  /** Where a subscription-eligible role actually lands while falling back (live router resolution). null when not falling back, or no router wired. */
  readonly effectiveBackend: 'cloud-api' | 'local-qwen3' | null
  readonly lastRun: RunnerRunSummaryDto | null
  /** Agent-mode tombstoned sessions (§3.6/§10.2); 0 in completion mode. */
  readonly tombstonedSessions: number
}

/** runner.testConnection: the manual 1-turn canary outcome (§3.7 — never scheduled). */
export interface RunnerTestConnectionDto {
  readonly ok: boolean
  readonly message: string
}

// ── app updater (Settings "Updates" section) ──────────────────────────────────

/**
 * Auto-updater lifecycle state. 'disabled' covers dev builds (not packaged) and
 * an unavailable updater — the reason rides in `detail`. 'error' carries the
 * operator-readable failure in `error`. The download states carry live progress.
 */
export type UpdaterStateDto =
  | 'disabled'
  | 'idle'
  | 'checking'
  | 'up-to-date'
  | 'downloading'
  | 'downloaded'
  | 'error'

/**
 * A snapshot of the auto-updater (src/main/updater.ts controller). Returned by
 * the `updater.*` channels and pushed over IPC_EVENT_UPDATER_STATUS on every
 * state transition (download-progress ticks throttled to ~4/second).
 */
export interface UpdaterStatusDto {
  readonly state: UpdaterStateDto
  /** The available/downloaded/installed version when known. */
  readonly version?: string
  /** Download progress 0–100. */
  readonly percent?: number
  readonly bytesPerSecond?: number
  readonly transferred?: number
  readonly total?: number
  /** Operator-readable failure message for state 'error'. */
  readonly error?: string
  /** Why the updater is 'disabled' (dev build / unavailable). */
  readonly detail?: string
  /**
   * Set by `updater.install` when the install was DEFERRED because a write was
   * still in flight after the quiesce bound (§21.9 crash-safety). The state stays
   * 'downloaded' (additive — the renderer switch is unchanged); the downloaded
   * update still applies automatically on the next ordinary quit
   * (autoInstallOnAppQuit). Absent on every other path.
   */
  readonly installDeferred?: boolean
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

// ── data & backups (Settings "Data & backups") ───────────────────────────────

/** How a directory under `backups/` was created. */
export type BackupKindDto =
  | 'manual'
  | 'auto'
  | 'pre-reset'
  | 'pre-restore'
  | 'pre-migration'
  | 'corrupt-wal'
  | 'unknown'

/** One row in the backup list. */
export interface BackupEntryDto {
  readonly dirName: string
  readonly kind: BackupKindDto
  /** ISO-8601 parsed from the directory stamp; null when unparseable. */
  readonly createdAt: string | null
  readonly bytes: number
  readonly files: number
  /** Carries a graph copy or an appdata.db → can be restored to. */
  readonly restorable: boolean
}

/** Auto-backup preferences (rule-12 defaults live in config.ts). */
export interface BackupSettingsDto {
  readonly enabled: boolean
  /** One of BACKUP_INTERVAL_HOURS_CHOICES (6 / 12 / 24 / 168). */
  readonly intervalHours: number
  readonly keepLast: number
  /** Optional age cap in days; absent = keep-last only. */
  readonly keepDays?: number
}

export interface BackupListDto {
  readonly backups: readonly BackupEntryDto[]
  readonly settings: BackupSettingsDto
  /** The interval choices the UI offers (6 / 12 / 24 / 168). */
  readonly intervalChoices: readonly number[]
}

// ── channel map ───────────────────────────────────────────────────────────────

/**
 * Every invokable channel: request payload → response data (wrapped in
 * IpcResult by the transport). Adding a channel here is the ONLY way to add
 * an IPC surface — preload and main both derive from this map.
 */
export interface IpcChannels {
  'app.status': { req: void; res: AppStatusDto }
  /**
   * Full-stack reconnect (fix/stack-reconnect): re-run every boot step whose
   * singleton is null (storage → models → kernel → mcp → agents → triggers),
   * re-wire the IPC + MCP-read deps, and return the FRESH AppStatusDto (with
   * diagnostics). No-throw: any step that fails again lands in `diagnostics`.
   * The dashboard offers this behind a "Reconnect" button when any subsystem is
   * non-ok — the common case is a graph lock held by a still-quitting previous
   * instance that has since released.
   */
  'app.reconnect': { req: void; res: AppStatusDto }

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

  /**
   * Memory editing (feature B): dashboard-only graph/KB mutations. IPC is the
   * ONLY surface — never exposed as MCP tools (§21 rule 6: Claude's write path
   * stays propose_correction → staged → validated). Every mutation runs as ONE
   * audited write-lane job (actor user:dashboard) so it is visible and
   * undoable in the History panel; validation + embedding happen BEFORE the
   * lane, so a rejected request (or a down embedder → OLLAMA_ERROR) writes
   * nothing. `props` may not carry protected keys (id / created_at /
   * updated_at / embedding / extracted_by / confidence).
   */
  'memory.node.create': { req: { label: IpcNodeLabel; props: JsonObject }; res: MemoryNodeMutationDto }
  'memory.node.update': { req: { label: IpcNodeLabel; id: string; props: JsonObject }; res: MemoryNodeMutationDto }
  /** Structured cascade: a Document takes its HAS_CHUNK Knowledge chunks with it; a Skill its HAS_VERSION SkillVersions. */
  'memory.node.delete': { req: { label: IpcNodeLabel; id: string }; res: MemoryDeleteResultDto }
  'memory.edge.create': { req: { type: IpcEdgeType; from: MemoryNodeRefDto; to: MemoryNodeRefDto }; res: MemoryEdgeMutationDto }
  'memory.edge.delete': { req: { type: IpcEdgeType; from: MemoryNodeRefDto; to: MemoryNodeRefDto }; res: MemoryEdgeMutationDto }

  /**
   * Memory deduplication (feature B maintenance): a read-only duplicate scan and
   * an audited merge. `scan` finds exact (normalized text/name) + near
   * (embedding cosine ≥ threshold, default DEDUPE_SIMILARITY_DEFAULT) duplicate
   * GROUPS across Project/Skill/Preference/Knowledge/Tag; `merge` collapses one
   * group onto its keeper in ONE audited lane job (undoable in History) — v1
   * merges Preference/Knowledge/Tag only (Skill/Project are scan-report-only).
   */
  'memory.dedupe.scan': { req: { labels?: readonly string[]; threshold?: number }; res: MemoryDedupeScanResultDto }
  'memory.dedupe.merge': {
    req: { label: IpcNodeLabel; keepId: string; removeIds: readonly string[] }
    res: MemoryDedupeMergeResultDto
  }

  /**
   * The whole knowledge graph projected for the Obsidian-style visualization —
   * nodes (id/label/display/degree) + edges between them. Read-only, dashboard
   * only (never an MCP tool). `limit` is clamped server-side to
   * [1, GRAPH_OVERVIEW_MAX_NODES]; when the store is larger the most-recently-
   * updated nodes are kept and the result is flagged `truncated`.
   */
  'graph.overview': { req: { limit?: number }; res: GraphOverviewDto }

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

  /**
   * Local-LLM usage + live resource snapshot (local-LLM visibility). Read-only:
   * aggregates the appdata `local_llm_usage` ledger over `sinceDays` (default
   * LOCAL_LLM_USAGE_SUMMARY_DEFAULT_DAYS) and probes the daemon (ps + status) for
   * `loaded`/`ollamaState`. Always answerable — an off daemon reports [] + not
   * running.
   */
  'usage.local.summary': { req: { sinceDays?: number }; res: LocalUsageSummaryDto }

  'tasks.list': { req: void; res: readonly TaskDto[] }
  /** Force a task to run now (deferred/failed/cancelled/backoff-pending) — §8 "run now". */
  'tasks.runNow': { req: { id: string }; res: { taskId: string; status: 'pending' } }
  /** Cancel a task (running/pending/deferred) — §8 cooperative cancel; kills its child processes. */
  'tasks.cancel': {
    req: { id: string }
    res: { taskId: string; status: 'cancelled'; wasRunning: boolean; killedChildren: number }
  }
  /** What is running for a task + its RAM/CPU (id omitted = the current in-flight task). */
  'tasks.processes': { req: { id?: string }; res: TaskProcessesDto }
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

  /**
   * The §2.2 reasoning roles projected for the settings "What runs where" table
   * (Stage 2). Each row carries a plain group name, whether it is §11.4
   * HARD-local (sensitive), and its LIVE effective backend (router.resolve). Pure
   * read — never mutates. A launch without a router reports `effectiveBackend:
   * null` for every role (DEFAULT == TODAY / local default).
   */
  'reasoning.roles': { req: void; res: readonly ReasoningRoleDto[] }

  /** Phase-17 headless subscription runner. Enable/model are saved via settings.save. */
  'runner.status': { req: void; res: RunnerStatusDto }
  /** Manual 1-turn canary — user-triggered only, NEVER scheduled (§3.7). */
  'runner.testConnection': { req: void; res: RunnerTestConnectionDto }

  /** Current auto-updater snapshot (Settings "Updates" section). */
  'updater.status': { req: void; res: UpdaterStatusDto }
  /** Trigger a manual update check (no-op while already checking/downloading). */
  'updater.check': { req: void; res: UpdaterStatusDto }
  /** Restart-to-install a downloaded update (user-confirmed in the UI first). */
  'updater.install': { req: void; res: UpdaterStatusDto }

  // ── data & backups (Settings "Data & backups") ──────────────────────────────
  /** The backup list (newest first) + current auto-backup settings. */
  'backups.list': { req: void; res: BackupListDto }
  /**
   * Stage a manual backup and relaunch. The graph is OS-locked while the app
   * runs, so the snapshot is taken at the next boot; the renderer shows
   * "restarting…" and main relaunches. `restarting: true` acknowledges the stage.
   */
  'backups.create': { req: void; res: { restarting: true } }
  /** Stage a restore-to-this-point (validated now) and relaunch (same as create). */
  'backups.restore': { req: { dirName: string }; res: { restarting: true } }
  /** Read the auto-backup settings. */
  'backups.settings.get': { req: void; res: BackupSettingsDto }
  /** Write the auto-backup settings (partial patch merged onto current). */
  'backups.settings.set': { req: Partial<BackupSettingsDto>; res: BackupSettingsDto }
  /** Export a portable copy of the data to a user-picked folder; null if cancelled. */
  'data.export': { req: void; res: { path: string | null } }
  /** Stage a reset-to-defaults (keeps every backup) and relaunch. */
  'data.reset': { req: void; res: { restarting: true } }
}

export type IpcChannel = keyof IpcChannels
export type IpcRequest<C extends IpcChannel> = IpcChannels[C]['req']
export type IpcResponse<C extends IpcChannel> = IpcChannels[C]['res']

/** Fire-and-forget events pushed main → renderer (webContents.send). */
export const IPC_EVENT_INGEST_PROGRESS = 'event.ingest.progress'
export const IPC_EVENT_OLLAMA_PULL = 'event.ollama.pull'
/** Auto-updater snapshot pushes (main → renderer) — mirrors the ingest/ollama events. */
export const IPC_EVENT_UPDATER_STATUS = 'event.updater.status'

/** Prefix every invokable channel rides under (namespacing + preload filter). */
export const IPC_INVOKE_PREFIX = 'agentic-os:'

/**
 * Frameless title-bar window-chrome channels. These live OUTSIDE the IpcChannels
 * map (and outside IPC_INVOKE_PREFIX / IpcResult) on purpose: they are OS window
 * commands + chrome state, not typed DTO queries. Adding them to the map would
 * force req/res typing and route them through the main-side handler loop, which
 * expects IpcResult envelopes. They mirror the bespoke event channels above
 * (IPC_EVENT_INGEST_PROGRESS) — one shared source of truth for main + preload.
 */
/** Fire-and-forget window commands (renderer → main via ipcRenderer.send). */
export const IPC_WINDOW_MINIMIZE = 'window.minimize'
export const IPC_WINDOW_TOGGLE_MAXIMIZE = 'window.toggle-maximize'
export const IPC_WINDOW_CLOSE = 'window.close'
/** Seed query for the maximize/restore icon — returns a bare boolean (not IpcResult). */
export const IPC_WINDOW_IS_MAXIMIZED = 'window.is-maximized'
/** Maximize-state push (main → renderer, boolean payload); mirrors event.ingest.progress. */
export const IPC_EVENT_WINDOW_MAXIMIZE = 'event.window.maximize'

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
