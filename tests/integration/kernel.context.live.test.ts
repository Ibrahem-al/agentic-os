/**
 * Live context-manager gate (`OLLAMA=1 npm test`): the REAL qwen3 small LLM
 * summarizes an oversized section and the planted codename survives into the
 * assembled prompt. Skipped (not failed) offline.
 *
 * Operating point (probed on this machine, see the phase-04 report): varied
 * realistic content in a single ~1900-token chunk with a ~280-token output
 * cap. qwen3:4b (Q4_K_M, think:false) narrates meta-commentary in its
 * summaries, but the facts-first system prompt reliably front-loads concrete
 * facts — the codename lands inside the cap. Highly repetitive adversarial
 * content can still defeat the 4b model (documented limitation; the §20
 * small LLM is user-swappable).
 */
import { describe, expect, it } from 'vitest'
import { ContextManager } from '../../src/main/kernel'
import { OllamaClient } from '../../src/main/models'

const LIVE_OLLAMA = process.env['OLLAMA'] === '1'

const SUBJECTS = ['ingestion pipeline', 'dashboard panel', 'review meeting', 'deploy preview', 'retry policy', 'cache layer', 'alert rule', 'session log', 'export job', 'palette token', 'trace viewer', 'skill registry']
const VERBS = ['was rescheduled to', 'now depends on', 'emits metrics for', 'no longer touches', 'batches work for', 'was migrated onto', 'waits for', 'archives results into', 'skips validation of', 'pins the version of']
const OBJECTS = ['the telemetry warehouse', 'the operations channel', 'the staging cluster', 'the nightly window', 'the graph store', 'the spool folder', 'the bearer token flow', 'the compaction queue', 'the reviewer rota', 'the sqlite mirror']

describe.skipIf(!LIVE_OLLAMA)('context manager live (OLLAMA=1, real qwen3 summarizer)', () => {
  it('summarizes an oversized section and keeps the codename', async () => {
    const manager = new ContextManager({ llm: new OllamaClient() })
    const lines: string[] = []
    for (let i = 0; i < 90; i++) {
      lines.push(`The ${SUBJECTS[i % 12]} ${VERBS[(i * 7) % 10]} ${OBJECTS[(i * 3) % 10]} (note ${i}).`)
    }
    lines.push('FACT: the production rollout codename is ZEPHYRWOLF — preserve this codename exactly.')
    const content = lines.join('\n')

    const result = await manager.assemble({
      objective: 'Draft the rollout announcement for the operations channel',
      sections: [{ name: 'meeting-notes', content }],
      tokenBudget: 500
    })

    expect(result.summarizedSections.map((s) => s.name)).toEqual(['meeting-notes'])
    expect(result.estimatedTokens).toBeLessThanOrEqual(500)
    expect(result.prompt).toContain('[summarized]')
    expect(result.prompt.toUpperCase()).toContain('ZEPHYRWOLF')
  }, 180_000)
})
