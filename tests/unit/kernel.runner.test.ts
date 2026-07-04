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
