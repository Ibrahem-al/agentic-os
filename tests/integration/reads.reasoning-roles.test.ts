/**
 * reasoning.roles read shape (Stage 2 — routing control). Pins the reads-layer
 * source behind the dashboard's "What runs where" table: every §2.2 role in
 * canonical order, a PLAIN user-facing group, the §11.4 HARD-local (sensitive)
 * flag, and the LIVE effective backend from router.resolve. Also pins the
 * DEFAULT == TODAY reading — no router wired ⇒ effectiveBackend null everywhere.
 */
import { describe, expect, it } from 'vitest'
import { getReasoningRoles, type ReasoningRolesDeps } from '../../src/main/reads'
import { ROLE_DEFAULTS, ROLE_KEYS, type ReasoningBackend, type RoleKey } from '../../src/main/models'
import type { ReasoningRoleGroupDto } from '../../src/shared/ipc'

const HARD_ROLES: readonly RoleKey[] = ['retrieval.critic', 'retrieval.rewrite', 'scanner.llmVerdict', 'skills.executor', 'skills.grader']
const GROUPS: readonly ReasoningRoleGroupDto[] = [
  'Understanding your sessions',
  'Improving skills',
  'Search & retrieval',
  'Safety scanning',
  'Summaries'
]

/** A router stub whose every role resolves to one fixed backend (introspection only). */
const routerResolving = (backend: ReasoningBackend): NonNullable<ReasoningRolesDeps['router']> => ({
  resolve: (role) => ({ role, backend, model: `model-${backend}` })
})

describe('getReasoningRoles (reasoning.roles read shape)', () => {
  it('enumerates every §2.2 role in canonical order, each with a valid plain group', () => {
    const rows = getReasoningRoles({})
    expect(rows.map((r) => r.role)).toEqual([...ROLE_KEYS])
    for (const r of rows) expect(GROUPS, r.role).toContain(r.group)
  })

  it('marks exactly the §11.4 HARD-local set as sensitive (mirrors ROLE_DEFAULTS.hardLocal)', () => {
    const rows = getReasoningRoles({})
    const sensitive = rows.filter((r) => r.sensitive).map((r) => r.role)
    expect(new Set(sensitive)).toEqual(new Set(HARD_ROLES))
    for (const r of rows) expect(r.sensitive, r.role).toBe(ROLE_DEFAULTS[r.role as RoleKey].hardLocal)
  })

  it('groups every role, and ingest.skillProposal lands under "Improving skills" (not Summaries) despite its ingest namespace', () => {
    const byRole = new Map(getReasoningRoles({}).map((r) => [r.role, r.group]))
    expect(byRole.get('ingest.skillProposal')).toBe('Improving skills')
    expect(byRole.get('ingest.projectSummary')).toBe('Summaries')
    expect(byRole.get('context.summarize')).toBe('Summaries')
    expect(byRole.get('scanner.llmVerdict')).toBe('Safety scanning')
    expect(byRole.get('retrieval.critic')).toBe('Search & retrieval')
    expect(byRole.get('extraction.fuzzy')).toBe('Understanding your sessions')
    // Every group is actually used (no empty category in the UI).
    expect(new Set(byRole.values())).toEqual(new Set(GROUPS))
  })

  it('no router wired → effectiveBackend is null for every role (DEFAULT == TODAY / local default)', () => {
    for (const rows of [getReasoningRoles({}), getReasoningRoles({ router: null })]) {
      for (const r of rows) expect(r.effectiveBackend, r.role).toBeNull()
    }
  })

  it('a live router fills effectiveBackend from router.resolve per role', () => {
    for (const backend of ['local-qwen3', 'cloud-api', 'subscription-claude'] as const) {
      const rows = getReasoningRoles({ router: routerResolving(backend) })
      for (const r of rows) expect(r.effectiveBackend, r.role).toBe(backend)
    }
  })
})
