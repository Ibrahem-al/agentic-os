/**
 * Dashboard IPC (phase 10) — the main-process side of the typed contract in
 * src/shared/ipc.ts (§21 rule 8: the renderer has no Node access; every
 * privileged read/write crosses here). One registration per channel, every
 * response wrapped in an IpcResult envelope so backend errors reach the
 * operator with their stable code + verbatim message (PRODUCT.md: truth over
 * polish — errors are written for operators, don't paraphrase them).
 *
 * Handlers are thin adapters over the phase 01–09 modules: staged writes,
 * approvals, audit/undo, injection flags, hybrid search, traces, spend,
 * tasks, watched folders, skills, ingestion and settings. No business logic
 * lives here — if a rule matters, it is enforced in the owning module and
 * this layer only relays it.
 */
import { app, BrowserWindow, dialog, ipcMain, type IpcMainInvokeEvent } from 'electron'
import { join } from 'node:path'
import type BetterSqlite3 from 'better-sqlite3'
import type {
  ApprovalDto,
  AppStatusDto,
  AuditActionDto,
  IngestCodebaseResultDto,
  IngestDocumentResultDto,
  IpcChannel,
  IpcErrorCode,
  IpcNodeLabel,
  IpcRequest,
  IpcResponse,
  IpcResult,
  JsonObject,
  JsonValue,
  OllamaPullProgressDto,
  ReasoningSettingsDto,
  RunnerSettingsDto,
  SettingsDto,
  SkillImprovementDto,
  SkillImprovementEntryDto,
  SkillSummaryDto,
  StagedWriteDto,
  WatchedFolderDto
} from '../shared/ipc'
import { IPC_EVENT_INGEST_PROGRESS, IPC_EVENT_OLLAMA_PULL, IPC_INVOKE_PREFIX } from '../shared/ipc'
import { CLOUD_PROVIDERS, WATCHED_FOLDERS_CONFIG_FILENAME, type CloudProvider } from './config'
import { type StorageEngine } from './storage'
import {
  Keychain,
  OllamaClient,
  OllamaError,
  Reranker,
  apiKeySecretName,
  defaultReasoningSettings,
  defaultRunnerSettings,
  loadModelSettings,
  saveModelSettings,
  settingsPath,
  type ModelSettings
} from './models'
import { searchMemory } from './retrieval'
import {
  AuditLog,
  PermissionEngine,
  StagedWriteError,
  UndoError,
  approveStagedWrite,
  getStagedWrite,
  listStagedWrites,
  rejectStagedWriteWithEffects,
  renderStagedWriteDiff,
  type InjectionScanner
} from './security'
import {
  SkillImprovementError,
  enqueueManualImprovement,
  getSkillSettings,
  latestStandingAdoption,
  listImprovements,
  rollbackSkillAdoption,
  setSkillSettings
} from './agents'
import {
  IngestError,
  WatchedFolderStore,
  ingestCodebase,
  ingestKnowledgeFile,
  scanWatchedFolder,
  type IngestDocumentResult,
  type KnowledgeIngestDeps
} from './ingest'
import { claudeMcpAddCommand } from './mcp'
import {
  HookInstallError,
  installSessionEndHook,
  type DurableTaskQueue,
  type RuleLoadError,
  type TriggerSchedules,
  type TriggerWatchers
} from './triggers'
import {
  getNode,
  getRunnerStatus,
  getSettingsSummary,
  getSkillDetail,
  getSpendSummary,
  getTrace,
  getTriggersStatus,
  listInjectionFlags,
  listNodes,
  listTasks,
  listTraces,
  memoryCounts
} from './reads'
import type { Runner, TestConnectionResult } from './runner'

/** The phase-11 trigger runtime the status/installer channels read. */
export interface IpcTriggerDeps {
  readonly queue: DurableTaskQueue
  readonly schedules: TriggerSchedules
  readonly watchers: TriggerWatchers
  readonly ruleErrors: readonly RuleLoadError[]
}

