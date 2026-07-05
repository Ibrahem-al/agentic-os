/**
 * Docker sandbox lane (§11 polyglot lane, §21 rule 3) — rule code in any
 * language runs in a deny-by-default container whose mounts + network policy
 * derive from the SAME CapabilityDeclaration as the Deno lane (§13 single
 * source) via dockerCapabilityArgs. Docker is OPTIONAL (§1): when the daemon
 * is absent the lane detects and guides instead of crashing.
 *
 * Fail-closed contract (recorded phase-09 decision, see capabilities.ts):
 * plain `docker run` cannot enforce PER-DOMAIN egress, so a declaration with
 * non-empty netDomains is 'refused' here — network-capable rules belong in
 * the Deno lane, which enforces --allow-net=<domains> for real.
 *
 * Volume mounts: host sides of `-v` keep their absolute Windows form
 * (`C:\dir`) — Docker Desktop parses the drive-letter colon correctly;
 * container sides stay POSIX (/sandbox, /caps/...).
 *
 * Linux-containers daemons ONLY: a Windows-containers daemon answers `docker
 * version` but cannot run the alpine lane image or its Linux-only flags
 * (`--read-only` is rejected outright), so detection checks Server.Os and
 * reports a windows daemon unavailable-with-guidance — the conformance suite
 * and the lane both consult the same detection and fail fast instead of
 * surfacing a raw daemon error 125.
 *
 * Container user: on POSIX hosts the container runs as the HOST user
 * (`--user uid:gid`), see dockerHostUserArgs. With `--cap-drop ALL` root has
 * no CAP_DAC_OVERRIDE, and a native-Linux daemon's bind mounts expose real
 * host ownership/mode bits — so a root container process cannot create files
 * in an fsWrite mount owned by a non-root host user (found on CI: probe
 * write EACCES on ubuntu while Docker Desktop's file-sharing layer masked it
 * locally). Matching the host user makes in-container DAC agree exactly with
 * what the host user may do, never more.
 */
import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { basename, dirname } from 'node:path'
import { DOCKER_LANE_IMAGE, SANDBOX_MEMORY_MB_DEFAULT, SANDBOX_TIMEOUT_MS_DEFAULT } from '../config'
import { CapabilityError, dockerCapabilityArgs } from './capabilities'
import type { DockerCapabilityArgs } from './capabilities'
import { collectSandboxProcess } from './sandbox'
import type { SandboxLane, SandboxResult, SandboxRunRequest } from './sandbox'

export type DockerDetection =
  | { readonly available: true; readonly version: string }
  | { readonly available: false; readonly guidance: string }

const DOCKER_GUIDANCE =
  'Docker is not reachable — the polyglot sandbox lane needs Docker Desktop. ' +
  'Install it from https://www.docker.com/products/docker-desktop/ (Windows: `winget install Docker.DockerDesktop`), ' +
  'start it, and wait until the whale icon reports the engine is running, then retry. ' +
  'JS/TS rules do not need Docker — they run in the managed Deno lane.'

const WINDOWS_CONTAINERS_GUIDANCE =
  'Docker daemon is in Windows-containers mode — switch to Linux containers to run polyglot rules ' +
  '(Docker Desktop tray icon → "Switch to Linux containers…"). ' +
  'JS/TS rules do not need Docker — they run in the managed Deno lane.'

/** How long `docker version` may take before we call the daemon unreachable. */
const DETECT_TIMEOUT_MS = 10_000

/** Cached per process — the daemon's presence rarely changes mid-run. */
let cachedDetection: Promise<DockerDetection> | null = null

/**
 * Probe the Docker daemon once per process (§11/§1 detect-and-guide):
 * `docker version --format '{{.Server.Os}} {{.Server.Version}}'` succeeds
 * only when both the CLI exists AND the daemon answers — and the answer must
 * say the daemon runs LINUX containers (see interpretDockerProbe). Any
 * failure yields install/start/switch guidance instead of an error.
 */
export function detectDocker(): Promise<DockerDetection> {
  cachedDetection ??= probeDocker()
  return cachedDetection
}

/** Test seam: clear the per-process cache so the next call re-probes. */
export function resetDockerDetection(): void {
  cachedDetection = null
}

/**
 * Pure decision over the version-probe output (exported for the conformance
 * suite's unit-style pins — it runs even where Docker is absent):
 *  - server Os 'linux' + a version → available. Docker Desktop on every host
 *    OS reports 'linux' here (the engine lives in its VM), so this stays
 *    available on Windows/macOS machines in Linux-containers mode.
 *  - server Os 'windows' → unavailable with SWITCH guidance: the daemon is
 *    real but runs Windows containers, which can never execute the alpine
 *    lane image or its Linux-only flags (--read-only et al.).
 *  - anything else (nonzero exit, empty output) → unavailable with
 *    install/start guidance, first stderr line attached when present.
 */
export function interpretDockerProbe(code: number | null, stdout: string, stderr: string): DockerDetection {
  const [serverOs = '', version = ''] = stdout.trim().split(/\s+/)
  if (code === 0 && serverOs.toLowerCase() === 'linux' && version !== '') {
    return { available: true, version }
  }
  if (code === 0 && serverOs.toLowerCase() === 'windows') {
    return { available: false, guidance: WINDOWS_CONTAINERS_GUIDANCE }
  }
  const detail = stderr.trim().split('\n')[0]
  return { available: false, guidance: detail ? `${DOCKER_GUIDANCE} (docker said: ${detail})` : DOCKER_GUIDANCE }
}

