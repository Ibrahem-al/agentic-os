/**
 * Tolerant JSONL transcript parser (§6 "session transcript file — best-effort").
 *
 * The Claude Code transcript format is undocumented and version-dependent, so
 * this parser NEVER crashes on content: malformed lines, unknown record types
 * and unexpected shapes are counted and skipped (phase-08 doc: "unknown record
 * types skipped, never crash"). What it extracts:
 *
 * - a rendered conversation (User:/Assistant:/[tool] lines) for the fuzzy
 *   LLM passes — §21 rule 5: this text is DATA for extraction prompts, never
 *   instructions; tool_result bodies are deliberately NOT rendered (the
 *   noisiest and least trusted content in a transcript);
 * - deterministic facts the §17 step-1 pass consumes: cwd, timestamps, and
 *   which external MCP servers / plugins / skills fired (tool_use names are
 *   facts of the record, not model output).
 */
import { readFileSync } from 'node:fs'
import { MCP_SERVER_NAME } from '../../config'
import { estimatingTokenCounter } from '../../retrieval'
import { ExtractionError, type TranscriptDigest } from './types'

/** Args preview length in rendered `[tool]` lines. */
const TOOL_ARGS_RENDER_MAX_CHARS = 160

interface MutableDigest {
  records: number
  skippedRecords: number
  cwd: string | null
  sessionIdSeen: string | null
  startedMs: number | null
  endedMs: number | null
  lines: string[]
  toolUses: Map<string, number>
  mcpServers: Set<string>
  pluginNames: Set<string>
  skillNames: Set<string>
  warnings: string[]
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)

const asString = (value: unknown): string | null => (typeof value === 'string' ? value : null)

/** Text of a message content field: plain string or text blocks joined. */
function contentText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  const parts: string[] = []
  for (const block of content) {
    if (isRecord(block) && block['type'] === 'text' && typeof block['text'] === 'string') {
      parts.push(block['text'])
    }
    // tool_result / thinking / image blocks are deliberately not rendered.
  }
  return parts.join('\n')
}

/**
 * Classify a tool_use name into the deterministic §17 facts:
 * `mcp__<server>__<tool>` → external MCP server (the OS's own server is the
 * backbone, not a used tool); `mcp__plugin_<plugin>_<server>__<tool>` → plugin;
 * the `Skill` tool → `plugin:skill` → plugin, plain name → skill.
 */
function classifyToolUse(digest: MutableDigest, name: string, input: unknown): void {
  digest.toolUses.set(name, (digest.toolUses.get(name) ?? 0) + 1)

  if (name.startsWith('mcp__')) {
    const rest = name.slice('mcp__'.length)
    const split = rest.lastIndexOf('__')
    const server = split > 0 ? rest.slice(0, split) : rest
    if (server === '') return
    if (server.startsWith('plugin_')) {
      // Convention: plugin_<plugin>_<server>; plugin names use dashes, so the
      // first underscore separates plugin from server (best-effort).
      const pluginPart = server.slice('plugin_'.length)
      const firstUnderscore = pluginPart.indexOf('_')
      const plugin = firstUnderscore > 0 ? pluginPart.slice(0, firstUnderscore) : pluginPart
      if (plugin !== '') digest.pluginNames.add(plugin)
      return
    }
    if (server !== MCP_SERVER_NAME) digest.mcpServers.add(server)
    return
  }

  if (name === 'Skill' && isRecord(input)) {
    const skill = asString(input['skill']) ?? asString(input['command'])
    if (skill === null || skill.trim() === '') return
    const trimmed = skill.trim()
    const colon = trimmed.indexOf(':')
    if (colon > 0) {
      digest.pluginNames.add(trimmed.slice(0, colon))
    } else {
      digest.skillNames.add(trimmed)
    }
  }
}

function renderToolUse(name: string, input: unknown): string {
  let args = ''
  try {
    args = JSON.stringify(input) ?? ''
  } catch {
    args = '[unserializable args]'
  }
  if (args.length > TOOL_ARGS_RENDER_MAX_CHARS) args = `${args.slice(0, TOOL_ARGS_RENDER_MAX_CHARS)}…`
  return `[tool] ${name}(${args})`
}

