/**
 * Fuzzy multi-pass extraction (§17 step 2): one focused prompt per target —
 * Components touched, Preferences stated, explicit Corrections — over the
 * rendered transcript. Local-first (§4: the small LLM does the cheap parts);
 * the WHOLE session escalates to the cloud tier when the transcript exceeds
 * the §20 token line or local confidence lands below it.
 *
 * Reply handling is built for the local model's measured quirks (phase-04
 * finding 8: qwen3 narrates around answers): the JSON array is RESCUED from
 * anywhere in the reply, items are normalized field-by-field, and anything
 * malformed is dropped — a bad model reply can never crash the workflow, it
 * only lowers the call's confidence score.
 *
 * Confidence accounting (drives the §20 escalation gate): each pass call
 * scores 0 when its reply had no parseable array (the model failed the task),
 * 1 when it confidently returned an empty array (a real "nothing here"), and
 * the mean item confidence otherwise. The session's local confidence is the
 * mean over local call scores.
 *
 * §21 rule 5: transcript content is DATA inside these prompts — extraction
 * reads it, stores distilled nodes, and nothing in it can trigger a tool call.
 *
 * Correction scope (§17, v1): EXPLICIT user corrections only — the prompt
 * forbids inferring from edits, re-runs, or silence.
 */
import {
  EXTRACTION_CLOUD_CHUNK_TOKENS,
  EXTRACTION_ESCALATE_CONFIDENCE,
  EXTRACTION_ESCALATE_TRANSCRIPT_TOKENS,
  EXTRACTION_LOCAL_CHUNK_TOKENS,
  EXTRACTION_MAX_ITEMS_PER_PASS,
  EXTRACTION_PASS_MAX_TOKENS,
  EXTRACTION_SUBSCRIPTION_CHUNK_TOKENS,
  EXTRACTION_SUBSCRIPTION_PASS_MAX_TOKENS
} from '../../config'
import { meteredComplete } from '../../models'
import { estimatingTokenCounter, type TokenCounter } from '../../retrieval'
import {
  ExtractionUnavailableError,
  normalizeItemText,
  type ExtractedComponent,
  type ExtractedCorrection,
  type ExtractedPreference,
  type ExtractionCloud,
  type ExtractionLlm,
  type FuzzyExtractionState,
  type FuzzyPassName,
  type TranscriptDigest
} from './types'

// ── Prompts (system markers are stable — test fakes dispatch on them) ────────

export const FUZZY_SYSTEM_PROMPTS: Readonly<Record<FuzzyPassName, string>> = {
  components:
    'You extract software components from coding-session transcripts for a memory graph. ' +
    'Components are the meaningful units the session actually worked on or discussed: pages, API routes, ' +
    'data models, services, modules, functions, classes. Reply with ONLY a JSON array — no prose, no reasoning.',
  preferences:
    'You extract user preferences from coding-session transcripts for a memory graph. ' +
    'A preference is a durable statement by the USER about how they want things done. ' +
    'Reply with ONLY a JSON array — no prose, no reasoning.',
  corrections:
    'You extract explicit user corrections from coding-session transcripts for a memory graph. ' +
    'Reply with ONLY a JSON array — no prose, no reasoning.'
}

