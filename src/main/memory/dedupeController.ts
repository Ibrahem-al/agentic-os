/**
 * Background duplicate-scan controller (user-directed improvement).
 *
 * The old "Find duplicates" scan ran synchronously inside the modal — closing
 * the popup threw the work away. This runs the scan in the MAIN process,
 * detached from any window: `start()` kicks it off and returns immediately,
 * progress + completion ride IPC_EVENT_DEDUPE_STATUS, and the LAST COMPLETED
 * result is persisted to the `dedupe_scans` row so reopening the modal (even
 * after a restart) shows it. A read-only maintenance scan is not a durable
 * "job", so this deliberately does NOT use the task queue (no retry/backoff, no
 * Jobs-list noise); an interrupted scan is simply re-run.
 *
 * `scope: 'recent'` resolves its cutoff from the persisted `watermark_at` (the
 * scan-START of the last completed recent/all scan) or, on the first-ever run,
 * DEDUPE_RECENT_DEFAULT_WINDOW_MS ago — so right after a big ingest it compares
 * exactly what changed. Only recent/all advance the watermark; a `count`
 * spot-check must not claim "everything up to now was checked".
 */
import type BetterSqlite3 from 'better-sqlite3'
import { DEDUPE_COUNT_DEFAULT, DEDUPE_RECENT_DEFAULT_WINDOW_MS } from '../config'
import type { StorageEngine } from '../storage'
import type {
  DedupeScanOptionsDto,
  DedupeScanRunningDto,
  DedupeScanScope,
  DedupeScanStatusDto,
  MemoryDedupeScanResultDto
} from '../../shared/ipc'
import { DedupeScanAbortedError, scanDuplicates, type ScanDuplicatesOptions } from './dedupe'
import { MemoryEditError } from './edit'

export type DedupeScanStatus = DedupeScanStatusDto
export type DedupeScanStartOptions = DedupeScanOptionsDto

export interface DedupeScanControllerDeps {
  readonly engine: StorageEngine
  readonly db: BetterSqlite3.Database
  /** Push a status snapshot to the renderer(s). No-op in headless rigs. */
  readonly broadcast?: (status: DedupeScanStatusDto) => void
  /** Injectable clock (ms) for deterministic tests. */
  readonly now?: () => number
}

interface DedupeScanRow {
  completed_at: string
  scope: string
  options_json: string
  result_json: string
  scanned_nodes: number
  watermark_at: string | null
}

interface PersistedOptions {
  scope: DedupeScanScope
  count?: number
  effectiveCutoff?: string
}

const advancesWatermark = (scope: DedupeScanScope): boolean => scope === 'recent' || scope === 'all'

export class DedupeScanController {
  private readonly engine: StorageEngine
  private readonly db: BetterSqlite3.Database
  private readonly broadcast: (status: DedupeScanStatusDto) => void
  private readonly now: () => number

  private phase: DedupeScanStatusDto['phase'] = 'idle'
  private running: DedupeScanRunningDto | undefined
  private errorMessage: string | undefined
  private abort: AbortController | null = null

  constructor(deps: DedupeScanControllerDeps) {
    this.engine = deps.engine
    this.db = deps.db
    this.broadcast = deps.broadcast ?? ((): void => {})
    this.now = deps.now ?? ((): number => Date.now())
  }

  /** Current status: live phase/progress merged with the persisted last result. */
  snapshot(): DedupeScanStatusDto {
    const status: {
      phase: DedupeScanStatusDto['phase']
      running?: DedupeScanRunningDto
      error?: { message: string }
      lastResult?: MemoryDedupeScanResultDto
      lastScope?: DedupeScanScope
      lastCount?: number
      lastCompletedAt?: string
      effectiveCutoff?: string
      watermarkAt?: string | null
    } = { phase: this.phase }
    if (this.phase === 'running' && this.running !== undefined) status.running = this.running
    if (this.phase === 'error' && this.errorMessage !== undefined) status.error = { message: this.errorMessage }
    const row = this.readRow()
    if (row !== null) {
      try {
        status.lastResult = JSON.parse(row.result_json) as MemoryDedupeScanResultDto
        status.lastScope = row.scope as DedupeScanScope
        status.lastCompletedAt = row.completed_at
        status.watermarkAt = row.watermark_at
        const opts = JSON.parse(row.options_json) as PersistedOptions
        if (typeof opts.count === 'number') status.lastCount = opts.count
        if (typeof opts.effectiveCutoff === 'string') status.effectiveCutoff = opts.effectiveCutoff
      } catch {
        // A corrupt row is treated as "no last result" — a fresh scan overwrites it.
      }
    }
    return status
  }

