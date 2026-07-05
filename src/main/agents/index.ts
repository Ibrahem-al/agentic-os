/**
 * Background agents barrel (§17). Phase 08 ships the extraction agent; the
 * skill-improvement agent (phase 12) will live beside it. Everything here
 * codes against the kernel/storage/model INTERFACES — no fenced SDK imports.
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
