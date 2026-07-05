/**
 * Capability schema unit tests (§13, phase 09): the zod validator +
 * normalization, path/domain scope matching, subset checks, and the §11 lane
 * derivations (Deno flags, Docker args) — the "single source for both lanes".
 */
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  CapabilityError,
  EMPTY_CAPABILITIES,
  capabilitiesWithin,
  denoPermissionFlags,
  dockerCapabilityArgs,
  isDomainAllowed,
  isPathWithin,
  parseCapabilities,
  pathsAllowed
} from '../../src/main/security'

const abs = (...parts: string[]): string => resolve('/', ...parts)

describe('parseCapabilities', () => {
  it('defaults every omitted field to deny (empty / zero)', () => {
    expect(parseCapabilities({})).toEqual(EMPTY_CAPABILITIES)
    expect(parseCapabilities(undefined)).toEqual(EMPTY_CAPABILITIES)
  })

  it('resolves ~ to the home directory and dedupes', () => {
    const cap = parseCapabilities({ fsRead: ['~/agentic-out', '~/agentic-out'] })
    expect(cap.fsRead).toEqual([resolve(join(homedir(), 'agentic-out'))])
  })

  it('rejects relative paths — declarations must not depend on cwd', () => {
    expect(() => parseCapabilities({ fsWrite: ['out/files'] })).toThrow(CapabilityError)
  })

  it('rejects malformed net domains and lowercases valid ones', () => {
    expect(() => parseCapabilities({ netDomains: ['http://example.com'] })).toThrow(CapabilityError)
    expect(() => parseCapabilities({ netDomains: ['bad host'] })).toThrow(CapabilityError)
    expect(parseCapabilities({ netDomains: ['CNN.com', 'api.example.com:443'] }).netDomains).toEqual([
      'cnn.com',
      'api.example.com:443'
    ])
  })

  it('rejects negative or non-finite spend ceilings', () => {
    expect(() => parseCapabilities({ maxSpendUSD: -1 })).toThrow(CapabilityError)
    expect(() => parseCapabilities({ maxSpendUSD: Number.POSITIVE_INFINITY })).toThrow(CapabilityError)
    expect(parseCapabilities({ maxSpendUSD: 0.1 }).maxSpendUSD).toBe(0.1)
  })
})

describe('path scope matching', () => {
  const root = abs('data', 'allowed')

  it('allows the root itself and anything under it', () => {
    expect(isPathWithin(root, root)).toBe(true)
    expect(isPathWithin(join(root, 'deep', 'file.txt'), root)).toBe(true)
  })

  it('denies siblings, parents and .. traversal', () => {
    expect(isPathWithin(abs('data', 'allowed-sibling'), root)).toBe(false)
    expect(isPathWithin(abs('data'), root)).toBe(false)
    expect(isPathWithin(join(root, '..', 'escape.txt'), root)).toBe(false)
  })

  it('pathsAllowed requires every path to be covered by some root', () => {
    const roots = [root, abs('other')]
    expect(pathsAllowed([join(root, 'a'), abs('other', 'b')], roots)).toBe(true)
    expect(pathsAllowed([join(root, 'a'), abs('elsewhere', 'c')], roots)).toBe(false)
    expect(pathsAllowed([], roots)).toBe(true)
  })
})

describe('net domain matching (Deno --allow-net semantics)', () => {
  it('bare host allows any port; host:port allows exactly that port', () => {
    expect(isDomainAllowed('example.com', ['example.com'])).toBe(true)
    expect(isDomainAllowed('example.com:8443', ['example.com'])).toBe(true)
    expect(isDomainAllowed('example.com:8443', ['example.com:443'])).toBe(false)
    expect(isDomainAllowed('example.com:443', ['example.com:443'])).toBe(true)
  })

  it('no wildcard subdomains, case-insensitive hosts', () => {
    expect(isDomainAllowed('api.example.com', ['example.com'])).toBe(false)
    expect(isDomainAllowed('EXAMPLE.com', ['example.com'])).toBe(true)
    expect(isDomainAllowed('evil.com', ['example.com', 'cnn.com'])).toBe(false)
  })
})

describe('capabilitiesWithin (sandbox-run must not exceed the agent)', () => {
  const outer = parseCapabilities({
    fsRead: [abs('data')],
    fsWrite: [abs('out')],
    netDomains: ['example.com'],
    tools: ['summarize'],
    maxSpendUSD: 0.5
  })

  it('accepts equal and narrower requests', () => {
    expect(capabilitiesWithin(outer, outer)).toBe(true)
    expect(
      capabilitiesWithin(
        parseCapabilities({ fsRead: [abs('data', 'sub')], netDomains: ['example.com:443'], maxSpendUSD: 0.1 }),
        outer
      )
    ).toBe(true)
    expect(capabilitiesWithin(EMPTY_CAPABILITIES, outer)).toBe(true)
  })

  it('rejects any dimension that exceeds the outer declaration', () => {
    expect(capabilitiesWithin(parseCapabilities({ fsRead: [abs('secrets')] }), outer)).toBe(false)
    expect(capabilitiesWithin(parseCapabilities({ fsWrite: [abs('data')] }), outer)).toBe(false)
    expect(capabilitiesWithin(parseCapabilities({ netDomains: ['evil.com'] }), outer)).toBe(false)
    expect(capabilitiesWithin(parseCapabilities({ tools: ['exec'] }), outer)).toBe(false)
    expect(capabilitiesWithin(parseCapabilities({ maxSpendUSD: 1 }), outer)).toBe(false)
  })
})

describe('lane derivations (§11 one policy, two lanes)', () => {
  it('deno: no capability ⇒ no flag ⇒ default-deny; --no-prompt/--no-remote always', () => {
    expect(denoPermissionFlags(EMPTY_CAPABILITIES)).toEqual(['--no-prompt', '--no-remote'])
    const cap = parseCapabilities({
      fsRead: [abs('a'), abs('b')],
      fsWrite: [abs('w')],
      netDomains: ['example.com:443']
    })
    const flags = denoPermissionFlags(cap)
    expect(flags).toContain(`--allow-read=${abs('a')},${abs('b')}`)
    expect(flags).toContain(`--allow-write=${abs('w')}`)
    expect(flags).toContain('--allow-net=example.com:443')
    expect(flags.some((f) => f.startsWith('--allow-run') || f.startsWith('--allow-env'))).toBe(false)
  })

  it('docker: deny-by-default container args + scoped ro/rw mounts', () => {
    const cap = parseCapabilities({ fsRead: [abs('a')], fsWrite: [abs('w')] })
    const derived = dockerCapabilityArgs(cap)
    const joined = derived.args.join(' ')
    expect(joined).toContain('--network none')
    expect(joined).toContain('--cap-drop ALL')
    expect(joined).toContain('--read-only')
    expect(derived.readMounts.get(abs('a'))).toBe('/caps/read/0')
    expect(derived.writeMounts.get(abs('w'))).toBe('/caps/write/0')
    expect(joined).toContain(`${abs('a')}:/caps/read/0:ro`)
    expect(joined).toContain(`${abs('w')}:/caps/write/0:rw`)
  })

  it('docker FAILS CLOSED on netDomains (no per-domain egress enforcement)', () => {
    expect(() => dockerCapabilityArgs(parseCapabilities({ netDomains: ['example.com'] }))).toThrow(
      CapabilityError
    )
  })
})
