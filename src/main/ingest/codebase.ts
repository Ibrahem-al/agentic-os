/**
 * Codebase ingestion (§18 write path, phase 07): point at a repo folder →
 * `Component` graph + code-doc `Knowledge`, automatically.
 *
 * Pipeline: gitignore-respecting walk (codebaseWalk.ts) → Tree-sitter unit
 * extraction (codeParser.ts) → import/re-export resolution into unit-level
 * DEPENDS_ON pairs → match-or-create the `Project` (matched by path-derived
 * identity; created with a README summary from the LOCAL small LLM) → ONE
 * write-lane job (§21 rule 1) applying the component DIFF → README/markdown/
 * docstrings through the phase-06 knowledge pipeline, tagged to the Project.
 *
 * Per-unit content-hash (§18 "re-ingest replaces only changed units"): a
 * Component id embeds its unit's source hash — an unchanged unit maps to an
 * id that already exists (zero writes for it), a changed unit becomes a new
 * id while the stale one is deleted in the same lane job. An identical
 * re-ingest performs ZERO lane jobs and ZERO model calls.
 *
 * Provenance (§21 rule 4): every Component node and every edge this pipeline
 * writes is stamped `extracted_by = CODEBASE_INGEST_PROVENANCE`,
 * `confidence = 1.0` (parsing is deterministic).
 *
 * §21 rules 3+5: parsed code is DATA — it is never executed and never
 * interpreted as instructions.
 */
import { createHash } from 'node:crypto'
import { readFileSync, statSync } from 'node:fs'
import { basename, extname, join, posix, resolve, sep } from 'node:path'
import {
  CODEBASE_DOCS_SOURCE_PREFIX,
  CODEBASE_INGEST_PROVENANCE,
  CODEBASE_README_PROMPT_MAX_CHARS,
  CODEBASE_SUMMARY_FALLBACK_MAX_CHARS,
  CODEBASE_SUMMARY_MAX_TOKENS,
  INGEST_MARKDOWN_EXTENSIONS
} from '../config'
import type { StorageEngine, WriteTx } from '../storage'
import {
  IngestError,
  ingestKnowledgeContent,
  ingestKnowledgeFile,
  tagSlug,
  type KnowledgeEmbedder
} from './knowledge'
import { walkCodebase, type SkippedWalkEntry, type WalkedFile } from './codebaseWalk'
import { codeLanguageForExtension, parseCodeFile, type CodeUnit, type ParsedFile } from './codeParser'

/** Structural (satisfied by OllamaClient): the LOCAL small LLM for summaries. */
export interface ProjectSummarizer {
  generate(
    prompt: string,
    options?: { system?: string; maxTokens?: number; temperature?: number }
  ): Promise<{ text: string }>
}

export interface CodebaseIngestDeps {
  readonly engine: StorageEngine
  readonly embedder: KnowledgeEmbedder
  /** README → Project summary (§18). Failures degrade to a deterministic fallback. */
  readonly llm: ProjectSummarizer
}

/** Progress events for the dashboard (phase 10) — n files / n components. */
export interface CodebaseIngestProgress {
  readonly phase: 'walking' | 'parsing' | 'writing' | 'knowledge'
  readonly filesWalked: number
  readonly codeFilesParsed: number
  readonly componentsFound: number
  readonly currentFile?: string
}

export interface IngestCodebaseOptions {
  /** Attach components to this Project (exact name match; created if missing). */
  readonly project?: string
  readonly onProgress?: (progress: CodebaseIngestProgress) => void
}

export interface IngestedKnowledgeDoc {
  readonly source: string
  readonly status: 'created' | 'replaced' | 'unchanged'
  readonly chunkCount: number
}

