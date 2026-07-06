/**
 * Runner binary resolution + version gate (phase 17; P1.9/§10.12) — the pure,
 * seam-driven half. `resolveClaudeBinary` is sync + fs-only, so every case here
 * runs against an injected `fileExists`/`env`/`platform`/`homeDir`/`execPath`
 * (no real filesystem, no subprocess). Pins the load-bearing seams:
 *   - `AGENTIC_OS_RUNNER_BINARY` wins over `settings.runner.binaryPath` AND all
 *     probing (the test seam + the user override);
 *   - a `.mjs`/`.js` target → `process.execPath` + `[script,…]` (node-script)
 *     so the fake runner spawns cross-platform with no shell;
 *   - a win32 `.cmd` shim → `cmd.exe /d /s /c <cmd>` (cmd-shim), never shell:true,
 *     with a native `claude.exe` preferred when present;
 *   - the `RUNNER_MIN_CLI_VERSION` gate (`parseSemver`/`meetsMinVersion`/
 *     `probeClaudeVersion`) rejects an old/unparseable `claude --version`.
 */
import { describe, expect, it } from 'vitest'
import { RUNNER_MIN_CLI_VERSION } from '../../src/main/config'
import {
  meetsMinVersion,
  parseSemver,
  probeClaudeVersion,
  resolveClaudeBinary,
  RUNNER_BINARY_ENV,
  type ResolvedBinary
} from '../../src/main/runner'

describe('resolveClaudeBinary — resolution order (env → settings → well-known → PATH)', () => {
  it('the AGENTIC_OS_RUNNER_BINARY env seam wins over settings.binaryPath AND probing', () => {
    const r = resolveClaudeBinary({
      env: { [RUNNER_BINARY_ENV]: '/opt/claude' },
      platform: 'linux',
      settingsBinaryPath: '/other/claude', // present, but env wins
      fileExists: () => true, // even with everything "on disk", env still wins
      homeDir: '/home/u'
    })
    expect(r).toEqual({ path: '/opt/claude', command: '/opt/claude', prefixArgs: [], strategy: 'env' })
  })

  it('a `.mjs` env target resolves to the node-script spawn (process.execPath + [script])', () => {
    const r = resolveClaudeBinary({
      env: { [RUNNER_BINARY_ENV]: '/abs/fake-runner.mjs' },
      platform: 'linux',
      execPath: '/usr/bin/node'
    })
    // The SPAWN strategy (node-script) wins over the SOURCE (env) — the whole
    // point of the seam is a cross-platform, shell-free Node fake.
    expect(r).toEqual({
      path: '/abs/fake-runner.mjs',
      command: '/usr/bin/node',
      prefixArgs: ['/abs/fake-runner.mjs'],
      strategy: 'node-script'
    })
  })

  it('settings.runner.binaryPath is honored UNCONDITIONALLY (wins over probing, even if the file is "missing")', () => {
    const r = resolveClaudeBinary({
      env: {}, // no env seam
      platform: 'linux',
      settingsBinaryPath: '/s/claude',
      fileExists: () => false // an explicit path is never re-checked into a fall-through
    })
    expect(r).toEqual({ path: '/s/claude', command: '/s/claude', prefixArgs: [], strategy: 'settings' })
  })

  it('a win32 `.cmd` (from settings) rides cmd.exe /d /s /c — NEVER shell:true', () => {
    const r = resolveClaudeBinary({
      env: { ComSpec: 'C:\\Windows\\System32\\cmd.exe' },
      platform: 'win32',
      settingsBinaryPath: 'C:\\npm\\claude.cmd'
    })
    expect(r).toEqual({
      path: 'C:\\npm\\claude.cmd',
      command: 'C:\\Windows\\System32\\cmd.exe',
      prefixArgs: ['/d', '/s', '/c', 'C:\\npm\\claude.cmd'],
      strategy: 'cmd-shim'
    })
  })

  it('cmd-shim falls back to a bare cmd.exe when ComSpec is unset', () => {
    const r = resolveClaudeBinary({ env: {}, platform: 'win32', settingsBinaryPath: 'C:\\npm\\claude.cmd' })
    expect(r?.command).toBe('cmd.exe')
    expect(r?.strategy).toBe('cmd-shim')
  })

  it('probes the ~/.local/bin well-known location', () => {
    const target = '/home/u/.local/bin/claude'
    const r = resolveClaudeBinary({ env: {}, platform: 'linux', homeDir: '/home/u', fileExists: (p) => p === target })
    expect(r).toEqual({ path: target, command: target, prefixArgs: [], strategy: 'well-known' })
  })

  it('probes an extra well-known dir (the async-resolved npm global bin)', () => {
    const npmBin = '/usr/lib/node_modules/.bin'
    const target = `${npmBin}/claude`
    const r = resolveClaudeBinary({
      env: {},
      platform: 'linux',
      homeDir: '/home/u',
      extraDirs: [npmBin],
      fileExists: (p) => p === target
    })
    expect(r?.strategy).toBe('well-known')
    expect(r?.path).toBe(target)
  })

  it('falls back to a bare `claude` found on PATH', () => {
    const r = resolveClaudeBinary({
      env: { PATH: '/a:/usr/bin' },
      platform: 'linux',
      homeDir: '/home/u',
      fileExists: (p) => p === '/usr/bin/claude'
    })
    expect(r).toEqual({ path: '/usr/bin/claude', command: '/usr/bin/claude', prefixArgs: [], strategy: 'path' })
  })

  it('on win32 prefers a native claude.exe over the claude.cmd shim in the same dir', () => {
    const r = resolveClaudeBinary({
      env: { Path: 'C:\\tools' },
      platform: 'win32',
      homeDir: 'C:\\Users\\u',
      fileExists: (p) => p === 'C:\\tools\\claude.exe' || p === 'C:\\tools\\claude.cmd'
    })
    expect(r?.path).toBe('C:\\tools\\claude.exe') // .exe preferred
    expect(r?.strategy).toBe('path') // native exe → spawned directly, not via cmd-shim
    expect(r?.command).toBe('C:\\tools\\claude.exe')
    expect(r?.prefixArgs).toEqual([])
  })

  it('on win32 uses the cmd-shim when only claude.cmd exists on PATH', () => {
    const r = resolveClaudeBinary({
      env: { Path: 'C:\\tools', ComSpec: 'C:\\Windows\\System32\\cmd.exe' },
      platform: 'win32',
      homeDir: 'C:\\Users\\u',
      fileExists: (p) => p === 'C:\\tools\\claude.cmd'
    })
    expect(r?.path).toBe('C:\\tools\\claude.cmd')
    expect(r?.strategy).toBe('cmd-shim')
    expect(r?.command).toBe('C:\\Windows\\System32\\cmd.exe')
    expect(r?.prefixArgs).toEqual(['/d', '/s', '/c', 'C:\\tools\\claude.cmd'])
  })

  it('returns null when no claude can be found anywhere', () => {
    expect(resolveClaudeBinary({ env: {}, platform: 'linux', homeDir: '/home/u', fileExists: () => false })).toBeNull()
  })
})

