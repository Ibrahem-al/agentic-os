/**
 * Knowledge-ingestion barrel (§18 write path, phase 06). The MCP tool, the
 * dashboard (phase 10) and the watchers (phase 11) all import from here.
 */
export { chunkDocument, type ChunkFormat, type ChunkOptions, type DocumentChunk } from './chunker'
export {
  IngestError,
  fileChunkFormat,
  ingestDocument,
  ingestKnowledgeContent,
  ingestKnowledgeFile,
  looksLikeFilePath,
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
