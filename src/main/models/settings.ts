/**
 * Model settings — the non-secret side of the cloud tier (§4: "Active
 * provider in settings"). Plain JSON at userData/settings.json; API keys
 * NEVER live here (keychain only, §21 rule 7).
 *
 * Kept deliberately small: phase 10's settings UI reads/writes this file
 * through these helpers; later phases may add sections.
 */
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { CLOUD_DEFAULT_MODELS, CLOUD_PROVIDER_DEFAULT, CLOUD_PROVIDERS, RUNNER_MODEL_DEFAULT, type CloudProvider } from '../config'
// TYPE-ONLY (phase 16): provider.ts type-imports ModelSettings back from here,
// so both directions are erased at compile time — a pure type cycle, never a
// runtime one (the router owns the resolution values; settings only shapes them).
import type { ReasoningBackend, RoleKey } from './provider'

/**
 * The phase-16 reasoning-role routing preference (§2.1/§11.4). Absent on a
 * default install (DEFAULT == TODAY); materialized only when the user opts in.
 * `backend` is the GLOBAL toggle — only `'subscription-claude'` moves the
 * subscription-eligible roles; the HARD-local roles never follow it (the router
 * enforces §11.4). `overrides`/`models` are per-role escape hatches.
 */
export interface ReasoningSettings {
  backend: ReasoningBackend
  overrides?: Partial<Record<RoleKey, ReasoningBackend>>
  models?: Partial<Record<RoleKey, string>>
  /**
   * Stage-2 sensitive-egress consent (extends the §10.7 egress-consent pattern).
   * Absent/false = today (DEFAULT == TODAY): the §11.4 HARD-local roles stay
   * local under every backend setting. Set true only via the settings panel's
   * consent modal; the router (provider.ts) then lets a HARD-local role follow a
   * non-local global backend or explicit override off this computer.
   */
  allowSensitiveNonLocal?: boolean
}

/**
 * The phase-16 headless-runner / subscription-reasoner settings. Absent on a
 * default install; `enabled` is the master switch and defaults false, so a
 * fresh install never spawns a runner and the subscription backend stays
 * unavailable. The rest are the phase-doc defaults, filled by loadModelSettings
 * whenever a `runner` section is present at all.
 */
export interface RunnerSettings {
  enabled: boolean
  model: string
  stageAll: boolean
  mode: 'completion' | 'agent'
  injectionPolicy: 'downgrade' | 'proceed'
  verifierModel?: string
  binaryPath?: string
}

/**
 * Network exposure. Absent on a default install (DEFAULT == TODAY = the MCP
 * server binds 127.0.0.1, localhost-only, per spec §21.7). `lanAccess` is an
 * explicit, consented departure: when true, boot binds the server to 0.0.0.0
 * so another device on the same network (e.g. the user's phone) can connect,
 * with the bearer token as the sole auth over the LAN. Recorded §21-rule-12
 * deviation from "never a networked service".
 */
export interface NetworkSettings {
  lanAccess: boolean
}

export interface ModelSettings {
  /** Which cloud brain background agents use. */
  cloudProvider: CloudProvider
  /** Per-provider model override; missing entries fall back to CLOUD_DEFAULT_MODELS. */
  cloudModels: Partial<Record<CloudProvider, string>>
  /** Small local LLM override (§20: qwen3:4b default, user-swappable). */
  smallLlmModel?: string
  /** Phase-16 role routing (§2.1/§11.4); absent = today's per-role tiers. */
  reasoning?: ReasoningSettings
  /** Phase-16 runner / subscription reasoner; absent = disabled (today). */
  runner?: RunnerSettings
  /** Network exposure; absent = localhost-only (today). */
  network?: NetworkSettings
}

/** The three reasoning backends, as a runtime set for validation. Mirrors
 * provider.ts's ReasoningBackend union (kept local so this module never
 * runtime-imports provider.ts — see the type-only import note above). */
const REASONING_BACKENDS = ['local-qwen3', 'cloud-api', 'subscription-claude'] as const satisfies readonly ReasoningBackend[]
const RUNNER_MODES = ['completion', 'agent'] as const satisfies readonly RunnerSettings['mode'][]
const INJECTION_POLICIES = ['downgrade', 'proceed'] as const satisfies readonly RunnerSettings['injectionPolicy'][]

export const SETTINGS_FILENAME = 'settings.json'

export function settingsPath(userDataDir: string): string {
  return join(userDataDir, SETTINGS_FILENAME)
}

