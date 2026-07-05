/**
 * Managed Deno sandbox lane (§11 default lane, §21 rule 3) — JS/TS rule code
 * runs under Deno's permission sandbox, NEVER in the host process. The lane's
 * flags derive 1:1 from the agent's CapabilityDeclaration (§13 single source)
 * via denoPermissionFlags; the shared collectSandboxProcess plumbing enforces
 * the JSON stdin/stdout contract, output bounds, and the wall-clock kill.
 *
 * The binary itself is MANAGED: exact version + per-platform zip sha256 are
 * pinned in config.ts (DENO_VERSION / DENO_PLATFORM_ASSETS), downloaded on
 * first use to <binDir>/deno-v<version>/ — checksum-verified and resumable,
 * the same pattern as the phase-02 reranker weights. Never fetched from
 * anywhere but the pinned GitHub release URL.
 *
 * Resource caps: memory via --v8-flags=--max-old-space-size (V8 heap, MiB).
 * CPU-time capping is APPROXIMATED by the wall-clock SIGKILL in
 * collectSandboxProcess — Node exposes no cross-platform per-process CPU
 * rlimit, so a spinning sandbox burns at most `timeoutMs` of wall clock.
 */
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmod, mkdir, open, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  DENO_PLATFORM_ASSETS,
  DENO_VERSION,
  SANDBOX_MEMORY_MB_DEFAULT,
  SANDBOX_TIMEOUT_MS_DEFAULT,
  denoDownloadUrl
} from '../config'
import { denoPermissionFlags } from './capabilities'
import { collectSandboxProcess } from './sandbox'
import type { SandboxLane, SandboxResult, SandboxRunRequest } from './sandbox'
import { extractZipEntry } from './zip'

export class DenoBinaryError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'DenoBinaryError'
  }
}

export interface EnsureDenoBinaryOptions {
  /** Directory the managed binaries live under (e.g. userData/bin). */
  readonly binDir: string
  /** Test seam — defaults to global fetch (follows GitHub's 302 redirects). */
  readonly fetchImpl?: typeof fetch
}

const exists = (path: string): Promise<boolean> => stat(path).then(() => true, () => false)

/**
 * Concurrent ensureDenoBinary calls in one process share one in-flight
 * promise per target path — a 42 MB archive must never download twice in
 * parallel (and parallel extractions would race the final rename).
 */
const inflight = new Map<string, Promise<string>>()

/**
 * Return the absolute path of the managed Deno binary for this platform,
 * downloading + extracting it first if absent:
 *   fetch pinned zip (resumable, .part + HTTP Range) → sha256-verify the
 *   COMPLETE zip against the config pin → extract the single binary →
 *   atomic temp-write + rename → chmod 0o755 (non-win32) → delete the zip.
 *
 * The extracted executable is NOT re-hashed on later calls: it can only ever
 * have been produced from a zip that passed the sha256 pin, and re-verifying
 * a ~120 MB exe on every sandbox spawn would tax the latency the Deno lane
 * exists for (§11 "millisecond startup").
 */
export function ensureDenoBinary(options: EnsureDenoBinaryOptions): Promise<string> {
  const binaryName = process.platform === 'win32' ? 'deno.exe' : 'deno'
  const versionDir = join(options.binDir, `deno-v${DENO_VERSION}`)
  const binaryPath = join(versionDir, binaryName)
  const existing = inflight.get(binaryPath)
  if (existing) return existing
  const promise = ensureOnce(binaryPath, versionDir, binaryName, options).finally(() => {
    inflight.delete(binaryPath)
  })
  inflight.set(binaryPath, promise)
  return promise
}

