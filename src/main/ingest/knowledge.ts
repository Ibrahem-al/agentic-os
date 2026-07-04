/**
 * Knowledge ingestion (§18 write path, phase 06): documents become tagged,
 * embedded `Knowledge` chunks under a `Document` node.
 *
 * Pipeline: structure-aware chunk (chunker.ts) → BGE-M3 embed locally → ONE
 * write-lane job (§21 rule 1) that creates/updates the `Document`, writes the
 * `Knowledge` chunks with `HAS_CHUNK` edges, and `TAGGED` edges to the
 * provided tags (created in the Tag taxonomy when missing).
 *
 * Content-hash dedup (§18): an identical re-add is a NO-OP — detected by
 * direct reads before any embedding or lane job, so "zero writes" is literal.
 * A changed document deletes its old chunks and writes the new set (no
 * versioning; `ingested_at` carries freshness). Chunk ids embed the content
 * hash, so a replaced document's chunks never collide with the old ones.
 *
 * §21 rule 5: ingested content is DATA. It is chunked, embedded and stored —
 * never parsed for instructions, never able to trigger a tool call.
 */
import { createHash } from 'node:crypto'
import { readFileSync, statSync } from 'node:fs'
import { extname, isAbsolute, resolve } from 'node:path'
import {
  INGEST_DEFERRED_EXTENSIONS,
  INGEST_INLINE_SOURCE_PREFIX,
  INGEST_MARKDOWN_EXTENSIONS,
  INGEST_MAX_FILE_BYTES,
  INGEST_TEXT_EXTENSIONS,
  KNOWLEDGE_INGEST_PROVENANCE
} from '../config'
import type { StorageEngine } from '../storage'
import { chunkDocument, type ChunkFormat } from './chunker'

/** Structural (mirrors retrieval's Embedder): satisfied by OllamaClient. */
export interface KnowledgeEmbedder {
  embed(texts: string[]): Promise<number[][]>
}

export interface KnowledgeIngestDeps {
  readonly engine: StorageEngine
  readonly embedder: KnowledgeEmbedder
}

/** Maps 1:1 onto ToolError codes; ingest never imports the MCP layer. */
export type IngestErrorCode = 'INVALID_INPUT' | 'NOT_FOUND'

export class IngestError extends Error {
  readonly code: IngestErrorCode

  constructor(code: IngestErrorCode, message: string) {
    super(message)
    this.name = 'IngestError'
    this.code = code
  }
}

export interface IngestedTag {
  readonly id: string
  readonly name: string
  /** True when this ingest created the Tag node (vs. reusing an existing one). */
  readonly created: boolean
}

export interface IngestDocumentResult {
  readonly documentId: string
  readonly source: string
  /** `sha256:<hex>` of the raw document content. */
  readonly contentHash: string
  /** created = new Document; replaced = content changed; unchanged = no-op. */
  readonly status: 'created' | 'replaced' | 'unchanged'
  readonly chunkCount: number
  readonly chunkIds: readonly string[]
  /** Chunks of the previous version removed on replace (0 otherwise). */
  readonly deletedChunkCount: number
  readonly tags: readonly IngestedTag[]
}

export interface IngestContentOptions {
  /** Stable document identity (file path, URL, or inline:<hash>). */
  readonly source: string
  readonly tags?: readonly string[]
  readonly format?: ChunkFormat
}

const sha256Hex = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex')

/** Tag-id slug — shared with codebase ingestion so tag ids never drift. */
export const tagSlug = (name: string): string =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')

/**
 * Ingest raw document content under a stable `source` identity. The plain
 * function the MCP tool, the dashboard file-pick and the watched-folder scan
 * all call.
 */
