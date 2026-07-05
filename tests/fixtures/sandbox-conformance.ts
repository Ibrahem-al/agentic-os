/**
 * Phase-09 sandbox conformance fixture — the ONE capability table (§11 "a
 * shared conformance test suite keeps the two enforcement paths behavior-
 * equivalent: same capability declaration → same effective allow/deny
 * outcomes"). tests/integration/security.conformance.test.ts runs every case
 * through BOTH lanes with the real probe scripts (probe.ts / probe.sh); this
 * module never executes probe code itself (§21 rule 3).
 *
 * Per-lane probe inputs: fs targets are host paths for Deno and container
 * paths for Docker — the container side is derived from the SAME declaration
 * via dockerCapabilityArgs(...).readMounts/writeMounts, so the mapping under
 * test is the lane's own. "Outside scope" on the Docker side is a /caps path
 * no case ever mounts: in a scoped container an undeclared path simply does
 * not exist, which is the deny outcome (mechanisms differ, outcomes must not
 * — see probe.sh header).
 *
 * Known divergence, pinned here as CONTRACT: dockerCapabilityArgs fails
 * closed on non-empty netDomains (plain `docker run` has no per-domain
 * egress control), so net cases that Deno enforces per-domain are 'refused'
 * lane errors on Docker — also a denial, never broader access.
 */
import { join, posix } from 'node:path'
import type { CapabilityDeclaration } from '../../src/main/kernel'
import { EMPTY_CAPABILITIES, dockerCapabilityArgs } from '../../src/main/security/capabilities'
import type { SandboxErrorKind } from '../../src/main/security/sandbox'

export type LaneName = 'deno' | 'docker'

/** The probe stdin document (see probe.ts / probe.sh headers). */
export interface ProbeInput {
  readonly op: 'read' | 'write' | 'net' | 'sleep' | 'echo'
  readonly path?: string
  readonly url?: string
  readonly content?: string
  readonly ms?: number
  readonly value?: string
}

/** The probe stdout document. */
export interface ProbeOutput {
  readonly ok: boolean
  readonly denied: boolean
  readonly detail: string
  readonly data?: string
}

/** One running fixture HTTP server, as the table sees it. */
export interface ConformanceServer {
  /** `127.0.0.1:<port>` — exactly the netDomains grammar entry. */
  readonly hostPort: string
  readonly url: string
  /** Fixed body the server answers with (quote/backslash-free). */
  readonly body: string
  /** One entry per request the server ACTUALLY received (test clears/reads). */
  readonly requests: readonly string[]
}

/** Host-side fixture environment the integration suite builds in beforeAll. */
export interface ConformanceEnv {
  /** Host dir declared in fsRead; contains READ_FILE_NAME = READ_FILE_CONTENT. */
  readonly readDir: string
  /** REAL existing host file outside every declared scope (DoD escape 1). */
  readonly outsideReadFile: string
  /** Host dir declared in fsWrite. */
  readonly writeDir: string
  /** Existing host dir outside fsWrite — probes must not create files here. */
  readonly outsideWriteDir: string
  /** Reachable server the allowlist cases point at (DoD escape 2 target). */
  readonly allowedServer: ConformanceServer
  /** Second reachable server representing a non-allowlisted domain. */
  readonly blockedServer: ConformanceServer
}

export type ExpectedOutcome =
  /** Lane ran the probe; probe reports ok:true — optionally with exact data. */
  | { readonly kind: 'allowed'; readonly data?: string }
  /** Lane ran the probe; probe reports denied:true. */
  | { readonly kind: 'denied' }
  /** The lane itself failed the run (refused / timeout / ...). */
  | { readonly kind: 'lane-error'; readonly error: SandboxErrorKind }

export interface ConformanceCase {
  readonly name: string
  capabilities(env: ConformanceEnv): CapabilityDeclaration
  input(env: ConformanceEnv, lane: LaneName): ProbeInput
  expected(env: ConformanceEnv, lane: LaneName): ExpectedOutcome
  /** SandboxRunRequest.timeoutMs override (the timeout case). */
  readonly timeoutMs?: number
  /** Host file that must exist with exactly this content after the run. */
  hostFileAfter?(env: ConformanceEnv, lane: LaneName): { path: string; content: string }
  /** Host file that must NOT exist after the run. */
  hostFileAbsentAfter?(env: ConformanceEnv, lane: LaneName): string
  /** Expected request-log length per fixture server after the run (default 0/0). */
  serverRequestsAfter?(lane: LaneName): { allowed: number; blocked: number }
}

