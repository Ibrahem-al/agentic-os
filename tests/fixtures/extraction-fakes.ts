/**
 * Deterministic fakes + builders for the phase-08 extraction tests.
 *
 * The scripted LLM dispatches on the extraction prompts' stable system-prompt
 * markers (same technique as ScriptedLlm for the retrieval critic); the fake
 * cloud brain satisfies the real CloudBrain interface so meteredComplete +
 * SpendMeter run for real against it. Transcript builders emit Claude Code
 * style JSONL records.
 */
import type BetterSqlite3 from 'better-sqlite3'
import type { ExtractionEmbedder, ExtractionLlm } from '../../src/main/agents'
import type { ChatMessage, CloudBrain, CompleteOptions, Completion } from '../../src/main/models'
import { fakeTextEmbedding } from './graph-seed'

// ── Scripted local LLM ───────────────────────────────────────────────────────

export interface ScriptedExtractionReplies {
  /** Reply text served for every components-pass call. */
  components?: string
  preferences?: string
  corrections?: string
  /** Tiebreak replies consumed in order (entity resolution judge). */
  tiebreaks?: string[]
}

export interface ScriptedExtractionOptions {
  /** Throw on any fuzzy-pass call (proves a path never ran the local tier). */
  failExtraction?: boolean
  /** Throw on tiebreak calls (exercises the tiebreak-unavailable path). */
  failTiebreak?: boolean
}

export class ScriptedExtractionLlm implements ExtractionLlm {
  readonly extractionCalls: { pass: 'components' | 'preferences' | 'corrections'; prompt: string }[] = []
  readonly tiebreakCalls: string[] = []
  private tiebreakIndex = 0

  constructor(
    private readonly replies: ScriptedExtractionReplies = {},
    private readonly options: ScriptedExtractionOptions = {}
  ) {}

  async generate(prompt: string, options?: { system?: string }): Promise<{ text: string }> {
    const system = options?.system ?? ''
    const pass = system.includes('extract software components')
      ? ('components' as const)
      : system.includes('extract user preferences')
        ? ('preferences' as const)
        : system.includes('extract explicit user corrections')
          ? ('corrections' as const)
          : null
    if (pass !== null) {
      if (this.options.failExtraction) throw new Error('scripted llm: extraction pass deliberately failing')
      this.extractionCalls.push({ pass, prompt })
      return { text: this.replies[pass] ?? '[]' }
    }
    if (system.includes('entity resolution judge')) {
      if (this.options.failTiebreak) throw new Error('scripted llm: tiebreak deliberately failing')
      this.tiebreakCalls.push(prompt)
      const reply = this.replies.tiebreaks?.[this.tiebreakIndex]
      this.tiebreakIndex += 1
      if (reply === undefined) throw new Error(`scripted llm: no tiebreak reply scripted for call ${this.tiebreakIndex}`)
      return { text: reply }
    }
    throw new Error(`scripted llm: unrecognized system prompt: ${system.slice(0, 80)}`)
  }
}

// ── Fake cloud brain (real CloudBrain interface — meteredComplete works) ─────

export interface FakeCloudReplies {
  components?: string
  preferences?: string
  corrections?: string
  /** Verifier replies consumed in order. */
  verifier?: string[]
}

export class FakeCloudBrain implements CloudBrain {
  readonly provider = 'anthropic' as const
  readonly model = 'claude-fake-cloud'
  readonly calls: { kind: string; system: string; prompt: string }[] = []
  private verifierIndex = 0

  constructor(
    private readonly replies: FakeCloudReplies = {},
    private readonly options: { failAll?: boolean } = {}
  ) {}

