/**
 * The §15 evaluation side of the self-correcting loop.
 *
 * The critic uses a SEPARATE prompt and the LOCAL tier (the small Ollama LLM,
 * thinking off) — never the cloud brain and never the prompt that produced the
 * content — to reduce self-judging bias. It scores the assembled bundle
 * against a fixed rubric; a failing score feeds the (also local) query
 * rewriter.
 */
import { RETRIEVAL_CRITIC_MAX_TOKENS, RETRIEVAL_REWRITE_MAX_TOKENS } from '../config'
import type { AssembledBundle, SmallLlm } from './types'

export interface CriticVerdict {
  /** Normalized rubric score, 0..1. */
  readonly score: number
  /** The critic's stated gap — fed to the query rewriter. */
  readonly feedback: string
}

/** Keep local-LLM prompts small: cap each bundle item's text in the prompt. */
const ITEM_TEXT_CAP = 400

function renderBundleForPrompt(bundle: AssembledBundle): string {
  const lines: string[] = []
  const all = [...bundle.globalPreferences, ...bundle.items]
  if (all.length === 0) return '(the bundle is empty — nothing was retrieved)'
  for (const [i, item] of all.entries()) {
    const text = item.text.length > ITEM_TEXT_CAP ? `${item.text.slice(0, ITEM_TEXT_CAP)}…` : item.text
    lines.push(`${i + 1}. [${item.label}] ${text}`)
  }
  return lines.join('\n')
}

const CRITIC_SYSTEM =
  'You are a strict retrieval judge. You score how well a retrieved context bundle prepares an agent ' +
  'to perform a task. Rubric: (a) relevance — items relate directly to the task; (b) coverage — the ' +
  'projects, skills, preferences and knowledge the task implies are present; (c) specificity — items ' +
  'carry actionable detail, not generic filler. Respond with ONLY a JSON object, no other text.'

/** Score `bundle` against the rubric with the local critic. */
export async function scoreBundle(llm: SmallLlm, task: string, bundle: AssembledBundle): Promise<CriticVerdict> {
  const prompt =
    `Task the agent must perform:\n${task}\n\n` +
    `Retrieved context bundle:\n${renderBundleForPrompt(bundle)}\n\n` +
    'Score the bundle against the rubric. Respond with ONLY this JSON shape:\n' +
    '{"score": <integer 0-10>, "missing": "<one short sentence naming the most important gap, or \'none\'>"}'
  const result = await llm.generate(prompt, {
    system: CRITIC_SYSTEM,
    maxTokens: RETRIEVAL_CRITIC_MAX_TOKENS,
    temperature: 0
  })
  return parseCriticVerdict(result.text)
}

/**
 * Parse the critic's reply. Local small models occasionally wrap or mangle the
 * JSON; parsing degrades gracefully — an unusable reply scores 0 (the loop
 * keeps iterating and the bundle keeps its best-effort flag) rather than
 * throwing away a retrieval on a critic formatting hiccup.
 */
export function parseCriticVerdict(text: string): CriticVerdict {
  const jsonMatch = /\{[\s\S]*?\}/.exec(text)
  if (jsonMatch) {
    try {
      const parsed = JSON.parse(jsonMatch[0]) as { score?: unknown; missing?: unknown }
      if (typeof parsed.score === 'number' && Number.isFinite(parsed.score)) {
        return {
          score: clamp01(parsed.score / 10),
          feedback: typeof parsed.missing === 'string' ? parsed.missing : ''
        }
      }
    } catch {
      // fall through to the bare-number salvage below
    }
  }
  const numberMatch = /-?\d+(\.\d+)?/.exec(text)
  if (numberMatch) {
    return { score: clamp01(Number(numberMatch[0]) / 10), feedback: '' }
  }
  return { score: 0, feedback: 'critic reply was unparseable' }
}

function clamp01(value: number): number {
  if (value < 0) return 0
  if (value > 1) return 1
  return value
}

const REWRITE_SYSTEM =
  'You rewrite search queries for a hybrid memory system holding projects, skills, preferences and ' +
  'knowledge notes. Reply with ONLY the rewritten query text on a single line — no quotes, no ' +
  'explanation.'

/**
 * Ask the local LLM for an improved query. Returns null when it produced
 * nothing usable (empty, or a repeat of a query already tried) — the loop
 * treats that as non-improvement and stops.
 */
export async function rewriteQuery(
  llm: SmallLlm,
  task: string,
  feedback: string,
  triedQueries: readonly string[]
): Promise<string | null> {
  const prompt =
    `Task the agent must perform:\n${task}\n\n` +
    `Queries already tried (retrieval was judged insufficient):\n` +
    triedQueries.map((q) => `- ${q}`).join('\n') +
    (feedback !== '' ? `\n\nJudge feedback on the last attempt: ${feedback}` : '') +
    '\n\nWrite ONE improved search query: keyword-rich, naming the concrete entities the task implies, ' +
    'and different from every query above.'
  const result = await llm.generate(prompt, {
    system: REWRITE_SYSTEM,
    maxTokens: RETRIEVAL_REWRITE_MAX_TOKENS,
    temperature: 0.7
  })
  const line =
    result.text
      .split('\n')
      .map((l) => l.trim().replace(/^["'`]+|["'`]+$/g, ''))
      .find((l) => l !== '') ?? ''
  if (line === '') return null
  const tried = new Set(triedQueries.map((q) => q.trim().toLowerCase()))
  if (tried.has(line.toLowerCase())) return null
  return line
}
