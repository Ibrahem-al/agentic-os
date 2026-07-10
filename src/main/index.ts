import { app, BrowserWindow, ipcMain, safeStorage, shell } from 'electron'
import { join } from 'node:path'
import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import {
  IPC_EVENT_UPDATER_STATUS,
  IPC_EVENT_WINDOW_MAXIMIZE,
  IPC_WINDOW_CLOSE,
  IPC_WINDOW_IS_MAXIMIZED,
  IPC_WINDOW_MINIMIZE,
  IPC_WINDOW_TOGGLE_MAXIMIZE,
  type BootDiagnosticDto
} from '../shared/ipc'
import {
  appDataPaths,
  CLOUD_BASE_URL_OVERRIDE,
  DENO_VERSION,
  HOOK_SESSION_END_URL,
  MCP_HOST,
  MCP_PORT,
  MCP_SERVERS_CONFIG_FILENAME,
  PRODUCT_NAME,
  RULES_DIR,
  RYU_EXTENSION_VERSION_DIR,
  RYUGRAPH_VERSION_PIN,
  BACKUP_SCHEDULER_CHECK_INTERVAL_MS,
  SPOOL_DIR,
  TRIGGER_STATE_FILENAME,
  WATCHED_FOLDERS_CONFIG_FILENAME
} from './config'
import {
  APPDATA_USER_VERSION,
  backupRequestPending,
  isAutoBackupDue,
  openAppData,
  openRyuGraphEngine,
  performPendingBackup,
  performPendingReset,
  performPendingRestore,
  requestBackup,
  verifyDataManifest,
  writeDataManifest,
  type AppData,
  type ResetResult
} from './storage'
import {
  CallBudget,
  Keychain,
  keychainPath,
  loadModelSettings,
  OllamaClient,
  ProviderRouter,
  Reranker,
  RUNNER_TOKEN_SECRET,
  SpendMeter,
  activeCloudModel,
  createCloudBrain,
  settingsPath
} from './models'
import { createTelemetry, type Telemetry } from './telemetry'
import { ContextManager, createInflightYield, Kernel, LangGraphRunner } from './kernel'
import {
  AuditLog,
  createInjectionScanner,
  DenoLane,
  detectDocker,
  DockerLane,
  PermissionEngine,
  registerInternalAgents,
  untrusted,
  type InjectionScanner
} from './security'
import { createRetriever } from './retrieval'
import { Runner } from './runner'
import { AgenticOsMcpServer, claudeMcpAddCommand, McpClientManager, writeSampleMcpJson } from './mcp'
import {
  createExtractionAgent,
  createSkillImprovementAgent,
  parseTranscriptFile,
  registerSkillImprovementHandler,
  type ExtractionAgent,
  type SkillImprovementAgent
} from './agents'
import { WatchedFolderStore } from './ingest'
import {
  createSessionEndHookHandler,
  drainSessionSpool,
  DurableTaskQueue,
  InactivityMonitor,
  loadRules,
  registerExtractionHandler,
  registerIngestHandlers,
  registerMaintenanceHandlers,
  registerRuleActionHandler,
  registerRuleAgents,
  TriggerSchedules,
  TriggerWatchers,
  type RuleLoadResult
} from './triggers'
import { registerIpcHandlers } from './ipc'
import { bootUpdater, type UpdaterController } from './updater'
import { computeBootDiagnostics } from './bootDiagnostics'

// Native modules are CJS; load them through require so the bundler leaves them
// external and Electron resolves them from node_modules at runtime.
const require = createRequire(import.meta.url)

// Test/e2e hook: point the whole app at a scratch userData dir (also keeps
// smoke tests away from real data). Must be set before app is ready.
const userDataOverride = process.env['AGENTIC_OS_USER_DATA_DIR']
if (userDataOverride) app.setPath('userData', userDataOverride)
// CI seam (linux only, recorded rule-12): headless runners have no keyring,
// so Chromium's os_crypt falls back in ways that can leave safeStorage
// unavailable and the keychain (bearer/hook tokens) dead. Setting
// AGENTIC_OS_LINUX_PASSWORD_STORE=basic pins the basic_text backend so the
// golden-path e2e can boot the real keychain on a runner. Never set in
// production; secrets there ride the OS keyring per §21 rule 7.
if (process.platform === 'linux' && process.env['AGENTIC_OS_LINUX_PASSWORD_STORE']) {
  app.commandLine.appendSwitch('password-store', process.env['AGENTIC_OS_LINUX_PASSWORD_STORE'])
}

let engine: Awaited<ReturnType<typeof openRyuGraphEngine>> | null = null
let appData: AppData | null = null
let telemetry: Telemetry | null = null
/** Kernel singletons (phase 04) — the MCP server + later agents run through these. */
let kernelInstances: { kernel: Kernel; runner: LangGraphRunner; contextManager: ContextManager } | null = null
/** Security singletons (phase 09): §13 engine + audit/undo + injection scanner. */
let securityInstances: { permissions: PermissionEngine; audit: AuditLog; scanner: InjectionScanner } | null = null
/**
 * ONE ReasoningProvider router (phase-16b, §11.4) shared across the kernel/MCP/
 * agents/IPC boots — built in bootKernel (the first consumer), like
 * kernelInstances/securityInstances. subscriptionComplete + runnerHealthy stay
 * UNSET until phase-17, so the subscription backend is unavailable and every
 * role resolves to its today tier: DEFAULT == TODAY.
 */
let providerRouter: ProviderRouter | null = null
/**
 * The headless subscription runner (phase 17). Built in bootKernel over the ONE
 * CallBudget; its `complete`/`isHealthy` are injected into the ProviderRouter so
 * subscribable roles can route to a Claude subscription when the user opts in.
 * SHIPS OFF: with `runner.enabled=false` (the default) `isHealthy()` is false, so
 * the subscription backend stays unavailable and nothing here ever spawns claude.
 * killChildren() runs FIRST in will-quit; sweepZombies() runs at boot.
 */
let subscriptionRunner: Runner | null = null
/** Model-layer singletons (phase 02) — shared by the MCP server (phase 05). */
let keychain: Keychain | null = null
let ollama: OllamaClient | null = null
/** ONE lazy reranker instance app-wide (phase-03: never re-instantiate models). */
let reranker: Reranker | null = null
/** MCP server + client manager (phase 05); the manager serves phases 08/10. */
let mcpServer: AgenticOsMcpServer | null = null
let mcpClientManager: McpClientManager | null = null
void mcpClientManager
/** Extraction agent (phase 08) — the phase-11 session-end triggers call it. */
let extractionAgent: ExtractionAgent | null = null
/** Skill-improvement agent (phase 12) — the 02:00 slot + "improve now" drive it. */
let skillImprovementAgent: SkillImprovementAgent | null = null
/**
 * Auto-updater controller (phase 13, extended). Built by bootUpdater() before
 * bootIpc so the `updater.*` IPC channels can read its snapshot; its
 * onStatusChange is forwarded to the window(s) over IPC_EVENT_UPDATER_STATUS.
 * 'disabled' (no-op) in dev builds.
 */
