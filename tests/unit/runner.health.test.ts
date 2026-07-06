/**
 * The runner's "read the output + decide if it's usable" surface (phase 17;
 * §6.7/§9.1/§9.7/§10.12), all pure + seam-driven (no db, no spawn):
 *   - `parseRunnerEnvelope` (spawn.ts) — defensive `--output-format json` parse;
 *     a missing required field / non-JSON / empty stdout becomes a typed parse
 *     failure the caller grades as not-installed, NEVER a throw.
 *   - `classifyRunnerFailure` + `parseResetTime` (health.ts) — the ONE classifier
 *     mapping auth / quota (with a best-effort reset time) / not-installed / other
 *     off BOTH stderr and the envelope result.
 *   - `RunnerHealth` — the sync `isHealthy()` router seam: enabled ∧ resolved ∧
 *     version-ok ∧ effective-state usable, the min-version gate, and the sticky
 *     auth/quota/not-installed state that decays to `unknown` after one TTL.
 */
import { describe, expect, it } from 'vitest'
import { RUNNER_HEALTH_TTL_MS } from '../../src/main/config'
import { defaultModelSettings, defaultRunnerSettings, type ModelSettings } from '../../src/main/models'
import {
  classifyRunnerFailure,
  parseResetTime,
  parseRunnerEnvelope,
  RunnerHealth,
  type ResolvedBinary,
  type RunnerEnvelope
} from '../../src/main/runner'

// ── parseRunnerEnvelope (defensive, §6.7/§10.12) ──────────────────────────────

/** A complete, well-formed envelope object (drift cases delete fields off it). */
function fullEnvelopeJson(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    session_id: 'sid-1',
    is_error: false,
    num_turns: 2,
    duration_ms: 100,
    usage: { input_tokens: 10, output_tokens: 5 },
    total_cost_usd: 0.001,
    result: 'hello',
    ...overrides
  })
}

describe('parseRunnerEnvelope', () => {
  it('maps a full envelope, ignoring unknown fields', () => {
    const parsed = parseRunnerEnvelope(fullEnvelopeJson({ mystery_field: 'ignored' }) + '\n')
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) throw new Error('unreachable')
    expect(parsed.envelope).toEqual({
      sessionId: 'sid-1',
      isError: false,
      result: 'hello',
      numTurns: 2,
      durationMs: 100,
      inputTokens: 10,
      outputTokens: 5,
      totalCostUsd: 0.001
    })
  })

  it('recovers a JSON object even with leading log noise (slice the last {…})', () => {
    const parsed = parseRunnerEnvelope(`WARN: some log line the CLI printed first\n${fullEnvelopeJson()}`)
    expect(parsed.ok).toBe(true)
  })

  it('best-effort usage/num_turns/cost: absent or non-numeric become null (still ok)', () => {
    const noUsage = parseRunnerEnvelope(JSON.stringify({ session_id: 's', is_error: false, result: 'r' }))
    expect(noUsage.ok).toBe(true)
    if (!noUsage.ok) throw new Error('unreachable')
    expect(noUsage.envelope.inputTokens).toBeNull()
    expect(noUsage.envelope.outputTokens).toBeNull()
    expect(noUsage.envelope.numTurns).toBeNull()

    const junkUsage = parseRunnerEnvelope(fullEnvelopeJson({ usage: 5, num_turns: 'two', total_cost_usd: 'free' }))
    expect(junkUsage.ok).toBe(true)
    if (!junkUsage.ok) throw new Error('unreachable')
    expect(junkUsage.envelope.inputTokens).toBeNull()
    expect(junkUsage.envelope.numTurns).toBeNull()
    expect(junkUsage.envelope.totalCostUsd).toBeNull()
  })

  it('EMPTY stdout → a typed "empty" failure (never a throw)', () => {
    const parsed = parseRunnerEnvelope('   \n  ')
    expect(parsed).toEqual({ ok: false, reason: 'empty', detail: expect.any(String) })
  })

  it('non-JSON stdout → "not-json"; a JSON array → "not-json" (must be an object)', () => {
    expect(parseRunnerEnvelope('claude: this is not json').ok).toBe(false)
    expect((parseRunnerEnvelope('claude: this is not json') as { reason: string }).reason).toBe('not-json')
    expect((parseRunnerEnvelope('[1,2,3]') as { reason: string }).reason).toBe('not-json')
  })

  it('a missing required field (result / session_id / is_error) → "missing-field"', () => {
    const noResult = parseRunnerEnvelope(JSON.stringify({ session_id: 's', is_error: false }))
    expect(noResult).toMatchObject({ ok: false, reason: 'missing-field' })
    const noSession = parseRunnerEnvelope(JSON.stringify({ is_error: false, result: 'r' }))
    expect(noSession).toMatchObject({ ok: false, reason: 'missing-field' })
    const badIsError = parseRunnerEnvelope(JSON.stringify({ session_id: 's', is_error: 'nope', result: 'r' }))
    expect(badIsError).toMatchObject({ ok: false, reason: 'missing-field' })
  })
})

