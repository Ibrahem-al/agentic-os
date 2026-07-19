/**
 * Triggers barrel (§7/§8, phase 11): the durable task queue, time schedules,
 * session-end detection (hook endpoint handler + spool drain + inactivity
 * fallback), the hook installer, user rules and the watchers runtime. Boot
 * (src/main/index.ts) composes these; tests compose them with seams.
 */
export {
  DurableTaskQueue,
  TaskFatalError,
  TaskRetryAtError,
  TaskRetryError,
  type DurableTaskQueueDeps,
  type EnqueueRequest,
  type EnqueueResult,
  type TaskHandler,
  type TaskRunContext
} from './queue'
export {
  SCHEDULES,
  TriggerSchedules,
  scheduleFireTaskId,
  type ScheduleSpec,
  type ScheduleStatus
} from './schedules'
export {
  reconcileWorkflowJobs,
  registerMaintenanceHandlers,
  runPruneJob,
  runTaskRetentionSweep,
  type MaintenanceJobDeps,
  type PruneResult,
  type WorkflowReconcileResult
} from './jobs'
export {
  EXTRACTION_TASK_KIND,
  InactivityMonitor,
  createSessionEndHookHandler,
  drainSessionSpool,
  enqueueExtraction,
  enqueueExtractionContinuation,
  extractionContinuationTaskId,
  extractionTaskId,
  registerExtractionHandler,
  type ExtractionHandlerAgentMode,
  type ExtractionHandlerDeps,
  type HookResponse,
  type SessionEndOrigin,
  type SessionEndPayload,
  type SpoolDrainResult
} from './sessionEnd'
export {
  HookInstallError,
  installSessionEndHook,
  sessionEndHookCommand,
  type InstallHookOptions,
  type InstallHookResult
} from './hookInstaller'
export {
  RULE_FILE_SUFFIX,
  RULE_PRESETS,
  analyzeRule,
  derivePresetCapabilities,
  evaluateRuleCondition,
  loadRules,
  parseRuleCondition,
  parseRuleFile,
  registerRuleAgents,
  ruleAgentId,
  type LoadedRule,
  type RuleAction,
  type RuleAnalysis,
  type RuleAnalysisCtx,
  type RuleCondition,
  type RuleFileJson,
  type RuleIssue,
  type RuleLoadError,
  type RuleLoadResult,
  type RulePresetName,
  type RuleTrigger
} from './rules'
export {
  INGEST_FILE_TASK_KIND,
  RULE_ACTION_TASK_KIND,
  TriggerWatchers,
  WATCH_SCAN_TASK_KIND,
  describeRuleTrigger,
  enqueueRuleFire,
  registerIngestHandlers,
  registerRuleActionHandler,
  type IngestHandlerDeps,
  type RuleHandlerDeps,
  type TriggerWatchersDeps,
  type WatcherStatus
} from './watchers'
export {
  RuleRuntime,
  ruleFingerprint,
  type RuleReloadResult,
  type RuleRuntimeDeps
} from './reload'
export {
  RuleStore,
  RuleStoreError,
  type RuleMutationOutcome,
  type RuleStoreAudit,
  type RuleStoreDeps,
  type RuleStoreEntry
} from './ruleStore'