let updaterController: UpdaterController | null = null
/** Trigger runtime (phase 11): queue + schedules + watchers + session-end. */
let triggerInstances: {
  queue: DurableTaskQueue
  schedules: TriggerSchedules
  watchers: TriggerWatchers
  inactivity: InactivityMonitor
  rules: RuleLoadResult
} | null = null

/**
 * Per-subsystem boot outcome, surfaced to the dashboard (App.tsx subsystem
 * strip) and the get_app_status MCP tool so a failed/degraded connection shows
 * its CAUSE, not just a red dot. Each boot step's catch records here; a couple of
 * non-throwing degradations (mcp port-in-use) record directly; computeBootDiagnostics
 * folds them with the resulting singleton state into the surfaced list.
 */
const bootErrors = new Map<string, string>()
function recordBootError(subsystem: string, err: unknown): void {
  bootErrors.set(subsystem, err instanceof Error ? err.message : String(err))
}

/**
 * Snapshot the module singletons + captured boot errors and fold them into the
 * per-subsystem diagnostics the dashboard shows (the pure fold lives in
 * bootDiagnostics.ts so it is unit-testable). Called once at bootIpc (the last
 * boot step) — a boot-time property, static until the next launch, like
 * `subsystems`.
 */
function currentBootDiagnostics(): BootDiagnosticDto[] {
  return computeBootDiagnostics({
    errors: bootErrors,
    engineOpen: engine !== null,
    appDataOpen: appData !== null,
    walQuarantined: engine?.walQuarantined ?? null,
    modelsOpen: ollama !== null,
    kernelOpen: kernelInstances !== null,
    mcpOpen: mcpServer !== null,
    mcpUrl: mcpServer?.url ?? null,
    agentsOpen: extractionAgent !== null,
    triggersOpen: triggerInstances !== null
  })
}

/**
 * Phase-13 test seam (rule 12, recorded): AGENTIC_OS_RERANKER_FILES points at
 * a JSON file matching RerankerOptions['files'] ({model, tokenizer,
 * tokenizerConfig} PinnedFile descriptors). The golden-path e2e/CI passes a
 * tiny valid ONNX fixture (with ITS real sha256) so the production retrieval
 * path runs the REAL onnxruntime session without the 570 MB download. Unset
 * in normal operation.
 */
function rerankerFilesOverride(): { files: NonNullable<ConstructorParameters<typeof Reranker>[0]['files']> } | Record<string, never> {
  const path = process.env['AGENTIC_OS_RERANKER_FILES']
  if (!path) return {}
  const { readFileSync } = require('node:fs') as typeof import('node:fs')
  try {
    const files = JSON.parse(readFileSync(path, 'utf8')) as NonNullable<
      ConstructorParameters<typeof Reranker>[0]['files']
    >
    console.log(`[models] reranker file pins overridden from ${path} (test seam)`)
    return { files }
  } catch (err) {
    console.warn(`[models] AGENTIC_OS_RERANKER_FILES unreadable (${String(err)}) — using pinned defaults`)
    return {}
  }
}

/**
 * §10.5/P0.3 boot hygiene: delete any per-task `<userData>/runner/*.mcp.json`
 * left by a previous run. Agent mode (phase-19) writes these fresh per spawn and
 * removes them after; a crash can strand one referencing a now-rotated runner
 * token. Completion mode writes none, so this is a no-op on a default install
 * (the directory usually does not exist).
 */
function sweepStaleRunnerMcpConfigs(userDataDir: string): void {
  const { readdirSync, rmSync } = require('node:fs') as typeof import('node:fs')
  const dir = join(userDataDir, 'runner')
  let entries: string[]
  try {
    entries = readdirSync(dir)
  } catch {
    return // no runner dir yet — nothing to sweep
  }
  let swept = 0
  for (const name of entries) {
    if (!name.endsWith('.mcp.json')) continue
    try {
      rmSync(join(dir, name), { force: true })
      swept += 1
    } catch {
      /* best effort — never fail boot over a leftover config */
    }
  }
  if (swept > 0) console.log(`[runner] swept ${swept} stale runner/*.mcp.json from a previous run`)
}

/**
 * Auto-backup scheduler (Settings "Data & backups"). unref'd — never holds the
 * process open, cleared at quit. The running app CANNOT snapshot the graph (the
 * engine holds an OS lock on graph.ryugraph — verified), so a due tick only
 * STAGES a `backup-requested.json` marker; the real auto-backup is the boot-time
 * catch-up in performPendingBackup, run before the store opens. The tick is
 * belt-and-braces (guarantees the next launch backs up even between catch-ups)
 * and cheap: it re-reads settings + the backup list each fire.
 */
let backupSchedulerTimer: ReturnType<typeof setInterval> | null = null
function startBackupScheduler(userDataDir: string): void {
  if (backupSchedulerTimer !== null) return
  backupSchedulerTimer = setInterval(() => {
    try {
      if (isAutoBackupDue(userDataDir) && !backupRequestPending(userDataDir)) {
        requestBackup(userDataDir, 'auto')
        console.log('[backups] auto-backup due — staged for the next launch (the graph is locked while the engine is open)')
      }
    } catch (err) {
      console.warn('[backups] scheduler tick failed (ignored)', err)
    }
  }, BACKUP_SCHEDULER_CHECK_INTERVAL_MS)
  backupSchedulerTimer.unref()
}

/** Native-module pipeline sanity: versions logged from Electron main. */
function logNativeModuleVersions(): void {
  const ortPkg = require('onnxruntime-node/package.json') as { version: string }
  const ort = require('onnxruntime-node') as { env?: { versions?: Record<string, string> } }
  const ortRuntimeVersion = ort.env?.versions?.['common'] ?? ortPkg.version
  console.log(`[native] onnxruntime-node ${ortPkg.version} (runtime ${ortRuntimeVersion}) loaded in Electron main`)
}

/**
 * Phase-01 storage boot: appdata.db (SQLite, WAL) + the RyuGraph engine
 * (backup-if-migrating → open → migrate), both under Electron userData.
 */
