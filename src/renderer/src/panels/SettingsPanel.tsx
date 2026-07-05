/**
 * Settings panel (phase 10): cloud provider + model overrides, encrypted api
 * keys (presence only ever crosses the IPC boundary, spec §21 rule 7), local
 * Ollama model status/pulls, and the MCP connection details (§4, §14).
 */
import { useEffect, useRef, useState } from 'react'
import type { IpcCloudProvider, OllamaPullProgressDto, SettingsDto } from '../../../shared/ipc'
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
  useToast
} from '../ui/kit'

function errMessage(err: unknown): string {
  return err instanceof IpcError ? err.message : String(err)
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
      </div>

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
