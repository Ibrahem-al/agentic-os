/**
 * Ingestion barrel (§18 write paths: knowledge, phase 06; codebase, phase
 * 07). The MCP tools, the dashboard (phase 10) and the watchers (phase 11)
 * all import from here.
 */
export { chunkDocument, type ChunkFormat, type ChunkOptions, type DocumentChunk } from './chunker'
export {
  ingestCodebase,
  rootKeyOf,
  type CodebaseIngestDeps,
  type CodebaseIngestProgress,
  type IngestCodebaseOptions,
  type IngestCodebaseResult,
  type IngestedKnowledgeDoc,
  type ProjectSummarizer
} from './codebase'
export { walkCodebase, type CodebaseWalkResult, type SkippedWalkEntry, type WalkedFile } from './codebaseWalk'
export {
  codeLanguageForExtension,
  parseCodeFile,
  type CodeLanguage,
  type CodeUnit,
  type ImportBinding,
  type ParsedFile,
  type ReExport,
  type UnitKind
} from './codeParser'
export {
  IngestError,
  fileChunkFormat,
  ingestDocument,
  ingestKnowledgeContent,
  ingestKnowledgeFile,
  looksLikeFilePath,
  tagSlug,
  type IngestContentOptions,
  type IngestDocumentResult,
  type IngestErrorCode,
  type IngestFileOptions,
  type IngestedTag,
  type KnowledgeEmbedder,
  type KnowledgeIngestDeps
} from './knowledge'
export {
  INGEST_SUPPORTED_EXTENSIONS,
  WatchedFolderStore,
  scanWatchedFolder,
  type FailedFile,
  type ScannedFileResult,
  type SkippedFile,
  type WatchedFolder,
  type WatchedFolderScanResult
} from './watch'
