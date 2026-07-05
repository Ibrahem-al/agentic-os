/**
 * Workflow runner integration (§9, §10, DoD 1+2 in-process half): the 3-step
 * demo workflow runs to completion with durable checkpoints, spans land in
 * the traces table with correct parent-child ids, failures mark the job and
 * resume() continues from the last good checkpoint in the SAME trace.
 * (Kill-the-process resume lives in kernel.kill.test.ts.)
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { LangGraphRunner, WorkflowJobError, type WorkflowStep } from '../../src/main/kernel'
import { DEMO_WORKFLOW_NAME, demoSteps } from '../fixtures/demo-workflow'
import { openKernelStack, spanAttributes, spanRows, type KernelTestStack } from '../fixtures/kernel-helpers'

let stack: KernelTestStack

beforeEach(() => {
  stack = openKernelStack()
})

afterEach(() => {
  stack.cleanup()
})

describe('3-step demo workflow (DoD 1)', () => {
  it('runs to completion, accumulating state through checkpointed steps', async () => {
    const log: string[] = []
    stack.runner.define(DEMO_WORKFLOW_NAME, demoSteps((line) => log.push(line)))

    const jobId = await stack.runner.run(DEMO_WORKFLOW_NAME, { seed: 42 }, { jobId: 'demo-1', agentId: 'agent-demo' })
    expect(jobId).toBe('demo-1')
    expect(log).toEqual(['fetch', 'process', 'finalize'])

    const job = await stack.runner.getJob('demo-1')
    expect(job).toBeDefined()
    expect(job!.status).toBe('done')
    expect(job!.attempts).toBe(1)
    expect(job!.lastError).toBeNull()
    expect(job!.nextSteps).toEqual([])
    expect(job!.state).toEqual({
      seed: 42,
      fetched: 'payload-42',
      processed: 'payload-42-processed',
      finalized: true,
      summary: 'payload-42-processed-done'
    })

    // Durable checkpoints exist in appdata.db for this thread.
    const checkpoints = stack.appData.db
      .prepare('SELECT count(*) AS c FROM workflow_checkpoints WHERE thread_id = ?')
      .get('demo-1') as { c: number }
    expect(checkpoints.c).toBeGreaterThanOrEqual(3)
  })

  it('emits spans with correct parent-child ids (DoD 2)', async () => {
    stack.runner.define(DEMO_WORKFLOW_NAME, demoSteps(() => undefined))
    await stack.runner.run(DEMO_WORKFLOW_NAME, { seed: 1 }, { jobId: 'demo-spans', agentId: 'agent-demo' })

    const root = spanRows(stack.appData, 'workflow.run')
    expect(root).toHaveLength(1)
    expect(root[0]!.parent_span_id).toBeNull()
    expect(root[0]!.status).toBe('ok')
    expect(spanAttributes(root[0]!)).toMatchObject({
      'workflow.name': DEMO_WORKFLOW_NAME,
      'workflow.job_id': 'demo-spans',
      'agent.id': 'agent-demo'
    })

    const steps = spanRows(stack.appData, 'kernel.workflow-step')
    expect(steps).toHaveLength(3)
    for (const step of steps) {
      expect(step.trace_id).toBe(root[0]!.trace_id)
      expect(step.parent_span_id).toBe(root[0]!.span_id)
      expect(step.status).toBe('ok')
      expect(spanAttributes(step)).toMatchObject({ 'agent.id': 'agent-demo', 'workflow.job_id': 'demo-spans' })
    }
    expect(steps.map((s) => spanAttributes(s)['action.name'])).toEqual(['fetch', 'process', 'finalize'])
    expect(steps.map((s) => spanAttributes(s)['workflow.step_index'])).toEqual([0, 1, 2])

    // Every step also went through the kernel chokepoint's audit stub.
    expect(stack.audit.events.filter((e) => e.action.kind === 'workflow-step')).toHaveLength(3)
  })
})

describe('failure + resume in-process (same trace)', () => {
  let allowStep2 = false
  let step1Runs = 0

  const gatedSteps: WorkflowStep[] = [
    {
      name: 'one',
      run: () => {
        step1Runs += 1
        return { one: 'done' }
      }
    },
    {
      name: 'two',
      run: () => {
        if (!allowStep2) throw new Error('gate closed')
        return { two: 'done' }
      }
    },
    { name: 'three', run: () => ({ three: 'done' }) }
  ]

  beforeEach(() => {
    allowStep2 = false
    step1Runs = 0
    stack.runner.define('gated', gatedSteps)
  })

  it('marks the job failed, then resume() completes it without re-running step 1', async () => {
    await expect(stack.runner.run('gated', {}, { jobId: 'gated-1' })).rejects.toThrow(WorkflowJobError)

    let job = await stack.runner.getJob('gated-1')
    expect(job!.status).toBe('failed')
    expect(job!.lastError).toContain('gate closed')
    expect(job!.state).toEqual({ one: 'done' }) // step 1's checkpoint survived
    expect(step1Runs).toBe(1)

    const failedStepSpans = spanRows(stack.appData, 'kernel.workflow-step').filter((s) => s.status === 'error')
    expect(failedStepSpans).toHaveLength(1)
    expect(spanRows(stack.appData, 'workflow.run')[0]!.status).toBe('error')

    allowStep2 = true
    await stack.runner.resume('gated-1')

    job = await stack.runner.getJob('gated-1')
    expect(job!.status).toBe('done')
    expect(job!.attempts).toBe(2)
    expect(job!.state).toEqual({ one: 'done', two: 'done', three: 'done' })
    expect(step1Runs).toBe(1) // resumed from the checkpoint, not from scratch

    // The resume joined the original trace: same trace id, parented on the
    // original workflow.run root span.
    const root = spanRows(stack.appData, 'workflow.run')[0]!
    const resume = spanRows(stack.appData, 'workflow.resume')
    expect(resume).toHaveLength(1)
    expect(resume[0]!.trace_id).toBe(root.trace_id)
    expect(resume[0]!.parent_span_id).toBe(root.span_id)
    expect(resume[0]!.status).toBe('ok')
  })

  it('resume of a done job is a no-op', async () => {
    allowStep2 = true
    await stack.runner.run('gated', {}, { jobId: 'gated-2' })
    const stepSpansBefore = spanRows(stack.appData, 'kernel.workflow-step').length

    await stack.runner.resume('gated-2')
    const job = await stack.runner.getJob('gated-2')
    expect(job!.status).toBe('done')
    expect(job!.attempts).toBe(1) // untouched
    expect(spanRows(stack.appData, 'kernel.workflow-step')).toHaveLength(stepSpansBefore)
  })
})

describe('§8 cooperative yield at step boundaries', () => {
  /** A runner over the shared stack with an injected yieldPoint. */
  const yieldingRunner = (yieldPoint: () => Promise<void>): LangGraphRunner =>
    new LangGraphRunner({ db: stack.appData.db, telemetry: stack.telemetry, executor: stack.kernel, yieldPoint })

  const loggingStep = (name: string, events: string[], value: number): WorkflowStep => ({
    name,
    run: () => {
      events.push(`step:${name}`)
      return { [name]: value }
    }
  })

  it('awaits the yieldPoint once per step, in order, before each step runs (3 steps = 3 yields)', async () => {
    const events: string[] = []
    const runner = yieldingRunner(() => {
      events.push('yield')
      return Promise.resolve()
    })
    runner.define('yield-order', [
      loggingStep('one', events, 1),
      loggingStep('two', events, 2),
      loggingStep('three', events, 3)
    ])
    await runner.run('yield-order', {}, { jobId: 'yield-order-1' })
    expect(events).toEqual(['yield', 'step:one', 'yield', 'step:two', 'yield', 'step:three'])
  })

  it('a blocked yieldPoint delays the next step; the previous checkpoint is already durable', async () => {
    const events: string[] = []
    let release: (() => void) | undefined
    let yields = 0
    const runner = yieldingRunner(() => {
      yields += 1
      if (yields === 2) {
        // Live session in flight at the step-1 → step-2 boundary: hold the
        // yield until the test releases it.
        return new Promise<void>((resolve) => {
          release = resolve
        })
      }
      return Promise.resolve()
    })
    runner.define('yield-blocked', [loggingStep('one', events, 1), loggingStep('two', events, 2)])

    const running = runner.run('yield-blocked', {}, { jobId: 'yield-blocked-1' })
    await vi.waitFor(() => {
      expect(release).toBeDefined()
    })
    // Step 1 ran and its checkpoint committed; step 2 has provably not started.
    expect(events).toEqual(['step:one'])
    const parked = await runner.getJob('yield-blocked-1')
    expect(parked!.status).toBe('running')
    expect(parked!.state).toEqual({ one: 1 })

    release!()
    await running
    expect(events).toEqual(['step:one', 'step:two'])
    expect((await runner.getJob('yield-blocked-1'))!.status).toBe('done')
  })

  it('resume() flows through the same node closures — resumed steps yield too', async () => {
    const events: string[] = []
    let allowTwo = false
    const runner = yieldingRunner(() => {
      events.push('yield')
      return Promise.resolve()
    })
    runner.define('yield-resume', [
      loggingStep('one', events, 1),
      {
        name: 'two',
        run: () => {
          if (!allowTwo) throw new Error('gate closed')
          events.push('step:two')
          return { two: 2 }
        }
      },
      loggingStep('three', events, 3)
    ])

    await expect(runner.run('yield-resume', {}, { jobId: 'yield-resume-1' })).rejects.toThrow(WorkflowJobError)
    // run(): yield → step one → yield → step two threw (yield precedes even a
    // failing step — the wait happens before the step does any work).
    expect(events).toEqual(['yield', 'step:one', 'yield'])

    allowTwo = true
    await runner.resume('yield-resume-1')
    // resume(): yield → step two → yield → step three; step one NOT re-run.
    expect(events).toEqual(['yield', 'step:one', 'yield', 'yield', 'step:two', 'yield', 'step:three'])
    expect((await runner.getJob('yield-resume-1'))!.status).toBe('done')
  })
})

