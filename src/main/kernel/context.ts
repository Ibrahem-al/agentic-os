/**
 * Context manager (§10): assembles background-agent prompts within the active
 * provider's token budget. Oversized content is SUMMARIZED by the small local
 * LLM (map-reduce over chunks sized for the local window) — never blindly
 * truncated: every section reaches the prompt either verbatim or as a
 * summary of its FULL content, and pinned sections are never summarized.
 *
 * Token counting: the per-provider *estimating* counter from phase 03. None
 * of the §20 providers ship a real local tokenizer (Anthropic: counting API
 * only); the estimator deliberately overestimates, so an assembled prompt
 * never exceeds a real budget (recorded in the phase-04 report).
 *
 * Assembly is guaranteed to terminate under budget: each summarize call caps
 * the model's output (num_predict) below the section's token target, so the
 * estimate of the result is bounded no matter what the model emits.
 */
import {
  CLOUD_MAX_TOKENS_DEFAULT,
  CLOUD_PROVIDER_DEFAULT,
  CONTEXT_MIN_SUMMARY_TOKENS,
  CONTEXT_SUMMARIZE_CHUNK_TOKENS,
  CONTEXT_SUMMARIZE_MAX_ROUNDS,
  CONTEXT_SUMMARY_OUTPUT_FRACTION,
  PROVIDER_CONTEXT_WINDOW_TOKENS,
  type CloudProvider
} from '../config'
// tokens.ts is dependency-free (config only) — imported directly so the
// kernel does not drag the full retrieval pipeline into plain-node tests.
import { estimatingTokenCounter, type TokenCounter } from '../retrieval/tokens'
import type { ProviderRouter } from '../models'
import type { Telemetry } from '../telemetry'
import type { SummarizerLlm } from './types'

export interface ContextSection {
  readonly name: string
  readonly content: string
  /** Pinned sections are never summarized; they fit verbatim or assembly throws. */
  readonly pinned?: boolean
}

export interface AssemblePromptRequest {
  /** The task statement — always included verbatim. */
  readonly objective: string
  readonly sections?: readonly ContextSection[]
  /** System prompt — always included verbatim, counted against the budget. */
  readonly system?: string
  /** Active provider (§10); sets the window and the token estimator. */
  readonly provider?: CloudProvider
  /** Full budget override; default = provider window − reserveOutputTokens. */
  readonly tokenBudget?: number
  /** Tokens reserved for the model's reply. Default CLOUD_MAX_TOKENS_DEFAULT. */
  readonly reserveOutputTokens?: number
  /**
   * Span/budget id for the summarizer's reasoning role (phase-16b) — the
   * enclosing op's id ('live:'+sessionId on the live path, else the workflow
   * jobId). Only consulted when a `router` is wired; context.summarize is
   * local-by-default so this is span-correlation only unless a user overrides
   * the role to the cloud tier.
   */
  readonly taskId?: string
}

export interface SummarizedSectionInfo {
  readonly name: string
  readonly originalTokens: number
  readonly finalTokens: number
}

export interface AssembledPrompt {
  readonly system?: string
  readonly prompt: string
  /** Estimated tokens of system + prompt (always ≤ tokenBudget). */
  readonly estimatedTokens: number
  readonly tokenBudget: number
  readonly summarizedSections: readonly SummarizedSectionInfo[]
}

export interface ContextManagerDeps {
  /** The LOCAL summarizer tier (§10) — satisfied by OllamaClient. */
  llm: SummarizerLlm
  /**
   * Reasoning router (phase-16b). When present, the summarizer is resolved PER
   * assemble() via `forRole('context.summarize', taskId)` (default local qwen3
   * — DEFAULT == TODAY); when absent the injected `llm` is used unchanged.
   */
  router?: ProviderRouter
  telemetry?: Telemetry
}

const SUMMARY_MARKER = '[summarized]\n'
// Facts FIRST: summaries run under a hard output cap (num_predict), so a
// summarizer that saves the important content for last would lose it to the
// cap. Front-loading facts makes truncation-by-cap harmless.
const SUMMARIZER_SYSTEM =
  'You compress context for another AI agent. State the concrete facts FIRST — identifiers, codenames, ' +
  'numbers, decisions, constraints — each preserved exactly as written; then compress the rest. ' +
  'Drop filler and repetition. Never enumerate repetitive lines. ' +
  'Output only the compressed summary, nothing else.'