export async function ingestKnowledgeContent(
  deps: KnowledgeIngestDeps,
  content: string,
  options: IngestContentOptions
): Promise<IngestDocumentResult> {
  const { engine, embedder } = deps
  const source = options.source.trim()
  if (source === '') throw new IngestError('INVALID_INPUT', 'ingest: source must be a non-empty string')
  if (content.trim() === '') {
    throw new IngestError('INVALID_INPUT', `ingest: document '${source}' has no content — nothing was ingested`)
  }
  if (content.includes('\u0000')) {
    throw new IngestError(
      'INVALID_INPUT',
      `ingest: document '${source}' looks binary (NUL bytes) — only text documents are supported`
    )
  }

  const contentHash = `sha256:${sha256Hex(content)}`

  // Dedup check first, via direct reads: an identical re-add must be a no-op
  // BEFORE any model call or lane job (§18 "identical re-adds skip").
  const existingRows = await engine.cypher(
    'MATCH (d:Document) WHERE d.source = $source RETURN d.id AS id, d.content_hash AS hash',
    { source }
  )
  const existing = existingRows[0]
  const documentId = existing ? String(existing['id']) : `doc-${sha256Hex(source).slice(0, 16)}`
  if (existing && String(existing['hash']) === contentHash) {
    const chunkRows = await engine.cypher(
      'MATCH (d:Document {id: $id})-[:HAS_CHUNK]->(k:Knowledge) RETURN k.id AS id ORDER BY k.id',
      { id: documentId }
    )
    return {
      documentId,
      source,
      contentHash,
      status: 'unchanged',
      chunkCount: chunkRows.length,
      chunkIds: chunkRows.map((r) => String(r['id'])),
      deletedChunkCount: 0,
      tags: []
    }
  }

  const chunks = chunkDocument(content, { format: options.format ?? 'markdown' })
  if (chunks.length === 0) {
    throw new IngestError('INVALID_INPUT', `ingest: document '${source}' produced no chunks — nothing was ingested`)
  }

  // Embed every chunk locally (BGE-M3 — the only embedding model), before the
  // lane job so the single writer is never blocked on a model call.
  const embeddings = await embedder.embed(chunks.map((c) => c.text))
  if (embeddings.length !== chunks.length) {
    throw new Error(`embedder returned ${embeddings.length} embeddings for ${chunks.length} chunks`)
  }

  // Resolve tag names → existing Tag nodes (exact-name match, same rule the
  // retrieval read path uses); missing ones are planned as new Tag nodes.
  const tagNames = [...new Set((options.tags ?? []).map((t) => t.trim()).filter((t) => t !== ''))]
  const tags: IngestedTag[] = []
  for (const name of tagNames) {
    const rows = await engine.cypher('MATCH (t:Tag) WHERE t.name = $name RETURN t.id AS id LIMIT 1', { name })
    const row = rows[0]
    if (row) {
      tags.push({ id: String(row['id']), name, created: false })
      continue
    }
    let id = `tag-${tagSlug(name) || sha256Hex(name).slice(0, 8)}`
    const idTaken = await engine.cypher('MATCH (t:Tag {id: $id}) RETURN t.name AS name LIMIT 1', { id })
    if (idTaken.length > 0) id = `${id}-${sha256Hex(name).slice(0, 6)}`
    tags.push({ id, name, created: true })
  }

  const hashPrefix = contentHash.slice('sha256:'.length, 'sha256:'.length + 8)
  const chunkIds = chunks.map((c) => `${documentId}-${hashPrefix}-c${c.index}`)
  const ingestedAt = new Date()

  // ONE lane job for the whole mutation (§21 rule 1): replace-on-change stays
  // consistent — no reader ever sees old and new chunk sets interleaved with
  // other writers' jobs.
  const deletedChunkCount = await engine.withWrite(async (tx) => {
    let deleted = 0
    if (existing) {
      const oldChunks = await tx.cypher(
        'MATCH (d:Document {id: $id})-[:HAS_CHUNK]->(k:Knowledge) RETURN count(k) AS c',
        { id: documentId }
      )
      deleted = Number(oldChunks[0]?.['c'] ?? 0)
      await tx.cypher('MATCH (d:Document {id: $id})-[:HAS_CHUNK]->(k:Knowledge) DETACH DELETE k', {
        id: documentId
      })
    }
    await tx.upsertNode('Document', {
      id: documentId,
      source,
      content_hash: contentHash,
      ingested_at: ingestedAt
    })
    for (const tag of tags) {
      if (tag.created) await tx.upsertNode('Tag', { id: tag.id, name: tag.name, is_global: false })
    }
    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i]
      const chunkId = chunkIds[i]
      const embedding = embeddings[i]
      if (!chunk || chunkId === undefined || !embedding) throw new Error('chunk/embedding arrays out of sync')
      await tx.upsertNode('Knowledge', {
        id: chunkId,
        content: chunk.text,
        embedding,
        extracted_by: KNOWLEDGE_INGEST_PROVENANCE,
        confidence: 1.0
      })
      await tx.createEdge('HAS_CHUNK', { label: 'Document', id: documentId }, { label: 'Knowledge', id: chunkId })
      for (const tag of tags) {
        await tx.createEdge('TAGGED', { label: 'Knowledge', id: chunkId }, { label: 'Tag', id: tag.id })
      }
    }
    return deleted
  })

  return {
    documentId,
    source,
    contentHash,
    status: existing ? 'replaced' : 'created',
    chunkCount: chunks.length,
    chunkIds,
    deletedChunkCount,
    tags
  }
}

