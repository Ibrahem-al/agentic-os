/**
 * Plain-language layer (UI redesign) — the single place raw backend status
 * words and machine numbers become sentence-case English for less technical
 * users. Every panel reads its plain labels/explanations from here so the
 * vocabulary stays one language (PRODUCT.md "one instrument, one language");
 * raw terms still ride in Badge `data-status` + "Details" tooltips per the
 * redesign brief. Dependency-free (renderer lib): pure functions only.
 *
 * Sibling `format.ts` keeps the terse cockpit grammar (relTime, mono `usd`,
 * `duration`); this module is the roomier plain-English variant used in
 * user-facing copy. Keep both — they serve different registers.
 */

/** Plain label + one-sentence explanation for a raw backend status word. */
export interface PlainStatus {
  readonly label: string
  readonly explain: string
}

/**
 * Every status word the app renders (task/staged/approval/audit/updater/runner/
 * skill/ollama/ingest/backup states from src/shared/ipc.ts) → a plain label and
 * a one-sentence explanation. The labels for the shared verbs come straight
 * from the brief's plain-language dictionary (pending→waiting, running→in
 * progress, …). Unknown words fall back to the raw word with no explanation.
 */
const STATUS_MAP: Readonly<Record<string, PlainStatus>> = {
  // task states (TaskDto.status)
  pending: { label: 'waiting', explain: 'Queued and waiting to start.' },
  running: { label: 'in progress', explain: 'Being worked on right now.' },
  done: { label: 'finished', explain: 'Completed without a problem.' },
  failed: { label: 'failed', explain: 'Something went wrong and it stopped.' },
  deferred: { label: 'postponed', explain: 'Put off for now; it will try again later.' },

  // staged writes (StagedWriteStatusDto) — a proposed memory change
  staged: { label: 'waiting for review', explain: 'A proposed memory change waiting for your decision.' },
  approved: { label: 'approved', explain: 'You approved it; it is being applied.' },
  rejected: { label: 'declined', explain: 'You declined it, so nothing was changed.' },
  committed: { label: 'saved', explain: 'The change has been saved to memory.' },

  // approvals (ApprovalDto.status) — a permission request
  denied: { label: 'declined', explain: 'You declined this request.' },

  // audit outcome (AuditActionDto.outcome) + generic health
  ok: { label: 'ok', explain: 'Worked as expected.' },
  warn: { label: 'needs attention', explain: 'Working, but not fully healthy.' },
  error: { label: 'error', explain: 'It did not work; the details say why.' },
  undone: { label: 'undone', explain: 'This action was reversed.' },

  // audit kinds (AuditKindDto) — what kind of thing happened
  action: { label: 'agent action', explain: 'Something the assistant did.' },
  'graph-write': { label: 'memory write', explain: 'A change to what the assistant remembers.' },
  'file-write': { label: 'file change', explain: 'A file was written or edited.' },
  'file-delete': { label: 'file removed', explain: 'A file was deleted.' },
  undo: { label: 'undo', explain: 'An earlier action was reversed.' },

  // app updater (UpdaterStateDto) — 'idle'/'disabled' stay plain-neutral
  disabled: { label: 'off', explain: 'Automatic updates are off for this build.' },
  idle: { label: 'idle', explain: 'Not checking for updates right now.' },
  checking: { label: 'checking', explain: 'Looking for a newer version.' },
  'up-to-date': { label: 'up to date', explain: 'You already have the latest version.' },
  downloading: { label: 'downloading', explain: 'Getting the new version.' },
  downloaded: { label: 'ready to install', explain: 'The update is downloaded and ready to install.' },

  // runner health (RunnerHealthStateDto)
  'not-installed': { label: 'not installed', explain: 'The tool it needs has not been installed yet.' },
  'auth-expired': { label: 'sign-in expired', explain: 'The sign-in expired; sign in again to use it.' },
  'quota-exhausted': { label: 'limit reached', explain: 'The usage limit was reached for now.' },
  unknown: { label: 'unknown', explain: 'The status could not be determined.' },
  fallback: { label: 'using a backup', explain: 'The usual helper is down, so a backup is handling this.' },

  // skill version status
  active: { label: 'in use', explain: 'The version being used right now.' },
  candidate: { label: 'being tested', explain: 'A newer version under evaluation.' },
  retired: { label: 'retired', explain: 'An older version, no longer in use.' },

  // skill improvement outcome (SkillImprovementEntryDto.outcome) + drift
  adopted: { label: 'adopted', explain: 'A better version was put into use.' },
  'drift-flagged': { label: 'possible quality drop', explain: 'Its quality may have slipped; worth a look.' },
  'rolled-back': { label: 'rolled back', explain: 'Reverted to the previous version.' },

  // ingest results (IngestDocumentResultDto / IngestCodebaseResultDto status)
  created: { label: 'added', explain: 'Newly added to memory.' },
  replaced: { label: 'replaced', explain: 'An existing item was updated with a new version.' },
  updated: { label: 'updated', explain: 'An existing item was refreshed.' },
  unchanged: { label: 'no change', explain: 'Already up to date; nothing changed.' },

  // local AI helper (OllamaStatusDto.state)
  ready: { label: 'ready', explain: 'The local AI helper (Ollama) is running.' },
  'models-missing': {
    label: 'needs a model',
    explain: 'The local AI helper is running, but a model still needs to download.'
  },
  'daemon-not-running': { label: 'not running', explain: 'The local AI helper (Ollama) is not running.' },

  // examples (SkillDetailDto examples kind)
  success: { label: 'worked', explain: 'An example of the skill working well.' },
  failure: { label: 'did not work', explain: 'An example of the skill going wrong.' },

  // safety flags (InjectionFlagDto.detector)
  regex: { label: 'pattern match', explain: 'Caught by a text-pattern check.' },
  llm: { label: 'AI review', explain: 'Caught by an AI safety review.' },

  // data & backups (BackupKindDto)
  manual: { label: 'manual', explain: 'A backup you made yourself.' },
  auto: { label: 'automatic', explain: 'A backup taken automatically on a schedule.' },
  'pre-reset': { label: 'before reset', explain: 'A safety backup taken before a reset.' },
  'pre-restore': { label: 'before restore', explain: 'A safety backup taken before restoring another backup.' },
  'pre-migration': { label: 'before upgrade', explain: 'A safety backup taken before a data upgrade.' },
  'corrupt-wal': { label: 'auto-recovery', explain: 'A backup taken while recovering from a data problem.' },

  // injection / safety wording used on flags
  flagged: { label: 'needs a look', explain: 'Flagged for your attention.' }
}

