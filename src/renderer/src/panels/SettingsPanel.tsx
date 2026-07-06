/**
 * Settings panel (phase 10): cloud provider + model overrides, encrypted api
 * keys (presence only ever crosses the IPC boundary, spec §21 rule 7), local
 * Ollama model status/pulls, and the MCP connection details (§4, §14).
 */
import { useEffect, useRef, useState } from 'react'
import type {
  InstallHookResultDto,
  IpcCloudProvider,
  ModelSettingsPatchDto,
  OllamaPullProgressDto,
  RunnerSettingsDto,
  RunnerTestConnectionDto,
  SettingsDto
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
    </>
  )
}
