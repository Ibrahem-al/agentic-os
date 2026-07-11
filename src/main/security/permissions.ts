/**
 * Permission engine (§13, phase 09) — replaces the phase-04 kernel stub.
 *
 * Capability-based, DEFAULT-DENY: every acting agent must be registered with
 * a CapabilityDeclaration; an unregistered agent is hard-blocked. Registered
 * agents pass through the §13 tiered gates:
 *
 *  - auto-allow: safe reads/retrieval (storage-read, retrieval, model-call,
 *    workflow-step — the step is the mediated container; what it touches is
 *    gated where it crosses a real boundary), plus read-tier scope-checked
 *    kinds (fs-read within fsRead).
 *  - approval-gated: writes / network / spend / sandbox runs with side
 *    effects. Without a standing grant the action queues a pending-approval
 *    row (the dashboard surfaces it; headless it stays queued) and is NOT
 *    executed. An approval persists per action signature, so retrying the
 *    same action after approval succeeds; a denial persists the same way.
 *  - hard block: out-of-scope facts (path outside fsRead/fsWrite, host not in
 *    netDomains, tool not declared, spend above maxSpendUSD, sandbox
 *    requesting more than the agent's own declaration) — plus a span event
 *    via the kernel (the kernel records the decision on the action's span).
 *
 * Standing grants (`gates: { write: 'allow', … }`) exist because the OS's own
 * internal agents already carry §13-mandated write gating of their own —
 * extraction's confidence-gated write + staged review (§17), MCP tools'
 * staged-only correction path (§21 rule 6) — and a live MCP session must
 * never pause-and-notify (§15). User rules (phase 11) default to 'ask' on
 * every gated tier. Recorded phase-09 decision.
 */
import { createHash, randomUUID } from 'node:crypto'
import type BetterSqlite3 from 'better-sqlite3'
import { SPEND_CEILING_USD_DEFAULT } from '../config'
import type { CapabilityDeclaration, KernelAction, PermissionChecker, PermissionDecision } from '../kernel'
import { capabilitiesWithin, isDomainAllowed, pathsAllowed, EMPTY_CAPABILITIES } from './capabilities'

/** Gated tiers (§13: prompt before writes, network calls, messages, spend). */
export type GatedTier = 'write' | 'net' | 'spend' | 'sandbox'

export interface AgentProfile {
  readonly capabilities: CapabilityDeclaration
  /**
   * Standing consent per gated tier: 'allow' commits without a pending row
   * (the agent carries its own §13 gating machinery — see module header);
   * 'ask' (the default for every tier) queues a pending-approval row.
   */
  readonly gates?: Partial<Readonly<Record<GatedTier, 'allow' | 'ask'>>>
}

export interface ApprovalRow {
  readonly id: string
  readonly signature: string
  readonly agentId: string
  readonly actionKind: string
  readonly actionName: string
  readonly tier: string
  readonly details: Record<string, unknown>
  readonly status: 'pending' | 'approved' | 'denied'
  readonly requestedAt: string
  readonly decidedAt: string | null
  readonly decidedBy: string | null
}

/**
 * The full planned MCP tool surface (§4.G / phase-14b), split by permission
 * tier. Most names have no handler yet — the dispatcher answers NOT_FOUND for
 * those (a client error, not a permission breach) — but tiering them here means
 * each is gated correctly the moment its handler lands (FP-1 / FP-4), and the
 * §13 mcp-call scope check (P0.6) fails closed on anything outside these sets.
 * Exported so the server dispatch (B3) derives the runner-session READ+STAGING
 * allowlist from the same source of truth.
 */