export interface IngestCodebaseResult {
  readonly root: string
  readonly projectId: string
  readonly projectName: string
  readonly projectCreated: boolean
  /** created = new Project; updated = graph changed; unchanged = full no-op. */
  readonly status: 'created' | 'updated' | 'unchanged'
  readonly filesWalked: number
  readonly codeFilesParsed: number
  readonly components: { total: number; created: number; deleted: number; unchanged: number }
  readonly dependsOn: { total: number; created: number; deleted: number }
  readonly knowledge: {
    readonly documents: readonly IngestedKnowledgeDoc[]
    /** Sources of stale codebase docs removed this run (deleted files, emptied docstrings). */
    readonly pruned: readonly string[]
    readonly failed: readonly { file: string; error: string }[]
  }
  readonly skipped: readonly SkippedWalkEntry[]
}

const sha256Hex = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex')
const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** Identifier-shaped unit names are reference-matchable; route names are not. */
const IDENTIFIER_RE = /^[A-Za-z_$][\w$]*$/

// ── Identity (deterministic, path-derived — the "match by path" key) ─────────

/**
 * Case-normalized on win32 so the same folder always yields the same key.
 * Exported for the extraction agent (phase 08): a session's cwd must derive
 * the SAME `proj-<rootKey>` identity this pipeline uses, or "match by path"
 * would split one repo into two Projects.
 */
export function rootKeyOf(root: string): string {
  const canonical = process.platform === 'win32' ? root.toLowerCase() : root
  return sha256Hex(canonical).slice(0, 16)
}

export interface DesiredComponent {
  readonly id: string
  readonly name: string
  readonly type: CodeUnit['kind']
  readonly relPath: string
  readonly unit: CodeUnit
}

function componentIdOf(rootKey: string, relPath: string, unit: CodeUnit): string {
  const scope = sha256Hex(`${relPath}\n${unit.kind}\n${unit.name}`).slice(0, 16)
  const hash8 = unit.contentHash.replace(/^sha256:/, '').slice(0, 8)
  return `cmp-${rootKey}-${scope}-${hash8}`
}

// ── Import-specifier resolution (repo-internal only) ─────────────────────────

const TS_EXTENSIONS = ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs']
const TS_SWAPS: readonly (readonly [RegExp, string[]])[] = [
  [/\.js$/, ['.ts', '.tsx']],
  [/\.mjs$/, ['.mts']],
  [/\.cjs$/, ['.cts']]
]

function resolveTsSpecifier(fromRel: string, spec: string, files: ReadonlySet<string>): string | null {
  if (!spec.startsWith('./') && !spec.startsWith('../')) return null // packages are external
  const target = posix.normalize(posix.join(posix.dirname(fromRel), spec))
  if (target.startsWith('../')) return null // escapes the root
  const candidates = [target, ...TS_EXTENSIONS.map((ext) => `${target}${ext}`)]
  for (const [pattern, exts] of TS_SWAPS) {
    if (pattern.test(target)) candidates.push(...exts.map((ext) => target.replace(pattern, ext)))
  }
  for (const ext of TS_EXTENSIONS) candidates.push(`${target}/index${ext}`)
  return candidates.find((c) => files.has(c)) ?? null
}

function resolvePySpecifier(fromRel: string, spec: string, files: ReadonlySet<string>): string | null {
  const dots = /^\.*/.exec(spec)?.[0].length ?? 0
  const rest = spec.slice(dots)
  const parts = rest === '' ? [] : rest.split('.')
  const bases: string[] = []
  if (dots > 0) {
    let dir = posix.dirname(fromRel)
    for (let i = 1; i < dots; i++) dir = posix.dirname(dir)
    bases.push(dir === '.' ? '' : `${dir}/`)
  } else {
    bases.push('') // root-relative package
    const fileDir = posix.dirname(fromRel)
    if (fileDir !== '.') bases.push(`${fileDir}/`) // sibling-module import
  }
  for (const base of bases) {
    const stem = `${base}${parts.join('/')}`.replace(/\/$/, '')
    for (const candidate of [`${stem}.py`, `${stem}/__init__.py`]) {
      const normalized = posix.normalize(candidate)
      if (!normalized.startsWith('../') && files.has(normalized)) return normalized
    }
  }
  return null
}

