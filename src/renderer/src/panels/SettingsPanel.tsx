/**
 * Settings panel (phase 10): cloud provider + model overrides, encrypted api
 * keys (presence only ever crosses the IPC boundary, spec §21 rule 7), local
 * Ollama model status/pulls, and the MCP connection details (§4, §14).
 */
import { useEffect, useRef, useState } from 'react'
import type {
  BackupSettingsDto,
  InstallHookResultDto,
  IpcCloudProvider,
  ModelSettingsPatchDto,
  OllamaPullProgressDto,
  RunnerSettingsDto,
  RunnerTestConnectionDto,
  SettingsDto,
  UpdaterStatusDto
} from '../../../shared/ipc'
import { call, IpcError, useIpc } from '../lib/ipc'
import {
  Badge,
  Button,
  ErrorState,
  LoadingRows,
  Modal,
  PanelHeader,
  SectionHeader,
  Select,
  TextInput,
  Timestamp,
  Toggle,
  useToast
} from '../ui/kit'

/**
 * Default runner section for a keyless install (mirrors main-side
 * defaultRunnerSettings / config.RUNNER_MODEL_DEFAULT). The `runner` section is
 * absent until the user opts in, so the first toggle/model change materializes
 * it from these defaults. OFF by default → nothing ever spawns claude.
 */
const RUNNER_DEFAULTS: RunnerSettingsDto = {
  enabled: false,
  model: 'sonnet',
  stageAll: true,
  mode: 'completion',
  injectionPolicy: 'downgrade'
}

/** Claude CLI model aliases offered in the runner model select. */
const RUNNER_MODEL_OPTIONS = ['sonnet', 'opus', 'haiku'] as const

function errMessage(err: unknown): string {
  return err instanceof IpcError ? err.message : String(err)
}

/** Download rate for the updater progress line: bytes/sec → "x.y MB/s". */
function mbPerSec(bytesPerSecond: number | undefined): string {
  if (bytesPerSecond === undefined) return ''
  return `${(bytesPerSecond / (1024 * 1024)).toFixed(1)} MB/s`
}

/** Human-readable byte size for the backup list. */
function bytesHuman(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let value = bytes / 1024
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit++
  }
  return `${value.toFixed(value >= 10 || unit === 0 ? 0 : 1)} ${units[unit]}`
}

/** Auto-backup interval → a plain-language label. */
function intervalLabel(hours: number): string {
  if (hours === 24) return 'daily'
  if (hours === 168) return 'weekly'
  return `every ${hours} hours`
}

/**
 * First-enable consent (P1.10 / §10.7). The runner ships OFF; the first time the
 * user turns it on we require an explicit acknowledgement of the egress before
 * the toggle persists. "First" is remembered in renderer localStorage (Node-free)
 * so a later off→on does not re-nag someone who already consented. A pre-enabled
 * install (config already on) seeds the flag so it never prompts retroactively.
 */
const RUNNER_CONSENT_KEY = 'agentic-os:runner-egress-consent'

function hasRunnerConsent(): boolean {
  try {
    return localStorage.getItem(RUNNER_CONSENT_KEY) === '1'
  } catch {
    return false
  }
}

function markRunnerConsent(): void {
  try {
    localStorage.setItem(RUNNER_CONSENT_KEY, '1')
  } catch {
    // Storage unavailable (private mode / disabled) — consent degrades to
    // per-session: the dialog simply shows again on the next enable, which is safe.
  }
}

