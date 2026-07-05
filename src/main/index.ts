import { app, BrowserWindow, safeStorage, shell } from 'electron'
import { join } from 'node:path'
import { createRequire } from 'node:module'
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
  SPOOL_DIR,
  TRIGGER_STATE_FILENAME,
  WATCHED_FOLDERS_CONFIG_FILENAME
} from './config'
import { openAppData, openRyuGraphEngine, type AppData } from './storage'
import {
  Keychain,
  keychainPath,
  loadModelSettings,
  OllamaClient,
  Reranker,
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
  type InjectionScanner
} from './security'
import { createRetriever } from './retrieval'
import { AgenticOsMcpServer, claudeMcpAddCommand, McpClientManager, writeSampleMcpJson } from './mcp'
import {
  createExtractionAgent,
  createSkillImprovementAgent,
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
import { bootUpdater } from './updater'

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
/** Trigger runtime (phase 11): queue + schedules + watchers + session-end. */
let triggerInstances: {
  queue: DurableTaskQueue
  schedules: TriggerSchedules
  watchers: TriggerWatchers
  inactivity: InactivityMonitor
  rules: RuleLoadResult
} | null = null

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
  const { readFileSync, existsSync } = require('node:fs') as typeof import('node:fs')
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

  const paths = appDataPaths(app.getPath('userData'))
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
  const paths = appDataPaths(app.getPath('userData'))
  const permissions = new PermissionEngine({ db: appData.db })
  registerInternalAgents(permissions)
  const audit = new AuditLog({
    db: appData.db,
    backupsDir: paths.backupsDir,
    ...(engine !== null ? { engine } : {})
  })
  const scanner = createInjectionScanner({ db: appData.db, ...(ollama !== null ? { llm: ollama } : {}) })
  securityInstances = { permissions, audit, scanner }
  const kernel = new Kernel({ telemetry, permissions, audit })
  // §8 phase-13: cooperative yield at step boundaries — a running multi-step
  // workflow defers to live MCP calls between steps (the queue's pre-dispatch
  // yield covers only task starts). The closure reads mcpServer at call time;
  // it is null until bootMcp() and that is fine (0 inflight = no wait).
  const runner = new LangGraphRunner({
    db: appData.db,
    telemetry,
    executor: kernel,
    yieldPoint: createInflightYield(() => mcpServer?.inflightCalls ?? 0)
  })
  const contextManager = new ContextManager({ llm: ollama ?? new OllamaClient(), telemetry })
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
  const retriever = createRetriever({ ...retrievalDeps, llm: ollama })
  const server = new AgenticOsMcpServer({
    bearerToken: keychain.ensureMcpBearerToken(),
    engine,
    retriever,
    retrieval: retrievalDeps,
    llm: ollama,
    db: appData.db,
    executor: kernelInstances.kernel,
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
    // §13 (phase 09): the write step's lane job records a reversible delta.
    ...(securityInstances !== null ? { audit: securityInstances.audit } : {})
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
    // §8: live MCP work is prioritized; background dispatch yields (capped).
    shouldYield: () => (mcpServer?.inflightCalls ?? 0) > 0
  })

  if (extractionAgent !== null) {
    registerExtractionHandler(queue, { agent: extractionAgent, runner: kernelInstances.runner })
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
    triggers:
      triggerInstances !== null
        ? {
            queue: triggerInstances.queue,
            schedules: triggerInstances.schedules,
            watchers: triggerInstances.watchers,
            ruleErrors: triggerInstances.rules.errors
          }
        : null,
    userDataDir,
    subsystems: {
      storage: engine !== null && appData !== null,
      models: ollama !== null,
      kernel: kernelInstances !== null,
      mcp: mcpServer !== null,
      agents: extractionAgent !== null
    }
  })
  console.log('[ipc] dashboard IPC ready (typed contract, structured errors)')
}

function createWindow(): void {
  const win = new BrowserWindow({
    width: 1200,
    height: 800,
    // The cockpit's dense tables need a floor; below this the master-detail
    // grids crush (audit finding, phase 10).
    minWidth: 960,
    minHeight: 600,
    title: PRODUCT_NAME,
    webPreferences: {
      preload: join(import.meta.dirname, '../preload/index.mjs'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false
    }
  })

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
    console.error('[native] native-module load FAILED', err)
  }
  try {
    await bootStorage()
  } catch (err) {
    console.error('[storage] storage boot FAILED', err)
  }
  try {
    await bootModels()
  } catch (err) {
    console.error('[models] model-layer boot FAILED', err)
  }
  try {
    bootKernel()
  } catch (err) {
    console.error('[kernel] kernel boot FAILED', err)
  }
  try {
    await bootMcp()
  } catch (err) {
    console.error('[mcp] MCP boot FAILED', err)
  }
  try {
    bootAgents()
  } catch (err) {
    console.error('[agents] agents boot FAILED', err)
  }
  try {
    await bootTriggers()
  } catch (err) {
    console.error('[triggers] triggers boot FAILED', err)
  }
  try {
    bootIpc()
  } catch (err) {
    console.error('[ipc] dashboard IPC boot FAILED', err)
  }
  // Phase 13: background auto-update (log-only; no-op in dev builds). An
  // installed update runs migrations WITH the pre-migration backup at its
  // first boot (§3/§21.9 — proven by scripts/smoke/packaged-smoke.mjs).
  bootUpdater()

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
  // MCP first: closeAllConnections() severs sockets synchronously, so no new
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
