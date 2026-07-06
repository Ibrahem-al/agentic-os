/**
 * The extraction agent (§17 agent #3), assembled as a Phase-04 workflow:
 *
 *   collect → deterministic → extract → resolve → verify → write
 *
 * Every step's output checkpoints into appdata.db (durability 'sync'), so a
 * crash between passes resumes from the last completed pass — earlier model
 * calls are never re-run, and because ALL graph writes live in the final
 * step, a crash before `write` leaves the graph untouched.
 *
 * Trigger policy (phase-08 doc): NO triggers here — `runExtraction(sessionId)`
 * is the manual entry point; the phase-11 session-end hook and inactivity
 * fallback will call exactly this function.
 */
import { randomUUID } from 'node:crypto'
import type BetterSqlite3 from 'better-sqlite3'
import { EXTRACTION_CLOUD_CHUNK_TOKENS } from '../../config'
import type { JsonObject, WorkflowStep } from '../../kernel'
import { meteredComplete } from '../../models'
import { estimatingTokenCounter } from '../../retrieval'
import { planDeterministic } from './deterministic'
import {
  chunkTranscript,
  componentFromSubmission,
  correctionFromSubmission,
  preferenceFromSubmission,
  runFuzzyExtraction,
  type ExtractionMode
} from './fuzzy'
import { resolveEntities } from './resolve'
import { parseTranscriptFile } from './transcript'
import {
  ExtractionError,
  type CollectedCall,
  type CollectedState,
  type DeterministicPlan,
  type ExtractedComponent,
  type ExtractedCorrection,
  type ExtractedPreference,
  type ExtractionAgentDeps,
  type ExtractionLlm,
  type ExtractionResult,
  type ExtractionRunResult,
  type FuzzyExtractionState,
  type ResolveState,
  type TranscriptDigest,
  type VerifyState
} from './types'
import { runVerification, type ExtractionVerifier } from './verify'
import { performGatedWrite } from './write'

export const EXTRACTION_WORKFLOW = 'extraction'
/**
 * The delegate variant (phase-18): resolve → verify → write over items an
 * external Claude already extracted and staged in `runner_submissions`, instead
 * of running the local/cloud fuzzy passes. Powers the interactive
 * `submit_extraction_items` continuation now, and agent-mode extraction in
 * phase-19.
 */
export const EXTRACTION_DELEGATE_WORKFLOW = 'extraction-delegate'
export const EXTRACTION_AGENT_ID = 'extraction-agent'

/** Session node ids are prefixed like every other §18 id family. */
export const sessionNodeIdOf = (sessionId: string): string => `session-${sessionId}`

export interface RunExtractionOptions {
  /** Transcript JSONL path (the SessionEnd hook delivers one; optional). */
  readonly transcriptPath?: string
  /** Working directory override (the hook delivers cwd; transcript records else). */
  readonly cwd?: string
  /** Caller-supplied job id (schedulers / tests); defaults to a random UUID. */
  readonly jobId?: string
}

/** Input for the delegate variant — items already staged in `runner_submissions`. */
export interface RunDelegateExtractionInput {
  /** The task whose `runner_submissions` rows carry the items to resolve+write. */
  readonly taskId: string
  readonly sessionId: string
  /** Optional transcript path (else the §6 `extract-<sid>` task's is resolved). */
  readonly transcriptPath?: string
}

export interface RunDelegateExtractionOptions {
  /** Caller-supplied job id (the queue handler); defaults to a random UUID. */
  readonly jobId?: string
}

export interface ExtractionAgent {
  /** Run extraction for a finished session. Resolves once the workflow completes. */
  runExtraction(sessionId: string, options?: RunExtractionOptions): Promise<ExtractionRunResult>
  /**
   * Run the delegate variant: resolve → verify → write over the items an
   * external Claude staged in `runner_submissions` for `input.taskId` (tier
   * 'subscription'), instead of running the fuzzy passes.
   */
  runDelegateExtraction(
    input: RunDelegateExtractionInput,
    options?: RunDelegateExtractionOptions
  ): Promise<ExtractionRunResult>
  /** Continue a crashed/failed extraction job from its last checkpoint (either workflow). */
  resumeExtraction(jobId: string): Promise<ExtractionRunResult>
}