function resolveSpecifier(from: ParsedFile, spec: string, files: ReadonlySet<string>): string | null {
  return from.language === 'python'
    ? resolvePySpecifier(from.relPath, spec, files)
    : resolveTsSpecifier(from.relPath, spec, files)
}

// ── Export resolution (follows barrels / __init__ imports) ───────────────────

interface ResolvedUnit {
  readonly relPath: string
  readonly unit: CodeUnit
}

interface FileIndex {
  readonly byPath: ReadonlyMap<string, ParsedFile>
  readonly paths: ReadonlySet<string>
  readonly unitsByName: ReadonlyMap<string, ReadonlyMap<string, CodeUnit>>
}

function indexFiles(parsed: readonly ParsedFile[]): FileIndex {
  const byPath = new Map<string, ParsedFile>()
  const unitsByName = new Map<string, Map<string, CodeUnit>>()
  for (const file of parsed) {
    byPath.set(file.relPath, file)
    const names = new Map<string, CodeUnit>()
    for (const unit of file.units) if (!names.has(unit.name)) names.set(unit.name, unit)
    unitsByName.set(file.relPath, names)
  }
  return { byPath, paths: new Set(byPath.keys()), unitsByName }
}

/**
 * Resolve `name` exported from `relPath` to the unit that defines it,
 * following TS re-export chains (`export … from`) and Python's
 * import-into-module surface (a name imported by `__init__.py` IS importable
 * from the package). Cycle- and depth-safe.
 */
function resolveExport(index: FileIndex, relPath: string, name: string, seen: Set<string>): ResolvedUnit | null {
  const key = `${relPath}\n${name}`
  if (seen.has(key) || seen.size > 64) return null
  seen.add(key)
  const file = index.byPath.get(relPath)
  if (!file) return null
  const unit = index.unitsByName.get(relPath)?.get(name)
  if (unit) return { relPath, unit }
  for (const re of file.reexports) {
    if (re.exported !== name && re.exported !== '*') continue
    const target = resolveSpecifier(file, re.specifier, index.paths)
    if (!target) continue
    const resolved = resolveExport(index, target, re.exported === '*' ? name : re.imported, seen)
    if (resolved) return resolved
  }
  if (file.language === 'python') {
    for (const imp of file.imports) {
      if (imp.local !== name || imp.imported === '*') continue
      const target = resolveSpecifier(file, imp.specifier, index.paths)
      if (!target) continue
      const resolved = resolveExport(index, target, imp.imported, seen)
      if (resolved) return resolved
    }
  }
  return null
}

// ── DEPENDS_ON derivation (imports × references inside unit bodies) ──────────

function dependencyPairs(
  index: FileIndex,
  components: ReadonlyMap<string, DesiredComponent>,
  idOf: (relPath: string, unit: CodeUnit) => string
): Set<string> {
  const pairs = new Set<string>()
  const link = (fromId: string, target: ResolvedUnit): void => {
    const toId = idOf(target.relPath, target.unit)
    if (fromId !== toId && components.has(toId)) pairs.add(`${fromId}\n${toId}`)
  }

  for (const file of index.byPath.values()) {
    if (file.units.length === 0) continue
    for (const binding of file.imports) {
      const target = resolveSpecifier(file, binding.specifier, index.paths)
      if (!target || target === file.relPath) continue

      if (binding.imported === '*' && binding.local === '*') {
        // Python `from mod import *`: every identifier-named unit of the
        // target is directly usable.
        const targetFile = index.byPath.get(target)
        if (!targetFile) continue
        for (const targetUnit of targetFile.units) {
          if (!IDENTIFIER_RE.test(targetUnit.name)) continue
          const re = new RegExp(`\\b${escapeRegExp(targetUnit.name)}\\b`)
          for (const unit of file.units) {
            if (re.test(unit.text)) link(idOf(file.relPath, unit), { relPath: target, unit: targetUnit })
          }
        }
        continue
      }

      if (binding.imported === '*') {
        // Namespace/module import: `ns.member` / `pkg.mod.member` usages.
        const attrRe = new RegExp(`\\b${escapeRegExp(binding.local)}\\.([A-Za-z_$][\\w$]*)`, 'g')
        for (const unit of file.units) {
          const fromId = idOf(file.relPath, unit)
          for (const match of unit.text.matchAll(attrRe)) {
            const member = match[1]
            if (member === undefined) continue
            const resolved = resolveExport(index, target, member, new Set())
            if (resolved) link(fromId, resolved)
          }
        }
        continue
      }

      const resolved = resolveExport(index, target, binding.imported, new Set())
      if (!resolved) continue
      const re = new RegExp(`\\b${escapeRegExp(binding.local)}\\b`)
      for (const unit of file.units) {
        if (re.test(unit.text)) link(idOf(file.relPath, unit), resolved)
      }
    }
  }
  return pairs
}

