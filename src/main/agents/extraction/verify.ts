/**
 * Independent verification of low-confidence extractions (§17 step 4).
 *
 * The verifier is a DIFFERENT model than the extractor — same principle as
 * §15's separate critic, so it cannot rubber-stamp its own work:
 * - extractor = local small LLM → verifier = the cloud brain;
 * - extractor = cloud (the session escalated) → the escalation itself was the
 *   independent review (§17: "the step-2 cloud escalation doubles as this
 *   reviewer"), so remaining low-confidence items are persistent uncertainty
 *   and go straight to the human review queue;
 * - no cloud tier configured → same: the review queue is the verifier of last
 *   resort (§13 staged writes).
 *
 * Each verdict is one metered cloud call (§14 ceiling enforced per call); a
 * budget halt or provider failure marks the item 'unavailable' — which the
 * write gate stages, never commits.
 */
import { EXTRACTION_ESCALATE_CONFIDENCE, EXTRACTION_VERIFIER_MAX_TOKENS } from '../../config'
import { SpendCeilingExceededError, type ReasoningBackend } from '../../models'
import { extractJsonObject } from './fuzzy'
import {
  itemKeyOf,
  type FuzzyExtractionState,
  type FuzzyPassName,
  type ResolveState,
  type VerificationResult,
  type VerifyState
} from './types'

/**
 * The independent verifier, transport-agnostic (phase-18): a bound completion
 * plus the backend it runs on. The agent builds it from the router
 * (`extraction.verify` → cloud-api or subscription) or from today's metered
 * `deps.cloud` (backend `'cloud-api'`); null = no genuinely-different tier
 * serves the role (keyless default resolves local). The `backend` decides the
 * §17 self-judging guards: only a `'cloud-api'` verifier is independent enough to
 * review a subscription-tier extraction.
 */
export interface ExtractionVerifier {
  readonly backend: ReasoningBackend
  complete(req: { readonly prompt: string; readonly system: string; readonly maxTokens: number }): Promise<{ text: string }>
}

export const VERIFIER_SYSTEM_PROMPT =
  'You are an independent verification judge for a memory-graph extraction pipeline. ' +
  'Decide whether a candidate memory item is genuinely supported by the transcript excerpt it was extracted from. ' +
  'Reply with ONLY a JSON object — no prose.'

/** The per-item write gate: below this, an item may not commit unverified. */
export const WRITE_GATE_CONFIDENCE = EXTRACTION_ESCALATE_CONFIDENCE

interface VerifiableItem {
  readonly key: string
  readonly kind: 'component' | 'preference' | 'correction'
  readonly payload: Record<string, unknown>
  readonly chunk: number
  readonly confidence: number
}

function verifiableItems(resolution: ResolveState): VerifiableItem[] {
  const items: VerifiableItem[] = []
  for (const component of resolution.components) {
    if (component.confidence >= WRITE_GATE_CONFIDENCE) continue
    items.push({
      key: itemKeyOf('components' as FuzzyPassName, component.name),
      kind: 'component',
      payload: { name: component.name, type: component.type, evidence: component.evidence },
      chunk: component.chunk,
      confidence: component.confidence
    })
  }
  for (const preference of resolution.preferences) {
    if (preference.confidence >= WRITE_GATE_CONFIDENCE) continue
    if (preference.resolution.kind === 'merge' && preference.resolution.via === 'intra-batch') continue
    items.push({
      key: itemKeyOf('preferences' as FuzzyPassName, preference.statement),
      kind: 'preference',
      payload: { statement: preference.statement, evidence: preference.evidence },
      chunk: preference.chunk,
      confidence: preference.confidence
    })
  }
  for (const correction of resolution.corrections) {
    if (correction.confidence >= WRITE_GATE_CONFIDENCE) continue
    items.push({
      key: itemKeyOf('corrections' as FuzzyPassName, correction.content),
      kind: 'correction',
      payload: { content: correction.content, skill: correction.skill, evidence: correction.evidence },
      chunk: correction.chunk,
      confidence: correction.confidence
    })
  }
  return items
}

export interface VerifyOptions {
  /**
   * The independent verifier (phase-18) — bound completion + backend. null = no
   * genuinely-different tier serves `extraction.verify` (keyless default). The
   * agent builds it from the router or today's `deps.cloud`.
   */
  readonly verifier: ExtractionVerifier | null
  readonly extraction: FuzzyExtractionState
  readonly resolution: ResolveState
}

