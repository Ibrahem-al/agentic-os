/**
 * Plain-language engine for staged writes (readability addendum R1) — the ONE
 * place a proposed memory change becomes a "what this does / why / where it came
 * from" a non-technical person can read. Pure functions over the DTO only (no
 * React, no DOM), so both the Approvals row and its diff modal share one sentence
 * engine, and the templates can be pinned by a plain vitest.
 *
 * Motivating feedback: approvals were "very hard to understand for a human". The
 * confusing row was a `kind:extraction` write proposing a de-duplicated Claude
 * Code skill node + a USES edge; `summarizeStagedWrite` turns exactly that into
 * "Found the Claude Code skill 'X' in <project> (shared by 7 projects) — saves it
 * once as a Skill and links <project> as a user of it."
 *
 * Every template composes from validated payload fields (targetLabel, statement/
 * name/content heads, evidence, reason, source, project_count, proposedBy). An
 * unknown shape degrades to a grammatical fallback — never raw JSON in the `what`
 * slot.
 */
import type { IpcNodeLabel, JsonObject, JsonValue, StagedWriteDto } from '../../../shared/ipc'

/**
 * A place a staged write traces back to. `session`/`project`/`node` chips are
 * clickable (open the node in the Memory inspector — R3 deep link); a `file` is
 * plain mono text (the renderer is sandboxed — path text + "found in" phrasing is
 * as far as it goes, no filesystem opening).
 */
export interface SourceRef {
  readonly kind: 'session' | 'project' | 'node' | 'file'
  readonly label?: IpcNodeLabel
  readonly id?: string
  readonly display: string
  readonly path?: string
}

export interface StagedSummary {
  /** One plain sentence: what committing this row does. Always present. */
  readonly what: string
  /** Why the agent proposed it (reason / evidence), when the payload carries one. */
  readonly why?: string
  /** Where it came from — resolved to clickable/inert chips. */
  readonly source?: readonly SourceRef[]
}

export interface StagedSummaryOptions {
  /**
   * Optional id → friendly display resolver (a Session/Project/node name the
   * caller already knows). Absent ⇒ the id is used verbatim, which is honest but
   * opaque; the source chip still deep-links to the node where the name shows.
   */
  readonly displayFor?: (ref: { readonly label?: IpcNodeLabel; readonly id: string }) => string | undefined
}

// ── payload narrowing (StagedWriteDto.payload is JsonObject) ──────────────────

function asObject(value: JsonValue | undefined): JsonObject | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value : null
}
function asArray(value: JsonValue | undefined): readonly JsonValue[] {
  return Array.isArray(value) ? value : []
}
function asString(value: JsonValue | undefined): string | null {
  return typeof value === 'string' && value !== '' ? value : null
}
function asNumber(value: JsonValue | undefined): number | null {
  return typeof value === 'number' ? value : null
}

/** Trim a long field so it reads inside a sentence (never mid-JSON). */
function head(text: string, max = 80): string {
  const clean = text.replace(/\s+/g, ' ').trim()
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean
}

/** Plain noun for a graph label ("Preference" → "preference", "Knowledge" → "note"). */
const LABEL_NOUN: Readonly<Record<IpcNodeLabel, string>> = {
  Session: 'work session',
  Project: 'project',
  Skill: 'skill',
  SkillVersion: 'skill version',
  Example: 'example',
  Correction: 'correction',
  Preference: 'preference',
  MCP: 'MCP tool',
  Plugin: 'plugin',
  Component: 'component',
  Document: 'document',
  Knowledge: 'note',
  Tag: 'tag'
}

function nounFor(label: string | null | undefined): string {
  const known = label != null ? (LABEL_NOUN as Record<string, string | undefined>)[label] : undefined
  return known ?? (label != null && label !== '' ? label.toLowerCase() : 'memory')
}

/** The human handle inside an extraction/correction node's props. */
function handleOf(props: JsonObject | null): string | null {
  if (props === null) return null
  return (
    asString(props['statement']) ??
    asString(props['name']) ??
    asString(props['content']) ??
    asString(props['summary']) ??
    asString(props['title'])
  )
}

// ── source resolution ─────────────────────────────────────────────────────────

/** The session id a staged write traces to — payload first, then the proposer tag. */
function sessionIdOf(row: StagedWriteDto): string | null {
  const fromPayload = asString(row.payload['session']) ?? asString(row.payload['sessionId'])
  if (fromPayload !== null) return fromPayload
  const match = /^(?:claude-mcp|extraction-agent):(.+)$/.exec(row.proposedBy)
  return match !== null && match[1] !== undefined && match[1] !== '' ? match[1] : null
}

function sessionRef(row: StagedWriteDto, opts: StagedSummaryOptions | undefined): SourceRef | null {
  const id = sessionIdOf(row)
  if (id === null) return null
  return { kind: 'session', label: 'Session', id, display: opts?.displayFor?.({ label: 'Session', id }) ?? id }
}

