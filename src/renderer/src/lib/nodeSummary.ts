/**
 * Plain-language node summaries (readability addendum R2) — one sentence that
 * says what a graph node IS, composed from its props + edge counts, for the
 * Memory inspector's lead line. Pure over the DTO (no React, no DOM) so it is
 * pinned by a plain vitest and importable anywhere.
 *
 * `nodeHandle` extracts the human handle (name / statement / content head) a
 * label leads with — used both here and as the inspector heading fallback when a
 * deep link arrives without a carried display (R3).
 */
import type { IpcNodeLabel, JsonObject, JsonValue, MemoryNodeDetailDto } from '../../../shared/ipc'

function asString(value: JsonValue | undefined): string | null {
  return typeof value === 'string' && value !== '' ? value : null
}

function head(text: string, max = 80): string {
  const clean = text.replace(/\s+/g, ' ').trim()
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean
}

/** The human handle a label leads with (name / statement / content / …). */
export function nodeHandle(label: IpcNodeLabel, props: JsonObject): string | null {
  const first =
    label === 'Preference'
      ? asString(props['statement'])
      : label === 'Knowledge' || label === 'Correction' || label === 'Example'
        ? asString(props['content'])
        : asString(props['name'])
  return (
    first ??
    asString(props['name']) ??
    asString(props['statement']) ??
    asString(props['content']) ??
    asString(props['title']) ??
    asString(props['summary'])
  )
}

/** Count incoming edges of a given type (e.g. how many projects USE a skill). */
function incomingCount(detail: MemoryNodeDetailDto, type: string): number {
  return detail.incoming.filter((e) => e.type === type).length
}

/** The display of the first incoming edge of a type (e.g. a chunk's parent doc). */
function incomingDisplay(detail: MemoryNodeDetailDto, type: string): string | null {
  const edge = detail.incoming.find((e) => e.type === type)
  return edge !== undefined ? edge.display : null
}

function projects(n: number): string {
  return `${n} ${n === 1 ? 'project' : 'projects'}`
}

/**
 * One plain sentence describing a node. Covers every label; an unknown/handle-less
 * node degrades to "A <label>." — never blank, never raw JSON.
 */
export function summarizeNode(detail: MemoryNodeDetailDto): string {
  const { label, props } = detail
  const handle = nodeHandle(label, props)

  switch (label) {
    case 'Preference':
      return handle !== null ? `A preference: '${head(handle)}'.` : 'A preference.'
    case 'Knowledge': {
      const doc = incomingDisplay(detail, 'HAS_CHUNK')
      const body = handle !== null ? `: '${head(handle)}'` : ''
      return doc !== null ? `A note from ${head(doc, 60)}${body}.` : `A note${body}.`
    }
    case 'Skill': {
      const used = incomingCount(detail, 'USES')
      const kind = asString(props['kind'])
      const noun = kind === 'claude-code-skill' ? 'Claude Code skill' : 'skill'
      const usage = used === 0 ? 'not linked to any project yet' : `used by ${projects(used)}`
      return handle !== null ? `A ${noun} named '${head(handle)}', ${usage}.` : `A ${noun}, ${usage}.`
    }
    case 'SkillVersion': {
      const status = asString(props['status'])
      return status !== null ? `A skill revision (${status}).` : 'A skill revision.'
    }
    case 'Session':
      return 'A past work session.'
    case 'Project':
      return handle !== null ? `A project named '${head(handle)}'.` : 'A project.'
    case 'Tag':
      return handle !== null ? `A label: '${head(handle)}'.` : 'A label.'
    case 'Correction':
      return handle !== null ? `A correction: '${head(handle)}'.` : 'A correction.'
    case 'Example': {
      const kind = asString(props['kind'])
      const body = handle !== null ? `: '${head(handle)}'` : ''
      return kind !== null ? `An example (${kind})${body}.` : `An example${body}.`
    }
    case 'Document': {
      const source = asString(props['source'])
      return source !== null ? `A document from ${head(source, 60)}.` : 'A document.'
    }
    case 'MCP':
      return handle !== null ? `An MCP tool named '${head(handle)}'.` : 'An MCP tool.'
    case 'Plugin':
      return handle !== null ? `A plugin named '${head(handle)}'.` : 'A plugin.'
    case 'Component': {
      const type = asString(props['type'])
      return handle !== null
        ? `A code component named '${head(handle)}'${type !== null ? ` (${type})` : ''}.`
        : 'A code component.'
    }
    default:
      return handle !== null ? `${label}: ${head(handle)}.` : `A ${String(label).toLowerCase()}.`
  }
}