async function bootStorage(): Promise<void> {
  const { readFileSync } = require('node:fs') as typeof import('node:fs')
  const userDataDir = app.getPath('userData')
  const paths = appDataPaths(userDataDir)

  // Data-safety lifecycle, BEFORE any store opens and BEFORE the win32
  // ryugraph gate below — so a packaged "reinstall from scratch" always runs
  // its next-boot reset. All three are internally fail-safe and wrapped again
  // here so a manifest/reset hiccup can never take boot down.
  //  1. verify: compare the previous manifest's critical assets to disk and
  //     WARN loudly on a lost graph/appdata/keychain (log-only, never blocks).
  //  2. reset: if (and only if) the installer left a valid reset marker,
  //     snapshot → integrity-check → record → clear (recoverable). No marker ⇒
  //     data is never touched — the app-side silent/auto-update invariant.
  let reset: ResetResult = { performed: false, reason: 'no-marker' }
  try {
    for (const finding of verifyDataManifest(userDataDir)) {
      console.warn(`[storage] data-manifest mismatch: ${finding.path} — ${finding.detail}`)
    }
  } catch (err) {
    console.warn('[storage] data-manifest verify failed (ignored)', err)
  }
  try {
    reset = performPendingReset(userDataDir, (m) => console.log(m))
  } catch (err) {
    // performPendingReset is internally fail-safe; this guard is belt-and-braces.
    console.error('[storage] pending-reset handling failed — user data left intact', err)
  }
  //  3. restore: a Settings-UI restore request runs here (before any store
  //     opens — the graph is unlocked). Both-markers edge: reset wins, the
  //     restore marker is defused. Internally fail-safe (mirror of reset).
  try {
    performPendingRestore(userDataDir, (m) => console.log(m), { resetJustPerformed: reset.performed })
  } catch (err) {
    console.error('[storage] pending-restore handling failed — user data left intact', err)
  }
  //  4. backup: consume a staged manual/auto backup marker + run the auto-backup
  //     boot catch-up (newest -auto older than the interval), then prune. A
  //     backup only ADDS a directory; never throws boot down.
  try {
    performPendingBackup(userDataDir, (m) => console.log(m))
  } catch (err) {
    console.error('[storage] pending-backup handling failed (ignored)', err)
  }

  // ryugraph's `exports` map hides package.json from require — read it directly.
  const ryuPkgPath = join(app.getAppPath(), 'node_modules', 'ryugraph', 'package.json')
  const ryuPkg = JSON.parse(readFileSync(ryuPkgPath, 'utf8')) as { version: string }
  if (ryuPkg.version !== RYUGRAPH_VERSION_PIN) {
    console.warn(`[storage] ryugraph ${ryuPkg.version} does not match pin ${RYUGRAPH_VERSION_PIN}`)
  }
  // The npm prebuilt ryujs.node binds its imports to node.exe with no
  // delay-load hook, so require()-ing it inside electron.exe on Windows is an
  // uncatchable native crash. `npm run rebuild:native` replaces it with an
  // Electron-targeted build and stamps this marker; until then, skip.
  if (process.platform === 'win32') {
    const marker = join(app.getAppPath(), 'node_modules', 'ryugraph', '.electron-safe')
    // Packaged builds are gated at PACK time instead (scripts/build/
    // before-pack.cjs refuses to pack without the rebuilt binary), so a
    // missing marker inside the archive is a packaging bug, not a user error.
    if (!existsSync(marker) && !app.isPackaged) {
      console.warn(
        '[storage] ryugraph prebuilt is not Electron-safe on win32 — run `npm run rebuild:native`; storage disabled this launch'
      )
      return
    }
  }

  appData = openAppData(paths.appDb)
  console.log(`[storage] appdata.db open (WAL: traces, tasks, mcp_calls, staged_writes, spend) at ${appData.path}`)
  if (appData.backupCreated !== null) {
    console.log(`[storage] pre-upgrade appdata backup: ${appData.backupCreated}`)
  }

  engine = await openRyuGraphEngine({
    graphDir: paths.graphDir,
    backupsDir: paths.backupsDir,
    // Packaged builds ship the vendored extensions as extraResources (they are
    // loaded by absolute path by NATIVE code and cannot live inside asar);
    // dev/test runs load them from the repo (§21 rule 2 — never fetched).
    extensionsDir: app.isPackaged
      ? join(process.resourcesPath, 'extensions', RYU_EXTENSION_VERSION_DIR)
      : join(app.getAppPath(), 'resources', 'extensions', RYU_EXTENSION_VERSION_DIR)
  })
  const counts = await engine.cypher('MATCH (n) RETURN count(n) AS c')
  const backupNote = engine.backupCreated ? `, pre-migration backup: ${engine.backupCreated}` : ''
  console.log(
    `[storage] ryugraph ${ryuPkg.version} open at ${paths.graphDir} — schema v${engine.schemaVersion}, ${Number(
      counts[0]?.['c'] ?? 0
    )} nodes, vector+FTS from vendored extensions${backupNote}`
  )
  if (engine.walQuarantined !== null) {
    console.warn(
      `[storage] RECOVERED from a corrupt graph WAL — quarantined the torn WAL to ${engine.walQuarantined} and reopened at the last checkpoint. Un-checkpointed writes since that checkpoint were lost; the quarantined WAL is preserved for inspection.`
    )
  }

  // Refresh the machine-readable data manifest (§3 "note") with live versions +
  // backup pointers. Atomic tmp+rename; a manifest write failure never takes
  // boot down (it is a derived record, not the data).
  try {
    writeDataManifest(userDataDir, {
      appVersion: app.getVersion(),
      appdataUserVersion: APPDATA_USER_VERSION,
      graphSchemaVersion: engine.schemaVersion,
      lastBackupAt: engine.backupCreated ?? appData.backupCreated ?? null,
      ...(reset.performed ? { lastResetAt: new Date().toISOString(), lastResetBackupDir: reset.backupDir } : {})
    })
  } catch (err) {
    console.warn('[storage] data-manifest write failed (ignored)', err)
  }
}

/**
 * Phase-02 model-layer boot: keychain (safeStorage-encrypted; auto-generates
 * the MCP bearer token, consumed in phase 05), model settings, and Ollama
 * detection for the §4 guided-install flow. No secret value is ever logged.
 */
async function bootModels(): Promise<void> {
  const userDataDir = app.getPath('userData')
  keychain = new Keychain({ filePath: keychainPath(userDataDir), safeStorage })
  keychain.ensureMcpBearerToken()
  console.log(
    `[models] keychain open (safeStorage-encrypted) — secrets present: ${keychain.listSecretNames().join(', ') || '(none)'}`
  )

  const settings = loadModelSettings(settingsPath(userDataDir))
  console.log(`[models] active cloud provider: ${settings.cloudProvider}`)

  ollama = new OllamaClient()
  const status = await ollama.status()
  if (status.state === 'ready') {
    console.log(`[models] ollama ready (${status.installedModels.length} models incl. required)`)
  } else if (status.state === 'models-missing') {
    console.log(`[models] ollama running, missing models: ${status.missingModels.join(', ')} — dashboard offers one-click pull`)
  } else {
    console.log(`[models] ollama not detected — dashboard links installer (${status.installUrl})`)
  }
}

