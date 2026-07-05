/**
 * Deno-lane conformance probe (phase 09, §11). Runs ONLY inside the Deno
 * sandbox lane — never imported by host test code (§21 rule 3). No imports
 * at all: Deno globals only, because the lane passes --no-remote (and an
 * import would be an undeclared capability anyway).
 *
 * Contract (shared with probe.sh): read ONE JSON document from stdin
 *   { op: 'read'|'write'|'net'|'sleep'|'echo', path?, url?, content?, ms?, value? }
 * print ONE JSON document to stdout
 *   { ok: boolean, denied: boolean, detail: string, data?: string }
 *
 * Denied detection: Deno 2 throws Deno.errors.NotCapable (name 'NotCapable');
 * Deno 1 threw PermissionDenied — both map to denied:true. Any other error is
 * ok:false / denied:false with the detail, so a broken probe never masquerades
 * as an enforcement result. Always exits 0: the outcome IS the JSON document.
 *
 * This directory is excluded from the repo's tsc/eslint runs (Deno globals);
 * see tsconfig.node.json / eslint.config.js.
 */

interface ProbeRequest {
  op?: string
  path?: string
  url?: string
  content?: string
  ms?: number
  value?: unknown
}

interface ProbeResponse {
  ok: boolean
  denied: boolean
  detail: string
  data?: string
}

function reply(response: ProbeResponse): void {
  console.log(JSON.stringify(response))
}

async function readStdin(): Promise<string> {
  const chunks: Uint8Array[] = []
  for await (const chunk of Deno.stdin.readable) chunks.push(chunk)
  let total = 0
  for (const chunk of chunks) total += chunk.length
  const merged = new Uint8Array(total)
  let at = 0
  for (const chunk of chunks) {
    merged.set(chunk, at)
    at += chunk.length
  }
  return new TextDecoder().decode(merged)
}

const request: ProbeRequest = JSON.parse(await readStdin())

try {
  switch (request.op) {
    case 'read': {
      const data = Deno.readTextFileSync(request.path ?? '')
      reply({ ok: true, denied: false, detail: 'read ok', data })
      break
    }
    case 'write': {
      Deno.writeTextFileSync(request.path ?? '', request.content ?? '')
      reply({ ok: true, denied: false, detail: 'write ok' })
      break
    }
    case 'net': {
      // Short abort timeout: a firewalled-but-allowed fetch must not eat the
      // whole sandbox deadline.
      const response = await fetch(request.url ?? '', { signal: AbortSignal.timeout(3000) })
      const body = await response.text()
      reply({ ok: true, denied: false, detail: `net ok ${response.status}`, data: body })
      break
    }
    case 'sleep': {
      await new Promise((resolve) => setTimeout(resolve, request.ms ?? 0))
      reply({ ok: true, denied: false, detail: 'sleep ok' })
      break
    }
    case 'echo': {
      reply({ ok: true, denied: false, detail: 'echo ok', data: String(request.value) })
      break
    }
    default:
      reply({ ok: false, denied: false, detail: `unknown op: ${String(request.op)}` })
  }
} catch (err) {
  const name = err instanceof Error ? err.name : ''
  const detail = err instanceof Error ? `${err.name}: ${err.message}` : String(err)
  reply({ ok: false, denied: name === 'NotCapable' || name === 'PermissionDenied', detail })
}
