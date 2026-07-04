/**
 * Compile-time proof that the REAL model classes satisfy the retrieval
 * module's structural interfaces — the golden tests run on fakes, so this is
 * what guarantees the production wiring (phase 04/05) type-checks.
 */
import { describe, expect, it } from 'vitest'
import { OllamaClient, Reranker, SpendMeter } from '../../src/main/models'
import type { BudgetGuard, Embedder, RerankerLike, SmallLlm } from '../../src/main/retrieval'

describe('retrieval structural interfaces', () => {
  it('OllamaClient satisfies Embedder and SmallLlm', () => {
    const client = new OllamaClient()
    const embedder: Embedder = client
    const llm: SmallLlm = client
    expect(embedder).toBe(client)
    expect(llm).toBe(client)
  })

  it('Reranker satisfies RerankerLike', () => {
    const reranker = new Reranker({ modelsDir: 'unused-no-io-until-rerank' })
    const like: RerankerLike = reranker
    expect(like).toBe(reranker)
  })

  it('SpendMeter satisfies BudgetGuard', () => {
    // Type-level only: constructing a SpendMeter needs a live appdata.db.
    const upcast: (meter: SpendMeter) => BudgetGuard = (meter) => meter
    expect(typeof upcast).toBe('function')
  })
})