/**
 * Phase-04 kernel boot: OTel telemetry into the traces table, the workflow
 * runner (LangGraph behind the WorkflowRunner interface, SQLite checkpointer
 * in appdata.db) and the context manager (local-LLM summarizer). Background
 * agents (phase 08+) and the MCP server (phase 05) run through these.
 */
function bootKernel(): void {
  if (appData === null) {
    console.warn('[kernel] appdata.db unavailable — kernel boot skipped')
    return
  }
  telemetry = createTelemetry(appData.db)
  // Phase 09: the REAL §13 spine replaces the phase-04 stubs — capability
  // engine (default-deny, tiered gates, pending approvals in appdata) and the
  // reversible-delta audit log (graph inverses + file pre-images in backups/).
  const userDataDir = app.getPath('userData')
  const paths = appDataPaths(userDataDir)
  // Phase-16b: the ONE ProviderRouter (§11.4 role → backend, resolved per call
  // from a cached settings snapshot), built here — the first consumer boot —
  // and shared via the module local. `loadSnapshot`/`makeCloud` re-read the
  // settings file + the keychain LIVE per call, so a provider/model/key change
  // takes effect on the NEXT call once an IPC mutator fires router.invalidate()
  // (P1.1 — no app restart). Phase-17 now injects subscriptionComplete +
  // runnerHealthy from the runner below; DEFAULT == TODAY still holds because
  // runner.enabled=false (the default) ⇒ isHealthy() false ⇒ subscription
  // unavailable ⇒ every role falls through to its today tier.
  const ollamaClient = ollama ?? new OllamaClient()
  const appDataForRouter = appData
  // Phase-17: ONE CallBudget over runner_runs (P0.2 — durable across resume),
  // shared by the runner's completion path AND the router's subscription guard.
  const callBudget = new CallBudget({ db: appDataForRouter.db })
  // Build the ONE headless runner (completion mode) over that budget, then inject
  // its completion fn + live health into the router — the two seams phase-16 left
  // UNSET. With runner.enabled=false (the default) isHealthy() is false, so the
  // subscription backend stays unavailable and every role resolves to its today
  // tier: DEFAULT == TODAY (a keyless install is byte-for-byte local and NEVER
  // spawns claude).
  const runnerInstance = new Runner({
    db: appDataForRouter.db,
    loadSettings: () => loadModelSettings(settingsPath(userDataDir)),
    telemetry,
    callBudget
  })
  subscriptionRunner = runnerInstance
  const router = new ProviderRouter({
    loadSnapshot: () => loadModelSettings(settingsPath(userDataDir)),
    ollama: ollamaClient,
    makeCloud: () => {
      const s = loadModelSettings(settingsPath(userDataDir))
      const apiKey = keychain?.getApiKey(s.cloudProvider)
      return apiKey
        ? {
            brain: createCloudBrain(s.cloudProvider, {
              apiKey,
              model: activeCloudModel(s),
              // Phase-13 test seam: the golden-path e2e fronts the cloud tier
              // with a scripted server (unset in production).
              ...(CLOUD_BASE_URL_OVERRIDE !== undefined ? { baseUrl: CLOUD_BASE_URL_OVERRIDE } : {})
            }),
            meter: new SpendMeter({ db: appDataForRouter.db })
          }
        : null
    },
    // Phase-17 (were unset): the runner's completion fn + live health probe.
    subscriptionComplete: runnerInstance.complete,
    runnerHealthy: () => runnerInstance.isHealthy(),
    callBudget
  })
  providerRouter = router
  // §10.1/P0.4 zombie defense: kill any runner child tree orphaned by a previous
  // process generation (an unfinished runner_runs row whose pid still resolves to
  // a claude image — NEVER by pid alone) and sweep stale per-task
  // runner/*.mcp.json. Both are no-ops on a fresh/default install.
  void runnerInstance
    .sweepZombies()
    .then((killed) => {
      if (killed > 0) console.log(`[runner] boot zombie sweep killed ${killed} orphaned runner child tree(s)`)
    })
    .catch((err) => console.warn('[runner] boot zombie sweep failed', err))
  sweepStaleRunnerMcpConfigs(userDataDir)
  const runnerEnabled = loadModelSettings(settingsPath(userDataDir)).runner?.enabled === true
  console.log(
    `[runner] subscription runner built (completion mode) — ${
      runnerEnabled ? 'ENABLED' : 'disabled (default)'
    }; complete/health injected into the router`
  )
  const permissions = new PermissionEngine({ db: appData.db })
  registerInternalAgents(permissions)
  const audit = new AuditLog({
    db: appData.db,
    backupsDir: paths.backupsDir,
    ...(engine !== null ? { engine } : {})
  })
  const scanner = createInjectionScanner({ db: appData.db, router, ...(ollama !== null ? { llm: ollama } : {}) })
  securityInstances = { permissions, audit, scanner }
  const kernel = new Kernel({ telemetry, permissions, audit })
  // §8 phase-13: cooperative yield at step boundaries — a running multi-step
  // workflow defers to live INTERACTIVE MCP calls between steps (the queue's
  // pre-dispatch yield covers only task starts). §14b gauge split: a runner's
  // own MCP calls are excluded, so a background workflow never yields to itself.
  // The closure reads mcpServer at call time; it is null until bootMcp() and
  // that is fine (0 inflight = no wait).
  const runner = new LangGraphRunner({
    db: appData.db,
    telemetry,
    executor: kernel,
    yieldPoint: createInflightYield(() => mcpServer?.inflightInteractiveCalls ?? 0)
  })
  const contextManager = new ContextManager({ llm: ollamaClient, router, telemetry })
  kernelInstances = { kernel, runner, contextManager }
  console.log('[kernel] workflow runner ready (LangGraph + SQLite checkpointer) — spans → traces table')
  console.log(
    '[security] §13 spine armed — permission engine (default-deny, tiered gates), audit/undo log, injection scanner'
  )
  // Sandbox lanes (§11): the managed Deno binary downloads on first use; the
  // Docker lane detects-and-guides. Nothing runs user code until phase 11.
  void detectDocker().then((docker) => {
    console.log(
      `[security] sandbox lanes — deno: managed v${DENO_VERSION} (downloads to userData/bin on first use); docker: ${
        docker.available ? `ready (server ${docker.version})` : 'not detected (guided install offered when a polyglot rule is added)'
      }`
    )
  })
}

/**
 * Phase-05 MCP boot: the §12 Streamable HTTP server on 127.0.0.1:4517 behind
 * the keychain bearer token, every tool call kernel-mediated and logged to
 * mcp_calls; plus the outbound MCP client manager. The get_context path uses
 * ONE retriever over the shared OllamaClient + one lazy Reranker (phase-03:
 * never re-instantiate models per call).
 */
