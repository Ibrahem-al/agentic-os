/**
 * Shared setup for kernel/telemetry tests: a real appdata.db in a temp dir,
 * real telemetry (spans → traces table), the Kernel facade with the audit
 * stub, and a LangGraphRunner — the full phase-04 stack minus Electron.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Kernel, LangGraphRunner, createAuditLogStub } from '../../src/main/kernel'
import { openAppData, type AppData } from '../../src/main/storage'
import { createTelemetry, type Telemetry } from '../../src/main/telemetry'

export interface KernelTestStack {
  baseDir: string
  appData: AppData
  telemetry: Telemetry
  kernel: Kernel
  audit: ReturnType<typeof createAuditLogStub>
  runner: LangGraphRunner
  cleanup(): void
}

export function openKernelStack(): KernelTestStack {
  const baseDir = mkdtempSync(join(tmpdir(), 'agentic-os-kernel-'))
  const appData = openAppData(join(baseDir, 'appdata.db'))
  const telemetry = createTelemetry(appData.db)
  const audit = createAuditLogStub()
  const kernel = new Kernel({ telemetry, audit })
  const runner = new LangGraphRunner({ db: appData.db, telemetry, executor: kernel })
  return {
    baseDir,
    appData,
    telemetry,
    kernel,
    audit,
    runner,
    cleanup: () => {
      appData.close()
      rmSync(baseDir, { recursive: true, force: true })
    }
  }
}

export interface SpanRow {
  trace_id: string
  span_id: string
  parent_span_id: string | null
  name: string
  kind: string
  start_unix_ms: number
  end_unix_ms: number | null
  status: string | null
  attributes_json: string | null
}

export function spanRows(appData: AppData, name?: string): SpanRow[] {
  const sql = name === undefined ? 'SELECT * FROM traces ORDER BY id' : 'SELECT * FROM traces WHERE name = ? ORDER BY id'
  const stmt = appData.db.prepare(sql)
  return (name === undefined ? stmt.all() : stmt.all(name)) as SpanRow[]
}

export function spanAttributes(row: SpanRow): Record<string, unknown> {
  return JSON.parse(row.attributes_json ?? '{}') as Record<string, unknown>
}