export const READ_TOOLS = new Set([
  // phase-05 originals
  'get_context',
  'search_memory',
  'list_skills',
  'get_skill',
  // phase-14b full read surface (§4.G)
  'list_sessions',
  'read_session',
  'get_pending_work',
  'get_skill_full',
  'get_skill_signal',
  'memory_counts',
  'list_nodes',
  'get_node',
  'list_staged_writes',
  'get_staged_write',
  'list_approvals',
  'list_injection_flags',
  'list_audit_log',
  'list_traces',
  'get_trace',
  'get_usage',
  'list_tasks',
  'get_task',
  'get_triggers_status',
  'list_watched_folders',
  'get_app_status',
  'get_settings_summary',
  'get_runner_status'
])
/** Staging IS the §21-rule-6 approval flow — gating the act of staging would be approval-on-approval. */
export const STAGING_TOOLS = new Set([
  'propose_correction',
  // phase-14b staging surface — proposals land in a review queue, not the graph
  'propose_extraction',
  'propose_skill_revision',
  'submit_extraction_items'
])
/**
 * Control tools trigger real side effects (runs, writes, task control) — they
 * are write-tier gated: standing-allowed on the interactive `mcp:` profile
 * (whose §13 write machinery lives downstream), never on runner profiles.
 */
export const CONTROL_TOOLS = new Set([
  'run_extraction',
  'improve_skill_now',
  'run_maintenance',
  'retry_task',
  'scan_watched_folder',
  // phase-05 ingest tools — moved here from the inline mcp-call name check
  'ingest_document',
  'ingest_codebase'
])
/**
 * Dashboard-maintenance tools (memory dedup — user-directed extension): they
 * behave like read/staging (no graph side effect — the scanner reads,
 * propose_dedupe_merge only STAGES), so they AUTO-ALLOW on the interactive
 * `mcp:` session. They are deliberately EXCLUDED from the runner surface
 * (`mcp-runner:` profile + the server-side RUNNER_SESSION_ALLOWLIST), so a
 * headless background reasoner can never trigger them — de-duplicating a user's
 * long-lived memory is a human-in-the-loop chore, not autonomous background
 * work. Kept a SEPARATE tier from READ_TOOLS/STAGING_TOOLS precisely so the
 * runner allowlist (derived from those two) stays unchanged.
 */
export const DASHBOARD_TOOLS = new Set(['list_duplicate_memories', 'propose_dedupe_merge'])

export class PermissionEngine implements PermissionChecker {
  private readonly db: BetterSqlite3.Database
  private readonly exact = new Map<string, AgentProfile>()
  private readonly prefixes: { prefix: string; profile: AgentProfile }[] = []

  constructor(deps: { db: BetterSqlite3.Database }) {
    this.db = deps.db
  }

  /** Register an agent id (exact match). Re-registration replaces. */
  registerAgent(agentId: string, profile: AgentProfile): void {
    this.exact.set(agentId, profile)
  }

  /**
   * Register a family of agent ids by prefix (e.g. 'mcp:' — one profile per
   * transport session family). Longest matching prefix wins.
   */
  registerAgentPrefix(prefix: string, profile: AgentProfile): void {
    const existing = this.prefixes.findIndex((p) => p.prefix === prefix)
    if (existing !== -1) this.prefixes.splice(existing, 1)
    this.prefixes.push({ prefix, profile })
    this.prefixes.sort((a, b) => b.prefix.length - a.prefix.length)
  }

  private profileOf(agentId: string): AgentProfile | undefined {
    const direct = this.exact.get(agentId)
    if (direct !== undefined) return direct
    return this.prefixes.find((p) => agentId.startsWith(p.prefix))?.profile
  }