async function bootMcp(): Promise<void> {
  if (appData === null || engine === null || kernelInstances === null || keychain === null || ollama === null) {
    console.warn('[mcp] storage/models/kernel unavailable — MCP server disabled this launch')
    return
  }
  const userDataDir = app.getPath('userData')
  const paths = appDataPaths(userDataDir)
  reranker ??= new Reranker({ modelsDir: paths.modelsDir, ...rerankerFilesOverride() })
  const retrievalDeps = { engine, embedder: ollama, reranker }
  // Phase-16b: the loop's critic/rewrite roles bind off the router when wired
  // (both §11.4 HARD-local ⇒ always local-qwen3 ⇒ identical to `llm`).
  const retriever = createRetriever({
    ...retrievalDeps,
    llm: ollama,
    ...(providerRouter !== null ? { router: providerRouter } : {})
  })
  // §10.1/P0.3 zombie defense: mint a FRESH runner token BEFORE the server binds
  // it (below), so a runner child that outlived a previous app process holds a
  // token that no longer authenticates — its next MCP call 401s at once. The
  // boot-sweep of stale runner/*.mcp.json + the kill-on-boot land at FP-3.
  const runnerToken = keychain.rotateRunnerToken()
  // P0.2: ONE durable call/spend guard (reads runner_runs, so it survives
  // resume) threaded into every tool's ToolContext as spendMeter. The live
  // read-path consumer (taskId 'live:<sessionId>', RUNNER_LIVE_SESSION_MAX_CALLS)
  // is wired when getContext is refactored at FP-1; here we only supply the dep.
  const callBudget = new CallBudget({ db: appData.db })
  const server = new AgenticOsMcpServer({
    bearerToken: keychain.ensureMcpBearerToken(),
    runnerToken,
    engine,
    retriever,
    retrieval: retrievalDeps,
    llm: ollama,
    // Phase-16b: the router backs ingest_codebase's README → Project summary
    // (ingest.projectSummary, local-by-default ⇒ identical to `llm`).
    ...(providerRouter !== null ? { router: providerRouter } : {}),
    db: appData.db,
    executor: kernelInstances.kernel,
    spendMeter: callBudget,
    // §13 (phase 09): ingest tools scan for embedded instructions and their
    // lane jobs record audited reversible deltas.
    ...(securityInstances !== null
      ? { scanner: securityInstances.scanner, audit: securityInstances.audit }
      : {})
  })
  try {
    await server.start()
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code === 'EADDRINUSE') {
      bootErrors.set('mcp', `port ${MCP_PORT} already in use (another ${PRODUCT_NAME} instance?) — MCP server disabled`)
      console.error(
        `[mcp] port ${MCP_PORT} is already in use (another ${PRODUCT_NAME} instance?) — MCP server disabled this launch`
      )
      return
    }
    throw err
  }
  mcpServer = server
  mcpClientManager = new McpClientManager({
    configPath: join(userDataDir, MCP_SERVERS_CONFIG_FILENAME),
    secrets: (name) => keychain?.getSecret(name)
  })

  // Connection helper (§12). The sample + the printed command carry the
  // <token> placeholder — the real token stays in the keychain (§21 rule 7)
  // and is surfaced by the dashboard (phase 10). Dev escape hatch: set
  // AGENTIC_OS_PRINT_MCP_TOKEN=1 to print the runnable command.
  const samplePath = join(userDataDir, '.mcp.json')
  writeSampleMcpJson(samplePath)
  console.log(`[mcp] server listening at ${server.url} (bearer auth, 7 tools, call log → mcp_calls)`)
  console.log(`[mcp] connect Claude Code with:\n[mcp]   ${claudeMcpAddCommand()}`)
  console.log(`[mcp] sample .mcp.json written to ${samplePath} (replace <token> with the keychain token)`)
  if (process.env['AGENTIC_OS_PRINT_MCP_TOKEN'] === '1') {
    console.log(`[mcp] dev: ${claudeMcpAddCommand(keychain.ensureMcpBearerToken())}`)
  }
}

/**
 * Phase-08 agents boot: the extraction agent's workflow registers on the
 * kernel runner; the phase-11 session-end triggers (hook endpoint + spool +
 * inactivity fallback) drive `runExtraction(sessionId)`. The cloud tier
 * (escalation + independent verification) activates only when the active
 * provider has an API key in the keychain — without one, low-confidence
 * extractions stage for human review instead.
 */
function bootAgents(): void {
  if (appData === null || engine === null || kernelInstances === null || ollama === null) {
    console.warn('[agents] storage/models/kernel unavailable — extraction agent disabled this launch')
    return
  }
  const settings = loadModelSettings(settingsPath(app.getPath('userData')))
  const apiKey = keychain?.getApiKey(settings.cloudProvider)
  const cloud = apiKey
    ? {
        brain: createCloudBrain(settings.cloudProvider, {
          apiKey,
          model: activeCloudModel(settings),
          // Phase-13 test seam: the golden-path e2e fronts the cloud tier
          // with a scripted provider server (adapters accepted baseUrl since
          // phase 02; this only wires it through boot). Unset in production.
          ...(CLOUD_BASE_URL_OVERRIDE !== undefined ? { baseUrl: CLOUD_BASE_URL_OVERRIDE } : {})
        }),
        meter: new SpendMeter({ db: appData.db })
      }
    : null
  extractionAgent = createExtractionAgent({
    engine,
    db: appData.db,
    runner: kernelInstances.runner,
    embedder: ollama,
    llm: ollama,
    cloud,
    // Phase-18: the §11.4 provider router owns the 3 extraction roles' backend
    // resolution per run (extraction.fuzzy decides two-tier vs the subscription
    // single tier; extraction.tiebreak; extraction.verify) and WINS over
    // llm/cloud when present. A keyless, runner-off default resolves every role to
    // its today tier ⇒ DEFAULT == TODAY (two-tier local + cloud escalation,
    // byte-identical). Mirrors the skill-improvement agent below. types.ts: "Only
    // boot injects it" — this is that injection.
    ...(providerRouter !== null ? { router: providerRouter } : {}),
    // §13 (phase 09): the write step's lane job records a reversible delta.
    ...(securityInstances !== null ? { audit: securityInstances.audit } : {}),
    // Phase-19 (§8 Phase 5): agent-mode spawn deps — present ONLY when the runner
    // booted AND the MCP server is up (the child connects back to it). SHIPS OFF:
    // the handler routes here only when runner.enabled + mode 'agent' (default
    // disabled + completion), so a default install never spawns a runner child.
    // The token getter reads the CURRENT keychain runner token (rotated per boot).
    ...(subscriptionRunner !== null && mcpServer !== null && keychain !== null
      ? {
          agentMode: {
            runner: subscriptionRunner,
            runnerToken: () => keychain?.getSecret(RUNNER_TOKEN_SECRET) ?? null,
            server: mcpServer,
            mcpUrl: mcpServer.url
          }
        }
      : {})
  })
  console.log(
    `[agents] extraction agent ready — the phase-11 session-end triggers drive it (cloud tier: ${
      cloud ? settings.cloudProvider : 'not configured — low-confidence extractions stage for review'
    })`
  )
  // Phase 12: the skill-improvement agent (§17 #4). Every version flip is an
  // audited reversible delta, so the audit log is a hard dependency.
  if (securityInstances !== null) {
    skillImprovementAgent = createSkillImprovementAgent({
      engine,
      db: appData.db,
      runner: kernelInstances.runner,
      embedder: ollama,
      llm: ollama,
      cloud,
      // Phase-16b: the router wins when present (cloud roles route through it
      // with the same §14 $0.50 ceiling; a keyless default resolves them local
      // ⇒ skipped exactly as today). Extraction is now wired the same way (phase-18).
      ...(providerRouter !== null ? { router: providerRouter } : {}),
      audit: securityInstances.audit
    })
    console.log(
      `[agents] skill-improvement agent ready — 02:00 slot + "improve now" drive it (cloud tier: ${
        cloud ? settings.cloudProvider : 'not configured — gated skills wait for an API key'
      })`
    )
  } else {
    console.warn('[agents] audit log unavailable — skill-improvement agent disabled this launch')
  }
}