/**
 * A default install's settings (§4). DELIBERATELY today-shaped: `reasoning` and
 * `runner` are ABSENT, not materialized — the prime directive is DEFAULT ==
 * TODAY, so a fresh settings.json must be byte-identical to before phase-16 and
 * the router must read "no reasoning config → today's per-role tiers". The two
 * sections appear only when the user opts in (phase-16b's settings.save merges a
 * patch that sets them); their defaults live in the factories below and are
 * filled by loadModelSettings whenever a partial section is present on disk.
 */
export function defaultModelSettings(): ModelSettings {
  return { cloudProvider: CLOUD_PROVIDER_DEFAULT, cloudModels: {} }
}

/** The default reasoning section (global backend local-qwen3, no overrides). */
export function defaultReasoningSettings(): ReasoningSettings {
  return { backend: 'local-qwen3' }
}

/** The default runner section — disabled, phase-doc field defaults. */
export function defaultRunnerSettings(): RunnerSettings {
  return { enabled: false, model: RUNNER_MODEL_DEFAULT, stageAll: true, mode: 'completion', injectionPolicy: 'downgrade' }
}

/** The default network section — localhost-only (the secure default). */
export function defaultNetworkSettings(): NetworkSettings {
  return { lanAccess: false }
}

/** The model the active provider should use (override or provider default). */
export function activeCloudModel(settings: ModelSettings): string {
  return settings.cloudModels[settings.cloudProvider] ?? CLOUD_DEFAULT_MODELS[settings.cloudProvider]
}