describe('parseSemver / meetsMinVersion (the RUNNER_MIN_CLI_VERSION gate)', () => {
  it('parseSemver pulls the first d.d.d triple out of real --version output', () => {
    expect(parseSemver('2.0.0 (Claude Code)')).toEqual([2, 0, 0])
    expect(parseSemver('claude version 1.12.3')).toEqual([1, 12, 3])
    expect(parseSemver('no version here')).toBeNull()
  })

  it('meetsMinVersion is a numeric >= over major.minor.patch (default min = RUNNER_MIN_CLI_VERSION)', () => {
    expect(RUNNER_MIN_CLI_VERSION).toBe('1.0.0')
    expect(meetsMinVersion('1.0.0', '1.0.0')).toBe(true) // equal is OK
    expect(meetsMinVersion('2.1.3', '1.0.0')).toBe(true)
    expect(meetsMinVersion('0.9.9', '1.0.0')).toBe(false) // an OLD CLI is rejected
    expect(meetsMinVersion('1.2.0', '1.10.0')).toBe(false) // numeric, not lexicographic (2 < 10)
    expect(meetsMinVersion('2.0.0')).toBe(true) // default min
    expect(meetsMinVersion('garbage')).toBe(false) // unparseable is NEVER >=
  })
})

describe('probeClaudeVersion (async, via the runVersion seam)', () => {
  const nativeInvocation: ResolvedBinary = { path: '/x/claude', command: '/x/claude', prefixArgs: [], strategy: 'path' }

  it('normalizes real --version output to major.minor.patch and appends --version to the invocation', async () => {
    let captured: { command: string; args: readonly string[] } | null = null
    const out = await probeClaudeVersion(nativeInvocation, {
      runVersion: async (command, args) => {
        captured = { command, args }
        return '2.0.0 (Claude Code)\n'
      }
    })
    expect(out).toBe('2.0.0')
    expect(captured).toEqual({ command: '/x/claude', args: ['--version'] })
  })

  it('carries a node-script invocation prefix through to the spawned argv', async () => {
    let captured: { command: string; args: readonly string[] } | null = null
    const nodeScript: ResolvedBinary = { path: '/x/fake.mjs', command: '/usr/bin/node', prefixArgs: ['/x/fake.mjs'], strategy: 'node-script' }
    await probeClaudeVersion(nodeScript, {
      runVersion: async (command, args) => {
        captured = { command, args }
        return '9.9.9'
      }
    })
    expect(captured).toEqual({ command: '/usr/bin/node', args: ['/x/fake.mjs', '--version'] })
  })

  it('returns null when the binary cannot run or prints nothing parseable', async () => {
    expect(await probeClaudeVersion(nativeInvocation, { runVersion: async () => null })).toBeNull()
    expect(await probeClaudeVersion(nativeInvocation, { runVersion: async () => 'not a version at all' })).toBeNull()
  })
})
