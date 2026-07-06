/**
 * Background agents barrel (§17). Phase 08 ships the extraction agent, phase
 * 12 the skill-improvement agent. Everything here codes against the
 * kernel/storage/model INTERFACES — no fenced SDK imports.
 */
export {
  EXTRACTION_AGENT_ID,
  EXTRACTION_WORKFLOW,
  createExtractionAgent,
  sessionNodeIdOf,
  type ExtractionAgent,
  type RunExtractionOptions
} from './extraction/agent'
export { planDeterministic } from './extraction/deterministic'
export {
  FUZZY_PASS_SCHEMAS,
  FUZZY_SYSTEM_PROMPTS,
  chunkTranscript,
  extractItemsReply,
  extractJsonArray,
  extractJsonObject,
  runFuzzyExtraction,
  type FuzzyExtractionOptions
} from './extraction/fuzzy'
export { TIEBREAK_SYSTEM_PROMPT, resolveEntities, type ResolveOptions } from './extraction/resolve'
export { parseTranscriptContent, parseTranscriptFile } from './extraction/transcript'
export {
  ExtractionError,
  ExtractionUnavailableError,
  extractionProvenance,
  itemKeyOf,
  normalizeItemText,
  type CollectedCall,
  type CollectedState,
  type DeterministicPlan,
  type ExtractedComponent,
  type ExtractedCorrection,
  type ExtractedPreference,
  type ExtractionAgentDeps,
  type ExtractionCloud,
  type ExtractionEmbedder,
  type ExtractionErrorCode,
  type ExtractionLlm,
  type ExtractionPass,
  type ExtractionResult,
  type ExtractionRunResult,
  type ExtractionTier,
  type FuzzyExtractionState,
  type FuzzyPassName,
  type PlannedRef,
  type PlannedTag,
  type ResolutionDecision,
  type ResolveState,
  type ResolvedComponent,
  type ResolvedCorrection,
  type ResolvedPreference,
  type TranscriptDigest,
  type VerificationResult,
  type VerifyState
} from './extraction/types'
export { VERIFIER_SYSTEM_PROMPT, WRITE_GATE_CONFIDENCE, runVerification } from './extraction/verify'
export { performGatedWrite, type GatedWriteOptions } from './extraction/write'

// ── skill-improvement agent (phase 12) ───────────────────────────────────────
export {
  baselineSkillMdOf,
  CLOUD_UNAVAILABLE_ERROR,
  createSkillImprovementAgent,
  SKILL_IMPROVEMENT_WORKFLOW,
  type RunImprovementOptions,
  type SkillImprovementAgent
} from './skills/agent'
export {
  COMPARATOR_SYSTEM_PROMPT,
  EXECUTOR_SYSTEM_MARKER,
  executorSystemPrompt,
  findRegressions,
  GRADER_FORMAT,
  GRADER_SYSTEM_PROMPT,
  majorityPass,
  parseComparatorReply,
  parseGraderReply,
  runBenchmark,
  summarizeBenchmark,
  type RunBenchmarkOptions
} from './skills/benchmark'
export {
  buildRewritePrompt,
  extractSkillMdReply,
  generateCandidate,
  REWRITE_SYSTEM_PROMPT,
  type GenerateCandidateOptions
} from './skills/candidate'
export { collectSignal, hasPendingReview, planImprovementRun, scanDrift, type PlanOptions } from './skills/gate'
export {
  enqueueManualImprovement,
  registerSkillImprovementHandler,
  SKILL_IMPROVEMENT_TASK_KIND,
  type SkillImprovementHandlerDeps
} from './skills/handler'
export {
  adoptSkillVersion,
  candidateVersionIdOf,
  diffLines,
  recordCandidateVersion,
  renderSkillImprovementDiff,
  retireCandidateVersion,
  rollbackSkillAdoption,
  SKILL_IMPROVEMENT_AGENT_ID,
  SKILL_IMPROVEMENT_STAGED_KIND,
  skillEmbedText,
  stagedWriteIdOf,
  stageSkillImprovement,
  type AdoptResult,
  type RollbackResult,
  type SkillImprovementPayload,
  type SkillLifecycleDeps
} from './skills/lifecycle'
export {
  ensureSkillMd,
  exportSkillMdFile,
  importSkillMdFile,
  looksLikeSkillMd,
  parseSkillMd,
  serializeSkillMd,
  SkillMdError,
  skillMdNameOf,
  SKILL_MD_FILENAME,
  type ParsedSkillMd
} from './skills/skillmd'
export {
  getSkillSettings,
  getImprovement,
  latestStandingAdoption,
  listImprovements,
  listOpenDriftWatches,
  markImprovementDecision,
  markImprovementDrift,
  markImprovementRolledBack,
  markSkillRun,
  recordImprovement,
  setSkillSettings,
  type ImprovementOutcome,
  type ImprovementRow,
  type SkillSettings
} from './skills/state'
export {
  assignSplits,
  buildCaseGenPrompt,
  buildCorrectionCases,
  buildTestSet,
  CASE_GEN_SYSTEM_MARKER,
  correctionCaseExpectation,
  extractCaseArray
} from './skills/testset'
export {
  SkillImprovementError,
  type BenchmarkSummary,
  type CaseRunResult,
  type ComparisonResult,
  type DriftApplied,
  type DriftFinding,
  type GradedExpectation,
  type PlanState,
  type ProcessedSkill,
  type RegressionFinding,
  type SkillAdoptionMode,
  type SkillAgentDeps,
  type SkillBenchmark,
  type SkillCandidate,
  type SkillCloud,
  type SkillEmbedder,
  type SkillImprovementResult,
  type SkillImprovementRunResult,
  type SkillLlm,
  type SkillOutcome,
  type SkillTestCase,
  type SkillTestSet,
  type SkillWorkItem
} from './skills/types'