const PASS_PROMPTS: Readonly<Record<FuzzyPassName, (chunk: string) => string>> = {
  components: (chunk) =>
    'List the software components this transcript excerpt worked on or discussed.\n' +
    'Rules:\n' +
    '- meaningful units only (a page, an API route, a data model, a service, a function) — never whole files and never the project itself\n' +
    '- "type" is one of: page, route, model, service, function, class, module, other\n' +
    '- "depends_on" names OTHER components from your list this one uses, only when the excerpt shows it\n' +
    '- "evidence" is a short exact quote from the excerpt (max 25 words)\n' +
    '- "confidence" is a number 0..1: how sure you are this is a real component of the user\'s software\n' +
    '- if there are none, reply with {"items": []}\n\n' +
    'Reply with JSON: {"items": [{"name": "...", "type": "...", "depends_on": [], "evidence": "...", "confidence": 0.9}]}\n\n' +
    `Transcript excerpt:\n${chunk}\n\nJSON:`,
  preferences: (chunk) =>
    'List the durable preferences the USER stated in this transcript excerpt.\n' +
    'Rules:\n' +
    '- only preferences the user actually stated ("prefer X", "always Y", "never Z", "use A not B") — ' +
    'not one-off instructions for the current task, and never the assistant\'s own suggestions\n' +
    '- "statement" rewrites the preference as one clear self-contained sentence\n' +
    '- "tags" are 1-3 short lowercase topic words (e.g. ["deploy"], ["database", "sql"])\n' +
    '- "derived_from" is the user\'s exact correction quote when the preference restates a correction they made, else null\n' +
    '- "evidence" is a short exact quote of the user\'s words (max 25 words)\n' +
    '- "confidence" is a number 0..1\n' +
    '- if there are none, reply with {"items": []}\n\n' +
    'Reply with JSON: {"items": [{"statement": "...", "tags": ["..."], "derived_from": null, "evidence": "...", "confidence": 0.9}]}\n\n' +
    `Transcript excerpt:\n${chunk}\n\nJSON:`,
  corrections: (chunk) =>
    'List the EXPLICIT corrections the USER stated in this transcript excerpt: clear negative or redirecting ' +
    'feedback about what the assistant did ("no, don\'t X", "stop doing Y", "that\'s wrong — use Z instead").\n' +
    'Rules:\n' +
    '- ONLY corrections the user explicitly stated. Do NOT infer corrections from edits, re-runs, silence, or anything unstated.\n' +
    '- "content" states the correction as one clear self-contained sentence\n' +
    '- "skill" is the skill name the correction applies to when the excerpt names one, else null\n' +
    '- "evidence" is the user\'s exact words (max 25 words)\n' +
    '- "confidence" is a number 0..1\n' +
    '- if there are none, reply with {"items": []}\n\n' +
    'Reply with JSON: {"items": [{"content": "...", "skill": null, "evidence": "...", "confidence": 0.9}]}\n\n' +
    `Transcript excerpt:\n${chunk}\n\nJSON:`
}

/**
 * Ollama structured-output schemas per pass (LOCAL tier only — the cloud tier
 * follows the prompt's shape on its own). Constrained decoding is what makes
 * qwen3:4b answer instead of narrating (probed live, phase-08 report): with a
 * plain prompt it reasons through its ENTIRE output budget; with a schema it
 * fills correct items directly. Top-level object because that is the safest
 * shape across Ollama's grammar generation.
 */
export const FUZZY_PASS_SCHEMAS: Readonly<Record<FuzzyPassName, Record<string, unknown>>> = {
  components: {
    type: 'object',
    properties: {
      items: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            name: { type: 'string' },
            type: { type: 'string' },
            depends_on: { type: 'array', items: { type: 'string' } },
            evidence: { type: 'string' },
            confidence: { type: 'number' }
          },
          required: ['name', 'type', 'depends_on', 'evidence', 'confidence']
        }
      }
    },
    required: ['items']
  },
  preferences: {
    type: 'object',
    properties: {
      items: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            statement: { type: 'string' },
            tags: { type: 'array', items: { type: 'string' } },
            derived_from: { type: ['string', 'null'] },
            evidence: { type: 'string' },
            confidence: { type: 'number' }
          },
          required: ['statement', 'tags', 'derived_from', 'evidence', 'confidence']
        }
      }
    },
    required: ['items']
  },
  corrections: {
    type: 'object',
    properties: {
      items: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            content: { type: 'string' },
            skill: { type: ['string', 'null'] },
            evidence: { type: 'string' },
            confidence: { type: 'number' }
          },
          required: ['content', 'skill', 'evidence', 'confidence']
        }
      }
    },
    required: ['items']
  }
}

// ── Tolerant JSON-array rescue ───────────────────────────────────────────────

/** Bracket positions tried before giving up on a reply (bounds worst case). */
const MAX_ARRAY_SCAN_STARTS = 20

/**
 * Find and parse the first well-formed JSON value opening with `open` in a
 * reply, tolerating any narration around it (phase-04: qwen3 narrates even
 * with think off). Scans string-aware so brackets inside string values never
 * confuse the match.
 */
