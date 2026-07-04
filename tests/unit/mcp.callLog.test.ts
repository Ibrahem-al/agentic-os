/**
 * The mcp_calls writer: stable args hashing (key order must not matter) and
 * row shape, including the hash-only fallback for oversized args.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { MCP_CALL_ARGS_JSON_MAX_BYTES } from '../../src/main/config'
import { hashArgs, McpCallLog, stableStringify } from '../../src/main/mcp'
import { openAppData, type AppData } from '../../src/main/storage'

describe('stableStringify / hashArgs', () => {
  it('is independent of object key order, recursively', () => {
    const a = { task: 'deploy', options: { tags: ['x'], k: 3 } }
    const b = { options: { k: 3, tags: ['x'] }, task: 'deploy' }
    expect(stableStringify(a)).toBe(stableStringify(b))
    expect(hashArgs(a)).toBe(hashArgs(b))
  })

  it('drops undefined properties and keeps null / primitives / arrays', () => {
    expect(stableStringify({ a: undefined, b: null })).toBe('{"b":null}')
    expect(stableStringify([1, 'two', false])).toBe('[1,"two",false]')
    expect(stableStringify('x')).toBe('"x"')
    expect(stableStringify(undefined)).toBe('null')
  })

  it('produces distinct sha256: hashes for distinct args', () => {
    expect(hashArgs({ q: 'a' })).toMatch(/^sha256:[0-9a-f]{64}$/)
    expect(hashArgs({ q: 'a' })).not.toBe(hashArgs({ q: 'b' }))
  })
})

describe('McpCallLog', () => {
  let dir: string
  let appData: AppData

  afterEach(() => {
    appData.close()
    rmSync(dir, { recursive: true, force: true })
  })

  function open(): McpCallLog {
    dir = mkdtempSync(join(tmpdir(), 'mcp-calllog-'))
    appData = openAppData(join(dir, 'appdata.db'))
    return new McpCallLog(appData.db)
  }

  interface CallRow {
    session_id: string
    tool: string
    params_json: string | null
    args_hash: string
    result_status: string
    error: string | null
    started_unix_ms: number
    duration_ms: number
  }

  it('writes the full row: session, tool, args JSON + hash, timing, status', () => {
    const log = open()
    const args = { task: 'deploy the storefront', tags: ['frontend'] }
    log.record({
      sessionId: 'sess-1',
      tool: 'get_context',
      args,
      resultStatus: 'ok',
      startedUnixMs: 1234,
      durationMs: 56.7
    })
    const row = appData.db.prepare('SELECT * FROM mcp_calls').get() as CallRow
    expect(row.session_id).toBe('sess-1')
    expect(row.tool).toBe('get_context')
    expect(row.params_json).toBe(stableStringify(args))
    expect(row.args_hash).toBe(hashArgs(args))
    expect(row.result_status).toBe('ok')
    expect(row.error).toBeNull()
    expect(row.started_unix_ms).toBe(1234)
    expect(row.duration_ms).toBe(57)
  })

  it('records errors with the message', () => {
    const log = open()
    log.record({
      sessionId: 'sess-2',
      tool: 'ingest_document',
      args: { path_or_content: '/tmp/x.md' },
      resultStatus: 'error',
      error: 'NOT_IMPLEMENTED: phase 06',
      startedUnixMs: 1,
      durationMs: 2
    })
    const row = appData.db.prepare('SELECT result_status, error FROM mcp_calls').get() as CallRow
    expect(row.result_status).toBe('error')
    expect(row.error).toBe('NOT_IMPLEMENTED: phase 06')
  })

  it('keeps the hash but not the JSON for oversized args', () => {
    const log = open()
    const args = { path_or_content: 'x'.repeat(MCP_CALL_ARGS_JSON_MAX_BYTES + 1) }
    log.record({
      sessionId: 'sess-3',
      tool: 'ingest_document',
      args,
      resultStatus: 'error',
      error: 'NOT_IMPLEMENTED',
      startedUnixMs: 1,
      durationMs: 2
    })
    const row = appData.db.prepare('SELECT params_json, args_hash FROM mcp_calls').get() as CallRow
    expect(row.params_json).toBeNull()
    expect(row.args_hash).toBe(hashArgs(args))
  })
})