async function ensureOnce(
  binaryPath: string,
  versionDir: string,
  binaryName: string,
  options: EnsureDenoBinaryOptions
): Promise<string> {
  if (await exists(binaryPath)) return binaryPath

  const platformKey = `${process.platform}-${process.arch}`
  const pin = DENO_PLATFORM_ASSETS[platformKey]
  if (!pin) {
    throw new DenoBinaryError(
      `no pinned Deno ${DENO_VERSION} archive for platform '${platformKey}' — ` +
        `supported: ${Object.keys(DENO_PLATFORM_ASSETS).join(', ')} (config.ts DENO_PLATFORM_ASSETS)`
    )
  }
  await mkdir(versionDir, { recursive: true })
  const fetchImpl = options.fetchImpl ?? fetch
  const zipPath = join(versionDir, pin.asset)

  // A complete zip left by an earlier run (crash between rename and extract)
  // is reused — the sha256 check below decides whether it is trustworthy.
  if (!(await exists(zipPath))) {
    await downloadResumable(fetchImpl, denoDownloadUrl(pin), zipPath)
  }
  const zipBuffer = await readFile(zipPath)
  const actual = createHash('sha256').update(zipBuffer).digest('hex')
  if (actual !== pin.sha256) {
    await rm(zipPath, { force: true })
    throw new DenoBinaryError(
      `downloaded ${pin.asset} has sha256 ${actual}, expected ${pin.sha256} — deleted; refusing to extract an unverified archive`
    )
  }

  // The release zip contains exactly one file: the executable.
  const entry = extractZipEntry(zipBuffer, (name) => name === binaryName || name.endsWith(`/${binaryName}`))
  const tempPath = `${binaryPath}.tmp-${process.pid}`
  await writeFile(tempPath, entry.data)
  if (process.platform !== 'win32') await chmod(tempPath, 0o755)
  await rename(tempPath, binaryPath) // atomic: a concurrent reader never sees a half-written exe
  await rm(zipPath, { force: true })
  return binaryPath
}

/**
 * Resumable download: bytes accumulate in `<final>.part`; an interrupted run
 * resumes with an HTTP Range request (GitHub answers 206; a plain 200 means
 * the server ignored the range and we start over). Mirrors the reranker's
 * phase-02 download path.
 */
async function downloadResumable(fetchImpl: typeof fetch, url: string, finalPath: string): Promise<void> {
  const partPath = `${finalPath}.part`
  let offset = 0
  if (await exists(partPath)) {
    offset = (await stat(partPath)).size
  }
  const headers: Record<string, string> = {}
  if (offset > 0) headers['range'] = `bytes=${offset}-`

  const response = await fetchImpl(url, { headers })
  if (response.status === 200) {
    offset = 0 // server ignored the range (or fresh download) — start over
  } else if (response.status === 206) {
    // resuming — append below
  } else {
    throw new DenoBinaryError(`download of ${url} failed: HTTP ${response.status}`)
  }
  if (!response.body) throw new DenoBinaryError(`download of ${url} returned no body`)

  const handle = await open(partPath, offset > 0 ? 'r+' : 'w')
  try {
    let position = offset
    const reader = response.body.getReader()
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      await handle.write(value, 0, value.length, position)
      position += value.length
    }
    await handle.truncate(position)
  } finally {
    await handle.close()
  }
  await rename(partPath, finalPath)
}

// ── The lane ─────────────────────────────────────────────────────────────────

export interface DenoLaneOptions {
  /** Directory the managed binary lives under (ensureDenoBinary's binDir). */
  readonly binDir: string
}

/**
 * §11 default lane. Lazy: the managed binary is ensured on the first run()
 * call; a download or spawn failure surfaces as a structured 'spawn-failed'
 * SandboxFailure, never a throw — the caller (§15) decides what to do.
 */
export class DenoLane implements SandboxLane {
  readonly name = 'deno' as const
  private readonly binDir: string

  constructor(options: DenoLaneOptions) {
    this.binDir = options.binDir
  }

  async run(request: SandboxRunRequest): Promise<SandboxResult> {
    const startedAt = Date.now()
    let binaryPath: string
    try {
      binaryPath = await ensureDenoBinary({ binDir: this.binDir })
    } catch (err) {
      return {
        ok: false,
        error: {
          kind: 'spawn-failed',
          message: `managed Deno binary unavailable: ${err instanceof Error ? err.message : String(err)}`
        },
        durationMs: Date.now() - startedAt
      }
    }
    const timeoutMs = request.timeoutMs ?? SANDBOX_TIMEOUT_MS_DEFAULT
    const memoryMb = request.memoryMb ?? SANDBOX_MEMORY_MB_DEFAULT
    const args = [
      'run',
      '--quiet',
      ...denoPermissionFlags(request.capabilities),
      `--v8-flags=--max-old-space-size=${memoryMb}`,
      request.entryFile
    ]
    try {
      const child = spawn(binaryPath, args, { windowsHide: true })
      return await collectSandboxProcess(child, request.input, timeoutMs)
    } catch (err) {
      // spawn() throws synchronously only on argument-level problems; runtime
      // launch failures arrive as the 'error' event collectSandboxProcess maps.
      return {
        ok: false,
        error: { kind: 'spawn-failed', message: err instanceof Error ? err.message : String(err) },
        durationMs: Date.now() - startedAt
      }
    }
  }
}
