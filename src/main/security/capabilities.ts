/**
 * Capability schema (§13, phase 09) — the SINGLE SOURCE for both sandbox
 * lanes and the kernel permission gates.
 *
 * `{ fsRead[], fsWrite[], netDomains[], tools[], maxSpendUSD }` is declared
 * once (agent registration or a user rule file) and derives:
 *  - the kernel's scope checks (PermissionEngine),
 *  - the Deno lane's --allow-read/--allow-write/--allow-net flags (§11 "a
 *    near 1:1 mapping"),
 *  - the Docker lane's volume mounts + network policy.
 *
 * Empty arrays / zero spend = default-deny: an undeclared capability does not
 * exist. Path semantics: a declared path grants that file or everything under
 * that directory. Net semantics mirror Deno's --allow-net grammar — `host`
 * allows every port on that host, `host:port` allows exactly that port; no
 * wildcard subdomains (declare each host).
 */
import { isAbsolute, relative, resolve, sep } from 'node:path'
import { homedir } from 'node:os'
import * as z from 'zod'
import type { CapabilityDeclaration } from '../kernel'

/** `host` or `host:port` — hostnames or IPv4; the Deno --allow-net grammar subset we accept. */
const NET_DOMAIN_RE = /^[a-zA-Z0-9]([a-zA-Z0-9.-]*[a-zA-Z0-9])?(:\d{1,5})?$/

/**
 * The zod validator for untrusted capability declarations (user rule files,
 * phase 11). Output shape satisfies the kernel's CapabilityDeclaration
 * contract; omitted fields default to deny (empty / 0).
 */
export const CapabilityDeclarationSchema = z.object({
  fsRead: z.array(z.string().min(1)).default([]),
  fsWrite: z.array(z.string().min(1)).default([]),
  netDomains: z
    .array(z.string().min(1).regex(NET_DOMAIN_RE, 'expected `host` or `host:port`'))
    .default([]),
  tools: z.array(z.string().min(1)).default([]),
  maxSpendUSD: z.number().min(0).finite().default(0)
})

// zod output must satisfy the kernel contract — compile-time pin.
type SchemaOutput = z.output<typeof CapabilityDeclarationSchema>
const _capabilityContractPin: CapabilityDeclaration = null as unknown as SchemaOutput
void _capabilityContractPin

/** No capabilities at all — the default-deny baseline. */
export const EMPTY_CAPABILITIES: CapabilityDeclaration = {
  fsRead: [],
  fsWrite: [],
  netDomains: [],
  tools: [],
  maxSpendUSD: 0
}

export class CapabilityError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'CapabilityError'
  }
}

/**
 * Parse + normalize an untrusted declaration: zod-validate, expand `~`,
 * resolve every path to an absolute one (relative paths are rejected — a
 * declaration must not depend on the daemon's cwd), dedupe.
 */
export function parseCapabilities(raw: unknown): CapabilityDeclaration {
  const parsed = CapabilityDeclarationSchema.safeParse(raw ?? {})
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('; ')
    throw new CapabilityError(`invalid capability declaration — ${detail}`)
  }
  const normalizePath = (p: string): string => {
    const expanded = p === '~' || p.startsWith('~/') || p.startsWith('~\\') ? homedir() + p.slice(1) : p
    if (!isAbsolute(expanded)) {
      throw new CapabilityError(
        `capability path '${p}' is not absolute — declarations must name absolute paths (use ~/ for the home directory)`
      )
    }
    return resolve(expanded)
  }
  return {
    fsRead: [...new Set(parsed.data.fsRead.map(normalizePath))],
    fsWrite: [...new Set(parsed.data.fsWrite.map(normalizePath))],
    netDomains: [...new Set(parsed.data.netDomains.map((d) => d.toLowerCase()))],
    tools: [...new Set(parsed.data.tools)],
    maxSpendUSD: parsed.data.maxSpendUSD
  }
}

/** Case handling matches the platform: win32 paths compare case-insensitively. */
const foldCase = (p: string): string => (process.platform === 'win32' ? p.toLowerCase() : p)

/** True when `candidate` is `root` itself or lives underneath it. */
export function isPathWithin(candidate: string, root: string): boolean {
  const rel = relative(foldCase(resolve(root)), foldCase(resolve(candidate)))
  return rel === '' || (!rel.startsWith('..' + sep) && rel !== '..' && !isAbsolute(rel))
}

/** True when every path is covered by at least one allowed root. */
export function pathsAllowed(paths: readonly string[], allowedRoots: readonly string[]): boolean {
  return paths.every((p) => allowedRoots.some((root) => isPathWithin(p, root)))
}