export default function SettingsPanel(): React.JSX.Element {
  const toast = useToast()
  const query = useIpc('settings.get', undefined)

  const [dto, setDto] = useState<SettingsDto | null>(null)
  const [provider, setProvider] = useState<IpcCloudProvider>('anthropic')
  const [modelOverride, setModelOverride] = useState('')
  const [smallLlm, setSmallLlm] = useState('')
  const [savingProvider, setSavingProvider] = useState(false)
  const [savingSmallLlm, setSavingSmallLlm] = useState(false)

  const [keyModal, setKeyModal] = useState<IpcCloudProvider | null>(null)
  const [keyValue, setKeyValue] = useState('')
  const [keySaving, setKeySaving] = useState(false)

  const [pulls, setPulls] = useState<Record<string, OllamaPullProgressDto>>({})
  const [pulling, setPulling] = useState<Record<string, boolean>>({})

  const [token, setToken] = useState<string | null>(null)

  const hookStatus = useIpc('triggers.status', undefined)
  const [installingHook, setInstallingHook] = useState(false)
  const [hookResult, setHookResult] = useState<InstallHookResultDto | null>(null)

  // ── subscription runner (phase 17) ───────────────────────────────────────────
  const runnerStatus = useIpc('runner.status', undefined)
  const [runnerBusy, setRunnerBusy] = useState(false)
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState<RunnerTestConnectionDto | null>(null)
  // First-enable §10.7 egress consent (P1.10).
  const [consentOpen, setConsentOpen] = useState(false)
  const [consentAck, setConsentAck] = useState(false)

  // ── data & backups ───────────────────────────────────────────────────────────
  const backupsQuery = useIpc('backups.list', undefined)
  // A create/restore/reset stages a marker and relaunches the app; this flag
  // shows a "restarting…" state and freezes the section while it happens.
  const [restarting, setRestarting] = useState(false)
  const [confirmBackup, setConfirmBackup] = useState(false)
  const [restoreConfirm, setRestoreConfirm] = useState<string | null>(null)
  const [savingBackupSettings, setSavingBackupSettings] = useState(false)
  const [keepLastInput, setKeepLastInput] = useState('')
  const [keepDaysInput, setKeepDaysInput] = useState('')
  const [exporting, setExporting] = useState(false)
  const [exportPath, setExportPath] = useState<string | null>(null)
  const [resetOpen, setResetOpen] = useState(false)
  const [resetText, setResetText] = useState('')

  // Seed the retention inputs from persisted settings whenever they arrive.
  useEffect(() => {
    const s = backupsQuery.data?.settings
    if (s === undefined) return
    setKeepLastInput(String(s.keepLast))
    setKeepDaysInput(s.keepDays !== undefined ? String(s.keepDays) : '')
    // Only re-sync on a fresh settings payload.
  }, [backupsQuery.data?.settings])

  const saveBackupSettings = async (patch: Partial<BackupSettingsDto>): Promise<void> => {
    setSavingBackupSettings(true)
    try {
      await call('backups.settings.set', patch)
      backupsQuery.reload()
      toast.notify('ok', 'saved')
    } catch (err) {
      toast.notify('err', errMessage(err))
    } finally {
      setSavingBackupSettings(false)
    }
  }

  const saveRetention = async (): Promise<void> => {
    const keepLast = Number.parseInt(keepLastInput, 10)
    const keepDays = Number.parseInt(keepDaysInput, 10)
    await saveBackupSettings({
      keepLast: Number.isFinite(keepLast) && keepLast >= 1 ? keepLast : 1,
      // 0 (or empty) turns the age cap off — the main side drops keepDays < 1.
      keepDays: Number.isFinite(keepDays) && keepDays >= 1 ? keepDays : 0
    })
  }

  const backupNow = async (): Promise<void> => {
    setRestarting(true)
    setConfirmBackup(false)
    try {
      await call('backups.create', undefined)
      // The app relaunches; this panel is torn down. Only a failure re-enables it.
    } catch (err) {
      setRestarting(false)
      toast.notify('err', errMessage(err))
    }
  }

  const restoreBackup = async (dirName: string): Promise<void> => {
    setRestarting(true)
    setRestoreConfirm(null)
    try {
      await call('backups.restore', { dirName })
    } catch (err) {
      setRestarting(false)
      toast.notify('err', errMessage(err))
    }
  }

  const exportData = async (): Promise<void> => {
    setExporting(true)
    try {
      const { path } = await call('data.export', undefined)
      if (path !== null) {
        setExportPath(path)
        toast.notify('ok', 'data exported')
      } else {
        toast.notify('info', 'export cancelled')
      }
    } catch (err) {
      toast.notify('err', errMessage(err))
    } finally {
      setExporting(false)
    }
  }

  const resetData = async (): Promise<void> => {
    setRestarting(true)
    setResetOpen(false)
    try {
      await call('data.reset', undefined)
    } catch (err) {
      setRestarting(false)
      toast.notify('err', errMessage(err))
    }
  }

  // ── app updates ──────────────────────────────────────────────────────────────
  // The app version rides app.status (the same source the rail footer renders).
  const appStatus = useIpc('app.status', undefined)
  // Seed the updater snapshot from updater.status on mount, then ride the live
  // IPC_EVENT_UPDATER_STATUS pushes (mirrors the ollama-pull progress pattern).
  const updaterQuery = useIpc('updater.status', undefined)
  const [updater, setUpdater] = useState<UpdaterStatusDto | null>(null)
  const [checkingUpdate, setCheckingUpdate] = useState(false)
  const [confirmRestart, setConfirmRestart] = useState(false)

  const installHook = async (): Promise<void> => {
    setInstallingHook(true)
    try {
      const result = await call('triggers.installHook', undefined)
      setHookResult(result)
      toast.notify('ok', result.changed ? 'session-end hook installed' : 'hook already installed')
      hookStatus.reload()
    } catch (err) {
      toast.notify('err', errMessage(err))
    } finally {
      setInstallingHook(false)
    }
  }

  /** Live pull subscriptions — severed when each pull ends and on unmount. */
  const unsubsRef = useRef<(() => void)[]>([])
  useEffect(
    () => () => {
      for (const unsub of unsubsRef.current) unsub()
      unsubsRef.current = []
    },
    []
  )

  const applyDto = (fresh: SettingsDto): void => {
    setDto(fresh)
    setProvider(fresh.cloudProvider)
    setModelOverride(fresh.cloudModels[fresh.cloudProvider] ?? '')
    setSmallLlm(fresh.smallLlmModel ?? '')
    // A runner that is already on has, by definition, been consented to — seed
    // the flag so a later off→on is never re-prompted retroactively.
    if (fresh.runner?.enabled === true) markRunnerConsent()
  }

  useEffect(() => {
    if (query.data !== null) applyDto(query.data)
    // applyDto is stable per render; re-sync only when fresh data arrives.
  }, [query.data])

  const copy = (text: string): void => {
    void navigator.clipboard.writeText(text).then(
      () => toast.notify('ok', 'copied'),
      () => toast.notify('err', 'copy failed')
    )
  }

  const saveProvider = async (): Promise<void> => {
    setSavingProvider(true)
    try {
      const trimmed = modelOverride.trim()
      // Only carry the override key when non-empty; empty means "no override".
      const cloudModels: Partial<Record<IpcCloudProvider, string>> = {}
      if (trimmed !== '') cloudModels[provider] = trimmed
      const fresh = await call('settings.save', { cloudProvider: provider, cloudModels })
      applyDto(fresh)
      toast.notify('ok', 'saved')
    } catch (err) {
      toast.notify('err', errMessage(err))
    } finally {
      setSavingProvider(false)
    }
  }

  const saveSmallLlm = async (): Promise<void> => {
    setSavingSmallLlm(true)
    try {
      const trimmed = smallLlm.trim()
      const fresh = await call('settings.save', { smallLlmModel: trimmed === '' ? null : trimmed })
      applyDto(fresh)
      toast.notify('ok', 'saved')
    } catch (err) {
      toast.notify('err', errMessage(err))
    } finally {
      setSavingSmallLlm(false)
    }
  }

  /**
   * Persist a runner-section change. The main-side settings.save merges onto the
   * current runner, but the patch type requires the full DTO, so send the
   * current section (or the keyless defaults) with the one changed field.
   */
  const saveRunner = async (patch: Partial<RunnerSettingsDto>): Promise<void> => {
    if (dto === null) return
    const next: RunnerSettingsDto = { ...(dto.runner ?? RUNNER_DEFAULTS), ...patch }
    // An enable/disable must move the GLOBAL reasoning backend in the SAME atomic
    // save (phase-22): the subscription tier is only routed to when
    // reasoning.backend === 'subscription-claude', so flipping runner.enabled
    // alone leaves it "available but unused". Disable reverts to 'local-qwen3'
    // UNCONDITIONALLY — a stale 'subscription-claude' with the runner off would
    // fall through to the paid cloud-api tier for the subscribable roles (§11.4).
    // The main-side merge preserves any hand-edited reasoning.overrides/models.
    // A model-only save leaves reasoning untouched (patch.enabled === undefined).
    const save: ModelSettingsPatchDto =
      patch.enabled === undefined
        ? { runner: next }
        : { runner: next, reasoning: { backend: patch.enabled ? 'subscription-claude' : 'local-qwen3' } }
    setRunnerBusy(true)
    try {
      const fresh = await call('settings.save', save)
      applyDto(fresh)
      if (patch.enabled === undefined) {
        toast.notify('ok', 'saved')
      } else {
        // Refresh the health cache so the routing status line reflects the new tier.
        runnerStatus.reload()
        toast.notify(
          'ok',
          patch.enabled
            ? 'runner enabled — background reasoning uses your subscription'
            : 'runner disabled — background reasoning back to local + cloud defaults'
        )
      }
    } catch (err) {
      toast.notify('err', errMessage(err))
    } finally {
      setRunnerBusy(false)
    }
  }

  /**
   * Enable-toggle gate (P1.10): the first time the runner is turned ON, require
   * the §10.7 egress acknowledgement before it persists. Turning OFF, or turning
   * ON after a prior consent, persists immediately.
   */
  const handleRunnerToggle = (next: boolean): void => {
    if (next && !hasRunnerConsent()) {
      setConsentAck(false)
      setConsentOpen(true)
      return
    }
    void saveRunner({ enabled: next })
  }

  const confirmRunnerConsent = (): void => {
    markRunnerConsent()
    setConsentOpen(false)
    void saveRunner({ enabled: true })
  }

  /** Manual 1-turn canary (§3.7 — never scheduled); refresh the status after. */
  const testRunnerConnection = async (): Promise<void> => {
    setTesting(true)
    setTestResult(null)
    try {
      const result = await call('runner.testConnection', undefined)
      setTestResult(result)
      toast.notify(result.ok ? 'ok' : 'err', result.message)
    } catch (err) {
      setTestResult({ ok: false, message: errMessage(err) })
      toast.notify('err', errMessage(err))
    } finally {
      setTesting(false)
      runnerStatus.reload()
    }
  }

  // Seed the updater snapshot once, then let live pushes own it (a push may land
  // before the query resolves — keep the pushed value).
  useEffect(() => {
    if (updaterQuery.data !== null) setUpdater((prev) => prev ?? updaterQuery.data)
  }, [updaterQuery.data])

  useEffect(() => {
    const unsub = window.agenticOS.onUpdaterStatus((status) => setUpdater(status))
    return unsub
  }, [])

  /** Manual "check for updates" — never throws (errors land in the snapshot/toast). */
  const checkForUpdates = async (): Promise<void> => {
    setCheckingUpdate(true)
    try {
      setUpdater(await call('updater.check', undefined))
    } catch (err) {
      toast.notify('err', errMessage(err))
    } finally {
      setCheckingUpdate(false)
    }
  }

  /**
   * Confirmed restart-to-install. On success the app quits and relaunches to
   * apply the update, so this panel never re-renders; only a failure surfaces.
   */
  const installUpdate = async (): Promise<void> => {
    try {
      await call('updater.install', undefined)
    } catch (err) {
      setConfirmRestart(false)
      toast.notify('err', errMessage(err))
    }
  }

  const closeKeyModal = (): void => {
    setKeyModal(null)
    setKeyValue('')
  }

  const saveKey = async (): Promise<void> => {
    if (keyModal === null) return
    setKeySaving(true)
    try {
      await call('settings.setApiKey', { provider: keyModal, key: keyValue })
      toast.notify('ok', 'key saved')
      closeKeyModal()
      query.reload()
    } catch (err) {
      toast.notify('err', errMessage(err))
    } finally {
      setKeySaving(false)
    }
  }

  const clearKey = async (p: IpcCloudProvider): Promise<void> => {
    try {
      await call('settings.clearApiKey', { provider: p })
      toast.notify('ok', 'key cleared')
      query.reload()
    } catch (err) {
      toast.notify('err', errMessage(err))
    }
  }

  const pull = async (model: string): Promise<void> => {
    setPulling((s) => ({ ...s, [model]: true }))
    // Subscribe BEFORE invoking so no push is missed.
    const unsub = window.agenticOS.onOllamaPull((p) => {
      if (p.model === model) setPulls((s) => ({ ...s, [model]: p }))
    })
    unsubsRef.current.push(unsub)
    try {
      await call('settings.ollamaPull', { model, runId: crypto.randomUUID() })
      toast.notify('ok', `pulled ${model}`)
    } catch (err) {
      toast.notify('err', errMessage(err))
    } finally {
      unsub()
      unsubsRef.current = unsubsRef.current.filter((u) => u !== unsub)
      try {
        const status = await call('settings.ollamaStatus', undefined)
        setDto((prev) => (prev !== null ? { ...prev, ollama: status } : prev))
      } catch {
        // status refresh failed — keep the last known state visible
      }
      setPulls((s) => {
        const next = { ...s }
        delete next[model]
        return next
      })
      setPulling((s) => ({ ...s, [model]: false }))
    }
  }

  const revealToken = async (): Promise<void> => {
    try {
      const { token: revealed } = await call('settings.revealMcpToken', undefined)
      setToken(revealed)
    } catch (err) {
      toast.notify('err', errMessage(err))
    }
  }

  if (dto === null) {
    return (
      <>
        <PanelHeader title="settings" />
        {query.error !== null ? <ErrorState error={query.error} onRetry={query.reload} /> : <LoadingRows />}
      </>
    )
  }

  const runnerCfg = dto.runner ?? RUNNER_DEFAULTS
  // Keep the current model selectable even if it is a custom id not in the presets.
  const runnerModelOptions = (
    (RUNNER_MODEL_OPTIONS as readonly string[]).includes(runnerCfg.model)
      ? RUNNER_MODEL_OPTIONS
      : [runnerCfg.model, ...RUNNER_MODEL_OPTIONS]
  ).map((m) => ({ value: m, label: m }))

  // Routing status line (phase-22): the tier background reasoning actually uses
  // right now. "Configured for subscription" is read back from the PERSISTED
  // reasoning.backend + runner.enabled (never optimistic local state); the
  // fallback wording mirrors the App.tsx runner chip's effectiveBackend handling.
  const runnerLive = runnerStatus.data
  const subscriptionConfigured = runnerCfg.enabled && dto.reasoning?.backend === 'subscription-claude'
  const runnerRoutingLine = !subscriptionConfigured
    ? 'background reasoning: local + cloud api defaults'
    : runnerLive !== null && runnerLive.fallbackActive
      ? runnerLive.effectiveBackend === 'cloud-api'
        ? 'background reasoning: subscription — currently falling back to your cloud api tier'
        : runnerLive.effectiveBackend === 'local-qwen3'
          ? 'background reasoning: subscription — currently falling back to the local model'
          : 'background reasoning: subscription — currently falling back to the fallback tier'
      : 'background reasoning: subscription'

  // ── app updates ──────────────────────────────────────────────────────────────
  const updState = updater?.state ?? 'idle'
  // The check button is inert while a check or download is already in flight.
  const updBusy = checkingUpdate || updState === 'checking' || updState === 'downloading'
  const updPercent = Math.round(updater?.percent ?? 0)

  return (
    <>
      <PanelHeader title="settings" />
      <div className="flex min-h-0 flex-1 flex-col gap-6 overflow-y-auto px-5 py-4">
        {/* ── cloud provider ───────────────────────────────────────────────── */}
        <section className="max-w-3xl">
          <SectionHeader meta="the reasoning tier background agents use">cloud provider</SectionHeader>
          <div className="flex items-end gap-2">
            <Select
              label="provider"
              testId="settings-provider"
              value={provider}
              onChange={(value) => {
                const p = value as IpcCloudProvider
                setProvider(p)
                setModelOverride(dto.cloudModels[p] ?? '')
              }}
              options={dto.providers.map((p) => ({ value: p, label: p }))}
            />
            <div className="min-w-0 flex-1">
              <TextInput
                label="model override"
                value={modelOverride}
                onChange={setModelOverride}
                mono
                placeholder={dto.defaultModels[provider]}
              />
            </div>
            <Button
              variant="primary"
              size="default"
              testId="settings-save"
              disabled={savingProvider}
              onClick={() => void saveProvider()}
            >
              save
            </Button>
          </div>
          <div className="mt-2 text-[11px] text-ink-faint">
            api keys and provider changes arm background agents on next launch
          </div>
        </section>

        {/* ── api keys ─────────────────────────────────────────────────────── */}
        <section className="max-w-3xl border-t border-line pt-5">
          <SectionHeader meta="stored encrypted via safeStorage, never on disk in plaintext">api keys</SectionHeader>
          <div>
            {dto.providers.map((p) => (
              <div key={p} className="flex items-center gap-3 border-b border-line py-2">
                <span className="w-28 text-[13px]">{p}</span>
                {dto.apiKeysPresent[p] ? (
                  <Badge status="ok" label="key set" />
                ) : (
                  <span className="font-mono text-[11px] text-ink-faint">no key</span>
                )}
                <div className="ml-auto flex items-center gap-2">
                  <Button testId={`settings-set-key-${p}`} onClick={() => setKeyModal(p)}>
                    set key
                  </Button>
                  {dto.apiKeysPresent[p] && (
                    <Button variant="danger" onClick={() => void clearKey(p)}>
                      clear
                    </Button>
                  )}
                </div>
              </div>
            ))}
          </div>
        </section>

        {/* ── local models ─────────────────────────────────────────────────── */}
        <section className="max-w-3xl border-t border-line pt-5">
          <SectionHeader meta="ollama serves bge-m3 embeddings and the small llm">local models</SectionHeader>
          <div className="flex flex-col gap-3">
            <div className="flex items-center gap-2.5">
              <Badge status={dto.ollama.state} />
              {dto.ollama.installedModels.length > 0 && (
                <span className="font-mono text-[12px] text-ink-mute">{dto.ollama.installedModels.join(' · ')}</span>
              )}
            </div>
            {dto.ollama.state === 'daemon-not-running' && (
              <div className="flex items-center gap-2">
                <span className="font-mono text-[12px] text-ink-mute">{dto.ollama.installUrl}</span>
                <Button onClick={() => copy(dto.ollama.installUrl)}>copy</Button>
              </div>
            )}
            {dto.ollama.missingModels.length > 0 && (
              <div>
                {dto.ollama.missingModels.map((model) => {
                  const progress = pulls[model]
                  return (
                    <div key={model} className="flex items-center gap-3 border-b border-line py-2">
                      <span className="font-mono text-[12px]">{model}</span>
                      {progress !== undefined && (
                        <span className="font-mono text-[11px] text-ink-mute" role="status">
                          {progress.error !== undefined ? progress.error : progress.status}
                          {progress.total !== undefined && progress.completed !== undefined
                            ? ` ${Math.round((progress.completed / progress.total) * 100)}%`
                            : ''}
                        </span>
                      )}
                      <div className="ml-auto">
                        <Button
                          variant="primary"
                          testId={`settings-pull-${model}`}
                          disabled={pulling[model] === true}
                          onClick={() => void pull(model)}
                        >
                          pull
                        </Button>
                      </div>
                    </div>
                  )
                })}
              </div>
            )}
            <div className="flex items-end gap-2">
              <div className="min-w-0 flex-1">
                <TextInput label="small llm override" value={smallLlm} onChange={setSmallLlm} mono placeholder="qwen3:4b" />
              </div>
              <Button variant="primary" size="default" disabled={savingSmallLlm} onClick={() => void saveSmallLlm()}>
                save
              </Button>
            </div>
          </div>
        </section>

        {/* ── subscription runner (phase 17) ───────────────────────────────── */}
        <section className="max-w-3xl border-t border-line pt-5">
          <SectionHeader meta="reason with a claude subscription via the local claude cli, off by default">
            subscription runner
          </SectionHeader>
          <div className="flex flex-col gap-3">
            <div className="flex items-center gap-3">
              <Toggle
                label="enable subscription runner"
                testId="settings-runner-enable"
                checked={runnerCfg.enabled}
                disabled={runnerBusy}
                onChange={handleRunnerToggle}
              />
              <span className="text-[13px]">{runnerCfg.enabled ? 'enabled' : 'disabled'}</span>
              <div className="ml-auto">
                <Select
                  ariaLabel="runner model"
                  testId="settings-runner-model"
                  value={runnerCfg.model}
                  onChange={(value) => void saveRunner({ model: value })}
                  options={runnerModelOptions}
                />
              </div>
            </div>

            {/* Honest scope line (phase-doc required copy). */}
            <div className="text-[12px] text-ink-mute">
              the subscription replaces the reasoning llm, not the model stack. embeddings and reranking stay
              local, so ollama remains required.
            </div>

            {/* Routing status: which tier background reasoning lands on right now (phase-22). */}
            <div className="text-[12px] text-ink-mute" role="status" data-testid="settings-runner-routing">
              {runnerRoutingLine}
            </div>

            {runnerStatus.data !== null && (
              <div className="flex flex-col gap-1.5 border-t border-line pt-3" data-testid="runner-status">
                <div className="flex flex-wrap items-center gap-2.5">
                  <Badge status={runnerStatus.data.state} />
                  {runnerStatus.data.version !== null && (
                    <span className="font-mono text-[11px] text-ink-mute">
                      cli {runnerStatus.data.version}
                      {runnerStatus.data.versionOk ? '' : ' (unsupported)'}
                    </span>
                  )}
                  {runnerStatus.data.lastRun !== null && (
                    <span className="flex items-center gap-1.5 font-mono text-[11px] text-ink-faint">
                      last run
                      <Timestamp iso={runnerStatus.data.lastRun.startedAt} />
                      {runnerStatus.data.lastRun.durationMs !== null
                        ? `· ${runnerStatus.data.lastRun.durationMs}ms`
                        : ''}
                    </span>
                  )}
                </div>
                <div className="font-mono text-[11px] break-all text-ink-faint">
                  {runnerStatus.data.binaryPath ?? 'claude cli not found on PATH'}
                </div>
                {runnerStatus.data.lastError !== null && runnerStatus.data.lastError !== '' && (
                  <div className="font-mono text-[11px] break-words text-err">{runnerStatus.data.lastError}</div>
                )}
              </div>
            )}

            <div className="flex items-center gap-2.5">
              <Button testId="settings-runner-test" disabled={testing} onClick={() => void testRunnerConnection()}>
                {testing ? 'testing…' : 'test connection'}
              </Button>
              {testResult !== null && (
                <span
                  role="status"
                  data-testid="runner-test-result"
                  className={`text-[12px] ${testResult.ok ? 'text-ok' : 'text-err'}`}
                >
                  {testResult.message}
                </span>
              )}
            </div>
            <div className="text-[11px] text-ink-faint">
              test connection runs one manual 1-turn canary against the claude cli. it is never scheduled. quota
              history and the run log are not surfaced here yet.
            </div>
          </div>
        </section>

        {/* ── mcp connection ───────────────────────────────────────────────── */}
        <section className="max-w-3xl border-t border-line pt-5">
          <SectionHeader meta="connect claude code or any mcp client">mcp connection</SectionHeader>
          <div className="flex flex-col gap-3">
            <div className="font-mono text-[12px] text-ink-mute">{dto.mcp.url ?? 'server disabled this launch'}</div>
            <div className="flex items-start gap-2">
              <div className="min-w-0 flex-1 rounded-md bg-raised p-3 font-mono text-[12px] break-all">
                {dto.mcp.connectCommand}
              </div>
              <Button onClick={() => copy(dto.mcp.connectCommand)}>copy</Button>
            </div>
            <div className="font-mono text-[11px] text-ink-faint">{dto.mcp.sampleConfigPath}</div>
            {token === null ? (
              <div>
                <Button testId="settings-reveal-token" onClick={() => void revealToken()}>
                  reveal token
                </Button>
              </div>
            ) : (
              <div className="flex items-start gap-2">
                <div className="min-w-0 flex-1 rounded-md bg-raised p-3 font-mono text-[12px] break-all">{token}</div>
                <Button onClick={() => copy(token)}>copy</Button>
                <Button onClick={() => setToken(null)}>hide</Button>
              </div>
            )}
            <div className="text-[11px] text-ink-faint">
              {'the token replaces <token> in the command. treat it like a password.'}
            </div>
          </div>
        </section>

        {/* ── session-end hook (phase 11) ──────────────────────────────────── */}
        <section className="max-w-3xl border-t border-line pt-5">
          <SectionHeader meta="claude code posts finished sessions to the extraction queue">
            session-end hook
          </SectionHeader>
          <div className="flex flex-col gap-3">
            <div className="text-[12px] text-ink-mute">
              {hookStatus.data === null
                ? 'checking ~/.claude/settings.json…'
                : hookStatus.data.hook.installed === true
                  ? 'installed - sessions extract automatically when they end'
                  : hookStatus.data.hook.installed === false
                    ? 'not installed - one click merges the hook into ~/.claude/settings.json (existing hooks are preserved; a backup is written)'
                    : 'state unknown - settings.json could not be read'}
            </div>
            <div>
              <Button
                variant="primary"
                testId="settings-install-hook"
                disabled={installingHook}
                onClick={() => void installHook()}
              >
                {installingHook
                  ? 'installing…'
                  : hookStatus.data?.hook.installed === true
                    ? 'reinstall / repair hook'
                    : 'install hook'}
              </Button>
            </div>
            {hookResult !== null && (
              <div className="flex flex-col gap-2" data-testid="hook-install-result">
                <div className="text-[12px]">
                  {hookResult.changed
                    ? `settings updated${hookResult.backupPath !== null ? ` (backup: ${hookResult.backupPath})` : ''}`
                    : 'already installed - nothing changed'}
                </div>
                {hookResult.diff !== '' && (
                  <pre className="max-h-56 overflow-y-auto rounded-md bg-raised p-3 font-mono text-[11px] whitespace-pre-wrap">
                    {hookResult.diff}
                  </pre>
                )}
              </div>
            )}
            <div className="text-[11px] text-ink-faint">
              if the app is closed when a session ends, the hook spools the session and it is picked up at the next
              launch. the fallback for other mcp clients: 30 minutes of call-log silence.
            </div>
          </div>
        </section>

        {/* ── app updates ──────────────────────────────────────────────────── */}
        <section className="max-w-3xl border-t border-line pt-5" data-testid="settings-updates">
          <SectionHeader meta="download and install new versions of the app">updates</SectionHeader>
          <div className="flex flex-col gap-3">
            <div className="flex items-center gap-2.5">
              <span className="text-[13px]">current version</span>
              <span className="font-mono text-[12px] text-ink-mute">v{appStatus.data?.version ?? '…'}</span>
              {updState !== 'idle' && updState !== 'disabled' && <Badge status={updState} />}
            </div>

            {/* Status line per state. */}
            {updState === 'disabled' && (
              <div className="text-[12px] text-ink-mute" role="status">
                {updater?.detail ?? 'auto-update runs only in the installed (packaged) app.'}
              </div>
            )}
            {updState === 'checking' && (
              <div className="text-[12px] text-ink-mute" role="status">
                checking github releases for a newer version…
              </div>
            )}
            {updState === 'up-to-date' && (
              <div className="text-[12px] text-ink-mute" role="status">
                you are on the latest version{updater?.version !== undefined ? ` (v${updater.version})` : ''}.
              </div>
            )}
            {updState === 'error' && (
              <div className="font-mono text-[11px] break-words text-err" role="alert">
                {updater?.error !== undefined && updater.error !== ''
                  ? updater.error
                  : 'the update check failed — try again later.'}
              </div>
            )}

            {/* Live download progress (percent + MB/s from the push events). */}
            {updState === 'downloading' && (
              <div className="flex flex-col gap-1.5" role="status" data-testid="updater-progress">
                <div className="flex items-center justify-between font-mono text-[11px] text-ink-mute">
                  <span>downloading{updater?.version !== undefined ? ` v${updater.version}` : ''}…</span>
                  <span>
                    {updPercent}%{updater?.bytesPerSecond !== undefined ? ` · ${mbPerSec(updater.bytesPerSecond)}` : ''}
                  </span>
                </div>
                <div className="h-1.5 w-full overflow-hidden rounded bg-line">
                  <div
                    className="h-full rounded bg-accent transition-[width] duration-120"
                    style={{ width: `${updPercent}%` }}
                  />
                </div>
              </div>
            )}

            {updState === 'downloaded' && (
              <div className="text-[12px] text-ink-mute" role="status">
                update{updater?.version !== undefined ? ` v${updater.version}` : ''} downloaded and ready to install.
              </div>
            )}

            {/* Actions: hidden entirely when auto-update is unavailable (dev build). */}
            {updState !== 'disabled' && (
              <div className="flex items-center gap-2.5">
                {updState !== 'downloaded' ? (
                  <Button
                    variant="primary"
                    testId="settings-check-update"
                    disabled={updBusy}
                    onClick={() => void checkForUpdates()}
                  >
                    {updBusy ? 'checking…' : 'check for updates'}
                  </Button>
                ) : !confirmRestart ? (
                  <Button
                    variant="primary"
                    testId="settings-restart-update"
                    onClick={() => setConfirmRestart(true)}
                  >
                    restart to update
                  </Button>
                ) : (
                  <div className="flex flex-wrap items-center gap-2.5" data-testid="updater-restart-confirm">
                    <span className="text-[12px]">
                      restart now to install{updater?.version !== undefined ? ` v${updater.version}` : ''}?
                    </span>
                    <Button variant="primary" testId="settings-restart-confirm" onClick={() => void installUpdate()}>
                      restart
                    </Button>
                    <Button testId="settings-restart-cancel" onClick={() => setConfirmRestart(false)}>
                      not now
                    </Button>
                  </div>
                )}
              </div>
            )}
            <div className="text-[11px] text-ink-faint">
              updates install in the background and finish applying the next time the app restarts. downloading a
              new version happens automatically; use restart to update to apply it now.
            </div>
          </div>
        </section>

        {/* ── data & backups ───────────────────────────────────────────────── */}
        <section className="max-w-3xl border-t border-line pt-5" data-testid="settings-backups">
          <SectionHeader meta="a version history of your data — snapshot now, restore to any point, or start fresh">
            data &amp; backups
          </SectionHeader>
          <div className="flex flex-col gap-4">
            {/* Backup now */}
            <div className="flex flex-wrap items-center gap-2.5">
              {!confirmBackup ? (
                <Button
                  variant="primary"
                  testId="backups-create"
                  disabled={restarting}
                  onClick={() => setConfirmBackup(true)}
                >
                  back up now
                </Button>
              ) : (
                <div className="flex flex-wrap items-center gap-2.5" data-testid="backups-create-confirm">
                  <span className="text-[12px]">
                    creating a backup restarts the app to snapshot the memory graph safely. it takes a few seconds.
                  </span>
                  <Button
                    variant="primary"
                    testId="backups-create-confirm-yes"
                    disabled={restarting}
                    onClick={() => void backupNow()}
                  >
                    back up &amp; restart
                  </Button>
                  <Button disabled={restarting} onClick={() => setConfirmBackup(false)}>
                    cancel
                  </Button>
                </div>
              )}
              {restarting && (
                <span className="text-[12px] text-ink-mute" role="status" data-testid="backups-restarting">
                  restarting…
                </span>
              )}
            </div>

            {/* Automatic backups */}
            <div className="flex flex-col gap-3 border-t border-line pt-3">
              <div className="flex flex-wrap items-center gap-3">
                <Toggle
                  label="automatic backups"
                  testId="backups-auto-enable"
                  checked={backupsQuery.data?.settings.enabled ?? true}
                  disabled={savingBackupSettings || restarting || backupsQuery.data === null}
                  onChange={(v) => void saveBackupSettings({ enabled: v })}
                />
                <span className="text-[13px]">{(backupsQuery.data?.settings.enabled ?? true) ? 'on' : 'off'}</span>
                <div className="ml-auto">
                  <Select
                    ariaLabel="backup interval"
                    testId="backups-interval"
                    value={String(backupsQuery.data?.settings.intervalHours ?? 24)}
                    onChange={(v) => void saveBackupSettings({ intervalHours: Number(v) })}
                    options={(backupsQuery.data?.intervalChoices ?? [6, 12, 24, 168]).map((h) => ({
                      value: String(h),
                      label: intervalLabel(h)
                    }))}
                  />
                </div>
              </div>
              <div className="flex flex-wrap items-end gap-3">
                <label className="flex flex-col gap-1">
                  <span className="text-[12px] text-ink-mute">keep last</span>
                  <input
                    type="number"
                    min={1}
                    aria-label="keep last N backups"
                    data-testid="backups-keep-last"
                    value={keepLastInput}
                    onChange={(e) => setKeepLastInput(e.target.value)}
                    className="h-8 w-24 rounded-md border border-line-strong bg-raised px-2.5 font-mono text-[12px] text-ink focus:border-accent focus:outline-none"
                  />
                </label>
                <label className="flex flex-col gap-1">
                  <span className="text-[12px] text-ink-mute">keep for days (0 = off)</span>
                  <input
                    type="number"
                    min={0}
                    aria-label="keep for days"
                    data-testid="backups-keep-days"
                    value={keepDaysInput}
                    onChange={(e) => setKeepDaysInput(e.target.value)}
                    className="h-8 w-28 rounded-md border border-line-strong bg-raised px-2.5 font-mono text-[12px] text-ink focus:border-accent focus:outline-none"
                  />
                </label>
                <Button
                  variant="primary"
                  size="default"
                  testId="backups-save-retention"
                  disabled={savingBackupSettings || restarting}
                  onClick={() => void saveRetention()}
                >
                  save
                </Button>
              </div>
              <div className="text-[11px] text-ink-faint">
                only automatic backups are pruned by these limits — manual backups and the safety snapshots taken
                before a restore or reset are kept forever. automatic backups are created at app startup when one is
                due (the memory graph can only be snapshotted safely while the app is not holding it open).
              </div>
            </div>

            {/* Backup list */}
            <div className="flex flex-col gap-1 border-t border-line pt-3">
              {backupsQuery.error !== null ? (
                <ErrorState error={backupsQuery.error} onRetry={backupsQuery.reload} />
              ) : backupsQuery.data === null ? (
                <div className="py-2 text-[12px] text-ink-mute">loading backups…</div>
              ) : backupsQuery.data.backups.length === 0 ? (
                <div className="py-2 text-[12px] text-ink-mute">
                  no backups yet — one is created automatically on the next launch, or back up now.
                </div>
              ) : (
                <div data-testid="backups-list">
                  {backupsQuery.data.backups.map((b) => (
                    <div key={b.dirName} className="flex flex-wrap items-center gap-3 border-b border-line py-2">
                      <Badge status={b.kind} />
                      {b.createdAt !== null ? (
                        <Timestamp iso={b.createdAt} />
                      ) : (
                        <span className="font-mono text-[11px] text-ink-faint">{b.dirName}</span>
                      )}
                      <span className="font-mono text-[11px] text-ink-mute">
                        {bytesHuman(b.bytes)} · {b.files} files
                      </span>
                      <div className="ml-auto">
                        {!b.restorable ? (
                          <span className="text-[11px] text-ink-faint">not restorable</span>
                        ) : restoreConfirm === b.dirName ? (
                          <div className="flex flex-wrap items-center gap-2" data-testid="backups-restore-confirm">
                            <span className="text-[11px] text-ink-mute">
                              restore to this point? current data is snapshotted first, then the app restarts.
                            </span>
                            <Button
                              variant="primary"
                              testId="backups-restore-confirm-yes"
                              disabled={restarting}
                              onClick={() => void restoreBackup(b.dirName)}
                            >
                              restore &amp; restart
                            </Button>
                            <Button disabled={restarting} onClick={() => setRestoreConfirm(null)}>
                              cancel
                            </Button>
                          </div>
                        ) : (
                          <Button
                            testId={`backups-restore-${b.dirName}`}
                            disabled={restarting}
                            onClick={() => setRestoreConfirm(b.dirName)}
                          >
                            restore
                          </Button>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* Export */}
            <div className="flex flex-wrap items-center gap-2.5 border-t border-line pt-3">
              <Button testId="data-export" disabled={exporting || restarting} onClick={() => void exportData()}>
                {exporting ? 'exporting…' : 'export data…'}
              </Button>
              {exportPath !== null && (
                <span className="font-mono text-[11px] break-all text-ink-mute" data-testid="data-export-path">
                  exported to {exportPath}
                </span>
              )}
              <span className="text-[11px] text-ink-faint">
                a portable copy: the graph as csv + cypher, appdata, and settings (api keys are never exported).
              </span>
            </div>

            {/* Danger zone: reset */}
            <div className="flex flex-col gap-2 rounded-md border border-err/40 bg-err/5 p-3" data-testid="data-reset">
              <div className="flex items-center gap-2">
                <span className="text-[13px] font-semibold text-err">danger zone</span>
              </div>
              <div className="text-[12px] text-ink-mute">
                reset deletes all data and returns the app to defaults, including the memory graph. your backups are
                kept — you can restore from one afterwards.
              </div>
              <div>
                <Button variant="danger" testId="data-reset-open" disabled={restarting} onClick={() => setResetOpen(true)}>
                  reset all data…
                </Button>
              </div>
            </div>
          </div>
        </section>
      </div>

      {consentOpen && (
        <Modal
          title="enable subscription runner"
          onClose={() => setConsentOpen(false)}
          footer={
            <>
              <Button onClick={() => setConsentOpen(false)}>cancel</Button>
              <Button
                variant="primary"
                testId="settings-runner-consent-confirm"
                disabled={!consentAck}
                onClick={confirmRunnerConsent}
              >
                enable runner
              </Button>
            </>
          }
        >
          <div className="flex flex-col gap-3 text-[13px] leading-6" data-testid="settings-runner-consent">
            <p>
              With the subscription runner enabled, the text being reasoned about — session transcripts, skill
              feedback, and (if you opt those roles in) retrieved memory snippets — is sent to Anthropic under your
              Claude account, the same vendor your Claude Code sessions already go to.
            </p>
            <p>
              While the runner is unavailable, background reasoning falls back to your cloud api key (if set) or the
              local model; turning the runner off restores those defaults.
            </p>
            <p className="text-ink-mute">
              Your memory graph, embeddings, and search index never leave your machine.
            </p>
            <label className="mt-1 flex items-center gap-2 text-[12px]">
              <input
                type="checkbox"
                aria-label="I understand what is sent to Anthropic"
                data-testid="settings-runner-consent-ack"
                checked={consentAck}
                onChange={(e) => setConsentAck(e.target.checked)}
                className="size-3.5"
                style={{ accentColor: 'var(--color-accent)' }}
              />
              <span>I understand what is sent to Anthropic.</span>
            </label>
          </div>
        </Modal>
      )}

      {keyModal !== null && (
        <Modal
          title={`set ${keyModal} api key`}
          onClose={closeKeyModal}
          footer={
            <>
              <Button onClick={closeKeyModal}>cancel</Button>
              <Button
                variant="primary"
                testId="settings-key-save"
                disabled={keySaving || keyValue.trim() === ''}
                onClick={() => void saveKey()}
              >
                save
              </Button>
            </>
          }
        >
          <label className="flex flex-col gap-1">
            <span className="text-[12px] text-ink-mute">api key</span>
            <input
              type="password"
              aria-label="api key"
              data-testid="settings-key-input"
              value={keyValue}
              onChange={(e) => setKeyValue(e.target.value)}
              className="h-8 w-full rounded-md border border-line-strong bg-raised px-2.5 font-mono text-[12px] text-ink placeholder:text-ink-mute focus:border-accent focus:outline-none"
            />
          </label>
          <p className="mt-2 text-[11px] text-ink-faint">encrypted with safeStorage; never shown or logged.</p>
        </Modal>
      )}

      {resetOpen && (
        <Modal
          title="reset all data"
          onClose={() => {
            setResetOpen(false)
            setResetText('')
          }}
          footer={
            <>
              <Button
                onClick={() => {
                  setResetOpen(false)
                  setResetText('')
                }}
              >
                cancel
              </Button>
              <Button
                variant="danger"
                testId="data-reset-confirm"
                disabled={restarting || resetText !== 'RESET'}
                onClick={() => void resetData()}
              >
                reset &amp; restart
              </Button>
            </>
          }
        >
          <div className="flex flex-col gap-3 text-[13px] leading-6" data-testid="data-reset-modal">
            <p>
              This permanently deletes the memory graph, app data, settings, and API keys, returning the app to a
              fresh install. <strong>Your backups are kept</strong> — you can restore from one afterwards.
            </p>
            <p className="text-ink-mute">
              A snapshot of your current data is taken first (a pre-reset backup). The app restarts to complete the
              reset.
            </p>
            <label className="mt-1 flex flex-col gap-1">
              <span className="text-[12px] text-ink-mute">type RESET to confirm</span>
              <input
                type="text"
                aria-label="type RESET to confirm"
                data-testid="data-reset-input"
                value={resetText}
                onChange={(e) => setResetText(e.target.value)}
                className="h-8 w-full rounded-md border border-line-strong bg-raised px-2.5 font-mono text-[12px] text-ink placeholder:text-ink-mute focus:border-accent focus:outline-none"
              />
            </label>
          </div>
        </Modal>
      )}
    </>
  )
}
