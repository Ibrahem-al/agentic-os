/**
 * Context manager unit tests (§10, DoD 3): oversized input is SUMMARIZED, not
 * truncated — the key fact planted at the very END of a huge section must
 * survive into the assembled prompt, the full content must reach the
 * summarizer (no pre-truncation), and the result must fit the budget.
 *
 * The fake summarizer is extractive-deterministic: it returns the lines
 * containing 'FACT:' from whatever it is shown (a faithful summarizer in
 * miniature). A truncating implementation would cut the tail before the
 * summarizer ever saw the fact — which is exactly what these tests catch.
 */
import { describe, expect, it } from 'vitest'
import { ContextManager, type SummarizerLlm } from '../../src/main/kernel'

interface FakeCall {
  prompt: string
  system?: string
  maxTokens?: number
}

/** Extractive fake: keeps FACT lines, respects maxTokens (~3 chars/token). */
function extractiveFake(): { llm: SummarizerLlm; calls: FakeCall[] } {
  const calls: FakeCall[] = []
  const llm: SummarizerLlm = {
    async generate(prompt, options) {
      calls.push({ prompt, ...(options?.system !== undefined ? { system: options.system } : {}), ...(options?.maxTokens !== undefined ? { maxTokens: options.maxTokens } : {}) })
      const body = prompt.slice(prompt.indexOf('\n\n') + 2)
      const factLines = body.split('\n').filter((line) => line.includes('FACT:'))
      let text = factLines.length > 0 ? factLines.join('\n') : body.slice(0, 40)
      const maxChars = (options?.maxTokens ?? 128) * 3
      if (text.length > maxChars) text = text.slice(0, maxChars)
      return { text }
    }
  }
  return { llm, calls }
}

const KEY_FACT = 'FACT: the deploy password rotates every thirty-one days (codename HELIOTROPE)'

function fillerLines(count: number): string[] {
  return Array.from({ length: count }, (_, i) => `filler alpha bravo charlie delta echo foxtrot golf hotel line ${i}`)
}

describe('within budget → verbatim, no model calls', () => {
  it('assembles objective + sections untouched', async () => {
    const { llm, calls } = extractiveFake()
    const manager = new ContextManager({ llm })
    const result = await manager.assemble({
      objective: 'Ship the release notes',
      system: 'You are a release manager.',
      sections: [
        { name: 'notes', content: 'The zebra palette is approved.' },
        { name: 'constraints', content: 'Never deploy on fridays.' }
      ],
      tokenBudget: 500
    })
    expect(calls).toHaveLength(0)
    expect(result.prompt).toContain('# Objective\n\nShip the release notes')
    expect(result.prompt).toContain('## notes\n\nThe zebra palette is approved.')
    expect(result.prompt).toContain('## constraints\n\nNever deploy on fridays.')
    expect(result.prompt).not.toContain('[summarized]')
    expect(result.system).toBe('You are a release manager.')
    expect(result.summarizedSections).toEqual([])
    expect(result.estimatedTokens).toBeLessThanOrEqual(500)
  })
})