/** Load settings; a missing file yields defaults, a malformed one throws. */
export function loadModelSettings(filePath: string): ModelSettings {
  let raw: string
  try {
    raw = readFileSync(filePath, 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return defaultModelSettings()
    throw err
  }
  const parsed: unknown = JSON.parse(raw)
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${filePath} is not a JSON object`)
  }
  const candidate = parsed as Partial<ModelSettings>
  const settings = defaultModelSettings()
  if (candidate.cloudProvider !== undefined) {
    if (!CLOUD_PROVIDERS.includes(candidate.cloudProvider)) {
      throw new Error(`${filePath}: unknown cloudProvider '${String(candidate.cloudProvider)}' (expected ${CLOUD_PROVIDERS.join('/')})`)
    }
    settings.cloudProvider = candidate.cloudProvider
  }
  if (candidate.cloudModels !== undefined) {
    if (candidate.cloudModels === null || typeof candidate.cloudModels !== 'object' || Array.isArray(candidate.cloudModels)) {
      throw new Error(`${filePath}: cloudModels must be an object`)
    }
    for (const [provider, model] of Object.entries(candidate.cloudModels)) {
      if (!CLOUD_PROVIDERS.includes(provider as CloudProvider) || typeof model !== 'string') {
        throw new Error(`${filePath}: cloudModels has invalid entry '${provider}'`)
      }
    }
    settings.cloudModels = { ...candidate.cloudModels }
  }
  if (candidate.smallLlmModel !== undefined) {
    if (typeof candidate.smallLlmModel !== 'string') throw new Error(`${filePath}: smallLlmModel must be a string`)
    settings.smallLlmModel = candidate.smallLlmModel
  }
  // Phase-16 sections: validated + normalized (defaults filled) only when a
  // section is present on disk. Absent → stays absent → the router reads today.
  if (candidate.reasoning !== undefined) settings.reasoning = parseReasoning(candidate.reasoning, filePath)
  if (candidate.runner !== undefined) settings.runner = parseRunner(candidate.runner, filePath)
  if (candidate.network !== undefined) settings.network = parseNetwork(candidate.network, filePath)
  return settings
}

/** Validate + normalize a `network` section (defaults filled). */
function parseNetwork(value: unknown, filePath: string): NetworkSettings {
  if (!isPlainObject(value)) throw new Error(`${filePath}: network must be an object`)
  const result = defaultNetworkSettings()
  const lanAccess = value['lanAccess']
  if (lanAccess !== undefined) {
    if (typeof lanAccess !== 'boolean') throw new Error(`${filePath}: network.lanAccess must be a boolean`)
    result.lanAccess = lanAccess
  }
  return result
}

/** Atomic write (tmp + rename), matching the keychain's crash discipline. */
export function saveModelSettings(filePath: string, settings: ModelSettings): void {
  mkdirSync(dirname(filePath), { recursive: true })
  const tmpPath = `${filePath}.tmp`
  try {
    writeFileSync(tmpPath, `${JSON.stringify(settings, null, 2)}\n`, 'utf8')
    renameSync(tmpPath, filePath)
  } catch (err) {
    rmSync(tmpPath, { force: true })
    throw err
  }
}

// ── phase-16 section validators ──────────────────────────────────────────────

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/**
 * Validate + normalize a `reasoning` section (defaults filled). Backend values
 * are checked against REASONING_BACKENDS; override/model KEYS are accepted as-is
 * (loose — strict role-name validation + the HARD-override warnings land in
 * phase-20, and the router only ever reads the known §2.2 roles anyway).
 */
function parseReasoning(value: unknown, filePath: string): ReasoningSettings {
  if (!isPlainObject(value)) throw new Error(`${filePath}: reasoning must be an object`)
  const result = defaultReasoningSettings()
  const backend = value['backend']
  if (backend !== undefined) {
    if (!(REASONING_BACKENDS as readonly string[]).includes(backend as string)) {
      throw new Error(`${filePath}: reasoning.backend '${String(backend)}' must be one of ${REASONING_BACKENDS.join('/')}`)
    }
    result.backend = backend as ReasoningBackend
  }
  const overrides = value['overrides']
  if (overrides !== undefined) {
    if (!isPlainObject(overrides)) throw new Error(`${filePath}: reasoning.overrides must be an object`)
    const parsed: Partial<Record<RoleKey, ReasoningBackend>> = {}
    for (const [role, backendValue] of Object.entries(overrides)) {
      if (!(REASONING_BACKENDS as readonly string[]).includes(backendValue as string)) {
        throw new Error(`${filePath}: reasoning.overrides['${role}'] '${String(backendValue)}' is not a valid backend`)
      }
      parsed[role as RoleKey] = backendValue as ReasoningBackend
    }
    result.overrides = parsed
  }
  const models = value['models']
  if (models !== undefined) {
    if (!isPlainObject(models)) throw new Error(`${filePath}: reasoning.models must be an object`)
    const parsed: Partial<Record<RoleKey, string>> = {}
    for (const [role, model] of Object.entries(models)) {
      if (typeof model !== 'string') throw new Error(`${filePath}: reasoning.models['${role}'] must be a string`)
      parsed[role as RoleKey] = model
    }
    result.models = parsed
  }
  // Stage-2 sensitive-egress consent. Only materialized when present on disk — a
  // section without it stays flag-free (DEFAULT == TODAY / consent absent).
  const allowSensitiveNonLocal = value['allowSensitiveNonLocal']
  if (allowSensitiveNonLocal !== undefined) {
    if (typeof allowSensitiveNonLocal !== 'boolean') {
      throw new Error(`${filePath}: reasoning.allowSensitiveNonLocal must be a boolean`)
    }
    result.allowSensitiveNonLocal = allowSensitiveNonLocal
  }
  return result
}

/** Validate + normalize a `runner` section (phase-doc defaults filled). */
function parseRunner(value: unknown, filePath: string): RunnerSettings {
  if (!isPlainObject(value)) throw new Error(`${filePath}: runner must be an object`)
  const result = defaultRunnerSettings()
  const enabled = value['enabled']
  if (enabled !== undefined) {
    if (typeof enabled !== 'boolean') throw new Error(`${filePath}: runner.enabled must be a boolean`)
    result.enabled = enabled
  }
  const model = value['model']
  if (model !== undefined) {
    if (typeof model !== 'string') throw new Error(`${filePath}: runner.model must be a string`)
    result.model = model
  }
  const stageAll = value['stageAll']
  if (stageAll !== undefined) {
    if (typeof stageAll !== 'boolean') throw new Error(`${filePath}: runner.stageAll must be a boolean`)
    result.stageAll = stageAll
  }
  const mode = value['mode']
  if (mode !== undefined) {
    if (!(RUNNER_MODES as readonly string[]).includes(mode as string)) {
      throw new Error(`${filePath}: runner.mode '${String(mode)}' must be one of ${RUNNER_MODES.join('/')}`)
    }
    result.mode = mode as RunnerSettings['mode']
  }
  const injectionPolicy = value['injectionPolicy']
  if (injectionPolicy !== undefined) {
    if (!(INJECTION_POLICIES as readonly string[]).includes(injectionPolicy as string)) {
      throw new Error(`${filePath}: runner.injectionPolicy '${String(injectionPolicy)}' must be one of ${INJECTION_POLICIES.join('/')}`)
    }
    result.injectionPolicy = injectionPolicy as RunnerSettings['injectionPolicy']
  }
  const verifierModel = value['verifierModel']
  if (verifierModel !== undefined) {
    if (typeof verifierModel !== 'string') throw new Error(`${filePath}: runner.verifierModel must be a string`)
    result.verifierModel = verifierModel
  }
  const binaryPath = value['binaryPath']
  if (binaryPath !== undefined) {
    if (typeof binaryPath !== 'string') throw new Error(`${filePath}: runner.binaryPath must be a string`)
    result.binaryPath = binaryPath
  }
  return result
}