interface ExtractionInput {
  readonly sessionId: string
  readonly transcriptPath: string | null
  readonly cwd: string | null
}

interface DelegateInput {
  readonly taskId: string
  readonly sessionId: string
  readonly transcriptPath: string | null
}

/**
 * Build the agent and register its workflow on the runner (once per process).
 * Every step executes through the kernel chokepoint (span + PHASE-09
 * permission seam) courtesy of the runner — nothing extra to wire here.
 */
export function createExtractionAgent(deps: ExtractionAgentDeps): ExtractionAgent {
  const selectCalls = deps.db.prepare(
    `SELECT tool, params_json, result_status, started_unix_ms, duration_ms
     FROM mcp_calls WHERE session_id = ? ORDER BY started_unix_ms, id`
  )

  /**
   * The reliable backbone both the main and delegate `collect` steps build:
   * mcp_calls + best-effort transcript → CollectedState. `hasBackbone` is false
   * only when there is nothing to work from (no calls, no transcript) — the
   * main path throws NOT_FOUND on that, the delegate proceeds (its submissions
   * ARE the payload).
   */
  const collectFor = (
    sessionId: string,
    transcriptPath: string | null,
    cwd: string | null
  ): { collected: CollectedState; hasBackbone: boolean } => {
    const warnings: string[] = []
    const rows = selectCalls.all(sessionId) as {
      tool: string
      params_json: string | null
      result_status: string | null
      started_unix_ms: number
      duration_ms: number | null
    }[]
    const calls: CollectedCall[] = rows.map((row) => {
      let params: Record<string, unknown> | null = null
      if (row.params_json !== null) {
        try {
          const parsed: unknown = JSON.parse(row.params_json)
          if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
            params = parsed as Record<string, unknown>
          }
        } catch {
          warnings.push(`mcp_calls row for '${row.tool}' has unparseable params_json — ignored`)
        }
      }
      return {
        tool: row.tool,
        params,
        ok: row.result_status === 'ok',
        startedUnixMs: row.started_unix_ms,
        durationMs: row.duration_ms
      }
    })

    let transcript: TranscriptDigest | null = null
    if (transcriptPath !== null) {
      try {
        transcript = parseTranscriptFile(transcriptPath)
        warnings.push(...transcript.warnings)
        if (transcript.sessionIdSeen !== null && transcript.sessionIdSeen !== sessionId) {
          warnings.push(
            `transcript records carry sessionId '${transcript.sessionIdSeen}', not '${sessionId}' — extracting it anyway (best-effort source, §6)`
          )
        }
      } catch (err) {
        if (err instanceof ExtractionError && err.code === 'NOT_FOUND') {
          // The transcript is the best-effort source (§6) — extraction
          // proceeds on the reliable backbone alone.
          warnings.push(`${err.message} — continuing with the MCP-call log only`)
        } else {
          throw err
        }
      }
    }

    const collected: CollectedState = {
      sessionId,
      sessionNodeId: sessionNodeIdOf(sessionId),
      transcriptPath,
      cwd: cwd ?? transcript?.cwd ?? null,
      calls,
      transcript,
      warnings
    }
    return { collected, hasBackbone: calls.length > 0 || transcript !== null }
  }

  // Steps shared by the main + delegate workflows (deterministic backbone, then
  // resolve → verify → write). resolve/verify bind their §11.4 roles per run.
  const deterministicStep: WorkflowStep = {
    name: 'deterministic',
    async run(state): Promise<JsonObject> {
      const collected = state['collected'] as CollectedState
      const plan = await planDeterministic(deps.engine, collected)
      return { plan } as unknown as JsonObject
    }
  }

  const resolveStep: WorkflowStep = {
    name: 'resolve',
    async run(state, ctx): Promise<JsonObject> {
      const collected = state['collected'] as CollectedState
      const plan = state['plan'] as DeterministicPlan
      const extraction = state['extraction'] as FuzzyExtractionState
      const resolution = await resolveEntities({
        engine: deps.engine,
        embedder: deps.embedder,
        llm: extractionReasoner(deps, 'extraction.tiebreak', ctx.jobId),
        sessionNodeId: collected.sessionNodeId,
        plan,
        extraction
      })
      return { resolution } as unknown as JsonObject
    }
  }

  const verifyStep: WorkflowStep = {
    name: 'verify',
    async run(state, ctx): Promise<JsonObject> {
      const extraction = state['extraction'] as FuzzyExtractionState
      const resolution = state['resolution'] as ResolveState
      const verification = await runVerification({
        verifier: buildVerifier(deps, ctx.jobId),
        extraction,
        resolution
      })
      return { verification } as unknown as JsonObject
    }
  }

  const writeStep: WorkflowStep = {
    name: 'write',
    async run(state): Promise<JsonObject> {
      const result = await performGatedWrite({
        engine: deps.engine,
        db: deps.db,
        collected: state['collected'] as CollectedState,
        plan: state['plan'] as DeterministicPlan,
        extraction: state['extraction'] as FuzzyExtractionState,
        resolution: state['resolution'] as ResolveState,
        verification: state['verification'] as VerifyState,
        ...(deps.audit !== undefined ? { audit: deps.audit } : {})
      })
      return { result } as unknown as JsonObject
    }
  }

  const steps: readonly WorkflowStep[] = [
    {
      name: 'collect',
      run(state): JsonObject {
        const input = state as unknown as ExtractionInput
        const sessionId = typeof input.sessionId === 'string' ? input.sessionId.trim() : ''
        if (sessionId === '') {
          throw new ExtractionError('INVALID_INPUT', 'extraction: sessionId must be a non-empty string')
        }
        const { collected, hasBackbone } = collectFor(sessionId, input.transcriptPath ?? null, input.cwd ?? null)
        if (!hasBackbone) {
          throw new ExtractionError(
            'NOT_FOUND',
            `extraction: session '${sessionId}' has no mcp_calls rows and no readable transcript — nothing to extract`
          )
        }
        return { collected } as unknown as JsonObject
      }
    },
    deterministicStep,
    {
      name: 'extract',
      async run(state, ctx): Promise<JsonObject> {
        const collected = state['collected'] as CollectedState
        // The escalation-mode decision (phase-18): 'subscription' resolves to the
        // §2.2 single big-context tier (no Gate A/B); anything else is today's
        // two-tier local-first + §20 cloud escalation.
        const extraction = await runFuzzyExtraction({
          llm: extractionReasoner(deps, 'extraction.fuzzy', ctx.jobId),
          cloud: deps.cloud ? { ...deps.cloud, taskId: ctx.jobId } : null,
          transcript: collected.transcript,
          mode: fuzzyMode(deps)
        })
        return { extraction } as unknown as JsonObject
      }
    },
    resolveStep,
    verifyStep,
    writeStep
  ]

  // The delegate variant: collect → deterministic → load submissions (tier
  // 'subscription') → resolve → verify → write. It re-chunks the transcript
  // exactly as read_session does so the child's `chunk` indices line up.
  const delegateSteps: readonly WorkflowStep[] = [
    {
      name: 'collect',
      run(state): JsonObject {
        const input = state as unknown as DelegateInput
        const sessionId = typeof input.sessionId === 'string' ? input.sessionId.trim() : ''
        if (sessionId === '') {
          throw new ExtractionError('INVALID_INPUT', 'extraction delegate: sessionId must be a non-empty string')
        }
        // Server-resolved (never caller-arbitrary): the payload's path, else the
        // §6 `extract-<sid>` task's — the SAME file read_session paginates.
        const transcriptPath = input.transcriptPath ?? resolveTranscriptPathFromTask(deps.db, sessionId)
        const { collected } = collectFor(sessionId, transcriptPath, null)
        // No NOT_FOUND throw here: the runner_submissions are the payload.
        return { collected, delegateTaskId: input.taskId } as unknown as JsonObject
      }
    },
    deterministicStep,
    {
      name: 'delegate',
      run(state): JsonObject {
        const collected = state['collected'] as CollectedState
        const taskId = typeof state['delegateTaskId'] === 'string' ? (state['delegateTaskId'] as string) : ''
        const extraction = loadSubmissions(deps.db, taskId, collected.transcript)
        return { extraction } as unknown as JsonObject
      }
    },
    resolveStep,
    verifyStep,
    writeStep
  ]

  deps.runner.define(EXTRACTION_WORKFLOW, steps)
  deps.runner.define(EXTRACTION_DELEGATE_WORKFLOW, delegateSteps)

  const resultOf = async (jobId: string): Promise<ExtractionRunResult> => {
    const job = await deps.runner.getJob(jobId)
    const result = job?.state['result'] as ExtractionResult | undefined
    if (result === undefined) {
      throw new Error(`extraction job ${jobId} finished without a result in its state — this is a bug`)
    }
    return { jobId, ...result }
  }

  return {
    async runExtraction(sessionId, options = {}) {
      if (typeof sessionId !== 'string' || sessionId.trim() === '') {
        throw new ExtractionError('INVALID_INPUT', 'extraction: sessionId must be a non-empty string')
      }
      const jobId = options.jobId ?? randomUUID()
      const input: ExtractionInput = {
        sessionId: sessionId.trim(),
        transcriptPath: options.transcriptPath ?? null,
        cwd: options.cwd ?? null
      }
      await deps.runner.run(EXTRACTION_WORKFLOW, input as unknown as JsonObject, {
        jobId,
        agentId: EXTRACTION_AGENT_ID
      })
      return resultOf(jobId)
    },
    async runDelegateExtraction(input, options = {}) {
      if (typeof input.sessionId !== 'string' || input.sessionId.trim() === '') {
        throw new ExtractionError('INVALID_INPUT', 'extraction delegate: sessionId must be a non-empty string')
      }
      if (typeof input.taskId !== 'string' || input.taskId.trim() === '') {
        throw new ExtractionError('INVALID_INPUT', 'extraction delegate: taskId must be a non-empty string')
      }
      const jobId = options.jobId ?? randomUUID()
      const wfInput: DelegateInput = {
        taskId: input.taskId,
        sessionId: input.sessionId.trim(),
        transcriptPath: input.transcriptPath ?? null
      }
      await deps.runner.run(EXTRACTION_DELEGATE_WORKFLOW, wfInput as unknown as JsonObject, {
        jobId,
        agentId: EXTRACTION_AGENT_ID
      })
      return resultOf(jobId)
    },
    async resumeExtraction(jobId) {
      await deps.runner.resume(jobId)
      return resultOf(jobId)
    }
  }
}