function rescueJson(reply: string, open: '[' | '{', accept: (parsed: unknown) => boolean): unknown | null {
  let starts = 0
  for (let i = 0; i < reply.length && starts < MAX_ARRAY_SCAN_STARTS; i++) {
    if (reply[i] !== open) continue
    starts += 1
    let depth = 0
    let inString = false
    let escaped = false
    for (let j = i; j < reply.length; j++) {
      const ch = reply[j]
      if (inString) {
        if (escaped) escaped = false
        else if (ch === '\\') escaped = true
        else if (ch === '"') inString = false
        continue
      }
      if (ch === '"') inString = true
      else if (ch === '[' || ch === '{') depth += 1
      else if (ch === ']' || ch === '}') {
        depth -= 1
        if (depth === 0) {
          try {
            const parsed: unknown = JSON.parse(reply.slice(i, j + 1))
            if (accept(parsed)) return parsed
          } catch {
            /* not valid JSON from this start — try the next opener */
          }
          break
        }
      }
    }
  }
  return null
}

/** First well-formed JSON array anywhere in the reply. */
export function extractJsonArray(reply: string): unknown[] | null {
  return rescueJson(reply, '[', (parsed) => Array.isArray(parsed)) as unknown[] | null
}

/** First well-formed JSON object anywhere in the reply. */
export function extractJsonObject(reply: string): Record<string, unknown> | null {
  return rescueJson(reply, '{', (parsed) => parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) as Record<
    string,
    unknown
  > | null
}

/**
 * A pass reply's item list: the schema-constrained `{"items": [...]}` object
 * (local tier) or a bare JSON array (cloud tier). Object-led replies are
 * tried object-first so a '[' inside a string value can never win the scan.
 * Null = the model failed the task.
 */
export function extractItemsReply(reply: string): unknown[] | null {
  if (reply.trimStart().startsWith('{')) {
    const object = extractJsonObject(reply)
    if (object !== null && Array.isArray(object['items'])) return object['items']
  }
  const array = extractJsonArray(reply)
  if (array !== null) return array
  const object = extractJsonObject(reply)
  if (object !== null && Array.isArray(object['items'])) return object['items']
  return null
}

// ── Item normalization (field-by-field, drop-don't-crash) ────────────────────

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)

const cleanText = (value: unknown, maxChars: number): string | null => {
  if (typeof value !== 'string') return null
  const text = value.replace(/\s+/g, ' ').trim()
  return text === '' ? null : text.slice(0, maxChars)
}

const cleanConfidence = (value: unknown): number => {
  // A missing/garbled confidence is treated as borderline (0.5): the write
  // gate then routes the item through verification/review, never a silent commit.
  if (typeof value !== 'number' || Number.isNaN(value)) return 0.5
  return Math.min(1, Math.max(0, value))
}

const cleanStringList = (value: unknown, maxItems: number, maxChars: number): string[] => {
  if (!Array.isArray(value)) return []
  const out: string[] = []
  for (const entry of value) {
    const text = cleanText(entry, maxChars)
    if (text !== null && !out.includes(text)) out.push(text)
    if (out.length >= maxItems) break
  }
  return out
}

/**
 * Normalize a raw model item (snake_case, the fuzzy-pass JSON shape) into an
 * `ExtractedComponent`. EXPORTED (phase-18) so the interactive
 * `submit_extraction_items` MCP tool normalizes agent-submitted items through
 * the exact same field-by-field rules before staging them in
 * `runner_submissions` (identical dedup keys + clamping as the local passes).
 */
export function normalizeComponent(raw: unknown, chunk: number): ExtractedComponent | null {
  if (!isRecord(raw)) return null
  const name = cleanText(raw['name'], 200)
  if (name === null) return null
  const type = (cleanText(raw['type'], 24) ?? 'other').toLowerCase()
  return {
    name,
    type,
    dependsOn: cleanStringList(raw['depends_on'], 10, 200),
    confidence: cleanConfidence(raw['confidence']),
    evidence: cleanText(raw['evidence'], 300) ?? '',
    chunk
  }
}

/** Normalize a raw model preference item (phase-18: also `submit_extraction_items`). */
export function normalizePreference(raw: unknown, chunk: number): ExtractedPreference | null {
  if (!isRecord(raw)) return null
  const statement = cleanText(raw['statement'], 400)
  if (statement === null) return null
  return {
    statement,
    tags: cleanStringList(raw['tags'], 5, 40).map((t) => t.toLowerCase()),
    derivedFrom: cleanText(raw['derived_from'], 300),
    confidence: cleanConfidence(raw['confidence']),
    evidence: cleanText(raw['evidence'], 300) ?? '',
    chunk
  }
}

