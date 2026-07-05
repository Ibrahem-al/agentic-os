/**
 * Kernel facade unit tests (phase 09): every action creates a span carrying
 * the §13 permission decision, denied/queued actions throw INSIDE the span
 * (status 'error' — the "hard block + span event"), and the audit hook
 * records each action with outcome and duration.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  KernelApprovalPendingError,
  KernelPermissionError,
  type KernelAction
} from '../../src/main/kernel'
import { EMPTY_CAPABILITIES } from '../../src/main/security'
import { openKernelStack, spanAttributes, spanRows, type KernelTestStack } from '../fixtures/kernel-helpers'

let stack: KernelTestStack

beforeEach(() => {
  stack = openKernelStack()
  // agent-7: may call the web.fetch tool with standing write consent — the
  // kernel-plumbing tests below are about spans/audit, not gating.
  stack.permissions.registerAgent('agent-7', {
    capabilities: { ...EMPTY_CAPABILITIES, tools: ['web.fetch'] },
    gates: { write: 'allow' }
  })
})

afterEach(() => {
  stack.cleanup()
})

const action: KernelAction = { kind: 'tool-call', name: 'web.fetch', attributes: { 'tool.target': 'example' } }

describe('kernel.execute', () => {
  it('runs the action inside a span carrying the permission decision', async () => {
    const result = await stack.kernel.execute('agent-7', action, () => Promise.resolve(41 + 1))
    expect(result).toBe(42)

    const rows = spanRows(stack.appData, 'kernel.tool-call')
    expect(rows).toHaveLength(1)
    const attrs = spanAttributes(rows[0]!)
    expect(attrs['agent.id']).toBe('agent-7')
    expect(attrs['action.name']).toBe('web.fetch')
    expect(attrs['tool.target']).toBe('example')
    expect(attrs['permission.decision']).toBe('allow')
    expect(rows[0]!.status).toBe('ok')
  })

  it('audits every action through the real §13 engine decision', async () => {
    await stack.kernel.execute('agent-7', action, () => 'done')
    expect(stack.audit.events).toHaveLength(1)
    const event = stack.audit.events[0]!
    expect(event.agentId).toBe('agent-7')
    expect(event.action).toEqual(action)
    expect(event.decision.allowed).toBe(true)
    expect(event.decision.reason).toContain('standing grant')
    expect(event.outcome).toBe('ok')
    expect(event.durationMs).toBeGreaterThanOrEqual(0)
    expect(Number.isNaN(Date.parse(event.at))).toBe(false)
  })

  it('marks failing actions as error in both span and audit, and rethrows', async () => {
    await expect(
      stack.kernel.execute('agent-7', { kind: 'model-call', name: 'summarize' }, () => {
        throw new Error('model exploded')
      })
    ).rejects.toThrow('model exploded')

    const row = spanRows(stack.appData, 'kernel.model-call')[0]!
    expect(row.status).toBe('error')
    expect(stack.audit.events[0]!.outcome).toBe('error')
    expect(stack.audit.events[0]!.error).toBe('model exploded')
  })

  it('nests spans of actions executed inside other actions', async () => {
    await stack.kernel.execute('agent-7', { kind: 'workflow-step', name: 'outer' }, async () => {
      await stack.kernel.execute('agent-7', { kind: 'model-call', name: 'inner' }, () => 'x')
    })
    const outer = spanRows(stack.appData, 'kernel.workflow-step')[0]!
    const inner = spanRows(stack.appData, 'kernel.model-call')[0]!
    expect(inner.trace_id).toBe(outer.trace_id)
    expect(inner.parent_span_id).toBe(outer.span_id)
  })

  it('hard-blocks an unregistered agent with a span event (§13 default-deny)', async () => {
    let ran = false
    await expect(
      stack.kernel.execute('nobody', { kind: 'storage-read', name: 'peek' }, () => {
        ran = true
      })
    ).rejects.toThrow(KernelPermissionError)
    expect(ran).toBe(false) // the action body never executed

    const row = spanRows(stack.appData, 'kernel.storage-read')[0]!
    expect(row.status).toBe('error')
    const attrs = spanAttributes(row)
    expect(attrs['permission.decision']).toBe('block')
    expect(String(attrs['permission.reason'])).toContain('not registered')
    expect(stack.audit.events[0]!.outcome).toBe('error')
    expect(stack.audit.events[0]!.error).toContain('permission denied')
  })

  it('hard-blocks an out-of-scope action without creating an approval row', async () => {
    await expect(
      stack.kernel.execute(
        'agent-7',
        { kind: 'net', name: 'fetch', host: 'evil.example.com' },
        () => 'never'
      )
    ).rejects.toThrow(KernelPermissionError)

    const attrs = spanAttributes(spanRows(stack.appData, 'kernel.net')[0]!)
    expect(attrs['permission.decision']).toBe('block')
    expect(stack.permissions.listApprovals()).toHaveLength(0)
  })

  it('queues gated actions behind a pending approval; approval lets a retry through', async () => {
    // agent-demo has no standing grants → storage-write is 'ask'-tier (§13).
    const write: KernelAction = { kind: 'storage-write', name: 'seed-node' }
    let ran = 0
    const attempt = (): Promise<string> =>
      stack.kernel.execute('agent-demo', write, () => {
        ran += 1
        return 'wrote'
      })

    await expect(attempt()).rejects.toThrow(KernelApprovalPendingError)
    expect(ran).toBe(0)
    const pending = stack.permissions.listApprovals({ status: 'pending' })
    expect(pending).toHaveLength(1)
    const attrs = spanAttributes(spanRows(stack.appData, 'kernel.storage-write')[0]!)
    expect(attrs['permission.decision']).toBe('pending')
    expect(attrs['permission.approval_id']).toBe(pending[0]!.id)

    // Headless it stays queued: a retry re-uses the same pending row.
    await expect(attempt()).rejects.toThrow(KernelApprovalPendingError)
    expect(stack.permissions.listApprovals()).toHaveLength(1)

    // The dashboard approves → the SAME action signature now executes.
    stack.permissions.approve(pending[0]!.id, 'tester')
    await expect(attempt()).resolves.toBe('wrote')
    expect(ran).toBe(1)
  })
})
