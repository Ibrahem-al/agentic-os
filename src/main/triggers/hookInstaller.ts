/**
 * Claude Code SessionEnd hook installer — the §6 "one-time guided setup"
 * (phase 11). Merges ONE `{type: 'command'}` entry into the user's
 * ~/.claude/settings.json `hooks.SessionEnd` array. Every other top-level
 * key, hook event (PostToolUse etc., matchers included), and pre-existing
 * SessionEnd group is preserved verbatim — unknown fields survive
 * JSON.parse/stringify naturally and we never modify any group but our own.
 * The installed command runs scripts/hooks/session-end.{sh,ps1}, which POST
 * the hook's stdin JSON to HOOK_SESSION_END_URL and spool it to
 * ~/.agentic-os/pending-sessions/ on ANY failure — and always exit 0, so a
 * hook failure can never break the user's Claude Code session.
 *
 * Honest limitations, recorded:
 * - Re-serialization normalizes the file's formatting and key order
 *   (JSON.parse → JSON.stringify). Comments are impossible in settings.json
 *   anyway — Claude Code parses it as plain JSON.
 * - A settings file we cannot parse is NEVER touched (HookInstallError names
 *   the path instead of guessing at a corrupt file). A changed existing file
 *   is backed up to `<path>.bak.<stamp>` first, and written atomically
 *   (.tmp + rename, same pattern as WatchedFolderStore.save).
 * - The hook token rides the command line inside the user's own
 *   settings.json. Deliberate phase-11 decision: the token's ONLY power is
 *   enqueuing session-end extraction; real secrets stay in the keychain.
 */
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, posix, win32 } from 'node:path'
import { HOOK_SESSION_END_URL } from '../config'

export interface InstallHookOptions {
  /** The keychain-held session-end hook token embedded in the command. */
  readonly token: string
  /** Directory holding session-end.sh / session-end.ps1 (the app's scripts/hooks). */
  readonly scriptsDir: string
  /** Default: join(homedir(), '.claude', 'settings.json'). Test seam. */
  readonly settingsPath?: string
  /** Default: process.platform. Test seam. */
  readonly platform?: NodeJS.Platform
  /** Default: HOOK_SESSION_END_URL. Test seam (ephemeral test ports). */
  readonly endpointUrl?: string
}

export interface InstallHookResult {
  /** false = the exact command is already installed; nothing was written. */
  readonly changed: boolean
  readonly command: string
  readonly settingsPath: string
  /** Backup written before modifying an existing file; null when nothing was written or the file did not exist. */
  readonly backupPath: string | null
  /** Line diff of the settings file (empty when changed=false). '-'/'+' prefixed lines with unchanged context. */
  readonly diff: string
}

/** The settings file could not be safely read or merged; it was NOT touched. */
export class HookInstallError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'HookInstallError'
  }
}

