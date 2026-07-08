/**
 * Boot-diagnostics fold: turns the boot outcome into the per-subsystem reason
 * the dashboard shows, so a failed/degraded connection displays WHY instead of
 * a bare red dot. Covers the corrupt-WAL recovery surfacing (the field failure
 * that motivated this), captured errors, dependency cascades, and degradations.
 */
import { describe, expect, it } from 'vitest'
import { computeBootDiagnostics, type BootSubsystemState } from '../../src/main/bootDiagnostics'
import type { BootDiagnosticDto } from '../../src/shared/ipc'

const healthy: BootSubsystemState = {
  errors: new Map(),
  engineOpen: true,
  appDataOpen: true,
  walQuarantined: null,
  modelsOpen: true,
  kernelOpen: true,
  mcpOpen: true,
  mcpUrl: 'http://127.0.0.1:4517/mcp',
  agentsOpen: true,
  triggersOpen: true
}
const find = (diags: readonly BootDiagnosticDto[], sub: string): BootDiagnosticDto | undefined =>
  diags.find((d) => d.subsystem === sub)

describe('computeBootDiagnostics', () => {
  it('healthy boot: every subsystem ok, native silent', () => {
    const d = computeBootDiagnostics(healthy)
    for (const s of ['storage', 'models', 'kernel', 'mcp', 'agents', 'triggers']) {
      expect(find(d, s)?.level).toBe('ok')
    }
    expect(find(d, 'native')).toBeUndefined()
  })

  it('corrupt-WAL recovery → storage WARN naming the reason + quarantine path', () => {
    const d = computeBootDiagnostics({
      ...healthy,
      walQuarantined: 'C:/x/backups/2026-07-08T03-51-29Z-corrupt-wal'
    })
    const storage = find(d, 'storage')
    expect(storage?.level).toBe('warn')
    expect(storage?.detail).toMatch(/recovered from a corrupt WAL/i)
    expect(storage?.detail).toContain('corrupt-wal')
  })

  it('a captured storage boot error surfaces verbatim as an ERROR', () => {
    const d = computeBootDiagnostics({
      ...healthy,
      engineOpen: false,
      errors: new Map([['storage', 'Runtime exception: Corrupted wal file. Read out invalid WAL record type.']])
    })
    const storage = find(d, 'storage')
    expect(storage?.level).toBe('error')
    expect(storage?.detail).toMatch(/Corrupted wal file/)
  })

  it('storage down cascades: mcp + agents report a dependency reason', () => {
    const d = computeBootDiagnostics({
      ...healthy,
      engineOpen: false,
      appDataOpen: false,
      kernelOpen: false,
      mcpOpen: false,
      agentsOpen: false
    })
    expect(find(d, 'storage')?.level).toBe('error')
    expect(find(d, 'mcp')?.level).toBe('error')
    expect(find(d, 'mcp')?.detail).toMatch(/needs storage/i)
    expect(find(d, 'agents')?.detail).toMatch(/needs storage/i)
  })

  it('mcp port-in-use (non-throwing degradation) surfaces the reason', () => {
    const d = computeBootDiagnostics({
      ...healthy,
      mcpOpen: false,
      errors: new Map([['mcp', 'port 4517 already in use (another agentic-os instance?) — MCP server disabled']])
    })
    const mcp = find(d, 'mcp')
    expect(mcp?.level).toBe('error')
    expect(mcp?.detail).toMatch(/port 4517 already in use/)
  })

  it('a keychain decrypt failure surfaces as a models ERROR verbatim', () => {
    const d = computeBootDiagnostics({
      ...healthy,
      modelsOpen: false,
      errors: new Map([['models', 'keychain cannot be decrypted (corrupt file, or encrypted under a different OS user)']])
    })
    expect(find(d, 'models')?.level).toBe('error')
    expect(find(d, 'models')?.detail).toMatch(/cannot be decrypted/)
  })

  it('triggers off is a WARN (degraded, not down)', () => {
    const d = computeBootDiagnostics({ ...healthy, triggersOpen: false })
    expect(find(d, 'triggers')?.level).toBe('warn')
  })

  it('native module load failure is surfaced as an error', () => {
    const d = computeBootDiagnostics({ ...healthy, errors: new Map([['native', 'ERR_DLOPEN_FAILED']]) })
    expect(find(d, 'native')?.level).toBe('error')
    expect(find(d, 'native')?.detail).toMatch(/native module load failed/i)
  })
})