  check(agentId: string, action: KernelAction): PermissionDecision {
    const profile = this.profileOf(agentId)
    if (profile === undefined) {
      return {
        allowed: false,
        reason: `agent '${agentId}' is not registered with the permission engine (§13 default-deny)`
      }
    }
    const cap = profile.capabilities

    switch (action.kind) {
      // ── auto-allow: safe reads / retrieval / mediated containers ──────────
      case 'storage-read':
      case 'retrieval':
      case 'model-call':
      case 'workflow-step':
        return { allowed: true, reason: 'read/retrieval tier — auto-allowed (§13)' }

      case 'fs-read': {
        const paths = action.paths ?? []
        if (paths.length === 0) return this.block(action, 'fs-read action declared no paths')
        if (!pathsAllowed(paths, cap.fsRead)) {
          return this.block(action, `path outside the agent's fsRead scope (${paths.join(', ')})`)
        }
        return { allowed: true, reason: 'read within declared fsRead scope — auto-allowed (§13)' }
      }

      // ── gated tiers (scope-check first, then standing grant / approval) ───
      case 'fs-write': {
        const paths = action.paths ?? []
        if (paths.length === 0) return this.block(action, 'fs-write action declared no paths')
        if (!pathsAllowed(paths, cap.fsWrite)) {
          return this.block(action, `path outside the agent's fsWrite scope (${paths.join(', ')})`)
        }
        return this.gate(agentId, action, profile, 'write', { paths: [...paths] })
      }

      case 'storage-write':
        return this.gate(agentId, action, profile, 'write', {})

      case 'net': {
        if (action.host === undefined || action.host === '') {
          return this.block(action, 'net action declared no host')
        }
        if (!isDomainAllowed(action.host, cap.netDomains)) {
          return this.block(action, `host '${action.host}' is not in the agent's netDomains allowlist`)
        }
        return this.gate(agentId, action, profile, 'net', { host: action.host })
      }

      case 'spend': {
        const usd = action.usd
        if (usd === undefined || !Number.isFinite(usd) || usd < 0) {
          return this.block(action, 'spend action declared no valid usd amount')
        }
        if (usd > cap.maxSpendUSD) {
          return this.block(action, `spend $${usd.toFixed(2)} exceeds the agent's maxSpendUSD $${cap.maxSpendUSD.toFixed(2)}`)
        }
        return this.gate(agentId, action, profile, 'spend', { usd })
      }

      case 'tool-call': {
        if (!cap.tools.includes(action.name) && !cap.tools.includes('*')) {
          return this.block(action, `tool '${action.name}' is not in the agent's declared tools`)
        }
        // Tool side effects are unknown at this layer — conservative: gated.
        return this.gate(agentId, action, profile, 'write', { tool: action.name })
      }

      case 'mcp-call': {
        // P0.6: scope-check FIRST — a session may only call tools its profile
        // declares (mirrors case 'tool-call'). This closes the gap where the
        // pre-14b branch skipped cap.tools entirely: READ/STAGING auto-allowed
        // regardless of the agent's declared surface, and unknown names fell
        // through to a silent allow. Now both fail closed.
        if (!cap.tools.includes(action.name) && !cap.tools.includes('*')) {
          return this.block(action, `tool '${action.name}' is not in the agent's declared tools`)
        }
        // Reads + staging (§21 rule 6 — staging IS the approval flow) auto-allow;
        // dashboard-maintenance tools (dedup scan/propose) are read/staging-tier too.
        if (READ_TOOLS.has(action.name) || STAGING_TOOLS.has(action.name) || DASHBOARD_TOOLS.has(action.name)) {
          return { allowed: true, reason: 'read/staging MCP tool — auto-allowed (§13/§21 rule 6)' }
        }
        // Control tools carry real side effects — write-tier gated.
        if (CONTROL_TOOLS.has(action.name)) {
          return this.gate(agentId, action, profile, 'write', { tool: action.name })
        }
        // Declared but in no recognized tier ⇒ fail closed (no allow-by-default).
        return this.block(action, `tool '${action.name}' is not a recognized MCP tool`)
      }

      case 'sandbox-run': {
        const requested = action.sandbox?.capabilities ?? EMPTY_CAPABILITIES
        if (!capabilitiesWithin(requested, cap)) {
          return this.block(action, "sandbox run requests capabilities beyond the agent's own declaration")
        }
        // A sandbox with no write/net capability cannot have side effects
        // beyond its output — read-tier. Otherwise it is a gated action.
        if (requested.fsWrite.length === 0 && requested.netDomains.length === 0) {
          return { allowed: true, reason: 'sandbox run with read-only capabilities — auto-allowed (§13)' }
        }
        return this.gate(agentId, action, profile, 'sandbox', {
          fsWrite: [...requested.fsWrite],
          netDomains: [...requested.netDomains]
        })
      }
    }
  }

