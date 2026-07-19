/**
 * Automation editor (phase 31) — the create/edit form for a user rule. A
 * trigger builder (time / file-or-folder / web page) + an action picker
 * (built-in job / your own sandboxed code) with live, debounced validation
 * against the single backend validator (`rules.validate`), so a bad cron or a
 * missing entry is flagged inline before Save is ever enabled.
 *
 * Everything runs main-side over typed IPC (renderer stays Node-free): the
 * form assembles a plain-JSON draft and never touches the filesystem, croner,
 * or zod itself. A code rule authored here still gets NO standing grants — its
 * writes/network/spend queue in Approvals (the pinned copy says so).
 */
import { useEffect, useMemo, useState } from 'react'
import { call, IpcError } from '../../lib/ipc'
import { Button, Select, TextInput, Toggle, useToast } from '../../ui/kit'
import { buildCron, matchCronPreset, WEEKDAY_NAMES, type CronPreset } from '../../lib/cron'
import { IPC_RULE_PRESETS } from '../../../../shared/ipc'
import type { RuleDetailDto, RuleMutationDto, RuleValidationDto } from '../../../../shared/ipc'

type TriggerKind = 'schedule' | 'file' | 'url'
type ActionMode = 'preset' | 'code'
type ScheduleMode = 'hourly' | 'daily' | 'weekly' | 'custom'

const LANG_OPTIONS = [
  { value: 'ts', label: 'TypeScript (Deno sandbox)' },
  { value: 'js', label: 'JavaScript (Deno sandbox)' },
  { value: 'py', label: 'Python (Docker sandbox)' },
  { value: 'sh', label: 'Shell (Docker sandbox)' }
]

const splitList = (raw: string): string[] =>
  raw
    .split(/[,\n]/)
    .map((x) => x.trim())
    .filter((x) => x !== '')

const asObject = (value: unknown): Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {}

const hostOf = (url: string): string => {
  try {
    return new URL(url).host.toLowerCase()
  } catch {
    return ''
  }
}

const dedupe = (items: string[]): string[] => [...new Set(items.filter((x) => x !== ''))]

interface CapsState {
  fsRead: string
  fsWrite: string
  netDomains: string
  tools: string
  maxSpendUSD: string
}

const capsToList = (value: unknown): string => {
  const arr = Array.isArray(value) ? value.filter((x): x is string => typeof x === 'string') : []
  return arr.join(', ')
}

export interface AutomationEditorProps {
  /** null = create a new automation; otherwise edit this one. */
  readonly initial: RuleDetailDto | null
  readonly watchedFolders: readonly { readonly name: string }[]
  readonly dockerAvailable: boolean
  readonly onClose: () => void
  readonly onSaved: (mutation: RuleMutationDto) => void
}

