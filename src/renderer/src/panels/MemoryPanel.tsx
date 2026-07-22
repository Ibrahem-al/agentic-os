/**
 * Memory panel (phase 10, spec §3 "explore the graph"): browse label counts →
 * paged node lists, hybrid search (vector + keyword + rerank) across the
 * retrievable labels, and a master-detail node inspector with edge navigation
 * and a back stack. VARIANCE 4: two-column 3fr/2fr split, each side scrolls
 * independently.
 *
 * Plain-language redesign: the counts lead with a CompositionBar ("what memory
 * holds") over a labelled list where each category carries a one-line
 * description; search hits read as text + a single "match" meter with the raw
 * ranking signals tucked behind a Disclosure; the inspector leads with the
 * human handle and keeps ids / complex JSON behind "Technical details". The
 * label chip keeps its exact two-span "<Label> <count>" contract (e2e selects
 * it by accessible name); the plain description lives in a SEPARATE element.
 *
 * Feature B (Stage 4): full user CRUD over the graph — an "Add memory" flow
 * (category picker → per-label field form), and inspector-level Edit / Delete
 * (with a plain cascade-count confirm) / Connect to… (edge-type picker filtered
 * to valid §18 pairs + a memory.search target picker) / per-edge remove. Every
 * mutation runs as ONE audited write-lane job (actor user:dashboard), so each is
 * reversible from History; each response carries its auditActionId, so the
 * confirmation toast offers an inline Undo without a History round trip.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import type {
  DedupeScanOptionsDto,
  DedupeScanScope,
  DedupeScanStatusDto,
  IpcEdgeType,
  IpcNodeLabel,
  JsonObject,
  JsonValue,
  MemoryDeleteResultDto,
  MemoryDuplicateGroupDto,
  MemoryEdgeDto,
  MemoryNodeDetailDto,
  MemoryNodeMutationDto,
  MemoryNodeSummaryDto,
  MemorySearchHitDto
} from '../../../shared/ipc'
import { IPC_EDGE_PAIRS, IPC_EDGE_TYPES, IPC_NODE_LABELS } from '../../../shared/ipc'
import type { PanelProps } from '../App'
import { IpcError, call, useIpc } from '../lib/ipc'
import { truncate } from '../lib/format'
import { plainPropLabel, plural } from '../lib/plain'
import { nodeHandle, summarizeNode } from '../lib/nodeSummary'
import {
  Button,
  Confidence,
  DataTable,
  Disclosure,
  EmptyState,
  ErrorState,
  KV,
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
import type { Column } from '../ui/kit'
import { CompositionBar } from '../ui/viz'
import { Icon } from '../ui/icons'

const PAGE_SIZE = 50

/**
 * One plain sentence per graph label so a less technical reader knows what each
 * category actually is. Record over IpcNodeLabel keeps this exhaustive — a new
 * label fails the build until it gets a description here.
 */
const LABEL_DESCRIPTIONS: Readonly<Record<IpcNodeLabel, string>> = {
  Session: 'Past work sessions',
  Project: 'Projects it knows',
  Skill: 'Learned abilities',
  SkillVersion: 'Skill revisions',
  Example: 'Examples it learned from',
  Correction: 'Corrections you made',
  Preference: 'Your preferences',
  MCP: 'Technical building blocks',
  Plugin: 'Technical building blocks',
  Component: 'Technical building blocks',
  Document: 'Documents added',
  Knowledge: 'Facts and notes',
  Tag: 'Labels'
}

// Cycled across the composition segments so adjacent categories stay distinct;
// tokens only (see viz CompTint), never semantic here — memory holds no state.
const COMP_TINTS = ['accent', 'ok', 'warn', 'undo', 'mute'] as const

// ── per-label editable-field map (feature B) ────────────────────────────────────
//
// Renderer-side mirror of the §18 writable node properties MINUS the protected
// keys (id / created_at / updated_at / embedding / extracted_by / confidence),
// which the server owns and this panel never sends. Like IPC_NODE_LABELS this is
// a hand-kept copy; the Record over IpcNodeLabel keeps it exhaustive. It drives
// BOTH the create form and the inspector's edit form.

type FieldType = 'text' | 'longtext' | 'number' | 'boolean'

interface FieldSpec {
  readonly key: string
  readonly label: string
  readonly type: FieldType
  readonly placeholder?: string
}

interface LabelForm {
  /** User-facing category name ("Preference", "Note", "Tag", …). */
  readonly title: string
  /** One-line description shown in the category picker. */
  readonly desc: string
  /** Primary categories lead; the rest hide behind "More types…". */
  readonly primary: boolean
  readonly fields: readonly FieldSpec[]
}

const LABEL_FORMS: Readonly<Record<IpcNodeLabel, LabelForm>> = {
  Preference: {
    title: 'Preference',
    desc: 'Something it should remember about how you work',
    primary: true,
    fields: [{ key: 'statement', label: 'What to remember', type: 'longtext', placeholder: 'e.g. Always run the linter before committing' }]
  },
  Knowledge: {
    title: 'Note',
    desc: 'A fact or note',
    primary: true,
    fields: [{ key: 'content', label: 'The note', type: 'longtext', placeholder: 'e.g. The staging database resets every night at 2am' }]
  },
  Tag: {
    title: 'Tag',
    desc: 'A label to group things',
    primary: true,
    fields: [
      { key: 'name', label: 'Label', type: 'text', placeholder: 'e.g. onboarding' },
      { key: 'is_global', label: 'Available everywhere', type: 'boolean' }
    ]
  },
  Project: {
    title: 'Project',
    desc: 'A project it knows about',
    primary: true,
    fields: [
      { key: 'name', label: 'Name', type: 'text' },
      { key: 'summary', label: 'Summary', type: 'longtext' }
    ]
  },
  Session: {
    title: 'Session',
    desc: 'A past work session',
    primary: false,
    fields: [
      { key: 'transcript_ref', label: 'Transcript reference', type: 'text' },
      { key: 'tier', label: 'Tier', type: 'text', placeholder: 'daily' },
      { key: 'started_at', label: 'Started at', type: 'text', placeholder: 'ISO date/time' },
      { key: 'ended_at', label: 'Ended at', type: 'text', placeholder: 'ISO date/time' }
    ]
  },
  Skill: {
    title: 'Skill',
    desc: 'An ability with standing instructions',
    primary: false,
    fields: [
      { key: 'name', label: 'Name', type: 'text' },
      { key: 'instructions', label: 'What it tells the assistant to do', type: 'longtext' }
    ]
  },
  SkillVersion: {
    title: 'Skill version',
    desc: 'A single revision of a skill',
    primary: false,
    fields: [
      { key: 'instructions', label: 'Instructions', type: 'longtext' },
      { key: 'status', label: 'Status', type: 'text', placeholder: 'candidate / active / retired' },
      { key: 'benchmark_score', label: 'Quality score', type: 'number' }
    ]
  },
  Example: {
    title: 'Example',
    desc: 'An example it learned from',
    primary: false,
    fields: [
      { key: 'kind', label: 'Kind', type: 'text', placeholder: 'success / failure' },
      { key: 'content', label: 'What happened', type: 'longtext' }
    ]
  },
  Correction: {
    title: 'Correction',
    desc: 'A correction you made',
    primary: false,
    fields: [{ key: 'content', label: 'The correction', type: 'longtext' }]
  },
  MCP: {
    title: 'MCP tool',
    desc: 'A technical building block',
    primary: false,
    fields: [
      { key: 'name', label: 'Name', type: 'text' },
      { key: 'config_ref', label: 'Config reference', type: 'text' }
    ]
  },
  Plugin: {
    title: 'Plugin',
    desc: 'A technical building block',
    primary: false,
    fields: [
      { key: 'name', label: 'Name', type: 'text' },
      { key: 'config_ref', label: 'Config reference', type: 'text' }
    ]
  },
  Component: {
    title: 'Component',
    desc: 'A piece of a codebase',
    primary: false,
    fields: [
      { key: 'name', label: 'Name', type: 'text' },
      { key: 'type', label: 'Type', type: 'text', placeholder: 'page / route / service / …' }
    ]
  },
  Document: {
    title: 'Document',
    desc: 'A source document',
    primary: false,
    fields: [
      { key: 'source', label: 'Source', type: 'text' },
      { key: 'content_hash', label: 'Content hash', type: 'text' },
      { key: 'ingested_at', label: 'Added at', type: 'text', placeholder: 'ISO date/time' }
    ]
  }
}

const PRIMARY_LABELS = IPC_NODE_LABELS.filter((l) => LABEL_FORMS[l].primary)
const MORE_LABELS = IPC_NODE_LABELS.filter((l) => !LABEL_FORMS[l].primary)

interface NodeRef {
  readonly label: IpcNodeLabel
  readonly id: string
  /** Human handle carried from the list row / edge so the inspector can lead with it. */
  readonly display?: string
}

