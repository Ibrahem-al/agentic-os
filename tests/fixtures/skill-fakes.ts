/**
 * Deterministic fakes for the phase-12 skill-improvement tests.
 *
 * ScriptedSkillLlm dispatches on the benchmark's stable system-prompt markers
 * (executor / grader — the extraction-fakes technique); the behaviors are
 * injected per test so the "model" is a pure function of its inputs. The
 * fake cloud brain satisfies the real CloudBrain interface (meteredComplete +
 * SpendMeter run for real) and dispatches on the rewrite / case-design /
 * comparator markers, keyed by the skill's frontmatter name where replies
 * differ per skill.
 */
import {
  CASE_GEN_SYSTEM_MARKER,
  COMPARATOR_SYSTEM_PROMPT,
  EXECUTOR_SYSTEM_MARKER,
  GRADER_SYSTEM_PROMPT,
  REWRITE_SYSTEM_PROMPT,
  type SkillLlm
} from '../../src/main/agents'
import type { ChatMessage, CloudBrain, CompleteOptions, Completion } from '../../src/main/models'

// ── Scripted local LLM (executor + grader) ───────────────────────────────────

export interface ScriptedSkillLlmBehavior {
  /** The case executor: (skill instructions, case prompt) → output text. */
  execute?: (instructions: string, prompt: string) => string
  /** The assertion grader: (expectation, output) → passed. */
  grade?: (expectation: string, output: string) => boolean
  /** Throw on the FIRST executor call only (crash simulation). */
  failExecuteOnce?: boolean
  /** Throw on EVERY executor call (proves a path never generated). */
  failExecute?: boolean
}

export class ScriptedSkillLlm implements SkillLlm {
  executorCalls = 0
  graderCalls = 0
  private failedOnce = false

  constructor(private readonly behavior: ScriptedSkillLlmBehavior = {}) {}

  async generate(prompt: string, options?: { system?: string }): Promise<{ text: string }> {
    const system = options?.system ?? ''
    if (system.startsWith(EXECUTOR_SYSTEM_MARKER)) {
      if (this.behavior.failExecute) throw new Error('scripted llm: executor deliberately down')
      if (this.behavior.failExecuteOnce && !this.failedOnce) {
        this.failedOnce = true
        throw new Error('scripted llm: executor deliberately failing once')
      }
      this.executorCalls += 1
      const instructions = /<skill_instructions>\n([\s\S]*)\n<\/skill_instructions>/.exec(system)?.[1] ?? ''
      const execute = this.behavior.execute ?? ((body: string): string => body)
      return { text: execute(instructions, prompt) }
    }
    if (system === GRADER_SYSTEM_PROMPT) {
      this.graderCalls += 1
      const output = /<output>\n([\s\S]*?)\n<\/output>/.exec(prompt)?.[1] ?? ''
      const expectation = /Expectation to evaluate:\n"([\s\S]*)"\n\nDoes the output/.exec(prompt)?.[1] ?? ''
      const grade = this.behavior.grade ?? ((exp: string, out: string): boolean => out.includes(exp))
      const passed = grade(expectation, output)
      return { text: JSON.stringify({ passed, evidence: passed ? 'found in output' : 'absent from output' }) }
    }
    throw new Error(`scripted skill llm: unrecognized system prompt: ${system.slice(0, 60)}`)
  }
}

// ── Fake cloud brain (rewrite + case design + blind comparator) ──────────────

export interface FakeSkillCloudReplies {
  /** SKILL.md rewrite replies keyed by frontmatter name; arrays consume in order. */
  rewriteByName?: Record<string, string | readonly string[]>
  /** Case-design replies (JSON array text) keyed by frontmatter name. */
  casesByName?: Record<string, string>
  /** The blind judge: (outputA, outputB) → letter verdict. */
  compare?: (outputA: string, outputB: string) => 'A' | 'B' | 'TIE'
}

export class FakeSkillCloudBrain implements CloudBrain {
  readonly provider = 'anthropic' as const
  readonly model = 'claude-fake-skill-cloud'
  readonly calls: { kind: 'rewrite' | 'cases' | 'compare'; prompt: string }[] = []
  private readonly rewriteCursor = new Map<string, number>()

  constructor(
    private readonly replies: FakeSkillCloudReplies = {},
    private readonly options: { failAll?: boolean } = {}
  ) {}

  async complete(messages: ChatMessage[], options?: CompleteOptions): Promise<Completion> {
    if (this.options.failAll) throw new Error('fake skill cloud: deliberately unavailable')
    const system = options?.system ?? ''
    const prompt = messages[messages.length - 1]?.content ?? ''
    const done = (kind: 'rewrite' | 'cases' | 'compare', text: string): Completion => {
      this.calls.push({ kind, prompt })
      return { text, model: this.model, usage: { inputTokens: 200, outputTokens: 80 }, stopReason: 'end_turn' }
    }
    const nameInPrompt = /\nname:\s*([a-z0-9-]+)/.exec(prompt)?.[1] ?? ''

    if (system === REWRITE_SYSTEM_PROMPT) {
      const scripted = this.replies.rewriteByName?.[nameInPrompt]
      if (scripted === undefined) throw new Error(`fake skill cloud: no rewrite scripted for '${nameInPrompt}'`)
      if (typeof scripted === 'string') return done('rewrite', scripted)
      const cursor = this.rewriteCursor.get(nameInPrompt) ?? 0
      const text = scripted[Math.min(cursor, scripted.length - 1)]
      this.rewriteCursor.set(nameInPrompt, cursor + 1)
      if (text === undefined) throw new Error(`fake skill cloud: rewrite replies exhausted for '${nameInPrompt}'`)
      return done('rewrite', text)
    }
    if (prompt.startsWith(CASE_GEN_SYSTEM_MARKER)) {
      return done('cases', this.replies.casesByName?.[nameInPrompt] ?? '[]')
    }
    if (system === COMPARATOR_SYSTEM_PROMPT) {
      const outputA = /<output_a>\n([\s\S]*?)\n<\/output_a>/.exec(prompt)?.[1] ?? ''
      const outputB = /<output_b>\n([\s\S]*?)\n<\/output_b>/.exec(prompt)?.[1] ?? ''
      const winner = (this.replies.compare ?? ((): 'TIE' => 'TIE'))(outputA, outputB)
      return done('compare', JSON.stringify({ winner, reasoning: 'scripted blind verdict' }))
    }
    throw new Error(`fake skill cloud: unrecognized call (system: ${system.slice(0, 50)})`)
  }
}

// ── SKILL.md builders ────────────────────────────────────────────────────────

/** A minimal valid SKILL.md with the given body (test candidate replies). */
export function skillMdOf(name: string, description: string, body: string): string {
  return `---\nname: ${name}\ndescription: ${description}\n---\n\n${body}`
}
