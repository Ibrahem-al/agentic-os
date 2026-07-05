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
  IpcCloudProvider,
  IpcErrorCode,
  IpcNodeLabel,
  IpcRequest,
  IpcResponse,
  IpcResult,
  JsonObject,
  JsonValue,
  LabelCountDto,
  MemoryEdgeDto,
  MemoryNodeDetailDto,
  MemoryNodeSummaryDto,
  OllamaPullProgressDto,
  SettingsDto,
  SkillDetailDto,
  SkillSummaryDto,
  SpendEntryDto,
  SpendSummaryDto,
  StagedWriteDto,
  TaskDto,
  TraceSpanDto,
  TraceSummaryDto,
  WatchedFolderDto
} from '../shared/ipc'
import { IPC_EVENT_INGEST_PROGRESS, IPC_EVENT_OLLAMA_PULL, IPC_INVOKE_PREFIX, IPC_NODE_LABELS } from '../shared/ipc'
import {
  CLOUD_DEFAULT_MODELS,
  CLOUD_PROVIDERS,
  SPEND_CEILING_USD_DEFAULT,
  WATCHED_FOLDERS_CONFIG_FILENAME,
  type CloudProvider
} from './config'
import {
  NODE_TABLES,
  REL_TABLES,
  nodeTable,
  type NodeLabel,
  type StorageEngine
} from './storage'
import {
  Keychain,
  OllamaClient,
  OllamaError,
  Reranker,
  apiKeySecretName,
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
  rejectStagedWrite,
  renderStagedWriteDiff,
  type InjectionScanner
} from './security'
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
  readonly userDataDir: string
  readonly subsystems: AppStatusDto['subsystems']
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
  if (err instanceof OllamaError) return 'OLLAMA_ERROR'
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

// ── memory browser helpers ────────────────────────────────────────────────────

/** The property that names a node in lists (label-specific, schema-backed). */
const DISPLAY_PROPS: Readonly<Record<IpcNodeLabel, readonly string[]>> = {
  Session: ['transcript_ref'],
  Project: ['name'],
  Skill: ['name'],
  SkillVersion: ['status'],
  Example: ['kind', 'content'],
  Correction: ['content'],
  Preference: ['statement'],
  MCP: ['name'],
  Plugin: ['name'],
  Component: ['name'],
  Document: ['source'],
  Knowledge: ['content'],
  Tag: ['name']
}

const truncate = (text: string, max = 140): string =>
  text.length > max ? `${text.slice(0, max - 1)}…` : text

const displayOf = (label: IpcNodeLabel, row: Record<string, unknown>, id: string): string => {
  const parts = DISPLAY_PROPS[label]
    .map((prop) => row[prop])
    .filter((v): v is string => typeof v === 'string' && v !== '')
  return parts.length > 0 ? truncate(parts.join(' · ').replace(/\s+/g, ' ')) : id
}

const assertLabel = (label: string): IpcNodeLabel => {
  if (!(IPC_NODE_LABELS as readonly string[]).includes(label)) {
    throw new IngestError('INVALID_INPUT', `unknown node label '${label}'`)
  }
  return label as IpcNodeLabel
}