/** Normalize a raw model correction item (phase-18: also `submit_extraction_items`). */
export function normalizeCorrection(raw: unknown, chunk: number): ExtractedCorrection | null {
  if (!isRecord(raw)) return null
  const content = cleanText(raw['content'], 400)
  if (content === null) return null
  return {
    content,
    skill: cleanText(raw['skill'], 100),
    confidence: cleanConfidence(raw['confidence']),
    evidence: cleanText(raw['evidence'], 300) ?? '',
    chunk
  }
}

// ── Submission read-back (phase-18: runner_submissions → typed items) ─────────

/** A non-negative integer chunk index from a stored submission payload. */
const cleanChunk = (value: unknown): number => {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 0
  return Math.max(0, Math.trunc(value))
}

/**
 * Rebuild an `ExtractedComponent` from a `runner_submissions` payload — the
 * ALREADY-normalized (camelCase) `ExtractedComponent` JSON the delegate reads
 * back. Defensive (a corrupt row must never crash the delegate workflow):
 * missing fields default, confidence clamps, garbage → null (dropped).
 */
export function componentFromSubmission(value: unknown): ExtractedComponent | null {
  if (!isRecord(value)) return null
  const name = cleanText(value['name'], 200)
  if (name === null) return null
  return {
    name,
    type: (cleanText(value['type'], 24) ?? 'other').toLowerCase(),
    dependsOn: cleanStringList(value['dependsOn'], 10, 200),
    confidence: cleanConfidence(value['confidence']),
    evidence: cleanText(value['evidence'], 300) ?? '',
    chunk: cleanChunk(value['chunk'])
  }
}

/** Rebuild an `ExtractedPreference` from a stored `runner_submissions` payload. */
export function preferenceFromSubmission(value: unknown): ExtractedPreference | null {
  if (!isRecord(value)) return null
  const statement = cleanText(value['statement'], 400)
  if (statement === null) return null
  return {
    statement,
    tags: cleanStringList(value['tags'], 5, 40).map((t) => t.toLowerCase()),
    derivedFrom: cleanText(value['derivedFrom'], 300),
    confidence: cleanConfidence(value['confidence']),
    evidence: cleanText(value['evidence'], 300) ?? '',
    chunk: cleanChunk(value['chunk'])
  }
}

/** Rebuild an `ExtractedCorrection` from a stored `runner_submissions` payload. */
export function correctionFromSubmission(value: unknown): ExtractedCorrection | null {
  if (!isRecord(value)) return null
  const content = cleanText(value['content'], 400)
  if (content === null) return null
  return {
    content,
    skill: cleanText(value['skill'], 100),
    confidence: cleanConfidence(value['confidence']),
    evidence: cleanText(value['evidence'], 300) ?? '',
    chunk: cleanChunk(value['chunk'])
  }
}

// ── Transcript chunking (message-line packing, estimator-budgeted) ───────────

export function chunkTranscript(text: string, targetTokens: number, counter: TokenCounter): string[] {
  const chunks: string[] = []
  let current: string[] = []
  let currentTokens = 0
  const flush = (): void => {
    if (current.length > 0) chunks.push(current.join('\n'))
    current = []
    currentTokens = 0
  }
  for (const piece of text.split('\n')) {
    // A single pathological line larger than the whole budget hard-splits.
    // The joining newline is billed with its line so a packed chunk's total
    // estimate can never exceed the target.
    const lineTokens = counter.count(`${piece}\n`)
    if (lineTokens > targetTokens) {
      flush()
      const charBudget = Math.max(64, targetTokens * 3)
      for (let i = 0; i < piece.length; i += charBudget) {
        chunks.push(piece.slice(i, i + charBudget))
      }
      continue
    }
    if (currentTokens + lineTokens > targetTokens) flush()
    current.push(piece)
    currentTokens += lineTokens
  }
  flush()
  return chunks.length === 0 ? [] : chunks
}

// ── Pass execution over one tier ─────────────────────────────────────────────

/** Produces one reply per (pass, chunk); local and cloud tiers both fit it. */
type PassCaller = (pass: FuzzyPassName, prompt: string, system: string) => Promise<string>

interface TierRun {
  components: ExtractedComponent[]
  preferences: ExtractedPreference[]
  corrections: ExtractedCorrection[]
  callScores: number[]
  /** Calls whose model invocation itself threw (daemon down, budget halt…). */
  failedCalls: number
  totalCalls: number
  warnings: string[]
}