// ── per-run §11.4 role binding + delegate helpers (phase-18) ──────────────────

/**
 * The extraction mode for THIS run: 'subscription' when `extraction.fuzzy`
 * resolves to the subscription tier (a big-context Claude → §2.2 single tier),
 * else 'two-tier' (today's local-first + §20 escalation, DEFAULT == TODAY). No
 * router (every existing test rig) → always 'two-tier'.
 */
function fuzzyMode(deps: ExtractionAgentDeps): ExtractionMode {
  return deps.router?.resolve('extraction.fuzzy').backend === 'subscription-claude' ? 'subscription' : 'two-tier'
}

/**
 * The `ExtractionLlm` for a local-shaped extraction role (`extraction.fuzzy`
 * primary passes / `extraction.tiebreak`): the router's per-run binding when
 * present, else today's `deps.llm`. The router hands back a `RoleReasoner` that
 * satisfies `ExtractionLlm`, so this is dependency injection — the pass logic is
 * unchanged.
 */
function extractionReasoner(
  deps: ExtractionAgentDeps,
  role: 'extraction.fuzzy' | 'extraction.tiebreak',
  jobId: string
): ExtractionLlm {
  return deps.router !== undefined ? deps.router.forRole(role, jobId) : deps.llm
}

/**
 * The independent verifier for `extraction.verify`, transport-agnostic:
 *  - Router present → route through it, but ONLY when the role resolves to a
 *    genuinely non-local tier (cloud-api / subscription). The keyless default
 *    resolves local → null (today's `skipped-no-cloud`). The backend is carried
 *    so verify.ts can apply the §17 self-judging guard (only cloud-api is
 *    independent enough to review a subscription extraction).
 *  - Router absent → today's metered cloud via `deps.cloud` (backend cloud-api),
 *    or null when no key is configured — byte-identical to before phase-18.
 * The router's cloud adapter + `meteredComplete` both keep the §14 $0.50 ceiling.
 */
