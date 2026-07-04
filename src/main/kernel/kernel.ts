/**
 * Kernel facade (§9) — the one chokepoint every agent action goes through:
 * permission check → span → audit. Phase 04 ships the chokepoint with the
 * permission check as a pass-through stub and the audit hook as an in-memory
 * stub; PHASE-09 replaces both with the real §13 capability engine and the
 * reversible-delta audit log without touching any caller.
 */
import { performance } from 'node:perf_hooks'
import type { Telemetry } from '../telemetry'
import type { ActionExecutor, AuditEvent, AuditHook, KernelAction, PermissionDecision } from './types'

export class KernelPermissionError extends Error {
  constructor(agentId: string, action: KernelAction, reason: string) {
    super(`agent '${agentId}' is not permitted to ${action.kind} '${action.name}': ${reason}`)
    this.name = 'KernelPermissionError'
  }
}

/**
 * In-memory audit collector. // PHASE-09: replaced by the real audit + undo
 * log (§13) — committed actions recorded with reversible deltas.
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

export interface KernelDeps {
  telemetry: Telemetry
  /** Defaults to a fresh in-memory stub (PHASE-09 replaces it). */
  audit?: AuditHook
}

export class Kernel implements ActionExecutor {
  private readonly telemetry: Telemetry
  private readonly audit: AuditHook

  constructor(deps: KernelDeps) {
    this.telemetry = deps.telemetry
    this.audit = deps.audit ?? createAuditLogStub()
  }

  // PHASE-09: pass-through stub. The real check evaluates the agent's declared
  // capabilities (§13 default-deny, tiered gates) against the action; the
  // signature and the throw-on-deny path below are the contract it fills in.
  private checkPermission(_agentId: string, _action: KernelAction): PermissionDecision {
    return { allowed: true, reason: 'PHASE-09 stub: permission enforcement not yet built; all actions pass' }
  }

  async execute<T>(agentId: string, action: KernelAction, fn: () => Promise<T> | T): Promise<T> {
    const decision = this.checkPermission(agentId, action)
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

    if (!decision.allowed) {
      record('error', `permission denied: ${decision.reason}`)
      throw new KernelPermissionError(agentId, action, decision.reason)
    }

    return this.telemetry.withSpan(
      `kernel.${action.kind}`,
      { 'agent.id': agentId, 'action.name': action.name, ...action.attributes },
      async () => {
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
