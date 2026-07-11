/**
 * Readability addendum R1: the staged-write sentence engine. Pure over the DTO,
 * so it is pinned here as plain vitest (no DOM). These templates are the exact
 * sentences the Approvals row + diff modal ship — docs quote them from here.
 */
import { describe, expect, it } from 'vitest'
import type { JsonObject, StagedWriteDto } from '../../src/shared/ipc'
import { plainProposerTitle, summarizeStagedWrite } from '../../src/renderer/src/lib/stagedSummary'

function sw(over: Partial<StagedWriteDto> & { kind: string; payload: JsonObject }): StagedWriteDto {
  return {
    id: 'sw-1',
    proposedBy: 'extraction-agent:sess-1',
    targetLabel: null,
    targetId: null,
    status: 'staged',
    validation: null,
    createdAt: '2026-07-11T00:00:00.000Z',
    decidedAt: null,
    committedAt: null,
    requiresEmbedder: false,
    ...over
  }
}

describe('summarizeStagedWrite — extraction', () => {
  it('names the session and the new preference', () => {
    const row = sw({
      kind: 'extraction',
      proposedBy: 'extraction-agent:sess-1',
      targetLabel: 'Preference',
      targetId: 'p1',
      payload: {
        op: 'create',
        node: { label: 'Preference', id: 'p1', props: { statement: 'weak guess preference' } },
        embedOnCommit: true,
        edges: [],
        evidence: 'the user preferred lighter colors',
        reason: 'stated in the session',
        session: 'sess-1'
      }
    })
    const summary = summarizeStagedWrite(row)
    expect(summary.what).toBe("From session sess-1: adds the preference 'weak guess preference'.")
    expect(summary.why).toBe('the user preferred lighter colors')
    expect(summary.source?.some((s) => s.kind === 'session' && s.id === 'sess-1')).toBe(true)
  })

  it('makes the de-duplicated Claude Code skill row self-explanatory (the confusing row)', () => {
    const row = sw({
      kind: 'extraction',
      proposedBy: 'extraction-agent:sess-9',
      targetLabel: 'Skill',
      targetId: 'skl-deploy',
      payload: {
        op: 'merge',
        node: {
          label: 'Skill',
          id: 'skl-deploy',
          props: { name: 'deploy storefront', kind: 'claude-code-skill', project_count: 7, source: '.claude/skills' }
        },
        edges: [{ type: 'USES', from: { label: 'Project', id: 'prj-store' }, to: { label: 'Skill', id: 'skl-deploy' } }],
        evidence: 'found at .claude/skills/deploy (symlink); shared across 7 projects',
        reason: 'the same skill appears in every project',
        session: 'sess-9'
      }
    })
    // With a project-name resolver it reads exactly the target sentence.
    const named = summarizeStagedWrite(row, {
      displayFor: (ref) => (ref.id === 'prj-store' ? 'store-front' : undefined)
    })
    expect(named.what).toBe(
      "Found the Claude Code skill 'deploy storefront' in store-front (shared by 7 projects) — saves it once as a Skill and links store-front as a user of it."
    )
    // Without a resolver it degrades to the project id — never raw JSON.
    const raw = summarizeStagedWrite(row)
    expect(raw.what).toContain("Found the Claude Code skill 'deploy storefront' in prj-store (shared by 7 projects)")
    expect(raw.source?.some((s) => s.kind === 'project' && s.id === 'prj-store')).toBe(true)
    expect(raw.source?.some((s) => s.kind === 'file' && s.path === '.claude/skills')).toBe(true)
  })
})

describe('summarizeStagedWrite — correction', () => {
  it('reads as a plain update with the new statement', () => {
    const row = sw({
      kind: 'propose_correction',
      proposedBy: 'claude-mcp:sess-2',
      targetLabel: 'Preference',
      targetId: 'p2',
      payload: { patch: { statement: 'two-space indentation' }, reason: 'user asked for it' }
    })
    const summary = summarizeStagedWrite(row)
    expect(summary.what).toBe("Updates the preference to say 'two-space indentation'.")
    expect(summary.why).toBe('user asked for it')
    expect(summary.source?.some((s) => s.kind === 'session' && s.id === 'sess-2')).toBe(true)
  })
})

describe('summarizeStagedWrite — skill-import', () => {
  it('a create reads as a new skill from a named project', () => {
    const row = sw({
      kind: 'skill-import',
      proposedBy: 'user:dashboard',
      targetLabel: 'Skill',
      payload: {
        name: 'deploy',
        projectName: 'my-project',
        projectId: 'prj-1',
        mode: 'create',
        proposal: false,
        source: '.claude/skills/deploy/SKILL.md',
        confidence: 1
      }
    })
    const summary = summarizeStagedWrite(row)
    expect(summary.what).toBe("Adds a new skill 'deploy' found in my-project.")
    expect(summary.source?.some((s) => s.kind === 'project' && s.id === 'prj-1')).toBe(true)
  })

  it('a proposal notes it came from the docs; a revision is held for review', () => {
    const proposal = summarizeStagedWrite(
      sw({
        kind: 'skill-import',
        payload: { name: 'triage', projectName: 'acme', projectId: 'prj-2', mode: 'create', proposal: true, source: 'llm-proposal:triage' }
      })
    )
    expect(proposal.what).toBe("Adds a new skill 'triage', proposed from the documentation of acme.")
    // llm-proposal:* is not a real path — no file chip.
    expect(proposal.source?.some((s) => s.kind === 'file')).toBeFalsy()

    const revision = summarizeStagedWrite(
      sw({ kind: 'skill-import', payload: { name: 'triage', projectId: 'prj-2', mode: 'revision', proposal: false } })
    )
    expect(revision.what).toContain("Saves a revised version of the skill 'triage'")
  })
})

describe('summarizeStagedWrite — dedupe-merge & skill-improvement', () => {
  it('dedupe-merge keeps one and folds the rest', () => {
    const summary = summarizeStagedWrite(
      sw({
        kind: 'dedupe-merge',
        targetLabel: 'Preference',
        payload: {
          label: 'Preference',
          keepId: 'p1',
          removeIds: ['p2', 'p3'],
          keepDisplay: 'likes dark mode',
          rationale: 'same idea, three times'
        }
      })
    )
    expect(summary.what).toBe("Merges 2 duplicate preferences into one, keeping 'likes dark mode'.")
    expect(summary.why).toBe('same idea, three times')
  })

  it('skill-improvement reads as adopting a better version', () => {
    const summary = summarizeStagedWrite(
      sw({ kind: 'skill-improvement', payload: { skillName: 'reviewer', reason: 'benchmark won', skillId: 'skl-1' } })
    )
    expect(summary.what).toBe("Adopts an improved version of the skill 'reviewer'.")
    expect(summary.why).toBe('benchmark won')
  })
})

describe('summarizeStagedWrite — unknown kinds degrade grammatically', () => {
  it('never emits raw JSON in the what slot', () => {
    const summary = summarizeStagedWrite(sw({ kind: 'mystery', targetLabel: 'Tag', targetId: 't1', payload: {} }))
    expect(summary.what).toBe('Changes a tag.')
    expect(summary.what).not.toContain('{')
  })
})

describe('plainProposerTitle', () => {
  it('maps proposer ids to plain titles', () => {
    expect(plainProposerTitle('claude-mcp:sess-1')).toBe('Proposed by Claude')
    expect(plainProposerTitle('extraction-agent:sess-1')).toBe('From the extraction agent')
    expect(plainProposerTitle('user:dashboard')).toBe('Added by you')
    expect(plainProposerTitle('rule-nightly-42')).toBe('rule-nightly-42')
  })
})