/**
 * Phase-11 triggers boot: the system becomes autonomous. Durable queue over
 * the §8 tasks mirror, §20 schedules, the §6 session-end chain (hook endpoint
 * on the MCP server + spool drain + inactivity fallback → the phase-08
 * extraction agent), watched-folder chokidar ingestion, and user rules
 * (§17 #5) registered as §13 agents with no standing grants — their actions
 * run in the phase-09 sandbox lanes only.
 */
async function bootTriggers(): Promise<void> {
  if (appData === null || kernelInstances === null || securityInstances === null) {
    console.warn('[triggers] storage/kernel unavailable — triggers disabled this launch')
    return
  }
  const userDataDir = app.getPath('userData')
  const paths = appDataPaths(userDataDir)
  const queue = new DurableTaskQueue({
    db: appData.db,
    // §8: live INTERACTIVE MCP work is prioritized; background dispatch yields
    // (capped). §14b gauge split: a runner's own MCP calls don't count, so its
    // background task never blocks itself.
    shouldYield: () => (mcpServer?.inflightInteractiveCalls ?? 0) > 0
  })

  if (extractionAgent !== null) {
    // Phase-19 (§8 Phase 5): agent-mode routing. Present ONLY when the runner +
    // MCP server booted; the routing itself checks runner.enabled + healthy +
    // mode 'agent' LIVE per session (default disabled + completion ⇒ today's
    // path). P1.6: the transcript is scanned with the regex-only scanner
    // (free/offline) and a flagged transcript downgrades to completion mode.
    const runnerInjectionScanner = createInjectionScanner({ db: appData.db })
    const scanTranscript = async (transcriptPath: string, taskId: string): Promise<boolean> => {
      let text: string
      try {
        text = parseTranscriptFile(transcriptPath).text
      } catch {
        return false // no readable transcript → nothing to scan
      }
      if (text.trim() === '') return false
      const res = await runnerInjectionScanner.scan(untrusted(text), `runner:${taskId}`)
      return res.flagged
    }
    registerExtractionHandler(queue, {
      agent: extractionAgent,
      runner: kernelInstances.runner,
      ...(subscriptionRunner !== null && mcpServer !== null
        ? {
            agentMode: {
              loadSettings: () => loadModelSettings(settingsPath(userDataDir)),
              runner: subscriptionRunner,
              scanTranscript
            }
          }
        : {})
    })
  } else {
    console.warn('[triggers] extraction agent unavailable — session-end tasks will defer to a later launch')
  }
  if (skillImprovementAgent !== null) {
    registerSkillImprovementHandler(queue, { agent: skillImprovementAgent, runner: kernelInstances.runner })
  } else {
    console.warn('[triggers] skill-improvement agent unavailable — 02:00 slot tasks will defer to a later launch')
  }
  const folderStore = new WatchedFolderStore({ configPath: join(userDataDir, WATCHED_FOLDERS_CONFIG_FILENAME) })
  if (engine !== null) {
    registerMaintenanceHandlers(queue, { engine, audit: securityInstances.audit, exportsDir: paths.exportsDir })
    if (ollama !== null) {
      registerIngestHandlers(queue, {
        knowledge: {
          engine,
          embedder: ollama,
          scanner: securityInstances.scanner,
          audit: { log: securityInstances.audit, agentId: 'system' }
        },
        folderStore,
        kernel: kernelInstances.kernel
      })
    }
  }

  // User rules (§17 shape, ~/.agentic-os/rules/*.rule.json) → §13 agents.
  const rules = loadRules(RULES_DIR)
  registerRuleAgents(securityInstances.permissions, rules.rules)
  for (const failure of rules.errors) {
    console.warn(`[triggers] invalid rule ${failure.file}: ${failure.error}`)
  }
  const docker = await detectDocker()
  registerRuleActionHandler(queue, {
    kernel: kernelInstances.kernel,
    rules: () => new Map(rules.rules.map((rule) => [rule.id, rule])),
    denoLane: new DenoLane({ binDir: join(userDataDir, 'bin') }),
    dockerLane: docker.available ? new DockerLane() : null
  })

  // §6 tier 1: the hook endpoint (same HTTP server, dedicated token). While
  // the app is down the hook script spools; drain that spool BEFORE start()
  // so the reload pass picks the tasks up in one go.
  if (mcpServer !== null && keychain !== null) {
    mcpServer.setSessionEndHook({
      token: keychain.ensureSessionEndHookToken(),
      handle: createSessionEndHookHandler(queue)
    })
    // Dev/e2e escape hatch, mirror of AGENTIC_OS_PRINT_MCP_TOKEN (phase-13
    // test seam, recorded): the golden-path e2e POSTs the session-end hook
    // itself, so it needs the dedicated hook token. Never printed by default.
    if (process.env['AGENTIC_OS_PRINT_HOOK_TOKEN'] === '1') {
      console.log(`[triggers] dev: session-end hook token: ${keychain.ensureSessionEndHookToken()}`)
    }
  }
  const spool = drainSessionSpool(queue, SPOOL_DIR)

  const { reloaded } = queue.start()
  const schedules = new TriggerSchedules({ queue })
  schedules.start()
  // §6 tier 2: the 30-min mcp_calls inactivity fallback (any client).
  const inactivity = new InactivityMonitor({ db: appData.db, queue })
  inactivity.start()
  const watchers = new TriggerWatchers({
    queue,
    kernel: kernelInstances.kernel,
    rules: rules.rules,
    folderStore,
    stateFile: join(userDataDir, TRIGGER_STATE_FILENAME)
  })
  await watchers.start()
  triggerInstances = { queue, schedules, watchers, inactivity, rules }

  const status = watchers.status()
  console.log(
    `[triggers] durable queue ready — ${reloaded} task(s) reloaded, spool drained (${spool.enqueued} new, ${spool.deduped} dup, ${spool.malformed} bad); schedules armed (skill 02:00, prune 03:00, export Sun 03:30)`
  )
  console.log(
    `[triggers] session-end: hook endpoint ${mcpServer !== null ? `armed at ${HOOK_SESSION_END_URL}` : 'NOT armed (MCP server down — spool only)'}; inactivity fallback 30 min; watchers: ${status.folders.length} folder(s), ${rules.rules.length} rule(s)${rules.errors.length > 0 ? ` (${rules.errors.length} invalid — see warnings)` : ''}`
  )
}