export function AutomationEditor({
  initial,
  watchedFolders,
  dockerAvailable,
  onClose,
  onSaved
}: AutomationEditorProps): React.JSX.Element {
  const toast = useToast()
  const editing = initial !== null
  const rawInitial = useMemo(() => asObject(initial?.raw), [initial])
  const rawTrigger = useMemo(() => asObject(rawInitial['trigger']), [rawInitial])
  const rawAction = useMemo(() => asObject(rawInitial['action']), [rawInitial])
  const rawCaps = useMemo(() => asObject(rawInitial['capabilities']), [rawInitial])

  // ── seed state ──────────────────────────────────────────────────────────────
  const [id, setId] = useState(() => initial?.id ?? '')

  const seededTriggerKind: TriggerKind =
    initial === null
      ? 'schedule'
      : initial.trigger.type === 'schedule'
        ? 'schedule'
        : 'path' in initial.trigger
          ? 'file'
          : 'url'
  const [triggerKind, setTriggerKind] = useState<TriggerKind>(seededTriggerKind)

  const seededCron = initial !== null && initial.trigger.type === 'schedule' ? initial.trigger.cron : '0 9 * * *'
  const seededPreset = matchCronPreset(seededCron)
  const [scheduleMode, setScheduleMode] = useState<ScheduleMode>(seededPreset.kind)
  const [hour, setHour] = useState(seededPreset.kind === 'daily' || seededPreset.kind === 'weekly' ? seededPreset.hour : 9)
  const [minute, setMinute] = useState(seededPreset.kind === 'daily' || seededPreset.kind === 'weekly' ? seededPreset.minute : 0)
  const [dayOfWeek, setDayOfWeek] = useState(seededPreset.kind === 'weekly' ? seededPreset.dayOfWeek : 1)
  const [customCron, setCustomCron] = useState(seededCron)

  const [watchPath, setWatchPath] = useState(() =>
    initial !== null && initial.trigger.type === 'watch' && 'path' in initial.trigger
      ? String(rawTrigger['path'] ?? initial.trigger.path)
      : ''
  )
  const [watchUrl, setWatchUrl] = useState(() =>
    initial !== null && initial.trigger.type === 'watch' && 'url' in initial.trigger ? initial.trigger.url : ''
  )
  const [intervalMin, setIntervalMin] = useState(() =>
    initial !== null && initial.trigger.type === 'watch' && 'intervalMin' in initial.trigger
      ? String(initial.trigger.intervalMin)
      : '30'
  )

  const [actionMode, setActionMode] = useState<ActionMode>(initial?.action.kind === 'preset' ? 'preset' : initial?.action.kind === 'code' ? 'code' : 'preset')
  const [preset, setPreset] = useState(initial?.action.kind === 'preset' ? initial.action.preset : IPC_RULE_PRESETS[0].id)
  const [presetFolder, setPresetFolder] = useState(
    initial?.action.kind === 'preset' && initial.action.folder !== null ? initial.action.folder : (watchedFolders[0]?.name ?? '')
  )

  const [lang, setLang] = useState(initial?.action.kind === 'code' ? initial.action.lang : 'ts')
  const [entry, setEntry] = useState(() => (initial?.action.kind === 'code' ? String(rawAction['entry'] ?? initial.action.entry) : ''))
  const [condition, setCondition] = useState(initial?.condition ?? '')
  const [caps, setCaps] = useState<CapsState>(() => ({
    fsRead: capsToList(rawCaps['fsRead']),
    fsWrite: capsToList(rawCaps['fsWrite']),
    netDomains: capsToList(rawCaps['netDomains']),
    tools: capsToList(rawCaps['tools']),
    maxSpendUSD: typeof rawCaps['maxSpendUSD'] === 'number' ? String(rawCaps['maxSpendUSD']) : '0'
  }))
  const [enabled, setEnabled] = useState(initial?.enabled ?? true)

  const [validation, setValidation] = useState<RuleValidationDto | null>(null)
  const [saving, setSaving] = useState(false)

  const presetMeta = IPC_RULE_PRESETS.find((p) => p.id === preset) ?? IPC_RULE_PRESETS[0]

  // ── assemble the draft ────────────────────────────────────────────────────────
  const draft = useMemo(() => {
    const trigger =
      triggerKind === 'schedule'
        ? { type: 'schedule', cron: scheduleMode === 'custom' ? customCron.trim() : buildCron(scheduleFrom(scheduleMode, hour, minute, dayOfWeek)) }
        : triggerKind === 'file'
          ? { type: 'watch', path: watchPath.trim() }
          : { type: 'watch', url: watchUrl.trim(), intervalMin: Number(intervalMin) || 0 }

    if (actionMode === 'preset') {
      return {
        id: id.trim(),
        trigger,
        // Conditions gate schedule fires too (the backend evaluates them for
        // every trigger), so emit whenever present — never silently drop one.
        ...(condition.trim() !== '' ? { condition: condition.trim() } : {}),
        // Omit an empty folder so the backend shows the friendly "choose a
        // folder" message rather than a raw min-length schema error.
        action: { kind: 'preset', preset, ...(presetMeta.needsFolder && presetFolder !== '' ? { folder: presetFolder } : {}) },
        ...(enabled ? {} : { enabled: false })
      }
    }
    // Code action: auto-fold the trigger scope into the declared capabilities so
    // a file/url watch validates without the user re-typing what they're watching.
    const derivedRead = triggerKind === 'file' && watchPath.trim() !== '' ? [watchPath.trim()] : []
    const derivedNet = triggerKind === 'url' && hostOf(watchUrl) !== '' ? [hostOf(watchUrl)] : []
    return {
      id: id.trim(),
      trigger,
      ...(condition.trim() !== '' ? { condition: condition.trim() } : {}),
      action: { kind: 'code', lang, entry: entry.trim() },
      capabilities: {
        fsRead: dedupe([...derivedRead, ...splitList(caps.fsRead)]),
        fsWrite: dedupe(splitList(caps.fsWrite)),
        netDomains: dedupe([...derivedNet, ...splitList(caps.netDomains)]),
        tools: dedupe(splitList(caps.tools)),
        maxSpendUSD: Number(caps.maxSpendUSD) || 0
      },
      ...(enabled ? {} : { enabled: false })
    }
  }, [
    triggerKind,
    scheduleMode,
    customCron,
    hour,
    minute,
    dayOfWeek,
    watchPath,
    watchUrl,
    intervalMin,
    actionMode,
    id,
    condition,
    preset,
    presetMeta.needsFolder,
    presetFolder,
    lang,
    entry,
    caps,
    enabled
  ])

  // ── debounced validation ──────────────────────────────────────────────────────
  const draftKey = JSON.stringify(draft)
  useEffect(() => {
    let cancelled = false
    const timer = setTimeout(() => {
      call('rules.validate', { draft, ...(editing && initial !== null ? { currentId: initial.id } : {}) })
        .then((res) => {
          if (!cancelled) setValidation(res)
        })
        .catch(() => {
          if (!cancelled) setValidation(null)
        })
    }, 300)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [draftKey, editing])

  const issueFor = (field: string): string | null => {
    const issue = validation?.issues.find((i) => i.field === field)
    return issue !== undefined ? issue.message : null
  }
  const errors = validation?.issues.filter((i) => i.severity === 'error') ?? []
  const warnings = validation?.issues.filter((i) => i.severity === 'warning') ?? []
  const canSave = validation?.ok === true && !saving && id.trim() !== ''

  const browse = async (kind: 'file' | 'folder', set: (path: string) => void): Promise<void> => {
    try {
      const picked = await call('ingest.pick', { kind })
      if (picked.path !== null) set(picked.path)
    } catch (err) {
      toast.notify('err', err instanceof IpcError ? err.message : String(err))
    }
  }

  const save = async (): Promise<void> => {
    setSaving(true)
    try {
      const res = editing && initial !== null
        ? await call('rules.update', { id: initial.id, draft })
        : await call('rules.create', { draft })
      toast.notify('ok', editing ? `Saved '${res.rule.id}'` : `Created '${res.rule.id}'`)
      onSaved(res)
    } catch (err) {
      toast.notify('err', err instanceof IpcError ? err.message : String(err))
    } finally {
      setSaving(false)
    }
  }

  const fieldError = (field: string): React.JSX.Element | null => {
    const msg = issueFor(field)
    return msg !== null ? <div className="mt-1 text-[11px] text-err">{msg}</div> : null
  }

  const nextRunLine =
    validation?.normalized?.nextRunAt != null ? (
      <div className="mt-1 text-[11px] text-ink-mute">Next run: {new Date(validation.normalized.nextRunAt).toLocaleString()}</div>
    ) : null

  return (
    <>
      {/* ── identity ── */}
      {editing ? (
        <div className="mb-3 flex items-center gap-2 text-[12px] text-ink-mute">
          <span>Automation</span>
          <span className="font-mono text-[12px] text-ink">{id}</span>
          <span>· id can&apos;t change (delete &amp; recreate to rename)</span>
        </div>
      ) : (
        <div className="mb-3">
          <TextInput label="Name (id)" value={id} onChange={setId} placeholder="my-daily-export" mono testId="rule-id" />
          {fieldError('id')}
        </div>
      )}

      {/* ── trigger ── */}
      <div className="mb-4 rounded-md border border-line bg-surface p-3">
        <div className="mb-2 text-[12px] font-medium text-ink">When should this run?</div>
        <Select
          ariaLabel="Trigger type"
          value={triggerKind}
          onChange={(v) => setTriggerKind(v as TriggerKind)}
          options={[
            { value: 'schedule', label: 'On a schedule' },
            { value: 'file', label: 'When a file or folder changes' },
            { value: 'url', label: 'When a web page changes' }
          ]}
        />
        <div className="mt-3 flex flex-col gap-2">
          {triggerKind === 'schedule' && (
            <>
              <Select
                ariaLabel="Schedule"
                value={scheduleMode}
                onChange={(v) => setScheduleMode(v as ScheduleMode)}
                options={[
                  { value: 'hourly', label: 'Every hour' },
                  { value: 'daily', label: 'Every day at…' },
                  { value: 'weekly', label: 'Every week on…' },
                  { value: 'custom', label: 'Custom (cron expression)' }
                ]}
              />
              {(scheduleMode === 'daily' || scheduleMode === 'weekly') && (
                <div className="flex items-end gap-2">
                  {scheduleMode === 'weekly' && (
                    <Select
                      label="Day"
                      value={String(dayOfWeek)}
                      onChange={(v) => setDayOfWeek(Number(v))}
                      options={WEEKDAY_NAMES.map((name, i) => ({ value: String(i), label: name }))}
                    />
                  )}
                  <TextInput label="Hour (0–23)" value={String(hour)} onChange={(v) => setHour(clampInt(v, 0, 23))} width="w-20" />
                  <TextInput label="Minute (0–59)" value={String(minute)} onChange={(v) => setMinute(clampInt(v, 0, 59))} width="w-20" />
                </div>
              )}
              {scheduleMode === 'custom' && (
                <div>
                  <TextInput label="Cron expression" value={customCron} onChange={setCustomCron} placeholder="0 9 * * *" mono testId="rule-cron" />
                  {fieldError('trigger.cron')}
                </div>
              )}
              {nextRunLine}
            </>
          )}
          {triggerKind === 'file' && (
            <div>
              <div className="flex items-end gap-2">
                <div className="flex-1">
                  <TextInput label="File or folder to watch" value={watchPath} onChange={setWatchPath} placeholder="~/Notes" mono testId="rule-watch-path" />
                </div>
                <Button onClick={() => void browse('folder', setWatchPath)}>Folder…</Button>
                <Button onClick={() => void browse('file', setWatchPath)}>File…</Button>
              </div>
              {fieldError('trigger.path')}
            </div>
          )}
          {triggerKind === 'url' && (
            <div className="flex items-end gap-2">
              <div className="flex-1">
                <TextInput label="Web address to poll" value={watchUrl} onChange={setWatchUrl} placeholder="https://example.com/feed" mono testId="rule-watch-url" />
                {fieldError('trigger.url')}
              </div>
              <div>
                <TextInput label="Every (min)" value={intervalMin} onChange={(v) => setIntervalMin(v.replace(/[^0-9]/g, ''))} width="w-24" />
                {fieldError('trigger.intervalMin')}
              </div>
            </div>
          )}
          <div>
            <TextInput
              label="Only run if… (optional)"
              value={condition}
              onChange={setCondition}
              placeholder={triggerKind === 'schedule' ? "firedAt contains '2027'" : "item.title contains 'AI'"}
              mono
            />
            <div className="mt-1 text-[11px] text-ink-mute">
              Grammar: <span className="font-mono">&lt;field.path&gt; contains &apos;text&apos;</span> — checked against the trigger event; leave blank to always run.
            </div>
            {fieldError('condition')}
          </div>
        </div>
      </div>

      {/* ── action ── */}
      <div className="mb-4 rounded-md border border-line bg-surface p-3">
        <div className="mb-2 text-[12px] font-medium text-ink">What should it do?</div>
        <div className="mb-3 flex gap-1.5">
          <Button variant={actionMode === 'preset' ? 'primary' : 'ghost'} onClick={() => setActionMode('preset')} testId="action-preset">
            Run a built-in job
          </Button>
          <Button variant={actionMode === 'code' ? 'primary' : 'ghost'} onClick={() => setActionMode('code')} testId="action-code">
            Run my code
          </Button>
        </div>

        {actionMode === 'preset' ? (
          <div className="flex flex-col gap-2">
            <Select
              ariaLabel="Built-in job"
              value={preset}
              onChange={setPreset}
              options={IPC_RULE_PRESETS.map((p) => ({ value: p.id, label: p.label }))}
            />
            <div className="text-[11px] text-ink-mute">{presetMeta.description}</div>
            {presetMeta.needsFolder && (
              <div>
                {watchedFolders.length === 0 ? (
                  <div className="text-[11px] text-warn">Add a watched folder first (under Watched folders) — this job scans one.</div>
                ) : (
                  <Select
                    label="Folder to scan"
                    value={presetFolder}
                    onChange={setPresetFolder}
                    options={watchedFolders.map((f) => ({ value: f.name, label: f.name }))}
                  />
                )}
                {fieldError('action.folder')}
              </div>
            )}
            <div className="text-[11px] text-ink-mute">Built-in jobs run as the app itself — no code, no extra permissions.</div>
          </div>
        ) : (
          <div className="flex flex-col gap-2">
            <Select label="Language" value={lang} onChange={setLang} options={LANG_OPTIONS} />
            {!dockerAvailable && (lang === 'py' || lang === 'sh') && (
              <div className="text-[11px] text-warn">Docker isn&apos;t available right now — this rule will fail to run until Docker is installed/started.</div>
            )}
            <div className="flex items-end gap-2">
              <div className="flex-1">
                <TextInput label="Script file" value={entry} onChange={setEntry} placeholder={`${id.trim() === '' ? 'my-automation' : id.trim()}.entry.ts`} mono testId="rule-entry" />
              </div>
              <Button onClick={() => void browse('file', setEntry)}>Browse…</Button>
            </div>
            {validation?.normalized?.willScaffoldEntry === true && (
              <div className="text-[11px] text-ink-mute">We&apos;ll create a starter file for you when you save.</div>
            )}
            {fieldError('action.entry')}
            {fieldError('action.lang')}
            <CapabilitiesEditor caps={caps} setCaps={setCaps} onBrowse={browse} issueFor={issueFor} />
          </div>
        )}
      </div>

      {/* ── status + validation summary ── */}
      <div className="mb-4 flex items-center gap-2">
        <Toggle checked={enabled} onChange={setEnabled} label="Enabled" testId="rule-enabled" />
        <span className="text-[12px] text-ink-mute">{enabled ? 'On — will run at its trigger.' : 'Off — saved but paused.'}</span>
      </div>

      {errors.length > 0 && (
        <div className="mb-2 rounded-md border border-err/40 bg-err/10 px-3 py-2 text-[12px] text-err">
          {errors.map((e, i) => (
            <div key={i}>{e.message}</div>
          ))}
        </div>
      )}
      {warnings.length > 0 && (
        <div className="mb-2 rounded-md border border-warn/40 bg-warn/10 px-3 py-2 text-[12px] text-warn">
          {warnings.map((w, i) => (
            <div key={i}>{w.message}</div>
          ))}
        </div>
      )}

      <div className="flex justify-end gap-2 border-t border-line pt-3">
        <Button onClick={onClose}>Cancel</Button>
        <Button variant="primary" disabled={!canSave} onClick={() => void save()} testId="rule-save">
          {saving ? 'Saving…' : editing ? 'Save changes' : 'Create automation'}
        </Button>
      </div>
    </>
  )
}

function CapabilitiesEditor({
  caps,
  setCaps,
  onBrowse,
  issueFor
}: {
  caps: CapsState
  setCaps: (next: CapsState) => void
  onBrowse: (kind: 'file' | 'folder', set: (path: string) => void) => Promise<void>
  issueFor: (field: string) => string | null
}): React.JSX.Element {
  const set = (patch: Partial<CapsState>): void => setCaps({ ...caps, ...patch })
  const appendPath = (field: 'fsRead' | 'fsWrite', path: string): void => {
    const current = caps[field]
    set({ [field]: current.trim() === '' ? path : `${current}, ${path}` } as Partial<CapsState>)
  }
  return (
    <div className="mt-1 rounded-md border border-line bg-bg/40 p-2.5">
      <div className="mb-1 text-[12px] font-medium text-ink">What this code may ask to do</div>
      <div className="mb-2 text-[11px] text-ink-mute">
        Granting a capability does not pre-approve anything — every write, network call, or spend still appears in Approvals for you to decide.
        Separate multiple entries with commas.
      </div>
      <div className="flex flex-col gap-2">
        <div className="flex items-end gap-2">
          <div className="flex-1">
            <TextInput label="Read files/folders" value={caps.fsRead} onChange={(v) => set({ fsRead: v })} placeholder="~/Notes" mono />
          </div>
          <Button onClick={() => void onBrowse('folder', (p) => appendPath('fsRead', p))}>Add…</Button>
        </div>
        <div className="flex items-end gap-2">
          <div className="flex-1">
            <TextInput label="Write files/folders" value={caps.fsWrite} onChange={(v) => set({ fsWrite: v })} placeholder="~/agentic-out" mono />
          </div>
          <Button onClick={() => void onBrowse('folder', (p) => appendPath('fsWrite', p))}>Add…</Button>
        </div>
        {issueFor('capabilities.fsWrite') !== null && <div className="text-[11px] text-err">{issueFor('capabilities.fsWrite')}</div>}
        <TextInput label="Network hosts" value={caps.netDomains} onChange={(v) => set({ netDomains: v })} placeholder="example.com" mono />
        <div className="flex items-end gap-2">
          <TextInput label="Max spend (USD)" value={caps.maxSpendUSD} onChange={(v) => set({ maxSpendUSD: v.replace(/[^0-9.]/g, '') })} width="w-24" />
          <span className="pb-2 text-[11px] text-ink-mute">{Number(caps.maxSpendUSD) > 0 ? `up to $${Number(caps.maxSpendUSD)}` : '$0 — this code may not spend money'}</span>
        </div>
        {issueFor('capabilities') !== null && <div className="text-[11px] text-err">{issueFor('capabilities')}</div>}
      </div>
    </div>
  )
}

function scheduleFrom(mode: ScheduleMode, hour: number, minute: number, dayOfWeek: number): Exclude<CronPreset, { kind: 'custom' }> {
  if (mode === 'hourly') return { kind: 'hourly' }
  if (mode === 'weekly') return { kind: 'weekly', hour, minute, dayOfWeek }
  return { kind: 'daily', hour, minute }
}

function clampInt(raw: string, lo: number, hi: number): number {
  const n = Number(raw.replace(/[^0-9]/g, ''))
  if (!Number.isFinite(n)) return lo
  return Math.max(lo, Math.min(hi, Math.trunc(n)))
}