/** Greedy line-boundary chunking by estimated tokens (hard-split huge lines). */
function splitIntoChunks(text: string, chunkTokens: number, counter: TokenCounter): string[] {
  const chunks: string[] = []
  let current = ''
  let currentTokens = 0
  const push = (): void => {
    if (current.length > 0) chunks.push(current)
    current = ''
    currentTokens = 0
  }
  for (const line of text.split('\n')) {
    let piece = line
    let pieceTokens = counter.count(piece)
    // A single line larger than a whole chunk: hard-split it (rare; the
    // split is only a chunking boundary — all content still gets summarized).
    while (pieceTokens > chunkTokens) {
      let sliceLength = Math.min(piece.length, chunkTokens * 3)
      while (counter.count(piece.slice(0, sliceLength)) > chunkTokens) {
        sliceLength = Math.floor(sliceLength / 2)
      }
      push()
      chunks.push(piece.slice(0, sliceLength))
      piece = piece.slice(sliceLength)
      pieceTokens = counter.count(piece)
    }
    const withNewline = current.length > 0 ? pieceTokens + 1 : pieceTokens
    if (currentTokens + withNewline > chunkTokens) push()
    current = current.length > 0 ? `${current}\n${piece}` : piece
    currentTokens = counter.count(current)
  }
  push()
  return chunks
}

export class ContextManager {
  private readonly llm: SummarizerLlm
  private readonly router: ProviderRouter | undefined
  private readonly telemetry: Telemetry | undefined

  constructor(deps: ContextManagerDeps) {
    this.llm = deps.llm
    this.router = deps.router
    this.telemetry = deps.telemetry
  }

  async assemble(request: AssemblePromptRequest): Promise<AssembledPrompt> {
    const provider = request.provider ?? CLOUD_PROVIDER_DEFAULT
    const counter = estimatingTokenCounter(provider)
    const reserve = request.reserveOutputTokens ?? CLOUD_MAX_TOKENS_DEFAULT
    const tokenBudget = request.tokenBudget ?? PROVIDER_CONTEXT_WINDOW_TOKENS[provider] - reserve
    if (tokenBudget <= 0) throw new Error(`token budget must be positive (got ${tokenBudget})`)

    const sections = request.sections ?? []
    const names = new Set<string>()
    for (const section of sections) {
      if (section.name.trim() === '') throw new Error('section names must be non-empty')
      if (names.has(section.name)) throw new Error(`duplicate section name '${section.name}'`)
      names.add(section.name)
    }

    // Fixed scaffolding: system, objective, section headers, and a summary-
    // marker allowance for every summarizable section (conservative — the
    // allowance is charged whether or not the section ends up summarized).
    const objectiveBlock = `# Objective\n\n${request.objective}`
    const headerFor = (name: string): string => `\n\n## ${name}\n\n`
    const markerTokens = counter.count(SUMMARY_MARKER)
    const systemTokens = request.system !== undefined ? counter.count(request.system) : 0
    let fixedTokens = systemTokens + counter.count(objectiveBlock)
    for (const section of sections) {
      fixedTokens += counter.count(headerFor(section.name))
      if (section.pinned !== true) fixedTokens += markerTokens
    }
    if (fixedTokens > tokenBudget) {
      throw new Error(
        `system + objective + section scaffolding (${fixedTokens} tokens) exceed the ${tokenBudget}-token budget — nothing summarizable remains (§10)`
      )
    }

    const sectionTokens = sections.map((section) => counter.count(section.content))
    const pinnedTotal = sections.reduce((sum, section, i) => (section.pinned === true ? sum + (sectionTokens[i] ?? 0) : sum), 0)
    const available = tokenBudget - fixedTokens
    if (pinnedTotal > available) {
      throw new Error(
        `pinned sections total ${pinnedTotal} tokens but only ${available} fit the budget — pinned content is never summarized (§10); unpin or raise the budget`
      )
    }

    // Waterfill: non-pinned sections that fit an equal share stay verbatim
    // (their slack redistributes); the rest split the remainder as summary
    // targets. Nothing is ever dropped or cut — only summarized.
    const verbatim = new Set<number>()
    sections.forEach((section, i) => {
      if (section.pinned === true) verbatim.add(i)
    })
    let free = available - pinnedTotal
    let unresolved = sections
      .map((section, i) => ({ index: i, tokens: sectionTokens[i] ?? 0 }))
      .filter((entry) => sections[entry.index]?.pinned !== true)
    const unresolvedTotal = unresolved.reduce((sum, entry) => sum + entry.tokens, 0)
    if (unresolvedTotal <= free) {
      for (const entry of unresolved) verbatim.add(entry.index)
      unresolved = []
    } else {
      for (;;) {
        if (unresolved.length === 0) break
        const share = Math.floor(free / unresolved.length)
        const fitting = unresolved.filter((entry) => entry.tokens <= share)
        if (fitting.length === 0) break
        for (const entry of fitting) {
          verbatim.add(entry.index)
          free -= entry.tokens
        }
        unresolved = unresolved.filter((entry) => entry.tokens > share)
      }
    }

    const summaries = new Map<number, string>()
    const summarizedSections: SummarizedSectionInfo[] = []
    if (unresolved.length > 0) {
      const target = Math.floor(free / unresolved.length)
      if (target < CONTEXT_MIN_SUMMARY_TOKENS) {
        throw new Error(
          `budget leaves only ${target} tokens per oversized section (min ${CONTEXT_MIN_SUMMARY_TOKENS}) — an honest summary cannot fit; raise the budget or drop sections`
        )
      }
      // Resolve the summarizer once for this assemble op: the router (phase-16b:
      // context.summarize, local-by-default) bound to this op's taskId when
      // wired, else today's injected llm. Not touched for within-budget
      // assemblies (no unresolved sections ⇒ no model call, unchanged).
      const summarizer: SummarizerLlm =
        this.router !== undefined
          ? this.router.forRole('context.summarize', request.taskId ?? 'context:summarize')
          : this.llm
      for (const entry of unresolved) {
        const section = sections[entry.index]!
        const summary = await this.summarize(section.name, section.content, target, counter, summarizer)
        summaries.set(entry.index, summary)
        summarizedSections.push({ name: section.name, originalTokens: entry.tokens, finalTokens: counter.count(summary) })
      }
    }

    const parts: string[] = [objectiveBlock]
    sections.forEach((section, i) => {
      const body = verbatim.has(i) ? section.content : `${SUMMARY_MARKER}${summaries.get(i) ?? ''}`
      parts.push(`${headerFor(section.name)}${body}`)
    })
    const prompt = parts.join('')
    const estimatedTokens = systemTokens + counter.count(prompt)
    return {
      ...(request.system !== undefined ? { system: request.system } : {}),
      prompt,
      estimatedTokens,
      tokenBudget,
      summarizedSections
    }
  }

