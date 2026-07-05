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

/** How long `docker version` may take before we call the daemon unreachable. */
const DETECT_TIMEOUT_MS = 10_000

/** Cached per process — the daemon's presence rarely changes mid-run. */
let cachedDetection: Promise<DockerDetection> | null = null

/**
 * Probe the Docker daemon once per process (§11/§1 detect-and-guide):
 * `docker version --format {{.Server.Version}}` succeeds only when both the
 * CLI exists AND the daemon answers. Any failure yields install/start
 * guidance instead of an error.
 */
export function detectDocker(): Promise<DockerDetection> {
  cachedDetection ??= probeDocker()
  return cachedDetection
}

/** Test seam: clear the per-process cache so the next call re-probes. */
export function resetDockerDetection(): void {
  cachedDetection = null
}

function probeDocker(): Promise<DockerDetection> {
  return new Promise((resolve) => {
    let child
    try {
      child = spawn('docker', ['version', '--format', '{{.Server.Version}}'], { windowsHide: true })
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
    child.on('close', (code) => {
      const version = stdout.trim()
      if (code === 0 && version !== '') {
        settle({ available: true, version })
      } else {
        const detail = stderr.trim().split('\n')[0]
        settle({ available: false, guidance: detail ? `${DOCKER_GUIDANCE} (docker said: ${detail})` : DOCKER_GUIDANCE })
      }
    })
  })
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