interface ListState {
  readonly label: IpcNodeLabel
  readonly rows: readonly MemoryNodeSummaryDto[]
  readonly total: number
  readonly loading: boolean
  readonly error: IpcError | null
}

interface SearchState {
  readonly query: string
  readonly hits: readonly MemorySearchHitDto[] | null
  readonly loading: boolean
  readonly error: IpcError | null
}

function toIpcError(err: unknown): IpcError {
  return err instanceof IpcError ? err : new IpcError('INTERNAL', String(err))
}

function nodeKey(ref: { readonly label: IpcNodeLabel; readonly id: string }): string {
  return `${ref.label}:${ref.id}`
}

/** Raw graph edge/prop token → plain lowercase words ("RELATES_TO" → "relates to"). */
function plainWords(raw: string): string {
  return raw.toLowerCase().replace(/_/g, ' ')
}

// ── form value helpers (feature B) ──────────────────────────────────────────────

type FieldValue = string | boolean
type FormValues = Record<string, FieldValue>

/** Seed a form's values from an existing node's props (blank for create). */
function initialValues(form: LabelForm, props?: JsonObject): FormValues {
  const out: FormValues = {}
  for (const field of form.fields) {
    const raw = props?.[field.key]
    if (field.type === 'boolean') out[field.key] = raw === true
    else if (raw === null || raw === undefined) out[field.key] = ''
    else out[field.key] = typeof raw === 'string' ? raw : String(raw)
  }
  return out
}

function asText(value: FieldValue | undefined): string {
  return typeof value === 'string' ? value : value === undefined ? '' : String(value)
}

/** The first text field carries the human handle — a create needs it non-empty. */
function hasHandle(form: LabelForm, values: FormValues): boolean {
  const first = form.fields[0]
  if (first === undefined) return false
  if (first.type === 'boolean') return true
  return asText(values[first.key]).trim() !== ''
}

/** Props for a create: skip blanks; parse numbers; booleans always ride. */
function buildCreateProps(form: LabelForm, values: FormValues): JsonObject {
  const props: JsonObject = {}
  for (const field of form.fields) {
    const value = values[field.key]
    if (field.type === 'boolean') {
      props[field.key] = value === true
    } else if (field.type === 'number') {
      const trimmed = asText(value).trim()
      if (trimmed === '') continue
      const num = Number(trimmed)
      if (Number.isFinite(num)) props[field.key] = num
    } else {
      const text = asText(value)
      if (text.trim() !== '') props[field.key] = text
    }
  }
  return props
}

/** Props for an edit: only CHANGED fields (upsert merges; empty text clears). */
function buildEditProps(form: LabelForm, values: FormValues, initial: FormValues): JsonObject {
  const props: JsonObject = {}
  for (const field of form.fields) {
    const value = values[field.key]
    if (field.type === 'boolean') {
      if ((value === true) !== (initial[field.key] === true)) props[field.key] = value === true
      continue
    }
    const text = asText(value)
    if (text === asText(initial[field.key])) continue
    if (field.type === 'number') {
      const trimmed = text.trim()
      if (trimmed === '') continue // never clear a number from the dashboard
      const num = Number(trimmed)
      if (Number.isFinite(num)) props[field.key] = num
    } else {
      props[field.key] = text
    }
  }
  return props
}

// ── prop rendering ────────────────────────────────────────────────────────────

function renderPropValue(key: string, value: JsonValue): ReactNode {
  if ((key === 'created_at' || key === 'updated_at') && typeof value === 'string') {
    return <Timestamp iso={value} />
  }
  if (typeof value === 'string') {
    return <span className="font-mono text-[12px] break-words whitespace-pre-wrap">{value}</span>
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return <span className="font-mono text-[12px]">{String(value)}</span>
  }
  return (
    <span className="font-mono text-[12px] break-words whitespace-pre-wrap">{JSON.stringify(value)}</span>
  )
}

// ── shared field form (create + edit) ───────────────────────────────────────────

function FieldInput({
  field,
  value,
  onChange
}: {
  field: FieldSpec
  value: FieldValue | undefined
  onChange: (value: FieldValue) => void
}): React.JSX.Element {
  const testId = `memory-field-${field.key}`
  if (field.type === 'boolean') {
    return (
      <div className="flex items-center justify-between gap-3">
        <span className="text-[12px] text-ink-mute">{field.label}</span>
        <Toggle checked={value === true} onChange={onChange} label={field.label} testId={testId} />
      </div>
    )
  }
  if (field.type === 'longtext') {
    return (
      <label className="flex flex-col gap-1">
        <span className="text-[12px] text-ink-mute">{field.label}</span>
        <textarea
          data-testid={testId}
          aria-label={field.label}
          value={asText(value)}
          onChange={(e) => onChange(e.target.value)}
          rows={4}
          {...(field.placeholder !== undefined ? { placeholder: field.placeholder } : {})}
          className="rounded-md border border-line-strong bg-raised px-2.5 py-2 text-[13px] leading-5 text-ink placeholder:text-ink-mute focus:border-accent focus:outline-none transition-colors duration-120"
        />
      </label>
    )
  }
  return (
    <TextInput
      label={field.label}
      value={asText(value)}
      onChange={onChange}
      testId={testId}
      mono={field.type === 'number'}
      {...(field.placeholder !== undefined ? { placeholder: field.placeholder } : {})}
    />
  )
}

function NodeFields({
  label,
  values,
  onChange
}: {
  label: IpcNodeLabel
  values: FormValues
  onChange: (key: string, value: FieldValue) => void
}): React.JSX.Element {
  const form = LABEL_FORMS[label]
  return (
    <div className="flex flex-col gap-3">
      {label === 'Skill' && (
        <p className="rounded-md bg-raised px-3 py-2 text-[12px] leading-5 text-ink-mute">
          Editing a skill here changes its instructions, not its saved versions. To manage versions or improve
          it, use the Skills panel.
        </p>
      )}
      {form.fields.map((field) => (
        <FieldInput key={field.key} field={field} value={values[field.key]} onChange={(value) => onChange(field.key, value)} />
      ))}
    </div>
  )
}

// ── add-memory flow (category picker → form) ────────────────────────────────────

function CategoryButton({
  label,
  onPick
}: {
  label: IpcNodeLabel
  onPick: (label: IpcNodeLabel) => void
}): React.JSX.Element {
  const form = LABEL_FORMS[label]
  return (
    <button
      type="button"
      data-testid={`memory-add-label-${label}`}
      onClick={() => onPick(label)}
      className="flex w-full cursor-pointer flex-col gap-0.5 rounded-md border border-line px-3 py-2 text-left transition-colors duration-120 hover:bg-raised focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
    >
      <span className="text-[13px] text-ink">{form.title}</span>
      <span className="text-[12px] text-ink-mute">{form.desc}</span>
    </button>
  )
}

function AddMemoryModal({
  onClose,
  onCreated
}: {
  onClose: () => void
  onCreated: (result: MemoryNodeMutationDto) => void
}): React.JSX.Element {
  const toast = useToast()
  const [label, setLabel] = useState<IpcNodeLabel | null>(null)
  const [values, setValues] = useState<FormValues>({})
  const [busy, setBusy] = useState(false)

  const pick = useCallback((next: IpcNodeLabel) => {
    setLabel(next)
    setValues(initialValues(LABEL_FORMS[next]))
  }, [])

  const form = label !== null ? LABEL_FORMS[label] : null
  const props = form !== null ? buildCreateProps(form, values) : {}
  const skillReady = label !== 'Skill' || asText(values['instructions']).trim() !== ''
  const canSubmit = form !== null && hasHandle(form, values) && skillReady

  async function submit(): Promise<void> {
    if (label === null) return
    setBusy(true)
    try {
      const result = await call('memory.node.create', { label, props })
      onCreated(result)
      onClose()
    } catch (err) {
      toast.notify('err', toIpcError(err).message)
    } finally {
      setBusy(false)
    }
  }

  if (label === null || form === null) {
    return (
      <Modal title="Add to memory" onClose={onClose} footer={<Button onClick={onClose}>Cancel</Button>}>
        <p className="mb-2 text-[12px] text-ink-mute">What would you like it to remember?</p>
        <div className="flex flex-col gap-2">
          {PRIMARY_LABELS.map((l) => (
            <CategoryButton key={l} label={l} onPick={pick} />
          ))}
        </div>
        <div className="mt-3">
          <Disclosure summary="More types…" testId="memory-add-more">
            <div className="flex flex-col gap-2">
              {MORE_LABELS.map((l) => (
                <CategoryButton key={l} label={l} onPick={pick} />
              ))}
            </div>
          </Disclosure>
        </div>
      </Modal>
    )
  }

  return (
    <Modal
      title={`New ${form.title.toLowerCase()}`}
      onClose={onClose}
      footer={
        <>
          <Button disabled={busy} onClick={() => setLabel(null)}>
            Back
          </Button>
          <Button variant="primary" testId="memory-add-submit" disabled={busy || !canSubmit} onClick={() => void submit()}>
            Add to memory
          </Button>
        </>
      }
    >
      <NodeFields label={label} values={values} onChange={(key, value) => setValues((old) => ({ ...old, [key]: value }))} />
    </Modal>
  )
}