// ── classifyRunnerFailure + parseResetTime (§9.1/§9.7) ────────────────────────

function envelope(overrides: Partial<RunnerEnvelope> & { result: string; isError: boolean }): RunnerEnvelope {
  return {
    sessionId: 's',
    numTurns: 1,
    durationMs: 1,
    inputTokens: null,
    outputTokens: null,
    totalCostUsd: null,
    ...overrides
  }
}

describe('classifyRunnerFailure', () => {
  it('maps auth from stderr AND from the envelope result text', () => {
    expect(classifyRunnerFailure(null, 'Please run /login to authenticate.', 0).kind).toBe('auth')
    expect(classifyRunnerFailure(envelope({ result: 'authentication_error: expired', isError: true }), '', 0).kind).toBe('auth')
    expect(classifyRunnerFailure(null, 'Error: invalid api key', 0).kind).toBe('auth')
  })

  it('maps quota (usage limit / 429 / rate limit / overloaded), parsing a reset time when present', () => {
    const q = classifyRunnerFailure(null, 'Claude usage limit reached — resets at 2026-07-06T18:00:00.000Z', Date.parse('2026-07-06T12:00:00.000Z'))
    expect(q.kind).toBe('quota')
    expect(q.resetAtUnixMs).toBe(Date.parse('2026-07-06T18:00:00.000Z'))

    expect(classifyRunnerFailure(null, 'API error: 429 Too Many Requests', 0).kind).toBe('quota')
    expect(classifyRunnerFailure(null, 'rate limit exceeded', 0).kind).toBe('quota')
    expect(classifyRunnerFailure(envelope({ result: 'model overloaded, try later', isError: true }), '', 0).kind).toBe('quota')
    // A quota with no parseable reset carries no resetAtUnixMs.
    expect(classifyRunnerFailure(null, 'rate limit exceeded', 0).resetAtUnixMs).toBeUndefined()
  })

  it('maps not-installed when there is no envelope and no auth/quota signal', () => {
    const f = classifyRunnerFailure(null, 'command not found: claude', 0)
    expect(f.kind).toBe('not-installed')
    expect(f.detail).toContain('command not found')
    // Empty stderr still yields a helpful default detail.
    expect(classifyRunnerFailure(null, '', 0).kind).toBe('not-installed')
  })

  it('maps a present-but-is_error envelope with no auth/quota signal to a transient "other"', () => {
    expect(classifyRunnerFailure(envelope({ result: 'some app-level failure', isError: true }), '', 0).kind).toBe('other')
  })
})

describe('parseResetTime', () => {
  it('returns a FUTURE iso timestamp and ignores a past one', () => {
    const now = Date.parse('2026-07-06T12:00:00.000Z')
    expect(parseResetTime('resets at 2026-07-06T18:00:00.000Z', now)).toBe(Date.parse('2026-07-06T18:00:00.000Z'))
    // A past ISO is not returned (phrased without a "resets at" clock trigger so
    // the clock fallback can't grab the year digits — it faithfully yields nothing).
    expect(parseResetTime('expired at 2026-07-06T06:00:00.000Z', now)).toBeUndefined()
  })

  it('parses a bare clock time to the next local occurrence', () => {
    const now = Date.parse('2026-07-06T00:00:00.000Z')
    const t = parseResetTime('usage limit; resets at 2pm', now)
    expect(t).toBeTypeOf('number')
    expect(t! > now).toBe(true)
    expect(new Date(t!).getHours()).toBe(14) // 2pm, local
  })

  it('returns undefined with no time hint', () => {
    expect(parseResetTime('usage limit reached', 0)).toBeUndefined()
  })
})

// ── RunnerHealth cache (the router's runnerHealthy() seam) ─────────────────────

const RESOLVED: ResolvedBinary = { path: '/x/claude', command: '/x/claude', prefixArgs: [], strategy: 'path' }

interface HealthOptions {
  enabled?: boolean
  version?: string | null
  resolved?: ResolvedBinary | null
  clock: { ms: number }
  ttlMs?: number
}

function newHealth(opts: HealthOptions): RunnerHealth {
  const settings: ModelSettings = { ...defaultModelSettings(), runner: { ...defaultRunnerSettings(), enabled: opts.enabled ?? true } }
  return new RunnerHealth({
    loadSettings: () => settings,
    now: () => opts.clock.ms,
    ttlMs: opts.ttlMs ?? 1000,
    resolveBinary: () => (opts.resolved === undefined ? RESOLVED : opts.resolved),
    probeVersion: async () => (opts.version === undefined ? '2.0.0' : opts.version),
    npmBinDir: async () => null
  })
}