  async complete(messages: ChatMessage[], options?: CompleteOptions): Promise<Completion> {
    if (this.options.failAll) throw new Error('fake cloud brain: deliberately unavailable')
    const system = options?.system ?? ''
    const prompt = messages[messages.length - 1]?.content ?? ''
    const reply = (kind: string, text: string): Completion => {
      this.calls.push({ kind, system, prompt })
      return {
        text,
        model: this.model,
        usage: { inputTokens: 120, outputTokens: 60 },
        stopReason: 'end_turn'
      }
    }
    if (system.includes('extract software components')) return reply('components', this.replies.components ?? '[]')
    if (system.includes('extract user preferences')) return reply('preferences', this.replies.preferences ?? '[]')
    if (system.includes('extract explicit user corrections')) return reply('corrections', this.replies.corrections ?? '[]')
    if (system.includes('independent verification judge')) {
      const text = this.replies.verifier?.[this.verifierIndex]
      this.verifierIndex += 1
      if (text === undefined) throw new Error(`fake cloud brain: no verifier reply scripted for call ${this.verifierIndex}`)
      return reply('verifier', text)
    }
    throw new Error(`fake cloud brain: unrecognized system prompt: ${system.slice(0, 80)}`)
  }
}

// ── Embedders ────────────────────────────────────────────────────────────────

/** Same bag-of-words embedding as the fixture graph; counts calls. */
export class FakeExtractionEmbedder implements ExtractionEmbedder {
  calls = 0

  async embed(texts: string[]): Promise<number[][]> {
    this.calls += 1
    return texts.map((t) => fakeTextEmbedding(t))
  }
}

/** Throws on the first embed() call, healthy afterwards (crash simulation). */
export class FailingOnceEmbedder implements ExtractionEmbedder {
  private failed = false
  private readonly inner = new FakeExtractionEmbedder()

  async embed(texts: string[]): Promise<number[][]> {
    if (!this.failed) {
      this.failed = true
      throw new Error('embedder deliberately crashing (simulated crash between passes)')
    }
    return this.inner.embed(texts)
  }
}

// ── Transcript record builders (Claude Code JSONL shape) ─────────────────────

export interface TranscriptRecordExtras {
  cwd?: string
  timestamp?: string
  sessionId?: string
  isMeta?: boolean
}

export function userRecord(text: string, extras: TranscriptRecordExtras = {}): Record<string, unknown> {
  return { type: 'user', message: { role: 'user', content: text }, ...extras }
}

export function assistantRecord(
  text: string | null,
  toolUses: readonly { name: string; input?: unknown }[] = [],
  extras: TranscriptRecordExtras = {}
): Record<string, unknown> {
  const content: unknown[] = []
  if (text !== null) content.push({ type: 'text', text })
  for (const [i, tool] of toolUses.entries()) {
    content.push({ type: 'tool_use', id: `toolu_${i}`, name: tool.name, input: tool.input ?? {} })
  }
  return { type: 'assistant', message: { role: 'assistant', content }, ...extras }
}

export function toolResultRecord(toolUseId: string, content: string, extras: TranscriptRecordExtras = {}): Record<string, unknown> {
  return {
    type: 'user',
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUseId, content }] },
    ...extras
  }
}

/** Serialize records (objects or pre-rendered raw lines) into JSONL. */
export function transcriptJsonl(records: readonly (Record<string, unknown> | string)[]): string {
  return `${records.map((r) => (typeof r === 'string' ? r : JSON.stringify(r))).join('\n')}\n`
}

// ── mcp_calls seeding (the synthetic backbone) ───────────────────────────────

export interface McpCallSeed {
  sessionId: string
  tool: string
  params?: Record<string, unknown> | null
  ok?: boolean
  startedUnixMs: number
  durationMs?: number
}

export function insertMcpCalls(db: BetterSqlite3.Database, seeds: readonly McpCallSeed[]): void {
  const insert = db.prepare(
    `INSERT INTO mcp_calls (session_id, tool, params_json, args_hash, result_status, error, started_unix_ms, duration_ms)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  )
  for (const seed of seeds) {
    const ok = seed.ok ?? true
    insert.run(
      seed.sessionId,
      seed.tool,
      seed.params === null ? null : JSON.stringify(seed.params ?? {}),
      'sha256:fixture',
      ok ? 'ok' : 'error',
      ok ? null : 'fixture error',
      seed.startedUnixMs,
      seed.durationMs ?? 250
    )
  }
}