// ── edit-memory modal ───────────────────────────────────────────────────────────

function EditMemoryModal({
  node,
  onClose,
  onSaved
}: {
  node: MemoryNodeDetailDto
  onClose: () => void
  onSaved: (result: MemoryNodeMutationDto) => void
}): React.JSX.Element {
  const toast = useToast()
  const form = LABEL_FORMS[node.label]
  const initial = useMemo(() => initialValues(form, node.props), [form, node.props])
  const [values, setValues] = useState<FormValues>(initial)
  const [busy, setBusy] = useState(false)

  const props = buildEditProps(form, values, initial)
  const canSubmit = Object.keys(props).length > 0

  async function submit(): Promise<void> {
    setBusy(true)
    try {
      const result = await call('memory.node.update', { label: node.label, id: node.id, props })
      onSaved(result)
      onClose()
    } catch (err) {
      toast.notify('err', toIpcError(err).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal
      title={`Edit ${form.title.toLowerCase()}`}
      onClose={onClose}
      footer={
        <>
          <Button disabled={busy} onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" testId="memory-edit-submit" disabled={busy || !canSubmit} onClick={() => void submit()}>
            Save changes
          </Button>
        </>
      }
    >
      <NodeFields label={node.label} values={values} onChange={(key, value) => setValues((old) => ({ ...old, [key]: value }))} />
    </Modal>
  )
}

// ── delete confirm (with plain cascade counts) ──────────────────────────────────

function DeleteConfirmModal({
  node,
  onClose,
  onDeleted
}: {
  node: MemoryNodeDetailDto
  onClose: () => void
  onDeleted: (result: MemoryDeleteResultDto) => void
}): React.JSX.Element {
  const toast = useToast()
  const [busy, setBusy] = useState(false)

  // Cascade counts come straight from the node's own outgoing edges (§ backend
  // delete): a Document takes its HAS_CHUNK chunks; a Skill its HAS_VERSION versions.
  const chunkCount = node.outgoing.filter((e) => e.type === 'HAS_CHUNK').length
  const versionCount = node.outgoing.filter((e) => e.type === 'HAS_VERSION').length
  const cascade =
    node.label === 'Document' && chunkCount > 0
      ? `This also removes its ${plural(chunkCount, 'saved chunk')}.`
      : node.label === 'Skill' && versionCount > 0
        ? `This also removes its ${plural(versionCount, 'version')}.`
        : null

  async function confirm(): Promise<void> {
    setBusy(true)
    try {
      const result = await call('memory.node.delete', { label: node.label, id: node.id })
      onDeleted(result)
      onClose()
    } catch (err) {
      toast.notify('err', toIpcError(err).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal
      title="Delete this?"
      onClose={onClose}
      footer={
        <>
          <Button disabled={busy} onClick={onClose}>
            Cancel
          </Button>
          <Button variant="danger" testId="memory-delete-confirm" disabled={busy} onClick={() => void confirm()}>
            Delete
          </Button>
        </>
      }
    >
      <div className="text-[13px]">Delete this {LABEL_FORMS[node.label].title.toLowerCase()} from memory?</div>
      {cascade !== null && <p className="mt-2 text-[12px] leading-5 text-warn">{cascade}</p>}
      <p className="mt-2 text-[12px] leading-5 text-ink-mute">You can undo this from History right after.</p>
    </Modal>
  )
}

// ── connect to… (edge-type picker + memory.search target picker) ────────────────

interface ConnectOption {
  readonly key: string
  readonly type: IpcEdgeType
  readonly direction: 'out' | 'in'
  readonly otherLabels: readonly IpcNodeLabel[]
  readonly optionLabel: string
}

/** Valid edge options for a node in BOTH directions (from §18 IPC_EDGE_PAIRS). */
function connectOptionsFor(label: IpcNodeLabel): ConnectOption[] {
  const acc = new Map<string, { type: IpcEdgeType; direction: 'out' | 'in'; others: Set<IpcNodeLabel> }>()
  for (const type of IPC_EDGE_TYPES) {
    for (const [from, to] of IPC_EDGE_PAIRS[type]) {
      if (from === label) {
        const key = `${type}:out`
        const entry = acc.get(key) ?? { type, direction: 'out' as const, others: new Set<IpcNodeLabel>() }
        entry.others.add(to)
        acc.set(key, entry)
      }
      if (to === label) {
        const key = `${type}:in`
        const entry = acc.get(key) ?? { type, direction: 'in' as const, others: new Set<IpcNodeLabel>() }
        entry.others.add(from)
        acc.set(key, entry)
      }
    }
  }
  return [...acc.values()].map((entry) => {
    const others = [...entry.others]
    const rel = plainWords(entry.type)
    const optionLabel =
      entry.direction === 'out' ? `${rel}: this → ${others.join(' / ')}` : `${rel}: ${others.join(' / ')} → this`
    return { key: `${entry.type}:${entry.direction}`, type: entry.type, direction: entry.direction, otherLabels: others, optionLabel }
  })
}

function ConnectModal({
  node,
  onClose,
  onConnected
}: {
  node: MemoryNodeDetailDto
  onClose: () => void
  onConnected: (auditActionId: string) => void
}): React.JSX.Element {
  const toast = useToast()
  const options = useMemo(() => connectOptionsFor(node.label), [node.label])
  const [optKey, setOptKey] = useState(options[0]?.key ?? '')
  const [query, setQuery] = useState('')
  const [hits, setHits] = useState<readonly MemorySearchHitDto[] | null>(null)
  const [searching, setSearching] = useState(false)
  const [busy, setBusy] = useState(false)

  const opt = options.find((o) => o.key === optKey)

  async function runSearch(): Promise<void> {
    if (opt === undefined || query.trim() === '') return
    setSearching(true)
    try {
      const res = await call('memory.search', { query: query.trim(), labels: [...opt.otherLabels] })
      setHits(res.filter((h) => (opt.otherLabels as readonly string[]).includes(h.label)))
    } catch (err) {
      toast.notify('err', toIpcError(err).message)
    } finally {
      setSearching(false)
    }
  }

  async function connect(hit: MemorySearchHitDto): Promise<void> {
    if (opt === undefined) return
    const self = { label: node.label, id: node.id }
    const other = { label: hit.label, id: hit.id }
    const from = opt.direction === 'out' ? self : other
    const to = opt.direction === 'out' ? other : self
    setBusy(true)
    try {
      const result = await call('memory.edge.create', { type: opt.type, from, to })
      onConnected(result.auditActionId)
      onClose()
    } catch (err) {
      toast.notify('err', toIpcError(err).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal title="Connect to…" onClose={onClose} footer={<Button onClick={onClose}>Close</Button>}>
      {options.length === 0 ? (
        <p className="text-[12px] text-ink-mute">Nothing in memory can be connected to this kind of thing.</p>
      ) : (
        <div className="flex flex-col gap-3">
          <Select
            value={optKey}
            onChange={(value) => {
              setOptKey(value)
              setHits(null)
            }}
            options={options.map((o) => ({ value: o.key, label: o.optionLabel }))}
            label="Kind of connection"
            testId="memory-connect-type"
          />
          <div className="flex items-end gap-2">
            <div className="min-w-0 flex-1">
              <TextInput
                label="Find what to connect"
                value={query}
                onChange={setQuery}
                onEnter={() => void runSearch()}
                testId="memory-connect-search"
                placeholder="Search by name or words"
              />
            </div>
            <Button size="default" disabled={searching || query.trim() === ''} onClick={() => void runSearch()}>
              Search
            </Button>
          </div>
          {searching && <LoadingRows rows={3} />}
          {hits !== null && !searching && (
            hits.length === 0 ? (
              <p className="text-[12px] text-ink-mute">
                Nothing matched. Search only finds Projects, Skills, Preferences and Notes.
              </p>
            ) : (
              <ul className="flex flex-col divide-y divide-line rounded-md border border-line">
                {hits.map((hit) => (
                  <li key={nodeKey(hit)} className="flex items-center justify-between gap-2 px-3 py-2">
                    <span className="min-w-0 text-[12px] break-words">
                      {truncate(hit.text, 120)} <span className="text-ink-mute">({hit.label})</span>
                    </span>
                    <Button
                      testId={`memory-connect-target-${hit.id}`}
                      disabled={busy}
                      onClick={() => void connect(hit)}
                    >
                      Connect
                    </Button>
                  </li>
                ))}
              </ul>
            )
          )}
        </div>
      )}
    </Modal>
  )
}

// ── edge remove confirm ─────────────────────────────────────────────────────────

function EdgeRemoveModal({
  node,
  edge,
  onClose,
  onRemoved
}: {
  node: MemoryNodeDetailDto
  edge: MemoryEdgeDto
  onClose: () => void
  onRemoved: (auditActionId: string) => void
}): React.JSX.Element {
  const toast = useToast()
  const [busy, setBusy] = useState(false)

  async function confirm(): Promise<void> {
    const self = { label: node.label, id: node.id }
    const other = { label: edge.label, id: edge.id }
    const from = edge.direction === 'out' ? self : other
    const to = edge.direction === 'out' ? other : self
    setBusy(true)
    try {
      const result = await call('memory.edge.delete', { type: edge.type as IpcEdgeType, from, to })
      onRemoved(result.auditActionId)
      onClose()
    } catch (err) {
      toast.notify('err', toIpcError(err).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal
      title="Remove this connection?"
      onClose={onClose}
      footer={
        <>
          <Button disabled={busy} onClick={onClose}>
            Cancel
          </Button>
          <Button variant="danger" testId="edge-remove-confirm" disabled={busy} onClick={() => void confirm()}>
            Remove
          </Button>
        </>
      }
    >
      <div className="text-[13px]">
        Remove the “{plainWords(edge.type)}” connection to <span className="break-words">{truncate(edge.display, 80)}</span>?
      </div>
      <p className="mt-2 text-[12px] leading-5 text-ink-mute">
        This only removes the link — nothing on either side is deleted. You can undo it from History.
      </p>
    </Modal>
  )
}

// ── find duplicates (scan + audited merge) ──────────────────────────────────────

/** Only these labels merge automatically; Skill/Project groups are report-only. */
const MERGEABLE_DEDUPE_LABELS = new Set<IpcNodeLabel>(['Preference', 'Knowledge', 'Tag'])

/** Plain reason chip text for a duplicate group. */
function dedupeReasonText(group: MemoryDuplicateGroupDto): string {
  if (group.reason === 'exact') return 'identical wording'
  const pct = group.similarity != null ? Math.round(group.similarity * 100) : null
  return pct !== null ? `nearly identical (${pct}% similar)` : 'nearly identical'
}

/** Plain hint for a label that cannot be auto-merged. */
function reportOnlyHint(label: IpcNodeLabel): string {
  if (label === 'Skill') return "Skills can't be auto-merged — review them in Skills."
  if (label === 'Project') return "Projects can't be auto-merged — review them here."
  return `${label} items can't be auto-merged here.`
}

function dedupeGroupKey(group: MemoryDuplicateGroupDto): string {
  return `${group.label}:${group.suggestedKeepId}`
}

/** Default node budget for the "a set number" scope (mirrors DEDUPE_COUNT_DEFAULT). */
const DEDUPE_COUNT_DEFAULT_UI = 500

/** Plain-language scope choices for the background scan. */
const DEDUPE_SCOPE_OPTIONS: readonly { value: DedupeScanScope; label: string }[] = [
  { value: 'recent', label: 'Recently changed — fastest' },
  { value: 'count', label: 'A set number of memories' },
  { value: 'all', label: 'Everything — slowest' }
]

/** One plain sentence describing what a completed scan actually compared. */
function dedupeScopeSummary(status: DedupeScanStatusDto): string {
  if (status.lastScope === 'count') return `Compared your newest ${status.lastCount ?? DEDUPE_COUNT_DEFAULT_UI} memories.`
  if (status.lastScope === 'all') return 'Compared your entire memory.'
  if (status.lastScope === 'recent') return 'Compared the memories that changed since your last check.'
  return ''
}

function DedupeGroupCard({
  group,
  index,
  keepId,
  busy,
  confirming,
  onPickKeeper,
  onStartMerge,
  onCancelMerge,
  onConfirmMerge
}: {
  group: MemoryDuplicateGroupDto
  index: number
  keepId: string
  busy: boolean
  confirming: boolean
  onPickKeeper: (id: string) => void
  onStartMerge: () => void
  onCancelMerge: () => void
  onConfirmMerge: (keepId: string) => void
}): React.JSX.Element {
  const mergeable = MERGEABLE_DEDUPE_LABELS.has(group.label)
  const removeCount = group.nodes.length - 1
  const keepNode = group.nodes.find((n) => n.id === keepId) ?? group.nodes[0]
  const radioName = `dedupe-keep-${index}`
  return (
    <div className="rounded-md border border-line" data-testid={`dedupe-group-${index}`}>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 border-b border-line bg-surface px-3 py-2">
        <span className="rounded-full bg-raised px-2 py-0.5 text-[11px] text-ink-mute">{dedupeReasonText(group)}</span>
        <span className="text-[12px] text-ink-mute">
          {plural(group.nodes.length, `matching ${group.label}`, `matching ${group.label}s`)}
        </span>
      </div>
      <ul className="flex flex-col divide-y divide-line">
        {group.nodes.map((node) => (
          <li key={node.id} className="px-3 py-2">
            {mergeable ? (
              <label className="flex cursor-pointer items-start gap-2.5">
                <input
                  type="radio"
                  name={radioName}
                  checked={node.id === keepId}
                  disabled={busy}
                  onChange={() => onPickKeeper(node.id)}
                  data-testid={`dedupe-keep-${node.id}`}
                  className="mt-1 accent-[var(--color-accent)]"
                  aria-label={`Keep ${truncate(node.display, 60)}`}
                />
                <span className="min-w-0 flex-1">
                  <span className="block text-[13px] break-words">{truncate(node.display, 140)}</span>
                  <span className="mt-0.5 flex flex-wrap items-center gap-x-3 text-[11px] text-ink-mute">
                    <span>{plural(node.edgeCount, 'connection')}</span>
                    <Timestamp iso={node.updatedAt} />
                    {node.id === keepId && <span className="text-accent">keeps this</span>}
                  </span>
                </span>
              </label>
            ) : (
              <div className="min-w-0">
                <span className="block text-[13px] break-words">{truncate(node.display, 140)}</span>
                <span className="mt-0.5 flex flex-wrap items-center gap-x-3 text-[11px] text-ink-mute">
                  <span>{plural(node.edgeCount, 'connection')}</span>
                  <Timestamp iso={node.updatedAt} />
                </span>
              </div>
            )}
          </li>
        ))}
      </ul>
      <div className="border-t border-line px-3 py-2">
        {!mergeable ? (
          <p className="text-[12px] text-ink-mute">{reportOnlyHint(group.label)}</p>
        ) : confirming ? (
          <div className="flex flex-col gap-2">
            <p className="text-[12px] leading-5 text-ink-mute">
              Merge {plural(removeCount, 'duplicate')} into “{truncate(keepNode?.display ?? '', 60)}”? Their connections
              move onto the kept one. You can undo this from History.
            </p>
            <div className="flex gap-1.5">
              <Button disabled={busy} onClick={onCancelMerge}>
                Cancel
              </Button>
              <Button
                variant="danger"
                testId="memory-dedupe-merge-confirm"
                disabled={busy}
                onClick={() => onConfirmMerge(keepId)}
              >
                Merge {removeCount}
              </Button>
            </div>
          </div>
        ) : (
          <Button variant="primary" testId="memory-dedupe-merge" disabled={busy} onClick={onStartMerge}>
            Keep this one, merge {plural(removeCount, 'duplicate')} into it
          </Button>
        )}
      </div>
    </div>
  )
}

function DedupeModal({
  onClose,
  notifyUndoable,
  onChanged
}: {
  onClose: () => void
  notifyUndoable: (auditActionId: string, message: string) => void
  onChanged: () => void
}): React.JSX.Element {
  const toast = useToast()
  const [status, setStatus] = useState<DedupeScanStatusDto | null>(null)
  const [loadError, setLoadError] = useState<IpcError | null>(null)
  const [scope, setScope] = useState<DedupeScanScope>('recent')
  const [countText, setCountText] = useState(String(DEDUPE_COUNT_DEFAULT_UI))
  const [keepers, setKeepers] = useState<Record<string, string>>({})
  const [confirming, setConfirming] = useState<string | null>(null)
  const [acceptingAll, setAcceptingAll] = useState(false)
  const [aiConfirm, setAiConfirm] = useState(false)
  const [cleanupBusy, setCleanupBusy] = useState(false)
  const [busy, setBusy] = useState(false)
  const [starting, setStarting] = useState(false)

  // Seed a keeper choice for any group we haven't seen yet (keeps a user's pick
  // across the progress re-renders that arrive while a scan runs).
  const applyStatus = useCallback((s: DedupeScanStatusDto): void => {
    setStatus(s)
    setLoadError(null)
    const groups = s.lastResult?.groups
    if (groups !== undefined) {
      setKeepers((old) => {
        const seed = { ...old }
        for (const g of groups) {
          const key = dedupeGroupKey(g)
          if (!(key in seed)) seed[key] = g.suggestedKeepId
        }
        return seed
      })
    }
  }, [])

  // Read the current status on open, then ride live pushes — the scan runs in
  // main and survives this modal closing, so reopening shows its progress/result.
  useEffect(() => {
    let alive = true
    void call('memory.dedupe.status', undefined).then(
      (s) => {
        if (alive) applyStatus(s)
      },
      (err) => {
        if (alive) setLoadError(toIpcError(err))
      }
    )
    const unsub = window.agenticOS.onDedupeStatus((s) => applyStatus(s))
    return () => {
      alive = false
      unsub()
    }
  }, [applyStatus])

  // Focus lifecycle for the accept-all confirm (an inline alertdialog whose
  // trigger unmounts when it opens): when it opens, remember the control that
  // opened it and move focus into the confirm so keyboard/screen-reader users land
  // on the destructive choice and its appearance is announced (WCAG 2.4.3 / 4.1.3);
  // when it closes, return focus to the opener. Mirrors Modal's discipline (kit.tsx).
  const acceptAllConfirmRef = useRef<HTMLDivElement>(null)
  const acceptAllOpenerRef = useRef<HTMLElement | null>(null)
  useEffect(() => {
    if (acceptingAll) {
      acceptAllOpenerRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
      acceptAllConfirmRef.current?.focus()
    } else if (acceptAllOpenerRef.current !== null) {
      acceptAllOpenerRef.current.focus()
      acceptAllOpenerRef.current = null
    }
  }, [acceptingAll])

  const startScan = useCallback(async (): Promise<void> => {
    setStarting(true)
    setConfirming(null)
    setAcceptingAll(false)
    try {
      const parsed = Math.trunc(Number(countText))
      const options: DedupeScanOptionsDto = {
        scope,
        ...(scope === 'count' ? { count: Number.isFinite(parsed) && parsed > 0 ? parsed : DEDUPE_COUNT_DEFAULT_UI } : {})
      }
      applyStatus(await call('memory.dedupe.scanStart', options))
    } catch (err) {
      toast.notify('err', toIpcError(err).message)
    } finally {
      setStarting(false)
    }
  }, [applyStatus, countText, scope, toast])

  const cancelScan = useCallback(async (): Promise<void> => {
    try {
      applyStatus(await call('memory.dedupe.cancel', undefined))
    } catch (err) {
      toast.notify('err', toIpcError(err).message)
    }
  }, [applyStatus, toast])

  const merge = useCallback(
    async (group: MemoryDuplicateGroupDto, keepId: string): Promise<void> => {
      const removeIds = group.nodes.map((n) => n.id).filter((id) => id !== keepId)
      if (removeIds.length === 0) return
      setBusy(true)
      try {
        const result = await call('memory.dedupe.merge', { label: group.label, keepId, removeIds })
        notifyUndoable(result.auditActionId, `Merged ${plural(result.removed, 'duplicate')} — undo available in History`)
        onChanged()
        await startScan() // re-scan for fresh results (the merged nodes are gone)
      } catch (err) {
        toast.notify('err', toIpcError(err).message)
      } finally {
        setBusy(false)
      }
    },
    [notifyUndoable, onChanged, startScan, toast]
  )

  // "Accept all suggested": collapse every mergeable group onto its keeper in ONE
  // audited lane job (the backend batches; one undo restores the lot). Stale
  // groups ride `skipped` rather than failing the batch — surfaced as a note.
  const mergeAll = useCallback(
    async (
      groupsToMerge: readonly { label: IpcNodeLabel; keepId: string; removeIds: readonly string[] }[]
    ): Promise<void> => {
      if (groupsToMerge.length === 0) return
      setBusy(true)
      setAcceptingAll(false)
      try {
        const result = await call('memory.dedupe.mergeAll', { groups: groupsToMerge })
        if (result.auditActionId === null) {
          toast.notify('ok', 'Nothing left to merge — scan again.')
        } else {
          notifyUndoable(
            result.auditActionId,
            `Merged ${plural(result.removed, 'duplicate')} across ${plural(result.mergedGroups, 'group')} — undo available in History`
          )
          if (result.skipped.length > 0) {
            toast.notify('info', `${plural(result.skipped.length, 'group')} skipped — its memories changed since the scan.`)
          }
        }
        onChanged()
        await startScan() // re-scan for fresh results (the merged nodes are gone)
      } catch (err) {
        toast.notify('err', toIpcError(err).message)
      } finally {
        setBusy(false)
      }
    },
    [notifyUndoable, onChanged, startScan, toast]
  )

  // "Let AI clean up": enqueue the background graph-cleanup job for the current
  // scope. It stages merge proposals for review (§21 rule 6) — nothing merges
  // without approval — so this is fire-and-forget: a toast, no result to show.
  const startCleanup = useCallback(async (): Promise<void> => {
    setCleanupBusy(true)
    try {
      const parsed = Math.trunc(Number(countText))
      const res = await call('memory.dedupe.cleanupStart', {
        scope,
        ...(scope === 'count' ? { count: Number.isFinite(parsed) && parsed > 0 ? parsed : DEDUPE_COUNT_DEFAULT_UI } : {})
      })
      toast.notify('ok', res.deduped ? 'AI cleanup is already scheduled.' : 'AI cleanup started — proposals will appear in Approvals.')
      setAiConfirm(false)
    } catch (err) {
      toast.notify('err', toIpcError(err).message)
    } finally {
      setCleanupBusy(false)
    }
  }, [countText, scope, toast])

  const running = status?.phase === 'running'
  const groups = status?.lastResult?.groups ?? []
  const progress = status?.running

  // Accept-all only offers the auto-mergeable groups (Preference/Knowledge/Tag);
  // Skill/Project groups are report-only and stay out of the batch. removeCount
  // sums the duplicates that fold away (each group keeps one).
  const mergeableGroups = groups.filter((g) => MERGEABLE_DEDUPE_LABELS.has(g.label))
  const reportOnlyCount = groups.length - mergeableGroups.length
  const acceptAllRemoveCount = mergeableGroups.reduce((sum, g) => sum + (g.nodes.length - 1), 0)
  const buildAcceptAllGroups = (): { label: IpcNodeLabel; keepId: string; removeIds: string[] }[] =>
    mergeableGroups.map((g) => {
      const keepId = keepers[dedupeGroupKey(g)] ?? g.suggestedKeepId
      return { label: g.label, keepId, removeIds: g.nodes.map((n) => n.id).filter((id) => id !== keepId) }
    })

  // ── scan controls (scope picker + Start/Cancel) ──
  const controls = (
    <div className="flex flex-col gap-2 rounded-md border border-line bg-surface px-3 py-3">
      <div className="flex flex-wrap items-end gap-3">
        <Select
          label="What to check"
          ariaLabel="duplicate scan scope"
          testId="dedupe-scope"
          value={scope}
          onChange={(v) => setScope(v as DedupeScanScope)}
          options={DEDUPE_SCOPE_OPTIONS}
        />
        {scope === 'count' && (
          <TextInput
            label="How many"
            ariaLabel="number of memories to check"
            testId="dedupe-count"
            width="w-24"
            value={countText}
            onChange={setCountText}
            onEnter={() => void startScan()}
          />
        )}
        <div className="ml-auto flex gap-1.5">
          <Button testId="dedupe-ai-cleanup" disabled={cleanupBusy} onClick={() => setAiConfirm((v) => !v)}>
            Let AI clean up
          </Button>
          {running ? (
            <Button testId="dedupe-cancel" onClick={() => void cancelScan()}>
              Stop
            </Button>
          ) : (
            <Button variant="primary" testId="dedupe-scan-start" disabled={starting} onClick={() => void startScan()}>
              {status?.lastResult !== undefined ? 'Scan again' : 'Scan'}
            </Button>
          )}
        </div>
      </div>
      {aiConfirm && (
        <div className="rounded-md border border-line bg-raised px-3 py-2">
          <p className="text-[12px] leading-5 text-ink-mute">
            A background job scans for duplicates and has your local AI review the near-matches. Its merge proposals
            appear in Approvals for your review — nothing changes without your approval.
          </p>
          <div className="mt-2 flex gap-1.5">
            <Button disabled={cleanupBusy} onClick={() => setAiConfirm(false)}>
              Cancel
            </Button>
            <Button
              variant="primary"
              testId="dedupe-ai-cleanup-confirm"
              disabled={cleanupBusy}
              onClick={() => void startCleanup()}
            >
              Start cleanup
            </Button>
          </div>
        </div>
      )}
      <p className="text-[12px] leading-5 text-ink-mute">
        {scope === 'recent'
          ? 'Only the memories that changed since your last check — quick, and ideal right after importing projects.'
          : scope === 'count'
            ? 'Only your most recently updated memories, up to the number you set.'
            : 'Every memory in the database. Thorough, but can take a while on a large graph.'}
      </p>
      {running && (
        <div className="rounded-md bg-raised px-3 py-2 text-[12px] leading-5" role="status" data-testid="dedupe-progress">
          Checking{progress?.currentLabel ? ` ${progress.currentLabel.toLowerCase()}s` : ''}…{' '}
          {progress !== undefined && progress.totalNodes > 0
            ? `${Math.min(progress.scannedNodes, progress.totalNodes)} of ${progress.totalNodes} memories`
            : `${progress?.scannedNodes ?? 0} memories`}
          . You can close this window — it keeps going in the background.
        </div>
      )}
    </div>
  )

  // ── results (the last completed scan; stays visible while a new one runs) ──
  let results: ReactNode = null
  if (loadError !== null) {
    results = <ErrorState error={loadError} onRetry={() => void startScan()} />
  } else if (status === null) {
    results = (
      <p className="py-2 text-[13px] text-ink-mute" role="status">
        Loading…
      </p>
    )
  } else if (status.phase === 'error' && status.error !== undefined) {
    results = <ErrorState error={new IpcError('INTERNAL', status.error.message)} onRetry={() => void startScan()} />
  } else if (groups.length > 0) {
    results = (
      <div className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center gap-x-2 text-[12px] text-ink-mute">
          <span>{dedupeScopeSummary(status)}</span>
          {status.lastScope === 'recent' && status.effectiveCutoff !== undefined && (
            <span>
              (since <Timestamp iso={status.effectiveCutoff} />)
            </span>
          )}
        </div>
        {mergeableGroups.length > 0 && (
          <div className="rounded-md border border-line bg-surface px-3 py-2.5">
            {acceptingAll ? (
              <div
                ref={acceptAllConfirmRef}
                tabIndex={-1}
                role="alertdialog"
                aria-label="Confirm merging all duplicate groups"
                className="flex flex-col gap-2 outline-none"
              >
                <p className="text-[12px] leading-5 text-ink-mute">
                  Merge {plural(acceptAllRemoveCount, 'duplicate')} across {plural(mergeableGroups.length, 'group')} into
                  the selected keepers? Connections move onto the kept memories, and one undo in History restores
                  everything.
                  {reportOnlyCount > 0 &&
                    ` The ${plural(reportOnlyCount, 'group')} that can't be auto-merged ${reportOnlyCount === 1 ? 'is' : 'are'} not included.`}
                </p>
                <div className="flex gap-1.5">
                  <Button disabled={busy} onClick={() => setAcceptingAll(false)}>
                    Cancel
                  </Button>
                  <Button
                    variant="primary"
                    testId="dedupe-accept-all-confirm"
                    disabled={busy || running}
                    onClick={() => void mergeAll(buildAcceptAllGroups())}
                  >
                    Merge all {mergeableGroups.length}
                  </Button>
                </div>
              </div>
            ) : (
              <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
                <span className="text-[12px] leading-5 text-ink-mute">
                  {plural(acceptAllRemoveCount, 'duplicate')} across {plural(mergeableGroups.length, 'group')} can merge
                  into the suggested keepers in one step.
                </span>
                <Button
                  variant="primary"
                  testId="dedupe-accept-all"
                  disabled={busy || running}
                  onClick={() => setAcceptingAll(true)}
                >
                  Merge all {mergeableGroups.length} suggested
                </Button>
              </div>
            )}
          </div>
        )}
        {status.lastResult?.truncated === true && (
          <p className="rounded-md border border-warn/40 bg-warn/10 px-3 py-2 text-[12px] leading-5">
            Memory is large, so only part of it was compared — merge these, then scan again (or narrow the scope).
          </p>
        )}
        {groups.map((group, i) => {
          const key = dedupeGroupKey(group)
          return (
            <DedupeGroupCard
              key={key}
              group={group}
              index={i}
              keepId={keepers[key] ?? group.suggestedKeepId}
              busy={busy || running}
              confirming={confirming === key}
              onPickKeeper={(id) => setKeepers((old) => ({ ...old, [key]: id }))}
              onStartMerge={() => setConfirming(key)}
              onCancelMerge={() => setConfirming(null)}
              onConfirmMerge={(keepId) => void merge(group, keepId)}
            />
          )
        })}
      </div>
    )
  } else if (!running && (status.phase === 'done' || status.lastResult !== undefined)) {
    // A completed scan that found nothing — keep it scope-specific so a narrow
    // "recent" scan isn't misread as a clean bill for the whole database.
    results = (
      <EmptyState icon={<Icon name="check" size={20} />}>
        {status.lastScope === 'recent'
          ? 'No duplicates among the memories that changed since your last check.'
          : status.lastScope === 'count'
            ? 'No duplicates among the memories checked.'
            : 'No duplicates found — memory looks clean.'}
      </EmptyState>
    )
  } else if (!running) {
    results = (
      <EmptyState icon={<Icon name="search" size={20} />}>Run a scan to check your memory for duplicates.</EmptyState>
    )
  }

  return (
    <Modal
      title="Find duplicates"
      onClose={onClose}
      wide
      footer={
        <Button variant="primary" onClick={onClose}>
          Done
        </Button>
      }
    >
      <p className="mb-3 text-[12px] leading-5 text-ink-mute">
        Memories that say almost the same thing. Pick the one to keep — its connections stay and the duplicates fold into
        it. Every merge is undoable from History.
      </p>
      <div className="flex flex-col gap-3">
        {controls}
        {results}
      </div>
    </Modal>
  )
}

// ── edges ─────────────────────────────────────────────────────────────────────

function groupEdges(edges: readonly MemoryEdgeDto[]): readonly (readonly [string, readonly MemoryEdgeDto[]])[] {
  const map = new Map<string, MemoryEdgeDto[]>()
  for (const edge of edges) {
    const bucket = map.get(edge.type)
    if (bucket !== undefined) bucket.push(edge)
    else map.set(edge.type, [edge])
  }
  return [...map.entries()]
}

function EdgeSection({
  title,
  emptyText,
  edges,
  onNavigate,
  onRemove
}: {
  title: string
  emptyText: string
  edges: readonly MemoryEdgeDto[]
  onNavigate: (ref: NodeRef) => void
  onRemove: (edge: MemoryEdgeDto) => void
}): React.JSX.Element {
  return (
    <section className="mt-5">
      <SectionHeader meta={edges.length === 0 ? undefined : String(edges.length)}>{title}</SectionHeader>
      {edges.length === 0 ? (
        <div className="text-[12px] text-ink-mute">{emptyText}</div>
      ) : (
        groupEdges(edges).map(([type, group]) => (
          <div key={type} className="mb-3">
            <div className="border-b border-line pb-1 text-[12px] text-ink-mute">{plainWords(type)}</div>
            <ul>
              {group.map((edge, i) => {
                // Provenance (where the edge came from) rides in the tooltip — a
                // technical id, not the first thing the row should say.
                const extractedBy =
                  typeof edge.props['extracted_by'] === 'string' ? edge.props['extracted_by'] : null
                const confidence =
                  typeof edge.props['confidence'] === 'number' ? edge.props['confidence'] : null
                const detail = extractedBy !== null ? `${nodeKey(edge)} · ${extractedBy}` : nodeKey(edge)
                return (
                  <li
                    key={`${edge.label}:${edge.id}:${i}`}
                    className="flex min-h-[34px] flex-wrap items-center gap-x-2.5 gap-y-0.5 border-b border-line py-1.5"
                  >
                    <button
                      type="button"
                      onClick={() => onNavigate({ label: edge.label, id: edge.id, display: edge.display })}
                      className="min-w-0 cursor-pointer text-left text-[12px] text-accent transition-colors duration-120 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
                      title={detail}
                    >
                      {truncate(edge.display, 120)}
                    </button>
                    {confidence !== null && <Confidence value={confidence} />}
                    <button
                      type="button"
                      aria-label={`Remove the ${plainWords(edge.type)} connection to ${truncate(edge.display, 60)}`}
                      title="Remove this connection"
                      data-testid={`edge-remove-${edge.type}-${edge.id}`}
                      onClick={() => onRemove(edge)}
                      className="ml-auto shrink-0 cursor-pointer rounded-md px-1.5 text-[12px] text-ink-mute transition-colors duration-120 hover:bg-raised hover:text-err focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
                    >
                      <Icon name="x" size={12} />
                    </button>
                  </li>
                )
              })}
            </ul>
          </div>
        ))
      )}
    </section>
  )
}

// ── inspector ─────────────────────────────────────────────────────────────────

function Inspector({
  nodeRef,
  canBack,
  onBack,
  onNavigate,
  onMutated,
  onDeleted
}: {
  nodeRef: NodeRef
  canBack: boolean
  onBack: () => void
  onNavigate: (ref: NodeRef) => void
  /** A same-node mutation committed (edit / connect / edge-remove) → refresh + undoable toast. */
  onMutated: (auditActionId: string, message: string) => void
  /** The node itself was deleted → clear + refresh + undoable toast. */
  onDeleted: (result: MemoryDeleteResultDto) => void
}): React.JSX.Element {
  const detail = useIpc('memory.node', { label: nodeRef.label, id: nodeRef.id })
  const [editing, setEditing] = useState(false)
  const [connecting, setConnecting] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [edgeToRemove, setEdgeToRemove] = useState<MemoryEdgeDto | null>(null)

  if (detail.error !== null) return <ErrorState error={detail.error} onRetry={detail.reload} />
  if (detail.loading || detail.data === null) return <LoadingRows rows={6} />

  const node = detail.data
  const extractedBy = typeof node.props['extracted_by'] === 'string' ? node.props['extracted_by'] : null
  const confidence = typeof node.props['confidence'] === 'number' ? node.props['confidence'] : null
  const entries = Object.entries(node.props).filter(
    ([key, value]) => value !== null && key !== 'extracted_by' && key !== 'confidence'
  )
  // Plain-first: primitive props read in the KV; nested JSON is technical detail.
  const simple = entries.filter(([, value]) => typeof value !== 'object')
  const complex = entries.filter(([, value]) => typeof value === 'object')
  // Heading = the human handle; a deep link (R3) may arrive without one, so fall
  // back to a handle derived from the props before the raw id.
  const heading = nodeRef.display ?? nodeHandle(node.label, node.props) ?? node.id

  return (
    <div className="px-4 py-3">
      <div className="flex items-center gap-2.5">
        {canBack && <Button onClick={onBack}>back</Button>}
        <span className="text-[12px] text-ink-mute">{node.label}</span>
        <div className="ml-auto flex items-center gap-1.5">
          <Button testId="memory-edit" onClick={() => setEditing(true)}>
            Edit
          </Button>
          <Button testId="memory-connect" onClick={() => setConnecting(true)}>
            Connect to…
          </Button>
          <Button variant="danger-ghost" testId="memory-delete" onClick={() => setDeleting(true)}>
            Delete
          </Button>
        </div>
      </div>
      <div className="mt-1.5 text-[14px] break-words">{heading}</div>
      {/* Plain "what this is" lead line (R2): one sentence from props + edge counts. */}
      <div className="mt-1 text-[13px] leading-5 text-ink-mute">{summarizeNode(node)}</div>
      {(extractedBy !== null || confidence !== null) && (
        <div className="mt-2.5 flex flex-wrap items-center gap-x-2.5 gap-y-1 border-b border-line pb-2.5 text-[12px] text-ink-mute">
          {extractedBy !== null && (
            <span>
              where this came from: <span className="font-mono text-[11px]">{extractedBy}</span>
            </span>
          )}
          {confidence !== null && <Confidence value={confidence} />}
        </div>
      )}
      <div className="mt-3">
        {simple.length === 0 ? (
          <div className="text-[12px] text-ink-mute">Nothing else is recorded about this.</div>
        ) : (
          <KV
            entries={simple.map(([key, value]) => ({
              k: plainPropLabel(node.label, key),
              v: renderPropValue(key, value),
              kTitle: key
            }))}
          />
        )}
      </div>
      {complex.length > 0 && (
        <div className="mt-3">
          <Disclosure summary="Technical details">
            <div className="mb-2 text-[12px] text-ink-mute">
              id <span className="font-mono break-all">{node.id}</span>
            </div>
            <KV entries={complex.map(([key, value]) => ({ k: key, v: renderPropValue(key, value) }))} />
          </Disclosure>
        </div>
      )}
      <EdgeSection
        title="Connected to"
        emptyText="This isn't connected to anything else yet."
        edges={node.outgoing}
        onNavigate={onNavigate}
        onRemove={setEdgeToRemove}
      />
      <EdgeSection
        title="Connected from"
        emptyText="Nothing else points to this yet."
        edges={node.incoming}
        onNavigate={onNavigate}
        onRemove={setEdgeToRemove}
      />

      {editing && (
        <EditMemoryModal
          node={node}
          onClose={() => setEditing(false)}
          onSaved={(result) => onMutated(result.auditActionId, 'Saved — undo available in History')}
        />
      )}
      {connecting && (
        <ConnectModal
          node={node}
          onClose={() => setConnecting(false)}
          onConnected={(auditActionId) => onMutated(auditActionId, 'Connected — undo available in History')}
        />
      )}
      {deleting && <DeleteConfirmModal node={node} onClose={() => setDeleting(false)} onDeleted={onDeleted} />}
      {edgeToRemove !== null && (
        <EdgeRemoveModal
          node={node}
          edge={edgeToRemove}
          onClose={() => setEdgeToRemove(null)}
          onRemoved={(auditActionId) => onMutated(auditActionId, 'Connection removed — undo available in History')}
        />
      )}
    </div>
  )
}

// ── tables ────────────────────────────────────────────────────────────────────

const LIST_COLUMNS: readonly Column<MemoryNodeSummaryDto>[] = [
  {
    key: 'display',
    header: 'what it is',
    render: (row) => <span>{truncate(row.display, 160)}</span>
  },
  {
    key: 'updated',
    header: 'last updated',
    className: 'whitespace-nowrap',
    render: (row) => <Timestamp iso={row.updatedAt} />
  }
]

// ── panel ─────────────────────────────────────────────────────────────────────

export default function MemoryPanel({ inspect: inspectTarget, onInspectConsumed }: PanelProps): React.JSX.Element {
  const toast = useToast()
  const counts = useIpc('memory.counts', undefined)
  const [query, setQuery] = useState('')
  const [search, setSearch] = useState<SearchState | null>(null)
  const [list, setList] = useState<ListState | null>(null)
  const [stack, setStack] = useState<readonly NodeRef[]>([])
  const [addOpen, setAddOpen] = useState(false)
  const [dedupeOpen, setDedupeOpen] = useState(false)
  const [inspectorGen, setInspectorGen] = useState(0)
  const listGen = useRef(0)
  const searchGen = useRef(0)
  const listRef = useRef<ListState | null>(null)
  listRef.current = list

  const current = stack.length > 0 ? stack[stack.length - 1] : undefined
  const currentKey = current !== undefined ? nodeKey(current) : null

  const loadPage = useCallback((label: IpcNodeLabel, prior: readonly MemoryNodeSummaryDto[]) => {
    const gen = ++listGen.current
    setList((old) => ({
      label,
      rows: prior,
      total: old !== null && old.label === label ? old.total : prior.length,
      loading: true,
      error: null
    }))
    call('memory.list', { label, limit: PAGE_SIZE, offset: prior.length })
      .then((res) => {
        if (listGen.current !== gen) return
        setList({ label, rows: [...prior, ...res.rows], total: res.total, loading: false, error: null })
      })
      .catch((err: unknown) => {
        if (listGen.current !== gen) return
        setList({ label, rows: prior, total: prior.length, loading: false, error: toIpcError(err) })
      })
  }, [])

  const runSearch = useCallback((raw: string) => {
    const trimmed = raw.trim()
    if (trimmed === '') return
    const gen = ++searchGen.current
    setSearch({ query: trimmed, hits: null, loading: true, error: null })
    call('memory.search', { query: trimmed })
      .then((hits) => {
        if (searchGen.current !== gen) return
        setSearch({ query: trimmed, hits, loading: false, error: null })
      })
      .catch((err: unknown) => {
        if (searchGen.current !== gen) return
        setSearch({ query: trimmed, hits: null, loading: false, error: toIpcError(err) })
      })
  }, [])

  const clearSearch = useCallback(() => {
    searchGen.current += 1
    setSearch(null)
    setQuery('')
  }, [])

  const inspect = useCallback((ref: NodeRef) => {
    setStack([ref])
  }, [])

  const navigate = useCallback((ref: NodeRef) => {
    setStack((old) => {
      const top = old.length > 0 ? old[old.length - 1] : undefined
      if (top !== undefined && top.label === ref.label && top.id === ref.id) return old
      return [...old, ref]
    })
  }, [])

  const goBack = useCallback(() => {
    setStack((old) => old.slice(0, -1))
  }, [])

  // R3 deep link: when App hands us a one-shot inspect target (e.g. from an
  // Approvals source chip), switch the browse list to its category, open its
  // inspector, then tell App we consumed it so a nav-away-and-back doesn't re-fire.
  useEffect(() => {
    if (inspectTarget == null) return
    loadPage(inspectTarget.label, [])
    setStack([{ label: inspectTarget.label, id: inspectTarget.id }])
    onInspectConsumed?.()
  }, [inspectTarget, loadPage, onInspectConsumed])

  // ── mutation plumbing (feature B) ─────────────────────────────────────────────

  const reloadList = useCallback(() => {
    const cur = listRef.current
    if (cur !== null) loadPage(cur.label, [])
  }, [loadPage])

  const bumpInspector = useCallback(() => setInspectorGen((g) => g + 1), [])

  const undoAction = useCallback(
    async (auditActionId: string): Promise<void> => {
      try {
        await call('audit.undo', { id: auditActionId })
        toast.notify('ok', 'Undone.')
        counts.reload()
        reloadList()
        bumpInspector()
      } catch (err) {
        toast.notify('err', toIpcError(err).message)
      }
    },
    [toast, counts, reloadList, bumpInspector]
  )

  const notifyUndoable = useCallback(
    (auditActionId: string, message: string) => {
      toast.notify('ok', message, { label: 'Undo', testId: 'undo-toast-action', onClick: () => void undoAction(auditActionId) })
    },
    [toast, undoAction]
  )

  // A create shows the new node's category immediately (switches the list to it).
  const onCreated = useCallback(
    (result: MemoryNodeMutationDto) => {
      notifyUndoable(result.auditActionId, 'Saved — undo available in History')
      counts.reload()
      loadPage(result.label, [])
    },
    [notifyUndoable, counts, loadPage]
  )

  const onMutated = useCallback(
    (auditActionId: string, message: string) => {
      notifyUndoable(auditActionId, message)
      counts.reload()
      reloadList()
      bumpInspector()
    },
    [notifyUndoable, counts, reloadList, bumpInspector]
  )

  const onDeleted = useCallback(
    (result: MemoryDeleteResultDto) => {
      notifyUndoable(result.auditActionId, `Deleted ${plural(result.deleted.nodes, 'item')} — undo available in History`)
      setStack([])
      counts.reload()
      reloadList()
    },
    [notifyUndoable, counts, reloadList]
  )

  // ── left column bodies ──────────────────────────────────────────────────────

  let browseBody: ReactNode
  if (counts.error !== null) {
    browseBody = <ErrorState error={counts.error} onRetry={counts.reload} />
  } else if (counts.data === null) {
    browseBody = <LoadingRows rows={6} />
  } else {
    const total = counts.data.reduce((sum, c) => sum + c.count, 0)
    const segments = counts.data.map((c, i) => ({
      label: c.label,
      count: c.count,
      tint: COMP_TINTS[i % COMP_TINTS.length] ?? 'accent'
    }))
    browseBody = (
      <>
        <div className="border-b border-line px-4 py-3">
          <CompositionBar segments={segments} ariaLabel="What memory holds" />
          <div className="mt-2 text-[12px] text-ink-mute">
            {total === 0
              ? 'Nothing remembered yet.'
              : `${total.toLocaleString()} ${total === 1 ? 'thing' : 'things'} remembered`}
          </div>
        </div>
        <div className="flex flex-col gap-1 px-4 py-3">
          {counts.data.map((c) => {
            const selected = list !== null && list.label === c.label
            return (
              <div key={c.label}>
                {/* Two spans only, no extra content — e2e selects this button by its
                    "<Label> <count>" accessible name (a title does not change that).
                    The plain description moves into the tooltip to keep the list
                    compact instead of an always-visible line under every chip. */}
                <button
                  type="button"
                  onClick={() => loadPage(c.label, [])}
                  title={LABEL_DESCRIPTIONS[c.label]}
                  className={`inline-flex cursor-pointer items-baseline gap-1.5 rounded-md px-2 py-1 text-[12px] transition-colors duration-120 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent ${
                    selected
                      ? 'bg-raised text-ink shadow-[inset_2px_0_0_var(--color-accent)]'
                      : 'text-ink-mute hover:bg-raised hover:text-ink'
                  }`}
                >
                  <span>{c.label}</span>
                  <span className="font-mono text-[11px]">{c.count}</span>
                </button>
              </div>
            )
          })}
        </div>
        {list === null ? (
          <EmptyState>Pick a category above to see what&apos;s in it, or search everything.</EmptyState>
        ) : (
          <>
            <div className="px-4">
              <SectionHeader
                meta={
                  <span className="font-mono text-[11px]">
                    {list.rows.length} of {list.total}
                  </span>
                }
              >
                {list.label}
              </SectionHeader>
            </div>
            {list.error !== null && (
              <ErrorState error={list.error} onRetry={() => loadPage(list.label, list.rows)} />
            )}
            <DataTable
              columns={LIST_COLUMNS}
              rows={list.rows}
              rowKey={nodeKey}
              onRowClick={inspect}
              selectedKey={currentKey}
              empty={list.loading ? 'loading' : `Nothing under ${list.label} yet.`}
            />
            {list.loading && <LoadingRows rows={3} />}
            {!list.loading && list.rows.length < list.total && (
              <div className="px-4 py-3">
                <Button onClick={() => loadPage(list.label, list.rows)}>Show more</Button>
              </div>
            )}
          </>
        )}
      </>
    )
  }

  let searchBody: ReactNode = null
  if (search !== null) {
    if (search.loading) {
      searchBody = <LoadingRows />
    } else if (search.error !== null) {
      searchBody = <ErrorState error={search.error} onRetry={() => runSearch(search.query)} />
    } else {
      const hits = search.hits ?? []
      searchBody = (
        <>
          <div className="px-4">
            <SectionHeader
              meta={
                <span className="font-mono text-[11px]">
                  {hits.length} {hits.length === 1 ? 'match' : 'matches'}
                </span>
              }
            >
              Results for &apos;{search.query}&apos;
            </SectionHeader>
          </div>
          {hits.length === 0 ? (
            <EmptyState>Nothing matched &apos;{search.query}&apos;. Try different words.</EmptyState>
          ) : (
            <ul>
              {hits.map((hit) => {
                const key = nodeKey(hit)
                const selected = currentKey === key
                return (
                  <li
                    key={key}
                    data-rowkey={key}
                    className={`border-b border-line px-4 py-3 ${
                      selected ? 'bg-raised shadow-[inset_2px_0_0_var(--color-accent)]' : ''
                    }`}
                  >
                    <button
                      type="button"
                      onClick={() => inspect({ label: hit.label, id: hit.id, display: hit.text })}
                      className="block w-full cursor-pointer text-left text-[13px] break-words transition-colors duration-120 hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
                    >
                      {truncate(hit.text, 200)}
                    </button>
                    <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px] text-ink-mute">
                      <span className="inline-flex items-center gap-1.5">
                        match <Confidence value={hit.rerankScore} />
                      </span>
                      <span>{hit.label}</span>
                    </div>
                    <div className="mt-1">
                      <Disclosure summary="How this matched">
                        <div className="grid grid-cols-[1fr_auto] gap-x-4 gap-y-1 text-[12px]">
                          <span className="text-ink-mute">meaning match (vector)</span>
                          <span className="text-right font-mono">{hit.signals.vector.toFixed(3)}</span>
                          <span className="text-ink-mute">word match (keyword)</span>
                          <span className="text-right font-mono">{hit.signals.keyword.toFixed(3)}</span>
                          <span className="text-ink-mute">related in memory (graph)</span>
                          <span className="text-right font-mono">{hit.signals.graph.toFixed(3)}</span>
                          <span className="text-ink-mute">combined score (fused)</span>
                          <span className="text-right font-mono">{hit.fusedScore.toFixed(3)}</span>
                        </div>
                      </Disclosure>
                    </div>
                  </li>
                )
              })}
            </ul>
          )}
        </>
      )
    }
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <PanelHeader
        title="Memory"
        subtitle="Everything your assistant knows and remembers"
        icon={<Icon name="memory" size={18} />}
        actions={
          <>
            <Button variant="primary" testId="memory-add" onClick={() => setAddOpen(true)}>
              Add memory
            </Button>
            <Button testId="memory-dedupe-scan" onClick={() => setDedupeOpen(true)}>
              Find duplicates
            </Button>
            <TextInput
              value={query}
              onChange={setQuery}
              placeholder="Search everything it knows…"
              ariaLabel="Search everything it knows"
              testId="memory-search-input"
              onEnter={() => runSearch(query)}
              width="w-80"
            />
            {search !== null && <Button onClick={clearSearch}>clear</Button>}
          </>
        }
      />
      <div className="grid min-h-0 flex-1 grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
        <div className="min-h-0 overflow-y-auto border-r border-line">
          {search !== null ? searchBody : browseBody}
        </div>
        <div className="min-h-0 overflow-y-auto" data-testid="memory-inspector">
          {current === undefined ? (
            <EmptyState>Pick something on the left to see its details.</EmptyState>
          ) : (
            <Inspector
              key={`${currentKey}:${inspectorGen}`}
              nodeRef={current}
              canBack={stack.length > 1}
              onBack={goBack}
              onNavigate={navigate}
              onMutated={onMutated}
              onDeleted={onDeleted}
            />
          )}
        </div>
      </div>

      {addOpen && <AddMemoryModal onClose={() => setAddOpen(false)} onCreated={onCreated} />}
      {dedupeOpen && (
        <DedupeModal
          onClose={() => setDedupeOpen(false)}
          notifyUndoable={notifyUndoable}
          onChanged={() => {
            counts.reload()
            reloadList()
            bumpInspector()
          }}
        />
      )}
    </div>
  )
}
