/**
 * SKILL.md format (phase 12) — reimplemented from the vendored skill-creator
 * reference (docs/reference/skill-creator/: SKILL.md "Anatomy of a Skill",
 * scripts/utils.py parse_skill_md, scripts/quick_validate.py), never guessed.
 *
 * A skill file is YAML frontmatter between `---` fences followed by a
 * markdown instructions body:
 *
 *   ---
 *   name: my-skill
 *   description: Use this skill when …
 *   ---
 *   # instructions …
 *
 * Rules (quick_validate.py, applied verbatim):
 *  - allowed frontmatter keys: name, description, license, allowed-tools,
 *    metadata, compatibility (nested keys under metadata are not top-level);
 *  - name: required, kebab-case ([a-z0-9-]), ≤ 64 chars, no leading/trailing/
 *    consecutive hyphens;
 *  - description: required, ≤ 1024 chars, no angle brackets;
 *  - compatibility: optional string ≤ 500 chars.
 * Multiline descriptions use the YAML indicators >, |, >-, |- with indented
 * continuation lines (utils.py's line-based reading — no YAML library).
 *
 * Persistence contract (phase doc build item 3): a skill's `instructions`
 * property stores the FULL SKILL.md text verbatim, so graph → disk → graph
 * round-trips byte-losslessly and skills stay portable to/from Claude Code.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

export const SKILL_MD_FILENAME = 'SKILL.md'

/** quick_validate.py ALLOWED_PROPERTIES, verbatim. */
export const SKILL_MD_ALLOWED_KEYS = [
  'name',
  'description',
  'license',
  'allowed-tools',
  'metadata',
  'compatibility'
] as const

export const SKILL_MD_NAME_MAX_CHARS = 64
export const SKILL_MD_DESCRIPTION_MAX_CHARS = 1024
export const SKILL_MD_COMPATIBILITY_MAX_CHARS = 500

export class SkillMdError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SkillMdError'
  }
}

export interface ParsedSkillMd {
  readonly name: string
  readonly description: string
  /** Raw frontmatter lines between the fences (verbatim, order preserved). */
  readonly frontmatterLines: readonly string[]
  /** Everything after the closing fence (leading newline stripped). */
  readonly body: string
  /** The exact input text — the lossless persisted form. */
  readonly raw: string
}

/** True when the text opens with a frontmatter fence (parse-worthy). */
export function looksLikeSkillMd(text: string): boolean {
  return text.split('\n', 1)[0]?.trim() === '---'
}

/**
 * Parse + validate one SKILL.md text. Throws SkillMdError with the exact
 * reason on any rule violation (the reference's messages, adapted).
 */
export function parseSkillMd(text: string): ParsedSkillMd {
  const lines = text.split('\n')
  if ((lines[0] ?? '').trim() !== '---') {
    throw new SkillMdError('SKILL.md missing frontmatter (no opening ---)')
  }
  let endIdx: number | null = null
  for (let i = 1; i < lines.length; i++) {
    if ((lines[i] ?? '').trim() === '---') {
      endIdx = i
      break
    }
  }
  if (endIdx === null) throw new SkillMdError('SKILL.md missing frontmatter (no closing ---)')

  const frontmatterLines = lines.slice(1, endIdx)
  let name = ''
  let description = ''
  let compatibility = ''
  const topLevelKeys: string[] = []

  const stripQuotes = (value: string): string => {
    const trimmed = value.trim()
    if (trimmed.length >= 2 && ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'")))) {
      return trimmed.slice(1, -1)
    }
    return trimmed
  }

  let i = 0
  while (i < frontmatterLines.length) {
    const line = frontmatterLines[i] ?? ''
    // Indented lines belong to a nested block (e.g. under metadata) or a
    // multiline scalar — never a top-level key (utils.py's line model).
    if (line.startsWith(' ') || line.startsWith('\t') || line.trim() === '' || line.trimStart().startsWith('#')) {
      i += 1
      continue
    }
    const colon = line.indexOf(':')
    if (colon <= 0) {
      throw new SkillMdError(`SKILL.md frontmatter line is not a key: value pair: '${line}'`)
    }
    const key = line.slice(0, colon).trim()
    const rawValue = line.slice(colon + 1).trim()
    topLevelKeys.push(key)

    const readValue = (): string => {
      // YAML multiline indicators (utils.py): >, |, >-, |- gather the
      // following indented lines joined with spaces.
      if (rawValue === '>' || rawValue === '|' || rawValue === '>-' || rawValue === '|-') {
        const continuation: string[] = []
        let j = i + 1
        while (j < frontmatterLines.length) {
          const cont = frontmatterLines[j] ?? ''
          if (!cont.startsWith('  ') && !cont.startsWith('\t')) break
          continuation.push(cont.trim())
          j += 1
        }
        i = j - 1
        return continuation.join(' ')
      }
      return stripQuotes(rawValue)
    }

    if (key === 'name') name = readValue()
    else if (key === 'description') description = readValue()
    else if (key === 'compatibility') compatibility = readValue()
    i += 1
  }

  const unexpected = topLevelKeys.filter((k) => !(SKILL_MD_ALLOWED_KEYS as readonly string[]).includes(k))
  if (unexpected.length > 0) {
    throw new SkillMdError(
      `Unexpected key(s) in SKILL.md frontmatter: ${[...unexpected].sort().join(', ')}. Allowed properties are: ${[...SKILL_MD_ALLOWED_KEYS].sort().join(', ')}`
    )
  }
  if (!topLevelKeys.includes('name')) throw new SkillMdError("Missing 'name' in frontmatter")
  if (!topLevelKeys.includes('description')) throw new SkillMdError("Missing 'description' in frontmatter")

  validateSkillMdName(name)
  validateSkillMdDescription(description)
  if (compatibility.length > SKILL_MD_COMPATIBILITY_MAX_CHARS) {
    throw new SkillMdError(
      `Compatibility is too long (${compatibility.length} characters). Maximum is ${SKILL_MD_COMPATIBILITY_MAX_CHARS} characters.`
    )
  }

  let body = lines.slice(endIdx + 1).join('\n')
  if (body.startsWith('\n')) body = body.slice(1)
  return { name, description, frontmatterLines, body, raw: text }
}