describe('oversized input → summarized, never truncated (DoD 3)', () => {
  it('keeps the key fact from the END of a huge section and fits the budget', async () => {
    const { llm, calls } = extractiveFake()
    const manager = new ContextManager({ llm })
    const content = [...fillerLines(399), KEY_FACT].join('\n')

    const result = await manager.assemble({
      objective: 'Prepare the deploy runbook',
      sections: [{ name: 'history', content }],
      tokenBudget: 1000
    })

    // Summarized, marked, and the tail fact survived.
    expect(result.summarizedSections).toHaveLength(1)
    expect(result.summarizedSections[0]!.name).toBe('history')
    expect(result.summarizedSections[0]!.finalTokens).toBeLessThan(result.summarizedSections[0]!.originalTokens)
    expect(result.prompt).toContain('[summarized]')
    expect(result.prompt).toContain('HELIOTROPE')
    expect(result.prompt).toContain('thirty-one')

    // Compression happened (bulk filler is gone), budget holds.
    expect(result.prompt).not.toMatch(/hotel line \d+/)
    expect(result.estimatedTokens).toBeLessThanOrEqual(1000)

    // No pre-truncation: the summarizer saw the WHOLE section, first line to
    // last, across its (multi-chunk) calls.
    expect(calls.length).toBeGreaterThanOrEqual(2)
    const seen = calls.map((call) => call.prompt).join('\n')
    expect(seen).toContain('hotel line 0')
    expect(seen).toContain('hotel line 398')
    expect(seen).toContain(KEY_FACT)
    // Every call was output-capped (that is what guarantees termination).
    for (const call of calls) expect(call.maxTokens).toBeGreaterThan(0)
  })

  it('waterfill: small sections stay verbatim while the oversized one is summarized', async () => {
    const { llm } = extractiveFake()
    const manager = new ContextManager({ llm })
    const pinnedContent = `contract: ${'term '.repeat(120)}end-of-contract`
    const notes = 'The approved palette is called aurora-jade. FACT: palette locked.'
    const history = [...fillerLines(380), KEY_FACT].join('\n')

    const result = await manager.assemble({
      objective: 'Plan the sprint',
      sections: [
        { name: 'task-contract', content: pinnedContent, pinned: true },
        { name: 'notes', content: notes },
        { name: 'history', content: history }
      ],
      tokenBudget: 900
    })

    expect(result.prompt).toContain(pinnedContent) // pinned: verbatim, always
    expect(result.prompt).toContain(notes) // fits its share: verbatim
    expect(result.summarizedSections.map((s) => s.name)).toEqual(['history'])
    expect(result.prompt).toContain('HELIOTROPE')
    expect(result.estimatedTokens).toBeLessThanOrEqual(900)
  })

  it('converges even when the model ignores its output cap in round 1', async () => {
    const calls: FakeCall[] = []
    const llm: SummarizerLlm = {
      async generate(prompt, options) {
        calls.push({ prompt, ...(options?.maxTokens !== undefined ? { maxTokens: options.maxTokens } : {}) })
        // Round-1 prompts carry the original filler; blow past the cap.
        if (!prompt.includes('blah')) return { text: 'blah '.repeat(400) }
        return { text: 'condensed: heliotrope retained' }
      }
    }
    const manager = new ContextManager({ llm })
    const content = fillerLines(400).join('\n')
    const result = await manager.assemble({
      objective: 'Compress the archive',
      sections: [{ name: 'archive', content }],
      tokenBudget: 1000
    })
    expect(result.prompt).toContain('condensed: heliotrope retained')
    expect(result.estimatedTokens).toBeLessThanOrEqual(1000)
    // Both rounds ran: original-content calls, then junk-summarizing calls.
    expect(calls.some((call) => call.prompt.includes('blah'))).toBe(true)
  })
})

describe('hard limits stay loud (no silent drops)', () => {
  it('throws when pinned sections cannot fit (pinned is never summarized)', async () => {
    const { llm, calls } = extractiveFake()
    const manager = new ContextManager({ llm })
    await expect(
      manager.assemble({
        objective: 'x',
        sections: [{ name: 'contract', content: 'word '.repeat(2000), pinned: true }],
        tokenBudget: 300
      })
    ).rejects.toThrow(/pinned/)
    expect(calls).toHaveLength(0)
  })

  it('throws when scaffolding alone exceeds the budget', async () => {
    const { llm } = extractiveFake()
    const manager = new ContextManager({ llm })
    await expect(
      manager.assemble({ objective: 'a long enough objective line', tokenBudget: 5 })
    ).rejects.toThrow(/scaffolding/)
  })

  it('throws when the per-section summary target would be dishonest', async () => {
    const { llm } = extractiveFake()
    const manager = new ContextManager({ llm })
    await expect(
      manager.assemble({
        objective: 'x',
        sections: [
          { name: 'one', content: 'word '.repeat(3000) },
          { name: 'two', content: 'word '.repeat(3000) }
        ],
        tokenBudget: 80
      })
    ).rejects.toThrow(/raise the budget/)
  })

  it('rejects duplicate and empty section names', async () => {
    const { llm } = extractiveFake()
    const manager = new ContextManager({ llm })
    await expect(
      manager.assemble({ objective: 'x', sections: [{ name: 'a', content: '1' }, { name: 'a', content: '2' }] })
    ).rejects.toThrow(/duplicate/)
    await expect(
      manager.assemble({ objective: 'x', sections: [{ name: ' ', content: '1' }] })
    ).rejects.toThrow(/non-empty/)
  })
})