  /**
   * Start a background scan. Rejects if one is already in flight (the UI
   * disables Start while running; this guards a programmatic double-call).
   * Returns the fresh status so the caller can render it immediately.
   */
  start(options: DedupeScanOptionsDto): DedupeScanStatusDto {
    if (this.phase === 'running') {
      throw new MemoryEditError('INVALID_INPUT', 'a duplicate scan is already running — cancel it or wait for it to finish')
    }
    const startedMs = this.now()
    let sinceIso: string | undefined
    if (options.scope === 'recent') {
      const wm = this.readRow()?.watermark_at ?? null
      sinceIso = wm ?? new Date(startedMs - DEDUPE_RECENT_DEFAULT_WINDOW_MS).toISOString()
    }
    this.abort = new AbortController()
    this.phase = 'running'
    this.errorMessage = undefined
    this.running = { scope: options.scope, scannedNodes: 0, totalNodes: 0, currentLabel: '' }
    void this.run(options, sinceIso, startedMs)
    const snap = this.snapshot()
    this.broadcast(snap)
    return snap
  }

  /** Abort the in-flight scan (cooperative — takes effect at the next probe checkpoint). */
  cancel(): DedupeScanStatusDto {
    this.abort?.abort()
    return this.snapshot()
  }

  private async run(options: DedupeScanOptionsDto, sinceIso: string | undefined, startedMs: number): Promise<void> {
    const signal = this.abort?.signal
    const scanOptions: ScanDuplicatesOptions = {
      scope: options.scope,
      ...(options.labels !== undefined ? { labels: options.labels } : {}),
      ...(options.threshold !== undefined ? { threshold: options.threshold } : {}),
      ...(options.near !== undefined ? { near: options.near } : {}),
      ...(options.scope === 'count' ? { count: options.count ?? DEDUPE_COUNT_DEFAULT } : {}),
      ...(sinceIso !== undefined ? { sinceUpdatedAtIso: sinceIso } : {}),
      ...(signal !== undefined ? { signal } : {}),
      onProgress: (p): void => {
        this.running = {
          scope: options.scope,
          scannedNodes: p.scannedNodes,
          totalNodes: p.totalNodes,
          currentLabel: p.currentLabel
        }
        this.broadcast(this.snapshot())
      }
    }
    try {
      const result = await scanDuplicates({ engine: this.engine }, scanOptions)
      this.persist(options, sinceIso, startedMs, result.groups, result.truncated, result.scannedNodes)
      this.phase = 'done'
      this.running = undefined
      this.broadcast(this.snapshot())
    } catch (err) {
      this.running = undefined
      if (err instanceof DedupeScanAbortedError) {
        this.phase = 'idle' // cancel → back to idle, prior lastResult preserved
      } else {
        this.phase = 'error'
        this.errorMessage = err instanceof Error ? err.message : String(err)
      }
      this.broadcast(this.snapshot())
    } finally {
      this.abort = null
    }
  }

  private persist(
    options: DedupeScanOptionsDto,
    sinceIso: string | undefined,
    startedMs: number,
    groups: MemoryDedupeScanResultDto['groups'],
    truncated: boolean,
    scannedNodes: number
  ): void {
    const completedAt = new Date(this.now()).toISOString()
    const prevWatermark = this.readRow()?.watermark_at ?? null
    const watermark = advancesWatermark(options.scope) ? new Date(startedMs).toISOString() : prevWatermark
    const persistedOptions: PersistedOptions = {
      scope: options.scope,
      ...(options.scope === 'count' ? { count: options.count ?? DEDUPE_COUNT_DEFAULT } : {}),
      ...(sinceIso !== undefined ? { effectiveCutoff: sinceIso } : {})
    }
    const resultJson = JSON.stringify({ groups, truncated } satisfies MemoryDedupeScanResultDto)
    this.db
      .prepare(
        `INSERT INTO dedupe_scans (id, completed_at, scope, options_json, result_json, scanned_nodes, watermark_at)
         VALUES (1, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           completed_at = excluded.completed_at, scope = excluded.scope, options_json = excluded.options_json,
           result_json = excluded.result_json, scanned_nodes = excluded.scanned_nodes, watermark_at = excluded.watermark_at`
      )
      .run(completedAt, options.scope, JSON.stringify(persistedOptions), resultJson, scannedNodes, watermark)
  }

  private readRow(): DedupeScanRow | null {
    const row = this.db
      .prepare(
        'SELECT completed_at, scope, options_json, result_json, scanned_nodes, watermark_at FROM dedupe_scans WHERE id = 1'
      )
      .get() as DedupeScanRow | undefined
    return row ?? null
  }
}