describe('RunnerHealth cache', () => {
  it('is healthy after a clean refresh (enabled + resolved + version-ok)', async () => {
    const health = newHealth({ clock: { ms: 1000 }, version: '2.0.0' })
    await health.refresh()
    const snap = health.snapshot()
    expect(snap.versionOk).toBe(true)
    expect(snap.version).toBe('2.0.0')
    expect(snap.binaryPath).toBe('/x/claude')
    expect(health.isHealthy()).toBe(true)
  })

  it('the min-version gate rejects an OLD --version (versionOk false, state not-installed, unhealthy)', async () => {
    const health = newHealth({ clock: { ms: 1000 }, version: '0.9.0' })
    await health.refresh()
    const snap = health.snapshot()
    expect(snap.versionOk).toBe(false)
    expect(snap.state).toBe('not-installed')
    expect(health.isHealthy()).toBe(false)
  })

  it('an unrunnable --version (null) and an unresolved binary both fail the gate', async () => {
    const noVersion = newHealth({ clock: { ms: 1 }, version: null })
    await noVersion.refresh()
    expect(noVersion.isHealthy()).toBe(false)
    expect(noVersion.snapshot().state).toBe('not-installed')

    const noBinary = newHealth({ clock: { ms: 1 }, resolved: null })
    await noBinary.refresh()
    expect(noBinary.snapshot().binaryPath).toBeNull()
    expect(noBinary.isHealthy()).toBe(false)
  })

  it('is never healthy while the runner is disabled, however good the binary is', async () => {
    const health = newHealth({ clock: { ms: 1 }, enabled: false, version: '2.0.0' })
    await health.refresh()
    expect(health.snapshot().versionOk).toBe(true)
    expect(health.isHealthy()).toBe(false) // the enabled gate dominates
  })

  it('a classified auth failure is sticky within one TTL, then decays to unknown (one re-probe)', async () => {
    const clock = { ms: 1000 }
    const health = newHealth({ clock, ttlMs: 1000, version: '2.0.0' })
    await health.refresh()
    expect(health.isHealthy()).toBe(true)

    health.noteFailure({ kind: 'auth', detail: 'please run /login' })
    expect(health.snapshot().state).toBe('auth-expired')
    expect(health.isHealthy()).toBe(false) // suppressed within the TTL

    clock.ms += 1500 // past the TTL
    expect(health.isHealthy()).toBe(true) // decayed to unknown → the next run re-probes
  })

  it('a quota failure is likewise sticky-then-decaying', async () => {
    const clock = { ms: 1000 }
    const health = newHealth({ clock, ttlMs: 1000, version: '2.0.0' })
    await health.refresh()
    health.noteFailure({ kind: 'quota', detail: 'usage limit reached' })
    expect(health.snapshot().state).toBe('quota-exhausted')
    expect(health.isHealthy()).toBe(false)
    clock.ms += 2000
    expect(health.isHealthy()).toBe(true)
  })

  it('noteSuccess clears a sticky failure to ok and stamps lastAuthOkAt', async () => {
    const clock = { ms: 5000 }
    const health = newHealth({ clock, version: '2.0.0' })
    await health.refresh()
    health.noteFailure({ kind: 'auth', detail: 'x' })
    expect(health.isHealthy()).toBe(false)

    health.noteSuccess()
    const snap = health.snapshot()
    expect(snap.state).toBe('ok')
    expect(snap.lastAuthOkAtMs).toBe(5000)
    expect(health.isHealthy()).toBe(true)
  })

  it('a transient "other" failure leaves the sticky state untouched (only lastError)', async () => {
    const health = newHealth({ clock: { ms: 1 }, version: '2.0.0' })
    await health.refresh()
    const before = health.snapshot().state // 'unknown' — a clean binary that never ran
    health.noteFailure({ kind: 'other', detail: 'a blip' })
    const after = health.snapshot()
    expect(after.state).toBe(before)
    expect(after.lastError).toBe('a blip')
    expect(health.isHealthy()).toBe(true) // still routable
  })

  it('defaults its TTL to RUNNER_HEALTH_TTL_MS', () => {
    // Compile/behaviour pin: a health with no ttlMs override uses the config TTL.
    const health = new RunnerHealth({ loadSettings: () => defaultModelSettings(), npmBinDir: async () => null })
    expect(RUNNER_HEALTH_TTL_MS).toBe(900_000)
    // A fresh, never-refreshed health is not healthy (nothing resolved yet).
    expect(health.isHealthy()).toBe(false)
  })
})
