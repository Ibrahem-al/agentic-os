/**
 * Sandbox lane contract (§11 "two lanes, one policy") — the shared request /
 * result shapes both lanes implement, and the timeout/JSON plumbing they
 * share. deno.ts and docker.ts are the only implementations; user/rule code
 * NEVER executes in the host process (§21 rule 3).
 *
 * Contract: the sandboxed program receives ONE JSON document on stdin and
 * must print ONE JSON document to stdout. Anything else (non-JSON stdout,
 * non-zero exit, timeout, oversized output) is a structured lane error — the
 * caller decides what to do (§15).
 */
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import type { CapabilityDeclaration } from '../kernel'

export interface SandboxRunRequest {
  /** The capability declaration limits derive from (§13 single source). */
  readonly capabilities: CapabilityDeclaration
  /** Absolute path of the entry script (TS/JS for Deno; any language for Docker). */
  readonly entryFile: string
  /** JSON value written to the program's stdin. */
  readonly input: unknown
  /** Wall-clock kill deadline (ms). Defaults to SANDBOX_TIMEOUT_MS_DEFAULT. */
  readonly timeoutMs?: number
  /** Memory cap (MiB). Defaults to SANDBOX_MEMORY_MB_DEFAULT. */
  readonly memoryMb?: number
}

export type SandboxErrorKind =
  | 'spawn-failed' // lane binary/daemon missing or unlaunchable
  | 'timeout' // killed at the wall-clock deadline
  | 'nonzero-exit' // program exited with a failure code
  | 'bad-output' // stdout was not a single JSON document
  | 'refused' // the lane cannot enforce the declaration (fails closed)

export interface SandboxFailure {
  readonly ok: false
  readonly error: {
    readonly kind: SandboxErrorKind
    readonly message: string
    /** Tail of stderr (bounded) for diagnostics. */
    readonly stderr?: string
  }
  readonly durationMs: number
}

export interface SandboxSuccess {
  readonly ok: true
  /** The JSON document the program printed to stdout. */
  readonly value: unknown
  readonly durationMs: number
}

export type SandboxResult = SandboxSuccess | SandboxFailure

/** One sandbox lane (§11): Deno (default, TS/JS) or Docker (polyglot). */
export interface SandboxLane {
  readonly name: 'deno' | 'docker'
  run(request: SandboxRunRequest): Promise<SandboxResult>
}

// ── Shared plumbing (used by both lane implementations) ──────────────────────

/** Bytes of stdout/stderr kept per run — beyond this the run fails cleanly. */
export const SANDBOX_MAX_OUTPUT_BYTES = 1024 * 1024
/** Stderr tail included in failures. */
export const SANDBOX_STDERR_TAIL_CHARS = 2000

/**
 * Feed `input` to a spawned lane process, collect bounded stdout/stderr,
 * enforce the wall-clock deadline (SIGKILL), and parse stdout as ONE JSON
 * document. Shared by both lanes so the contract cannot drift between them.
 */
export function collectSandboxProcess(
  child: ChildProcessWithoutNullStreams,
  input: unknown,
  timeoutMs: number,
  onTimeout?: () => void
): Promise<SandboxResult> {
  const startedAt = Date.now()
  return new Promise((resolvePromise) => {
    let stdout = ''
    let stderr = ''
    let truncated = false
    let timedOut = false
    let settled = false

    const timer = setTimeout(() => {
      timedOut = true
      onTimeout?.()
      child.kill('SIGKILL')
    }, timeoutMs)

    const settle = (result: SandboxResult): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolvePromise(result)
    }
    const fail = (kind: SandboxErrorKind, message: string): void =>
      settle({
        ok: false,
        error: {
          kind,
          message,
          ...(stderr !== '' ? { stderr: stderr.slice(-SANDBOX_STDERR_TAIL_CHARS) } : {})
        },
        durationMs: Date.now() - startedAt
      })

    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      if (stdout.length + chunk.length > SANDBOX_MAX_OUTPUT_BYTES) truncated = true
      stdout = (stdout + chunk).slice(0, SANDBOX_MAX_OUTPUT_BYTES)
    })
    child.stderr.on('data', (chunk: string) => {
      stderr = (stderr + chunk).slice(-SANDBOX_MAX_OUTPUT_BYTES)
    })
    child.on('error', (err) => fail('spawn-failed', err.message))
    child.on('close', (code) => {
      if (timedOut) return fail('timeout', `killed after ${timeoutMs}ms wall-clock deadline`)
      if (code !== 0) return fail('nonzero-exit', `sandbox program exited with code ${code}`)
      if (truncated) return fail('bad-output', `stdout exceeded ${SANDBOX_MAX_OUTPUT_BYTES} bytes`)
      try {
        const value: unknown = JSON.parse(stdout)
        settle({ ok: true, value, durationMs: Date.now() - startedAt })
      } catch {
        fail('bad-output', 'sandbox program did not print a single JSON document to stdout')
      }
    })

    child.stdin.on('error', () => undefined) // program may exit without reading stdin
    child.stdin.end(JSON.stringify(input ?? null))
  })
}
