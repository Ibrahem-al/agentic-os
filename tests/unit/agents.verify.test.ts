/**
 * The §17 verification self-judging guards (phase-18). runVerification is now
 * transport-agnostic (an ExtractionVerifier binding carrying its backend); the
 * guards pin:
 *   - subscription tier → skipped-subscription-extractor UNLESS a genuinely
 *     independent cloud-api verifier is configured (a subscription verifier is
 *     still self-judging, so it never runs);
 *   - cloud tier → skipped-cloud-extractor (unchanged);
 *   - local tier → today's cloud-verify / skipped-no-cloud (unchanged);
 *   - the verifier sees the item's source-chunk excerpt (index alignment).
 */
import { describe, expect, it } from 'vitest'
import {
  runVerification,
  type ExtractionVerifier,
  type FuzzyExtractionState,
  type ResolveState,
  type ResolvedComponent
} from '../../src/main/agents'
import type { ReasoningBackend } from '../../src/main/models'

const lowComponent = (): ResolvedComponent => ({
  name: 'thing',
  type: 'service',
  dependsOn: [],
  confidence: 0.4, // below the 0.6 write gate → verifiable
  evidence: 'saw thing',
  chunk: 0,
  resolution: { kind: 'new', id: 'cmp-x-1' }
})

const resolutionWith = (components: ResolvedComponent[]): ResolveState => ({
  components,
  preferences: [],
  corrections: [],
  tags: [],
  projectTag: null,
  projectAlreadyTagged: false,
  projectEmbedding: null,
  warnings: []
})

const stateOf = (tier: FuzzyExtractionState['tier']): FuzzyExtractionState => ({
  tier,
  components: [],
  preferences: [],
  corrections: [],
  sessionConfidence: null,
  escalated: false,
  escalationReason: null,
  chunkTexts: ['chunk zero excerpt'],
  warnings: []
})

function verifierSpy(backend: ReasoningBackend, reply: string): {
  verifier: ExtractionVerifier
  state: { calls: number; lastPrompt: string }
} {
  const state = { calls: 0, lastPrompt: '' }
  const verifier: ExtractionVerifier = {
    backend,
    complete: async (req) => {
      state.calls += 1
      state.lastPrompt = req.prompt
      return { text: reply }
    }
  }
  return { verifier, state }
}

describe('runVerification — §17 self-judging guards (phase-18)', () => {
  it('none-needed when every item is at/above the write gate', async () => {
    const hi: ResolvedComponent = { ...lowComponent(), confidence: 0.9 }
    const v = await runVerification({ verifier: null, extraction: stateOf('local'), resolution: resolutionWith([hi]) })
    expect(v.mode).toBe('none-needed')
    expect(v.results).toHaveLength(0)
  })

  it('subscription tier + NO independent verifier → skipped-subscription-extractor (self-judging)', async () => {
    const v = await runVerification({
      verifier: null,
      extraction: stateOf('subscription'),
      resolution: resolutionWith([lowComponent()])
    })
    expect(v.mode).toBe('skipped-subscription-extractor')
    expect(v.results.every((r) => r.verdict === 'unavailable')).toBe(true)
  })

  it('subscription tier + a subscription verifier is STILL self-judging → skipped, verifier never called', async () => {
    const { verifier, state } = verifierSpy('subscription-claude', '{"verdict":"confirm","confidence":0.9}')
    const v = await runVerification({
      verifier,
      extraction: stateOf('subscription'),
      resolution: resolutionWith([lowComponent()])
    })
    expect(v.mode).toBe('skipped-subscription-extractor')
    expect(state.calls).toBe(0)
  })

  it('subscription tier + an INDEPENDENT cloud-api verifier reviews it (and sees the source chunk)', async () => {
    const { verifier, state } = verifierSpy('cloud-api', '{"verdict":"confirm","confidence":0.95,"note":"clear"}')
    const v = await runVerification({
      verifier,
      extraction: stateOf('subscription'),
      resolution: resolutionWith([lowComponent()])
    })
    expect(v.mode).toBe('cloud')
    expect(state.calls).toBe(1)
    expect(v.results[0]?.verdict).toBe('confirm')
    expect(state.lastPrompt).toContain('chunk zero excerpt') // index alignment
  })

  it('cloud tier stays skipped-cloud-extractor regardless of the verifier (unchanged)', async () => {
    const { verifier, state } = verifierSpy('cloud-api', '{"verdict":"confirm","confidence":0.9}')
    const v = await runVerification({
      verifier,
      extraction: stateOf('cloud'),
      resolution: resolutionWith([lowComponent()])
    })
    expect(v.mode).toBe('skipped-cloud-extractor')
    expect(state.calls).toBe(0)
  })

  it('local tier + no verifier → skipped-no-cloud (today, unchanged)', async () => {
    const v = await runVerification({
      verifier: null,
      extraction: stateOf('local'),
      resolution: resolutionWith([lowComponent()])
    })
    expect(v.mode).toBe('skipped-no-cloud')
  })

  it('local tier + a cloud verifier runs verification (today, unchanged)', async () => {
    const { verifier, state } = verifierSpy('cloud-api', '{"verdict":"reject","confidence":0.9,"note":"unsupported"}')
    const v = await runVerification({
      verifier,
      extraction: stateOf('local'),
      resolution: resolutionWith([lowComponent()])
    })
    expect(v.mode).toBe('cloud')
    expect(v.results[0]?.verdict).toBe('reject')
    expect(state.calls).toBe(1)
  })
})
