/**
 * Watchers runtime (§7 "always-running watchers", phase 11) — cheap LOCAL
 * detection that enqueues durable tasks; nothing expensive runs on a watcher
 * thread, and nothing a watcher ingests or triggers escapes the §13 envelope:
 *
 *  - WATCHED FOLDERS (knowledge ingestion, §7): chokidar on every enabled
 *    folder → a changed/added supported file enqueues an 'ingest-file' task
 *    (the phase-06 pipeline; content-hash dedup keeps re-ingest cheap). One
 *    'watch-scan' task per folder at start() catches files that changed while
 *    the app was closed. Autonomously ingested documents get the
 *    AUTO_INGEST_TRUST_TAG (§13 source trust-tagging, v1 form).
 *  - RULE FILE WATCHES: chokidar on the rule's declared path; detection reads
 *    + hashes the file THROUGH the kernel (`fs-read`, auto-allowed only
 *    within the rule's own fsRead scope) so even detection is §13-checked and
 *    traced. A real content change (hash != baseline) fires the rule.
 *  - RULE URL WATCHES: fetch+hash polling on the rule's interval, routed
 *    through the kernel as a `net` action — for a user rule that tier is
 *    approval-gated, so the FIRST poll queues a §13 approval and polling
 *    stays dark until the dashboard approves (phase-09 decision: user rules
 *    get no standing grants). The first successful poll is the baseline;
 *    only a change fires.
 *  - RULE SCHEDULES: croner per schedule-triggered rule.
 *
 * A fire evaluates the rule's condition against the trigger event and
 * enqueues a 'rule-action' task; the action itself runs in a phase-09
 * sandbox lane via the kernel's sandbox-run gate (see registerRuleHandlers).
 * Baselines persist in userData/trigger-state.json so restarts do not re-fire
 * unchanged targets.
 */