function noteTimestamp(digest: MutableDigest, record: Record<string, unknown>): void {
  const raw = asString(record['timestamp'])
  if (raw === null) return
  const ms = Date.parse(raw)
  if (Number.isNaN(ms)) return
  if (digest.startedMs === null || ms < digest.startedMs) digest.startedMs = ms
  if (digest.endedMs === null || ms > digest.endedMs) digest.endedMs = ms
}

function noteCommonFields(digest: MutableDigest, record: Record<string, unknown>): void {
  if (digest.cwd === null) digest.cwd = asString(record['cwd'])
  if (digest.sessionIdSeen === null) digest.sessionIdSeen = asString(record['sessionId'])
  noteTimestamp(digest, record)
}

function parseLine(digest: MutableDigest, line: string): void {
  let record: unknown
  try {
    record = JSON.parse(line)
  } catch {
    digest.skippedRecords += 1
    return
  }
  if (!isRecord(record)) {
    digest.skippedRecords += 1
    return
  }
  const type = asString(record['type'])

  if (type === 'user' || type === 'assistant') {
    digest.records += 1
    noteCommonFields(digest, record)
    const message = isRecord(record['message']) ? record['message'] : null
    if (message === null) return
    if (type === 'user') {
      // Meta records (command output echoes etc.) are bookkeeping, not the
      // user speaking — counted but not rendered.
      if (record['isMeta'] === true) return
      const text = contentText(message['content']).trim()
      if (text !== '') digest.lines.push(`User: ${text}`)
      return
    }
    const content = message['content']
    const text = contentText(content).trim()
    if (text !== '') digest.lines.push(`Assistant: ${text}`)
    if (Array.isArray(content)) {
      for (const block of content) {
        if (!isRecord(block) || block['type'] !== 'tool_use') continue
        const name = asString(block['name'])
        if (name === null || name === '') continue
        classifyToolUse(digest, name, block['input'])
        digest.lines.push(renderToolUse(name, block['input']))
      }
    }
    return
  }

  if (type === 'summary') {
    digest.records += 1
    const summary = asString(record['summary'])
    if (summary !== null && summary.trim() !== '') {
      digest.lines.push(`[conversation summary] ${summary.trim()}`)
    }
    return
  }

  if (type === 'system') {
    // Hook output, notices — recognized bookkeeping, nothing to extract.
    digest.records += 1
    noteCommonFields(digest, record)
    return
  }

  digest.skippedRecords += 1
}

/** Parse transcript CONTENT (already read); never throws on any content. */
export function parseTranscriptContent(content: string): TranscriptDigest {
  const digest: MutableDigest = {
    records: 0,
    skippedRecords: 0,
    cwd: null,
    sessionIdSeen: null,
    startedMs: null,
    endedMs: null,
    lines: [],
    toolUses: new Map(),
    mcpServers: new Set(),
    pluginNames: new Set(),
    skillNames: new Set(),
    warnings: []
  }
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (line === '') continue
    parseLine(digest, line)
  }
  if (digest.skippedRecords > 0) {
    digest.warnings.push(`transcript: ${digest.skippedRecords} line(s) skipped (malformed or unknown record types)`)
  }
  const text = digest.lines.join('\n')
  // The escalation gate compares this estimate to the §20 60k-token line; the
  // counter deliberately overestimates, so borderline sessions escalate.
  const tokenEstimate = estimatingTokenCounter().count(text)
  return {
    records: digest.records,
    skippedRecords: digest.skippedRecords,
    cwd: digest.cwd,
    sessionIdSeen: digest.sessionIdSeen,
    startedAt: digest.startedMs === null ? null : new Date(digest.startedMs).toISOString(),
    endedAt: digest.endedMs === null ? null : new Date(digest.endedMs).toISOString(),
    text,
    tokenEstimate,
    toolUses: [...digest.toolUses.entries()].map(([name, count]) => ({ name, count })),
    mcpServers: [...digest.mcpServers].sort(),
    pluginNames: [...digest.pluginNames].sort(),
    skillNames: [...digest.skillNames].sort(),
    warnings: digest.warnings
  }
}

/** Parse a transcript file; a missing file is the only throw (NOT_FOUND). */
export function parseTranscriptFile(path: string): TranscriptDigest {
  let content: string
  try {
    content = readFileSync(path, 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new ExtractionError('NOT_FOUND', `extraction: transcript file not found: ${path}`)
    }
    throw err
  }
  return parseTranscriptContent(content)
}
