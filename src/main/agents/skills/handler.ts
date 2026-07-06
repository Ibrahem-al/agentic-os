/**
 * Queue integration (phase 12 replacing the phase-11 no-op slot): the §20
 * 02:00 schedule enqueues kind 'skill-improvement' nightly (event-gated
 * inside the workflow's plan step, so the task row honestly records
 * "checked, nothing to do" on quiet nights), and the dashboard's
 * "improve now" enqueues a manual task carrying the skillId.
 *
 * Retries RESUME the same workflow job (deterministic `<taskId>-wf` id, the
 * phase-11 extraction-handler pattern): checkpointed cloud calls are never
 * re-bought by a retry.
 */
import { TASK_CLASS_BAND, TASK_PRIORITY } from '../../config'
import type { WorkflowRunner } from '../../kernel'
import { TaskFatalError, type DurableTaskQueue, type EnqueueResult } from '../../triggers/queue'
import type { SkillImprovementAgent } from './agent'
import { decodeProvidedCandidate } from './candidate'
import { SkillImprovementError } from './types'

export const SKILL_IMPROVEMENT_TASK_KIND = 'skill-improvement'

export interface SkillImprovementHandlerDeps {
  readonly agent: SkillImprovementAgent
  readonly runner: WorkflowRunner
}

/** Does the error chain end in a non-retryable skill-improvement error? */
function fatalCode(err: unknown): string | null {
  let current: unknown = err
  for (let depth = 0; depth < 6 && current instanceof Error; depth++) {
    if (current instanceof SkillImprovementError && (current.code === 'NOT_FOUND' || current.code === 'INVALID_INPUT')) {
      return current.code
    }
    current = current.cause
  }
  return null
}

export function registerSkillImprovementHandler(queue: DurableTaskQueue, deps: SkillImprovementHandlerDeps): void {
  queue.registerHandler(SKILL_IMPROVEMENT_TASK_KIND, async (payload, ctx) => {
    const skillId = typeof payload['skillId'] === 'string' && payload['skillId'] !== '' ? payload['skillId'] : undefined
    // phase-18: a `propose_skill_revision` task carries a client-provided
    // SKILL.md the candidate step uses instead of the cloud rewrite (still gated).
    // Only bound on the FIRST run — resume replays it from the checkpointed state.
    const providedCandidate = skillId !== undefined ? decodeProvidedCandidate(skillId, payload['providedCandidate']) : undefined
    const workflowJobId = `${ctx.taskId}-wf`
    try {
      const existing = await deps.runner.getJob(workflowJobId)
      const result =
        existing !== undefined
          ? await deps.agent.resumeImprovement(workflowJobId)
          : await deps.agent.runImprovement({
              jobId: workflowJobId,
              ...(skillId !== undefined ? { skillId } : {}),
              ...(providedCandidate !== undefined ? { providedCandidate } : {})
            })
      const counts = new Map<string, number>()
      for (const entry of result.processed) counts.set(entry.outcome, (counts.get(entry.outcome) ?? 0) + 1)
      const outcomeNote =
        result.processed.length === 0
          ? 'no skills accrued new corrections or failure examples — nothing to do'
          : [...counts.entries()].map(([outcome, count]) => `${outcome} ${count}`).join(', ')
      const driftNote =
        result.drift.length > 0 ? `; drift: ${result.drift.map((d) => `${d.skillId} ${d.action}`).join(', ')}` : ''
      return { note: `${result.mode} run — ${outcomeNote}${driftNote}` }
    } catch (err) {
      const code = fatalCode(err)
      if (code !== null) {
        throw new TaskFatalError(
          `skill-improvement task ${ctx.taskId} cannot succeed (${code}): ${err instanceof Error ? err.message : String(err)}`,
          { cause: err }
        )
      }
      throw err
    }
  })
}

/** The §17 manual "improve this skill now" trigger (dashboard IPC). */
export function enqueueManualImprovement(queue: DurableTaskQueue, skillId: string): EnqueueResult {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  return queue.enqueue({
    id: `skill-manual-${skillId}-${stamp}`,
    kind: SKILL_IMPROVEMENT_TASK_KIND,
    // §8 priority classes: "improve now" comes from the dashboard, so it
    // rides the user band; the nightly 02:00 slot stays background.
    priority: TASK_CLASS_BAND.user + TASK_PRIORITY.skillImprove,
    payload: { skillId }
  })
}
