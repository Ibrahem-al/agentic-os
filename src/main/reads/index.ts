/**
 * Reads barrel (phase 15) — the shared read functions behind BOTH the
 * dashboard IPC read handlers (`ipc.ts`, refactored to call these) and the §4
 * MCP read tools (`mcp/tools/read.ts`). Every function is a pure adapter over
 * an existing query/owning-module fn returning a plain, renderer-safe DTO; no
 * function here writes anything.
 *
 * Renderer-safe DTOs are reused from `src/shared/ipc.ts` where a dashboard
 * equivalent exists; genuinely new tool shapes live in `./types`.
 */
export { jsonify, jsonObject } from './serialize'
export * from './types'

export {
  DISPLAY_PROPS,
  assertLabel,
  displayOf,
  getNode,
  inspectableColumns,
  listNodes,
  memoryCounts,
  truncate,
  type GetNodeArgs,
  type ListNodesArgs
} from './memory'

export { graphOverview, type GraphOverviewArgs } from './graph'

export {
  getSkillDetail,
  getSkillFull,
  getSkillImprovement,
  getSkillSignal,
  improvementEntryDto,
  type SkillReadDeps
} from './skills'

export {
  getPendingWork,
  listSessions,
  readSession,
  type PendingWorkArgs,
  type PendingWorkDeps,
  type ReadSessionArgs,
  type SessionReadsDeps
} from './sessions'

export {
  getStagedWriteRead,
  listApprovalsRead,
  listInjectionFlags,
  listStagedWritesRead,
  type ApprovalLister,
  type GetStagedWriteArgs,
  type GetStagedWriteDeps,
  type ListStagedWritesArgs
} from './review'

export {
  getSpendSummary,
  getTrace,
  getUsage,
  listAuditLog,
  listTraces,
  runnerUsage
} from './observability'

export {
  getLocalUsage,
  type LocalUsageArgs,
  type LocalUsageDeps,
  type LocalUsageOllama
} from './localUsage'

export {
  getTask,
  getTriggersStatus,
  listTasks,
  listWatchedFolders,
  type GetTaskArgs,
  type GetTaskDeps,
  type TriggerStatusDeps,
  type TriggersStatusArgs
} from './tasks'

export {
  getTaskProcesses,
  type TaskProcessesArgs,
  type TaskProcessesDeps
} from './processes'

export { sampleProcess, type ProcResourceSample } from './processSampler'

export {
  getAppStatus,
  getSettingsSummary,
  type AppStatusDeps,
  type SettingsSummaryDeps
} from './status'

export { getRunnerStatus, type RunnerStatusDeps, type RunnerStatusSource } from './runner'

export { getReasoningRoles, type ReasoningRolesDeps } from './reasoningRoles'
