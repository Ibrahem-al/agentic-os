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
import { CLOUD_DEFAULT_MODELS, CLOUD_PROVIDER_DEFAULT, CLOUD_PROVIDERS, type CloudProvider } from '../config'

export interface ModelSettings {
  /** Which cloud brain background agents use. */
  cloudProvider: CloudProvider
  /** Per-provider model override; missing entries fall back to CLOUD_DEFAULT_MODELS. */
  cloudModels: Partial<Record<CloudProvider, string>>
  /** Small local LLM override (§20: qwen3:4b default, user-swappable). */
  smallLlmModel?: string
}

export const SETTINGS_FILENAME = 'settings.json'

export function settingsPath(userDataDir: string): string {
  return join(userDataDir, SETTINGS_FILENAME)
}

export function defaultModelSettings(): ModelSettings {
  return { cloudProvider: CLOUD_PROVIDER_DEFAULT, cloudModels: {} }
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
  return settings
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
