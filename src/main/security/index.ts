/**
 * Security barrel (§11, §13 — phase 09): capability schema, permission
 * engine, sandbox lanes, audit/undo, staged-writes lifecycle, injection
 * defenses. The rest of the app imports from here.
 */
export {
  CapabilityDeclarationSchema,
  CapabilityError,
  EMPTY_CAPABILITIES,
  capabilitiesWithin,
  denoPermissionFlags,
  dockerCapabilityArgs,
  isDomainAllowed,
  isPathWithin,
  parseCapabilities,
  pathsAllowed,
  type DockerCapabilityArgs
} from './capabilities'
export {
  CONTROL_TOOLS,
  PermissionEngine,
  READ_TOOLS,
  STAGING_TOOLS,
  registerInternalAgents,
  type AgentProfile,
  type ApprovalRow,
  type GatedTier
} from './permissions'
export {
  AuditLog,
  UndoError,
  type AuditActionRow,
  type AuditLogDeps,
  type GraphInverseOp,
  type UndoErrorCode
} from './audit'
export {
  approveStagedWrite,
  getStagedWrite,
  listStagedWrites,
  rejectStagedWrite,
  rejectStagedWriteWithEffects,
  renderStagedWriteDiff,
  stagedWriteRequiresEmbedder,
  StagedWriteError,
  type ApproveResult,
  type CommitEmbedder,
  type StagedWriteRow,
  type StagedWriteStatus,
  type StagedWritesDeps
} from './stagedWrites'
export { untrusted, UntrustedText, untrustedForPromptData, untrustedForStorage } from './untrusted'
export {
  createInjectionScanner,
  INJECTION_PATTERNS,
  type InjectionFinding,
  type InjectionScanner,
  type InjectionScannerDeps,
  type InjectionScanResult,
  type ScannerLlm
} from './scanner'
export {
  collectSandboxProcess,
  SANDBOX_MAX_OUTPUT_BYTES,
  type SandboxErrorKind,
  type SandboxFailure,
  type SandboxLane,
  type SandboxResult,
  type SandboxRunRequest,
  type SandboxSuccess
} from './sandbox'
export { DenoLane, ensureDenoBinary } from './deno'
export {
  detectDocker,
  DockerLane,
  dockerHostUserArgs,
  interpretDockerProbe,
  resetDockerDetection,
  type DockerDetection
} from './docker'
export { extractZipEntry } from './zip'
