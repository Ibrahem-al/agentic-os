/**
 * The definitive kill-mid-write proof (§21.9 crash-safety) — the hard way, real
 * SIGKILL (mirrors triggers.queue.kill.test.ts).
 *
 * A REAL child process opens the REAL RyuGraph engine + appdata.db, seeds a clean
 * baseline node, then starts a LONG audited `graphWrite` (5 node upserts) and is
 * SIGKILLed mid-lane-job — AFTER the committed prefix + the 'pending' audit row's
 * inverses are on disk. Because the write lane is exclusive but NOT transactional
 * (each statement auto-commits), the graph keeps that partial write durably.
 *
 * This test = the "restarted app": it reopens both stores, confirms the durable
 * partial write is really there (the 5 nodes survived the crash), runs the boot
 * sweep, and asserts the sweep (a) rolled the partial write back (node counts
 * return to pre-write state — only the baseline remains), (b) settled the audit
 * row to 'error' with the rolled-back suffix, (c) cleared the stranded
 * `graph-write:<id>` lane_jobs row without a spurious non-audited warn, and (d)
 * emitted a warn diagnostic. Re-running the sweep is a no-op (idempotent).
 *
 * One store per test file (ryugraph 25.9.1 teardown discipline).
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { AuditLog } from '../../src/main/security'
import { createLaneJournal, runCrashSweep } from '../../src/main/crashSweep'
import { openAppData, openRyuGraphEngine, type AppData } from '../../src/main/storage'
import {
  AUDIT_KILL_BASELINE_ID,
  AUDIT_KILL_HANDSHAKE,
  AUDIT_KILL_PARTIAL_IDS
} from '../fixtures/audit-kill-constants'
import { EXTENSIONS_DIR } from './helpers'

const repoRoot = fileURLToPath(new URL('../..', import.meta.url))

let baseDir: string
let childBundle: string
let engine: Awaited<ReturnType<typeof openRyuGraphEngine>> | undefined
let appData: AppData | undefined

beforeAll(async () => {
  baseDir = mkdtempSync(join(tmpdir(), 'agentic-os-audit-kill-'))
  const esbuild = await import('esbuild')
  const outDir = join(repoRoot, 'out', 'test-child')
  mkdirSync(outDir, { recursive: true })
  childBundle = join(outDir, 'audit-kill-child.mjs')
  await esbuild.build({
    entryPoints: [join(repoRoot, 'tests', 'fixtures', 'audit-kill-child.ts')],
    outfile: childBundle,
    bundle: true,
    platform: 'node',
    format: 'esm',
    packages: 'external',
    logLevel: 'silent'
  })
}, 60_000)

afterAll(async () => {
  await engine?.close()
  appData?.close()
  rmSync(baseDir, { recursive: true, force: true })
})

function waitForHandshake(child: ChildProcess, marker: string, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    let stdout = ''
    let stderr = ''
    const timer = setTimeout(
      () => reject(new Error(`no '${marker}' handshake in ${timeoutMs}ms\nstdout: ${stdout}\nstderr: ${stderr}`)),
      timeoutMs
    )
    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString()
      if (stdout.includes(marker)) {
        clearTimeout(timer)
        resolve()
      }
    })
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString()
    })
    child.on('exit', (code) =>
      reject(new Error(`child exited early (code ${code})\nstdout: ${stdout}\nstderr: ${stderr}`))
    )
  })
}

describe('crash sweep rolls back a real SIGKILL-interrupted audited write (§21.9)', () => {
  it('kill mid-graphWrite → reopen → sweep rolls the partial write back', async () => {
    const graphDir = join(baseDir, 'graph')
    const appDbPath = join(baseDir, 'appdata.db')
    const backupsDir = join(baseDir, 'backups')
    mkdirSync(backupsDir, { recursive: true })

    // Phase A: the "app" seeds a baseline node and dies mid audited write.
    const child = spawn(
      process.execPath,
      [childBundle, graphDir, appDbPath, EXTENSIONS_DIR, backupsDir],
      { cwd: repoRoot, stdio: ['ignore', 'pipe', 'pipe'] }
    )
    await waitForHandshake(child, AUDIT_KILL_HANDSHAKE, 45_000)
    child.removeAllListeners('exit')
    child.kill('SIGKILL')
    await new Promise<void>((resolve) => child.on('exit', () => resolve()))

    // Phase B: the "restarted app" — reopen both stores over the same dirs.
    engine = await openRyuGraphEngine({ graphDir, backupsDir, extensionsDir: EXTENSIONS_DIR })
    appData = openAppData(appDbPath)
    engine.setLaneJournal(createLaneJournal(appData.db))
    const audit = new AuditLog({ db: appData.db, backupsDir, engine })

    const nodeCount = async (id: string): Promise<number> => {
      const rows = await engine!.cypher('MATCH (n:Tag {id: $id}) RETURN count(n) AS c', { id })
      return Number(rows[0]?.['c'] ?? 0)
    }
    const laneJobCount = (): number =>
      Number((appData!.db.prepare('SELECT count(*) AS c FROM lane_jobs').get() as { c: number }).c)

    // The durable partial write really survived the crash: the committed prefix
    // (all 5 nodes) is on disk, the baseline is on disk, and appdata.db holds the
    // 'pending' audit row + the stranded graph-write lane_jobs row.
    expect(await nodeCount(AUDIT_KILL_BASELINE_ID)).toBe(1)
    for (const id of AUDIT_KILL_PARTIAL_IDS) expect(await nodeCount(id)).toBe(1)
    const pendingRows = appData.db
      .prepare(`SELECT id, description FROM audit_log WHERE outcome = 'pending'`)
      .all() as { id: string; description: string }[]
    expect(pendingRows).toHaveLength(1)
    const crashedId = pendingRows[0]!.id
    expect(laneJobCount()).toBeGreaterThanOrEqual(1)

    // The boot sweep rolls the interrupted write back.
    const result = await runCrashSweep({ db: appData.db, audit })

    expect(result.rolledBack).toBe(1)
    expect(result.rollbackFailed).toBe(0)
    // The stranded lane_jobs row maps to the (now-settled) audit action, so it is
    // cleared as an audited orphan — NOT re-reported as a non-audited job.
    expect(result.auditedCleared).toBeGreaterThanOrEqual(1)
    expect(result.nonAuditedFlagged).toBe(0)

    // (a) The partial write is gone; (b) the baseline write is untouched.
    for (const id of AUDIT_KILL_PARTIAL_IDS) expect(await nodeCount(id)).toBe(0)
    expect(await nodeCount(AUDIT_KILL_BASELINE_ID)).toBe(1)

    // (c) The audit row settled to 'error' with the rolled-back suffix.
    const row = audit.getAction(crashedId)!
    expect(row.outcome).toBe('error')
    expect(row.description).toMatch(/\(rolled back after interrupted write\)$/)

    // (d) A warn diagnostic surfaced the rollback to the dashboard.
    const warn = result.diagnostics.find(
      (d) => d.level === 'warn' && d.detail.includes('interrupted multi-node write')
    )
    expect(warn?.subsystem).toBe('storage')

    // The stranded lane_jobs row is cleared and the sweep is idempotent.
    expect(laneJobCount()).toBe(0)
    const again = await runCrashSweep({ db: appData.db, audit })
    expect(again.rolledBack).toBe(0)
    expect(again.diagnostics).toHaveLength(0)
  }, 90_000)
})
