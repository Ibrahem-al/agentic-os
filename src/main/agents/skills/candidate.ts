/**
 * Candidate step (§17 step 2, phase 12): "the cloud brain rewrites the
 * skill's instructions from recent failures → a new SkillVersion (status
 * candidate)". The rewrite prompt reimplements the vendored skill-creator
 * guidance (SKILL.md "Improving the skill" + "Writing Style"): generalize
 * from feedback instead of overfitting, keep the prompt lean, explain the
 * why, imperative form. The reply must be a COMPLETE SKILL.md file — it is
 * validated against the reference's frontmatter rules and retried once with
 * the exact validation error before the skill is skipped.
 *
 * The rewriter sees the corrections and failure examples, NEVER the test
 * cases — held-out cases stay unseen, which is what makes scoring by
 * held-out mean something.
 */
import { createHash } from 'node:crypto'
import { SKILL_REWRITE_MAX_TOKENS } from '../../config'
import { candidateVersionIdOf } from './lifecycle'
import { parseSkillMd, SkillMdError } from './skillmd'
import type { SkillCandidate, SkillCloudCall, SkillWorkItem } from './types'

export const REWRITE_SYSTEM_PROMPT =
  'You improve Claude Code skills. A skill is a SKILL.md file: YAML frontmatter (name, description) ' +
  'followed by markdown instructions. You rewrite the instructions so the skill stops drawing the corrections ' +
  'users filed against it — while staying general: generalize from the feedback to the underlying principle, ' +
  'do not bolt on a list of one-off rules. Keep the prompt lean (remove things not pulling their weight), ' +
  'prefer the imperative form, and explain the why behind important steps instead of bare MUSTs. ' +
  'Reply with ONLY the complete new SKILL.md file content, starting with the opening --- fence.'

export function buildRewritePrompt(item: SkillWorkItem, skillMd: string, expectedName: string): string {
  const corrections = item.corrections.map((c) => `- ${c.content}`).join('\n')
  const failures = item.failureExamples.map((e) => `- ${e.content}`).join('\n')
  return (
    `Current skill file:\n<skill>\n${skillMd}\n</skill>\n\n` +
    `User corrections this skill has drawn (the rewrite must make each of these unnecessary):\n${corrections || '(none)'}\n\n` +
    `Recent failure examples:\n${failures || '(none)'}\n\n` +
    `Rewrite the skill. Hard requirements:\n` +
    `- frontmatter 'name:' stays EXACTLY '${expectedName}'\n` +
    `- 'description:' stays under 1024 characters with no angle brackets\n` +
    `- the instructions must make every listed correction unnecessary without overfitting to its wording\n` +
    `- keep everything that already works\n\n` +
    `Reply with ONLY the complete SKILL.md file content.`
  )
}

/** Pull the SKILL.md out of a reply that may carry fences or preamble. */
export function extractSkillMdReply(text: string): string {
  let body = text.trim()
  // Strip a wrapping markdown code fence if present.
  const fenceMatch = /^```[a-zA-Z]*\n([\s\S]*?)\n```\s*$/.exec(body)
  if (fenceMatch !== undefined && fenceMatch !== null && fenceMatch[1] !== undefined) body = fenceMatch[1]
  // Drop any preamble before the first frontmatter fence line.
  const lines = body.split('\n')
  const fenceIdx = lines.findIndex((line) => line.trim() === '---')
  if (fenceIdx > 0) body = lines.slice(fenceIdx).join('\n')
  return body
}

export interface GenerateCandidateOptions {
  readonly item: SkillWorkItem
  /** Baseline instructions in SKILL.md form (what the model rewrites). */
  readonly skillMd: string
  /** The frontmatter name the candidate must keep. */
  readonly expectedName: string
  /**
   * Role-bound `skills.rewrite` cloud completion (the router path or today's
   * metered cloud). The agent only calls this step once the role resolves to a
   * cloud/subscription tier, so it is always present here.
   */
  readonly cloud: SkillCloudCall
}

/**
 * One rewrite (+ one retry carrying the exact validation error). Returns a
 * candidate with `error` set instead of throwing on model failure — the run
 * continues with the other skills.
 */