interface RawPassItems {
  components: ExtractedComponent[]
  preferences: ExtractedPreference[]
  corrections: ExtractedCorrection[]
}

function parsePassReply(pass: FuzzyPassName, reply: string, chunk: number, into: RawPassItems): number {
  const parsed = extractItemsReply(reply)
  if (parsed === null) return 0 // the model failed the task — zero-confidence call
  if (parsed.length === 0) return 1 // a confident, well-formed "nothing here"
  const capped = parsed.slice(0, EXTRACTION_MAX_ITEMS_PER_PASS)
  const confidences: number[] = []
  for (const raw of capped) {
    if (pass === 'components') {
      const item = normalizeComponent(raw, chunk)
      if (item) {
        into.components.push(item)
        confidences.push(item.confidence)
      }
    } else if (pass === 'preferences') {
      const item = normalizePreference(raw, chunk)
      if (item) {
        into.preferences.push(item)
        confidences.push(item.confidence)
      }
    } else {
      const item = normalizeCorrection(raw, chunk)
      if (item) {
        into.corrections.push(item)
        confidences.push(item.confidence)
      }
    }
  }
  if (confidences.length === 0) return 0 // items were attempted but all malformed
  return confidences.reduce((a, b) => a + b, 0) / confidences.length
}

async function runPasses(caller: PassCaller, chunks: readonly string[], tierName: string): Promise<TierRun> {
  const run: TierRun = {
    components: [],
    preferences: [],
    corrections: [],
    callScores: [],
    failedCalls: 0,
    totalCalls: 0,
    warnings: []
  }
  const raw: RawPassItems = { components: [], preferences: [], corrections: [] }
  const passes: FuzzyPassName[] = ['components', 'preferences', 'corrections']
  for (const [chunkIndex, chunk] of chunks.entries()) {
    for (const pass of passes) {
      run.totalCalls += 1
      let reply: string
      try {
        reply = await caller(pass, PASS_PROMPTS[pass](chunk), FUZZY_SYSTEM_PROMPTS[pass])
      } catch (err) {
        run.failedCalls += 1
        run.callScores.push(0)
        run.warnings.push(
          `${tierName} ${pass} pass failed on chunk ${chunkIndex + 1}/${chunks.length}: ${
            err instanceof Error ? err.message : String(err)
          }`
        )
        continue
      }
      run.callScores.push(parsePassReply(pass, reply, chunkIndex, raw))
    }
  }
  run.components = dedupeBy(raw.components, (c) => normalizeItemText(c.name), mergeComponents)
  run.preferences = dedupeBy(raw.preferences, (p) => normalizeItemText(p.statement), mergePreferences)
  run.corrections = dedupeBy(raw.corrections, (c) => normalizeItemText(c.content), mergeCorrections)
  return run
}

function dedupeBy<T>(items: readonly T[], keyOf: (item: T) => string, merge: (a: T, b: T) => T): T[] {
  const byKey = new Map<string, T>()
  for (const item of items) {
    const key = keyOf(item)
    const existing = byKey.get(key)
    byKey.set(key, existing === undefined ? item : merge(existing, item))
  }
  return [...byKey.values()]
}

const mergeComponents = (a: ExtractedComponent, b: ExtractedComponent): ExtractedComponent => ({
  ...a,
  dependsOn: [...new Set([...a.dependsOn, ...b.dependsOn])],
  confidence: Math.max(a.confidence, b.confidence)
})

const mergePreferences = (a: ExtractedPreference, b: ExtractedPreference): ExtractedPreference => ({
  ...a,
  tags: [...new Set([...a.tags, ...b.tags])],
  derivedFrom: a.derivedFrom ?? b.derivedFrom,
  confidence: Math.max(a.confidence, b.confidence)
})

const mergeCorrections = (a: ExtractedCorrection, b: ExtractedCorrection): ExtractedCorrection => ({
  ...a,
  skill: a.skill ?? b.skill,
  confidence: Math.max(a.confidence, b.confidence)
})

const mean = (values: readonly number[]): number | null =>
  values.length === 0 ? null : values.reduce((a, b) => a + b, 0) / values.length

// ── Entry point ──────────────────────────────────────────────────────────────

