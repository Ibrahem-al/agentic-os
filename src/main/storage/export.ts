/**
 * Graph export job (§5 "memory insurance"): dump every node and relationship
 * to `exports/<date>/` as Neo4j-compatible CSVs plus a generic Cypher
 * statement file, so accumulated memory is never trapped in the engine.
 *
 * Scheduling (weekly, Sunday 03:30 — EXPORT_JOB_CRON) is wired in the
 * triggers phase; this module only provides the job function.
 *
 * The whole dump runs inside one withWrite() reservation: the write lane is
 * held for the duration, so the export is a quiesced, consistent snapshot
 * (reads-only — nothing is mutated).
 *
 * Formats:
 * - `nodes_<Label>.csv` / `rels_<TYPE>__<From>__<To>.csv` use neo4j-admin
 *   import headers (`id:ID(Label)`, `:LABEL`, `:START_ID(...)`, `:TYPE`,
 *   typed columns, `;`-separated arrays).
 * - `graph.cypher` uses plain CREATE statements with `datetime('…')`
 *   timestamps (Neo4j syntax; a migration target can re-map trivially).
 * - `manifest.json` records counts, schema version and timestamps.
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { StorageEngine, WriteTx } from './engine'
import {
  NODE_TABLES,
  nodeColumns,
  REL_TABLES,
  relColumns,
  type PropertySpec,
  type PropertyType
} from './schema'

export interface ExportResult {
  /** The created export directory. */
  readonly dir: string
  readonly nodeCounts: Readonly<Record<string, number>>
  readonly relCounts: Readonly<Record<string, number>>
}

/** neo4j-admin import type annotation for a column. */
function neo4jType(type: PropertyType): string {
  switch (type) {
    case 'STRING':
      return ''
    case 'INT64':
      return ':long'
    case 'DOUBLE':
      return ':double'
    case 'BOOLEAN':
      return ':boolean'
    case 'TIMESTAMP':
      return ':datetime'
    case 'EMBEDDING':
      return ':double[]'
  }
}

