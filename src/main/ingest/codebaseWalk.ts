/**
 * Codebase walk (§18 codebase write path): recursively list a repo folder's
 * ingestable files, respecting `.gitignore` (root + nested files, full
 * semantics via the `ignore` matcher), always pruning `node_modules` / `.git`
 * / dot-directories, and skipping binaries and files over the 1 MB cap.
 *
 * Pure filesystem reads — no storage, no models. The orchestrator
 * (codebase.ts) decides what each surviving file becomes.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { extname, join } from 'node:path'
import ignore, { type Ignore } from 'ignore'
import { CODEBASE_CODE_EXTENSIONS, INGEST_MARKDOWN_EXTENSIONS, INGEST_MAX_FILE_BYTES } from '../config'

export interface WalkedFile {
  /** Absolute path. */
  readonly path: string
  /** Path relative to the walk root, '/'-separated (stable id material). */
  readonly relPath: string
  readonly bytes: number
}

export interface SkippedWalkEntry {
  readonly relPath: string
  readonly reason: string
}

export interface CodebaseWalkResult {
  /** Files with a Tree-sitter grammar (§18 v1: TS/JS/Python). */
  readonly codeFiles: readonly WalkedFile[]
  /** Markdown files routed to the phase-06 knowledge pipeline. */
  readonly docFiles: readonly WalkedFile[]
  /** Everything considered but not ingested, with the reason. */
  readonly skipped: readonly SkippedWalkEntry[]
}

/** Directories never descended into, gitignore or not (matches the phase-06 scan). */
const ALWAYS_PRUNED = new Set(['node_modules', '.git'])

/** Bytes sniffed for NUL to catch binaries hiding behind a text extension. */
const BINARY_SNIFF_BYTES = 8192

interface IgnoreScope {
  /** Directory the .gitignore lives in, relative to root ('' = root), '/'-suffixed unless root. */
  readonly baseRel: string
  readonly matcher: Ignore
}

function loadGitignore(dir: string, baseRel: string): IgnoreScope | null {
  let raw: string
  try {
    raw = readFileSync(join(dir, '.gitignore'), 'utf8')
  } catch {
    return null
  }
  return { baseRel, matcher: ignore().add(raw) }
}

/**
 * True when `relPath` (relative to root) is gitignored by any scope above it.
 * Directories must be tested with a trailing '/' so dir-only patterns match.
 */
function isIgnored(relPath: string, scopes: readonly IgnoreScope[]): boolean {
  for (const scope of scopes) {
    if (scope.baseRel !== '' && !relPath.startsWith(scope.baseRel)) continue
    const local = relPath.slice(scope.baseRel.length)
    if (local !== '' && scope.matcher.ignores(local)) return true
  }
  return false
}

function sniffLooksBinary(path: string): boolean {
  const content = readFileSync(path)
  const window = content.subarray(0, BINARY_SNIFF_BYTES)
  return window.includes(0)
}

/**
 * Walk `root`, returning code files (Tree-sitter languages), doc files
 * (markdown) and the skip list. Like git, an ignored directory is pruned
 * outright (nothing inside it can be re-included).
 */
export function walkCodebase(root: string): CodebaseWalkResult {
  const codeFiles: WalkedFile[] = []
  const docFiles: WalkedFile[] = []
  const skipped: SkippedWalkEntry[] = []

  const walk = (dir: string, relDir: string, scopes: readonly IgnoreScope[]): void => {
    const ownGitignore = loadGitignore(dir, relDir)
    const activeScopes = ownGitignore ? [...scopes, ownGitignore] : scopes

    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch (err) {
      skipped.push({ relPath: relDir || '.', reason: `unreadable directory (${(err as Error).message})` })
      return
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))

    for (const entry of entries) {
      const rel = `${relDir}${entry.name}`
      if (entry.isDirectory()) {
        if (ALWAYS_PRUNED.has(entry.name) || entry.name.startsWith('.')) continue
        if (isIgnored(`${rel}/`, activeScopes)) continue
        walk(join(dir, entry.name), `${rel}/`, activeScopes)
        continue
      }
      if (!entry.isFile()) continue
      if (entry.name.startsWith('.')) continue
      if (isIgnored(rel, activeScopes)) continue

      const ext = extname(entry.name).toLowerCase()
      const isCode = CODEBASE_CODE_EXTENSIONS.includes(ext)
      const isDoc = INGEST_MARKDOWN_EXTENSIONS.includes(ext)
      if (!isCode && !isDoc) {
        skipped.push({ relPath: rel, reason: `extension '${ext || '(none)'}' is not code (TS/JS/Python) or markdown` })
        continue
      }

      const path = join(dir, entry.name)
      let bytes: number
      try {
        bytes = statSync(path).size
      } catch (err) {
        skipped.push({ relPath: rel, reason: `unreadable (${(err as Error).message})` })
        continue
      }
      if (bytes > INGEST_MAX_FILE_BYTES) {
        skipped.push({ relPath: rel, reason: `${bytes} bytes exceeds the ${INGEST_MAX_FILE_BYTES}-byte limit` })
        continue
      }
      try {
        if (sniffLooksBinary(path)) {
          skipped.push({ relPath: rel, reason: 'binary content (NUL bytes)' })
          continue
        }
      } catch (err) {
        skipped.push({ relPath: rel, reason: `unreadable (${(err as Error).message})` })
        continue
      }

      const file: WalkedFile = { path, relPath: rel, bytes }
      if (isCode) codeFiles.push(file)
      else docFiles.push(file)
    }
  }

  walk(root, '', [])
  return { codeFiles, docFiles, skipped }
}