function buildVerifier(deps: ExtractionAgentDeps, jobId: string): ExtractionVerifier | null {
  const router = deps.router
  if (router !== undefined) {
    const backend = router.resolve('extraction.verify').backend
    if (backend === 'local-qwen3') return null
    return {
      backend,
      complete: async ({ prompt, system, maxTokens }) => {
        const res = await router.complete('extraction.verify', { prompt, system, maxTokens, taskId: jobId })
        return { text: res.text }
      }
    }
  }
  const cloud = deps.cloud
  if (cloud) {
    return {
      backend: 'cloud-api',
      complete: async ({ prompt, system, maxTokens }) => {
        const completion = await meteredComplete(cloud.brain, cloud.meter, jobId, [{ role: 'user', content: prompt }], {
          system,
          maxTokens
        })
        return { text: completion.text }
      }
    }
  }
  return null
}

/** The §6 `extract-<sid>` task's recorded transcript path (server-side, like read_session). */
function resolveTranscriptPathFromTask(db: BetterSqlite3.Database, sessionId: string): string | null {
  // `extract-<sid>` inlined (the §6 dedup id) to avoid an agents→triggers cycle.
  const row = db.prepare('SELECT payload_json FROM tasks WHERE id = ?').get(`extract-${sessionId}`) as
    | { payload_json: string | null }
    | undefined
  if (row?.payload_json == null) return null
  try {
    const payload = JSON.parse(row.payload_json) as { transcriptPath?: unknown }
    return typeof payload.transcriptPath === 'string' && payload.transcriptPath !== '' ? payload.transcriptPath : null
  } catch {
    return null
  }
}

