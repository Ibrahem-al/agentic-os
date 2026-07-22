/**
 * Permission engine unit tests (§13, phase 09): default-deny for unregistered
 * agents, tiered gates (auto-allow reads; write/net/spend queue pending
 * approvals; out-of-scope hard-blocks), standing grants, persistent approval
 * decisions, and the internal-agent registrations boot installs.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { KernelAction } from '../../src/main/kernel'
import {
  EMPTY_CAPABILITIES,
  parseCapabilities,
  PermissionEngine,
  registerInternalAgents
} from '../../src/main/security'
import { openAppData, type AppData } from '../../src/main/storage'

const abs = (...parts: string[]): string => resolve('/', ...parts)

let baseDir: string
let appData: AppData
let engine: PermissionEngine

beforeEach(() => {
  baseDir = mkdtempSync(join(tmpdir(), 'agentic-os-perm-'))
  appData = openAppData(join(baseDir, 'appdata.db'))
  engine = new PermissionEngine({ db: appData.db })
})

afterEach(() => {
  appData.close()
  rmSync(baseDir, { recursive: true, force: true })
})

describe('default-deny (§13)', () => {
  it('blocks every action from an unregistered agent — even reads', () => {
    const decision = engine.check('ghost', { kind: 'storage-read', name: 'peek' })
    expect(decision.allowed).toBe(false)
    expect(decision.reason).toContain('not registered')
    expect(decision.pendingApprovalId).toBeUndefined()
    expect(engine.listApprovals()).toHaveLength(0)
  })
})

describe('tiered gates', () => {
  beforeEach(() => {
    engine.registerAgent('worker', {
      capabilities: parseCapabilities({
        fsRead: [abs('data')],
        fsWrite: [abs('out')],
        netDomains: ['example.com', 'api.example.com:443'],
        tools: ['summarize'],
        maxSpendUSD: 0.5
      })
    })
  })

  it('auto-allows reads/retrieval/model calls/workflow steps', () => {
    for (const kind of ['storage-read', 'retrieval', 'model-call', 'workflow-step'] as const) {
      expect(engine.check('worker', { kind, name: 'x' }).allowed).toBe(true)
    }
  })

  it('auto-allows fs-read within scope; hard-blocks outside (no approval row)', () => {
    expect(engine.check('worker', { kind: 'fs-read', name: 'read', paths: [abs('data', 'f.txt')] }).allowed).toBe(true)
    const denied = engine.check('worker', { kind: 'fs-read', name: 'read', paths: [abs('secrets', 'k.pem')] })
    expect(denied.allowed).toBe(false)
    expect(denied.reason).toContain('hard block')
    expect(engine.listApprovals()).toHaveLength(0)
  })

  it('queues in-scope fs-writes; approval persists per action signature', () => {
    const action: KernelAction = { kind: 'fs-write', name: 'save', paths: [join(abs('out'), 'r.json')] }
    const first = engine.check('worker', action)
    expect(first.allowed).toBe(false)
    expect(first.pendingApprovalId).toBeDefined()

    // Same signature → same queued row (headless it stays queued, not duplicated).
    const again = engine.check('worker', action)
    expect(again.pendingApprovalId).toBe(first.pendingApprovalId)
    expect(engine.listApprovals({ status: 'pending' })).toHaveLength(1)

    engine.approve(first.pendingApprovalId!, 'tester')
    expect(engine.check('worker', action).allowed).toBe(true)
    // A different path = a different signature = a fresh approval.
    const other = engine.check('worker', { ...action, paths: [join(abs('out'), 'other.json')] })
    expect(other.allowed).toBe(false)
    expect(other.pendingApprovalId).not.toBe(first.pendingApprovalId)
  })

  it('a denial persists the same way', () => {
    const action: KernelAction = { kind: 'net', name: 'fetch', host: 'example.com' }
    const queued = engine.check('worker', action)
    engine.deny(queued.pendingApprovalId!, 'tester')
    const after = engine.check('worker', action)
    expect(after.allowed).toBe(false)
    expect(after.reason).toContain('denied by tester')
    expect(after.pendingApprovalId).toBeUndefined()
  })

  it('hard-blocks out-of-scope net hosts and over-ceiling spend', () => {
    expect(engine.check('worker', { kind: 'net', name: 'fetch', host: 'evil.com' }).allowed).toBe(false)
    expect(engine.check('worker', { kind: 'net', name: 'fetch', host: 'api.example.com:8080' }).allowed).toBe(false)
    expect(engine.check('worker', { kind: 'spend', name: 'cloud', usd: 0.75 }).allowed).toBe(false)
    // in-scope spend is gated, not blocked
    expect(engine.check('worker', { kind: 'spend', name: 'cloud', usd: 0.25 }).pendingApprovalId).toBeDefined()
  })

  it('blocks undeclared tools; declared tools are write-gated', () => {
    expect(engine.check('worker', { kind: 'tool-call', name: 'exec' }).allowed).toBe(false)
    const declared = engine.check('worker', { kind: 'tool-call', name: 'summarize' })
    expect(declared.allowed).toBe(false)
    expect(declared.pendingApprovalId).toBeDefined()
  })

  it('P0.6: mcp-call enforces declared-tool scope, and a declared-but-unrecognized name fails closed', () => {
    // 'worker' declares only the 'summarize' tool (see beforeEach).
    // (a) A READ tool the profile does NOT declare: pre-14b this auto-allowed
    //     for ANY registered agent because the mcp-call branch skipped cap.tools.
    const undeclared = engine.check('worker', { kind: 'mcp-call', name: 'get_context' })
    expect(undeclared.allowed).toBe(false)
    expect(undeclared.reason).toContain("not in the agent's declared tools")
    // (b) A name the profile DOES declare but that maps to no read/staging/control
    //     tier: the old allow-by-default fallthrough is replaced with a hard block.
    const unrecognized = engine.check('worker', { kind: 'mcp-call', name: 'summarize' })
    expect(unrecognized.allowed).toBe(false)
    expect(unrecognized.reason).toContain('not a recognized MCP tool')
    expect(engine.listApprovals()).toHaveLength(0)
  })

  it('sandbox-run: read-only requests auto-allow; side-effecting ones gate; exceeding ones block', () => {
    const readOnly = engine.check('worker', {
      kind: 'sandbox-run',
      name: 'rule',
      sandbox: { capabilities: parseCapabilities({ fsRead: [abs('data')] }) }
    })
    expect(readOnly.allowed).toBe(true)

    const writing = engine.check('worker', {
      kind: 'sandbox-run',
      name: 'rule',
      sandbox: { capabilities: parseCapabilities({ fsWrite: [abs('out')] }) }
    })
    expect(writing.allowed).toBe(false)
    expect(writing.pendingApprovalId).toBeDefined()

    const exceeding = engine.check('worker', {
      kind: 'sandbox-run',
      name: 'rule',
      sandbox: { capabilities: parseCapabilities({ fsRead: [abs('secrets')] }) }
    })
    expect(exceeding.allowed).toBe(false)
    expect(exceeding.reason).toContain('hard block')
    expect(exceeding.pendingApprovalId).toBeUndefined()
  })

  it('standing grants skip the queue for their tier only', () => {
    engine.registerAgent('trusted', {
      capabilities: parseCapabilities({ fsWrite: [abs('out')], maxSpendUSD: 0.5 }),
      gates: { write: 'allow' }
    })
    expect(
      engine.check('trusted', { kind: 'fs-write', name: 'save', paths: [join(abs('out'), 'f')] }).allowed
    ).toBe(true)
    // spend has no standing grant → still queues
    expect(engine.check('trusted', { kind: 'spend', name: 'cloud', usd: 0.1 }).pendingApprovalId).toBeDefined()
    // scope still applies despite the grant
    expect(
      engine.check('trusted', { kind: 'fs-write', name: 'save', paths: [abs('elsewhere', 'f')] }).allowed
    ).toBe(false)
  })

  it('approve/deny of unknown or decided approvals throws', () => {
    expect(() => engine.approve('nope', 'tester')).toThrow('does not exist')
    const queued = engine.check('worker', { kind: 'storage-write', name: 'w' })
    engine.approve(queued.pendingApprovalId!, 'tester')
    expect(() => engine.deny(queued.pendingApprovalId!, 'tester')).toThrow('already decided')
  })
})

describe('internal registrations (boot profile)', () => {
  beforeEach(() => {
    registerInternalAgents(engine)
  })

  it('extraction-agent: workflow steps + writes + spend flow; fs/net stay denied', () => {
    expect(engine.check('extraction-agent', { kind: 'workflow-step', name: 'extract' }).allowed).toBe(true)
    expect(engine.check('extraction-agent', { kind: 'storage-write', name: 'gated-write' }).allowed).toBe(true)
    expect(engine.check('extraction-agent', { kind: 'spend', name: 'escalate', usd: 0.4 }).allowed).toBe(true)
    expect(engine.check('extraction-agent', { kind: 'spend', name: 'escalate', usd: 0.6 }).allowed).toBe(false)
    expect(engine.check('extraction-agent', { kind: 'fs-write', name: 'w', paths: [abs('x')] }).allowed).toBe(false)
    expect(engine.check('extraction-agent', { kind: 'net', name: 'fetch', host: 'example.com' }).allowed).toBe(false)
  })

  it('mcp:<session> prefix: full read + staging surface auto-allows; control (incl. ingest) standing-allowed; interactive behavior unchanged', () => {
    const sid = 'mcp:3f2a-transport-session'
    // The 7 phase-05 tools still behave exactly as today...
    for (const tool of ['get_context', 'search_memory', 'list_skills', 'get_skill', 'propose_correction']) {
      expect(engine.check(sid, { kind: 'mcp-call', name: tool }).allowed).toBe(true)
    }
    expect(engine.check(sid, { kind: 'mcp-call', name: 'ingest_document' }).allowed).toBe(true)
    expect(engine.check(sid, { kind: 'mcp-call', name: 'ingest_codebase' }).allowed).toBe(true)
    // ...and a sample of the phase-14b read/staging surface auto-allows too.
    for (const tool of ['list_sessions', 'get_runner_status', 'list_audit_log', 'submit_extraction_items']) {
      expect(engine.check(sid, { kind: 'mcp-call', name: tool }).allowed).toBe(true)
    }
    // The new control tools ride the write standing-grant on the interactive profile.
    for (const tool of ['run_extraction', 'improve_skill_now', 'run_maintenance', 'retry_task', 'scan_watched_folder']) {
      expect(engine.check(sid, { kind: 'mcp-call', name: tool }).allowed).toBe(true)
    }
    // run_graph_cleanup is a dashboard-maintenance tool (net effect: staging only):
    // AUTO-allowed on the interactive session, like the dedup scan/propose tools.
    expect(engine.check(sid, { kind: 'mcp-call', name: 'run_graph_cleanup' }).allowed).toBe(true)
    // P0.6: an unknown / undeclared tool name is now BLOCKED (pre-14b it was allow-defaulted).
    const unknown = engine.check(sid, { kind: 'mcp-call', name: 'no-such-tool' })
    expect(unknown.allowed).toBe(false)
    expect(unknown.reason).toContain('hard block')
    expect(engine.listApprovals()).toHaveLength(0)
    // a non-mcp action from the session family still hits scope checks.
    expect(engine.check(sid, { kind: 'fs-write', name: 'w', paths: [abs('x')] }).allowed).toBe(false)
  })

  it('mcp-runner:<session> prefix: READ + STAGING auto-allow; CONTROL and unknown names blocked; no standing grant', () => {
    const rid = 'mcp-runner:abcd-transport-session'
    // Reads + staging auto-allow (sample the declared surface).
    for (const tool of ['get_context', 'list_sessions', 'get_runner_status', 'propose_correction', 'submit_extraction_items']) {
      expect(engine.check(rid, { kind: 'mcp-call', name: tool }).allowed).toBe(true)
    }
    // Control + dashboard-maintenance tools are NOT in the runner's declared
    // surface → hard-blocked (no standing write grant exists either). run_graph_cleanup
    // is dashboard-only, so a headless runner can never trigger a memory-cleanup pass.
    for (const tool of ['ingest_document', 'ingest_codebase', 'run_extraction', 'run_maintenance', 'retry_task', 'run_graph_cleanup']) {
      const denied = engine.check(rid, { kind: 'mcp-call', name: tool })
      expect(denied.allowed).toBe(false)
      expect(denied.reason).toContain('hard block')
    }
    // Unknown names blocked; none of the above queued an approval row.
    expect(engine.check(rid, { kind: 'mcp-call', name: 'no-such-tool' }).allowed).toBe(false)
    expect(engine.listApprovals()).toHaveLength(0)
    // Prefix hygiene: a runner id does not match the mcp: family, so it never
    // inherits the interactive write standing-grant.
    expect('mcp-runner:x'.startsWith('mcp:')).toBe(false)
  })

  it('prefix families do not leak: an id NOT matching any prefix stays denied', () => {
    expect(engine.check('mcpX-not-a-session', { kind: 'storage-read', name: 'r' }).allowed).toBe(false)
  })

  it('re-registration replaces a profile', () => {
    engine.registerAgent('system', { capabilities: EMPTY_CAPABILITIES }) // drop the write grant
    expect(engine.check('system', { kind: 'storage-write', name: 'w' }).allowed).toBe(false)
  })
})
