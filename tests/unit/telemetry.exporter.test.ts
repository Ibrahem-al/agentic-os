/**
 * Telemetry unit tests: real OTel provider + SqliteSpanExporter over a real
 * appdata.db — row mapping, parent-child nesting through the ambient context,
 * error status, and remote-parent trace continuation (the resume mechanism).
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { openAppData, type AppData } from '../../src/main/storage'
import { createTelemetry, type Telemetry } from '../../src/main/telemetry'
import { spanAttributes, spanRows } from '../fixtures/kernel-helpers'

let dir: string
let appData: AppData
let telemetry: Telemetry

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'agentic-os-telemetry-'))
  appData = openAppData(join(dir, 'appdata.db'))
  telemetry = createTelemetry(appData.db)
})

afterEach(async () => {
  await telemetry.shutdown()
  appData.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('SqliteSpanExporter row mapping', () => {
  it('writes one row per ended span with ids, times, status and attributes', async () => {
    const result = await telemetry.withSpan('unit.parent', { alpha: 'a', count: 3, flag: true }, () => 'value')
    expect(result).toBe('value')

    const rows = spanRows(appData)
    expect(rows).toHaveLength(1)
    const row = rows[0]!
    expect(row.name).toBe('unit.parent')
    expect(row.trace_id).toMatch(/^[0-9a-f]{32}$/)
    expect(row.span_id).toMatch(/^[0-9a-f]{16}$/)
    expect(row.parent_span_id).toBeNull()
    expect(row.kind).toBe('internal')
    expect(row.status).toBe('ok')
    expect(row.start_unix_ms).toBeGreaterThan(0)
    expect(row.end_unix_ms).toBeGreaterThanOrEqual(row.start_unix_ms)
    expect(spanAttributes(row)).toEqual({ alpha: 'a', count: 3, flag: true })
  })

  it('nests child spans under the ambient parent (same trace, parent id set)', async () => {
    await telemetry.withSpan('outer', {}, async () => {
      await telemetry.withSpan('inner', {}, () => undefined)
    })
    const rows = spanRows(appData)
    expect(rows.map((r) => r.name).sort()).toEqual(['inner', 'outer'])
    const outer = rows.find((r) => r.name === 'outer')!
    const inner = rows.find((r) => r.name === 'inner')!
    expect(inner.trace_id).toBe(outer.trace_id)
    expect(inner.parent_span_id).toBe(outer.span_id)
    expect(outer.parent_span_id).toBeNull()
    // The child ends first (SimpleSpanProcessor exports in end order).
    expect(rows[0]!.name).toBe('inner')
  })

  it('marks throwing spans as errors, records the message, and rethrows', async () => {
    await expect(
      telemetry.withSpan('unit.fails', {}, () => {
        throw new Error('kaboom')
      })
    ).rejects.toThrow('kaboom')
    const row = spanRows(appData, 'unit.fails')[0]!
    expect(row.status).toBe('error')
    expect(spanAttributes(row)['otel.status_message']).toBe('kaboom')
  })

  it('continues a remote trace via remoteParentContext (resume mechanism)', async () => {
    const traceId = 'a1b2c3d4e5f60718293a4b5c6d7e8f90'
    const spanId = '0123456789abcdef'
    await telemetry.withSpan('resumed.root', {}, () => undefined, {
      parent: telemetry.remoteParentContext(traceId, spanId)
    })
    const row = spanRows(appData, 'resumed.root')[0]!
    expect(row.trace_id).toBe(traceId)
    expect(row.parent_span_id).toBe(spanId)
  })

  it('keeps telemetry instances isolated (no global provider)', async () => {
    const otherDir = mkdtempSync(join(tmpdir(), 'agentic-os-telemetry2-'))
    const otherAppData = openAppData(join(otherDir, 'appdata.db'))
    const otherTelemetry = createTelemetry(otherAppData.db)
    try {
      await telemetry.withSpan('mine', {}, () => undefined)
      expect(spanRows(appData)).toHaveLength(1)
      expect(spanRows(otherAppData)).toHaveLength(0)
    } finally {
      await otherTelemetry.shutdown()
      otherAppData.close()
      rmSync(otherDir, { recursive: true, force: true })
    }
  })
})
