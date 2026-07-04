/**
 * Watched-folder knowledge ingestion — DEFINITION + MANUAL TRIGGER only
 * (phase 06). Live file watching (chokidar, §7) and scheduling wire up in
 * phase 11; until then `scanWatchedFolder` is the trigger the dashboard (and
 * later the watcher) calls, and the store persists the definitions.
 *
 * Definitions live in userData/watched-folders.json — same zod-validated
 * atomic-write pattern as the MCP client manager's config. No secrets ever
 * belong in this file.
 */
import { readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname, extname, join } from 'node:path'
import * as z from 'zod'
import {
  INGEST_DEFERRED_EXTENSIONS,
  INGEST_MARKDOWN_EXTENSIONS,
  INGEST_MAX_FILE_BYTES,
  INGEST_TEXT_EXTENSIONS
} from '../config'
import { IngestError, ingestKnowledgeFile, type IngestDocumentResult, type KnowledgeIngestDeps } from './knowledge'

/** Every extension the knowledge pipeline accepts (markdown + plain/source). */
export const INGEST_SUPPORTED_EXTENSIONS: readonly string[] = [
  ...INGEST_MARKDOWN_EXTENSIONS,
  ...INGEST_TEXT_EXTENSIONS
]

const WatchedFolderSchema = z.object({
  /** Unique definition name (the store's key). */
  name: z.string().min(1),
  /** Absolute folder path to scan/watch. */
  path: z.string().min(1),
  /** Tag names applied to every ingested chunk. */
  tags: z.array(z.string()).default([]),
  /** Extension allowlist (dot-prefixed); default: everything supported. */
  extensions: z.array(z.string().regex(/^\./, 'extensions must start with a dot')).optional(),
  /** Phase-11 chokidar watching honors this; the manual scan ignores it. */
  enabled: z.boolean().default(true)
})
const WatchedFoldersConfigSchema = z.object({ folders: z.array(WatchedFolderSchema) })

export type WatchedFolder = z.output<typeof WatchedFolderSchema>

/** Persistent store of watched-folder definitions (userData JSON file). */
export class WatchedFolderStore {
  private readonly configPath: string

  constructor(deps: { configPath: string }) {
    this.configPath = deps.configPath
  }

  list(): WatchedFolder[] {
    return this.load().folders
  }

  add(definition: unknown): WatchedFolder {
    const parsed = WatchedFolderSchema.safeParse(definition)
    if (!parsed.success) {
      const detail = parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ')
      throw new Error(`invalid watched-folder definition — ${detail}`)
    }
    const config = this.load()
    if (config.folders.some((f) => f.name === parsed.data.name)) {
      throw new Error(`a watched folder named '${parsed.data.name}' already exists — remove it first`)
    }
    config.folders.push(parsed.data)
    this.save(config)
    return parsed.data
  }

  remove(name: string): boolean {
    const config = this.load()
    const remaining = config.folders.filter((f) => f.name !== name)
    if (remaining.length === config.folders.length) return false
    this.save({ folders: remaining })
    return true
  }

  private load(): { folders: WatchedFolder[] } {
    let raw: string
    try {
      raw = readFileSync(this.configPath, 'utf8')
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { folders: [] }
      throw err
    }
    const parsed = WatchedFoldersConfigSchema.safeParse(JSON.parse(raw))
    if (!parsed.success) {
      const detail = parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ')
      throw new Error(`${this.configPath} is not a valid watched-folders config — ${detail}`)
    }
    return { folders: [...parsed.data.folders] }
  }

  private save(config: { folders: WatchedFolder[] }): void {
    mkdirSync(dirname(this.configPath), { recursive: true })
    const tmpPath = `${this.configPath}.tmp`
    try {
      writeFileSync(tmpPath, `${JSON.stringify(config, null, 2)}\n`, 'utf8')
      renameSync(tmpPath, this.configPath)
    } catch (err) {
      rmSync(tmpPath, { force: true })
      throw err
    }
  }
}

export interface ScannedFileResult {
  readonly file: string
  readonly status: IngestDocumentResult['status']
  readonly chunkCount: number
}

export interface SkippedFile {
  readonly file: string
  readonly reason: string
}

export interface FailedFile {
  readonly file: string
  readonly error: string
}

export interface WatchedFolderScanResult {
  readonly folder: string
  readonly path: string
  /** Files considered (after directory pruning). */
  readonly scannedFiles: number
  readonly ingested: readonly ScannedFileResult[]
  readonly skipped: readonly SkippedFile[]
  readonly failed: readonly FailedFile[]
}

/** Directories never descended into during a scan. */
const PRUNED_DIRECTORIES = new Set(['node_modules', '.git'])

function* walkFiles(dir: string): Generator<string> {
  const entries = readdirSync(dir, { withFileTypes: true })
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (PRUNED_DIRECTORIES.has(entry.name) || entry.name.startsWith('.')) continue
      yield* walkFiles(join(dir, entry.name))
    } else if (entry.isFile()) {
      yield join(dir, entry.name)
    }
  }
}

/**
 * The manual trigger: scan a watched folder NOW and ingest every supported
 * file through the knowledge pipeline (content-hash dedup makes re-scans
 * cheap no-ops). Per-file failures are collected, never thrown — one bad file
 * must not abort a folder.
 */
export async function scanWatchedFolder(
  deps: KnowledgeIngestDeps,
  folder: WatchedFolder
): Promise<WatchedFolderScanResult> {
  let stats
  try {
    stats = statSync(folder.path)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new IngestError('NOT_FOUND', `watched folder '${folder.name}': path not found: ${folder.path}`)
    }
    throw err
  }
  if (!stats.isDirectory()) {
    throw new IngestError('INVALID_INPUT', `watched folder '${folder.name}': ${folder.path} is not a directory`)
  }

  const allowed = new Set((folder.extensions ?? INGEST_SUPPORTED_EXTENSIONS).map((e) => e.toLowerCase()))
  const ingested: ScannedFileResult[] = []
  const skipped: SkippedFile[] = []
  const failed: FailedFile[] = []
  let scannedFiles = 0

  for (const file of walkFiles(folder.path)) {
    scannedFiles += 1
    const ext = extname(file).toLowerCase()
    if (!allowed.has(ext)) {
      const reason = INGEST_DEFERRED_EXTENSIONS.includes(ext)
        ? `'${ext}' is deferred (rich-document parsing)`
        : `extension '${ext || '(none)'}' not in this folder's allowlist`
      skipped.push({ file, reason })
      continue
    }
    let size: number
    try {
      size = statSync(file).size
    } catch (err) {
      failed.push({ file, error: err instanceof Error ? err.message : String(err) })
      continue
    }
    if (size > INGEST_MAX_FILE_BYTES) {
      skipped.push({ file, reason: `${size} bytes exceeds the ${INGEST_MAX_FILE_BYTES}-byte limit` })
      continue
    }
    try {
      const result = await ingestKnowledgeFile(deps, file, { tags: folder.tags })
      ingested.push({ file, status: result.status, chunkCount: result.chunkCount })
    } catch (err) {
      failed.push({ file, error: err instanceof Error ? err.message : String(err) })
    }
  }

  return { folder: folder.name, path: folder.path, scannedFiles, ingested, skipped, failed }
}
