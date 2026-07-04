/**
 * Candidate text rendering: fetch the §18 domain properties of every candidate
 * node and render one text per node — the exact string the cross-encoder
 * scores and the bundle carries. Read-only (direct read connection).
 */
import type { NodeLabel, Row, StorageEngine } from '../storage'
import { candidateKey } from './fusion'

/** The labels that can appear as retrieval candidates (seeds + expansion). */
export type CandidateLabel =
  | 'Project'
  | 'Skill'
  | 'Preference'
  | 'Knowledge'
  | 'SkillVersion'
  | 'Example'
  | 'MCP'
  | 'Plugin'
  | 'Component'

interface LabelRenderSpec {
  /** Columns fetched alongside id. */
  readonly columns: readonly string[]
  readonly render: (row: Row) => string
}

const str = (row: Row, column: string): string => {
  const v = row[column]
  return v === null || v === undefined ? '' : String(v)
}

const joinNonEmpty = (parts: string[], sep: string): string => parts.filter((p) => p !== '').join(sep)

const RENDERERS: Readonly<Record<CandidateLabel, LabelRenderSpec>> = {
  Project: {
    columns: ['name', 'summary'],
    render: (r) => joinNonEmpty([str(r, 'name'), str(r, 'summary')], ' — ')
  },
  Skill: {
    columns: ['name', 'instructions'],
    render: (r) => joinNonEmpty([str(r, 'name'), str(r, 'instructions')], ': ')
  },
  Preference: {
    columns: ['statement'],
    render: (r) => str(r, 'statement')
  },
  Knowledge: {
    columns: ['content'],
    render: (r) => str(r, 'content')
  },
  SkillVersion: {
    columns: ['status', 'instructions'],
    render: (r) => joinNonEmpty([`${str(r, 'status')} skill version`, str(r, 'instructions')], ': ')
  },
  Example: {
    columns: ['kind', 'content'],
    render: (r) => joinNonEmpty([`${str(r, 'kind')} example`, str(r, 'content')], ': ')
  },
  MCP: {
    columns: ['name'],
    render: (r) => joinNonEmpty(['MCP server', str(r, 'name')], ' ')
  },
  Plugin: {
    columns: ['name'],
    render: (r) => joinNonEmpty(['plugin', str(r, 'name')], ' ')
  },
  Component: {
    columns: ['name', 'type'],
    render: (r) => {
      const name = str(r, 'name')
      const type = str(r, 'type')
      return joinNonEmpty(['component', name, type === '' ? '' : `(${type})`], ' ')
    }
  }
}

export function isCandidateLabel(label: NodeLabel): label is CandidateLabel {
  return label in RENDERERS
}

/**
 * Fetch + render the text of every requested node, keyed by candidateKey.
 * Nodes that no longer exist are simply absent from the result.
 */
export async function fetchNodeTexts(
  engine: StorageEngine,
  refs: readonly { label: CandidateLabel; id: string }[]
): Promise<Map<string, string>> {
  const byLabel = new Map<CandidateLabel, string[]>()
  for (const ref of refs) {
    const list = byLabel.get(ref.label) ?? []
    list.push(ref.id)
    byLabel.set(ref.label, list)
  }
  const texts = new Map<string, string>()
  await Promise.all(
    [...byLabel.entries()].map(async ([label, ids]) => {
      const spec = RENDERERS[label]
      const cols = spec.columns.map((c) => `n.${c} AS ${c}`).join(', ')
      const rows = await engine.cypher(
        `UNWIND $ids AS nid MATCH (n:${label} {id: nid}) RETURN n.id AS id, ${cols}`,
        { ids }
      )
      for (const row of rows) {
        texts.set(candidateKey(label, String(row['id'])), spec.render(row))
      }
    })
  )
  return texts
}