  /**
   * Map-reduce summarization: chunk to the local window, summarize each chunk
   * with a hard output cap, and re-summarize the concatenation until it fits
   * the target. The caps make the result's ESTIMATE land under target even
   * though the estimator overestimates real tokens.
   */
  private async summarize(
    name: string,
    content: string,
    targetTokens: number,
    counter: TokenCounter,
    llm: SummarizerLlm
  ): Promise<string> {
    let current = content
    for (let round = 1; round <= CONTEXT_SUMMARIZE_MAX_ROUNDS; round++) {
      if (counter.count(current) <= targetTokens) return current
      const chunks = splitIntoChunks(current, CONTEXT_SUMMARIZE_CHUNK_TOKENS, counter)
      const perChunkCap = Math.max(16, Math.floor((targetTokens * CONTEXT_SUMMARY_OUTPUT_FRACTION) / chunks.length))
      const parts: string[] = []
      for (const [chunkIndex, chunk] of chunks.entries()) {
        parts.push(await this.summarizeChunk(name, chunk, perChunkCap, round, chunkIndex, chunks.length, llm))
      }
      current = parts.filter((part) => part.length > 0).join('\n')
    }
    if (counter.count(current) > targetTokens) {
      throw new Error(
        `summarizing section '${name}' did not converge to ${targetTokens} tokens after ${CONTEXT_SUMMARIZE_MAX_ROUNDS} rounds`
      )
    }
    return current
  }

  private async summarizeChunk(
    name: string,
    chunk: string,
    maxTokens: number,
    round: number,
    chunkIndex: number,
    chunkCount: number,
    llm: SummarizerLlm
  ): Promise<string> {
    const approxWords = Math.max(10, Math.floor(maxTokens * 0.75))
    const prompt = `Compress the following content from the section titled "${name}". State the concrete facts first, preserved exactly; keep the whole summary under ${approxWords} words.\n\n${chunk}`
    const call = async (): Promise<string> => {
      const result = await llm.generate(prompt, { system: SUMMARIZER_SYSTEM, maxTokens, temperature: 0 })
      return result.text.trim()
    }
    if (this.telemetry === undefined) return call()
    return this.telemetry.withSpan(
      'model.summarize',
      {
        'model.purpose': 'summarize',
        'context.section': name,
        'context.round': round,
        'context.chunk': chunkIndex,
        'context.chunks': chunkCount
      },
      call
    )
  }
}