/** Everything the dashboard reads/writes. Null = subsystem didn't boot. */
export interface IpcDeps {
  readonly engine: StorageEngine | null
  readonly db: BetterSqlite3.Database | null
  readonly permissions: PermissionEngine | null
  readonly audit: AuditLog | null
  readonly scanner: InjectionScanner | null
  readonly ollama: OllamaClient | null
  readonly reranker: Reranker | null
  readonly keychain: Keychain | null
  readonly mcpUrl: string | null
  readonly triggers: IpcTriggerDeps | null
  readonly userDataDir: string
  readonly subsystems: AppStatusDto['subsystems']
  /**
   * Phase-16b (P1.1): fired by the settings mutators (save / setApiKey /
   * clearApiKey) AFTER a successful mutation so boot can drop the ProviderRouter's
   * cached snapshot (router.invalidate()); a provider/key/role change then takes
   * effect on the NEXT reasoning call with no app restart. Optional — unset in
   * every test rig and any launch without a router (the mutation still persists,
   * only the live re-route is skipped).
   */
  readonly onSettingsChanged?: () => void
  /**
   * Phase-17 subscription runner — backs `runner.status` (health snapshot +
   * latest runner_runs row) and `runner.testConnection` (the manual 1-turn
   * canary, §3.7). Optional: null/absent when the runner did not boot (storage
   * down) or in test rigs; `runner.status` then reports the disabled/unknown
   * shape and `runner.testConnection` surfaces UNAVAILABLE.
   */
  readonly runner?: Pick<Runner, 'healthSnapshot' | 'testConnection'> | null
}

/** The name decisions are recorded under (§13 decided_by / decidedBy). */
const DASHBOARD_USER = 'user:dashboard'

class UnavailableError extends Error {
  constructor(what: string) {
    super(`${what} is unavailable this launch — check the boot log ([storage]/[models]/[kernel] lines)`)
    this.name = 'UnavailableError'
  }
}

const errorCode = (err: unknown): IpcErrorCode => {
  if (err instanceof UnavailableError) return 'UNAVAILABLE'
  if (err instanceof StagedWriteError) return err.code
  if (err instanceof UndoError) return err.code
  if (err instanceof IngestError) return err.code
  if (err instanceof SkillImprovementError) return err.code
  if (err instanceof OllamaError) return 'OLLAMA_ERROR'
  if (err instanceof HookInstallError) return 'INVALID_STATE'
  return 'INTERNAL'
}

/** Date → ISO recursively; drops functions/undefined; keeps JSON shape. */
const jsonify = (value: unknown): JsonValue => {
  if (value === null || value === undefined) return null
  if (value instanceof Date) return value.toISOString()
  if (typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number') return Number.isFinite(value) ? value : String(value)
  if (typeof value === 'bigint') return Number(value)
  if (Array.isArray(value)) return value.map(jsonify)
  if (typeof value === 'object') {
    const out: JsonObject = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (v !== undefined && typeof v !== 'function') out[k] = jsonify(v)
    }
    return out
  }
  return String(value)
}
const jsonObject = (value: unknown): JsonObject => {
  const result = jsonify(value)
  return typeof result === 'object' && result !== null && !Array.isArray(result) ? result : {}
}

/** Compose the runner test-connection canary result into one operator line (§3.7). */
const testConnectionMessage = (r: TestConnectionResult): string => {
  if (r.ok) {
    const version = r.version !== null ? ` (claude ${r.version})` : ''
    const sample = r.sample !== undefined && r.sample !== '' ? ` — replied: ${r.sample}` : ''
    return `Connected${version}${sample}`
  }
  const detail = r.error ?? `runner ${r.state}`
  // The one actionable line for the common expired-login case (§3.7 banner copy).
  return r.state === 'auth-expired' ? `${detail} — run \`claude /login\` in any terminal, then Retry` : detail
}

// ── registration ──────────────────────────────────────────────────────────────