/** Node columns worth shipping to the inspector (embedding never crosses). */
const inspectableColumns = (label: NodeLabel): string[] => {
  const spec = nodeTable(label)
  const cols = ['id', ...spec.properties.map((p) => p.name)]
  if (spec.provenance) cols.push('extracted_by', 'confidence')
  cols.push('created_at', 'updated_at')
  return cols
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

  register('memory.counts', async () => {
    const engine = need.engine()
    const counts: LabelCountDto[] = []
    for (const spec of NODE_TABLES) {
      const rows = await engine.cypher(`MATCH (n:${spec.label}) RETURN count(n) AS c`)
      counts.push({ label: spec.label, count: Number(rows[0]?.['c'] ?? 0) })
    }
    return counts
  })

  register('memory.list', async ({ label, limit, offset }) => {
    const engine = need.engine()
    const safeLabel = assertLabel(label)
    const safeLimit = Math.min(Math.max(Math.trunc(limit) || 0, 1), 200)
    const safeOffset = Math.max(Math.trunc(offset) || 0, 0)
    const displayCols = DISPLAY_PROPS[safeLabel]
    const select = ['n.id AS id', 'n.updated_at AS updated_at', ...displayCols.map((p) => `n.${p} AS ${p}`)]
    const rows = await engine.cypher(
      `MATCH (n:${safeLabel}) RETURN ${select.join(', ')} ORDER BY n.updated_at DESC, n.id SKIP ${safeOffset} LIMIT ${safeLimit}`
    )
    const totalRows = await engine.cypher(`MATCH (n:${safeLabel}) RETURN count(n) AS c`)
    const summaries: MemoryNodeSummaryDto[] = rows.map((row) => {
      const id = String(row['id'] ?? '')
      const updated = row['updated_at']
      return {
        label: safeLabel,
        id,
        display: displayOf(safeLabel, row, id),
        updatedAt: updated instanceof Date ? updated.toISOString() : updated == null ? null : String(updated)
      }
    })
    return { rows: summaries, total: Number(totalRows[0]?.['c'] ?? 0) }
  })

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

  register('memory.node', async ({ label, id }) => {
    const engine = need.engine()
    const safeLabel = assertLabel(label)
    const cols = inspectableColumns(safeLabel)
    const propRows = await engine.cypher(
      `MATCH (n:${safeLabel} {id: $id}) RETURN ${cols.map((c) => `n.${c} AS ${c}`).join(', ')} LIMIT 1`,
      { id }
    )
    const propRow = propRows[0]
    if (propRow === undefined) {
      throw new IngestError('NOT_FOUND', `${safeLabel} ${id} does not exist`)
    }

    const edges: { outgoing: MemoryEdgeDto[]; incoming: MemoryEdgeDto[] } = { outgoing: [], incoming: [] }
    const relSelect = 'r.extracted_by AS r_extracted_by, r.confidence AS r_confidence, r.created_at AS r_created_at'
    for (const rel of REL_TABLES) {
      for (const [from, to] of rel.pairs) {
        if (from === safeLabel) {
          const otherCols = DISPLAY_PROPS[to].map((p) => `m.${p} AS ${p}`).join(', ')
          const rows = await engine.cypher(
            `MATCH (n:${safeLabel} {id: $id})-[r:${rel.type}]->(m:${to}) RETURN m.id AS id${otherCols ? `, ${otherCols}` : ''}, ${relSelect} LIMIT 100`,
            { id }
          )
          for (const row of rows) edges.outgoing.push(edgeDto(rel.type, 'out', to, row))
        }
        if (to === safeLabel) {
          const otherCols = DISPLAY_PROPS[from].map((p) => `m.${p} AS ${p}`).join(', ')
          const rows = await engine.cypher(
            `MATCH (m:${from})-[r:${rel.type}]->(n:${safeLabel} {id: $id}) RETURN m.id AS id${otherCols ? `, ${otherCols}` : ''}, ${relSelect} LIMIT 100`,
            { id }
          )
          for (const row of rows) edges.incoming.push(edgeDto(rel.type, 'in', from, row))
        }
      }
    }

    const detail: MemoryNodeDetailDto = {
      label: safeLabel,
      id,
      props: jsonObject(propRow),
      outgoing: edges.outgoing,
      incoming: edges.incoming
    }
    return detail
  })

  const edgeDto = (
    type: string,
    direction: 'out' | 'in',
    label: IpcNodeLabel,
    row: Record<string, unknown>
  ): MemoryEdgeDto => {
    const id = String(row['id'] ?? '')
    const props: JsonObject = {}
    for (const [key, value] of Object.entries(row)) {
      if (key.startsWith('r_') && value !== null && value !== undefined) {
        props[key.slice(2)] = jsonify(value)
      }
    }
    return { type, direction, label, id, display: displayOf(label, row, id), props }
  }

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

  register('review.staged.reject', ({ id, reason }) => {
    rejectStagedWrite(need.db(), id, { decidedBy: DASHBOARD_USER, ...(reason !== undefined ? { reason } : {}) })
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
    return null
  })

  register('review.flags.list', () => {
    const rows = need
      .db()
      .prepare('SELECT id, source, detector, pattern, excerpt, created_at FROM injection_flags ORDER BY created_at DESC, id LIMIT 500')
      .all() as { id: string; source: string; detector: 'regex' | 'llm'; pattern: string; excerpt: string; created_at: string }[]
    return rows.map((row) => ({
      id: row.id,
      source: row.source,
      detector: row.detector,
      pattern: row.pattern,
      excerpt: row.excerpt,
      createdAt: row.created_at
    }))
  })

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

  register('spend.summary', () => {
    const db = need.db()
    const total = db.prepare('SELECT COALESCE(SUM(usd), 0) AS t FROM spend').get() as { t: number }
    const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()
    const last24h = db.prepare('SELECT COALESCE(SUM(usd), 0) AS t FROM spend WHERE created_at >= ?').get(cutoff) as {
      t: number
    }
    const byTask = db
      .prepare(
        `SELECT task_id, SUM(usd) AS usd, COUNT(*) AS calls, MAX(created_at) AS last_at
         FROM spend WHERE task_id IS NOT NULL GROUP BY task_id ORDER BY usd DESC LIMIT 20`
      )
      .all() as { task_id: string; usd: number; calls: number; last_at: string }[]
    const recent = db
      .prepare(
        `SELECT id, task_id, provider, model, input_tokens, output_tokens, usd, created_at
         FROM spend ORDER BY created_at DESC, id DESC LIMIT 50`
      )
      .all() as {
      id: number
      task_id: string | null
      provider: string | null
      model: string | null
      input_tokens: number | null
      output_tokens: number | null
      usd: number
      created_at: string
    }[]
    const summary: SpendSummaryDto = {
      totalUsd: total.t,
      last24hUsd: last24h.t,
      ceilingUsd: SPEND_CEILING_USD_DEFAULT,
      byTask: byTask.map((row) => ({ taskId: row.task_id, usd: row.usd, calls: row.calls, lastAt: row.last_at })),
      recent: recent.map(
        (row): SpendEntryDto => ({
          id: row.id,
          taskId: row.task_id,
          provider: row.provider,
          model: row.model,
          inputTokens: row.input_tokens,
          outputTokens: row.output_tokens,
          usd: row.usd,
          createdAt: row.created_at
        })
      )
    }
    return summary
  })

  // ── tasks & watched folders ────────────────────────────────────────────────

  register('tasks.list', () => {
    const rows = need
      .db()
      .prepare(
        `SELECT id, kind, status, attempts, not_before_unix_ms, last_error, created_at, updated_at
         FROM tasks ORDER BY updated_at DESC LIMIT 200`
      )
      .all() as {
      id: string
      kind: string
      status: TaskDto['status']
      attempts: number
      not_before_unix_ms: number | null
      last_error: string | null
      created_at: string
      updated_at: string
    }[]
    return rows.map(
      (row): TaskDto => ({
        id: row.id,
        kind: row.kind,
        status: row.status,
        attempts: row.attempts,
        notBeforeUnixMs: row.not_before_unix_ms,
        lastError: row.last_error,
        createdAt: row.created_at,
        updatedAt: row.updated_at
      })
    )
  })

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

  // ── traces ─────────────────────────────────────────────────────────────────

  register('traces.recent', ({ limit }) => {
    const db = need.db()
    const safeLimit = Math.min(Math.max(Math.trunc(limit ?? 50) || 50, 1), 200)
    const rows = db
      .prepare(
        `SELECT trace_id,
                MIN(start_unix_ms) AS start_ms,
                MAX(COALESCE(end_unix_ms, start_unix_ms)) AS end_ms,
                COUNT(*) AS span_count,
                SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END) AS error_count
         FROM traces GROUP BY trace_id ORDER BY start_ms DESC LIMIT ?`
      )
      .all(safeLimit) as { trace_id: string; start_ms: number; end_ms: number; span_count: number; error_count: number }[]
    const rootStmt = db.prepare(
      `SELECT name FROM traces WHERE trace_id = ?
       ORDER BY (parent_span_id IS NOT NULL AND parent_span_id != ''), start_unix_ms, id LIMIT 1`
    )
    return rows.map((row): TraceSummaryDto => {
      const root = rootStmt.get(row.trace_id) as { name: string } | undefined
      return {
        traceId: row.trace_id,
        rootName: root?.name ?? '(unknown)',
        startUnixMs: row.start_ms,
        durationMs: row.end_ms > row.start_ms ? row.end_ms - row.start_ms : null,
        spanCount: row.span_count,
        errorCount: row.error_count
      }
    })
  })

  register('traces.spans', ({ traceId }) => {
    const rows = need
      .db()
      .prepare(
        `SELECT span_id, parent_span_id, name, kind, start_unix_ms, end_unix_ms, status, attributes_json
         FROM traces WHERE trace_id = ? ORDER BY start_unix_ms, id`
      )
      .all(traceId) as {
      span_id: string
      parent_span_id: string | null
      name: string
      kind: string | null
      start_unix_ms: number
      end_unix_ms: number | null
      status: string | null
      attributes_json: string | null
    }[]
    return rows.map(
      (row): TraceSpanDto => ({
        spanId: row.span_id,
        parentSpanId: row.parent_span_id === '' ? null : row.parent_span_id,
        name: row.name,
        kind: row.kind,
        startUnixMs: row.start_unix_ms,
        endUnixMs: row.end_unix_ms,
        status: row.status,
        attributes: row.attributes_json === null ? {} : jsonObject(JSON.parse(row.attributes_json))
      })
    )
  })

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

  register('skills.detail', async ({ id }) => {
    const engine = need.engine()
    const skillRows = await engine.cypher(
      `MATCH (s:Skill {id: $id}) RETURN s.id AS id, s.name AS name, s.instructions AS instructions,
       s.current_version AS current_version LIMIT 1`,
      { id }
    )
    const skill = skillRows[0]
    if (skill === undefined) throw new IngestError('NOT_FOUND', `Skill ${id} does not exist`)
    const versionRows = await engine.cypher(
      `MATCH (s:Skill {id: $id})-[:HAS_VERSION]->(v:SkillVersion)
       RETURN v.id AS id, v.status AS status, v.benchmark_score AS score, v.instructions AS instructions,
              v.created_at AS created_at ORDER BY v.created_at DESC LIMIT 20`,
      { id }
    )
    const exampleRows = await engine.cypher(
      `MATCH (s:Skill {id: $id})-[:HAS_EXAMPLE]->(e:Example)
       RETURN e.id AS id, e.kind AS kind, e.content AS content ORDER BY e.created_at DESC LIMIT 20`,
      { id }
    )
    const correctionRows = await engine.cypher(
      `MATCH (c:Correction)-[:IMPROVED]->(s:Skill {id: $id})
       RETURN c.id AS id, c.content AS content ORDER BY c.created_at DESC LIMIT 20`,
      { id }
    )
    const detail: SkillDetailDto = {
      id: String(skill['id']),
      name: String(skill['name'] ?? skill['id']),
      instructions: String(skill['instructions'] ?? ''),
      currentVersion: skill['current_version'] == null ? null : String(skill['current_version']),
      versions: versionRows.map((row) => ({
        id: String(row['id']),
        status: String(row['status'] ?? 'unknown'),
        benchmarkScore: typeof row['score'] === 'number' ? row['score'] : null,
        instructions: String(row['instructions'] ?? ''),
        createdAt: row['created_at'] instanceof Date ? row['created_at'].toISOString() : null
      })),
      examples: exampleRows.map((row) => ({
        id: String(row['id']),
        kind: String(row['kind'] ?? 'unknown'),
        content: String(row['content'] ?? '')
      })),
      corrections: correctionRows.map((row) => ({
        id: String(row['id']),
        content: String(row['content'] ?? '')
      }))
    }
    return detail
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
    const settings = loadModelSettings(settingsFile())
    const keychain = deps.keychain
    const apiKeysPresent = Object.fromEntries(
      CLOUD_PROVIDERS.map((provider) => [provider, keychain?.getApiKey(provider) !== undefined])
    ) as Record<IpcCloudProvider, boolean>
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
      cloudProvider: settings.cloudProvider,
      cloudModels: settings.cloudModels,
      smallLlmModel: settings.smallLlmModel ?? null,
      providers: CLOUD_PROVIDERS,
      defaultModels: CLOUD_DEFAULT_MODELS,
      apiKeysPresent,
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
      }
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
    saveModelSettings(settingsFile(), next)
    return settingsDto()
  })

  register('settings.setApiKey', ({ provider, key }) => {
    if (!(CLOUD_PROVIDERS as readonly string[]).includes(provider)) {
      throw new IngestError('INVALID_INPUT', `unknown provider '${provider}'`)
    }
    need.keychain().setApiKey(provider as CloudProvider, key)
    return null
  })

  register('settings.clearApiKey', ({ provider }) => {
    if (!(CLOUD_PROVIDERS as readonly string[]).includes(provider)) {
      throw new IngestError('INVALID_INPUT', `unknown provider '${provider}'`)
    }
    need.keychain().deleteSecret(apiKeySecretName(provider as CloudProvider))
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
}
