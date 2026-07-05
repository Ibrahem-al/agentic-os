/**
 * Test-set step (§17 step 1, phase 12): "Turn that skill's past Corrections
 * into regression cases ('given this situation, does the skill now avoid the
 * corrected mistake?'), optionally topped up with a few synthetic cases for
 * coverage" — synthetic padding is the cloud brain's job (phase doc), the
 * correction→case mapping is deterministic (id-linked, so the zero-regression
 * gate can name the correction a candidate broke).
 *
 * Split (reimplemented from skill-creator's run_loop.py split_eval_set):
 * stratified by case source, shuffled with a PRNG seeded from the skill id
 * (stable across runs — resume and re-benchmark see the same split), held-out
 * fraction 0.4 with at least one held-out case per non-empty group. Scores
 * come from held-out cases only ("score by held-out to avoid overfitting");
 * the regression gate reads correction cases from BOTH splits.
 */
import { SKILL_CASE_GEN_MAX_TOKENS, SKILL_HOLDOUT_FRACTION, SKILL_MAX_CORRECTION_CASES, SKILL_SYNTHETIC_CASES } from '../../config'
import { meteredComplete } from '../../models'
import type { SkillCloud, SkillTestCase, SkillTestSet, SkillWorkItem } from './types'

// ── deterministic PRNG (split stability without Math.random) ────────────────

function fnv1a(text: string): number {
  let hash = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash >>> 0
}

/** mulberry32 — tiny, deterministic, good enough for split shuffles. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function shuffled<T>(items: readonly T[], rand: () => number): T[] {
  const out = [...items]
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1))
    const tmp = out[i]!
    out[i] = out[j]!
    out[j] = tmp
  }
  return out
}

/**
 * Assign train/held-out per group (skill-creator semantics: per-group shuffle,
 * n_test = max(1, floor(len * holdout))). Exported for the unit suite.
 */
export function assignSplits(cases: readonly Omit<SkillTestCase, 'split'>[], seedKey: string): SkillTestCase[] {
  const rand = mulberry32(fnv1a(seedKey))
  const bySource = new Map<string, Omit<SkillTestCase, 'split'>[]>()
  for (const testCase of cases) {
    const group = bySource.get(testCase.source) ?? []
    group.push(testCase)
    bySource.set(testCase.source, group)
  }
  const heldoutIds = new Set<string>()
  for (const group of bySource.values()) {
    const count = Math.max(1, Math.floor(group.length * SKILL_HOLDOUT_FRACTION))
    for (const testCase of shuffled(group, rand).slice(0, count)) heldoutIds.add(testCase.id)
  }
  return cases.map((testCase) => ({ ...testCase, split: heldoutIds.has(testCase.id) ? 'heldout' : 'train' }))
}

// ── deterministic correction → regression case ───────────────────────────────

/**
 * The generic execution scenario both configurations answer. Deliberately
 * neutral: quoting the correction in the PROMPT would hand the answer to both
 * configurations and flatten the delta — the correction lives in the graded
 * expectation instead.
 */
export function correctionCasePrompt(skillName: string): string {
  return (
    `A user invokes the skill '${skillName}' for a typical task it covers. ` +
    `Walk through exactly how you carry the task out, step by step — be concrete about what you do, ` +
    `what you check, and in what order.`
  )
}

export function correctionCaseExpectation(correctionContent: string): string {
  return (
    `The walkthrough complies with this user correction: "${correctionContent}" — ` +
    `the corrected mistake does not appear, and the corrected behavior does.`
  )
}

export function buildCorrectionCases(item: SkillWorkItem): Omit<SkillTestCase, 'split'>[] {
  // Most recent first (§17 "past Corrections"; the cap bounds benchmark cost).
  return item.corrections.slice(0, SKILL_MAX_CORRECTION_CASES).map((correction) => ({
    id: `case-corr-${correction.id}`,
    source: 'correction' as const,
    correctionId: correction.id,
    prompt: correctionCasePrompt(item.skillName),
    expectations: [correctionCaseExpectation(correction.content)]
  }))
}

// ── cloud synthetic padding ──────────────────────────────────────────────────

export const CASE_GEN_SYSTEM_MARKER = 'You design test cases for an agent skill.'

