/**
 * Memory-editing surface (feature B): dashboard-only graph/KB CRUD. The IPC
 * layer is the ONLY caller — never exposed over MCP (§21 rule 6: Claude's
 * write path stays propose_correction → staged → validated).
 */
export {
  createMemoryEdge,
  createMemoryNode,
  deleteMemoryEdge,
  deleteMemoryNode,
  MemoryEditError,
  PROTECTED_NODE_KEYS,
  updateMemoryNode,
  type DeleteNodeResult,
  type EdgeMutationResult,
  type MemoryEditDeps,
  type MemoryEditErrorCode,
  type NodeMutationResult
} from './edit'
/**
 * Memory deduplication (dashboard maintenance): a read-only duplicate SCAN and
 * an audited MERGE. Wired to IPC (memory.dedupe.*) and reused by the MCP
 * list_duplicate_memories / propose_dedupe_merge tools — the latter STAGES a
 * merge (§21 rule 6), never commits directly.
 */
export {
  DEDUPE_LABELS,
  DEDUPE_MERGE_LABELS,
  DedupeScanAbortedError,
  mergeDuplicates,
  planDedupeMerge,
  scanDuplicates,
  type DedupeLabel,
  type DedupeMergeDeps,
  type DedupeMergeLabel,
  type DedupeMergePlan,
  type DedupeScanDeps,
  type DedupeScanProgress,
  type DedupeScope,
  type DuplicateGroup,
  type DuplicateNode,
  type MergeDuplicatesResult,
  type ScanDuplicatesOptions,
  type ScanDuplicatesResult
} from './dedupe'
export {
  DedupeScanController,
  type DedupeScanControllerDeps,
  type DedupeScanStatus,
  type DedupeScanStartOptions
} from './dedupeController'
