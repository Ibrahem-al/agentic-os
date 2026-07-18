/**
 * Cross-platform OS process resource sampler (task-control feature: "what process
 * is running for a task and how much RAM/CPU"). No new dependency — spawns the
 * platform's own tool the same way runner/index.ts's zombie probe does:
 *   - win32: `tasklist /FI "PID eq N" /FO CSV /NH` → working-set memory. tasklist
 *     reports NO CPU%, so cpuPercent is null there (an honest gap — Windows CPU%
 *     needs a two-sample delta we deliberately do not pay for on a read).
 *   - posix: `ps -p N -o rss=,%cpu=` → RSS + a since-start average CPU%.
 * NEVER throws — a vanished pid / missing tool / unparsable line degrades to null,
 * so a resource read is always safe (the process list is best-effort telemetry).
 * The app's OWN main process is sampled by Electron (app.getAppMetrics) upstream,
 * which gives CPU on every platform; this samples out-of-process children only.
 */
import { spawn } from 'node:child_process'

export interface ProcResourceSample {
  /** Percent of one core (may exceed 100 across cores); null when the OS tool omits it. */
  readonly cpuPercent: number | null
  /** Resident/working-set bytes; null when unparsable. */
  readonly memoryBytes: number | null
}

/** Spawn `command args`, capture trimmed stdout, or null on any failure/timeout (5s cap). */
function runCapture(command: string, args: readonly string[]): Promise<string | null> {
  return new Promise((resolve) => {
    let child
    try {
      child = spawn(command, [...args], { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] })
    } catch {
      resolve(null)
      return
    }
    let stdout = ''
    let settled = false
    const settle = (value: string | null): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(value)
    }
    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL')
      } catch {
        /* gone */
      }
      settle(null)
    }, 5000)
    child.stdout?.setEncoding('utf8')
    child.stdout?.on('data', (chunk: string) => (stdout += chunk))
    child.on('error', () => settle(null))
    child.on('close', (code) => settle(code === 0 ? stdout : null))
  })
}

/** Pull the quoted fields out of one tasklist CSV row (the mem field itself contains commas). */
function csvFields(line: string): string[] {
  const out: string[] = []
  const re = /"([^"]*)"/g
  let m: RegExpExecArray | null
  while ((m = re.exec(line)) !== null) out.push(m[1] ?? '')
  return out
}

/** "12,345 K" → 12645... bytes (KB×1024). Returns null when the field is N/A / unparsable. */
function parseWinMemKb(field: string | undefined): number | null {
  if (field === undefined) return null
  const digits = field.replace(/[^\d]/g, '')
  if (digits === '') return null
  return Number(digits) * 1024
}

/**
 * Sample a live pid's CPU%/memory, or null when it does not resolve. `platform`
 * is a test seam (defaults to the real platform).
 */
export async function sampleProcess(
  pid: number,
  platform: NodeJS.Platform = process.platform
): Promise<ProcResourceSample | null> {
  if (!Number.isInteger(pid) || pid <= 0) return null
  try {
    if (platform === 'win32') {
      const out = await runCapture('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'])
      if (out === null) return null
      const line = out.trim().split(/\r?\n/, 1)[0] ?? ''
      const fields = csvFields(line)
      // A found task prints 5 quoted fields ("image","pid",...,"mem usage"); a
      // "no tasks" INFO line has none.
      if (fields.length < 5) return null
      return { cpuPercent: null, memoryBytes: parseWinMemKb(fields[4]) }
    }
    const out = await runCapture('ps', ['-p', String(pid), '-o', 'rss=,%cpu='])
    if (out === null) return null
    const line = out.trim().split(/\r?\n/, 1)[0]?.trim() ?? ''
    const m = /^(\d+)\s+([\d.]+)/.exec(line)
    if (m === null) return null
    return { memoryBytes: Number(m[1]) * 1024, cpuPercent: Number(m[2]) }
  } catch {
    return null
  }
}