describe('runner boundary', () => {
  it('a second runner over the same db resumes a job it did not start (definitions are code)', async () => {
    let blockStep2 = true
    const steps: WorkflowStep[] = [
      { name: 'one', run: () => ({ one: 1 }) },
      {
        name: 'two',
        run: () => {
          if (blockStep2) throw new Error('first runner gives up')
          return { two: 2 }
        }
      },
      { name: 'three', run: () => ({ three: 3 }) }
    ]
    stack.runner.define('handover', steps)
    await expect(stack.runner.run('handover', {}, { jobId: 'handover-1' })).rejects.toThrow(WorkflowJobError)

    // Fresh runner instance (same process, same db) — real re-instantiation.
    const { allowAllPermissions, Kernel, LangGraphRunner } = await import('../../src/main/kernel')
    const secondRunner = new LangGraphRunner({
      db: stack.appData.db,
      telemetry: stack.telemetry,
      executor: new Kernel({ telemetry: stack.telemetry, permissions: allowAllPermissions() })
    })
    secondRunner.define('handover', steps)
    blockStep2 = false
    await secondRunner.resume('handover-1')
    const job = await secondRunner.getJob('handover-1')
    expect(job!.status).toBe('done')
    expect(job!.state).toEqual({ one: 1, two: 2, three: 3 })
  })
})