/**
 * Load a task's `runner_submissions` rows into a subscription-tier
 * FuzzyExtractionState. `chunkTexts` is the transcript RE-CHUNKED exactly as
 * read_session paginates (EXTRACTION_CLOUD_CHUNK_TOKENS + estimatingTokenCounter)
 * so the submitted items' `chunk` indices align with the excerpt the verifier
 * sees. Defensive: a corrupt payload row is dropped, never a crash.
 */
function loadSubmissions(
  db: BetterSqlite3.Database,
  taskId: string,
  transcript: TranscriptDigest | null
): FuzzyExtractionState {
  const warnings: string[] = []
  const components: ExtractedComponent[] = []
  const preferences: ExtractedPreference[] = []
  const corrections: ExtractedCorrection[] = []
  if (taskId !== '') {
    const rows = db
      .prepare('SELECT kind, payload_json FROM runner_submissions WHERE task_id = ? ORDER BY id')
      .all(taskId) as { kind: string; payload_json: string }[]
    for (const row of rows) {
      let parsed: unknown
      try {
        parsed = JSON.parse(row.payload_json)
      } catch {
        warnings.push(`runner_submissions row (kind '${row.kind}') has unparseable payload_json — ignored`)
        continue
      }
      if (row.kind === 'component') {
        const item = componentFromSubmission(parsed)
        if (item !== null) components.push(item)
      } else if (row.kind === 'preference') {
        const item = preferenceFromSubmission(parsed)
        if (item !== null) preferences.push(item)
      } else if (row.kind === 'correction') {
        const item = correctionFromSubmission(parsed)
        if (item !== null) corrections.push(item)
      } else {
        warnings.push(`runner_submissions row has unrecognized kind '${row.kind}' — ignored`)
      }
    }
  }
  const chunkTexts =
    transcript !== null && transcript.text.trim() !== ''
      ? chunkTranscript(transcript.text, EXTRACTION_CLOUD_CHUNK_TOKENS, estimatingTokenCounter())
      : []
  return {
    tier: 'subscription',
    components,
    preferences,
    corrections,
    // The subscription/agent tier submitted items directly — no local fuzzy pass
    // ran here, so there is no aggregate call score to report.
    sessionConfidence: null,
    escalated: false,
    escalationReason: null,
    chunkTexts,
    warnings
  }
}
