/**
 * Status reads (§4.F) — the source for the `get_app_status` and
 * `get_settings_summary` MCP read tools.
 *
 *  - getAppStatus: the dashboard app-status fields plus live `ollama.status()`.
 *  - getSettingsSummary: SANITIZED — cloud provider, model names, and API-key
 *    PRESENCE booleans only. Key material NEVER crosses this boundary (§21
 *    rule 7). The phase-16 `reasoning`/`runner` sections are surfaced only once
 *    loadModelSettings returns them (additive — no rework here).
 */
import type { AppStatusDto, IpcCloudProvider, OllamaStatusDto } from '../../shared/ipc'
import { CLOUD_DEFAULT_MODELS, CLOUD_PROVIDERS } from '../config'
import { loadModelSettings, settingsPath, type Keychain, type OllamaClient } from '../models'
import { jsonObject } from './serialize'
import type { AppStatusFullDto, SettingsSummaryDto } from './types'

const OLLAMA_UNAVAILABLE: OllamaStatusDto = {
  state: 'daemon-not-running',
  installedModels: [],
  missingModels: [],
  installUrl: 'https://ollama.com/download'
}

export interface AppStatusDeps extends AppStatusDto {
  /** null when the model layer didn't boot this launch. */
  readonly ollama: Pick<OllamaClient, 'status'> | null
}

/** get_app_status: subsystems + mcpUrl + live Ollama health. */
export async function getAppStatus(deps: AppStatusDeps): Promise<AppStatusFullDto> {
  const status = deps.ollama !== null ? await deps.ollama.status() : OLLAMA_UNAVAILABLE
  return {
    version: deps.version,
    platform: deps.platform,
    userDataDir: deps.userDataDir,
    subsystems: deps.subsystems,
    mcpUrl: deps.mcpUrl,
    diagnostics: deps.diagnostics ?? [],
    ollama: {
      state: status.state,
      installedModels: status.installedModels,
      missingModels: status.missingModels,
      installUrl: status.installUrl
    }
  }
}

export interface SettingsSummaryDeps {
  readonly userDataDir: string
  /** null when the keychain didn't boot — every provider then reads "absent". */
  readonly keychain: Pick<Keychain, 'getApiKey'> | null
}

/** get_settings_summary: the sanitized model settings (presence booleans only). */
export function getSettingsSummary(deps: SettingsSummaryDeps): SettingsSummaryDto {
  const settings = loadModelSettings(settingsPath(deps.userDataDir))
  const apiKeysPresent = Object.fromEntries(
    CLOUD_PROVIDERS.map((provider) => [provider, deps.keychain?.getApiKey(provider) !== undefined])
  ) as Record<IpcCloudProvider, boolean>
  // phase-16 will add reasoning/runner to ModelSettings; surface them if present
  // (loadModelSettings drops unknown keys until then, so this is inert today).
  const extra = settings as unknown as { reasoning?: unknown; runner?: unknown; network?: unknown }
  return {
    cloudProvider: settings.cloudProvider,
    cloudModels: settings.cloudModels,
    smallLlmModel: settings.smallLlmModel ?? null,
    providers: CLOUD_PROVIDERS,
    defaultModels: CLOUD_DEFAULT_MODELS,
    apiKeysPresent,
    ...(extra.reasoning !== undefined ? { reasoning: jsonObject(extra.reasoning) } : {}),
    ...(extra.runner !== undefined ? { runner: jsonObject(extra.runner) } : {}),
    ...(extra.network !== undefined ? { network: jsonObject(extra.network) } : {})
  }
}