/**
 * Phase-10 dashboard boot: register the typed IPC handlers over whatever
 * singletons this launch produced (§21 rule 8). Missing subsystems surface
 * as structured UNAVAILABLE errors in the panels, never as blank screens.
 */
function bootIpc(): void {
  const userDataDir = app.getPath('userData')
  if (reranker === null && appData !== null && engine !== null && ollama !== null) {
    // MCP boot was skipped (e.g. port in use) — memory search still needs
    // the ONE shared reranker instance.
    reranker = new Reranker({ modelsDir: appDataPaths(userDataDir).modelsDir, ...rerankerFilesOverride() })
  }
  const triggers =
    triggerInstances !== null
      ? {
          queue: triggerInstances.queue,
          schedules: triggerInstances.schedules,
          watchers: triggerInstances.watchers,
          ruleErrors: triggerInstances.rules.errors
        }
      : null
  const subsystems = {
    storage: engine !== null && appData !== null,
    models: ollama !== null,
    kernel: kernelInstances !== null,
    mcp: mcpServer !== null,
    agents: extractionAgent !== null
  }
  const diagnostics = currentBootDiagnostics()
  registerIpcHandlers({
    engine,
    db: appData?.db ?? null,
    permissions: securityInstances?.permissions ?? null,
    audit: securityInstances?.audit ?? null,
    scanner: securityInstances?.scanner ?? null,
    ollama,
    reranker,
    keychain,
    mcpUrl: mcpServer?.url ?? null,
    triggers,
    // Phase-17: the subscription runner backs runner.status / runner.testConnection.
    runner: subscriptionRunner,
    // Phase-21: the live router fills runner.status's effectiveBackend — where a
    // subscription-eligible role lands while the runner is falling back.
    router: providerRouter,
    // Settings "Updates" section: the auto-updater controller backs
    // updater.status / updater.check / updater.install. Built just before this in
    // whenReady; null in dev where it reports the disabled snapshot.
    updater: updaterController,
    userDataDir,
    // Phase-16b (P1.1): the settings mutators (save / setApiKey / clearApiKey)
    // fire this after a successful change so boot drops the router's cached
    // snapshot — provider/model/key changes take effect on the NEXT reasoning
    // call with no app restart.
    onSettingsChanged: () => providerRouter?.invalidate(),
    subsystems,
    diagnostics
  })
  // §4 read tools ride the SAME shared read functions as the IPC handlers above;
  // supply their late-bound deps now — the last boot step, where every singleton
  // exists and `subsystems` is accurate. Additive: a default install is
  // unchanged, the read tools are simply newly available over MCP.
  if (mcpServer !== null) {
    mcpServer.setReadContext({
      ...(securityInstances !== null ? { permissions: securityInstances.permissions } : {}),
      ...(kernelInstances !== null ? { runner: kernelInstances.runner } : {}),
      // Phase-17: get_runner_status reads this health source (distinct from the
      // workflow `runner` above).
      ...(subscriptionRunner !== null ? { runnerStatus: subscriptionRunner } : {}),
      triggers,
      watchedFolders: new WatchedFolderStore({ configPath: join(userDataDir, WATCHED_FOLDERS_CONFIG_FILENAME) }),
      // Phase-18: the §8 queue backs the staged-write + control tools
      // (run_extraction / improve_skill_now / run_maintenance / retry_task /
      // propose_skill_revision / submit_extraction_items). Absent ⇒ those tools
      // return a clean INVALID_STATE (triggers did not boot this launch).
      ...(triggerInstances !== null ? { queue: triggerInstances.queue } : {}),
      ollama,
      keychain,
      appStatus: {
        version: app.getVersion(),
        platform: process.platform,
        userDataDir,
        subsystems,
        mcpUrl: mcpServer.url,
        diagnostics
      }
    })
  }
  console.log('[ipc] dashboard IPC ready (typed contract, structured errors)')
}

/**
 * GLOBAL window-chrome handlers for the frameless title bar. Registered exactly
 * once (in whenReady, before createWindow) so macOS 'activate' re-creating the
 * window never double-registers the ipcMain.handle channel. Each resolves the
 * target window from the sender, so a re-created window still gets its controls.
 * fromWebContents returns null for a destroyed sender — the optional chaining /
 * null check keeps strict TS green and is a no-op in that race.
 */
function registerWindowControlIpc(): void {
  ipcMain.on(IPC_WINDOW_MINIMIZE, (event) => {
    BrowserWindow.fromWebContents(event.sender)?.minimize()
  })
  ipcMain.on(IPC_WINDOW_TOGGLE_MAXIMIZE, (event) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    if (win === null) return
    if (win.isMaximized()) win.unmaximize()
    else win.maximize()
  })
  ipcMain.on(IPC_WINDOW_CLOSE, (event) => {
    BrowserWindow.fromWebContents(event.sender)?.close()
  })
  ipcMain.handle(IPC_WINDOW_IS_MAXIMIZED, (event) => BrowserWindow.fromWebContents(event.sender)?.isMaximized() ?? false)
}