function probeDocker(): Promise<DockerDetection> {
  return new Promise((resolve) => {
    let child
    try {
      child = spawn('docker', ['version', '--format', '{{.Server.Os}} {{.Server.Version}}'], { windowsHide: true })
    } catch {
      resolve({ available: false, guidance: DOCKER_GUIDANCE })
      return
    }
    let stdout = ''
    let stderr = ''
    let settled = false
    const settle = (detection: DockerDetection): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(detection)
    }
    // A CLI that hangs (engine mid-startup) is as unusable as an absent one.
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      settle({ available: false, guidance: DOCKER_GUIDANCE })
    }, DETECT_TIMEOUT_MS)
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => (stdout += chunk))
    child.stderr.on('data', (chunk: string) => (stderr += chunk))
    child.on('error', () => settle({ available: false, guidance: DOCKER_GUIDANCE }))
    child.on('close', (code) => settle(interpretDockerProbe(code, stdout, stderr)))
  })
}

/**
 * `--user` flags matching the HOST user — POSIX hosts only. On a native
 * Linux daemon, bind mounts expose real host uid/gid/mode bits, and with
 * `--cap-drop ALL` the container's root has no CAP_DAC_OVERRIDE, so uid 0 is
 * subject to ordinary permission checks: it can neither create files in an
 * fsWrite mount owned by a non-root host user (dir mode 0755 → the "other"
 * class has no w) nor should it — the capability means "what the host user
 * may write", never more. Running as the host user makes in-container DAC
 * agree exactly with host DAC and lands created files host-owned. Windows
 * has no getuid/getgid (Docker Desktop's file-sharing layer presents mounts
 * permissively there), so the flags are omitted. Known limitation, recorded:
 * ROOTLESS daemons remap uids themselves, where the default user would be
 * the better fit — CI and supported dev setups run rootful daemons.
 */
export function dockerHostUserArgs(
  getuid: (() => number) | undefined = process.getuid,
  getgid: (() => number) | undefined = process.getgid
): string[] {
  if (getuid === undefined || getgid === undefined) return []
  return ['--user', `${getuid()}:${getgid()}`]
}

// ── The lane ─────────────────────────────────────────────────────────────────

export interface DockerLaneOptions {
  /** Container image for runs. Defaults to DOCKER_LANE_IMAGE (§20). */
  readonly image?: string
}

export class DockerLane implements SandboxLane {
  readonly name = 'docker' as const
  private readonly image: string

  constructor(options?: DockerLaneOptions) {
    this.image = options?.image ?? DOCKER_LANE_IMAGE
  }

  async run(request: SandboxRunRequest): Promise<SandboxResult> {
    const startedAt = Date.now()

    // Derive enforcement FIRST: a declaration this lane cannot honor must be
    // refused before anything runs (fail closed), even if Docker is absent.
    let capabilityArgs: DockerCapabilityArgs
    try {
      capabilityArgs = dockerCapabilityArgs(request.capabilities)
    } catch (err) {
      if (err instanceof CapabilityError) {
        return { ok: false, error: { kind: 'refused', message: err.message }, durationMs: Date.now() - startedAt }
      }
      throw err
    }

    const docker = await detectDocker()
    if (!docker.available) {
      return { ok: false, error: { kind: 'spawn-failed', message: docker.guidance }, durationMs: Date.now() - startedAt }
    }

    const timeoutMs = request.timeoutMs ?? SANDBOX_TIMEOUT_MS_DEFAULT
    const memoryMb = request.memoryMb ?? SANDBOX_MEMORY_MB_DEFAULT
    const containerName = `sbx-${randomBytes(8).toString('hex')}`
    const entryDir = dirname(request.entryFile)
    const entryBase = basename(request.entryFile)
    const args = [
      'run',
      '--rm',
      '-i', // stdin carries the JSON input document
      '--name',
      containerName,
      '--memory',
      `${memoryMb}m`,
      '--memory-swap', // equal to --memory: the cap is a cap, not a swap budget
      `${memoryMb}m`,
      '--pids-limit',
      '128',
      '--cpus',
      '1',
      ...dockerHostUserArgs(), // run as the host user on POSIX (see fn doc)
      ...capabilityArgs.args,
      '-v',
      `${entryDir}:/sandbox:ro`,
      this.image,
      'sh',
      `/sandbox/${entryBase}`
    ]
    const child = spawn('docker', args, { windowsHide: true })
    return collectSandboxProcess(child, request.input, timeoutMs, () => {
      // SIGKILLing the docker CLI kills only the CLIENT — the container keeps
      // running (worse: with its stdin never seeing EOF, a probe blocked on
      // reading input hangs forever). Kill it BY NAME — and retry: under load
      // the deadline can fire while `docker run` is still creating the
      // container, so a single kill races creation and misses (observed live,
      // phase 09: one leaked sleeper container). --rm reaps it once dead.
      void killContainerWithRetries(containerName)
    })
  }
}

const KILL_RETRIES = 6
const KILL_RETRY_DELAY_MS = 2000

/** Fire-and-forget: keep trying `docker kill <name>` until one lands. */
async function killContainerWithRetries(containerName: string): Promise<void> {
  for (let attempt = 0; attempt < KILL_RETRIES; attempt++) {
    const killed = await new Promise<boolean>((resolve) => {
      let child
      try {
        child = spawn('docker', ['kill', containerName], { stdio: 'ignore', windowsHide: true })
      } catch {
        resolve(false)
        return
      }
      child.on('error', () => resolve(false))
      child.on('close', (code) => resolve(code === 0))
    })
    if (killed) return
    // Not killable yet (still being created) or already gone — wait and
    // retry; a final miss means the container never came up at all.
    await new Promise((resolve) => setTimeout(resolve, KILL_RETRY_DELAY_MS))
  }
}
