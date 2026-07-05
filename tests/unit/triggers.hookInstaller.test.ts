/**
 * SessionEnd hook installer (§6): careful merge into ~/.claude/settings.json.
 * Golden-file merge preserves every pre-existing key and hook verbatim; the
 * installer is idempotent, replaces only OUR command on token rotation, backs
 * up before changing an existing file, and never touches a file it cannot
 * parse. Platform seams keep the suite off the real homedir.
 */
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { HOOK_SESSION_END_URL } from '../../src/main/config'
import { HookInstallError, installSessionEndHook, sessionEndHookCommand } from '../../src/main/triggers/hookInstaller'

interface HookItem {
  readonly type?: string
  readonly command?: string
}
interface HookGroup {
  readonly matcher?: string
  readonly hooks?: readonly HookItem[]
}
interface SettingsFile {
  readonly model?: string
  readonly permissions?: unknown
  readonly hooks?: {
    readonly SessionEnd?: readonly HookGroup[]
    readonly PostToolUse?: readonly HookGroup[]
  }
}

describe('triggers.hookInstaller', () => {
  let dir: string | undefined
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true })
    dir = undefined
  })

  function makeHome(): { settingsPath: string; scriptsDir: string } {
    dir = mkdtempSync(join(tmpdir(), 'agentic-os-hook-'))
    const scriptsDir = join(dir, 'scripts', 'hooks')
    mkdirSync(scriptsDir, { recursive: true })
    writeFileSync(join(scriptsDir, 'session-end.sh'), '#!/bin/sh\nexit 0\n', 'utf8')
    return { settingsPath: join(dir, '.claude', 'settings.json'), scriptsDir }
  }

  function readSettings(settingsPath: string): SettingsFile {
    return JSON.parse(readFileSync(settingsPath, 'utf8')) as SettingsFile
  }

  function countBackups(settingsPath: string): number {
    const parent = join(settingsPath, '..')
    return readdirSync(parent).filter((name) => name.includes('.bak.')).length
  }

  it('golden-file merge: preserves every pre-existing key/hook and appends our group', () => {
    const { settingsPath, scriptsDir } = makeHome()
    const original = {
      model: 'opus',
      permissions: { allow: ['Bash(ls:*)'], deny: [] },
      hooks: {
        PostToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'echo hi' }] }],
        SessionEnd: [{ hooks: [{ type: 'command', command: 'other-tool --bye' }] }]
      }
    }
    const originalText = `${JSON.stringify(original, null, 2)}\n`
    mkdirSync(join(settingsPath, '..'), { recursive: true })
    writeFileSync(settingsPath, originalText, 'utf8')

    const result = installSessionEndHook({ token: 'tok-A', scriptsDir, settingsPath, platform: 'linux' })
    expect(result.changed).toBe(true)
    expect(result.settingsPath).toBe(settingsPath)

    const after = readSettings(settingsPath)
    // Every pre-existing key/hook intact verbatim.
    expect(after.model).toBe('opus')
    expect(after.permissions).toEqual(original.permissions)
    expect(after.hooks?.PostToolUse).toEqual(original.hooks.PostToolUse)
    expect(after.hooks?.SessionEnd?.[0]).toEqual(original.hooks.SessionEnd[0])
    // Ours APPENDED as a new group.
    expect(after.hooks?.SessionEnd).toHaveLength(2)
    expect(after.hooks?.SessionEnd?.[1]).toEqual({ hooks: [{ type: 'command', command: result.command }] })

    // Diff: a '+' line with our command, NO '-' line removing the other tool's.
    const diffLines = result.diff.split('\n')
    expect(diffLines.some((l) => l.startsWith('+ ') && l.includes('session-end.sh'))).toBe(true)
    expect(diffLines.some((l) => l.startsWith('- ') && l.includes('other-tool --bye'))).toBe(false)

    // Backup byte-identical to the original.
    if (result.backupPath === null) throw new Error('expected a backup path for a changed existing file')
    expect(readFileSync(result.backupPath, 'utf8')).toBe(originalText)
  })

  it('fresh install: creates the file with the right structure and no backup', () => {
    const { settingsPath, scriptsDir } = makeHome()
    const result = installSessionEndHook({ token: 'tok-A', scriptsDir, settingsPath, platform: 'linux' })
    expect(result.changed).toBe(true)
    expect(result.backupPath).toBeNull()
    const after = readSettings(settingsPath)
    expect(after.hooks?.SessionEnd).toHaveLength(1)
    expect(after.hooks?.SessionEnd?.[0]?.hooks?.[0]).toEqual({ type: 'command', command: result.command })
    expect(result.command).toContain('session-end.sh')
    expect(result.command).toContain('tok-A')
  })

  it('idempotent re-install: {changed: false, diff: ""}, content unchanged, no second backup', () => {
    const { settingsPath, scriptsDir } = makeHome()
    mkdirSync(join(settingsPath, '..'), { recursive: true })
    writeFileSync(settingsPath, `${JSON.stringify({ model: 'opus' }, null, 2)}\n`, 'utf8')

    const first = installSessionEndHook({ token: 'tok-A', scriptsDir, settingsPath, platform: 'linux' })
    expect(first.changed).toBe(true)
    expect(countBackups(settingsPath)).toBe(1)
    const textAfterFirst = readFileSync(settingsPath, 'utf8')

    const second = installSessionEndHook({ token: 'tok-A', scriptsDir, settingsPath, platform: 'linux' })
    expect(second.changed).toBe(false)
    expect(second.diff).toBe('')
    expect(second.backupPath).toBeNull()
    expect(readFileSync(settingsPath, 'utf8')).toBe(textAfterFirst)
    expect(countBackups(settingsPath)).toBe(1)
  })

  it('token rotation: replaces OUR command in place, other groups untouched', () => {
    const { settingsPath, scriptsDir } = makeHome()
    mkdirSync(join(settingsPath, '..'), { recursive: true })
    const otherGroup = { hooks: [{ type: 'command', command: 'other-tool --bye' }] }
    writeFileSync(settingsPath, `${JSON.stringify({ hooks: { SessionEnd: [otherGroup] } }, null, 2)}\n`, 'utf8')

    installSessionEndHook({ token: 'tok-A', scriptsDir, settingsPath, platform: 'linux' })
    const rotated = installSessionEndHook({ token: 'tok-B', scriptsDir, settingsPath, platform: 'linux' })
    expect(rotated.changed).toBe(true)

    const after = readSettings(settingsPath)
    const sessionEnd = after.hooks?.SessionEnd ?? []
    expect(sessionEnd).toHaveLength(2)
    expect(sessionEnd[0]).toEqual(otherGroup)
    const ourCommands = sessionEnd
      .flatMap((group) => group.hooks ?? [])
      .map((item) => item.command ?? '')
      .filter((command) => command.includes('session-end.sh'))
    expect(ourCommands).toHaveLength(1)
    expect(ourCommands[0]).toContain('tok-B')
    expect(ourCommands[0]).not.toContain('tok-A')
  })

  it('corrupt settings.json: throws HookInstallError, file untouched', () => {
    const { settingsPath, scriptsDir } = makeHome()
    mkdirSync(join(settingsPath, '..'), { recursive: true })
    writeFileSync(settingsPath, '{not json', 'utf8')
    expect(() => installSessionEndHook({ token: 'tok-A', scriptsDir, settingsPath, platform: 'linux' })).toThrow(
      HookInstallError
    )
    expect(readFileSync(settingsPath, 'utf8')).toBe('{not json')
    expect(countBackups(settingsPath)).toBe(0)
  })

  it('hooks.SessionEnd present but not an array: HookInstallError, untouched', () => {
    const { settingsPath, scriptsDir } = makeHome()
    mkdirSync(join(settingsPath, '..'), { recursive: true })
    const text = `${JSON.stringify({ hooks: { SessionEnd: { nope: true } } }, null, 2)}\n`
    writeFileSync(settingsPath, text, 'utf8')
    expect(() => installSessionEndHook({ token: 'tok-A', scriptsDir, settingsPath, platform: 'linux' })).toThrow(
      HookInstallError
    )
    expect(readFileSync(settingsPath, 'utf8')).toBe(text)
  })

  it('platform command shapes: win32 powershell, posix single-quoted with escaping', () => {
    const winCommand = sessionEndHookCommand({ token: 'TKN', scriptsDir: 'C:\\apps\\agentic\\hooks', platform: 'win32' })
    expect(winCommand).toContain('powershell -NoProfile -ExecutionPolicy Bypass -File')
    expect(winCommand).toContain('"C:\\apps\\agentic\\hooks\\session-end.ps1"')
    expect(winCommand).toContain('-Token "TKN"')
    expect(winCommand).toContain(`-Url "${HOOK_SESSION_END_URL}"`)

    const linuxCommand = sessionEndHookCommand({ token: 'TKN', scriptsDir: '/opt/agentic/hooks', platform: 'linux' })
    expect(linuxCommand).toBe(`'/opt/agentic/hooks/session-end.sh' 'TKN' '${HOOK_SESSION_END_URL}'`)

    // A single quote in the path is escaped POSIX-style ('\'').
    const quotedCommand = sessionEndHookCommand({ token: 'TKN', scriptsDir: "/opt/o'brien", platform: 'darwin' })
    expect(quotedCommand).toContain(`'/opt/o'\\''brien/session-end.sh'`)

    // Endpoint seam for ephemeral test ports.
    const seamCommand = sessionEndHookCommand({
      token: 'TKN',
      scriptsDir: '/opt/agentic/hooks',
      platform: 'linux',
      endpointUrl: 'http://127.0.0.1:9999/hooks/session-end'
    })
    expect(seamCommand).toContain("'http://127.0.0.1:9999/hooks/session-end'")
  })
})
