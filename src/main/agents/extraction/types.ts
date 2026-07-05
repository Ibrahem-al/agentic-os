/**
 * Extraction-agent types (§17 "Extraction agent — detailed design", phase 08).
 *
 * The agent is a Phase-04 workflow: every slice of state below is checkpointed
 * between steps, so everything must be plain JSON (timestamps as ISO strings,
 * embeddings as number[]). Graph writes happen ONLY in the final `write` step
 * — a crash between passes leaves the graph untouched and `resume()` replays
 * from the last completed pass without re-running earlier model calls.
 *
 * Model dependencies are structural (mirrors retrieval/types.ts): the real
 * OllamaClient / CloudBrain / SpendMeter satisfy them, tests inject fakes.
 */
import type BetterSqlite3 from 'better-sqlite3'
import { EXTRACTION_PROVENANCE } from '../../config'
import type { WorkflowRunner } from '../../kernel'
import type { CloudBrain, SpendMeter } from '../../models'
import type { StorageEngine } from '../../storage'

// ── Structural model interfaces ──────────────────────────────────────────────

/** Satisfied by OllamaClient (bge-m3 — the only embedding model). */
export interface ExtractionEmbedder {
  embed(texts: string[]): Promise<number[][]>
}

/**
 * Satisfied by OllamaClient — the LOCAL small LLM (§4 "cheap parts of
 * extraction"). `format` is Ollama structured outputs: schema-constrained
 * decoding is what keeps qwen3:4b from narrating away its output budget
 * (phase-08 finding; fakes may ignore it).
 */
export interface ExtractionLlm {
  generate(
    prompt: string,
    options?: {
      system?: string
      maxTokens?: number
      temperature?: number
      format?: 'json' | Record<string, unknown>
    }
  ): Promise<{ text: string }>
}

/**
 * The cloud tier for escalation + independent verification (§17 step 4). The
 * meter enforces the §14 per-task ceiling on every call (taskId = the
 * workflow job id).
 */
export interface ExtractionCloud {
  readonly brain: CloudBrain
  readonly meter: SpendMeter
}

export interface ExtractionAgentDeps {
  readonly engine: StorageEngine
  /** appdata.db — mcp_calls reads + staged_writes inserts (SQLite, not the graph). */
  readonly db: BetterSqlite3.Database
  readonly runner: WorkflowRunner
  readonly embedder: ExtractionEmbedder
  readonly llm: ExtractionLlm
  /** Absent = no API key configured; escalation/verification degrade to staging. */
  readonly cloud?: ExtractionCloud | null
}

// ── Errors ───────────────────────────────────────────────────────────────────

export type ExtractionErrorCode = 'INVALID_INPUT' | 'NOT_FOUND'

export class ExtractionError extends Error {
  readonly code: ExtractionErrorCode

  constructor(code: ExtractionErrorCode, message: string) {
    super(message)
    this.name = 'ExtractionError'
    this.code = code
  }
}

// ── Provenance (§18 v3.1: `extraction@<version>/<pass>`) ─────────────────────

export type ExtractionPass = 'deterministic' | 'llm-local' | 'llm-cloud' | 'llm-local+verified'

export function extractionProvenance(pass: ExtractionPass): string {
  return `${EXTRACTION_PROVENANCE}/${pass}`
}

// ── collect step ─────────────────────────────────────────────────────────────

/** One mcp_calls row, trimmed to what the passes consume (JSON-safe). */
export interface CollectedCall {
  readonly tool: string
  /** Parsed params_json (null when the row stored none / it was oversized). */
  readonly params: Record<string, unknown> | null
  readonly ok: boolean
  readonly startedUnixMs: number
  readonly durationMs: number | null
}

/** Deterministic facts parsed out of the transcript (JSON-safe digest). */
export interface TranscriptDigest {
  /** Recognized JSONL records (rendered or deliberately skipped kinds). */
  readonly records: number
  /** Malformed lines + unknown record types (never a crash — §17 step 2). */
  readonly skippedRecords: number
  readonly cwd: string | null
  readonly sessionIdSeen: string | null
  readonly startedAt: string | null
  readonly endedAt: string | null
  /** Rendered conversation (User:/Assistant:/[tool] lines) for the fuzzy passes. */
  readonly text: string
  readonly tokenEstimate: number
  /** Every tool name seen with its use count (deterministic facts). */
  readonly toolUses: readonly { name: string; count: number }[]
  /** External MCP server names from mcp__<server>__* (never the OS's own). */
  readonly mcpServers: readonly string[]
  /** Plugin names from mcp__plugin_<plugin>_<server>__* and plugin:skill invocations. */
  readonly pluginNames: readonly string[]
  /** Plain skill names invoked via the Skill tool. */
  readonly skillNames: readonly string[]
  readonly warnings: readonly string[]
}

export interface CollectedState {
  readonly sessionId: string
  readonly sessionNodeId: string
  readonly transcriptPath: string | null
  /** Working directory: explicit option > transcript records > null. */
  readonly cwd: string | null
  readonly calls: readonly CollectedCall[]
  readonly transcript: TranscriptDigest | null
  readonly warnings: readonly string[]
}

// ── deterministic step (§17 step 1: no model, confidence 1.0) ────────────────

export interface PlannedRef {
  readonly id: string
  readonly name: string
  /** True when the node must be created in the write step (MERGE semantics, §18). */
  readonly create: boolean
}