export function validateSkillMdName(name: string): void {
  const trimmed = name.trim()
  if (trimmed === '') throw new SkillMdError("Missing 'name' in frontmatter")
  if (!/^[a-z0-9-]+$/.test(trimmed)) {
    throw new SkillMdError(`Name '${trimmed}' should be kebab-case (lowercase letters, digits, and hyphens only)`)
  }
  if (trimmed.startsWith('-') || trimmed.endsWith('-') || trimmed.includes('--')) {
    throw new SkillMdError(`Name '${trimmed}' cannot start/end with hyphen or contain consecutive hyphens`)
  }
  if (trimmed.length > SKILL_MD_NAME_MAX_CHARS) {
    throw new SkillMdError(`Name is too long (${trimmed.length} characters). Maximum is ${SKILL_MD_NAME_MAX_CHARS} characters.`)
  }
}

export function validateSkillMdDescription(description: string): void {
  const trimmed = description.trim()
  if (trimmed === '') throw new SkillMdError("Missing 'description' in frontmatter")
  if (trimmed.includes('<') || trimmed.includes('>')) {
    throw new SkillMdError('Description cannot contain angle brackets (< or >)')
  }
  if (trimmed.length > SKILL_MD_DESCRIPTION_MAX_CHARS) {
    throw new SkillMdError(
      `Description is too long (${trimmed.length} characters). Maximum is ${SKILL_MD_DESCRIPTION_MAX_CHARS} characters.`
    )
  }
}

/** Kebab-case a display name into a valid SKILL.md frontmatter name. */
export function skillMdNameOf(displayName: string): string {
  const kebab = displayName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, SKILL_MD_NAME_MAX_CHARS)
    .replace(/^-|-$/g, '')
  return kebab === '' ? 'skill' : kebab
}

/** Serialize the canonical minimal form (used when wrapping legacy skills). */
export function serializeSkillMd(parts: { name: string; description: string; body: string }): string {
  validateSkillMdName(parts.name)
  validateSkillMdDescription(parts.description)
  return `---\nname: ${parts.name}\ndescription: ${parts.description}\n---\n\n${parts.body}`
}

/**
 * The persisted form of a skill's instructions: already-valid SKILL.md text
 * passes through VERBATIM (byte-lossless round-trip); legacy plain
 * instructions are wrapped once with synthesized frontmatter (name from the
 * display name, description from the first instruction line, sanitized to the
 * reference's rules).
 */
export function ensureSkillMd(displayName: string, instructions: string): string {
  if (looksLikeSkillMd(instructions)) {
    parseSkillMd(instructions) // throws with the exact reason when malformed
    return instructions
  }
  const firstLine = instructions
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l !== '')
  const description = (firstLine ?? `Instructions for the ${displayName} skill.`)
    .replace(/[<>]/g, '')
    .slice(0, SKILL_MD_DESCRIPTION_MAX_CHARS)
  return serializeSkillMd({ name: skillMdNameOf(displayName), description, body: instructions })
}

// ── Disk round-trip (DoD: "round-trips losslessly to a SKILL.md file") ──────

/**
 * Write a skill's instructions to `<dir>/<skill-md-name>/SKILL.md` (the
 * skill-creator directory shape) and return the file path. Instructions not
 * yet in SKILL.md form are wrapped via ensureSkillMd first.
 */
export function exportSkillMdFile(dir: string, displayName: string, instructions: string): string {
  const content = ensureSkillMd(displayName, instructions)
  const parsed = parseSkillMd(content)
  const filePath = join(dir, parsed.name, SKILL_MD_FILENAME)
  mkdirSync(dirname(filePath), { recursive: true })
  writeFileSync(filePath, content, 'utf8')
  return filePath
}

/** Read + validate a SKILL.md file; `raw` is the byte-lossless stored form. */
export function importSkillMdFile(filePath: string): ParsedSkillMd {
  return parseSkillMd(readFileSync(filePath, 'utf8'))
}
