/**
 * Kernel facade unit tests: every action creates a span, the PHASE-09
 * permission stub passes everything through, and the audit hook stub records
 * each action with outcome and duration.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { KernelPermissionError, type KernelAction } from '../../src/main/kernel'
import { openKernelStack, spanAttributes, spanRows, type KernelTestStack } from '../fixtures/kernel-helpers'

let stack: KernelTestStack

beforeEach(() => {
  stack = openKernelStack()
})

afterEach(() => {
  stack.cleanup()
})

const action: KernelAction = { kind: 'tool-call', name: 'web.fetch', attributes: { 'tool.target': 'example' } }

describe('kernel.execute', () => {
  it('runs the action inside a span and returns its result', async () => {
    const result = await stack.kernel.execute('agent-7', action, () => Promise.resolve(41 + 1))
    expect(result).toBe(42)

    const rows = spanRows(stack.appData, 'kernel.tool-call')
    expect(rows).toHaveLength(1)
    const attrs = spanAttributes(rows[0]!)
    expect(attrs['agent.id']).toBe('agent-7')
    expect(attrs['action.name']).toBe('web.fetch')
    expect(attrs['tool.target']).toBe('example')
    expect(rows[0]!.status).toBe('ok')
  })

  it('audits every action through the PHASE-09 stub (pass-through decision)', async () => {
    await stack.kernel.execute('agent-7', action, () => 'done')
    expect(stack.audit.events).toHaveLength(1)
    const event = stack.audit.events[0]!
    expect(event.agentId).toBe('agent-7')
    expect(event.action).toEqual(action)
    expect(event.decision.allowed).toBe(true)
    expect(event.decision.reason).toContain('PHASE-09')
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

  it('exports KernelPermissionError for the PHASE-09 deny path', () => {
    // The stub never denies; the error class is the contract PHASE-09 fills in.
    const err = new KernelPermissionError('agent-7', action, 'out of scope')
    expect(err.message).toContain('agent-7')
    expect(err.message).toContain('web.fetch')
  })
})