// ── Project match / create (§18: match by path, summary from README) ─────────

interface ProjectPlan {
  readonly id: string
  readonly name: string
  /** Set only when the Project must be created in this run's lane job. */
  readonly create?: { summary: string; embedding: number[] }
}

function packageJsonName(root: string): string | null {
  try {
    const parsed = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { name?: unknown }
    return typeof parsed.name === 'string' && parsed.name.trim() !== '' ? parsed.name.trim() : null
  } catch {
    return null
  }
}

function pickReadme(docFiles: readonly WalkedFile[]): WalkedFile | null {
  const atRoot = docFiles.filter((f) => !f.relPath.includes('/'))
  return (
    atRoot.find((f) => f.relPath.toLowerCase() === 'readme.md') ??
    atRoot.find((f) => f.relPath.toLowerCase().startsWith('readme.')) ??
    atRoot[0] ??
    docFiles[0] ??
    null
  )
}

/** Deterministic fallback: the README's first prose paragraph, or a stub. */
function fallbackSummary(readmeContent: string | null, root: string, codeFileCount: number): string {
  if (readmeContent !== null) {
    const paragraphs = readmeContent.split(/\r?\n\s*\r?\n/)
    for (const paragraph of paragraphs) {
      const text = paragraph.replace(/\s+/g, ' ').trim()
      if (text === '' || text.startsWith('#') || text.startsWith('[![') || text.startsWith('<')) continue
      return text.slice(0, CODEBASE_SUMMARY_FALLBACK_MAX_CHARS)
    }
  }
  return `Codebase ingested from ${root} (${codeFileCount} source files).`
}

/**
 * Reject small-LLM replies that narrate instead of summarizing (phase-04
 * finding: qwen3 sometimes narrates its reasoning even with think off). A
 * narrated reply that carries the summary in quotes is rescued from the
 * quotes; anything else falls back to the deterministic README summary.
 */
const SUMMARY_NARRATION_RE = /\b(we are|we need|let's|let us|i will|i'll|the user|reply with|summariz)/i

function acceptSummary(raw: string): string | null {
  const text = raw.replace(/\s+/g, ' ').trim()
  if (text.length >= 20 && text.length <= 600 && !SUMMARY_NARRATION_RE.test(text)) return text
  const quoted = [...text.matchAll(/"([^"]{40,600})"/g)].map((m) => m[1] ?? '')
  const rescue = quoted[quoted.length - 1]?.trim() ?? ''
  if (rescue.length >= 40 && !SUMMARY_NARRATION_RE.test(rescue)) return rescue
  return null
}

async function summarizeReadme(llm: ProjectSummarizer, readmeContent: string): Promise<string | null> {
  try {
    const result = await llm.generate(
      'Summarize this codebase README in two or three plain sentences: what the project is and what it does. ' +
        'Reply with only the summary.\n\nREADME:\n' +
        readmeContent.slice(0, CODEBASE_README_PROMPT_MAX_CHARS),
      {
        system:
          'You write short project summaries for a memory graph. Output ONLY the summary sentences — ' +
          'no preamble, no reasoning, no quotation marks.',
        maxTokens: CODEBASE_SUMMARY_MAX_TOKENS,
        temperature: 0
      }
    )
    return acceptSummary(result.text)
  } catch {
    return null // local tier unavailable — the deterministic fallback covers it
  }
}

