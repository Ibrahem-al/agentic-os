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
import type { JsonObject, WorkflowStep } from '../../kernel'
import { planDeterministic } from './deterministic'
import { runFuzzyExtraction } from './fuzzy'
import { resolveEntities } from './resolve'
import { parseTranscriptFile } from './transcript'
import {
  ExtractionError,
  type CollectedCall,
  type CollectedState,
  type DeterministicPlan,
  type ExtractionAgentDeps,
  type ExtractionResult,
  type ExtractionRunResult,
  type FuzzyExtractionState,
  type ResolveState,
  type TranscriptDigest,
  type VerifyState
} from './types'
import { runVerification } from './verify'
import { performGatedWrite } from './write'

export const EXTRACTION_WORKFLOW = 'extraction'
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

export interface ExtractionAgent {
  /** Run extraction for a finished session. Resolves once the workflow completes. */
  runExtraction(sessionId: string, options?: RunExtractionOptions): Promise<ExtractionRunResult>
  /** Continue a crashed/failed extraction job from its last checkpoint. */
  resumeExtraction(jobId: string): Promise<ExtractionRunResult>
}

interface ExtractionInput {
  readonly sessionId: string
  readonly transcriptPath: string | null
  readonly cwd: string | null
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

  const steps: readonly WorkflowStep[] = [
    {
      name: 'collect',
      run(state): JsonObject {
        const input = state as unknown as ExtractionInput
        const sessionId = typeof input.sessionId === 'string' ? input.sessionId.trim() : ''
        if (sessionId === '') {
          throw new ExtractionError('INVALID_INPUT', 'extraction: sessionId must be a non-empty string')
        }
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
        const transcriptPath = input.transcriptPath ?? null
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

        if (calls.length === 0 && transcript === null) {
          throw new ExtractionError(
            'NOT_FOUND',
            `extraction: session '${sessionId}' has no mcp_calls rows and no readable transcript — nothing to extract`
          )
        }

        const collected: CollectedState = {
          sessionId,
          sessionNodeId: sessionNodeIdOf(sessionId),
          transcriptPath,
          cwd: input.cwd ?? transcript?.cwd ?? null,
          calls,
          transcript,
          warnings
        }
        return { collected } as unknown as JsonObject
      }
    },
    {
      name: 'deterministic',
      async run(state): Promise<JsonObject> {
        const collected = state['collected'] as CollectedState
        const plan = await planDeterministic(deps.engine, collected)
        return { plan } as unknown as JsonObject
      }
    },
    {
      name: 'extract',
      async run(state, ctx): Promise<JsonObject> {
        const collected = state['collected'] as CollectedState
        const extraction = await runFuzzyExtraction({
          llm: deps.llm,
          cloud: deps.cloud ? { ...deps.cloud, taskId: ctx.jobId } : null,
          transcript: collected.transcript
        })
        return { extraction } as unknown as JsonObject
      }
    },
    {
      name: 'resolve',
      async run(state): Promise<JsonObject> {
        const collected = state['collected'] as CollectedState
        const plan = state['plan'] as DeterministicPlan
        const extraction = state['extraction'] as FuzzyExtractionState
        const resolution = await resolveEntities({
          engine: deps.engine,
          embedder: deps.embedder,
          llm: deps.llm,
          sessionNodeId: collected.sessionNodeId,
          plan,
          extraction
        })
        return { resolution } as unknown as JsonObject
      }
    },
    {
      name: 'verify',
      async run(state, ctx): Promise<JsonObject> {
        const extraction = state['extraction'] as FuzzyExtractionState
        const resolution = state['resolution'] as ResolveState
        const verification = await runVerification({
          cloud: deps.cloud ? { ...deps.cloud, taskId: ctx.jobId } : null,
          extraction,
          resolution
        })
        return { verification } as unknown as JsonObject
      }
    },
    {
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
  ]

  deps.runner.define(EXTRACTION_WORKFLOW, steps)

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
    async resumeExtraction(jobId) {
      await deps.runner.resume(jobId)
      return resultOf(jobId)
    }
  }
}
