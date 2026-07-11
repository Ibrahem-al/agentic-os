/**
 * Readability addendum R2: the Memory-inspector node summary. Pure over the
 * detail DTO — pinned here as plain vitest (no DOM).
 */
import { describe, expect, it } from 'vitest'
import type { IpcNodeLabel, JsonObject, MemoryEdgeDto, MemoryNodeDetailDto } from '../../src/shared/ipc'
import { nodeHandle, summarizeNode } from '../../src/renderer/src/lib/nodeSummary'

function detail(
  label: IpcNodeLabel,
  props: JsonObject,
  edges?: { incoming?: MemoryEdgeDto[]; outgoing?: MemoryEdgeDto[] }
): MemoryNodeDetailDto {
  return { label, id: `${label}-1`, props, incoming: edges?.incoming ?? [], outgoing: edges?.outgoing ?? [] }
}

function edge(type: string, label: IpcNodeLabel, display: string): MemoryEdgeDto {
  return { type, direction: 'in', label, id: `${label}-x`, display, props: {} }
}

describe('summarizeNode', () => {
  it('Preference reads its statement', () => {
    expect(summarizeNode(detail('Preference', { statement: 'likes dark mode' }))).toBe("A preference: 'likes dark mode'.")
  })

  it('Skill counts the projects that use it, and names its type', () => {
    const used = detail('Skill', { name: 'deploy', kind: 'claude-code-skill' }, {
      incoming: [edge('USES', 'Project', 'store-front'), edge('USES', 'Project', 'admin')]
    })
    expect(summarizeNode(used)).toBe("A Claude Code skill named 'deploy', used by 2 projects.")

    const unused = detail('Skill', { name: 'lonely' })
    expect(summarizeNode(unused)).toBe("A skill named 'lonely', not linked to any project yet.")
  })

  it('Knowledge names its source document', () => {
    const chunk = detail('Knowledge', { content: 'the staging db resets nightly' }, {
      incoming: [edge('HAS_CHUNK', 'Document', 'runbook.md')]
    })
    expect(summarizeNode(chunk)).toBe("A note from runbook.md: 'the staging db resets nightly'.")
  })

  it('covers Session / Project / Tag', () => {
    expect(summarizeNode(detail('Session', { transcript_ref: 'sess-1' }))).toBe('A past work session.')
    expect(summarizeNode(detail('Project', { name: 'acme' }))).toBe("A project named 'acme'.")
    expect(summarizeNode(detail('Tag', { name: 'onboarding' }))).toBe("A label: 'onboarding'.")
  })

  it('degrades handle-less nodes to a plain "A <thing>." — never blank, never JSON', () => {
    expect(summarizeNode(detail('Document', {}))).toBe('A document.')
  })
})

describe('nodeHandle', () => {
  it('extracts the human handle a label leads with', () => {
    expect(nodeHandle('Preference', { statement: 's' })).toBe('s')
    expect(nodeHandle('Skill', { name: 'deploy' })).toBe('deploy')
    expect(nodeHandle('Knowledge', { content: 'c' })).toBe('c')
    expect(nodeHandle('Tag', {})).toBeNull()
  })
})