/**
 * Plain label + explanation for a raw backend status word. Unknown words return
 * the raw word as the label with an empty explanation (never blank UI).
 */
export function plainStatus(status: string): PlainStatus {
  return STATUS_MAP[status] ?? { label: status, explain: '' }
}

/** "3 changes" / "1 change"; pass an irregular plural when needed. */
export function plural(n: number, singular: string, pluralWord?: string): string {
  const word = n === 1 ? singular : (pluralWord ?? `${singular}s`)
  return `${n} ${word}`
}

/**
 * Friendly label for a raw graph property key (readability addendum R2). A few
 * high-traffic keys get a hand-written phrase; everything else falls back to the
 * key with underscores turned to spaces (`content_hash` → "content hash"). The
 * raw key stays available for the caller to keep in a `title` attribute. `label`
 * is accepted for future per-label overrides and ignored today (one shared map
 * reads well across every node kind).
 */
const PROP_LABELS: Readonly<Record<string, string>> = {
  statement: 'what it says',
  content: 'content',
  instructions: 'instructions',
  name: 'name',
  summary: 'summary',
  description: 'description',
  project_count: 'used in projects',
  source: 'where it came from',
  source_doc: 'from document',
  kind: 'type',
  type: 'type',
  status: 'status',
  tier: 'tier',
  is_global: 'available everywhere',
  benchmark_score: 'quality score',
  current_version: 'current version',
  config_ref: 'config reference',
  content_hash: 'content hash',
  transcript_ref: 'transcript',
  created_at: 'created',
  updated_at: 'updated',
  ingested_at: 'added',
  started_at: 'started',
  ended_at: 'ended'
}

export function plainPropLabel(_label: string, key: string): string {
  return PROP_LABELS[key] ?? key.replace(/_/g, ' ')
}

/**
 * Duration in plain words with a space before the unit: "4.2 s", "2 min",
 * "1 h 5 min". Null/unknown → an em dash. Roomier than format.ts `duration`.
 */
export function plainDuration(ms: number | null | undefined): string {
  if (ms == null || Number.isNaN(ms)) return '—'
  const clamped = Math.max(0, ms)
  const secs = clamped / 1000
  if (secs < 60) {
    // one decimal under 10 s, whole seconds up to a minute
    const value = secs < 10 ? Math.round(secs * 10) / 10 : Math.round(secs)
    return `${value} s`
  }
  const totalMinutes = Math.floor(secs / 60)
  if (totalMinutes < 60) return `${totalMinutes} min`
  const hours = Math.floor(totalMinutes / 60)
  const minutes = totalMinutes % 60
  return minutes === 0 ? `${hours} h` : `${hours} h ${minutes} min`
}

const BYTE_UNITS = ['B', 'KB', 'MB', 'GB', 'TB'] as const

/** Human byte size: "512 B", "1.2 MB" (1024-based; one decimal above bytes). */
export function plainBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < BYTE_UNITS.length - 1) {
    value /= 1024
    unit++
  }
  const rounded = unit === 0 ? Math.round(value) : Math.round(value * 10) / 10
  return `${rounded} ${BYTE_UNITS[unit] ?? 'B'}`
}

/**
 * USD with precision that suits the size: sub-cent gets 4 decimals, under a
 * dollar 3, otherwise 2 — so tiny model charges stay legible ("$0.0132") while
 * larger totals read cleanly ("$12.50").
 */
export function plainUsd(usd: number): string {
  if (!Number.isFinite(usd)) return '$0.00'
  const abs = Math.abs(usd)
  const decimals = abs === 0 ? 2 : abs < 0.01 ? 4 : abs < 1 ? 3 : 2
  return `$${usd.toFixed(decimals)}`
}

/** Local calendar-day key for an ISO timestamp, "YYYY-MM-DD" (empty if unparseable). */
export function dayKey(iso: string): string {
  const date = new Date(iso)
  return Number.isNaN(date.getTime()) ? '' : localDayKey(date)
}

/** Day keys for the last `n` days, oldest → newest, ending today (local). */
export function lastNDays(n: number): readonly string[] {
  const today = new Date()
  const keys: string[] = []
  for (let i = n - 1; i >= 0; i--) {
    keys.push(localDayKey(new Date(today.getFullYear(), today.getMonth(), today.getDate() - i)))
  }
  return keys
}

/** "YYYY-MM-DD" from a Date's local components (shared by dayKey/lastNDays). */
function localDayKey(date: Date): string {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}