async function planProject(
  deps: CodebaseIngestDeps,
  root: string,
  rootKey: string,
  options: IngestCodebaseOptions,
  docFiles: readonly WalkedFile[],
  codeFileCount: number
): Promise<ProjectPlan> {
  const { engine } = deps
  const pathDerivedId = `proj-${rootKey}`

  if (options.project !== undefined) {
    const name = options.project.trim()
    if (name === '') throw new IngestError('INVALID_INPUT', 'ingest: project name must be non-empty when provided')
    const rows = await engine.cypher('MATCH (p:Project) WHERE p.name = $name RETURN p.id AS id LIMIT 1', { name })
    const row = rows[0]
    if (row) return { id: String(row['id']), name }
    // Creating under an explicit name: if a differently-named project already
    // holds the path-derived id (an earlier unnamed ingest of this root), a
    // name-derived id keeps them distinct — the same (root, name) pair always
    // resolves back here via the name match above.
    const pathIdTaken = await engine.cypher('MATCH (p:Project {id: $id}) RETURN p.id AS id LIMIT 1', {
      id: pathDerivedId
    })
    const id = pathIdTaken.length === 0 ? pathDerivedId : `proj-${rootKey}-${sha256Hex(name).slice(0, 8)}`
    return { id, name, create: await buildCreate(name) }
  }

  const byPath = await engine.cypher('MATCH (p:Project {id: $id}) RETURN p.name AS name LIMIT 1', {
    id: pathDerivedId
  })
  const pathRow = byPath[0]
  if (pathRow) return { id: pathDerivedId, name: String(pathRow['name'] ?? basename(root)) }

  // A project that already owns this root's components (created under another
  // name/id — e.g. by a named first ingest or the extraction agent).
  const byComponents = await engine.cypher(
    `MATCH (p:Project)-[:HAS_COMPONENT]->(c:Component)
     WHERE c.id STARTS WITH $prefix RETURN DISTINCT p.id AS id, p.name AS name LIMIT 1`,
    { prefix: `cmp-${rootKey}-` }
  )
  const componentRow = byComponents[0]
  if (componentRow) {
    return { id: String(componentRow['id']), name: String(componentRow['name'] ?? basename(root)) }
  }

  const name = packageJsonName(root) ?? basename(root)
  return { id: pathDerivedId, name, create: await buildCreate(name) }

  async function buildCreate(name: string): Promise<{ summary: string; embedding: number[] }> {
    const readme = pickReadme(docFiles)
    const readmeContent = readme ? readFileSync(readme.path, 'utf8') : null
    const summary =
      (readmeContent !== null ? await summarizeReadme(deps.llm, readmeContent) : null) ??
      fallbackSummary(readmeContent, root, codeFileCount)
    // Embed exactly what retrieval renders for a Project ("name — summary").
    const embedding = (await deps.embedder.embed([`${name} — ${summary}`]))[0]
    if (!embedding) throw new Error('embedder returned no embedding for the project summary')
    return { summary, embedding }
  }
}

// ── Knowledge docs (README/markdown/docstrings → phase-06 pipeline) ──────────

function docstringDigest(file: ParsedFile): string | null {
  const documented = file.units.filter((u) => u.doc !== '')
  if (documented.length === 0) return null
  const sections = documented.map((u) => `## ${u.name}\n\n${u.doc}`)
  return `# Code documentation — ${file.relPath}\n\n${sections.join('\n\n')}\n`
}

/** True for Document sources this pipeline (and only it) produces for `root`. */
function isCodebaseDocSource(source: string, root: string): boolean {
  const rootPrefix = root.endsWith(sep) ? root : `${root}${sep}`
  const normalize = (p: string): string => (process.platform === 'win32' ? p.toLowerCase() : p)
  const docsPrefix = `${CODEBASE_DOCS_SOURCE_PREFIX}${rootPrefix}`
  if (normalize(source).startsWith(normalize(docsPrefix))) return true
  return (
    normalize(source).startsWith(normalize(rootPrefix)) &&
    INGEST_MARKDOWN_EXTENSIONS.includes(extname(source).toLowerCase())
  )
}