// ── Fixture constants ─────────────────────────────────────────────────────────
// All content strings are single-line and quote/backslash-free: probe.sh emits
// them into its JSON output verbatim (documented probe constraint).

export const READ_FILE_NAME = 'allowed.txt'
export const READ_FILE_CONTENT = 'sandbox-read-payload-7391'
export const OUTSIDE_READ_FILE_NAME = 'secret.txt'
export const OUTSIDE_READ_FILE_CONTENT = 'host-secret-outside-scope'
export const ALLOWED_SERVER_BODY = 'hello-from-allowed-server'
export const BLOCKED_SERVER_BODY = 'hello-from-blocked-server'

/** Docker-side out-of-scope targets: /caps paths NO case ever mounts. */
export const DOCKER_UNMOUNTED_READ_PATH = `/caps/read/99/${OUTSIDE_READ_FILE_NAME}`
export const DOCKER_UNMOUNTED_WRITE_DIR = '/caps/write/99'

const writtenFileName = (lane: LaneName): string => `probe-out-${lane}.txt`
const writtenContent = (lane: LaneName): string => `sandbox-write-payload-${lane}`
const escapeFileName = (lane: LaneName): string => `escape-${lane}.txt`

// ── Capability builders (shared by input/expected so the mapping cannot drift) ─

const readCaps = (env: ConformanceEnv): CapabilityDeclaration => ({
  ...EMPTY_CAPABILITIES,
  fsRead: [env.readDir]
})
const writeCaps = (env: ConformanceEnv): CapabilityDeclaration => ({
  ...EMPTY_CAPABILITIES,
  fsWrite: [env.writeDir]
})
const noNetCaps = (): CapabilityDeclaration => EMPTY_CAPABILITIES
const allowedNetCaps = (env: ConformanceEnv): CapabilityDeclaration => ({
  ...EMPTY_CAPABILITIES,
  netDomains: [env.allowedServer.hostPort]
})

/** Container path for a host file under a declared fsRead root. */
function dockerReadPath(caps: CapabilityDeclaration, hostRoot: string, fileName: string): string {
  const mount = dockerCapabilityArgs(caps).readMounts.get(hostRoot)
  if (!mount) throw new Error(`fixture bug: ${hostRoot} is not a declared fsRead root`)
  return posix.join(mount, fileName)
}

/** Container path for a host file under a declared fsWrite root. */
function dockerWritePath(caps: CapabilityDeclaration, hostRoot: string, fileName: string): string {
  const mount = dockerCapabilityArgs(caps).writeMounts.get(hostRoot)
  if (!mount) throw new Error(`fixture bug: ${hostRoot} is not a declared fsWrite root`)
  return posix.join(mount, fileName)
}

// ── The table ─────────────────────────────────────────────────────────────────

