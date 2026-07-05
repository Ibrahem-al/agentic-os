/**
 * Public surface of the storage layer (§5). Everything outside storage/
 * imports from here; the RyuGraph driver never leaks past this boundary.
 */
export type {
  CypherParams,
  EdgeProps,
  NodeProps,
  NodeRef,
  Row,
  StorageEngine,
  TextHit,
  UpsertResult,
  VectorHit,
  WriteTx
} from './engine'
export {
  EDGE_TYPES,
  NODE_LABELS,
  NODE_TABLES,
  REL_TABLES,
  RETRIEVABLE_LABELS,
  nodeTable,
  relTable,
  type EdgeType,
  type NodeLabel,
  type NodeTableSpec,
  type PropertySpec,
  type RelTableSpec,
  type RetrievableLabel
} from './schema'
export { isMutatingCypher, openRyuGraphEngine, ryuPlatformDir, type RyuGraphEngineOptions } from './ryugraph'
export { MIGRATIONS, type Migration, type MigrationContext } from './migrations'
export { exportGraph, type ExportResult } from './export'
export { openAppData, type AppData } from './appdata'
export { WriteLane, type WriteJobRecord } from './writeLane'