// ── Entry point ──────────────────────────────────────────────────────────────

/**
 * Ingest a codebase folder (the `ingest_codebase` tool body and the phase-10
 * dashboard folder-pick both call this). Never executes the code it parses.
 */
export async function ingestCodebase(
  deps: CodebaseIngestDeps,
  rootPath: string,
  options: IngestCodebaseOptions = {}
): Promise<IngestCodebaseResult> {
  const { engine, embedder } = deps
  if (rootPath.trim() === '') throw new IngestError('INVALID_INPUT', 'ingest: codebase path must be non-empty')
  const root = resolve(rootPath.trim())
  let stats
  try {
    stats = statSync(root)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new IngestError('NOT_FOUND', `ingest: codebase folder not found: ${root} — nothing was ingested`)
    }
    throw err
  }
  if (!stats.isDirectory()) {
    throw new IngestError(
      'INVALID_INPUT',
      `ingest: ${root} is a file — point ingest_codebase at the repo root folder (use ingest_document for single files)`
    )
  }

  const rootKey = rootKeyOf(root)
  const componentPrefix = `cmp-${rootKey}-`
  const progress = (p: CodebaseIngestProgress): void => options.onProgress?.(p)

  // 1) Walk (gitignore-respecting; node_modules/binaries/>1MB skipped).
  const walk = walkCodebase(root)
  const filesWalked = walk.codeFiles.length + walk.docFiles.length + walk.skipped.length
  progress({ phase: 'walking', filesWalked, codeFilesParsed: 0, componentsFound: 0 })

  // 2) Parse every code file into meaningful units (per-unit content hash).
  const parsed: ParsedFile[] = []
  let componentsFound = 0
  for (const file of walk.codeFiles) {
    const language = codeLanguageForExtension(extname(file.relPath))
    if (!language) continue // unreachable: the walk only admits code extensions
    const source = readFileSync(file.path, 'utf8')
    const parsedFile = await parseCodeFile(file.relPath, language, source)
    parsed.push(parsedFile)
    componentsFound += parsedFile.units.length
    progress({
      phase: 'parsing',
      filesWalked,
      codeFilesParsed: parsed.length,
      componentsFound,
      currentFile: file.relPath
    })
  }
  const index = indexFiles(parsed)

  // 3) Desired component set + DEPENDS_ON pairs.
  const desired = new Map<string, DesiredComponent>()
  for (const file of parsed) {
    for (const unit of file.units) {
      const id = componentIdOf(rootKey, file.relPath, unit)
      desired.set(id, { id, name: `${file.relPath}:${unit.name}`, type: unit.kind, relPath: file.relPath, unit })
    }
  }
  const idOf = (relPath: string, unit: CodeUnit): string => componentIdOf(rootKey, relPath, unit)
  const desiredEdges = dependencyPairs(index, desired, idOf)

  // 4) Project (match by path → create with README summary) + current graph
  //    state — all reads, before any write.
  const project = await planProject(deps, root, rootKey, options, walk.docFiles, walk.codeFiles.length)

  const existingComponentRows = await engine.cypher(
    'MATCH (c:Component) WHERE c.id STARTS WITH $prefix RETURN c.id AS id',
    { prefix: componentPrefix }
  )
  const existingComponents = new Set(existingComponentRows.map((r) => String(r['id'])))
  const existingEdgeRows = await engine.cypher(
    `MATCH (a:Component)-[r:DEPENDS_ON]->(b:Component)
     WHERE a.id STARTS WITH $prefix AND b.id STARTS WITH $prefix
     RETURN a.id AS f, b.id AS t`,
    { prefix: componentPrefix }
  )
  const existingEdges = new Set(existingEdgeRows.map((r) => `${String(r['f'])}\n${String(r['t'])}`))
  const linkedRows = project.create
    ? []
    : await engine.cypher('MATCH (p:Project {id: $id})-[:HAS_COMPONENT]->(c:Component) RETURN c.id AS id', {
        id: project.id
      })
  const linkedComponents = new Set(linkedRows.map((r) => String(r['id'])))

  const tagRows = await engine.cypher('MATCH (t:Tag) WHERE t.name = $name RETURN t.id AS id LIMIT 1', {
    name: project.name
  })
  const tagRow = tagRows[0]
  let tagId = tagRow ? String(tagRow['id']) : `tag-${tagSlug(project.name) || sha256Hex(project.name).slice(0, 8)}`
  const tagCreate = !tagRow
  if (tagCreate) {
    const idTaken = await engine.cypher('MATCH (t:Tag {id: $id}) RETURN t.id AS id LIMIT 1', { id: tagId })
    if (idTaken.length > 0) tagId = `${tagId}-${sha256Hex(project.name).slice(0, 6)}`
  }
  const taggedRows = project.create
    ? []
    : await engine.cypher('MATCH (p:Project {id: $pid})-[:TAGGED]->(t:Tag {id: $tid}) RETURN p.id AS id LIMIT 1', {
        pid: project.id,
        tid: tagId
      })
  const projectNeedsTag = taggedRows.length === 0

  // 5) The diff (per-unit content hash makes unchanged units no-ops).
  const newComponents = [...desired.keys()].filter((id) => !existingComponents.has(id)).sort()
  const staleComponents = [...existingComponents].filter((id) => !desired.has(id)).sort()
  const survivors = new Set([...existingComponents].filter((id) => desired.has(id)))
  const staleEdges = [...existingEdges]
    .filter((pair) => {
      const [from, to] = pair.split('\n')
      return from !== undefined && to !== undefined && survivors.has(from) && survivors.has(to) && !desiredEdges.has(pair)
    })
    .sort()
  const newEdges = [...desiredEdges].filter((pair) => !existingEdges.has(pair)).sort()
  const unlinkedComponents = [...desired.keys()].filter((id) => !linkedComponents.has(id) && !newComponents.includes(id))

  const provenance = { extracted_by: CODEBASE_INGEST_PROVENANCE, confidence: 1.0 } as const
  const graphNeedsWrite =
    project.create !== undefined ||
    tagCreate ||
    projectNeedsTag ||
    newComponents.length > 0 ||
    staleComponents.length > 0 ||
    staleEdges.length > 0 ||
    newEdges.length > 0 ||
    unlinkedComponents.length > 0

  progress({ phase: 'writing', filesWalked, codeFilesParsed: parsed.length, componentsFound })

  // 6) ONE lane job for the whole component-graph mutation (§21 rule 1).
  if (graphNeedsWrite) {
    await engine.withWrite(async (tx: WriteTx) => {
      if (project.create) {
        await tx.upsertNode('Project', {
          id: project.id,
          name: project.name,
          summary: project.create.summary,
          embedding: project.create.embedding
        })
      }
      if (tagCreate) await tx.upsertNode('Tag', { id: tagId, name: project.name, is_global: false })
      if (projectNeedsTag) {
        await tx.createEdge('TAGGED', { label: 'Project', id: project.id }, { label: 'Tag', id: tagId }, provenance)
      }
      if (staleComponents.length > 0) {
        await tx.cypher('UNWIND $ids AS cid MATCH (c:Component {id: cid}) DETACH DELETE c', {
          ids: staleComponents
        })
      }
      for (const pair of staleEdges) {
        const [from, to] = pair.split('\n')
        if (from === undefined || to === undefined) continue
        await tx.cypher(
          'MATCH (a:Component {id: $from})-[r:DEPENDS_ON]->(b:Component {id: $to}) DELETE r',
          { from, to }
        )
      }
      for (const id of newComponents) {
        const component = desired.get(id)
        if (!component) continue
        await tx.upsertNode('Component', { id, name: component.name, type: component.type, ...provenance })
      }
      for (const id of [...newComponents, ...unlinkedComponents]) {
        await tx.createEdge('HAS_COMPONENT', { label: 'Project', id: project.id }, { label: 'Component', id }, provenance)
      }
      for (const pair of newEdges) {
        const [from, to] = pair.split('\n')
        if (from === undefined || to === undefined) continue
        await tx.createEdge('DEPENDS_ON', { label: 'Component', id: from }, { label: 'Component', id: to }, provenance)
      }
    })
  }

  // 7) README/markdown + docstrings through the phase-06 knowledge pipeline,
  //    tagged to the Project (content-hash dedup keeps re-runs cheap).
  const documents: IngestedKnowledgeDoc[] = []
  const failed: { file: string; error: string }[] = []
  const producedSources = new Set<string>()
  const knowledgeDeps = { engine, embedder }
  for (const doc of walk.docFiles) {
    progress({ phase: 'knowledge', filesWalked, codeFilesParsed: parsed.length, componentsFound, currentFile: doc.relPath })
    try {
      const result = await ingestKnowledgeFile(knowledgeDeps, doc.path, { tags: [project.name] })
      producedSources.add(result.source)
      documents.push({ source: result.source, status: result.status, chunkCount: result.chunkCount })
    } catch (err) {
      failed.push({ file: doc.relPath, error: err instanceof Error ? err.message : String(err) })
    }
  }
  for (const file of parsed) {
    const digest = docstringDigest(file)
    if (digest === null) continue
    const source = `${CODEBASE_DOCS_SOURCE_PREFIX}${join(root, ...file.relPath.split('/'))}`
    progress({ phase: 'knowledge', filesWalked, codeFilesParsed: parsed.length, componentsFound, currentFile: file.relPath })
    try {
      const result = await ingestKnowledgeContent(knowledgeDeps, digest, {
        source,
        tags: [project.name],
        format: 'markdown'
      })
      producedSources.add(result.source)
      documents.push({ source: result.source, status: result.status, chunkCount: result.chunkCount })
    } catch (err) {
      failed.push({ file: file.relPath, error: err instanceof Error ? err.message : String(err) })
    }
  }

  // 8) Prune codebase docs that no longer exist (deleted/emptied since the
  //    last ingest): project-tagged documents under this root not produced now.
  const taggedDocRows = await engine.cypher(
    `MATCH (d:Document)-[:HAS_CHUNK]->(k:Knowledge)-[:TAGGED]->(t:Tag {id: $tagId})
     RETURN DISTINCT d.id AS id, d.source AS source`,
    { tagId }
  )
  const staleDocs = taggedDocRows
    .map((r) => ({ id: String(r['id']), source: String(r['source']) }))
    .filter((d) => isCodebaseDocSource(d.source, root) && !producedSources.has(d.source))
    .sort((a, b) => (a.source < b.source ? -1 : 1))
  if (staleDocs.length > 0) {
    await engine.withWrite(async (tx) => {
      for (const doc of staleDocs) {
        await tx.cypher('MATCH (d:Document {id: $id})-[:HAS_CHUNK]->(k:Knowledge) DETACH DELETE k', { id: doc.id })
        await tx.cypher('MATCH (d:Document {id: $id}) DETACH DELETE d', { id: doc.id })
      }
    })
  }

  const knowledgeChanged = documents.some((d) => d.status !== 'unchanged') || staleDocs.length > 0
  const status: IngestCodebaseResult['status'] = project.create
    ? 'created'
    : graphNeedsWrite || knowledgeChanged
      ? 'updated'
      : 'unchanged'

  return {
    root,
    projectId: project.id,
    projectName: project.name,
    projectCreated: project.create !== undefined,
    status,
    filesWalked,
    codeFilesParsed: parsed.length,
    components: {
      total: desired.size,
      created: newComponents.length,
      deleted: staleComponents.length,
      unchanged: survivors.size
    },
    dependsOn: { total: desiredEdges.size, created: newEdges.length, deleted: staleEdges.length },
    knowledge: { documents, pruned: staleDocs.map((d) => d.source), failed },
    skipped: walk.skipped
  }
}