export async function generateCandidate(options: GenerateCandidateOptions): Promise<SkillCandidate> {
  const basePrompt = buildRewritePrompt(options.item, options.skillMd, options.expectedName)
  let lastError = ''
  for (let attempt = 0; attempt < 2; attempt++) {
    const prompt =
      attempt === 0
        ? basePrompt
        : `${basePrompt}\n\nYour previous reply was rejected: ${lastError}\nFix that and reply with only the complete SKILL.md file content.`
    let text: string
    try {
      const completion = await options.cloud({ prompt, system: REWRITE_SYSTEM_PROMPT, maxTokens: SKILL_REWRITE_MAX_TOKENS })
      text = completion.text
    } catch (err) {
      return {
        skillId: options.item.skillId,
        candidateVersionId: '',
        instructions: '',
        error: `candidate rewrite failed: ${err instanceof Error ? err.message : String(err)}`
      }
    }
    const candidateMd = extractSkillMdReply(text)
    try {
      const parsed = parseSkillMd(candidateMd)
      if (parsed.name !== options.expectedName) {
        lastError = `frontmatter name '${parsed.name}' must stay exactly '${options.expectedName}'`
        continue
      }
      if (normalizeMd(candidateMd) === normalizeMd(options.skillMd)) {
        lastError = 'the reply is identical to the current skill — the corrections require actual changes'
        continue
      }
      return {
        skillId: options.item.skillId,
        candidateVersionId: candidateVersionIdOf(options.item.skillId, candidateMd),
        instructions: candidateMd,
        error: null
      }
    } catch (err) {
      lastError = err instanceof SkillMdError ? err.message : String(err)
    }
  }
  return {
    skillId: options.item.skillId,
    candidateVersionId: '',
    instructions: '',
    error: `candidate rewrite produced an invalid SKILL.md twice — last error: ${lastError}`
  }
}

/**
 * Line-ending-normalized comparison form (the "did the candidate actually
 * change?" check). Exported so `propose_skill_revision` (the MCP tool) applies
 * the SAME differs-from-active rule at the boundary that this step applies.
 */
export const normalizeMd = (text: string): string => text.replace(/\r\n/g, '\n').trim()

/** Content-hash helper shared with tests (stable candidate identity). */
export function instructionsHash(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 8)
}

// ── Provided candidate (phase-18: propose_skill_revision) ────────────────────

/**
 * A SKILL.md revision an external Claude proposed via `propose_skill_revision`
 * (staged through `queue.enqueue`, carried in the task payload). The candidate
 * step uses it INSTEAD of the cloud rewrite LLM — but it still rides the full
 * benchmark + §17 adoption gate below, so a provided candidate NEVER
 * self-certifies. `skillId` scopes it to one work item; `versionId` is the
 * caller's claim, recomputed from the content here (never trusted).
 */
export interface ProvidedCandidate {
  readonly skillId: string
  readonly versionId: string
  readonly instructions: string
  readonly proposedBy: string
}

export interface UseProvidedCandidateOptions {
  readonly item: SkillWorkItem
  /** Baseline instructions in SKILL.md form (what the revision must differ from). */
  readonly skillMd: string
  /** The frontmatter name the candidate must keep. */
  readonly expectedName: string
  readonly provided: ProvidedCandidate
}

/**
 * Validate a client-provided SKILL.md candidate the SAME way `generateCandidate`
 * validates the rewrite LLM's reply (parse, name must match the baseline, must
 * differ), recomputing the version id from the content. Returns a candidate
 * with `error` set instead of throwing, so the run continues + the write step
 * records a `failed-candidate` outcome honestly.
 */
export function useProvidedCandidate(options: UseProvidedCandidateOptions): SkillCandidate {
  const { item, skillMd, expectedName, provided } = options
  const fail = (error: string): SkillCandidate => ({
    skillId: item.skillId,
    candidateVersionId: '',
    instructions: '',
    error
  })
  let parsed
  try {
    parsed = parseSkillMd(provided.instructions)
  } catch (err) {
    return fail(`provided candidate is not a valid SKILL.md: ${err instanceof SkillMdError ? err.message : String(err)}`)
  }
  if (parsed.name !== expectedName) {
    return fail(`provided candidate frontmatter name '${parsed.name}' must stay exactly '${expectedName}'`)
  }
  if (normalizeMd(provided.instructions) === normalizeMd(skillMd)) {
    return fail('provided candidate is identical to the current skill — a revision must differ')
  }
  return {
    skillId: item.skillId,
    // Recompute the identity from the content (the caller's versionId is a claim).
    candidateVersionId: candidateVersionIdOf(item.skillId, provided.instructions),
    instructions: provided.instructions,
    error: null
  }
}

/**
 * Decode the `providedCandidate` sub-object from a skill-improvement task payload
 * (`{ skillId, providedCandidate: { versionId, instructions, proposedBy } }`),
 * folding in the top-level skillId. Returns undefined when absent/malformed so
 * the run falls back to the normal cloud-rewrite path.
 */
export function decodeProvidedCandidate(skillId: string, raw: unknown): ProvidedCandidate | undefined {
  if (skillId === '' || raw === null || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const r = raw as Record<string, unknown>
  const instructions = typeof r['instructions'] === 'string' ? r['instructions'] : ''
  if (instructions === '') return undefined
  return {
    skillId,
    versionId: typeof r['versionId'] === 'string' ? r['versionId'] : '',
    instructions,
    proposedBy: typeof r['proposedBy'] === 'string' ? r['proposedBy'] : ''
  }
}
