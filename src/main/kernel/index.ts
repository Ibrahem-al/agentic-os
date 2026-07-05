/**
 * Kernel barrel (§9, §10) — the rest of the app imports from here. LangGraph
 * never leaks past this boundary (ESLint-enforced): agent code sees only
 * WorkflowRunner / WorkflowStep / ActionExecutor.
 */
export { SqliteCheckpointSaver } from './checkpointer'
export {
  ContextManager,
  type AssembledPrompt,
  type AssemblePromptRequest,
  type ContextManagerDeps,
  type ContextSection,
  type SummarizedSectionInfo
} from './context'
export {
  allowAllPermissions,
  createAuditLogStub,
  Kernel,
  KernelApprovalPendingError,
  KernelPermissionError,
  type KernelDeps
} from './kernel'
export { LangGraphRunner, type LangGraphRunnerDeps } from './runner'
export {
  WorkflowJobError,
  type ActionExecutor,
  type AuditEvent,
  type AuditHook,
  type CapabilityDeclaration,
  type JsonObject,
  type KernelAction,
  type KernelActionKind,
  type PermissionChecker,
  type PermissionDecision,
  type RunWorkflowOptions,
  type SummarizerLlm,
  type WorkflowJobStatus,
  type WorkflowRunner,
  type WorkflowStep,
  type WorkflowStepContext
} from './types'