/**
 * Deno --allow-net semantics: a bare `host` entry allows every port on that
 * host; `host:port` allows exactly that port. Hosts compare case-insensitively
 * and exactly (no subdomain wildcards).
 */
export function isDomainAllowed(hostPort: string, netDomains: readonly string[]): boolean {
  const wanted = hostPort.toLowerCase()
  const colon = wanted.lastIndexOf(':')
  const wantedHost = colon === -1 ? wanted : wanted.slice(0, colon)
  return netDomains.some((allowed) => {
    const entry = allowed.toLowerCase()
    if (entry === wanted) return true
    // bare-host entry covers any port on that host
    return !entry.includes(':') && entry === wantedHost
  })
}

/** True when `inner` requests nothing beyond what `outer` declares. */
export function capabilitiesWithin(inner: CapabilityDeclaration, outer: CapabilityDeclaration): boolean {
  return (
    pathsAllowed(inner.fsRead, outer.fsRead) &&
    pathsAllowed(inner.fsWrite, outer.fsWrite) &&
    inner.netDomains.every((d) => isDomainAllowed(d, outer.netDomains)) &&
    inner.tools.every((t) => outer.tools.includes(t)) &&
    inner.maxSpendUSD <= outer.maxSpendUSD
  )
}

// ── Lane derivations (§11 "the permission engine derives the flags") ─────────

/**
 * Deno permission flags for a declaration — the §11 near-1:1 mapping. No
 * capability ⇒ no flag ⇒ Deno's default-deny. `--no-prompt` (deny instead of
 * interactive prompt) and `--no-remote` (rule code is local; remote imports
 * would be an undeclared network path) are unconditional.
 */
export function denoPermissionFlags(cap: CapabilityDeclaration): string[] {
  const flags: string[] = ['--no-prompt', '--no-remote']
  if (cap.fsRead.length > 0) flags.push(`--allow-read=${cap.fsRead.join(',')}`)
  if (cap.fsWrite.length > 0) flags.push(`--allow-write=${cap.fsWrite.join(',')}`)
  if (cap.netDomains.length > 0) flags.push(`--allow-net=${cap.netDomains.join(',')}`)
  return flags
}

export interface DockerCapabilityArgs {
  /** `docker run` arguments enforcing the declaration. */
  readonly args: string[]
  /** Host path → read-only container path (fsRead[i] → /caps/read/<i>). */
  readonly readMounts: ReadonlyMap<string, string>
  /** Host path → read-write container path (fsWrite[i] → /caps/write/<i>). */
  readonly writeMounts: ReadonlyMap<string, string>
}

/**
 * Docker enforcement for the same declaration: deny-by-default container —
 * `--network none`, all capabilities dropped, read-only root fs — with scoped
 * volume mounts derived from fsRead (ro) / fsWrite (rw).
 *
 * Per-domain network egress is NOT enforceable with plain `docker run` (no
 * native per-host firewall; DNS pinning is bypassable via raw IPs), so a
 * declaration with netDomains must FAIL CLOSED here: throws CapabilityError.
 * TS/JS rules needing network belong in the Deno lane, which enforces
 * per-domain allowlists for real. Recorded phase-09 decision.
 */
export function dockerCapabilityArgs(cap: CapabilityDeclaration): DockerCapabilityArgs {
  if (cap.netDomains.length > 0) {
    throw new CapabilityError(
      'the Docker lane cannot enforce per-domain network allowlists (netDomains) — ' +
        'it fails closed rather than granting broader access than declared; ' +
        'use the Deno lane for network-capable rules, or declare netDomains: []'
    )
  }
  const args: string[] = [
    '--network',
    'none',
    '--cap-drop',
    'ALL',
    '--security-opt',
    'no-new-privileges',
    '--read-only',
    '--tmpfs',
    '/tmp:rw,size=64m'
  ]
  const readMounts = new Map<string, string>()
  const writeMounts = new Map<string, string>()
  cap.fsRead.forEach((hostPath, i) => {
    const containerPath = `/caps/read/${i}`
    readMounts.set(hostPath, containerPath)
    args.push('-v', `${hostPath}:${containerPath}:ro`)
  })
  cap.fsWrite.forEach((hostPath, i) => {
    const containerPath = `/caps/write/${i}`
    writeMounts.set(hostPath, containerPath)
    args.push('-v', `${hostPath}:${containerPath}:rw`)
  })
  return { args, readMounts, writeMounts }
}
