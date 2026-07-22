/**
 * Reasoning-roles read (Stage 2 — routing control) — the shared source behind
 * the dashboard `reasoning.roles` IPC handler. Projects the §2.2 reasoning roles
 * for the settings "What runs where" table: a PLAIN user-facing group name, the
 * §11.4 HARD-local (sensitive) flag, and the LIVE effective backend each role
 * resolves to right now (router.resolve — reflects settings + key/health +
 * fallback chain). Read-only: it never mutates and never reaches a model.
 *
 * The group map is a UI grouping (not a spec concept) so the dotted role keys
 * present as five human categories. `effectiveBackend` is null only when no
 * router booted this launch (a degraded state the renderer reads as the local
 * default — DEFAULT == TODAY).
 */
import { ROLE_DEFAULTS, ROLE_KEYS } from '../models'
import type { ProviderRouter, RoleKey } from '../models'
import type { ReasoningRoleDto, ReasoningRoleGroupDto } from '../../shared/ipc'

/**
 * Plain, user-facing grouping of every §2.2 role. A total map over ROLE_KEYS
 * (compile-checked below) so a future role must pick a group. `ingest.skillProposal`
 * groups with "Improving skills" (it proposes new skills from project docs), not
 * "Summaries", despite its ingest namespace.
 */
const ROLE_GROUPS: Readonly<Record<RoleKey, ReasoningRoleGroupDto>> = {
  'extraction.fuzzy': 'Understanding your sessions',
  'extraction.tiebreak': 'Understanding your sessions',
  'extraction.verify': 'Understanding your sessions',
  'retrieval.critic': 'Search & retrieval',
  'retrieval.rewrite': 'Search & retrieval',
  'skills.testset': 'Improving skills',
  'skills.rewrite': 'Improving skills',
  'skills.comparator': 'Improving skills',
  'skills.executor': 'Improving skills',
  'skills.grader': 'Improving skills',
  'ingest.projectSummary': 'Summaries',
  'ingest.skillProposal': 'Improving skills',
  'scanner.llmVerdict': 'Safety scanning',
  'context.summarize': 'Summaries',
  // The §8 graph-cleanup dedupe judge decides whether two stored memories are the
  // same — the same class of "understanding your memory" work as extraction's
  // entity-resolution tiebreak, so it groups under "Understanding your sessions".
  'cleanup.dedupeJudge': 'Understanding your sessions'
}

export interface ReasoningRolesDeps {
  /**
   * The phase-16 ProviderRouter (resolve only) — the LIVE effective backend a
   * role lands on. Optional/nullable so test rigs and any launch without a router
   * compile unchanged and report `effectiveBackend: null` for every role.
   */
  readonly router?: Pick<ProviderRouter, 'resolve'> | null
}

/**
 * reasoning.roles: every §2.2 role in canonical order, with its plain group, the
 * §11.4 HARD-local (sensitive) flag, and its live effective backend. `sensitive`
 * is static (ROLE_DEFAULTS.hardLocal); `effectiveBackend` reflects live routing
 * (null when no router is wired).
 */
export function getReasoningRoles(deps: ReasoningRolesDeps): readonly ReasoningRoleDto[] {
  const router = deps.router ?? null
  return ROLE_KEYS.map(
    (role): ReasoningRoleDto => ({
      role,
      group: ROLE_GROUPS[role],
      sensitive: ROLE_DEFAULTS[role].hardLocal,
      effectiveBackend: router !== null ? router.resolve(role).backend : null
    })
  )
}