/**
 * The plain "can't be applied" verdict recorded on a row whose staged payload
 * failed §18 property validation at approve time (null when the row is clean).
 * The backend writes `{ invalidPayload: true, verdict }` into validation_json
 * (approveStagedWrite); the review panel shows this verdict as a plain warning
 * and de-emphasizes Approve. Raw technical detail stays behind the diff
 * disclosure — this is the human-readable lead.
 */
export function invalidPayloadVerdictOf(row: StagedWriteDto): string | null {
  const v = row.validation
  if (v === null || v['invalidPayload'] !== true) return null
  return asString(v['verdict'])
}

/**
 * Human title for a proposer id — the plain group header the addendum asks for
 * ("Proposed by Claude" / "From the extraction agent" / "Added by you"). The raw
 * id stays in the caller's title attribute.
 */
export function plainProposerTitle(proposedBy: string): string {
  if (proposedBy.startsWith('claude-mcp:')) return 'Proposed by Claude'
  if (proposedBy.startsWith('extraction-agent:')) return 'From the extraction agent'
  if (proposedBy === 'user:dashboard') return 'Added by you'
  return proposedBy
}

// ── per-kind templates ─────────────────────────────────────────────────────────

function summarizeCorrection(row: StagedWriteDto, opts: StagedSummaryOptions | undefined): StagedSummary {
  const patch = asObject(row.payload['patch'])
  const noun = nounFor(row.targetLabel)
  const statement = patch !== null ? asString(patch['statement']) : null
  const what =
    statement !== null
      ? `Updates the ${noun} to say '${head(statement)}'.`
      : `Updates the ${noun}.`
  const reason = asString(row.payload['reason'])
  const session = sessionRef(row, opts)
  const target =
    row.targetLabel !== null && row.targetId !== null
      ? nodeRef(row.targetLabel, row.targetId, opts, statement ?? undefined)
      : null
  return build(what, reason, [session, target])
}

function summarizeExtraction(row: StagedWriteDto, opts: StagedSummaryOptions | undefined): StagedSummary {
  const p = row.payload
  const op = asString(p['op'])
  const node = asObject(p['node'])
  const props = node !== null ? asObject(node['props']) : null
  const nodeLabel = node !== null ? asString(node['label']) : null
  const why = asString(p['evidence']) ?? asString(p['reason'])
  const session = sessionRef(row, opts)

  // The confusing row: a de-duplicated Claude Code Skill node + a Project USES
  // edge. project_count > 1 ⇒ the skill is shared; name it once, link the project.
  if (nodeLabel === 'Skill' && props !== null) {
    const name = asString(props['name']) ?? 'a skill'
    const projectCount = asNumber(props['project_count'])
    const project = projectFromUsesEdge(p, opts)
    const projectName = project?.display ?? 'this project'
    const skillNoun = asString(props['kind']) === 'claude-code-skill' ? 'Claude Code skill' : 'skill'
    const what =
      projectCount !== null && projectCount > 1
        ? `Found the ${skillNoun} '${name}' in ${projectName} (shared by ${projectCount} projects) — saves it once as a Skill and links ${projectName} as a user of it.`
        : `Found the ${skillNoun} '${name}' in ${projectName} — saves it as a Skill and links ${projectName} to it.`
    // The skill's `source` path rides in the node props (not the payload root).
    return build(what, why, [session, project, fileSourceRef(asString(props['source']))])
  }

  const fileRef = fileSourceRef(asString(p['source']))

  const noun = nounFor(nodeLabel ?? row.targetLabel)
  const statement = handleOf(props)
  const sessionName = session?.display ?? null
  let what: string
  if (op === 'merge' && node === null) {
    // Evidence-only merge onto an existing node — its content is untouched.
    what = `Adds new evidence to an existing ${nounFor(row.targetLabel)}.`
  } else if (statement !== null) {
    const body = `adds the ${noun} '${head(statement)}'`
    what = sessionName !== null ? `From session ${sessionName}: ${body}.` : `${cap(body)}.`
  } else {
    const body = `adds a new ${noun}`
    what = sessionName !== null ? `From session ${sessionName}: ${body}.` : `${cap(body)}.`
  }
  const target =
    node !== null && nodeLabel !== null
      ? nodeRef(nodeLabel, asString(node['id']) ?? '', opts, statement ?? undefined)
      : row.targetLabel !== null && row.targetId !== null
        ? nodeRef(row.targetLabel, row.targetId, opts, statement ?? undefined)
        : null
  return build(what, why, [session, target, fileRef])
}

function summarizeSkillImprovement(row: StagedWriteDto, opts: StagedSummaryOptions | undefined): StagedSummary {
  const name = asString(row.payload['skillName']) ?? 'a skill'
  const what = `Adopts an improved version of the skill '${name}'.`
  const reason = asString(row.payload['reason'])
  const skillId = asString(row.payload['skillId'])
  const target = skillId !== null ? nodeRef('Skill', skillId, opts, name) : null
  return build(what, reason, [target])
}