export const CONFORMANCE_CASES: readonly ConformanceCase[] = [
  {
    // Case 1 — proves a REAL read (exact content round-trip), not a vacuous pass.
    name: 'read inside fsRead is allowed with exact content',
    capabilities: readCaps,
    input: (env, lane) => ({
      op: 'read',
      path:
        lane === 'deno'
          ? join(env.readDir, READ_FILE_NAME)
          : dockerReadPath(readCaps(env), env.readDir, READ_FILE_NAME)
    }),
    expected: () => ({ kind: 'allowed', data: READ_FILE_CONTENT })
  },
  {
    // Case 2 — DoD escape attempt 1: read outside scope. The Deno target is a
    // REAL existing host file (denial is enforcement, not ENOENT).
    name: 'read outside fsRead is denied (escape attempt)',
    capabilities: readCaps,
    input: (env, lane) => ({
      op: 'read',
      path: lane === 'deno' ? env.outsideReadFile : DOCKER_UNMOUNTED_READ_PATH
    }),
    expected: () => ({ kind: 'denied' })
  },
  {
    // Case 3 — write lands ON THE HOST (Docker: through the rw bind mount).
    name: 'write inside fsWrite is allowed and reaches the host',
    capabilities: writeCaps,
    input: (env, lane) => ({
      op: 'write',
      path:
        lane === 'deno'
          ? join(env.writeDir, writtenFileName(lane))
          : dockerWritePath(writeCaps(env), env.writeDir, writtenFileName(lane)),
      content: writtenContent(lane)
    }),
    expected: () => ({ kind: 'allowed' }),
    hostFileAfter: (env, lane) => ({ path: join(env.writeDir, writtenFileName(lane)), content: writtenContent(lane) })
  },
  {
    // Case 4 — write outside scope: denied AND provably absent on the host.
    name: 'write outside fsWrite is denied and nothing lands on the host',
    capabilities: writeCaps,
    input: (env, lane) => ({
      op: 'write',
      path:
        lane === 'deno'
          ? join(env.outsideWriteDir, escapeFileName(lane))
          : posix.join(DOCKER_UNMOUNTED_WRITE_DIR, escapeFileName(lane)),
      content: 'escaped'
    }),
    expected: () => ({ kind: 'denied' }),
    hostFileAbsentAfter: (env, lane) => join(env.outsideWriteDir, escapeFileName(lane))
  },
  {
    // Case 5 — DoD escape attempt 2 (empty allowlist): the server IS reachable
    // from the host; only the sandbox denies. Its request log must stay EMPTY.
    // Docker note: with --network none the probe's wget can only ever hit the
    // CONTAINER loopback (nothing listens there) — the host server is
    // unreachable by construction, and the empty host-side log proves it.
    name: 'net fetch with empty netDomains is denied and never reaches the server',
    capabilities: noNetCaps,
    input: (env) => ({ op: 'net', url: env.allowedServer.url }),
    expected: () => ({ kind: 'denied' }),
    serverRequestsAfter: () => ({ allowed: 0, blocked: 0 })
  },
  {
    // Case 6 — non-allowlisted domain while another domain IS allowlisted.
    // Deno enforces per-domain; Docker fails closed on any netDomains
    // declaration ('refused' — also a denial, never broader access).
    name: 'net fetch to a non-allowlisted domain is denied (Deno) / refused (Docker)',
    capabilities: allowedNetCaps,
    input: (env) => ({ op: 'net', url: env.blockedServer.url }),
    expected: (_env, lane) => (lane === 'deno' ? { kind: 'denied' } : { kind: 'lane-error', error: 'refused' }),
    serverRequestsAfter: () => ({ allowed: 0, blocked: 0 })
  },
  {
    // Case 7 — the allowlisted domain: Deno allows and round-trips the body;
    // Docker 'refused' is PINNED as the fail-closed contract (per-domain
    // egress is unenforceable with plain `docker run`; network-capable rules
    // belong in the Deno lane — recorded phase-09 decision).
    name: 'net fetch to the allowlisted domain is allowed (Deno) / refused (Docker, fail-closed)',
    capabilities: allowedNetCaps,
    input: (env) => ({ op: 'net', url: env.allowedServer.url }),
    expected: (env, lane) =>
      lane === 'deno' ? { kind: 'allowed', data: env.allowedServer.body } : { kind: 'lane-error', error: 'refused' },
    serverRequestsAfter: (lane) => ({ allowed: lane === 'deno' ? 1 : 0, blocked: 0 })
  },
  {
    // Case 8 — wall-clock kill: a 120 s sleep dies at the 3 s deadline.
    name: 'sleep past the deadline is killed with a timeout failure',
    capabilities: noNetCaps,
    timeoutMs: 3000,
    input: () => ({ op: 'sleep', ms: 120_000 }),
    expected: () => ({ kind: 'lane-error', error: 'timeout' })
  },
  {
    // Case 9 — pins the JSON stdin/stdout contract itself, both directions.
    name: 'echo round-trips the input value through stdin/stdout',
    capabilities: noNetCaps,
    input: () => ({ op: 'echo', value: 'echo-roundtrip-91' }),
    expected: () => ({ kind: 'allowed', data: 'echo-roundtrip-91' })
  }
]
