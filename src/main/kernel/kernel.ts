/**
 * Kernel facade (§9) — the one chokepoint every agent action goes through:
 * permission check → span → audit. Phase 09 filled the two phase-04 seams:
 * the permission check is the injected §13 engine (capability-based,
 * default-deny, tiered gates — security/PermissionEngine), and the audit hook
 * is the reversible-delta audit log (security/AuditLog). Every action —
 * allowed, blocked or queued — produces a span whose attributes carry the
 * decision (§13 "hard block + span event").
 */
import { performance } from 'node:perf_hooks'
import type { Telemetry } from '../telemetry'
import type {
  ActionExecutor,
  AuditEvent,
  AuditHook,
  KernelAction,
  PermissionChecker,
  PermissionDecision
} from './types'

export class KernelPermissionError extends Error {
  constructor(agentId: string, action: KernelAction, reason: string) {
    super(`agent '${agentId}' is not permitted to ${action.kind} '${action.name}': ${reason}`)
    this.name = 'KernelPermissionError'
  }
}

/**
 * The action is queued behind a §13 pending-approval row — not executed, not
 * hard-blocked. Callers (the phase-11 scheduler) may retry after approval;
 * catch-sites for KernelPermissionError keep working (subclass).
 */
export class KernelApprovalPendingError extends KernelPermissionError {
  readonly approvalId: string

  constructor(agentId: string, action: KernelAction, reason: string, approvalId: string) {
    super(agentId, action, reason)
    this.name = 'KernelApprovalPendingError'
    this.approvalId = approvalId
  }
}

/**
 * In-memory audit collector for tests that only assert mediation happened;
 * the app boots with the real reversible-delta audit log (security/AuditLog),
 * which implements the same AuditHook seam.
 */
export function createAuditLogStub(): AuditHook & { readonly events: readonly AuditEvent[] } {
  const events: AuditEvent[] = []
  return {
    events,
    record(event: AuditEvent): void {
      events.push(event)
    }
  }
}

/**
 * Allow-everything checker for tests whose subject is NOT permissions (kernel
 * plumbing, runner mechanics). The app itself always boots the real engine;
 * requiring an explicit checker keeps the safety spine visible at every
 * construction site instead of hiding behind a default.
 */
export function allowAllPermissions(): PermissionChecker {
  return {
    check: () => ({ allowed: true, reason: 'allow-all checker (test rig — not the §13 engine)' })
  }
}

export interface KernelDeps {
  telemetry: Telemetry
  /** The §13 permission engine (or an explicit allow-all stand-in in tests). */
  permissions: PermissionChecker
  /** Defaults to a fresh in-memory stub; boot injects the real audit log. */
  audit?: AuditHook
}

export class Kernel implements ActionExecutor {
  private readonly telemetry: Telemetry
  private readonly permissions: PermissionChecker
  private readonly audit: AuditHook

  constructor(deps: KernelDeps) {
    this.telemetry = deps.telemetry
    this.permissions = deps.permissions
    this.audit = deps.audit ?? createAuditLogStub()
  }

  async execute<T>(agentId: string, action: KernelAction, fn: () => Promise<T> | T): Promise<T> {
    const decision = this.permissions.check(agentId, action)
    const startedAt = new Date().toISOString()
    const t0 = performance.now()
    const record = (outcome: 'ok' | 'error', error?: string): void => {
      const event: AuditEvent = {
        at: startedAt,
        agentId,
        action,
        decision,
        outcome,
        durationMs: performance.now() - t0,
        ...(error !== undefined ? { error } : {})
      }
      this.audit.record(event)
    }

    // Every decision leaves a span (§13 "hard block + span event"): the
    // decision + reason ride the span attributes; denied/queued actions throw
    // inside the span, so its status lands as 'error' in the traces table.
    const decisionAttr = decision.allowed ? 'allow' : decision.pendingApprovalId !== undefined ? 'pending' : 'block'
    return this.telemetry.withSpan(
      `kernel.${action.kind}`,
      {
        'agent.id': agentId,
        'action.name': action.name,
        'permission.decision': decisionAttr,
        'permission.reason': decision.reason,
        ...(decision.pendingApprovalId !== undefined ? { 'permission.approval_id': decision.pendingApprovalId } : {}),
        ...action.attributes
      },
      async () => {
        if (!decision.allowed) {
          record('error', `permission denied: ${decision.reason}`)
          throw decision.pendingApprovalId !== undefined
            ? new KernelApprovalPendingError(agentId, action, decision.reason, decision.pendingApprovalId)
            : new KernelPermissionError(agentId, action, decision.reason)
        }
        try {
          const result = await fn()
          record('ok')
          return result
        } catch (err) {
          record('error', err instanceof Error ? err.message : String(err))
          throw err
        }
      }
    )
  }
}

// Re-exported for construction sites that only import from ./kernel.
export type { PermissionDecision }