/** Chunk format for a supported file, or a clear IngestError for the rest. */
export function fileChunkFormat(filePath: string): ChunkFormat {
  const ext = extname(filePath).toLowerCase()
  if (INGEST_MARKDOWN_EXTENSIONS.includes(ext)) return 'markdown'
  if (INGEST_TEXT_EXTENSIONS.includes(ext)) return 'plain'
  if (INGEST_DEFERRED_EXTENSIONS.includes(ext)) {
    throw new IngestError(
      'INVALID_INPUT',
      `ingest: '${ext}' documents are not supported yet (rich-document parsing is deferred) — ` +
        'convert to markdown or plain text first; nothing was ingested'
    )
  }
  throw new IngestError(
    'INVALID_INPUT',
    `ingest: unsupported file extension '${ext || '(none)'}' — supported: markdown (${INGEST_MARKDOWN_EXTENSIONS.join(
      ', '
    )}), plain text/source (${INGEST_TEXT_EXTENSIONS.join(', ')}); nothing was ingested`
  )
}

export interface IngestFileOptions {
  readonly tags?: readonly string[]
}

/** Ingest a file from disk; the resolved absolute path is the document source. */
export async function ingestKnowledgeFile(
  deps: KnowledgeIngestDeps,
  filePath: string,
  options: IngestFileOptions = {}
): Promise<IngestDocumentResult> {
  const absolute = resolve(filePath)
  const format = fileChunkFormat(absolute)
  let stats
  try {
    stats = statSync(absolute)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new IngestError('NOT_FOUND', `ingest: file not found: ${absolute} — nothing was ingested`)
    }
    throw err
  }
  if (stats.isDirectory()) {
    throw new IngestError(
      'INVALID_INPUT',
      `ingest: ${absolute} is a directory — ingest a single file, or add it as a watched folder`
    )
  }
  if (stats.size > INGEST_MAX_FILE_BYTES) {
    throw new IngestError(
      'INVALID_INPUT',
      `ingest: ${absolute} is ${stats.size} bytes (max ${INGEST_MAX_FILE_BYTES}) — nothing was ingested`
    )
  }
  const content = readFileSync(absolute, 'utf8')
  return ingestKnowledgeContent(deps, content, {
    source: absolute,
    format,
    ...(options.tags !== undefined ? { tags: options.tags } : {})
  })
}

/** True when the ingest input should be treated as a file path, not content. */
export function looksLikeFilePath(raw: string): boolean {
  const trimmed = raw.trim()
  if (trimmed === '' || trimmed.length > 4096 || trimmed.includes('\n')) return false
  return isAbsolute(trimmed) || /^[A-Za-z]:[\\/]/.test(trimmed)
}

/**
 * The `ingest_document(path_or_content, tags?)` entry point (§12): a
 * single-line absolute path ingests that file (missing file → NOT_FOUND);
 * anything else is ingested as inline content under a content-derived
 * `inline:<hash>` source, so identical inline re-adds dedup naturally.
 */
export async function ingestDocument(
  deps: KnowledgeIngestDeps,
  pathOrContent: string,
  tags: readonly string[] = []
): Promise<IngestDocumentResult> {
  if (looksLikeFilePath(pathOrContent)) {
    return ingestKnowledgeFile(deps, pathOrContent.trim(), { tags })
  }
  return ingestKnowledgeContent(deps, pathOrContent, {
    source: `${INGEST_INLINE_SOURCE_PREFIX}${sha256Hex(pathOrContent).slice(0, 16)}`,
    format: 'markdown',
    tags
  })
}