function summarizeSkillImport(row: StagedWriteDto, opts: StagedSummaryOptions | undefined): StagedSummary {
  const p = row.payload
  const name = asString(p['name']) ?? 'a skill'
  const projectName = asString(p['projectName']) ?? asString(p['projectId'])
  const projectId = asString(p['projectId'])
  const proposal = p['proposal'] === true
  const fileRef = fileSourceRef(asString(p['source']))
  const project =
    projectId !== null
      ? ({
          kind: 'project',
          label: 'Project',
          id: projectId,
          display: opts?.displayFor?.({ label: 'Project', id: projectId }) ?? projectName ?? projectId
        } as SourceRef)
      : null
  let what: string
  if (asString(p['mode']) === 'revision') {
    what = `Saves a revised version of the skill '${name}' — held for your review, never used until you approve it.`
  } else if (proposal) {
    what =
      projectName !== null
        ? `Adds a new skill '${name}', proposed from the documentation of ${projectName}.`
        : `Adds a new skill '${name}', proposed from the project's documentation.`
  } else {
    what =
      projectName !== null
        ? `Adds a new skill '${name}' found in ${projectName}.`
        : `Adds a new skill '${name}'.`
  }
  return build(what, undefined, [project, fileRef])
}

function summarizeDedupeMerge(row: StagedWriteDto, opts: StagedSummaryOptions | undefined): StagedSummary {
  const p = row.payload
  const label = asString(p['label']) ?? row.targetLabel
  const noun = nounFor(label)
  const n = asArray(p['removeIds']).length
  const keepDisplay = asString(p['keepDisplay']) ?? asString(p['keepId']) ?? 'one'
  const what = `Merges ${n} duplicate ${noun}${n === 1 ? '' : 's'} into one, keeping '${head(keepDisplay)}'.`
  const rationale = asString(p['rationale'])
  const keepId = asString(p['keepId'])
  const keep = keepId !== null && label !== null ? nodeRef(label, keepId, opts, keepDisplay) : null
  return build(what, rationale, [keep])
}

// ── entry point ─────────────────────────────────────────────────────────────

export function summarizeStagedWrite(row: StagedWriteDto, opts?: StagedSummaryOptions): StagedSummary {
  switch (row.kind) {
    case 'propose_correction':
    case 'correction':
      return summarizeCorrection(row, opts)
    case 'extraction':
      return summarizeExtraction(row, opts)
    case 'skill-improvement':
      return summarizeSkillImprovement(row, opts)
    case 'skill-import':
      return summarizeSkillImport(row, opts)
    case 'dedupe-merge':
      return summarizeDedupeMerge(row, opts)
    default:
      return summarizeUnknown(row, opts)
  }
}

/** Grammatical last resort — a target-led sentence, never raw JSON. */
function summarizeUnknown(row: StagedWriteDto, opts: StagedSummaryOptions | undefined): StagedSummary {
  const noun = nounFor(row.targetLabel)
  const what = `Changes ${row.targetLabel !== null ? `a ${noun}` : 'something in memory'}.`
  const target =
    row.targetLabel !== null && row.targetId !== null ? nodeRef(row.targetLabel, row.targetId, opts) : null
  return build(what, asString(row.payload['reason']) ?? undefined, [target])
}

// ── shared builders ───────────────────────────────────────────────────────────

function nodeRef(
  label: string,
  id: string,
  opts: StagedSummaryOptions | undefined,
  fallbackDisplay?: string
): SourceRef | null {
  if (id === '') return null
  const known = (LABEL_NOUN as Record<string, string | undefined>)[label] !== undefined
  const typedLabel = known ? (label as IpcNodeLabel) : undefined
  const display = opts?.displayFor?.({ label: typedLabel, id }) ?? fallbackDisplay ?? id
  return { kind: 'node', ...(typedLabel !== undefined ? { label: typedLabel } : {}), id, display: head(display, 60) }
}

function projectFromUsesEdge(payload: JsonObject, opts: StagedSummaryOptions | undefined): SourceRef | null {
  for (const raw of asArray(payload['edges'])) {
    const edge = asObject(raw)
    if (edge === null || asString(edge['type']) !== 'USES') continue
    const from = asObject(edge['from'])
    const id = from !== null ? asString(from['id']) : null
    if (id === null) continue
    return { kind: 'project', label: 'Project', id, display: opts?.displayFor?.({ label: 'Project', id }) ?? id }
  }
  return null
}

function fileSourceRef(source: string | null): SourceRef | null {
  if (source === null) return null
  // An `llm-proposal:<name>` source is not a real path — skip the file chip.
  if (source.startsWith('llm-proposal:')) return null
  return { kind: 'file', display: source, path: source }
}

function build(
  what: string,
  why: string | null | undefined,
  refs: readonly (SourceRef | null)[]
): StagedSummary {
  const source = refs.filter((r): r is SourceRef => r !== null)
  return {
    what,
    ...(why !== null && why !== undefined && why !== '' ? { why } : {}),
    ...(source.length > 0 ? { source } : {})
  }
}

function cap(text: string): string {
  return text.length === 0 ? text : text.charAt(0).toUpperCase() + text.slice(1)
}
