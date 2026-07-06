/**
 * JSON serialization helpers shared across the reads module — extracted
 * verbatim from `ipc.ts` so the phase-15 wire refactor is behavior-identical.
 *
 * Every read function returns a plain, renderer-safe DTO (spec §21 rule 8);
 * these two coerce arbitrary store values (Dates, bigints, nested objects)
 * into the JSON shape both consumers — the dashboard IPC layer and the MCP
 * read tools — hand back.
 */
import type { JsonObject, JsonValue } from '../../shared/ipc'

/** Date → ISO recursively; drops functions/undefined; keeps JSON shape. */
export const jsonify = (value: unknown): JsonValue => {
  if (value === null || value === undefined) return null
  if (value instanceof Date) return value.toISOString()
  if (typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number') return Number.isFinite(value) ? value : String(value)
  if (typeof value === 'bigint') return Number(value)
  if (Array.isArray(value)) return value.map(jsonify)
  if (typeof value === 'object') {
    const out: JsonObject = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (v !== undefined && typeof v !== 'function') out[k] = jsonify(v)
    }
    return out
  }
  return String(value)
}

export const jsonObject = (value: unknown): JsonObject => {
  const result = jsonify(value)
  return typeof result === 'object' && result !== null && !Array.isArray(result) ? result : {}
}