function csvEscape(field: string): string {
  return /[",\r\n]/.test(field) ? `"${field.replaceAll('"', '""')}"` : field
}

/** CSV cell for an engine-decoded value. */
function csvValue(value: unknown): string {
  if (value === null || value === undefined) return ''
  if (value instanceof Date) return value.toISOString()
  if (Array.isArray(value)) return csvEscape(value.map((v) => String(v)).join(';'))
  if (typeof value === 'boolean' || typeof value === 'number' || typeof value === 'bigint') return String(value)
  return csvEscape(String(value))
}

function cypherString(value: string): string {
  return `'${value.replaceAll('\\', '\\\\').replaceAll("'", "\\'")}'`
}

/** Cypher literal for an engine-decoded value (Neo4j-compatible). */
function cypherValue(value: unknown): string {
  if (value === null || value === undefined) return 'null'
  if (value instanceof Date) return `datetime(${cypherString(value.toISOString())})`
  if (Array.isArray(value)) return `[${value.map((v) => String(v)).join(', ')}]`
  if (typeof value === 'boolean' || typeof value === 'number' || typeof value === 'bigint') return String(value)
  return cypherString(String(value))
}

function csvLine(cells: readonly string[]): string {
  return cells.join(',') + '\n'
}

/** Internal bookkeeping table, exported too so a restore is complete. */
const SCHEMA_VERSION_COLUMNS: readonly PropertySpec[] = [
  { name: 'version', type: 'INT64' },
  { name: 'name', type: 'STRING' },
  { name: 'applied_at', type: 'TIMESTAMP' }
]

async function exportNodeTable(
  tx: WriteTx,
  label: string,
  columns: readonly PropertySpec[],
  idColumn: string,
  dir: string,
  cypherLines: string[]
): Promise<number> {
  const selects = columns.map((c) => `n.${c.name} AS ${c.name}`).join(', ')
  const rows = await tx.cypher(`MATCH (n:${label}) RETURN ${selects} ORDER BY n.${idColumn}`)
  const header = columns.map((c) =>
    c.name === idColumn ? `${c.name}:ID(${label})` : `${c.name}${neo4jType(c.type)}`
  )
  let csv = csvLine([...header, ':LABEL'])
  for (const row of rows) {
    csv += csvLine([...columns.map((c) => csvValue(row[c.name])), label])
    const props = columns
      .filter((c) => row[c.name] !== null && row[c.name] !== undefined)
      .map((c) => `${c.name}: ${cypherValue(row[c.name])}`)
    cypherLines.push(`CREATE (:${label} {${props.join(', ')}});`)
  }
  writeFileSync(join(dir, `nodes_${label}.csv`), csv)
  return rows.length
}

async function exportRelPair(
  tx: WriteTx,
  type: string,
  from: string,
  to: string,
  dir: string,
  cypherLines: string[]
): Promise<number> {
  const columns = relColumns()
  const selects = columns.map((c) => `r.${c.name} AS ${c.name}`).join(', ')
  const rows = await tx.cypher(
    `MATCH (a:${from})-[r:${type}]->(b:${to}) RETURN a.id AS __from, b.id AS __to, ${selects} ORDER BY __from, __to`
  )
  const header = [
    `:START_ID(${from})`,
    `:END_ID(${to})`,
    ...columns.map((c) => `${c.name}${neo4jType(c.type)}`),
    ':TYPE'
  ]
  let csv = csvLine(header)
  for (const row of rows) {
    csv += csvLine([
      csvValue(row['__from']),
      csvValue(row['__to']),
      ...columns.map((c) => csvValue(row[c.name])),
      type
    ])
    const props = columns
      .filter((c) => row[c.name] !== null && row[c.name] !== undefined)
      .map((c) => `${c.name}: ${cypherValue(row[c.name])}`)
    const propsFragment = props.length > 0 ? ` {${props.join(', ')}}` : ''
    cypherLines.push(
      `MATCH (a:${from} {id: ${cypherValue(row['__from'])}}), (b:${to} {id: ${cypherValue(row['__to'])}}) ` +
        `CREATE (a)-[:${type}${propsFragment}]->(b);`
    )
  }
  writeFileSync(join(dir, `rels_${type}__${from}__${to}.csv`), csv)
  return rows.length
}

/**
 * Dump all nodes/edges to `<exportsDir>/<YYYY-MM-DD>/` (time-suffixed when
 * the date directory already exists, e.g. re-runs on the same day).
 */
export async function exportGraph(
  engine: StorageEngine,
  exportsDir: string,
  when: Date = new Date()
): Promise<ExportResult> {
  const day = when.toISOString().slice(0, 10)
  let dir = join(exportsDir, day)
  if (existsSync(dir)) {
    dir = join(exportsDir, `${day}-${when.toISOString().slice(11, 19).replaceAll(':', '')}`)
    for (let n = 2; existsSync(dir); n++) dir = join(exportsDir, `${day}-${n}`)
  }
  mkdirSync(dir, { recursive: true })

  const nodeCounts: Record<string, number> = {}
  const relCounts: Record<string, number> = {}
  const cypherLines: string[] = [
    `// agentic-os graph export ${when.toISOString()} (schema v${engine.schemaVersion})`,
    '// Node CREATEs precede relationship CREATEs; timestamps are datetime(ISO-8601).'
  ]

  await engine.withWrite(async (tx) => {
    for (const spec of NODE_TABLES) {
      nodeCounts[spec.label] = await exportNodeTable(tx, spec.label, nodeColumns(spec), 'id', dir, cypherLines)
    }
    nodeCounts['SchemaVersion'] = await exportNodeTable(
      tx,
      'SchemaVersion',
      SCHEMA_VERSION_COLUMNS,
      'version',
      dir,
      cypherLines
    )
    for (const spec of REL_TABLES) {
      for (const [from, to] of spec.pairs) {
        relCounts[`${spec.type}__${from}__${to}`] = await exportRelPair(tx, spec.type, from, to, dir, cypherLines)
      }
    }
  })

  writeFileSync(join(dir, 'graph.cypher'), cypherLines.join('\n') + '\n')
  writeFileSync(
    join(dir, 'manifest.json'),
    JSON.stringify(
      { exportedAt: when.toISOString(), schemaVersion: engine.schemaVersion, nodeCounts, relCounts },
      null,
      2
    )
  )
  return { dir, nodeCounts, relCounts }
}