export interface DeterministicPlan {
  readonly session: {
    readonly id: string
    readonly startedAt: string | null
    readonly endedAt: string | null
    readonly transcriptRef: string | null
  }
  /** Existing Skill nodes the session provably used (matched, never created). */
  readonly skills: readonly PlannedRef[]
  readonly mcps: readonly PlannedRef[]
  readonly plugins: readonly PlannedRef[]
  /** Matched by cwd path identity, or planned for creation; null without a cwd. */
  readonly project: (PlannedRef & { readonly summary?: string }) | null
  readonly notes: readonly string[]
}

// ── extract step (§17 step 2: fuzzy multi-pass, local-first) ─────────────────

export type FuzzyPassName = 'components' | 'preferences' | 'corrections'

export interface ExtractedComponent {
  readonly name: string
  readonly type: string
  readonly dependsOn: readonly string[]
  readonly confidence: number
  /** Short exact transcript quote backing the item (verifier + review queue). */
  readonly evidence: string
  /** Index of the transcript chunk it was extracted from (verifier context). */
  readonly chunk: number
}

export interface ExtractedPreference {
  readonly statement: string
  readonly tags: readonly string[]
  /** Exact correction quote this preference restates, when the model saw one. */
  readonly derivedFrom: string | null
  readonly confidence: number
  readonly evidence: string
  readonly chunk: number
}

export interface ExtractedCorrection {
  readonly content: string
  /** Skill name the correction targets (matched to an existing Skill later). */
  readonly skill: string | null
  readonly confidence: number
  readonly evidence: string
  readonly chunk: number
}

export type ExtractionTier = 'local' | 'cloud' | 'none'

export interface FuzzyExtractionState {
  readonly tier: ExtractionTier
  readonly components: readonly ExtractedComponent[]
  readonly preferences: readonly ExtractedPreference[]
  readonly corrections: readonly ExtractedCorrection[]
  /**
   * Aggregate local confidence (§20 escalation gate): mean of per-call scores
   * — an unparseable reply scores 0, a clean empty array 1, items their mean
   * confidence. Null when no fuzzy call ran (no transcript).
   */
  readonly sessionConfidence: number | null
  readonly escalated: boolean
  readonly escalationReason: 'transcript-tokens' | 'low-local-confidence' | null
  /** Transcript chunks as prompted (verifier shows an item its source chunk). */
  readonly chunkTexts: readonly string[]
  readonly warnings: readonly string[]
}

// ── resolve step (§17 step 3: tiered entity resolution) ──────────────────────

export type ResolutionDecision =
  | { readonly kind: 'new'; readonly id: string }
  | {
      readonly kind: 'merge'
      /** The existing node the item resolved onto. */
      readonly id: string
      readonly similarity: number
      readonly via: 'stable-key' | 'cosine' | 'llm-tiebreak' | 'intra-batch'
    }

export interface ResolvedComponent extends ExtractedComponent {
  readonly resolution: ResolutionDecision
}

export interface ResolvedPreference extends ExtractedPreference {
  readonly resolution: ResolutionDecision
  /** BGE-M3 embedding of the statement; carried to the write step for new nodes. */
  readonly embedding: readonly number[] | null
}

export interface ResolvedCorrection extends ExtractedCorrection {
  readonly id: string
  /** Existing Skill node the correction IMPROVED (exact name match), if any. */
  readonly skillId: string | null
}

export interface PlannedTag {
  readonly id: string
  readonly name: string
  readonly create: boolean
}

export interface ResolveState {
  readonly components: readonly ResolvedComponent[]
  readonly preferences: readonly ResolvedPreference[]
  readonly corrections: readonly ResolvedCorrection[]
  readonly tags: readonly PlannedTag[]
  /** The project's own name tag (created with the project, phase-07 symmetry). */
  readonly projectTag: PlannedTag | null
  /** True when the matched project already has its TAGGED edge (skip re-MERGE). */
  readonly projectAlreadyTagged: boolean
  /** Embedding for a to-be-created Project (`name — summary`), else null. */
  readonly projectEmbedding: readonly number[] | null
  readonly warnings: readonly string[]
}

// ── verify step (§17 step 4: independent verifier before the review queue) ───

export interface VerificationResult {
  /** `component:<norm name>` / `preference:<norm statement>` / `correction:<norm content>`. */
  readonly itemKey: string
  readonly verdict: 'confirm' | 'reject' | 'unavailable'
  /** The verifier's own confidence (null when unavailable). */
  readonly confidence: number | null
  readonly note: string | null
}

export interface VerifyState {
  readonly mode: 'cloud' | 'none-needed' | 'skipped-no-cloud' | 'skipped-cloud-extractor'
  readonly results: readonly VerificationResult[]
  readonly warnings: readonly string[]
}

// ── write step result ────────────────────────────────────────────────────────

export interface ExtractionResult {
  readonly sessionNodeId: string
  readonly tier: ExtractionTier
  readonly escalated: boolean
  readonly committed: {
    readonly project: 'created' | 'matched' | null
    readonly usedSkills: number
    readonly usedMcps: number
    readonly usedPlugins: number
    readonly components: number
    readonly mergedComponents: number
    readonly preferences: number
    readonly mergedPreferences: number
    readonly corrections: number
  }
  readonly staged: {
    readonly count: number
    readonly ids: readonly string[]
  }
  readonly warnings: readonly string[]
}

export interface ExtractionRunResult extends ExtractionResult {
  readonly jobId: string
}

// ── Normalized item keys (dedup + verification correlation) ──────────────────

export function normalizeItemText(text: string): string {
  return text.toLowerCase().replace(/\s+/g, ' ').trim()
}

export function itemKeyOf(pass: FuzzyPassName, text: string): string {
  const singular = pass.replace(/s$/, '')
  return `${singular}:${normalizeItemText(text)}`
}