export function buildCaseGenPrompt(item: SkillWorkItem, skillMd: string): string {
  const corrections = item.corrections.map((c) => `- ${c.content}`).join('\n')
  return (
    `${CASE_GEN_SYSTEM_MARKER}\n\n` +
    `The skill under test:\n<skill>\n${skillMd}\n</skill>\n\n` +
    `Past user corrections of this skill (regression cases already cover these):\n${corrections || '(none)'}\n\n` +
    `Design exactly ${SKILL_SYNTHETIC_CASES} additional test cases for COVERAGE — realistic situations a user ` +
    `would bring to this skill, exercising parts of the instructions the corrections do not touch. ` +
    `Each case needs a concrete task prompt and 1-2 objectively checkable expectations about the response ` +
    `(what a correct execution must contain or avoid). Good assertions are discriminating: they pass when the ` +
    `skill genuinely succeeds and fail when it does not.\n\n` +
    `Reply with ONLY a JSON array, no other text:\n` +
    `[{"prompt": "...", "expectations": ["...", "..."]}]`
  )
}

/** Tolerant JSON-array rescue (narration-tolerant, string-aware scanning). */
export function extractCaseArray(text: string): { prompt: string; expectations: string[] }[] {
  const start = text.indexOf('[')
  if (start === -1) return []
  // Walk to the matching close bracket, string-aware.
  let depth = 0
  let inString = false
  let escaped = false
  let end = -1
  for (let i = start; i < text.length; i++) {
    const ch = text[i]
    if (inString) {
      if (escaped) escaped = false
      else if (ch === '\\') escaped = true
      else if (ch === '"') inString = false
      continue
    }
    if (ch === '"') inString = true
    else if (ch === '[') depth += 1
    else if (ch === ']') {
      depth -= 1
      if (depth === 0) {
        end = i
        break
      }
    }
  }
  if (end === -1) return []
  let parsed: unknown
  try {
    parsed = JSON.parse(text.slice(start, end + 1))
  } catch {
    return []
  }
  if (!Array.isArray(parsed)) return []
  const cases: { prompt: string; expectations: string[] }[] = []
  for (const entry of parsed) {
    if (entry === null || typeof entry !== 'object') continue
    const prompt = (entry as { prompt?: unknown }).prompt
    const expectations = (entry as { expectations?: unknown }).expectations
    if (typeof prompt !== 'string' || prompt.trim() === '') continue
    const cleaned = Array.isArray(expectations)
      ? expectations.filter((e): e is string => typeof e === 'string' && e.trim() !== '')
      : []
    if (cleaned.length === 0) continue
    cases.push({ prompt: prompt.trim(), expectations: cleaned.slice(0, 2) })
  }
  return cases.slice(0, SKILL_SYNTHETIC_CASES)
}

// ── the step ─────────────────────────────────────────────────────────────────

export interface BuildTestSetOptions {
  readonly item: SkillWorkItem
  /** The baseline instructions in SKILL.md form (context for the case designer). */
  readonly skillMd: string
  readonly cloud: (SkillCloud & { taskId: string }) | null
}

export async function buildTestSet(options: BuildTestSetOptions): Promise<SkillTestSet> {
  const warnings: string[] = []
  const cases: Omit<SkillTestCase, 'split'>[] = buildCorrectionCases(options.item)
  if (options.item.corrections.length > SKILL_MAX_CORRECTION_CASES) {
    warnings.push(
      `${options.item.skillId}: ${options.item.corrections.length} corrections, benchmarking the ${SKILL_MAX_CORRECTION_CASES} most recent`
    )
  }

  if (options.cloud !== null) {
    try {
      const completion = await meteredComplete(
        options.cloud.brain,
        options.cloud.meter,
        options.cloud.taskId,
        [{ role: 'user', content: buildCaseGenPrompt(options.item, options.skillMd) }],
        { maxTokens: SKILL_CASE_GEN_MAX_TOKENS }
      )
      const synthetic = extractCaseArray(completion.text)
      if (synthetic.length === 0) {
        warnings.push(`${options.item.skillId}: synthetic case reply was unparseable — benchmarking on correction cases only`)
      }
      synthetic.forEach((entry, index) => {
        cases.push({
          id: `case-syn-${options.item.skillId}-${index}`,
          source: 'synthetic',
          correctionId: null,
          prompt: entry.prompt,
          expectations: entry.expectations
        })
      })
    } catch (err) {
      warnings.push(
        `${options.item.skillId}: synthetic case generation failed (${err instanceof Error ? err.message : String(err)}) — benchmarking on correction cases only`
      )
    }
  } else {
    warnings.push(`${options.item.skillId}: no cloud tier — no synthetic padding`)
  }

  return { skillId: options.item.skillId, cases: assignSplits(cases, options.item.skillId), warnings }
}