/**
 * Extraction mode (phase-18). `'two-tier'` (the default, DEFAULT == TODAY) is
 * today's local-first fuzzy passes + the two §20 cloud-escalation gates.
 * `'subscription'` is the §2.2 SINGLE tier: the big-context subscription Claude
 * IS the primary reasoning tier, so there is nothing smaller to escalate FROM —
 * Gate A/B become no-ops, chunks grow to `EXTRACTION_SUBSCRIPTION_CHUNK_TOKENS`
 * (30k) and the pass cap to `EXTRACTION_SUBSCRIPTION_PASS_MAX_TOKENS` (2k). The
 * agent decides the mode once per run from
 * `router.resolve('extraction.fuzzy').backend`.
 */
export type ExtractionMode = 'two-tier' | 'subscription'

export interface FuzzyExtractionOptions {
  readonly llm: ExtractionLlm
  /** Cloud tier + the job's task id for §14 metered spend; null = not configured. */
  readonly cloud?: (ExtractionCloud & { readonly taskId: string }) | null
  readonly transcript: TranscriptDigest | null
  /** Injectable for tests; defaults to the conservative estimating counter. */
  readonly counter?: TokenCounter
  /** Extraction mode (phase-18); absent → `'two-tier'` (today, unchanged). */
  readonly mode?: ExtractionMode
}

