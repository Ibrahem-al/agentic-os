/**
 * Post-release fix (renderer side): the review panel reads the plain-language
 * "can't be applied" verdict off a row's validation_json. Pure over the DTO, so
 * it is pinned here as plain vitest (no DOM) — the panel just renders what this
 * returns as a warning line and de-emphasizes Approve when it is non-null.
 */
import { describe, expect, it } from 'vitest'
import type { JsonObject, StagedWriteDto } from '../../src/shared/ipc'
import { invalidPayloadVerdictOf } from '../../src/renderer/src/lib/stagedSummary'

function sw(validation: JsonObject | null): StagedWriteDto {
  return {
    id: 'sw-1',
    proposedBy: 'claude-mcp:s1',
    kind: 'extraction',
    targetLabel: 'Skill',
    targetId: 'skill-ui-ux-pro-max',
    payload: {},
    status: 'staged',
    validation,
    createdAt: '2026-07-11T00:00:00.000Z',
    decidedAt: null,
    committedAt: null,
    requiresEmbedder: false
  }
}

describe('invalidPayloadVerdictOf', () => {
  it('returns the verdict when the row carries an invalid-payload validation', () => {
    const verdict =
      "This proposal can't be applied: a Skill doesn't have the property description. Decline it — if the skill is real, re-ingest the project and approve the properly-formed version."
    expect(invalidPayloadVerdictOf(sw({ decidedBy: 'user:dashboard', invalidPayload: true, verdict }))).toBe(verdict)
  })

  it('returns null for a clean row, a committed row, and a plain (non-invalid) commit error', () => {
    expect(invalidPayloadVerdictOf(sw(null))).toBeNull()
    expect(invalidPayloadVerdictOf(sw({ decidedBy: 'u', auditActionId: 'a1' }))).toBeNull()
    expect(invalidPayloadVerdictOf(sw({ decidedBy: 'u', commitError: 'better-sqlite failed' }))).toBeNull()
  })
})