function createWindow(): void {
  // Runtime window/taskbar icon. Packaged: process.resourcesPath/icon.png
  // (electron-builder extraResources). Dev: build/icon.png at the repo root.
  // Guarded so a missing file never throws. On packaged Windows the taskbar
  // uses the EXE-embedded build/icon.ico; this mainly covers dev + Linux.
  const iconCandidate = app.isPackaged
    ? join(process.resourcesPath, 'icon.png')
    : join(app.getAppPath(), 'build', 'icon.png')
  const win = new BrowserWindow({
    width: 1200,
    height: 800,
    ...(existsSync(iconCandidate) ? { icon: iconCandidate } : {}),
    // The cockpit's dense tables need a floor; below this the master-detail
    // grids crush (audit finding, phase 10).
    minWidth: 960,
    minHeight: 600,
    title: PRODUCT_NAME,
    // Frameless custom chrome (renderer TitleBar). 'hidden' (NOT frame:false)
    // drops the native caption while keeping Windows resize borders + snap.
    titleBarStyle: 'hidden',
    // macOS keeps native traffic lights — nudge them to center in the 36px bar.
    ...(process.platform === 'darwin' ? { trafficLightPosition: { x: 12, y: 10 } } : {}),
    webPreferences: {
      preload: join(import.meta.dirname, '../preload/index.mjs'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  // Push maximize-state changes so the TitleBar can swap its maximize/restore
  // icon. Guarded against a destroyed window (teardown race).
  const sendMaximizeState = (state: boolean): void => {
    if (!win.isDestroyed()) win.webContents.send(IPC_EVENT_WINDOW_MAXIMIZE, state)
  }
  win.on('maximize', () => sendMaximizeState(true))
  win.on('unmaximize', () => sendMaximizeState(false))

  win.webContents.setWindowOpenHandler((details) => {
    void shell.openExternal(details.url)
    return { action: 'deny' }
  })

  if (process.env['ELECTRON_RENDERER_URL']) {
    void win.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    void win.loadFile(join(import.meta.dirname, '../renderer/index.html'))
  }
}

void app.whenReady().then(async () => {
  console.log(`[boot] ${PRODUCT_NAME} main process starting (MCP reserved at ${MCP_HOST}:${MCP_PORT})`)
  // Second half of the linux CI keystore seam (see the top-of-file switch):
  // headless runners have no keyring, and the password-store switch alone
  // does not make safeStorage report available — Electron's sanctioned
  // escape hatch is the explicit plaintext opt-in. Never set in production.
  if (process.platform === 'linux' && process.env['AGENTIC_OS_LINUX_PASSWORD_STORE'] === 'basic') {
    safeStorage.setUsePlainTextEncryption(true)
    console.log('[models] AGENTIC_OS_LINUX_PASSWORD_STORE=basic — safeStorage plaintext opt-in (test seam)')
  }
  try {
    logNativeModuleVersions()
  } catch (err) {
    recordBootError('native', err)
    console.error('[native] native-module load FAILED', err)
  }
  try {
    await bootStorage()
  } catch (err) {
    recordBootError('storage', err)
    console.error('[storage] storage boot FAILED', err)
  }
  try {
    await bootModels()
  } catch (err) {
    recordBootError('models', err)
    console.error('[models] model-layer boot FAILED', err)
  }
  try {
    bootKernel()
  } catch (err) {
    recordBootError('kernel', err)
    console.error('[kernel] kernel boot FAILED', err)
  }
  try {
    await bootMcp()
  } catch (err) {
    recordBootError('mcp', err)
    console.error('[mcp] MCP boot FAILED', err)
  }
  try {
    bootAgents()
  } catch (err) {
    recordBootError('agents', err)
    console.error('[agents] agents boot FAILED', err)
  }
  try {
    await bootTriggers()
  } catch (err) {
    recordBootError('triggers', err)
    console.error('[triggers] triggers boot FAILED', err)
  }
  // Phase 13: background auto-update (log-only; no-op in dev builds). An
  // installed update runs migrations WITH the pre-migration backup at its
  // first boot (§3/§21.9 — proven by scripts/smoke/packaged-smoke.mjs). Built
  // BEFORE bootIpc so the updater.* channels read its snapshot; onStatusChange
  // is forwarded to the window(s) for the Settings "Updates" section (mirrors
  // how ingest/ollama progress is pushed). bootUpdater never throws — the guard
  // is belt-and-braces. Pushes before a window exists are simply dropped; the
  // renderer seeds itself from updater.status on mount, then rides the pushes.
  try {
    updaterController = bootUpdater()
    updaterController.onStatusChange((status) => {
      for (const win of BrowserWindow.getAllWindows()) {
        if (!win.isDestroyed()) win.webContents.send(IPC_EVENT_UPDATER_STATUS, status)
      }
    })
  } catch (err) {
    console.error('[updater] updater boot FAILED', err)
  }
  try {
    bootIpc()
  } catch (err) {
    console.error('[ipc] dashboard IPC boot FAILED', err)
  }

  // Auto-backup scheduler (Settings "Data & backups"). Independent of storage —
  // it only stages markers over userData fs, so it runs even when the store is
  // down (the next healthy boot performs the staged backup).
  try {
    startBackupScheduler(app.getPath('userData'))
  } catch (err) {
    console.error('[backups] scheduler start FAILED', err)
  }

  registerWindowControlIpc()
  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

// Quit path: checkpoint + close connections, but keep the Database handle —
// ryugraph 25.9.1 segfaults during native teardown after Database.close(),
// which would turn every clean exit into a crash. WAL replay covers the rest.
let quitting = false
app.on('will-quit', (event) => {
  if (quitting) return
  quitting = true
  event.preventDefault()
  if (backupSchedulerTimer !== null) {
    clearInterval(backupSchedulerTimer)
    backupSchedulerTimer = null
  }
  // Phase-17/P0.4: kill any in-flight runner child tree FIRST — before the MCP
  // server and the queue tear down — so a live `claude` child is never stranded,
  // and the queue's "task stays running, re-runs next boot" invariant stays
  // clean. Guarded + synchronous; a default install has no children to kill.
  subscriptionRunner?.killChildren()
  subscriptionRunner = null
  // MCP next: closeAllConnections() severs sockets synchronously, so no new
  // tool call can reach appdata.db after this line; the rest of stop() (SDK
  // session teardown) finishes in the background.
  void mcpServer?.stop().catch(() => undefined)
  mcpServer = null
  mcpClientManager = null
  // Triggers next (phase 11): schedules/watchers/inactivity stop taking new
  // work synchronously; the queue's in-flight task gets a bounded grace
  // window before the db handle closes — a task cut off here stays 'running'
  // in the mirror and the next launch re-runs it (handlers are idempotent).
  const triggers = triggerInstances
  triggerInstances = null
  triggers?.inactivity.stop()
  triggers?.schedules.stop()
  const stopping = Promise.all([
    triggers?.queue.stop() ?? Promise.resolve(),
    triggers?.watchers.stop().catch(() => undefined) ?? Promise.resolve()
  ])
  void stopping
    .then(() => {
      // Telemetry flushes synchronously (SimpleSpanProcessor + better-sqlite3);
      // shutdown just stops accepting spans before the db handle closes.
      void telemetry?.shutdown().catch(() => undefined)
      telemetry = null
      extractionAgent = null
      skillImprovementAgent = null
      providerRouter = null
      kernelInstances = null
      securityInstances = null
      appData?.close()
      appData = null
      const closing = engine
      engine = null
      return closing?.close({ skipDatabaseClose: true }).catch((err) => console.error('[storage] close failed', err))
    })
    .finally(() => app.exit(0))
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
