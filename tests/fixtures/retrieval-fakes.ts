/**
 * Deterministic model fakes for the offline retrieval tests. They satisfy the
 * retrieval module's structural interfaces (Embedder / RerankerLike /
 * SmallLlm) so golden + loop tests run with zero network and stable results.
 */
import type { Embedder, RerankerLike, SmallLlm } from '../../src/main/retrieval'
import { fakeTextEmbedding, tokenizeForFake } from './graph-seed'

/** Embeds with the same bag-of-words hash the fixture nodes were seeded with. */
export class FakeEmbedder implements Embedder {
  /** Number of embed() calls (loop tests assert one embed per iteration). */
  calls = 0

  async embed(texts: string[]): Promise<number[][]> {
    this.calls += 1
    return texts.map((t) => fakeTextEmbedding(t))
  }
}

/**
 * Lexical-overlap cross-encoder stand-in: score = |query ∩ doc| / sqrt(|doc|),
 * higher = more relevant, mirroring the real reranker's "raw logit" contract.
 */
export class FakeReranker implements RerankerLike {
  calls = 0

  async rerank(query: string, docs: string[]): Promise<number[]> {
    this.calls += 1
    const queryTokens = new Set(tokenizeForFake(query))
    return docs.map((doc) => {
      const docTokens = new Set(tokenizeForFake(doc))
      let overlap = 0
      for (const token of docTokens) if (queryTokens.has(token)) overlap += 1
      return overlap / Math.sqrt(docTokens.size + 1)
    })
  }
}

export interface ScriptedLlmStep {
  /** Critic reply for this iteration (raw text handed back to the parser). */
  criticReply: string
  /** Rewrite reply if the loop asks for one after this critic verdict. */
  rewriteReply?: string
}

/**
 * SmallLlm fake driven by a per-iteration script. Distinguishes critic calls
 * from rewrite calls by their system prompt (critic says "retrieval judge",
 * rewriter says "rewrite search queries") — pinned by the critic unit tests.
 */
export class ScriptedLlm implements SmallLlm {
  criticCalls: string[] = []
  rewriteCalls: string[] = []
  private criticIndex = 0
  private rewriteIndex = 0

  constructor(private readonly steps: ScriptedLlmStep[]) {}

  async generate(prompt: string, options?: { system?: string }): Promise<{ text: string }> {
    const system = options?.system ?? ''
    if (system.includes('retrieval judge')) {
      this.criticCalls.push(prompt)
      const step = this.steps[this.criticIndex]
      if (!step) throw new Error(`ScriptedLlm: no critic reply scripted for iteration ${this.criticIndex + 1}`)
      this.criticIndex += 1
      return { text: step.criticReply }
    }
    if (system.includes('rewrite search queries')) {
      this.rewriteCalls.push(prompt)
      const step = this.steps[this.rewriteIndex]
      const reply = step?.rewriteReply
      if (reply === undefined) {
        throw new Error(`ScriptedLlm: no rewrite reply scripted for iteration ${this.rewriteIndex + 1}`)
      }
      this.rewriteIndex += 1
      return { text: reply }
    }
    throw new Error(`ScriptedLlm: unrecognized system prompt: ${system.slice(0, 80)}`)
  }
}
