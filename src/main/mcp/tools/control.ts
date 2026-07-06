/**
 * Control tools (§12) — ingest_document, ingest_codebase.
 *
 * Both run the sanctioned §18 ingestion write paths (every mutation through the
 * single write lane). Content rides in as UntrustedText; the §13 scanner flags
 * suspicious input and the lane job logs an audited delta.
 */
import * as z from 'zod'
import { IngestError, ingestCodebase, ingestDocument } from '../../ingest'
import { ToolError, parse, jsonSchema, type McpToolDef, type ToolContext } from './shared'

const IngestDocumentInput = z.object({
  path_or_content: z.string().min(1).describe('Absolute file path, or the document content itself.'),
  tags: z.array(z.string()).optional().describe('Tag names for the ingested chunks.')
})

const IngestCodebaseInput = z.object({
  path: z.string().min(1).describe('Absolute folder path of the codebase.'),
  project: z.string().optional().describe('Project name to attach components to.')
})

async function ingestDocumentTool(args: unknown, ctx: ToolContext): Promise<unknown> {
  const input = parse(IngestDocumentInput, args, 'ingest_document')
  try {
    // The phase-06 pipeline: chunk → embed (the read path's embedder) → one
    // write-lane job. Content-hash dedup means identical re-adds are no-ops.
    // Phase 09: content rides in as UntrustedText, the §13 scanner flags
    // suspicious docs, and the lane job logs an audited delta.
    return await ingestDocument(
      {
        engine: ctx.engine,
        embedder: ctx.retrieval.embedder,
        ...(ctx.scanner !== undefined ? { scanner: ctx.scanner } : {}),
        ...(ctx.audit !== undefined ? { audit: { log: ctx.audit, agentId: `mcp:${ctx.sessionId}` } } : {})
      },
      input.path_or_content,
      input.tags ?? []
    )
  } catch (err) {
    if (err instanceof IngestError) throw new ToolError(err.code, err.message)
    throw err
  }
}

/** Skip-list entries echoed in the reply (full list stays in the function result). */
const INGEST_CODEBASE_SKIPPED_REPLY_CAP = 50

async function ingestCodebaseTool(args: unknown, ctx: ToolContext): Promise<unknown> {
  const input = parse(IngestCodebaseInput, args, 'ingest_codebase')
  try {
    // The phase-07 pipeline: gitignore walk → Tree-sitter units → Component
    // diff in one write-lane job → README/markdown/docstrings through the
    // phase-06 knowledge pipeline. Per-unit content hashes make re-ingests of
    // unchanged code zero-write no-ops.
    const result = await ingestCodebase(
      {
        engine: ctx.engine,
        embedder: ctx.retrieval.embedder,
        llm: ctx.llm,
        ...(ctx.router !== undefined ? { router: ctx.router } : {}),
        ...(ctx.scanner !== undefined ? { scanner: ctx.scanner } : {}),
        ...(ctx.audit !== undefined ? { audit: { log: ctx.audit, agentId: `mcp:${ctx.sessionId}` } } : {})
      },
      input.path,
      input.project !== undefined ? { project: input.project } : {}
    )
    return {
      ...result,
      skipped: result.skipped.slice(0, INGEST_CODEBASE_SKIPPED_REPLY_CAP),
      skippedTotal: result.skipped.length
    }
  } catch (err) {
    if (err instanceof IngestError) throw new ToolError(err.code, err.message)
    throw err
  }
}

export const CONTROL_TOOL_DEFS: readonly McpToolDef[] = [
  {
    name: 'ingest_document',
    description:
      'Ingest a document into knowledge memory: structure-aware chunking (headings/code fences, ~512 tokens), ' +
      'local embeddings, content-hash dedup (identical re-adds are no-ops; changed documents replace their old chunks). ' +
      'Pass an absolute file path (markdown/plain text/source; PDF is not supported) or the document content itself; ' +
      'optional tags attach to every chunk.',
    inputSchema: jsonSchema(IngestDocumentInput),
    handle: ingestDocumentTool
  },
  {
    name: 'ingest_codebase',
    description:
      'Ingest a codebase folder into component memory: gitignore-respecting walk, Tree-sitter parsing ' +
      '(TypeScript/JavaScript/Python) into meaningful units (exported functions/classes, routes, data models) ' +
      'as Component nodes with DEPENDS_ON edges, attached to a Project matched by path or created with a ' +
      'README-derived summary. READMEs, markdown and docstrings become Knowledge chunks tagged to the Project. ' +
      'Per-unit content hashes: re-ingesting unchanged code is a no-op.',
    inputSchema: jsonSchema(IngestCodebaseInput),
    handle: ingestCodebaseTool
  }
]
