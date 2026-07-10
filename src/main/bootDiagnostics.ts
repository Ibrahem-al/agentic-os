/**
 * Pure fold of the boot outcome into per-subsystem diagnostics — the reason a
 * connection is down or degraded, surfaced to the dashboard (App.tsx subsystem
 * strip) and the get_app_status MCP tool. Kept OUT of index.ts (which imports
 * Electron at module load and cannot be unit-tested) so the mapping is testable
 * in isolation.
 *
 * Precedence per subsystem: a captured boot error (from that step's catch, or a
 * non-throwing degradation like an mcp port-in-use) wins → 'error'; else a
 * specific degradation (a corrupt-WAL recovery, triggers off) → 'warn'; else the
 * resulting singleton exists → 'ok'. 'ok' rows are kept for the MCP tool; the
 * dashboard filters to non-ok.
 */
import type { BootDiagnosticDto } from '../shared/ipc'

/** The boot state the diagnostics fold reads (built from index.ts singletons). */
export interface BootSubsystemState {
  /** Message captured by each boot step's catch, keyed by subsystem name. */
  readonly errors: ReadonlyMap<string, string>
  readonly engineOpen: boolean
  readonly appDataOpen: boolean
  /** Non-null when storage recovered from a corrupt WAL (the quarantine dir). */
  readonly walQuarantined: string | null
  readonly modelsOpen: boolean
  readonly kernelOpen: boolean
  readonly mcpOpen: boolean
  readonly mcpUrl: string | null
  readonly agentsOpen: boolean
  readonly triggersOpen: boolean
}

export function computeBootDiagnostics(state: BootSubsystemState): BootDiagnosticDto[] {
  const diags: BootDiagnosticDto[] = []
  const add = (subsystem: string, level: BootDiagnosticDto['level'], detail: string): void => {
    diags.push({ subsystem, level, detail })
  }
  const err = (key: string): string | undefined => state.errors.get(key)

  // native has no "ok" row — an implicit dependency; only its failure is worth surfacing.
  const nativeErr = err('native')
  if (nativeErr !== undefined) add('native', 'error', `native module load failed: ${nativeErr}`)

  const storageErr = err('storage')
  if (storageErr !== undefined) add('storage', 'error', storageErr)
  else if (!state.engineOpen || !state.appDataOpen) add('storage', 'error', 'graph store did not open this launch (see logs)')
  else if (state.walQuarantined !== null)
    add('storage', 'warn', `recovered from a corrupt WAL (quarantined to ${state.walQuarantined}); writes since the last checkpoint were lost`)
  else add('storage', 'ok', 'graph + appdata open')

  const modelsErr = err('models')
  if (modelsErr !== undefined) add('models', 'error', modelsErr)
  else if (!state.modelsOpen) add('models', 'error', 'model layer did not boot')
  else add('models', 'ok', 'keychain + ollama')

  const kernelErr = err('kernel')
  if (kernelErr !== undefined) add('kernel', 'error', kernelErr)
  else if (!state.kernelOpen) add('kernel', 'error', state.appDataOpen ? 'kernel did not boot' : 'appdata.db unavailable — kernel skipped')
  else add('kernel', 'ok', 'workflow runner + security spine armed')

  const mcpErr = err('mcp')
  if (mcpErr !== undefined) add('mcp', 'error', mcpErr)
  else if (!state.mcpOpen) add('mcp', 'error', 'MCP server disabled — needs storage + models + kernel')
  else add('mcp', 'ok', state.mcpUrl !== null ? `listening at ${state.mcpUrl}` : 'listening')

  const agentsErr = err('agents')
  if (agentsErr !== undefined) add('agents', 'error', agentsErr)
  else if (!state.agentsOpen) add('agents', 'error', 'extraction agent disabled — needs storage + models + kernel')
  else add('agents', 'ok', 'extraction + skill-improvement ready')

  const triggersErr = err('triggers')
  if (triggersErr !== undefined) add('triggers', 'error', triggersErr)
  else if (!state.triggersOpen) add('triggers', 'warn', 'triggers disabled this launch')
  else add('triggers', 'ok', 'queue + schedules + watchers armed')

  return diags
}
