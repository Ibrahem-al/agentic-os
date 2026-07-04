/**
 * Ordered, idempotent schema migrations (§21 rule 9) + the pre-migration
 * file-copy backup of the graph directory (§3, §5).
 *
 * Version bookkeeping is two-layer:
 * - authoritative: `SchemaVersion` nodes in the graph (one per applied
 *   migration; current version = max);
 * - bootstrap sidecar: `<graphDir>/schema-version.json`, read BEFORE the
 *   database is opened so the backup can be taken while no file locks are
 *   held (Windows forbids copying an open RyuGraph db, and closing the
 *   handle to copy is not an option — see engine.close()). A missing or
 *   stale sidecar just means a defensive backup, never a skipped one.
 *
 * Idempotency: every statement in a migration must be safely re-runnable
 * (IF NOT EXISTS, SHOW_INDEXES guards) so a crash mid-migration re-applies
 * cleanly on next boot.
 */
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { allTableDdl, ftsIndexName, indexDdl, RETRIEVABLE_LABELS, vectorIndexName } from './schema'
import type { CypherParams, Row } from './engine'

export interface MigrationContext {
  /** Runs on the engine's write connection, inside the migration's lane job. */
  cypher(query: string, params?: CypherParams): Promise<Row[]>
}

export interface Migration {
  /** Positive integer; strictly ordered. */
  readonly version: number
  readonly name: string
  up(ctx: MigrationContext): Promise<void>
}

/** v1 — the full §18 schema: 13 node tables + 15 rel tables + vector/FTS indexes. */
const initialSchema: Migration = {
  version: 1,
  name: 'initial-schema',
  async up(ctx) {
    for (const ddl of allTableDdl()) await ctx.cypher(ddl)
    const existing = new Set(
      (await ctx.cypher('CALL SHOW_INDEXES() RETURN *')).map(
        (r) => `${String(r['table name'] ?? r['table_name'])}.${String(r['index name'] ?? r['index_name'])}`
      )
    )
    for (const label of RETRIEVABLE_LABELS) {
      const ddl = indexDdl(label)
      if (!existing.has(`${label}.${vectorIndexName(label)}`)) await ctx.cypher(ddl.vector)
      if (!existing.has(`${label}.${ftsIndexName(label)}`)) await ctx.cypher(ddl.fts)
    }
  }
}

/** The production migration registry, ascending by version. */
export const MIGRATIONS: readonly Migration[] = [initialSchema]

/** Validates uniqueness/ordering and returns an ascending-sorted copy. */
export function validateMigrations(migrations: readonly Migration[]): Migration[] {
  const sorted = [...migrations].sort((a, b) => a.version - b.version)
  const seen = new Set<number>()
  for (const m of sorted) {
    if (!Number.isSafeInteger(m.version) || m.version < 1) {
      throw new Error(`migration version must be a positive integer: ${m.version} (${m.name})`)
    }
    if (!m.name) throw new Error(`migration v${m.version} has no name`)
    if (seen.has(m.version)) throw new Error(`duplicate migration version: ${m.version}`)
    seen.add(m.version)
  }
  return sorted
}

// ── Sidecar ──────────────────────────────────────────────────────────────────

const SIDECAR_FILENAME = 'schema-version.json'

/** Schema version recorded beside the db files; null when absent/unreadable. */
export function readSchemaSidecar(graphDir: string): number | null {
  try {
    const raw = readFileSync(join(graphDir, SIDECAR_FILENAME), 'utf8')
    const parsed: unknown = JSON.parse(raw)
    const version = (parsed as { version?: unknown }).version
    return typeof version === 'number' && Number.isSafeInteger(version) && version >= 0 ? version : null
  } catch {
    return null
  }
}

export function writeSchemaSidecar(graphDir: string, version: number): void {
  writeFileSync(
    join(graphDir, SIDECAR_FILENAME),
    JSON.stringify({ version, updatedAt: new Date().toISOString() }, null, 2)
  )
}

// ── Pre-migration backup ─────────────────────────────────────────────────────

/** True when the graph directory exists and holds anything worth backing up. */
export function graphDirHasData(graphDir: string): boolean {
  try {
    return readdirSync(graphDir).length > 0
  } catch {
    return false
  }
}

/**
 * File-copies the whole graph directory into
 * `<backupsDir>/<stamp>-pre-migration-v<targetVersion>/`. Must be called
 * BEFORE the database is opened (open db files cannot be copied on Windows).
 * Returns the created backup directory.
 */
export function backupGraphDir(graphDir: string, backupsDir: string, targetVersion: number): string {
  mkdirSync(backupsDir, { recursive: true })
  const stamp = new Date().toISOString().replaceAll(':', '-').replace(/\.\d+Z$/, 'Z')
  const base = join(backupsDir, `${stamp}-pre-migration-v${targetVersion}`)
  let dest = base
  for (let n = 2; existsSync(dest); n++) dest = `${base}-${n}`
  cpSync(graphDir, dest, { recursive: true })
  return dest
}
