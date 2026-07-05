/**
 * Phase-09 DoD: "Conformance suite green in both lanes (escape attempts:
 * read outside scope, hit a non-allowlisted domain — both denied, both
 * lanes)." Every case in tests/fixtures/sandbox-conformance.ts runs through
 * the REAL Deno lane (managed pinned binary, downloaded once to out/test-bin
 * — user-approved, cached thereafter) AND the REAL Docker lane (alpine
 * container). Probe code executes ONLY inside the lanes (§21 rule 3) — this
 * file never imports it.
 *
 * Unavailable lanes skip gracefully with the reason; on the dev machine both
 * lanes are present and every case runs for real. Docker containers cost
 * ~0.5–2 s each to start, hence the generous per-test timeout.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { DenoLane, ensureDenoBinary } from '../../src/main/security/deno'
import { DockerLane, detectDocker } from '../../src/main/security/docker'
import type { SandboxResult } from '../../src/main/security/sandbox'
import {
  ALLOWED_SERVER_BODY,
  BLOCKED_SERVER_BODY,
  CONFORMANCE_CASES,
  OUTSIDE_READ_FILE_CONTENT,
  OUTSIDE_READ_FILE_NAME,
  READ_FILE_CONTENT,
  READ_FILE_NAME,
  type ConformanceEnv,
  type ExpectedOutcome,
  type LaneName,
  type ProbeOutput
} from '../fixtures/sandbox-conformance'

const repoRoot = fileURLToPath(new URL('../..', import.meta.url))
const sourceProbesDir = join(repoRoot, 'tests', 'fixtures', 'sandbox-probes')
/** out/ is gitignored — the ~42 MB managed binary downloads once, then caches. */
const denoBinDir = join(repoRoot, 'out', 'test-bin')

interface FixtureServer {
  server: Server
  hostPort: string
  url: string
  body: string
  requests: string[]
}

function startFixtureServer(body: string): Promise<FixtureServer> {
  const requests: string[] = []
  const server = createServer((req, res) => {
    requests.push(`${req.method ?? ''} ${req.url ?? ''}`)
    res.writeHead(200, { 'content-type': 'text/plain' })
    res.end(body)
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (address === null || typeof address === 'string') throw new Error('fixture server reported no port')
      const hostPort = `127.0.0.1:${address.port}`
      resolve({ server, hostPort, url: `http://${hostPort}/probe`, body, requests })
    })
  })
}

let baseDir: string
let probesDir: string
let env: ConformanceEnv
let allowedServer: FixtureServer
let blockedServer: FixtureServer
let denoLane: DenoLane | null = null
let denoUnavailable = ''
let dockerLane: DockerLane | null = null
let dockerUnavailable = ''

beforeAll(async () => {
  baseDir = mkdtempSync(join(tmpdir(), 'agentic-os-sandbox-'))

  // ONE probe dir reused by every case (dominates Docker mount setup cost).
  // Copied out of the repo checkout: probe.sh is normalized to LF here so a
  // core.autocrlf=true checkout can never hand busybox sh a CRLF script, and
  // the bind-mounted dir stays clear of OneDrive file-on-demand behavior.
  probesDir = join(baseDir, 'probes')
  mkdirSync(probesDir)
  writeFileSync(join(probesDir, 'probe.ts'), readFileSync(join(sourceProbesDir, 'probe.ts'), 'utf8'))
  writeFileSync(join(probesDir, 'probe.sh'), readFileSync(join(sourceProbesDir, 'probe.sh'), 'utf8').replace(/\r\n/g, '\n'))

  const readDir = join(baseDir, 'cap-read')
  const outsideReadDir = join(baseDir, 'outside-read')
  const writeDir = join(baseDir, 'cap-write')
  const outsideWriteDir = join(baseDir, 'outside-write')
  for (const dir of [readDir, outsideReadDir, writeDir, outsideWriteDir]) mkdirSync(dir)
  writeFileSync(join(readDir, READ_FILE_NAME), READ_FILE_CONTENT)
  const outsideReadFile = join(outsideReadDir, OUTSIDE_READ_FILE_NAME)
  writeFileSync(outsideReadFile, OUTSIDE_READ_FILE_CONTENT) // a REAL host file outside scope

  allowedServer = await startFixtureServer(ALLOWED_SERVER_BODY)
  blockedServer = await startFixtureServer(BLOCKED_SERVER_BODY)

  env = {
    readDir,
    outsideReadFile,
    writeDir,
    outsideWriteDir,
    allowedServer,
    blockedServer
  }

  try {
    await ensureDenoBinary({ binDir: denoBinDir })
    denoLane = new DenoLane({ binDir: denoBinDir })
  } catch (err) {
    denoUnavailable = err instanceof Error ? err.message : String(err)
  }

  const docker = await detectDocker()
  if (docker.available) {
    dockerLane = new DockerLane()
  } else {
    dockerUnavailable = docker.guidance
  }
}, 600_000) // first-ever run downloads the pinned Deno zip