export function registerIpcHandlers(deps: IpcDeps): void {
  const need = {
    engine: (): StorageEngine => deps.engine ?? raiseUnavailable('graph storage'),
    db: (): BetterSqlite3.Database => deps.db ?? raiseUnavailable('appdata.db'),
    permissions: (): PermissionEngine => deps.permissions ?? raiseUnavailable('the permission engine'),
    audit: (): AuditLog => deps.audit ?? raiseUnavailable('the audit log'),
    ollama: (): OllamaClient => deps.ollama ?? raiseUnavailable('the model layer'),
    reranker: (): Reranker => deps.reranker ?? raiseUnavailable('the reranker'),
    keychain: (): Keychain => deps.keychain ?? raiseUnavailable('the keychain')
  }
  function raiseUnavailable(what: string): never {
    throw new UnavailableError(what)
  }

  const knowledgeDeps = (): KnowledgeIngestDeps => ({
    engine: need.engine(),
    embedder: need.ollama(),
    ...(deps.scanner !== null ? { scanner: deps.scanner } : {}),
    ...(deps.audit !== null ? { audit: { log: deps.audit, agentId: DASHBOARD_USER } } : {})
  })

  const register = <C extends IpcChannel>(
    channel: C,
    fn: (req: IpcRequest<C>, event: IpcMainInvokeEvent) => Promise<IpcResponse<C>> | IpcResponse<C>
  ): void => {
    ipcMain.handle(`${IPC_INVOKE_PREFIX}${channel}`, async (event, req): Promise<IpcResult<IpcResponse<C>>> => {
      try {
        return { ok: true, data: await fn(req as IpcRequest<C>, event) }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        return { ok: false, code: errorCode(err), message }
      }
    })
  }

  // ── app ────────────────────────────────────────────────────────────────────

  register('app.status', () => ({
    version: app.getVersion(),
    platform: process.platform,
    userDataDir: deps.userDataDir,
    subsystems: deps.subsystems,
    mcpUrl: deps.mcpUrl
  }))

  // ── memory browser ─────────────────────────────────────────────────────────

  register('memory.counts', () => memoryCounts(need.engine()))

  register('memory.list', ({ label, limit, offset }) => listNodes(need.engine(), { label, limit, offset }))

  register('memory.search', async ({ query, labels, k }) => {
    const hits = await searchMemory(
      { engine: need.engine(), embedder: need.ollama(), reranker: need.reranker() },
      query,
      {
        ...(labels !== undefined && labels.length > 0 ? { labels } : {}),
        ...(k !== undefined ? { k } : {})
      }
    )
    return hits.map((hit) => ({
      label: hit.label as IpcNodeLabel,
      id: hit.id,
      text: hit.text,
      rerankScore: hit.rerankScore,
      fusedScore: hit.fusedScore,
      signals: hit.signals
    }))
  })

  register('memory.node', ({ label, id }) => getNode(need.engine(), { label, id }))

  // ── review queue ───────────────────────────────────────────────────────────

  register('review.staged.list', ({ status }) => {
    const rows = listStagedWrites(need.db(), status !== undefined ? { status } : undefined)
    return rows.map(
      (row): StagedWriteDto => ({
        id: row.id,
        proposedBy: row.proposedBy,
        kind: row.kind,
        targetLabel: row.targetLabel,
        targetId: row.targetId,
        payload: jsonObject(row.payload),
        status: row.status,
        validation: row.validation === null ? null : jsonObject(row.validation),
        createdAt: row.createdAt,
        decidedAt: row.decidedAt,
        committedAt: row.committedAt
      })
    )
  })

  register('review.staged.diff', async ({ id }) => {
    const db = need.db()
    if (getStagedWrite(db, id) === undefined) throw new StagedWriteError('NOT_FOUND', `staged write ${id} does not exist`)
    return renderStagedWriteDiff({ db, engine: need.engine() }, id)
  })

  register('review.staged.approve', async ({ id }) => {
    const result = await approveStagedWrite(
      {
        db: need.db(),
        engine: need.engine(),
        audit: need.audit(),
        embedder: need.ollama()
      },
      id,
      { decidedBy: DASHBOARD_USER }
    )
    return { id: result.id, auditActionId: result.auditActionId }
  })

  register('review.staged.reject', async ({ id, reason }) => {
    // Kind-aware: skill-improvement rejections also retire the recorded
    // candidate (audited); other kinds stay row-only (§13, phase 09).
    await rejectStagedWriteWithEffects(
      {
        db: need.db(),
        engine: need.engine(),
        audit: need.audit(),
        embedder: need.ollama()
      },
      id,
      { decidedBy: DASHBOARD_USER, ...(reason !== undefined ? { reason } : {}) }
    )
    return null
  })

  register('review.approvals.list', ({ status }) => {
    const rows = need.permissions().listApprovals(status !== undefined ? { status } : undefined)
    return rows.map(
      (row): ApprovalDto => ({
        id: row.id,
        agentId: row.agentId,
        actionKind: row.actionKind,
        actionName: row.actionName,
        tier: row.tier,
        details: jsonObject(row.details),
        status: row.status,
        requestedAt: row.requestedAt,
        decidedAt: row.decidedAt,
        decidedBy: row.decidedBy
      })
    )
  })

  register('review.approvals.decide', ({ id, decision }) => {
    const permissions = need.permissions()
    if (decision === 'approved') permissions.approve(id, DASHBOARD_USER)
    else permissions.deny(id, DASHBOARD_USER)
    // Phase 11: tasks parked behind this approval retry (or fail) immediately.
    deps.triggers?.queue.onApprovalDecided(id, decision)
    return null
  })

  register('review.flags.list', () => listInjectionFlags(need.db()))

  // ── audit / undo ───────────────────────────────────────────────────────────

  register('audit.list', ({ kind, agentId }) => {
    const rows = need.audit().listActions({
      ...(kind !== undefined ? { kind } : {}),
      ...(agentId !== undefined ? { agentId } : {})
    })
    // Newest first for the timeline (listActions returns oldest-first).
    return rows
      .slice()
      .reverse()
      .map(
        (row): AuditActionDto => ({
          id: row.id,
          agentId: row.agentId,
          kind: row.kind,
          description: row.description,
          reversible: row.reversible,
          outcome: row.outcome,
          error: row.error,
          details: jsonObject(row.details),
          undoneAt: row.undoneAt,
          undoActionId: row.undoActionId,
          createdAt: row.createdAt
        })
      )
  })

  register('audit.undo', async ({ id }) => {
    const audit = need.audit()
    await audit.undo(id, DASHBOARD_USER)
    // undo() records the undo as its own audited action and links it back.
    const undone = audit.getAction(id)
    return { undoActionId: undone?.undoActionId ?? '' }
  })

  // ── spend ──────────────────────────────────────────────────────────────────

  register('spend.summary', () => getSpendSummary(need.db()))

  // ── tasks & watched folders ────────────────────────────────────────────────

  register('tasks.list', () => listTasks(need.db()))

  const watchStore = new WatchedFolderStore({
    configPath: join(deps.userDataDir, WATCHED_FOLDERS_CONFIG_FILENAME)
  })
  const folderDto = (folder: {
    name: string
    path: string
    tags: string[]
    extensions?: string[]
    enabled: boolean
  }): WatchedFolderDto => ({
    name: folder.name,
    path: folder.path,
    tags: folder.tags,
    ...(folder.extensions !== undefined ? { extensions: folder.extensions } : {}),
    enabled: folder.enabled
  })

  register('watch.list', () => watchStore.list().map(folderDto))

  register('watch.add', ({ name, path, tags, extensions }) => {
    const added = watchStore.add({
      name,
      path,
      tags: [...tags],
      ...(extensions !== undefined ? { extensions: [...extensions] } : {})
    })
    return folderDto(added)
  })

  register('watch.remove', ({ name }) => ({ removed: watchStore.remove(name) }))

  register('watch.scan', async ({ name }) => {
    const folder = watchStore.list().find((f) => f.name === name)
    if (folder === undefined) throw new IngestError('NOT_FOUND', `watched folder '${name}' does not exist`)
    const result = await scanWatchedFolder(knowledgeDeps(), folder)
    return {
      folder: result.folder,
      path: result.path,
      scannedFiles: result.scannedFiles,
      ingested: result.ingested.map((r) => ({ file: r.file, status: r.status, chunkCount: r.chunkCount })),
      skipped: result.skipped.map((r) => ({ file: r.file, reason: r.reason })),
      failed: result.failed.map((r) => ({ file: r.file, error: r.error }))
    }
  })

  // ── triggers & automation (phase 11) ───────────────────────────────────────

  register('triggers.status', () => getTriggersStatus({ triggers: deps.triggers }))

  register('triggers.installHook', () => {
    const keychain = need.keychain()
    const token = keychain.ensureSessionEndHookToken()
    const result = installSessionEndHook({
      token,
      // Packaged builds ship the hook scripts as extraResources — an external
      // shell must execute them, so they cannot live inside asar (phase 13).
      scriptsDir: app.isPackaged
        ? join(process.resourcesPath, 'hooks')
        : join(app.getAppPath(), 'scripts', 'hooks')
    })
    // §21 rule 7 discipline: the token lives in settings.json (the recorded
    // phase-11 placement) but never renders in the dashboard.
    const redact = (text: string): string => text.replaceAll(token, '<hook-token>')
    return {
      changed: result.changed,
      command: redact(result.command),
      settingsPath: result.settingsPath,
      backupPath: result.backupPath,
      diff: redact(result.diff)
    }
  })

  // ── traces ─────────────────────────────────────────────────────────────────

  register('traces.recent', ({ limit }) => listTraces(need.db(), { limit }))

  register('traces.spans', ({ traceId }) => getTrace(need.db(), { traceId }))

  // ── skills ─────────────────────────────────────────────────────────────────

  register('skills.list', async () => {
    const engine = need.engine()
    const skills = await engine.cypher(
      'MATCH (s:Skill) RETURN s.id AS id, s.name AS name, s.current_version AS current_version ORDER BY s.name'
    )
    const countMap = async (query: string): Promise<Map<string, number>> => {
      const rows = await engine.cypher(query)
      return new Map(rows.map((row) => [String(row['id']), Number(row['c'] ?? 0)]))
    }
    const versions = await countMap('MATCH (s:Skill)-[:HAS_VERSION]->(v:SkillVersion) RETURN s.id AS id, count(v) AS c')
    const examples = await countMap('MATCH (s:Skill)-[:HAS_EXAMPLE]->(e:Example) RETURN s.id AS id, count(e) AS c')
    const failures = await countMap(
      `MATCH (s:Skill)-[:HAS_EXAMPLE]->(e:Example) WHERE e.kind = 'failure' RETURN s.id AS id, count(e) AS c`
    )
    const corrections = await countMap('MATCH (c:Correction)-[:IMPROVED]->(s:Skill) RETURN s.id AS id, count(c) AS c')
    const uses = await countMap('MATCH (sess:Session)-[:USED]->(s:Skill) RETURN s.id AS id, count(sess) AS c')
    const activeScores = await engine.cypher(
      `MATCH (s:Skill)-[:HAS_VERSION]->(v:SkillVersion) WHERE v.status = 'active'
       RETURN s.id AS id, max(v.benchmark_score) AS score`
    )
    const scoreMap = new Map(activeScores.map((row) => [String(row['id']), row['score']]))
    return skills.map((row): SkillSummaryDto => {
      const id = String(row['id'])
      const score = scoreMap.get(id)
      return {
        id,
        name: String(row['name'] ?? id),
        currentVersion: row['current_version'] == null ? null : String(row['current_version']),
        versionCount: versions.get(id) ?? 0,
        exampleCount: examples.get(id) ?? 0,
        failureExampleCount: failures.get(id) ?? 0,
        correctionCount: corrections.get(id) ?? 0,
        sessionUseCount: uses.get(id) ?? 0,
        activeBenchmarkScore: typeof score === 'number' ? score : null
      }
    })
  })

  register('skills.detail', ({ id }) => getSkillDetail(need.engine(), { id }))

  // ── skill improvement (§17 agent #4, phase 12) ─────────────────────────────

  const improvementDto = (skillId: string): SkillImprovementDto => {
    const db = need.db()
    const settings = getSkillSettings(db, skillId)
    const history = listImprovements(db, skillId).map(
      (row): SkillImprovementEntryDto => ({
        id: row.id,
        candidateVersionId: row.candidateVersionId,
        predecessorVersionId: row.predecessorVersionId,
        mode: row.mode,
        outcome: row.outcome,
        reason: row.reason,
        createdAt: row.createdAt,
        adoptedAt: row.adoptedAt,
        rolledBackAt: row.rolledBackAt,
        driftFlaggedAt: row.driftFlaggedAt,
        driftResolvedAt: row.driftResolvedAt,
        benchmark: jsonObject(row.benchmark),
        drift: row.drift === null ? null : jsonObject(row.drift)
      })
    )
    return {
      skillId,
      settings: { mode: settings.mode, autoRevert: settings.autoRevert, lastRunAt: settings.lastRunAt },
      history,
      canRollback: latestStandingAdoption(db, skillId) !== undefined
    }
  }

  register('skills.improvement', ({ skillId }) => improvementDto(skillId))

  // Rail-level drift visibility (phase-13 polish): open flags = drift detected
  // by the §20 nightly watch, not yet cleared, reverted, or rolled back.
  register('skills.driftSummary', () => {
    const row = need
      .db()
      .prepare(
        `SELECT count(*) AS flagged FROM skill_improvements
         WHERE drift_flagged_at IS NOT NULL AND drift_resolved_at IS NULL AND rolled_back_at IS NULL`
      )
      .get() as { flagged: number }
    return { flagged: row.flagged }
  })

  register('skills.improvementSettings', ({ skillId, mode, autoRevert }) => {
    setSkillSettings(need.db(), skillId, { mode, autoRevert })
    return improvementDto(skillId)
  })

  register('skills.improveNow', ({ skillId }) => {
    const queue = deps.triggers?.queue ?? raiseUnavailable('the trigger queue')
    const result = enqueueManualImprovement(queue, skillId)
    return { taskId: result.taskId, deduped: result.deduped }
  })

  register('skills.rollback', async ({ skillId }) => {
    await rollbackSkillAdoption(
      { engine: need.engine(), db: need.db(), audit: need.audit(), embedder: need.ollama() },
      { skillId, decidedBy: DASHBOARD_USER }
    )
    return improvementDto(skillId)
  })

  // ── ingestion ──────────────────────────────────────────────────────────────

  register('ingest.pick', async ({ kind }, event) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    const options = {
      properties: [kind === 'file' ? ('openFile' as const) : ('openDirectory' as const)]
    }
    const result = win !== null ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options)
    return { path: result.canceled ? null : (result.filePaths[0] ?? null) }
  })

  register('ingest.document', async ({ path, tags }) => {
    const result = await ingestKnowledgeFile(knowledgeDeps(), path, {
      ...(tags !== undefined && tags.length > 0 ? { tags } : {})
    })
    return documentResultDto(result)
  })

  register('ingest.codebase', async ({ root, project, runId }, event) => {
    const sender = event.sender
    const result = await ingestCodebase(
      {
        engine: need.engine(),
        embedder: need.ollama(),
        llm: need.ollama(),
        ...(deps.scanner !== null ? { scanner: deps.scanner } : {}),
        ...(deps.audit !== null ? { audit: { log: deps.audit, agentId: DASHBOARD_USER } } : {})
      },
      root,
      {
        ...(project !== undefined && project !== '' ? { project } : {}),
        onProgress: (progress) => {
          if (sender.isDestroyed()) return
          sender.send(IPC_EVENT_INGEST_PROGRESS, {
            runId,
            phase: progress.phase,
            filesWalked: progress.filesWalked,
            codeFilesParsed: progress.codeFilesParsed,
            componentsFound: progress.componentsFound,
            ...(progress.currentFile !== undefined ? { currentFile: progress.currentFile } : {})
          })
        }
      }
    )
    const dto: IngestCodebaseResultDto = {
      root: result.root,
      projectId: result.projectId,
      projectName: result.projectName,
      projectCreated: result.projectCreated,
      status: result.status,
      filesWalked: result.filesWalked,
      codeFilesParsed: result.codeFilesParsed,
      components: result.components,
      dependsOn: result.dependsOn,
      knowledgeDocuments: result.knowledge.documents.length,
      knowledgePruned: result.knowledge.pruned.length,
      knowledgeFailed: result.knowledge.failed.map((f) => ({ file: f.file, error: f.error })),
      skipped: result.skipped.length
    }
    return dto
  })

  const documentResultDto = (result: IngestDocumentResult): IngestDocumentResultDto => ({
    source: result.source,
    status: result.status,
    chunkCount: result.chunkCount,
    tags: result.tags.map((tag) => ({ id: tag.id, name: tag.name, created: tag.created })),
    injectionFlagged: result.injection?.flagged ?? false,
    warnings: result.injection?.warnings ?? []
  })

  // ── settings ───────────────────────────────────────────────────────────────

  const settingsFile = (): string => settingsPath(deps.userDataDir)

  const settingsDto = async (): Promise<SettingsDto> => {
    // The sanitized model settings (provider + model names + API-key PRESENCE
    // booleans, never key material) are assembled by the shared getSettingsSummary
    // reused by the get_settings_summary MCP tool; the dashboard adds the live
    // Ollama health and the MCP connect block on top (both stay dashboard-only).
    const summary = getSettingsSummary({ userDataDir: deps.userDataDir, keychain: deps.keychain })
    const ollamaStatus =
      deps.ollama !== null
        ? await deps.ollama.status()
        : {
            state: 'daemon-not-running' as const,
            installedModels: [],
            missingModels: [],
            installUrl: 'https://ollama.com/download'
          }
    return {
      cloudProvider: summary.cloudProvider,
      cloudModels: summary.cloudModels,
      smallLlmModel: summary.smallLlmModel,
      providers: summary.providers,
      defaultModels: summary.defaultModels,
      apiKeysPresent: summary.apiKeysPresent,
      ollama: {
        state: ollamaStatus.state,
        installedModels: ollamaStatus.installedModels,
        missingModels: ollamaStatus.missingModels,
        installUrl: ollamaStatus.installUrl
      },
      mcp: {
        url: deps.mcpUrl,
        connectCommand: claudeMcpAddCommand(),
        sampleConfigPath: join(deps.userDataDir, '.mcp.json')
      },
      // Phase-16b: surface the reasoning/runner sections getSettingsSummary
      // (phase-15) already returns — validated JsonObjects derived from
      // ModelSettings.reasoning/runner. Present only once the user opts in;
      // absent and inert on a default install (DEFAULT == TODAY).
      ...(summary.reasoning !== undefined ? { reasoning: summary.reasoning as unknown as ReasoningSettingsDto } : {}),
      ...(summary.runner !== undefined ? { runner: summary.runner as unknown as RunnerSettingsDto } : {})
    }
  }

  register('settings.get', () => settingsDto())

  register('settings.save', async (patch) => {
    const current = loadModelSettings(settingsFile())
    const next: ModelSettings = {
      cloudProvider: patch.cloudProvider ?? current.cloudProvider,
      cloudModels: { ...current.cloudModels, ...(patch.cloudModels ?? {}) }
    }
    const smallLlm = patch.smallLlmModel === undefined ? (current.smallLlmModel ?? null) : patch.smallLlmModel
    if (smallLlm !== null && smallLlm !== '') next.smallLlmModel = smallLlm
    // Phase-16b: `next` is rebuilt from an explicit field list that would DROP
    // the additive reasoning/runner sections. Merge a patch onto whatever is on
    // disk (materializing the phase-doc default the first time a section is
    // touched); when the patch omits a section, PRESERVE the on-disk one — an
    // absent section MUST stay absent (DEFAULT == TODAY), never be resurrected.
    // The loadModelSettings ladder re-validates both on the settingsDto readback.
    if (patch.reasoning !== undefined) {
      next.reasoning = { ...defaultReasoningSettings(), ...current.reasoning, ...patch.reasoning }
    } else if (current.reasoning !== undefined) {
      next.reasoning = current.reasoning
    }
    if (patch.runner !== undefined) {
      next.runner = { ...defaultRunnerSettings(), ...current.runner, ...patch.runner }
    } else if (current.runner !== undefined) {
      next.runner = current.runner
    }
    saveModelSettings(settingsFile(), next)
    deps.onSettingsChanged?.()
    return settingsDto()
  })

  register('settings.setApiKey', ({ provider, key }) => {
    if (!(CLOUD_PROVIDERS as readonly string[]).includes(provider)) {
      throw new IngestError('INVALID_INPUT', `unknown provider '${provider}'`)
    }
    need.keychain().setApiKey(provider as CloudProvider, key)
    // Phase-16b: a key change flips makeCloud() between a tier and null; invalidate
    // so the next reasoning call re-routes without an app restart (P1.1).
    deps.onSettingsChanged?.()
    return null
  })

  register('settings.clearApiKey', ({ provider }) => {
    if (!(CLOUD_PROVIDERS as readonly string[]).includes(provider)) {
      throw new IngestError('INVALID_INPUT', `unknown provider '${provider}'`)
    }
    need.keychain().deleteSecret(apiKeySecretName(provider as CloudProvider))
    deps.onSettingsChanged?.()
    return null
  })

  register('settings.revealMcpToken', () => ({ token: need.keychain().ensureMcpBearerToken() }))

  register('settings.ollamaStatus', async () => {
    const status = await need.ollama().status()
    return {
      state: status.state,
      installedModels: status.installedModels,
      missingModels: status.missingModels,
      installUrl: status.installUrl
    }
  })

  register('settings.ollamaPull', async ({ model, runId }, event) => {
    const sender = event.sender
    const send = (payload: OllamaPullProgressDto): void => {
      if (!sender.isDestroyed()) sender.send(IPC_EVENT_OLLAMA_PULL, payload)
    }
    try {
      await need.ollama().pull(model, (progress) => {
        send({
          model,
          status: progress.status,
          ...(progress.completed !== undefined ? { completed: progress.completed } : {}),
          ...(progress.total !== undefined ? { total: progress.total } : {}),
          done: false
        })
        void runId
      })
      send({ model, status: 'success', done: true })
      return null
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      send({ model, status: 'error', done: true, error: message })
      throw err
    }
  })

  // ── runner (phase 17) ────────────────────────────────────────────────────────

  // Enable/model live in settings.json (saved via settings.save); this is the
  // read-only health + latest-run view for the settings panel + banner. Always
  // answerable — an absent runner reports the disabled/unknown shape (off is the
  // default, not a fault).
  register('runner.status', () => getRunnerStatus({ runner: deps.runner ?? null, db: need.db() }))

  // The manual 1-turn canary — the closest thing to an auth probe (§3.7). Only
  // ever user-triggered from the settings panel, NEVER scheduled.
  register('runner.testConnection', async () => {
    const runner = deps.runner ?? raiseUnavailable('the subscription runner')
    const result = await runner.testConnection()
    return { ok: result.ok, message: testConnectionMessage(result) }
  })
}
