/**
 * LangGraphRunner validation unit tests: definition hygiene, input checks,
 * and job-id collision. (Execution, checkpoints, spans and kill/resume live
 * in tests/integration/kernel.*.test.ts.)
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { WorkflowStep } from '../../src/main/kernel'
import { openKernelStack, type KernelTestStack } from '../fixtures/kernel-helpers'

let stack: KernelTestStack

beforeEach(() => {
  stack = openKernelStack()
})

afterEach(() => {
  stack.cleanup()
})

const step = (name: string): WorkflowStep => ({ name, run: () => ({ [name]: true }) })

describe('define()', () => {
  it('rejects empty names, empty step lists, duplicates and reserved names', () => {
    expect(() => stack.runner.define('', [step('a')])).toThrow(/non-empty/)
    expect(() => stack.runner.define('w', [])).toThrow(/at least one step/)
    expect(() => stack.runner.define('w', [step('a'), step('a')])).toThrow(/duplicate step name/)
    expect(() => stack.runner.define('w', [step('__start__')])).toThrow(/reserved/)
    expect(() => stack.runner.define('w', [{ name: ' ', run: () => undefined }])).toThrow(/empty name/)
  })

  it('rejects redefinition', () => {
    stack.runner.define('w', [step('a')])
    expect(() => stack.runner.define('w', [step('a')])).toThrow(/already defined/)
  })
})

describe('run() validation', () => {
  it('rejects unknown workflows', async () => {
    await expect(stack.runner.run('ghost', {})).rejects.toThrow(/not defined/)
  })

  it('rejects non-object and circular inputs', async () => {
    stack.runner.define('w', [step('a')])
    await expect(stack.runner.run('w', [] as unknown as Record<string, unknown>)).rejects.toThrow(/plain JSON object/)
    const circular: Record<string, unknown> = {}
    circular['self'] = circular
    await expect(stack.runner.run('w', circular)).rejects.toThrow()
  })

  it('rejects duplicate job ids', async () => {
    stack.runner.define('w', [step('a')])
    await stack.runner.run('w', {}, { jobId: 'job-1' })
    await expect(stack.runner.run('w', {}, { jobId: 'job-1' })).rejects.toThrow(/already exists/)
  })
})

describe('resume()/getJob() edges', () => {
  it('resume of an unknown job throws', async () => {
    await expect(stack.runner.resume('missing')).rejects.toThrow(/no job/)
  })

  it('resume without a definition in this process is actionable', async () => {
    stack.runner.define('w', [step('a')])
    // Simulate a crashed job from another process: row exists, no local run.
    stack.appData.db
      .prepare(`INSERT INTO tasks (id, kind, payload_json, status, attempts) VALUES (?, 'workflow', ?, 'running', 1)`)
      .run('foreign-job', JSON.stringify({ workflow: 'not-registered-here', agentId: 'system', input: {} }))
    await expect(stack.runner.resume('foreign-job')).rejects.toThrow(/define\(\)/)
  })

  it('getJob returns undefined for unknown ids and rejects non-workflow tasks', async () => {
    expect(await stack.runner.getJob('missing')).toBeUndefined()
    stack.appData.db.prepare(`INSERT INTO tasks (id, kind) VALUES ('other-task', 'extraction')`).run()
    await expect(stack.runner.getJob('other-task')).rejects.toThrow(/kind/)
  })
})

describe('cooperative cancel (§8) + resolveNoop', () => {
  it('a run whose signal has fired marks the job cancelled, not failed', async () => {
    const ac = new AbortController()
    ac.abort() // pre-aborted → the very first step-boundary check stops the run
    stack.runner.define('cw', [step('a')])
    await expect(stack.runner.run('cw', {}, { jobId: 'cw-1', signal: ac.signal })).rejects.toThrow()
    expect((await stack.runner.getJob('cw-1'))?.status).toBe('cancelled')
  })

  it('threads the cancel signal into each step context', async () => {
    let seen: AbortSignal | undefined
    stack.runner.define('sw', [
      {
        name: 'a',
        run: (_state, ctx) => {
          seen = ctx.signal
          return {}
        }
      }
    ])
    const ac = new AbortController()
    await stack.runner.run('sw', {}, { jobId: 'sw-1', signal: ac.signal })
    expect(seen).toBe(ac.signal)
  })

  it('cancels at a mid-workflow boundary — earlier steps keep their checkpoint', async () => {
    const ac = new AbortController()
    const ran: string[] = []
    stack.runner.define('mw', [
      {
        name: 'first',
        run: () => {
          ran.push('first')
          ac.abort() // fire the cancel; the boundary before 'second' will catch it
          return {}
        }
      },
      {
        name: 'second',
        run: () => {
          ran.push('second')
          return {}
        }
      }
    ])
    await expect(stack.runner.run('mw', {}, { jobId: 'mw-1', signal: ac.signal })).rejects.toThrow()
    expect(ran).toEqual(['first']) // 'second' never started
    expect((await stack.runner.getJob('mw-1'))?.status).toBe('cancelled')
  })

  it('resolveNoop settles a failed job row to done and no-ops on a missing row', async () => {
    stack.runner.define('nw', [
      {
        name: 'boom',
        run: () => {
          throw new Error('nope')
        }
      }
    ])
    await expect(stack.runner.run('nw', {}, { jobId: 'nw-1' })).rejects.toThrow()
    expect((await stack.runner.getJob('nw-1'))?.status).toBe('failed')
    stack.runner.resolveNoop('nw-1')
    expect((await stack.runner.getJob('nw-1'))?.status).toBe('done')
    expect(() => stack.runner.resolveNoop('ghost')).not.toThrow()
  })
})