  // ── approvals (§13 "prompt before …"; headless = stays queued) ─────────────

  private gate(
    agentId: string,
    action: KernelAction,
    profile: AgentProfile,
    tier: GatedTier,
    details: Record<string, unknown>
  ): PermissionDecision {
    if ((profile.gates?.[tier] ?? 'ask') === 'allow') {
      return { allowed: true, reason: `standing grant for ${tier}-tier actions (agent profile)` }
    }
    const signature = sha256(
      `${agentId}\n${action.kind}\n${action.name}\n${stableJson(details)}`
    )
    const existing = this.db
      .prepare('SELECT id, status, decided_by FROM approvals WHERE signature = ?')
      .get(signature) as { id: string; status: string; decided_by: string | null } | undefined
    if (existing?.status === 'approved') {
      return { allowed: true, reason: `approved by ${existing.decided_by ?? 'user'} (approval ${existing.id})` }
    }
    if (existing?.status === 'denied') {
      return {
        allowed: false,
        reason: `denied by ${existing.decided_by ?? 'user'} (approval ${existing.id})`
      }
    }
    if (existing !== undefined) {
      return {
        allowed: false,
        reason: `queued behind pending approval ${existing.id} (§13 — the dashboard surfaces it)`,
        pendingApprovalId: existing.id
      }
    }
    const id = randomUUID()
    this.db
      .prepare(
        `INSERT INTO approvals (id, signature, agent_id, action_kind, action_name, tier, details_json)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(id, signature, agentId, action.kind, action.name, tier, stableJson(details))
    return {
      allowed: false,
      reason: `${tier}-tier action queued for approval (${id}) — §13 prompt-before gate; headless it stays queued`,
      pendingApprovalId: id
    }
  }

  private block(action: KernelAction, why: string): PermissionDecision {
    return { allowed: false, reason: `out-of-scope ${action.kind} — hard block (§13): ${why}` }
  }

  approve(approvalId: string, decidedBy: string): void {
    this.decide(approvalId, 'approved', decidedBy)
  }

  deny(approvalId: string, decidedBy: string): void {
    this.decide(approvalId, 'denied', decidedBy)
  }

  private decide(approvalId: string, status: 'approved' | 'denied', decidedBy: string): void {
    const result = this.db
      .prepare(
        `UPDATE approvals SET status = ?, decided_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'), decided_by = ?
         WHERE id = ? AND status = 'pending'`
      )
      .run(status, decidedBy, approvalId)
    if (result.changes === 0) {
      throw new Error(`approval ${approvalId} does not exist or is already decided`)
    }
  }

  listApprovals(filter?: { status?: 'pending' | 'approved' | 'denied' }): ApprovalRow[] {
    const rows = (
      filter?.status !== undefined
        ? this.db.prepare('SELECT * FROM approvals WHERE status = ? ORDER BY requested_at, id').all(filter.status)
        : this.db.prepare('SELECT * FROM approvals ORDER BY requested_at, id').all()
    ) as {
      id: string
      signature: string
      agent_id: string
      action_kind: string
      action_name: string
      tier: string
      details_json: string | null
      status: 'pending' | 'approved' | 'denied'
      requested_at: string
      decided_at: string | null
      decided_by: string | null
    }[]
    return rows.map((r) => ({
      id: r.id,
      signature: r.signature,
      agentId: r.agent_id,
      actionKind: r.action_kind,
      actionName: r.action_name,
      tier: r.tier,
      details: JSON.parse(r.details_json ?? '{}') as Record<string, unknown>,
      status: r.status,
      requestedAt: r.requested_at,
      decidedAt: r.decided_at,
      decidedBy: r.decided_by
    }))
  }
}

/**
 * The OS's own hardcoded roles (§17), registered at boot AND in test rigs so
 * every existing caller runs through the real engine. Standing grants are
 * justified per agent in the module header + phase-09 report; user rules
 * (phase 11) get NO standing grants.
 */
export function registerInternalAgents(engine: PermissionEngine): void {
  // The runner's default attribution for internal workflows and test jobs:
  // takes only workflow-step/storage/model actions (auto-allow tier). Grants
  // cover internal write-lane maintenance jobs (prune/export, phase 11).
  engine.registerAgent('system', {
    capabilities: EMPTY_CAPABILITIES,
    gates: { write: 'allow' }
  })
  // Extraction (§17): its graph writes carry their own §13 machinery — the
  // confidence-gated write, the independent verifier and the staged_writes
  // review queue. Spend is capped at the §20 per-task ceiling (the same
  // figure the §14 SpendMeter enforces per call) with standing consent.
  engine.registerAgent('extraction-agent', {
    capabilities: { ...EMPTY_CAPABILITIES, maxSpendUSD: SPEND_CEILING_USD_DEFAULT },
    gates: { write: 'allow', spend: 'allow' }
  })
  // Skill improvement (§17 agent #4, phase 12): like extraction, its writes
  // carry their own §13 machinery — the no-regression adoption gate, the
  // stylistic path's review-queue staging, and every version flip lands as an
  // audited reversible delta (rollback = the recorded inverse). Spend (test
  // synthesis, candidate rewrite, blind comparison) is capped at the §20
  // per-task ceiling the SpendMeter enforces per call.
  engine.registerAgent('skill-improvement-agent', {
    capabilities: { ...EMPTY_CAPABILITIES, maxSpendUSD: SPEND_CEILING_USD_DEFAULT },
    gates: { write: 'allow', spend: 'allow' }
  })
  // Live MCP sessions (§12 'mcp:<transport session id>'): the user drives
  // these through Claude interactively; §15 forbids pause-and-notify on live
  // tool calls, and the only correction path is staged (§21 rule 6). The
  // ingest tools' writes are sanctioned §18 write paths invoked by the user.
  engine.registerAgentPrefix('mcp:', {
    capabilities: {
      ...EMPTY_CAPABILITIES,
      // The full planned surface: with the P0.6 cap.tools check now enforced,
      // the interactive session must declare every tool it may call. Reads +
      // staging (and the dashboard-maintenance dedup tools) auto-allow; the
      // control tools ride the write standing-grant — so the 7 phase-05 tools
      // (and every later one) behave exactly as today.
      tools: [...READ_TOOLS, ...STAGING_TOOLS, ...CONTROL_TOOLS, ...DASHBOARD_TOOLS]
    },
    gates: { write: 'allow' }
  })
  // Runner-attributed MCP sessions (§12 'mcp-runner:<transport session id>',
  // phase-14b): the subscription reasoner drives these headlessly. Scoped to
  // READ + STAGING only (NOT the control tools) with NO standing grant — reads
  // and staging auto-allow; any gated tier stays queued headless rather than
  // committing. maxSpendUSD 0: the runner's ceiling is the durable call budget
  // (models/callBudget), never a dollar figure. Prefix hygiene —
  // 'mcp-runner:'.startsWith('mcp:') is false, so this never inherits the
  // interactive write grant (verified).
  engine.registerAgentPrefix('mcp-runner:', {
    capabilities: {
      ...EMPTY_CAPABILITIES,
      tools: [...READ_TOOLS, ...STAGING_TOOLS],
      maxSpendUSD: 0
    }
  })
}

const sha256 = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex')

/** Deterministic JSON for approval signatures (sorted keys, one level deep is enough for our flat details). */
function stableJson(value: Record<string, unknown>): string {
  return JSON.stringify(
    Object.fromEntries(Object.entries(value).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
  )
}