afterAll(async () => {
  await new Promise<void>((resolve) => allowedServer?.server.close(() => resolve()))
  await new Promise<void>((resolve) => blockedServer?.server.close(() => resolve()))
  rmSync(baseDir, { recursive: true, force: true })
  // denoBinDir is deliberately NOT removed: the managed binary is the cache.
})

function assertOutcome(result: SandboxResult, expected: ExpectedOutcome, label: string): void {
  if (expected.kind === 'lane-error') {
    expect(result.ok, `${label}: expected lane error '${expected.error}', got success ${JSON.stringify(result)}`).toBe(false)
    if (!result.ok) expect(result.error.kind, `${label}: ${result.error.message}`).toBe(expected.error)
    return
  }
  // Probe-level outcomes require the lane run itself to have succeeded.
  expect(result.ok, `${label}: lane failed: ${JSON.stringify(result)}`).toBe(true)
  if (!result.ok) return
  const probe = result.value as ProbeOutput
  if (expected.kind === 'denied') {
    expect(probe.denied, `${label}: expected denial, probe said: ${probe.detail}`).toBe(true)
    expect(probe.ok).toBe(false)
    return
  }
  expect(probe.denied, `${label}: unexpectedly denied: ${probe.detail}`).toBe(false)
  expect(probe.ok, `${label}: probe failed: ${probe.detail}`).toBe(true)
  if (expected.data !== undefined) {
    expect(probe.data, `${label}: probe data mismatch`).toBe(expected.data)
  }
}

describe('sandbox conformance — one capability table, two lanes (§11)', () => {
  for (const conformanceCase of CONFORMANCE_CASES) {
    for (const lane of ['deno', 'docker'] as const satisfies readonly LaneName[]) {
      it(`${conformanceCase.name} [${lane}]`, { timeout: 60_000 }, async (ctx) => {
        const laneImpl = lane === 'deno' ? denoLane : dockerLane
        if (!laneImpl) {
          return ctx.skip(`${lane} lane unavailable: ${lane === 'deno' ? denoUnavailable : dockerUnavailable}`)
        }
        allowedServer.requests.length = 0
        blockedServer.requests.length = 0

        const result = await laneImpl.run({
          capabilities: conformanceCase.capabilities(env),
          entryFile: join(probesDir, lane === 'deno' ? 'probe.ts' : 'probe.sh'),
          input: conformanceCase.input(env, lane),
          ...(conformanceCase.timeoutMs !== undefined ? { timeoutMs: conformanceCase.timeoutMs } : {})
        })

        const label = `${conformanceCase.name} [${lane}]`
        assertOutcome(result, conformanceCase.expected(env, lane), label)

        // The timeout case must die at the deadline, not the 120 s sleep.
        if (conformanceCase.timeoutMs !== undefined) {
          expect(result.durationMs, `${label}: kill did not honor the deadline`).toBeLessThan(20_000)
        }

        const fileAfter = conformanceCase.hostFileAfter?.(env, lane)
        if (fileAfter) {
          expect(existsSync(fileAfter.path), `${label}: expected host file ${fileAfter.path}`).toBe(true)
          expect(readFileSync(fileAfter.path, 'utf8')).toBe(fileAfter.content)
        }
        const absentAfter = conformanceCase.hostFileAbsentAfter?.(env, lane)
        if (absentAfter) {
          expect(existsSync(absentAfter), `${label}: escape write reached the host: ${absentAfter}`).toBe(false)
        }

        const requestsAfter = conformanceCase.serverRequestsAfter?.(lane) ?? { allowed: 0, blocked: 0 }
        expect(allowedServer.requests.length, `${label}: allowed-server request log`).toBe(requestsAfter.allowed)
        expect(blockedServer.requests.length, `${label}: blocked-server request log`).toBe(requestsAfter.blocked)
      })
    }
  }
})
