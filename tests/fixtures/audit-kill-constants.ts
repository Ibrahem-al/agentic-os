/**
 * Shared constants for the crash-safety kill-mid-write proof. Kept in a module
 * with NO top-level execution so the parent test can import them without running
 * the child fixture's main() in-process (the fixture spawns as its own node
 * process; only the parent reads these).
 */
export const AUDIT_KILL_HANDSHAKE = 'PARTIAL_WRITE_COMMITTED'
/** The baseline node the sweep must leave intact (a clean, settled write). */
export const AUDIT_KILL_BASELINE_ID = 'kill-baseline'
/** The ids the audited write creates; all must be rolled back by the sweep. */
export const AUDIT_KILL_PARTIAL_IDS = ['kill-p1', 'kill-p2', 'kill-p3', 'kill-p4', 'kill-p5'] as const
