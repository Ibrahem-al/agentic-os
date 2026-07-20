/**
 * Settings panel (phase 10): cloud provider + model overrides, encrypted api
 * keys (presence only ever crosses the IPC boundary, spec §21 rule 7), local
 * Ollama model status/pulls, and the MCP connection details (§4, §14).
 */
import { useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import type {
  BackupSettingsDto,
  InstallHookResultDto,
  IpcCloudProvider,
  IpcReasoningBackend,
  ModelSettingsPatchDto,
  OllamaPullProgressDto,
  ReasoningRoleDto,
  ReasoningRoleGroupDto,
  RunnerSettingsDto,
  RunnerTestConnectionDto,
  SettingsDto,
  UpdaterStatusDto
} from '../../../shared/ipc'
import { call, IpcError, useIpc } from '../lib/ipc'
import { plainBackend, plainBytes, plainStatus } from '../lib/plain'
import { ReleaseNotes } from '../lib/releaseNotes'
import { Icon } from '../ui/icons'
import {
  Badge,
  Button,
  Disclosure,
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

/**
 * The muted "release name · date" line above the patch notes — the release name
 * only when it adds something over the bare version, and the date only when it
 * parses (the one renderer-side date parse, guarded). Null ⇒ render no line.
 */
function releaseNotesHeader(u: UpdaterStatusDto): string | null {
  const parts: string[] = []
  const name = u.releaseName?.trim()
  const bare = (s: string): string => s.toLowerCase().replace(/^v/, '')
  if (name !== undefined && name !== '' && (u.version === undefined || bare(name) !== bare(u.version))) parts.push(name)
  if (u.releaseDate !== undefined) {
    const d = new Date(u.releaseDate)
    if (!Number.isNaN(d.getTime())) parts.push(d.toLocaleDateString())
  }
  return parts.length > 0 ? parts.join(' · ') : null
}

/**
 * The three places background reasoning can run — the "AI processing" radio.
 * Wired to `reasoning.backend`; the subscription choice reuses the runner-enable
 * path (consent gate + the atomic backend coupling), so it is not a fork.
 */
const BACKEND_CHOICES: readonly {
  readonly value: IpcReasoningBackend
  readonly testId: string
  readonly label: string
  readonly hint: string
}[] = [
  {
    value: 'local-qwen3',
    testId: 'ai-processing-backend-local',
    label: 'On this computer',
    hint: 'Private and free. Needs the local AI helper (Ollama) running.'
  },
  {
    value: 'cloud-api',
    testId: 'ai-processing-backend-cloud',
    label: 'My cloud API key',
    hint: 'Faster; costs per use. Needs a key set under AI providers.'
  },
  {
    value: 'subscription-claude',
    testId: 'ai-processing-backend-subscription',
    label: 'My Claude subscription',
    hint: 'Uses your existing Claude plan through the runner.'
  }
]

/** Canonical render order for the "What runs where" group rows. */
const ROLE_GROUP_ORDER: readonly ReasoningRoleGroupDto[] = [
  'Understanding your sessions',
  'Search & retrieval',
  'Improving skills',
  'Safety scanning',
  'Summaries'
]

/** Backend ids in a fixed order for a group's "where it runs" badges. */
const BACKEND_BADGE_ORDER: readonly IpcReasoningBackend[] = ['local-qwen3', 'cloud-api', 'subscription-claude']

/** Slug a plain group name into a stable testid suffix. */
function groupSlug(group: string): string {
  return group
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '')
}

function errMessage(err: unknown): string {
  return err instanceof IpcError ? err.message : String(err)
}

/** Download rate for the updater progress line: bytes/sec → "x.y MB/s". */
function mbPerSec(bytesPerSecond: number | undefined): string {
  if (bytesPerSecond === undefined) return ''
  return `${(bytesPerSecond / (1024 * 1024)).toFixed(1)} MB/s`
}

/**
 * In-panel section nav (mini-TOC). A less technical user meets one long settings
 * page as a short list of plain topics they can jump to instead of scrolling a
 * wall. `id` matches the anchored section below; order matches the render order.
 */
const SECTIONS = [
  { id: 'providers', label: 'AI providers' },
  { id: 'ai-processing', label: 'AI processing' },
  { id: 'local-ai', label: 'Local AI helper' },
  { id: 'claude', label: 'Claude connection' },
  { id: 'reasoning', label: 'Advanced reasoning' },
  { id: 'updates', label: 'Updates' },
  { id: 'backups', label: 'Data & backups' },
  { id: 'hooks', label: 'Automation hooks' }
] as const

/**
 * Download progress fill. Deliberately accent (not the capacity MeterBar, whose
 * warn/err colors read "over budget"): a download nearing 100% is good news, so
 * a bar going red near the end would mislead. Shared by the updater and Ollama
 * model pulls. `prefers-reduced-motion` collapses the width transition globally.
 */
function ProgressBar({ percent, label }: { percent: number; label: string }): React.JSX.Element {
  const pct = Math.max(0, Math.min(100, Math.round(percent)))
  return (
    <div className="h-2 w-full overflow-hidden rounded-full bg-line" role="img" aria-label={label}>
      <div className="h-full rounded-full bg-accent transition-[width] duration-120" style={{ width: `${pct}%` }} />
    </div>
  )
}

/**
 * One settings section: an anchored heading, a one-line plain sentence of what
 * it is for, then its controls. `innerRef` registers the element so the mini-TOC
 * chips can scroll to it; `divider` draws the hairline separator (off for the
 * first section, which follows the sticky nav).
 */
function SettingsSection({
  id,
  title,
  blurb,
  testId,
  divider = true,
  innerRef,
  children
}: {
  id: string
  title: string
  blurb: ReactNode
  testId?: string
  divider?: boolean
  innerRef: (el: HTMLElement | null) => void
  children: ReactNode
}): React.JSX.Element {
  return (
    <section
      ref={innerRef}
      id={id}
      className={`max-w-3xl scroll-mt-2 ${divider ? 'border-t border-line pt-5' : ''}`}
      {...(testId !== undefined ? { 'data-testid': testId } : {})}
    >
      <SectionHeader>{title}</SectionHeader>
      <p className="-mt-1 mb-3 text-[12px] text-ink-mute">{blurb}</p>
      {children}
    </section>
  )
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

  // ── AI processing (Stage 3): where reasoning runs + sensitive-egress consent ──
  const rolesQuery = useIpc('reasoning.roles', undefined)
  const [sensitiveConsentOpen, setSensitiveConsentOpen] = useState(false)
  const [sensitiveAck, setSensitiveAck] = useState(false)
  const [sensitiveBusy, setSensitiveBusy] = useState(false)

  // Phone / other-device access over the local network — opt-in, consent-gated
  // exactly like the sensitive-egress flag above.
  const [lanConsentOpen, setLanConsentOpen] = useState(false)
  const [lanAck, setLanAck] = useState(false)
  const [lanBusy, setLanBusy] = useState(false)

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
  const [pausingRestart, setPausingRestart] = useState(false)

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

  /**
   * Switch the global reasoning backend to a NON-subscription tier (local/cloud).
   * Mirrors the runner-toggle coupling: turns the runner OFF (a stale enabled
   * runner would surface its health banner while sitting unused) and sets
   * reasoning.backend in the same atomic save. Only touches the runner section
   * when it is actually on, so a keyless install switching local↔cloud never
   * materializes it. The main-side merge preserves overrides/models AND the
   * allowSensitiveNonLocal flag (a backend-only reasoning patch — Stage 2).
   */
  const saveBackend = async (backend: IpcReasoningBackend): Promise<void> => {
    if (dto === null) return
    const currentRunner = dto.runner ?? RUNNER_DEFAULTS
    const save: ModelSettingsPatchDto = currentRunner.enabled
      ? { runner: { ...currentRunner, enabled: false }, reasoning: { backend } }
      : { reasoning: { backend } }
    setRunnerBusy(true)
    try {
      const fresh = await call('settings.save', save)
      applyDto(fresh)
      runnerStatus.reload()
      toast.notify(
        'ok',
        backend === 'cloud-api'
          ? 'background reasoning now uses your cloud api key'
          : 'background reasoning now runs on this computer'
      )
    } catch (err) {
      toast.notify('err', errMessage(err))
    } finally {
      setRunnerBusy(false)
    }
  }

  /**
   * Pick where background reasoning runs. Subscription reuses the runner-enable
   * path verbatim (consent gate + the atomic subscription-claude coupling);
   * local/cloud go through saveBackend, which also switches the runner off.
   */
  const selectBackend = (backend: IpcReasoningBackend): void => {
    if (dto === null || runnerBusy) return
    if (backend === (dto.reasoning?.backend ?? 'local-qwen3')) return
    if (backend === 'subscription-claude') {
      handleRunnerToggle(true)
      return
    }
    void saveBackend(backend)
  }

  /**
   * Persist the sensitive-egress consent flag. The current backend is echoed so
   * the main-side merge sets ONLY the flag; a revoke sends `false` EXPLICITLY
   * (Stage 2 gotcha 1 — an omitted key would preserve a prior true).
   */
  const saveSensitive = async (allow: boolean): Promise<void> => {
    if (dto === null) return
    const backend = dto.reasoning?.backend ?? 'local-qwen3'
    setSensitiveBusy(true)
    try {
      const fresh = await call('settings.save', { reasoning: { backend, allowSensitiveNonLocal: allow } })
      applyDto(fresh)
      toast.notify(
        'ok',
        allow ? 'sensitive work may now leave this computer' : 'sensitive work is kept on this computer'
      )
    } catch (err) {
      toast.notify('err', errMessage(err))
    } finally {
      setSensitiveBusy(false)
    }
  }

  /** Turning ON gates behind the consent modal; turning OFF revokes immediately. */
  const handleSensitiveToggle = (next: boolean): void => {
    if (next) {
      setSensitiveAck(false)
      setSensitiveConsentOpen(true)
      return
    }
    void saveSensitive(false)
  }

  const confirmSensitiveConsent = (): void => {
    setSensitiveConsentOpen(false)
    void saveSensitive(true)
  }

  /**
   * Persist the LAN-access flag. Turning it on/off only takes full effect after
   * a restart (the MCP server binds its host at boot), so the toast says so.
   */
  const saveLan = async (enable: boolean): Promise<void> => {
    setLanBusy(true)
    try {
      const fresh = await call('settings.save', { network: { lanAccess: enable } })
      applyDto(fresh)
      toast.notify(
        'ok',
        enable
          ? 'network access on — restart the app to start listening'
          : 'network access off — restart the app to stop listening'
      )
    } catch (err) {
      toast.notify('err', errMessage(err))
    } finally {
      setLanBusy(false)
    }
  }

  /** Turning ON gates behind the consent modal; turning OFF revokes immediately. */
  const handleLanToggle = (next: boolean): void => {
    if (next) {
      setLanAck(false)
      setLanConsentOpen(true)
      return
    }
    void saveLan(false)
  }

  const confirmLanConsent = (): void => {
    setLanConsentOpen(false)
    void saveLan(true)
  }

  // Re-fetch the live role map after any settings change (the router re-resolves
  // post-invalidate on settings.save), so "What runs where" reflects the new
  // backend/consent/key without a restart (Stage 2 gotcha 6).
  const reloadRoles = rolesQuery.reload
  useEffect(() => {
    if (dto !== null) reloadRoles()
  }, [dto, reloadRoles])

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
   * Confirmed restart-to-install. On the normal path the app quits + relaunches
   * to apply the update, so this panel never re-renders. But the install can be
   * DEFERRED: either a write was still in flight after the quiesce bound, or a
   * background JOB is running (then `blockedByTaskId` is set and the UI offers to
   * pause it). `force: true` = the "pause the job and restart now" action.
   */
  const installUpdate = async (force = false): Promise<void> => {
    if (force) setPausingRestart(true)
    try {
      const status = await call('updater.install', { force })
      if (status.installDeferred === true) {
        setUpdater(status)
        setConfirmRestart(false)
        // A job blocking the restart shows the inline block (with the pause
        // button); only the plain write-drain defer needs a toast.
        if (status.blockedByTaskId === undefined) {
          toast.notify('ok', status.detail ?? 'The update will install when you next close the app.')
        }
      }
      // Otherwise the app is quitting to install — no state change needed here.
    } catch (err) {
      setConfirmRestart(false)
      toast.notify('err', errMessage(err))
    } finally {
      setPausingRestart(false)
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

  // ── in-panel section nav ───────────────────────────────────────────────────────
  // The mini-TOC chips scroll to each anchored section; refs are registered per
  // section id. No smooth behavior — instant jump respects reduced-motion and the
  // no-decorative-motion rule.
  const sectionRefs = useRef<Record<string, HTMLElement | null>>({})
  // Block-body ref callback (returns void — a React 19 ref callback must not
  // return a value); one per section id.
  const registerSection =
    (id: string) =>
    (el: HTMLElement | null): void => {
      sectionRefs.current[id] = el
    }
  const scrollToSection = (id: string): void => {
    sectionRefs.current[id]?.scrollIntoView({ block: 'start' })
  }

  const headerProps = {
    title: 'Settings',
    subtitle: 'Connections, models, and your data.',
    icon: <Icon name="settings" size={18} />
  }

  if (dto === null) {
    return (
      <>
        <PanelHeader {...headerProps} />
        {query.error !== null ? <ErrorState error={query.error} onRetry={query.reload} /> : <LoadingRows />}
      </>
    )
  }

  const runnerCfg = dto.runner ?? RUNNER_DEFAULTS
  // AI-processing: the persisted global backend + sensitive-egress consent.
  const currentBackend: IpcReasoningBackend = dto.reasoning?.backend ?? 'local-qwen3'
  const sensitiveAllowed = dto.reasoning?.allowSensitiveNonLocal === true
  const roles: readonly ReasoningRoleDto[] | null = rolesQuery.data
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
      <PanelHeader {...headerProps} />
      <div className="flex min-h-0 flex-1 flex-col gap-6 overflow-y-auto px-5 py-4">
        {/* Mini-TOC: jump to a topic instead of scrolling the whole page. */}
        <nav
          aria-label="Settings sections"
          className="sticky top-0 z-10 -mx-5 -mt-4 flex flex-wrap gap-1.5 border-b border-line bg-bg px-5 py-3"
        >
          {SECTIONS.map((s) => (
            <button
              key={s.id}
              type="button"
              onClick={() => scrollToSection(s.id)}
              className="cursor-pointer rounded-full border border-line-strong px-3 py-1 text-[12px] text-ink-mute transition-colors duration-120 hover:bg-raised hover:text-ink"
            >
              {s.label}
            </button>
          ))}
        </nav>

        {/* ── AI providers (cloud service + keys) ───────────────────────────── */}
        <SettingsSection
          id="providers"
          title="AI providers"
          blurb="The cloud AI service your background agents reason with, plus the keys they use to reach it."
          divider={false}
          innerRef={registerSection('providers')}
        >
          <div className="flex items-end gap-2">
            <Select
              label="cloud service"
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
                label="model (optional)"
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
              Save
            </Button>
          </div>
          <p className="mt-2 text-[12px] text-ink-mute">
            Changes to the service or keys take effect the next time the app starts.
          </p>

          <div className="mt-5 border-t border-line pt-4">
            <div className="mb-1 text-[13px] font-medium">Keys</div>
            <p className="mb-2 text-[12px] text-ink-mute">
              Stored encrypted on this computer — never saved as plain text, and only ever sent to the service the
              key belongs to.
            </p>
            {dto.providers.map((p) => (
              <div key={p} className="flex items-center gap-3 border-b border-line py-2">
                <span className="w-28 text-[13px]">{p}</span>
                {dto.apiKeysPresent[p] ? (
                  <Badge status="ok" label="key set" title="A key is saved for this service." />
                ) : (
                  <span className="text-[12px] text-ink-mute">no key yet</span>
                )}
                <div className="ml-auto flex items-center gap-2">
                  <Button testId={`settings-set-key-${p}`} onClick={() => setKeyModal(p)}>
                    {dto.apiKeysPresent[p] ? 'Replace key' : 'Add key'}
                  </Button>
                  {dto.apiKeysPresent[p] && (
                    <Button variant="danger" onClick={() => void clearKey(p)}>
                      Remove
                    </Button>
                  )}
                </div>
              </div>
            ))}
          </div>
        </SettingsSection>

        {/* ── AI processing (where reasoning runs + sensitive consent) ──────── */}
        <SettingsSection
          id="ai-processing"
          title="AI processing"
          blurb="Where your background agents do their thinking. Search indexing (embeddings) always runs on this computer, whatever you choose here."
          innerRef={registerSection('ai-processing')}
        >
          <div className="flex flex-col gap-5">
            {/* Primary choice: a plain vertical radio list, not a card grid. */}
            <fieldset className="flex flex-col gap-2" data-testid="ai-processing-backend">
              <legend className="sr-only">Where background reasoning runs</legend>
              {BACKEND_CHOICES.map((choice) => {
                const selected = currentBackend === choice.value
                return (
                  <label
                    key={choice.value}
                    data-testid={choice.testId}
                    className={`flex cursor-pointer items-start gap-3 rounded-md border p-3 transition-colors duration-120 ${
                      selected ? 'border-accent bg-accent/5' : 'border-line-strong hover:bg-raised'
                    }`}
                  >
                    <input
                      type="radio"
                      name="ai-processing-backend"
                      value={choice.value}
                      checked={selected}
                      disabled={runnerBusy}
                      onChange={() => selectBackend(choice.value)}
                      className="mt-0.5 size-3.5"
                      style={{ accentColor: 'var(--color-accent)' }}
                    />
                    <span className="flex min-w-0 flex-col gap-0.5">
                      <span className="text-[13px] text-ink">{choice.label}</span>
                      <span className="text-[12px] text-ink-mute">{choice.hint}</span>
                    </span>
                  </label>
                )
              })}
            </fieldset>

            <p className="text-[12px] text-ink-mute">
              Search indexing (embeddings) always runs on this computer, whatever you choose here.
            </p>

            {/* What runs where — the live reasoning.roles map, grouped in plain words. */}
            <div className="flex flex-col gap-2 border-t border-line pt-4">
              <div className="text-[13px] font-medium">What runs where</div>
              <p className="text-[12px] text-ink-mute">
                Where each kind of background work runs right now, given your choice above.
              </p>
              {roles === null ? (
                <div className="py-2 text-[12px] text-ink-mute">Loading…</div>
              ) : (
                <div data-testid="ai-processing-runs">
                  {ROLE_GROUP_ORDER.map((group) => {
                    const groupRoles = roles.filter((r) => r.group === group)
                    if (groupRoles.length === 0) return null
                    const present = new Set(groupRoles.map((r) => r.effectiveBackend ?? 'local-qwen3'))
                    const backends = BACKEND_BADGE_ORDER.filter((b) => present.has(b))
                    const sensitive = groupRoles.some((r) => r.sensitive)
                    return (
                      <div
                        key={group}
                        className="flex flex-col gap-1 border-b border-line py-2.5"
                        data-testid={`ai-processing-role-${groupSlug(group)}`}
                      >
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="min-w-0 flex-1 text-[13px]">{group}</span>
                          {sensitive && <Icon name="lock" size={13} className="shrink-0 text-ink-mute" />}
                          {backends.map((b) => (
                            <Badge key={b} status={b} label={plainBackend(b)} title={`Runs on ${plainBackend(b)}.`} />
                          ))}
                        </div>
                        {sensitive && (
                          <p className="text-[12px] text-ink-mute">
                            Handles raw session text — kept on this computer unless you allow otherwise.
                          </p>
                        )}
                      </div>
                    )
                  })}
                </div>
              )}
            </div>

            {/* Sensitive-egress override (extends the §10.7 consent pattern). */}
            <div className="flex flex-col gap-2 border-t border-line pt-4">
              <div className="flex items-center gap-3">
                <Toggle
                  label="Allow sensitive work to leave this computer"
                  testId="ai-processing-sensitive-toggle"
                  checked={sensitiveAllowed}
                  disabled={sensitiveBusy}
                  onChange={handleSensitiveToggle}
                />
                <span className="text-[13px]">{sensitiveAllowed ? 'on' : 'off'}</span>
              </div>
              {sensitiveAllowed ? (
                <p className="text-[12px] text-ink-mute">
                  Sensitive work (raw session text and scanned content) may follow your choice above off this
                  computer. Turn this off to keep it local again.
                </p>
              ) : (
                <p className="text-[12px] text-ink-mute">
                  Sensitive work (raw session text and scanned content) stays on this computer, even when everything
                  else uses the cloud or your subscription.
                </p>
              )}
            </div>
          </div>
        </SettingsSection>

        {/* ── local AI helper (ollama) ─────────────────────────────────────── */}
        <SettingsSection
          id="local-ai"
          title="Local AI helper"
          blurb="A small AI that runs on your computer (Ollama). It powers search and quick local answers, so the app keeps working even offline."
          innerRef={registerSection('local-ai')}
        >
          <div className="flex flex-col gap-3">
            <div className="flex flex-wrap items-center gap-2.5">
              <Badge
                status={dto.ollama.state}
                label={plainStatus(dto.ollama.state).label}
                title={plainStatus(dto.ollama.state).explain}
              />
              {dto.ollama.installedModels.length > 0 && (
                <span className="font-mono text-[12px] text-ink-mute">{dto.ollama.installedModels.join(' · ')}</span>
              )}
            </div>
            {dto.ollama.state === 'daemon-not-running' && (
              <div className="flex flex-col gap-1.5">
                <p className="text-[12px] text-ink-mute">
                  The local AI helper isn&apos;t running. Start Ollama, or install it from the link below.
                </p>
                <div className="flex items-center gap-2">
                  <span className="font-mono text-[12px] text-ink-mute">{dto.ollama.installUrl}</span>
                  <Button onClick={() => copy(dto.ollama.installUrl)}>Copy link</Button>
                </div>
              </div>
            )}
            {dto.ollama.missingModels.length > 0 && (
              <div className="flex flex-col gap-1">
                <p className="text-[12px] text-ink-mute">
                  These models still need to download before everything works:
                </p>
                {dto.ollama.missingModels.map((model) => {
                  const progress = pulls[model]
                  const pct =
                    progress?.total !== undefined && progress.completed !== undefined
                      ? Math.round((progress.completed / progress.total) * 100)
                      : null
                  return (
                    <div key={model} className="flex flex-col gap-1.5 border-b border-line py-2">
                      <div className="flex items-center gap-3">
                        <span className="font-mono text-[12px]">{model}</span>
                        {progress !== undefined && (
                          <span className="font-mono text-[11px] text-ink-mute" role="status">
                            {progress.error !== undefined ? progress.error : progress.status}
                            {pct !== null ? ` ${pct}%` : ''}
                          </span>
                        )}
                        <div className="ml-auto">
                          <Button
                            variant="primary"
                            testId={`settings-pull-${model}`}
                            disabled={pulling[model] === true}
                            onClick={() => void pull(model)}
                          >
                            {pulling[model] === true ? 'Downloading…' : 'Download'}
                          </Button>
                        </div>
                      </div>
                      {pct !== null && <ProgressBar percent={pct} label={`${model} download ${pct}%`} />}
                    </div>
                  )
                })}
              </div>
            )}
            <div className="flex items-end gap-2">
              <div className="min-w-0 flex-1">
                <TextInput label="small model (optional)" value={smallLlm} onChange={setSmallLlm} mono placeholder="qwen3:4b" />
              </div>
              <Button variant="primary" size="default" disabled={savingSmallLlm} onClick={() => void saveSmallLlm()}>
                Save
              </Button>
            </div>
          </div>
        </SettingsSection>

        {/* ── Claude connection (mcp) ──────────────────────────────────────── */}
        <SettingsSection
          id="claude"
          title="Claude connection"
          blurb="How Claude Code (or any MCP client) connects to this app. Share the command below to link it."
          innerRef={registerSection('claude')}
        >
          <div className="flex flex-col gap-3">
            <div className="font-mono text-[12px] text-ink-mute">
              {dto.mcp.url ?? 'The connection is turned off for this launch.'}
            </div>
            <div className="flex items-start gap-2">
              <div className="min-w-0 flex-1 rounded-md bg-raised p-3 font-mono text-[12px] break-all">
                {dto.mcp.connectCommand}
              </div>
              <Button onClick={() => copy(dto.mcp.connectCommand)}>Copy</Button>
            </div>
            <Disclosure summary="Connection details" testId="settings-mcp-details">
              <div className="flex flex-col gap-3">
                <div className="font-mono text-[11px] text-ink-mute">{dto.mcp.sampleConfigPath}</div>
                {token === null ? (
                  <div>
                    <Button testId="settings-reveal-token" onClick={() => void revealToken()}>
                      Reveal token
                    </Button>
                  </div>
                ) : (
                  <div className="flex items-start gap-2">
                    <div className="min-w-0 flex-1 rounded-md bg-raised p-3 font-mono text-[12px] break-all">{token}</div>
                    <Button onClick={() => copy(token)}>Copy</Button>
                    <Button onClick={() => setToken(null)}>Hide</Button>
                  </div>
                )}
                <p className="text-[12px] text-ink-mute">
                  {'The token replaces <token> in the command. Treat it like a password.'}
                </p>
              </div>
            </Disclosure>

            {/* ── Phone / other-device access over the local network ─────────── */}
            <div className="mt-1 flex flex-col gap-3 border-t border-line pt-4">
              <div className="flex items-center gap-3">
                <Toggle
                  label="Let a phone or other device on my network connect"
                  testId="settings-lan-toggle"
                  checked={dto.mcp.lanAccess}
                  disabled={lanBusy}
                  onChange={handleLanToggle}
                />
                <span className="text-[13px]">{dto.mcp.lanAccess ? 'on' : 'off'}</span>
              </div>
              <p className="text-[12px] text-ink-mute">
                Off by default, the app only answers from this computer. Turn this on to continue your work from
                your phone or another device on the same Wi-Fi.
              </p>
              {dto.mcp.lanAccess &&
                (dto.mcp.lanUrl !== null ? (
                  <div className="flex flex-col gap-2">
                    <div className="text-[12px] text-ink-mute">
                      On the other device, point its MCP client at this address (use the same token as above):
                    </div>
                    <div className="flex items-start gap-2">
                      <div
                        className="min-w-0 flex-1 rounded-md bg-raised p-3 font-mono text-[12px] break-all"
                        data-testid="settings-lan-url"
                      >
                        {dto.mcp.lanUrl}
                      </div>
                      <Button onClick={() => copy(dto.mcp.lanUrl ?? '')}>Copy</Button>
                    </div>
                    <p className="text-[12px] text-warn">
                      Anyone on this network who has the token can reach your memory and tools. Keep the token
                      private and turn this off when you are done.
                    </p>
                  </div>
                ) : (
                  <div className="text-[12px] text-warn" data-testid="settings-lan-restart">
                    Restart the app to start listening on your network.
                  </div>
                ))}
            </div>
          </div>
        </SettingsSection>

        {/* ── Advanced reasoning (subscription runner) ─────────────────────── */}
        <SettingsSection
          id="reasoning"
          title="Advanced reasoning"
          blurb="Optional: let background work reason with your Claude subscription instead of a paid API key. Off by default."
          innerRef={registerSection('reasoning')}
        >
          <Disclosure summary="Set up subscription reasoning" testId="settings-runner-advanced">
            <div className="flex flex-col gap-3">
              <div className="flex items-center gap-3">
                <Toggle
                  label="enable subscription runner"
                  testId="settings-runner-enable"
                  checked={runnerCfg.enabled}
                  disabled={runnerBusy}
                  onChange={handleRunnerToggle}
                />
                <span className="text-[13px]">{runnerCfg.enabled ? 'on' : 'off'}</span>
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
                    <Badge
                      status={runnerStatus.data.state}
                      label={plainStatus(runnerStatus.data.state).label}
                      title={plainStatus(runnerStatus.data.state).explain}
                    />
                    {runnerStatus.data.version !== null && (
                      <span className="font-mono text-[11px] text-ink-mute">
                        cli {runnerStatus.data.version}
                        {runnerStatus.data.versionOk ? '' : ' (unsupported)'}
                      </span>
                    )}
                    {runnerStatus.data.lastRun !== null && (
                      <span className="flex items-center gap-1.5 font-mono text-[11px] text-ink-mute">
                        last run
                        <Timestamp iso={runnerStatus.data.lastRun.startedAt} />
                        {runnerStatus.data.lastRun.durationMs !== null
                          ? `· ${runnerStatus.data.lastRun.durationMs}ms`
                          : ''}
                      </span>
                    )}
                  </div>
                  <div className="font-mono text-[11px] break-all text-ink-mute">
                    {runnerStatus.data.binaryPath ?? 'claude cli not found on PATH'}
                  </div>
                  {runnerStatus.data.lastError !== null && runnerStatus.data.lastError !== '' && (
                    <div className="font-mono text-[11px] break-words text-err">{runnerStatus.data.lastError}</div>
                  )}
                </div>
              )}

              <div className="flex items-center gap-2.5">
                <Button testId="settings-runner-test" disabled={testing} onClick={() => void testRunnerConnection()}>
                  {testing ? 'Testing…' : 'Test connection'}
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
              <div className="text-[12px] text-ink-mute">
                Test connection runs one manual check against the Claude CLI. It is never scheduled. Usage history
                and the run log aren&apos;t shown here yet.
              </div>
            </div>
          </Disclosure>
        </SettingsSection>

        {/* ── updates ──────────────────────────────────────────────────────── */}
        <SettingsSection
          id="updates"
          title="Updates"
          blurb="Check for and install new versions of the app."
          testId="settings-updates"
          innerRef={registerSection('updates')}
        >
          <div className="flex flex-col gap-3">
            <div className="flex items-center gap-2.5">
              <span className="text-[13px]">current version</span>
              <span className="font-mono text-[12px] text-ink-mute">v{appStatus.data?.version ?? '…'}</span>
              {updState !== 'idle' && updState !== 'disabled' && (
                <Badge status={updState} label={plainStatus(updState).label} title={plainStatus(updState).explain} />
              )}
            </div>

            {/* Status line per state. */}
            {updState === 'disabled' && (
              <p className="text-[12px] text-ink-mute" role="status">
                {updater?.detail ?? 'Automatic updates only run in the installed app.'}
              </p>
            )}
            {updState === 'checking' && (
              <p className="text-[12px] text-ink-mute" role="status">
                Checking for a newer version…
              </p>
            )}
            {updState === 'up-to-date' && (
              <p className="text-[12px] text-ink-mute" role="status">
                You&apos;re up to date{updater?.version !== undefined ? ` (v${updater.version})` : ''}.
              </p>
            )}
            {updState === 'error' && (
              <div className="font-mono text-[11px] break-words text-err" role="alert">
                {updater?.error !== undefined && updater.error !== ''
                  ? updater.error
                  : 'The update check failed — try again later.'}
              </div>
            )}

            {/* Live download progress (percent + MB/s from the push events). */}
            {updState === 'downloading' && (
              <div className="flex flex-col gap-1.5" role="status" data-testid="updater-progress">
                <div className="flex items-center justify-between font-mono text-[11px] text-ink-mute">
                  <span>Downloading{updater?.version !== undefined ? ` v${updater.version}` : ''}…</span>
                  <span>
                    {updPercent}%{updater?.bytesPerSecond !== undefined ? ` · ${mbPerSec(updater.bytesPerSecond)}` : ''}
                  </span>
                </div>
                <ProgressBar percent={updPercent} label={`downloading ${updPercent}%`} />
              </div>
            )}

            {updState === 'downloaded' && (
              <p className="text-[12px] text-ink-mute" role="status">
                Version{updater?.version !== undefined ? ` v${updater.version}` : ''} is downloaded and ready to
                install.
              </p>
            )}

            {/* Restart held because a BACKGROUND JOB is running — say so plainly
                and offer to pause it and restart now (the update otherwise applies
                when the job finishes and the app next closes). */}
            {updState === 'downloaded' &&
              updater?.installDeferred === true &&
              updater.blockedByTaskId !== undefined && (
                <div
                  className="flex flex-col gap-2 rounded-md border border-warn/40 bg-warn/10 px-3 py-2"
                  data-testid="updater-blocked-job"
                >
                  <p className="text-[12px] leading-5">
                    The app didn&apos;t restart because a background job is running{' '}
                    (<span className="font-mono text-[11px]">{updater.blockedByTaskId}</span>). It&apos;ll update on its
                    own once the job finishes and you close the app — or pause the job and restart now (you can resume
                    the job from Jobs afterwards).
                  </p>
                  <div>
                    <Button
                      variant="primary"
                      testId="updater-pause-restart"
                      disabled={pausingRestart}
                      onClick={() => void installUpdate(true)}
                    >
                      {pausingRestart ? 'Pausing…' : 'Pause the job & restart'}
                    </Button>
                  </div>
                </div>
              )}

            {/* Install deferred (§21.9 quiesce): a write was in flight, so we did
                not interrupt it — the update applies on the next quit. */}
            {updState === 'downloaded' &&
              updater?.installDeferred === true &&
              updater.blockedByTaskId === undefined && (
                <p
                  className="rounded-md border border-warn/40 bg-warn/10 px-3 py-2 text-[12px] leading-5"
                  role="status"
                  data-testid="updater-deferred"
                >
                  {updater.detail ?? 'The app is finishing a write — the update will install when you next close it.'}
                </p>
              )}

            {/* What's new — the release notes for the update being downloaded /
                ready to install, so the user can read them before restarting.
                Collapsed by default; hidden entirely when the release carries no
                notes (the common case while the repo is private → today's UI). */}
            {(updState === 'downloading' || updState === 'downloaded') &&
              updater?.releaseNotes !== undefined &&
              updater.releaseNotes.trim() !== '' && (
                <Disclosure
                  key={updater.version ?? 'notes'}
                  summary={`What's new${updater.version !== undefined ? ` in v${updater.version}` : ''}`}
                  testId="updater-release-notes"
                >
                  <div className="flex flex-col gap-2">
                    {releaseNotesHeader(updater) !== null && (
                      <div className="text-[11px] text-ink-mute">{releaseNotesHeader(updater)}</div>
                    )}
                    <div className="max-h-64 overflow-y-auto">
                      <ReleaseNotes text={updater.releaseNotes} />
                    </div>
                  </div>
                </Disclosure>
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
                    {updBusy ? 'Checking…' : 'Check for updates'}
                  </Button>
                ) : !confirmRestart ? (
                  <Button
                    variant="primary"
                    testId="settings-restart-update"
                    onClick={() => setConfirmRestart(true)}
                  >
                    Restart to update
                  </Button>
                ) : (
                  <div className="flex flex-wrap items-center gap-2.5" data-testid="updater-restart-confirm">
                    <span className="text-[12px]">
                      Restart now to install{updater?.version !== undefined ? ` v${updater.version}` : ''}?
                    </span>
                    <Button variant="primary" testId="settings-restart-confirm" onClick={() => void installUpdate()}>
                      Restart
                    </Button>
                    <Button testId="settings-restart-cancel" onClick={() => setConfirmRestart(false)}>
                      Not now
                    </Button>
                  </div>
                )}
              </div>
            )}
            <p className="text-[12px] text-ink-mute">
              Updates download in the background and finish applying the next time the app restarts.
            </p>
          </div>
        </SettingsSection>

        {/* ── data & backups ───────────────────────────────────────────────── */}
        <SettingsSection
          id="backups"
          title="Data & backups"
          blurb="A backup is a snapshot of everything the assistant knows. Snapshot now, restore to an earlier point, or start fresh."
          testId="settings-backups"
          innerRef={registerSection('backups')}
        >
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
                  Back up now
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
                    Back up &amp; restart
                  </Button>
                  <Button disabled={restarting} onClick={() => setConfirmBackup(false)}>
                    Cancel
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
                  Save
                </Button>
              </div>
              <p className="text-[12px] text-ink-mute">
                Only automatic backups are pruned by these limits — manual backups and the safety snapshots taken
                before a restore or reset are kept forever. Automatic backups are created at app startup when one is
                due (the memory graph can only be snapshotted safely while the app is not holding it open).
              </p>
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
                      <Badge status={b.kind} label={plainStatus(b.kind).label} title={plainStatus(b.kind).explain} />
                      {b.createdAt !== null ? (
                        <Timestamp iso={b.createdAt} />
                      ) : (
                        <span className="font-mono text-[11px] text-ink-mute">{b.dirName}</span>
                      )}
                      <span className="font-mono text-[11px] text-ink-mute">
                        {plainBytes(b.bytes)} · {b.files} files
                      </span>
                      <div className="ml-auto">
                        {!b.restorable ? (
                          <span className="text-[12px] text-ink-mute">not restorable</span>
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
                              Restore &amp; restart
                            </Button>
                            <Button disabled={restarting} onClick={() => setRestoreConfirm(null)}>
                              Cancel
                            </Button>
                          </div>
                        ) : (
                          <Button
                            testId={`backups-restore-${b.dirName}`}
                            disabled={restarting}
                            onClick={() => setRestoreConfirm(b.dirName)}
                          >
                            Restore
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
                {exporting ? 'Exporting…' : 'Export data…'}
              </Button>
              {exportPath !== null && (
                <span className="font-mono text-[11px] break-all text-ink-mute" data-testid="data-export-path">
                  exported to {exportPath}
                </span>
              )}
              <span className="text-[12px] text-ink-mute">
                A portable copy: the graph as csv + cypher, appdata, and settings (api keys are never exported).
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
                  Reset all data…
                </Button>
              </div>
            </div>
          </div>
        </SettingsSection>

        {/* ── automation hooks (session-end hook) ──────────────────────────── */}
        <SettingsSection
          id="hooks"
          title="Automation hooks"
          blurb="Automatically hand finished Claude Code sessions to this app so it can learn from them."
          innerRef={registerSection('hooks')}
        >
          <div className="flex flex-col gap-3">
            <p className="text-[12px] text-ink-mute">
              {hookStatus.data === null
                ? 'Checking ~/.claude/settings.json…'
                : hookStatus.data.hook.installed === true
                  ? 'Installed — finished sessions are sent here automatically when they end.'
                  : hookStatus.data.hook.installed === false
                    ? 'Not installed — one click merges the hook into ~/.claude/settings.json (existing hooks are preserved; a backup is written first).'
                    : 'Status unknown — settings.json could not be read.'}
            </p>
            <div>
              <Button
                variant="primary"
                testId="settings-install-hook"
                disabled={installingHook}
                onClick={() => void installHook()}
              >
                {installingHook
                  ? 'Installing…'
                  : hookStatus.data?.hook.installed === true
                    ? 'Reinstall / repair hook'
                    : 'Install hook'}
              </Button>
            </div>
            {hookResult !== null && (
              <div className="flex flex-col gap-2" data-testid="hook-install-result">
                <div className="text-[12px]">
                  {hookResult.changed
                    ? `Settings updated${hookResult.backupPath !== null ? ` (backup: ${hookResult.backupPath})` : ''}.`
                    : 'Already installed — nothing changed.'}
                </div>
                {hookResult.diff !== '' && (
                  <Disclosure summary="See what changed" testId="settings-hook-diff">
                    <pre className="max-h-56 overflow-y-auto font-mono text-[11px] whitespace-pre-wrap">
                      {hookResult.diff}
                    </pre>
                  </Disclosure>
                )}
              </div>
            )}
            <p className="text-[12px] text-ink-mute">
              If the app is closed when a session ends, the hook saves it and it is picked up at the next launch. The
              fallback for other MCP clients is 30 minutes of quiet in the call log.
            </p>
          </div>
        </SettingsSection>
      </div>

      {consentOpen && (
        <Modal
          title="enable subscription runner"
          onClose={() => setConsentOpen(false)}
          footer={
            <>
              <Button onClick={() => setConsentOpen(false)}>Cancel</Button>
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

      {sensitiveConsentOpen && (
        <Modal
          title="allow sensitive work to leave this computer"
          onClose={() => setSensitiveConsentOpen(false)}
          footer={
            <>
              <Button onClick={() => setSensitiveConsentOpen(false)}>Cancel</Button>
              <Button
                variant="primary"
                testId="ai-processing-sensitive-consent-confirm"
                disabled={!sensitiveAck}
                onClick={confirmSensitiveConsent}
              >
                Allow
              </Button>
            </>
          }
        >
          <div className="flex flex-col gap-3 text-[13px] leading-6" data-testid="ai-processing-sensitive-consent">
            <p>
              Some background work handles raw session text: the transcripts of your sessions and the content the
              safety scanner reviews. By default this work always runs on this computer, even when everything else
              uses the cloud or your subscription.
            </p>
            <p>
              Allow it to leave, and that raw text is sent to whichever service you chose above — your cloud API
              provider, or Anthropic under your Claude subscription — the same place your other background reasoning
              already goes.
            </p>
            <p className="text-ink-mute">
              Your memory graph, embeddings, and search index never leave your machine. You can turn this back off at
              any time.
            </p>
            <label className="mt-1 flex items-center gap-2 text-[12px]">
              <input
                type="checkbox"
                aria-label="I understand sensitive text will leave this computer"
                data-testid="ai-processing-sensitive-consent-ack"
                checked={sensitiveAck}
                onChange={(e) => setSensitiveAck(e.target.checked)}
                className="size-3.5"
                style={{ accentColor: 'var(--color-accent)' }}
              />
              <span>I understand what leaves this computer.</span>
            </label>
          </div>
        </Modal>
      )}

      {lanConsentOpen && (
        <Modal
          title="let a phone or other device connect"
          onClose={() => setLanConsentOpen(false)}
          footer={
            <>
              <Button onClick={() => setLanConsentOpen(false)}>Cancel</Button>
              <Button
                variant="primary"
                testId="settings-lan-consent-confirm"
                disabled={!lanAck}
                onClick={confirmLanConsent}
              >
                Allow
              </Button>
            </>
          }
        >
          <div className="flex flex-col gap-3 text-[13px] leading-6" data-testid="settings-lan-consent">
            <p>
              By default this app only answers requests from this computer. Turn this on and it will also listen on
              your local network, so a phone or another device on the same Wi-Fi can connect and continue your work.
            </p>
            <p className="text-warn">
              Anyone on this network who has your connection token could reach your memory and tools. Only do this on
              a network you trust, keep the token private, and turn it back off when you are done.
            </p>
            <p className="text-ink-mute">
              This takes effect after you restart the app. You can turn it back off at any time.
            </p>
            <label className="mt-1 flex items-center gap-2 text-[12px]">
              <input
                type="checkbox"
                aria-label="I understand this exposes the app to my local network"
                data-testid="settings-lan-consent-ack"
                checked={lanAck}
                onChange={(e) => setLanAck(e.target.checked)}
                className="size-3.5"
                style={{ accentColor: 'var(--color-accent)' }}
              />
              <span>I understand this opens access to my local network.</span>
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
              <Button onClick={closeKeyModal}>Cancel</Button>
              <Button
                variant="primary"
                testId="settings-key-save"
                disabled={keySaving || keyValue.trim() === ''}
                onClick={() => void saveKey()}
              >
                Save
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
          <p className="mt-2 text-[12px] text-ink-mute">Encrypted on this computer; never shown again or written to a log.</p>
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
                Cancel
              </Button>
              <Button
                variant="danger"
                testId="data-reset-confirm"
                disabled={restarting || resetText !== 'RESET'}
                onClick={() => void resetData()}
              >
                Reset &amp; restart
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
