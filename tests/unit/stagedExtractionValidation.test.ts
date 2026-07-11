/**
 * Post-release fix: staged-extraction §18 property validation. Pure over the
 * schema (no engine, no DB) — pins the exact rules and the shipped copy:
 *  - node props must be writable for the label (minus engine-owned keys);
 *  - per-label required props must be present;
 *  - edges must be REL_TABLES-legal (from,to) pairs;
 *  - the internal extraction agent's legitimate node shapes still pass.
 */
import { describe, expect, it } from 'vitest'
import {
  extractionStagingErrorMessage,
  invalidPayloadVerdict,
  validateExtractionStaging
} from '../../src/main/security'

describe('validateExtractionStaging — §18 node property rules', () => {
  it('flags the exact user shape: a Skill with non-schema props and no instructions', () => {
    const issue = validateExtractionStaging({
      node: {
        label: 'Skill',
        props: {
          description: 'A pro UI/UX skill',
          kind: 'claude-code-skill',
          name: 'skill-ui-ux-pro-max',
          project_count: 3,
          source: '.claude/skills/ui-ux'
        }
      },
      edges: []
    })
    expect(issue).not.toBeNull()
    // name IS a Skill prop (not offending); description/kind/project_count/source
    // are not; instructions is required and missing.
    expect(issue!.node).toEqual({
      label: 'Skill',
      offending: ['description', 'kind', 'project_count', 'source'],
      missing: ['instructions']
    })
    expect(issue!.edges).toHaveLength(0)
  })

  it('the friendly verdict is the shipped user-facing copy', () => {
    const issue = validateExtractionStaging({
      node: { label: 'Skill', props: { description: 'x', kind: 'y', name: 'n', project_count: 3, source: 's' } },
      edges: []
    })!
    expect(invalidPayloadVerdict(issue)).toBe(
      "This proposal can't be applied: a Skill doesn't have the properties description, kind, project_count, source, " +
        "and it's missing the required instructions. Decline it — if the skill is real, re-ingest the project and " +
        'approve the properly-formed version.'
    )
  })

  it('the agent-facing message names the label, offending + missing keys, and points at ingest_codebase', () => {
    const issue = validateExtractionStaging({
      node: { label: 'Skill', props: { description: 'x', name: 'n' } },
      edges: []
    })!
    const msg = extractionStagingErrorMessage('propose_extraction', issue)
    expect(msg).toContain('propose_extraction')
    expect(msg).toContain('Skill')
    expect(msg).toContain('description')
    expect(msg).toContain('instructions')
    expect(msg).toContain('ingest_codebase')
  })

  it("accepts the internal extraction agent's legitimate node shapes", () => {
    // Component create: { name, type, extracted_by, confidence } (write.ts stagedItem)
    expect(
      validateExtractionStaging({
        node: {
          label: 'Component',
          props: { name: 'CheckoutForm', type: 'component', extracted_by: 'extraction@0.0.1/llm-local', confidence: 0.4 }
        },
        edges: [{ type: 'EXTRACTED_FROM', from: { label: 'Component' }, to: { label: 'Session' } }]
      })
    ).toBeNull()
    // Preference create: { statement, extracted_by, confidence }
    expect(
      validateExtractionStaging({
        node: {
          label: 'Preference',
          props: { statement: 'prefer pnpm', extracted_by: 'extraction@0.0.1/llm-local', confidence: 0.4 }
        },
        edges: [{ type: 'APPLIES_TO', from: { label: 'Preference' }, to: { label: 'Tag' } }]
      })
    ).toBeNull()
    // Correction create: { content } only — Correction carries no provenance columns
    expect(
      validateExtractionStaging({
        node: { label: 'Correction', props: { content: 'do not use var' } },
        edges: [{ type: 'OBSERVED_IN', from: { label: 'Correction' }, to: { label: 'Session' } }]
      })
    ).toBeNull()
    // Evidence-only merge: node null + a legal edge
    expect(
      validateExtractionStaging({
        node: null,
        edges: [{ type: 'EXTRACTED_FROM', from: { label: 'Preference' }, to: { label: 'Session' } }]
      })
    ).toBeNull()
  })

  it('flags a lone unknown prop and server-owned keys (embedding)', () => {
    const foo = validateExtractionStaging({ node: { label: 'Preference', props: { statement: 's', foo: 1 } }, edges: [] })!
    expect(foo.node).toEqual({ label: 'Preference', offending: ['foo'], missing: [] })
    const embed = validateExtractionStaging({
      node: { label: 'Preference', props: { statement: 's', embedding: [1, 2] } },
      edges: []
    })!
    expect(embed.node?.offending).toContain('embedding')
  })

  it('flags a missing-only required prop (offending empty)', () => {
    const issue = validateExtractionStaging({ node: { label: 'Knowledge', props: {} }, edges: [] })!
    expect(issue.node).toEqual({ label: 'Knowledge', offending: [], missing: ['content'] })
  })

  it('flags an illegal edge (from,to) pair against REL_TABLES', () => {
    const issue = validateExtractionStaging({
      node: null,
      edges: [{ type: 'APPLIES_TO', from: { label: 'Preference' }, to: { label: 'Session' } }]
    })!
    expect(issue.node).toBeNull()
    expect(issue.edges).toHaveLength(1)
    expect(issue.edges[0]).toContain('APPLIES_TO')
    expect(invalidPayloadVerdict(issue)).toContain('APPLIES_TO')
  })
})