import { createHash } from 'node:crypto'
import { readFileSync, renameSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { basename, dirname, extname } from 'node:path'
import { watch as chokidarWatch, type FSWatcher } from 'chokidar'
import { Cron } from 'croner'
import * as z from 'zod'
import {
  AUTO_INGEST_TRUST_TAG,
  INGEST_MAX_FILE_BYTES,
  TASK_PRIORITY,
  WATCHER_DEBOUNCE_MS,
  WATCHER_URL_CONTENT_MAX_BYTES,
  WATCHER_URL_MIN_INTERVAL_MS
} from '../config'
import type { ActionExecutor, JsonObject } from '../kernel'
import { KernelApprovalPendingError, KernelPermissionError } from '../kernel'
import {
  IngestError,
  INGEST_SUPPORTED_EXTENSIONS,
  ingestKnowledgeFile,
  scanWatchedFolder,
  type KnowledgeIngestDeps,
  type WatchedFolder,
  type WatchedFolderStore
} from '../ingest'
import type { SandboxLane } from '../security'
import { evaluateRuleCondition, ruleAgentId, type LoadedRule } from './rules'
import { TaskFatalError, type DurableTaskQueue } from './queue'

export const RULE_ACTION_TASK_KIND = 'rule-action'
export const INGEST_FILE_TASK_KIND = 'ingest-file'
export const WATCH_SCAN_TASK_KIND = 'watch-scan'

const sha256 = (data: string | Buffer): string => createHash('sha256').update(data).digest('hex')
const shortHash = (text: string): string => sha256(text).slice(0, 12)

// ── Persistent watcher baselines ─────────────────────────────────────────────

const TriggerStateSchema = z.object({
  /** ruleId → last observed sha256 of the watched file's content. */
  fileHashes: z.record(z.string(), z.string()).default({}),
  /** ruleId → last observed sha256 of the polled url's body. */
  urlHashes: z.record(z.string(), z.string()).default({})
})
type TriggerState = z.output<typeof TriggerStateSchema>

class TriggerStateStore {
  private readonly filePath: string
  private state: TriggerState

  constructor(filePath: string) {
    this.filePath = filePath
    this.state = { fileHashes: {}, urlHashes: {} }
    try {
      const parsed = TriggerStateSchema.safeParse(JSON.parse(readFileSync(filePath, 'utf8')))
      if (parsed.success) this.state = parsed.data
    } catch {
      // Missing or corrupt state = empty baselines; watchers rebuild them.
    }
  }

  get(kind: 'fileHashes' | 'urlHashes', ruleId: string): string | undefined {
    return this.state[kind][ruleId]
  }

  set(kind: 'fileHashes' | 'urlHashes', ruleId: string, hash: string): void {
    this.state[kind][ruleId] = hash
    this.persist()
  }

  private persist(): void {
    mkdirSync(dirname(this.filePath), { recursive: true })
    const tmpPath = `${this.filePath}.tmp`
    try {
      writeFileSync(tmpPath, `${JSON.stringify(this.state, null, 2)}\n`, 'utf8')
      renameSync(tmpPath, this.filePath)
    } catch (err) {
      rmSync(tmpPath, { force: true })
      throw err
    }
  }
}

// ── Task handlers (rule actions + watcher-driven ingestion) ──────────────────

export interface RuleHandlerDeps {
  readonly kernel: ActionExecutor
  /** Live view of the loaded rules (rules reload only at boot in v1). */
  readonly rules: () => ReadonlyMap<string, LoadedRule>
  readonly denoLane: SandboxLane
  readonly dockerLane: SandboxLane | null
}

/**
 * The 'rule-action' handler: the queued fire of a user rule. §21 rule 3 —
 * the action executes ONLY inside a sandbox lane, under the rule's own
 * declared capabilities, behind the kernel's sandbox-run gate (side-effecting
 * capability sets are approval-gated for user rules; the queue parks the task
 * on KernelApprovalPendingError and retries once the dashboard decides).
 */
export function registerRuleActionHandler(queue: DurableTaskQueue, deps: RuleHandlerDeps): void {
  queue.registerHandler(RULE_ACTION_TASK_KIND, async (payload, ctx) => {
    const ruleId = typeof payload['ruleId'] === 'string' ? payload['ruleId'] : ''
    const rule = deps.rules().get(ruleId)
    if (rule === undefined) {
      throw new TaskFatalError(`rule '${ruleId}' is no longer loaded — task ${ctx.taskId} cannot run`)
    }
    const lane = rule.action.lane === 'deno' ? deps.denoLane : deps.dockerLane
    if (lane === null) {
      throw new TaskFatalError(
        `rule '${ruleId}' declares lang '${rule.action.lang}' (docker lane), but docker is unavailable — install/start Docker and re-enqueue`
      )
    }
    const event = (payload['event'] ?? {}) as JsonObject
    const result = await deps.kernel.execute(
      ruleAgentId(ruleId),
      {
        kind: 'sandbox-run',
        name: `${ruleId}:${basename(rule.action.entry)}`,
        sandbox: { capabilities: rule.capabilities },
        attributes: { 'rule.id': ruleId, 'rule.lane': lane.name }
      },
      () =>
        lane.run({
          capabilities: rule.capabilities,
          entryFile: rule.action.entry,
          input: {
            rule: { id: ruleId, modelTier: rule.modelTier },
            trigger: event,
            condition: rule.condition?.source ?? null
          }
        })
    )
    if (!result.ok) {
      const stderr = result.error.stderr !== undefined ? ` — stderr tail: ${result.error.stderr.slice(-400)}` : ''
      throw new Error(
        `rule '${ruleId}' action failed in the ${lane.name} lane (${result.error.kind}): ${result.error.message}${stderr}`
      )
    }
    return { note: `rule '${ruleId}' action ran in the ${lane.name} lane (${result.durationMs}ms)` }
  })
}

export interface IngestHandlerDeps {
  readonly knowledge: KnowledgeIngestDeps
  readonly folderStore: WatchedFolderStore
  readonly kernel: ActionExecutor
}

/** Tags applied to autonomously ingested content (§13 trust-tagging v1). */
const autoTags = (tags: readonly string[]): string[] =>
  tags.includes(AUTO_INGEST_TRUST_TAG) ? [...tags] : [...tags, AUTO_INGEST_TRUST_TAG]

/**
 * The watcher-driven ingestion handlers. Both run through the kernel as
 * 'system' storage writes (standing write grant — the §18 knowledge write
 * path with scanner + audited lane job stays the enforcement point).
 */
export function registerIngestHandlers(queue: DurableTaskQueue, deps: IngestHandlerDeps): void {
  queue.registerHandler(INGEST_FILE_TASK_KIND, async (payload, ctx) => {
    const path = typeof payload['path'] === 'string' ? payload['path'] : ''
    if (path === '') throw new TaskFatalError(`ingest-file task ${ctx.taskId} carries no path`)
    const tags = Array.isArray(payload['tags']) ? payload['tags'].filter((t): t is string => typeof t === 'string') : []
    try {
      const result = await deps.kernel.execute(
        'system',
        { kind: 'storage-write', name: 'watched-file-ingest', attributes: { 'ingest.source': path } },
        () => ingestKnowledgeFile(deps.knowledge, path, { tags: autoTags(tags) })
      )
      return { note: `${result.status} — ${result.chunkCount} chunk(s) from ${path}` }
    } catch (err) {
      if (err instanceof IngestError) {
        // The file vanished or is not ingestable — a watcher race, not a
        // retryable failure (the next change event re-enqueues).
        return { note: `skipped ${path}: ${err.message}` }
      }
      throw err
    }
  })

  queue.registerHandler(WATCH_SCAN_TASK_KIND, async (payload, ctx) => {
    const name = typeof payload['folder'] === 'string' ? payload['folder'] : ''
    if (name === '') throw new TaskFatalError(`watch-scan task ${ctx.taskId} carries no folder name`)
    const folder = deps.folderStore.list().find((f) => f.name === name)
    if (folder === undefined) return { note: `watched folder '${name}' no longer exists — nothing scanned` }
    const result = await deps.kernel.execute(
      'system',
      { kind: 'storage-write', name: 'watched-folder-scan', attributes: { 'ingest.folder': name } },
      () => scanWatchedFolder(deps.knowledge, { ...folder, tags: autoTags(folder.tags) })
    )
    return {
      note: `scanned ${result.scannedFiles} file(s): ${result.ingested.length} ingested, ${result.skipped.length} skipped, ${result.failed.length} failed`
    }
  })
}

// ── The runtime ───────────────────────────────────────────────────────────────

export interface TriggerWatchersDeps {
  readonly queue: DurableTaskQueue
  readonly kernel: ActionExecutor
  readonly rules: readonly LoadedRule[]
  readonly folderStore: WatchedFolderStore
  /** Baseline persistence (userData/trigger-state.json). */
  readonly stateFile: string
  /** Test seams. */
  readonly fetchImpl?: typeof fetch
  readonly debounceMs?: number
  readonly urlMinIntervalMs?: number
}

export interface WatcherStatus {
  readonly folders: readonly { name: string; path: string }[]
  readonly rules: readonly { id: string; trigger: string }[]
}

export class TriggerWatchers {
  private readonly deps: TriggerWatchersDeps
  private readonly state: TriggerStateStore
  private readonly watchers: FSWatcher[] = []
  private readonly timers: NodeJS.Timeout[] = []
  private readonly crons: Cron[] = []
  /** One log line per (rule, reason) — polling errors must not spam the log. */
  private readonly warned = new Set<string>()
  private started = false
  private watchedFolders: WatchedFolder[] = []

  constructor(deps: TriggerWatchersDeps) {
    this.deps = deps
    this.state = new TriggerStateStore(deps.stateFile)
  }

  async start(): Promise<void> {
    if (this.started) throw new Error('watchers already started')
    this.started = true

    // Watched folders (§7 knowledge ingestion).
    this.watchedFolders = this.deps.folderStore.list().filter((f) => f.enabled)
    for (const folder of this.watchedFolders) {
      // Catch-up scan for changes made while the app was closed (content-hash
      // dedup makes an unchanged folder a cheap no-op).
      this.deps.queue.enqueue({
        id: `watch-scan-${shortHash(folder.name)}-${Date.now()}`,
        kind: WATCH_SCAN_TASK_KIND,
        priority: TASK_PRIORITY.watchScan,
        payload: { folder: folder.name }
      })
      const allowed = new Set((folder.extensions ?? INGEST_SUPPORTED_EXTENSIONS).map((e) => e.toLowerCase()))
      const watcher = chokidarWatch(folder.path, {
        ignoreInitial: true,
        awaitWriteFinish: {
          stabilityThreshold: this.deps.debounceMs ?? WATCHER_DEBOUNCE_MS,
          pollInterval: 100
        },
        ignored: (path: string) => {
          const name = basename(path)
          return name === 'node_modules' || name === '.git' || (name.startsWith('.') && name !== '.')
        }
      })
      const onFile = (path: string, sizeBytes: number | undefined): void => {
        if (!allowed.has(extname(path).toLowerCase())) return
        if (sizeBytes !== undefined && sizeBytes > INGEST_MAX_FILE_BYTES) return
        this.deps.queue.enqueue({
          id: `ingest-${shortHash(path)}-${Date.now()}`,
          kind: INGEST_FILE_TASK_KIND,
          priority: TASK_PRIORITY.ingestFile,
          payload: { path, folder: folder.name, tags: folder.tags }
        })
      }
      watcher.on('add', (path, stats) => onFile(path, stats?.size))
      watcher.on('change', (path, stats) => onFile(path, stats?.size))
      watcher.on('error', (err) => this.warnOnce(`folder:${folder.name}`, `watcher error: ${String(err)}`))
      this.watchers.push(watcher)
    }

    // User rules (§17 #5).
    for (const rule of this.deps.rules) {
      if (rule.trigger.type === 'schedule') {
        const cron = new Cron(rule.trigger.cron, () => {
          this.fireRule(rule, { kind: 'schedule', firedAt: new Date().toISOString() })
        })
        this.crons.push(cron)
        continue
      }
      if ('path' in rule.trigger) {
        const watchedPath = rule.trigger.path
        const watcher = chokidarWatch(watchedPath, {
          ignoreInitial: true,
          awaitWriteFinish: {
            stabilityThreshold: this.deps.debounceMs ?? WATCHER_DEBOUNCE_MS,
            pollInterval: 100
          }
        })
        const onChange = (path: string, eventName: string): void => {
          void this.detectFileChange(rule, path, eventName)
        }
        watcher.on('add', (path) => onChange(path, 'add'))
        watcher.on('change', (path) => onChange(path, 'change'))
        watcher.on('error', (err) => this.warnOnce(`rule:${rule.id}`, `file watcher error: ${String(err)}`))
        this.watchers.push(watcher)
        continue
      }
      const { url, intervalMin } = rule.trigger
      const intervalMs = Math.max(
        Math.round(intervalMin * 60_000),
        this.deps.urlMinIntervalMs ?? WATCHER_URL_MIN_INTERVAL_MS
      )
      // First poll now (sets the baseline or queues the §13 net approval).
      void this.pollUrl(rule, url)
      const timer = setInterval(() => void this.pollUrl(rule, url), intervalMs)
      this.timers.push(timer)
    }
  }

  async stop(): Promise<void> {
    for (const timer of this.timers) clearInterval(timer)
    this.timers.length = 0
    for (const cron of this.crons) cron.stop()
    this.crons.length = 0
    const closing = this.watchers.splice(0)
    await Promise.all(closing.map((w) => w.close().catch(() => undefined)))
  }

  status(): WatcherStatus {
    return {
      folders: this.watchedFolders.map((f) => ({ name: f.name, path: f.path })),
      rules: this.deps.rules.map((r) => ({
        id: r.id,
        trigger:
          r.trigger.type === 'schedule'
            ? `schedule ${r.trigger.cron}`
            : 'path' in r.trigger
              ? `watch ${r.trigger.path}`
              : `watch ${r.trigger.url} every ${r.trigger.intervalMin}m`
      }))
    }
  }

  /**
   * Rule file-watch detection: read + hash through the kernel (fs-read is
   * auto-allowed only inside the rule's declared fsRead — §13 even for
   * detection), fire on a REAL content change.
   */
  private async detectFileChange(rule: LoadedRule, path: string, eventName: string): Promise<void> {
    try {
      const content = await this.deps.kernel.execute(
        ruleAgentId(rule.id),
        { kind: 'fs-read', name: 'watch-detect', paths: [path], attributes: { 'rule.id': rule.id } },
        () => readFileSync(path)
      )
      const contentHash = sha256(content)
      if (this.state.get('fileHashes', rule.id) === contentHash) return // touch without change
      this.state.set('fileHashes', rule.id, contentHash)
      this.fireRule(rule, {
        kind: 'file',
        path,
        event: eventName,
        contentHash,
        content: content.toString('utf8').slice(0, WATCHER_URL_CONTENT_MAX_BYTES)
      })
    } catch (err) {
      this.warnOnce(`rule:${rule.id}:detect`, `file detection failed: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  /**
   * Rule url-watch detection (§7 budget rule: cheap local fetch+hash; the
   * expensive action only runs when the trigger actually fires). The net
   * action is approval-gated for user rules — until the dashboard approves,
   * polls queue exactly one §13 approval and stay dark.
   */
  private async pollUrl(rule: LoadedRule, url: string): Promise<void> {
    const host = new URL(url).host
    let body: string
    try {
      body = await this.deps.kernel.execute(
        ruleAgentId(rule.id),
        { kind: 'net', name: 'watch-poll', host, attributes: { 'rule.id': rule.id, 'watch.url': url } },
        async () => {
          const fetchImpl = this.deps.fetchImpl ?? fetch
          const response = await fetchImpl(url, { signal: AbortSignal.timeout(10_000) })
          const text = await response.text()
          if (!response.ok) throw new Error(`GET ${url} answered ${response.status}`)
          return text.slice(0, WATCHER_URL_CONTENT_MAX_BYTES)
        }
      )
    } catch (err) {
      if (err instanceof KernelApprovalPendingError) {
        this.warnOnce(
          `rule:${rule.id}:approval`,
          `url watch is waiting on §13 approval ${err.approvalId} — approve it in the review queue to start polling`
        )
        return
      }
      if (err instanceof KernelPermissionError) {
        this.warnOnce(`rule:${rule.id}:denied`, `url watch poll denied: ${err.message}`)
        return
      }
      this.warnOnce(`rule:${rule.id}:poll`, `url poll failed: ${err instanceof Error ? err.message : String(err)}`)
      return
    }
    this.warned.delete(`rule:${rule.id}:poll`) // a success re-arms the failure warning
    const contentHash = sha256(body)
    const baseline = this.state.get('urlHashes', rule.id)
    if (baseline === contentHash) return
    this.state.set('urlHashes', rule.id, contentHash)
    if (baseline === undefined) return // first observation is the baseline, not a change
    this.fireRule(rule, { kind: 'url', url, contentHash, content: body })
  }

  /** Condition-check the trigger event and enqueue the rule's action task. */
  private fireRule(rule: LoadedRule, event: JsonObject): void {
    if (rule.condition !== null && !evaluateRuleCondition(rule.condition, event)) return
    const result = this.deps.queue.enqueue({
      id: `rule-${rule.id}-${Date.now()}`,
      kind: RULE_ACTION_TASK_KIND,
      priority: TASK_PRIORITY.ruleAction,
      payload: { ruleId: rule.id, event }
    })
    if (!result.deduped) {
      console.log(`[triggers] rule '${rule.id}' fired (${String(event['kind'])}) — enqueued ${result.taskId}`)
    }
  }

  private warnOnce(key: string, message: string): void {
    if (this.warned.has(key)) return
    this.warned.add(key)
    console.warn(`[triggers] ${message}`)
  }
}