export async function runFuzzyExtraction(options: FuzzyExtractionOptions): Promise<FuzzyExtractionState> {
  const counter = options.counter ?? estimatingTokenCounter()
  const transcript = options.transcript
  if (transcript === null || transcript.text.trim() === '') {
    return {
      tier: 'none',
      components: [],
      preferences: [],
      corrections: [],
      sessionConfidence: null,
      escalated: false,
      escalationReason: null,
      chunkTexts: [],
      warnings: transcript === null ? [] : ['transcript rendered no conversation text — fuzzy passes skipped']
    }
  }

  // ESCALATION-MODE branch (phase-18): the subscription tier is a SINGLE
  // big-context tier — run the fuzzy passes once over 30k chunks, no Gate A/B,
  // no cloud escalation (there is no smaller tier to escalate from). `options.llm`
  // is the router-bound `extraction.fuzzy` reasoner resolving to subscription-claude.
  if ((options.mode ?? 'two-tier') === 'subscription') {
    const subscriptionCaller: PassCaller = async (pass, prompt, system) => {
      const result = await options.llm.generate(prompt, {
        system,
        maxTokens: EXTRACTION_SUBSCRIPTION_PASS_MAX_TOKENS,
        temperature: 0,
        // The subscription backend has no constrained decoding; the router folds
        // the schema into the prompt as a shape instruction, so replies still
        // arrive as the `{"items": [...]}` shape `extractItemsReply` reads.
        format: FUZZY_PASS_SCHEMAS[pass]
      })
      return result.text
    }
    const subscriptionChunks = chunkTranscript(transcript.text, EXTRACTION_SUBSCRIPTION_CHUNK_TOKENS, counter)
    const run = await runPasses(subscriptionCaller, subscriptionChunks, 'subscription')
    // P0.1 (MCP-COVERAGE §9.5): every subscription call threw — the run learned
    // NOTHING; throw the ordinary retryable error rather than tombstone the
    // session as extracted-empty (the queue's §20 round re-attempts).
    if (run.totalCalls > 0 && run.failedCalls === run.totalCalls) {
      throw new ExtractionUnavailableError(
        `extraction: all ${run.totalCalls} subscription fuzzy-pass calls failed — ` +
          'no model tier produced output; retry later instead of committing an empty extraction'
      )
    }
    return {
      tier: 'subscription',
      components: run.components,
      preferences: run.preferences,
      corrections: run.corrections,
      sessionConfidence: mean(run.callScores),
      escalated: false,
      escalationReason: null,
      chunkTexts: subscriptionChunks,
      warnings: run.warnings
    }
  }

  const cloud = options.cloud ?? null
  const localCaller: PassCaller = async (pass, prompt, system) => {
    const result = await options.llm.generate(prompt, {
      system,
      maxTokens: EXTRACTION_PASS_MAX_TOKENS,
      temperature: 0,
      // Constrained decoding: without it the local model narrates through its
      // entire output budget and never reaches the JSON (probed live).
      format: FUZZY_PASS_SCHEMAS[pass]
    })
    return result.text
  }
  const cloudCaller: PassCaller | null =
    cloud === null
      ? null
      : async (_pass, prompt, system) => {
          const completion = await meteredComplete(cloud.brain, cloud.meter, cloud.taskId, [{ role: 'user', content: prompt }], {
            system,
            maxTokens: EXTRACTION_PASS_MAX_TOKENS
          })
          return completion.text
        }

  const warnings: string[] = []
  const oversized = transcript.tokenEstimate > EXTRACTION_ESCALATE_TRANSCRIPT_TOKENS

  // Gate A (§20): an oversized session escalates wholesale — the local window
  // would need dozens of passes over content the cloud reads in one.
  if (oversized && cloudCaller !== null) {
    const cloudChunks = chunkTranscript(transcript.text, EXTRACTION_CLOUD_CHUNK_TOKENS, counter)
    const cloudRun = await runPasses(cloudCaller, cloudChunks, 'cloud')
    warnings.push(...cloudRun.warnings)
    if (cloudRun.failedCalls < cloudRun.totalCalls) {
      return {
        tier: 'cloud',
        components: cloudRun.components,
        preferences: cloudRun.preferences,
        corrections: cloudRun.corrections,
        sessionConfidence: null, // local never ran; the size gate escalated
        escalated: true,
        escalationReason: 'transcript-tokens',
        chunkTexts: [],
        warnings
      }
    }
    warnings.push('cloud escalation failed on every call — falling back to the local tier')
  } else if (oversized) {
    warnings.push(
      `transcript is ~${transcript.tokenEstimate} tokens (> ${EXTRACTION_ESCALATE_TRANSCRIPT_TOKENS}) but no cloud tier is configured — extracting locally in chunks`
    )
  }

  const localChunks = chunkTranscript(transcript.text, EXTRACTION_LOCAL_CHUNK_TOKENS, counter)
  const localRun = await runPasses(localCaller, localChunks, 'local')
  warnings.push(...localRun.warnings)
  const sessionConfidence = mean(localRun.callScores)

  // Gate B (§20): low aggregate local confidence escalates the whole session.
  if (sessionConfidence !== null && sessionConfidence < EXTRACTION_ESCALATE_CONFIDENCE) {
    if (cloudCaller !== null) {
      const cloudChunks = chunkTranscript(transcript.text, EXTRACTION_CLOUD_CHUNK_TOKENS, counter)
      const cloudRun = await runPasses(cloudCaller, cloudChunks, 'cloud')
      warnings.push(...cloudRun.warnings)
      if (cloudRun.failedCalls < cloudRun.totalCalls) {
        return {
          tier: 'cloud',
          components: cloudRun.components,
          preferences: cloudRun.preferences,
          corrections: cloudRun.corrections,
          sessionConfidence,
          escalated: true,
          escalationReason: 'low-local-confidence',
          chunkTexts: [],
          warnings
        }
      }
      warnings.push('cloud escalation failed on every call — keeping the local extraction')
    } else {
      warnings.push(
        `local extraction confidence ${sessionConfidence.toFixed(2)} < ${EXTRACTION_ESCALATE_CONFIDENCE} and no cloud tier is configured — low-confidence items will be staged for review`
      )
    }
  }

  // P0.1 (MCP-COVERAGE §9.5, phase 14): every local call threw — the run
  // learned NOTHING, and returning the empty local state would let the
  // workflow flip the exactly-once `extract-<sessionId>` task to 'done',
  // silently tombstoning the session as extracted forever. Throw an ordinary
  // retryable error instead so the §20 retry/defer machinery re-attempts.
  // Placement is load-bearing: this sits AFTER both escalation gates, so a
  // cloud rescue that produced output already returned above (tier 'cloud')
  // and is never killed — only the no-cloud and cloud-also-all-failed paths
  // reach here. The empty-transcript path (totalCalls === 0 — nothing was
  // ever asked of a model) returned tier 'none' long before this point and
  // still skips quietly.
  if (localRun.totalCalls > 0 && localRun.failedCalls === localRun.totalCalls) {
    throw new ExtractionUnavailableError(
      `extraction: all ${localRun.totalCalls} local fuzzy-pass calls failed` +
        (cloudCaller !== null
          ? ' and the cloud escalation failed on every call'
          : ' and no cloud tier is configured') +
        ' — no model tier produced output; retry later instead of committing an empty extraction'
    )
  }

  return {
    tier: 'local',
    components: localRun.components,
    preferences: localRun.preferences,
    corrections: localRun.corrections,
    sessionConfidence,
    escalated: false,
    escalationReason: null,
    chunkTexts: localChunks,
    warnings
  }
}