/** Every verifiable item marked 'unavailable' (a guard fired — items go to review). */
function allUnavailable(
  items: readonly VerifiableItem[],
  mode: VerifyState['mode'],
  note: string,
  warnings: readonly string[] = []
): VerifyState {
  return {
    mode,
    results: items.map((item) => ({ itemKey: item.key, verdict: 'unavailable', confidence: null, note })),
    warnings
  }
}

export async function runVerification(options: VerifyOptions): Promise<VerifyState> {
  const items = verifiableItems(options.resolution)
  if (items.length === 0) return { mode: 'none-needed', results: [], warnings: [] }

  const tier = options.extraction.tier
  const verifier = options.verifier

  if (tier === 'cloud') {
    // The cloud already extracted (and thereby reviewed) this session; a
    // second pass by the same model would be self-judging (§15 principle).
    return allUnavailable(
      items,
      'skipped-cloud-extractor',
      'cloud escalation already reviewed this session — persistent uncertainty goes to human review'
    )
  }
  if (tier === 'subscription' && (verifier === null || verifier.backend !== 'cloud-api')) {
    // §17 self-judging guard for the subscription tier: the subscription
    // extracted, so verifying with the same subscription tier (or with no
    // independent tier at all) would be self-judging — mirror the cloud guard
    // and send below-gate items to the human queue. Only a genuinely
    // independent cloud-api verifier (a configured API key) may review it.
    return allUnavailable(
      items,
      'skipped-subscription-extractor',
      'subscription tier extracted this session — no independent cloud verifier; persistent uncertainty goes to human review'
    )
  }
  if (verifier === null) {
    return allUnavailable(items, 'skipped-no-cloud', 'no cloud tier configured — low-confidence item goes to human review', [
      'no cloud tier configured — low-confidence items were staged unverified'
    ])
  }

  const warnings: string[] = []
  const results: VerificationResult[] = []
  let budgetHalted = false
  for (const item of items) {
    if (budgetHalted) {
      results.push({ itemKey: item.key, verdict: 'unavailable', confidence: null, note: 'spend ceiling reached' })
      continue
    }
    const chunkText = options.extraction.chunkTexts[item.chunk] ?? ''
    const prompt =
      `A smaller model extracted this candidate ${item.kind} from a coding-session transcript, with low confidence ` +
      `(${item.confidence.toFixed(2)}).\n\nCandidate ${item.kind}:\n${JSON.stringify(item.payload)}\n\n` +
      `Transcript excerpt it was extracted from:\n${chunkText}\n\n` +
      'Confirm ONLY if the excerpt clearly supports the candidate' +
      (item.kind === 'correction' ? ' (for corrections: the user must have explicitly stated it)' : '') +
      '.\nReply with exactly: {"verdict": "confirm" | "reject", "confidence": <0..1>, "note": "<one short sentence>"}'
    try {
      const completion = await verifier.complete({
        prompt,
        system: VERIFIER_SYSTEM_PROMPT,
        maxTokens: EXTRACTION_VERIFIER_MAX_TOKENS
      })
      const parsed = extractJsonObject(completion.text)
      const verdictRaw = parsed?.['verdict']
      const verdict = verdictRaw === 'confirm' ? 'confirm' : verdictRaw === 'reject' ? 'reject' : null
      if (verdict === null) {
        results.push({
          itemKey: item.key,
          verdict: 'unavailable',
          confidence: null,
          note: 'verifier reply was unparseable'
        })
        warnings.push(`verifier reply unparseable for ${item.key}`)
        continue
      }
      const confidenceRaw = parsed?.['confidence']
      const confidence =
        typeof confidenceRaw === 'number' && !Number.isNaN(confidenceRaw)
          ? Math.min(1, Math.max(0, confidenceRaw))
          : null
      const noteRaw = parsed?.['note']
      results.push({
        itemKey: item.key,
        verdict,
        confidence,
        note: typeof noteRaw === 'string' ? noteRaw.slice(0, 300) : null
      })
    } catch (err) {
      const budget = err instanceof SpendCeilingExceededError
      if (budget) budgetHalted = true
      results.push({
        itemKey: item.key,
        verdict: 'unavailable',
        confidence: null,
        note: budget ? 'spend ceiling reached' : 'verifier call failed'
      })
      warnings.push(
        `verifier ${budget ? 'halted by spend ceiling' : 'failed'} for ${item.key}: ${err instanceof Error ? err.message : String(err)}`
      )
    }
  }
  return { mode: 'cloud', results, warnings }
}