/** POSIX single-quote an argv word; embedded quotes become '\''. */
function posixQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`
}

/**
 * The exact hook command for a platform: powershell + session-end.ps1 on
 * win32, single-quoted session-end.sh everywhere else. The installer runs on
 * the same machine as the settings file, so the script path uses that
 * platform's native join.
 */
export function sessionEndHookCommand(options: {
  token: string
  scriptsDir: string
  platform?: NodeJS.Platform
  endpointUrl?: string
}): string {
  const platform = options.platform ?? process.platform
  const url = options.endpointUrl ?? HOOK_SESSION_END_URL
  if (platform === 'win32') {
    const script = win32.join(options.scriptsDir, 'session-end.ps1')
    return `powershell -NoProfile -ExecutionPolicy Bypass -File "${script}" -Token "${options.token}" -Url "${url}"`
  }
  const script = posix.join(options.scriptsDir, 'session-end.sh')
  return `${posixQuote(script)} ${posixQuote(options.token)} ${posixQuote(url)}`
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** `yyyyMMddTHHmmss` (UTC) for backup file names. */
function backupStamp(date: Date): string {
  const p = (n: number): string => String(n).padStart(2, '0')
  return (
    `${date.getUTCFullYear()}${p(date.getUTCMonth() + 1)}${p(date.getUTCDate())}` +
    `T${p(date.getUTCHours())}${p(date.getUTCMinutes())}${p(date.getUTCSeconds())}`
  )
}

function toLines(text: string): string[] {
  if (text === '') return []
  const lines = text.split('\n')
  if (lines[lines.length - 1] === '') lines.pop()
  return lines
}

/**
 * Small LCS-based line diff (the settings file is tiny): unchanged lines
 * prefixed '  ', removed '- ', added '+ '. No external deps.
 */
function lineDiff(before: string, after: string): string {
  const a = toLines(before)
  const b = toLines(after)
  const width = b.length + 1
  // lcs[i * width + j] = LCS length of a[i:] vs b[j:].
  const lcs = new Array<number>((a.length + 1) * width).fill(0)
  const at = (i: number, j: number): number => lcs[i * width + j] ?? 0
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      lcs[i * width + j] = a[i] === b[j] ? at(i + 1, j + 1) + 1 : Math.max(at(i + 1, j), at(i, j + 1))
    }
  }
  const out: string[] = []
  let i = 0
  let j = 0
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      out.push(`  ${a[i] ?? ''}`)
      i += 1
      j += 1
    } else if (at(i + 1, j) >= at(i, j + 1)) {
      out.push(`- ${a[i] ?? ''}`)
      i += 1
    } else {
      out.push(`+ ${b[j] ?? ''}`)
      j += 1
    }
  }
  for (; i < a.length; i += 1) out.push(`- ${a[i] ?? ''}`)
  for (; j < b.length; j += 1) out.push(`+ ${b[j] ?? ''}`)
  return out.join('\n')
}

/** The `{type, command}` object inside a SessionEnd group that is ours. */
function findOurCommandHolder(sessionEnd: unknown[]): Record<string, unknown> | null {
  for (const group of sessionEnd) {
    if (!isPlainObject(group)) continue
    const groupHooks = group['hooks']
    if (!Array.isArray(groupHooks)) continue
    for (const item of groupHooks) {
      if (!isPlainObject(item)) continue
      const command = item['command']
      if (typeof command === 'string' && (command.includes('session-end.ps1') || command.includes('session-end.sh'))) {
        return item
      }
    }
  }
  return null
}

/**
 * Merge our SessionEnd hook into the user's Claude Code settings.json.
 * Idempotent: an identical installed command is a no-op ({changed: false});
 * a stale command (rotated token, moved app, platform change) is replaced in
 * place; otherwise a new group is appended — existing groups are never
 * modified.
 */
export function installSessionEndHook(options: InstallHookOptions): InstallHookResult {
  const platform = options.platform ?? process.platform
  const settingsPath = options.settingsPath ?? join(homedir(), '.claude', 'settings.json')
  const command = sessionEndHookCommand({
    token: options.token,
    scriptsDir: options.scriptsDir,
    ...(options.platform !== undefined ? { platform: options.platform } : {}),
    ...(options.endpointUrl !== undefined ? { endpointUrl: options.endpointUrl } : {})
  })

  if (platform !== 'win32') {
    // Hook commands must be executable; a chmod failure is non-fatal
    // (scriptsDir may be read-only inside a packaged app).
    const script = posix.join(options.scriptsDir, 'session-end.sh')
    try {
      if (existsSync(script)) chmodSync(script, 0o755)
    } catch {
      // Non-fatal by design.
    }
  }

  let beforeText: string | null
  try {
    beforeText = readFileSync(settingsPath, 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
    beforeText = null
  }

  let settings: Record<string, unknown>
  if (beforeText === null) {
    settings = {}
  } else {
    let parsed: unknown
    try {
      parsed = JSON.parse(beforeText)
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err)
      throw new HookInstallError(
        `${settingsPath} is not valid JSON (${detail}) — the file was NOT touched; fix it and re-run the setup`
      )
    }
    if (!isPlainObject(parsed)) {
      throw new HookInstallError(
        `${settingsPath} does not contain a JSON object — the file was NOT touched; fix it and re-run the setup`
      )
    }
    settings = parsed
  }

  const hooksValue = settings['hooks']
  let hooks: Record<string, unknown>
  if (hooksValue === undefined) {
    hooks = {}
    settings['hooks'] = hooks
  } else if (isPlainObject(hooksValue)) {
    hooks = hooksValue
  } else {
    throw new HookInstallError(
      `${settingsPath}: 'hooks' exists but is not an object — the file was NOT touched`
    )
  }

  const sessionEndValue = hooks['SessionEnd']
  let sessionEnd: unknown[]
  if (sessionEndValue === undefined) {
    sessionEnd = []
    hooks['SessionEnd'] = sessionEnd
  } else if (Array.isArray(sessionEndValue)) {
    sessionEnd = sessionEndValue
  } else {
    throw new HookInstallError(
      `${settingsPath}: 'hooks.SessionEnd' exists but is not an array — the file was NOT touched`
    )
  }

  const ours = findOurCommandHolder(sessionEnd)
  if (ours !== null && ours['command'] === command) {
    return { changed: false, command, settingsPath, backupPath: null, diff: '' }
  }
  if (ours !== null) {
    // Stale token/path/platform: replace OUR command string in place.
    ours['command'] = command
  } else {
    sessionEnd.push({ hooks: [{ type: 'command', command }] })
  }

  const afterText = `${JSON.stringify(settings, null, 2)}\n`

  let backupPath: string | null = null
  if (beforeText !== null) {
    backupPath = `${settingsPath}.bak.${backupStamp(new Date())}`
    copyFileSync(settingsPath, backupPath)
  }

  mkdirSync(dirname(settingsPath), { recursive: true })
  const tmpPath = `${settingsPath}.tmp`
  try {
    writeFileSync(tmpPath, afterText, 'utf8')
    renameSync(tmpPath, settingsPath)
  } catch (err) {
    rmSync(tmpPath, { force: true })
    throw err
  }

  return { changed: true, command, settingsPath, backupPath, diff: lineDiff(beforeText ?? '', afterText) }
}
