/**
 * Raw-driver probe: exact engine Cypher (DDL, inline CREATE with CAST,
 * prepared QUERY_VECTOR_INDEX, the drop→SET→recreate dance) against the
 * ryugraph package resolved from node_modules NEXT TO THIS SCRIPT.
 * Two connections like the engine: writes on writeConn, searches on readConn
 * (plus a same-conn variant to isolate cross-connection staleness).
 *
 * ONE Database, one table per scenario: each ryugraph Database reserves
 * ~8 TiB of virtual address space, and ten of them in one process exhausts
 * the mmap budget on CI runners (found live on the first probe run). A
 * scenario's CHECKPOINT is therefore db-wide; scenarios still isolate their
 * data via their own tables + indexes, which is what the defect cares about.
 *
 * Usage: node ryu-vector-probe.mjs <scratchBaseDir> <extensionsDir> [numThreads]
 */
import { mkdirSync, mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { cpus } from 'node:os'
import process from 'node:process'
import console from 'node:console'

const require = createRequire(import.meta.url)
const ryu = require('ryugraph')
const [, , scratchBase, extensionsDir, threadsArg] = process.argv
const NUM_THREADS = threadsArg ? Number(threadsArg) : undefined
mkdirSync(scratchBase, { recursive: true })
console.log(`cpu=${cpus()[0]?.model ?? 'unknown'} cores=${cpus().length} platform=${process.platform}-${process.arch}`)
console.log(`numThreads=${NUM_THREADS ?? 'default'}`)

const DIM = 1024

function vec(i) {
  const v = new Array(DIM).fill(0)
  v[0] = Math.SQRT1_2
  v[i] = Math.SQRT1_2
  return v
}

async function run(conn, query, params) {
  let results
  if (params && Object.keys(params).length > 0) {
    const prepared = await conn.prepare(query)
    if (!prepared.isSuccess()) throw new Error(prepared.getErrorMessage())
    results = await conn.execute(prepared, params)
  } else {
    results = await conn.query(query)
  }
  const list = Array.isArray(results) ? results : [results]
  const rows = []
  for (const r of list) rows.push(...(await r.getAll()))
  return rows
}

// ── The single shared database ───────────────────────────────────────────────
const dir = mkdtempSync(join(scratchBase, 'raw-probe-'))
const db = new ryu.Database(join(dir, 'graph.ryugraph'))
const writeConn = NUM_THREADS ? new ryu.Connection(db, NUM_THREADS) : new ryu.Connection(db)
const readConn = NUM_THREADS ? new ryu.Connection(db, NUM_THREADS) : new ryu.Connection(db)
{
  const platDir =
    { win32: 'win', darwin: 'osx', linux: 'linux' }[process.platform] +
    '_' +
    { x64: 'amd64', arm64: 'arm64' }[process.arch]
  for (const conn of [writeConn, readConn]) {
    for (const ext of ['vector', 'fts']) {
      const p = join(extensionsDir, platDir, ext, `lib${ext}.ryu_extension`).replaceAll('\\', '/')
      try {
        await run(conn, `LOAD EXTENSION '${p}'`)
      } catch (e) {
        if (!/already[ _-]?loaded/i.test(String(e))) throw e
      }
    }
  }
}

/** Per-scenario table + index closures over the shared db. */
async function scenario(name) {
  const T = `T_${name}`
  const IDX = `idx_vec_${name}`
  await run(
    writeConn,
    `CREATE NODE TABLE IF NOT EXISTS ${T}(id STRING, name STRING, embedding FLOAT[${DIM}], created_at TIMESTAMP, updated_at TIMESTAMP, PRIMARY KEY(id))`
  )
  return {
    insert: async (id, v) => {
      const now = new Date().toISOString()
      await run(
        writeConn,
        `CREATE (:${T} {id: $id, created_at: timestamp($__now), updated_at: timestamp($__now), name: $p_name, embedding: CAST($p_embedding AS FLOAT[${DIM}])})`,
        { id, __now: now, p_name: `n-${id}`, p_embedding: v }
      )
    },
    setEmbedding: async (id, v) => {
      await run(
        writeConn,
        `MATCH (n:${T} {id: $id}) SET n.embedding = CAST($e AS FLOAT[${DIM}]), n.updated_at = timestamp($__now)`,
        { id, e: v, __now: new Date().toISOString() }
      )
    },
    search: async (conn, v, k) => {
      const rows = await run(
        conn,
        `CALL QUERY_VECTOR_INDEX('${T}', '${IDX}', $q, $k) RETURN node.id AS id, distance ORDER BY distance, id`,
        { q: v, k }
      )
      return rows.map((r) => `${r.id}:${typeof r.distance}:${Math.round(Number(r.distance) * 1e6) / 1e6}`).join(' | ') || '(EMPTY)'
    },
    storedEmbedding: async (id) => {
      const rows = await run(readConn, `MATCH (n:${T} {id: "${id}"}) RETURN n.embedding AS e`)
      return rows[0]?.e
    },
    createIndex: () => run(writeConn, `CALL CREATE_VECTOR_INDEX('${T}', '${IDX}', 'embedding')`),
    dropIndex: () => run(writeConn, `CALL DROP_VECTOR_INDEX('${T}', '${IDX}')`)
  }
}

const checkpoint = () => run(writeConn, 'CHECKPOINT')
const report = (s) => console.log(s)

// R1 — bulk insert THEN create index (fixture-seed control).
{
  const s = await scenario('r1')
  await s.insert('a', vec(1))
  await s.insert('b', vec(2))
  await s.createIndex()
  report(`R1 insert->index   read  q2 k=2 -> ${await s.search(readConn, vec(2), 2)}`)
  report(`R1 insert->index   write q2 k=2 -> ${await s.search(writeConn, vec(2), 2)}`)
}

// R2 — create index on EMPTY table, THEN insert (extraction scenario).
{
  const s = await scenario('r2')
  await s.createIndex()
  await s.insert('a', vec(1))
  await s.insert('b', vec(2))
  report(`R2 index->insert   read  q2 k=2 -> ${await s.search(readConn, vec(2), 2)}`)
  report(`R2 index->insert   write q2 k=2 -> ${await s.search(writeConn, vec(2), 2)}`)
  report(`R2 index->insert   read  q1 k=2 -> ${await s.search(readConn, vec(1), 2)}`)
}

// R3 — index exists first, ONE insert, immediate search (greenfield minimal).
{
  const s = await scenario('r3')
  await s.createIndex()
  await s.insert('only', vec(5))
  report(`R3 index->1insert  read  q5 k=1 -> ${await s.search(readConn, vec(5), 1)}`)
}

// R4 — the adopt dance on a table indexed BEFORE any data existed:
// index on empty → inserts → drop → SET → recreate → search.
{
  const s = await scenario('r4')
  await s.createIndex()
  for (let i = 1; i <= 3; i++) await s.insert(`s${i}`, vec(i))
  await s.dropIndex()
  await s.setEmbedding('s2', vec(9))
  await s.createIndex()
  report(`R4 dance(idx-empty) read  q9 k=3 -> ${await s.search(readConn, vec(9), 3)}`)
  report(`R4 dance(idx-empty) write q9 k=3 -> ${await s.search(writeConn, vec(9), 3)}`)
  report(`R4 dance(idx-empty) read  q1 k=3 -> ${await s.search(readConn, vec(1), 3)}`)
  const e = await s.storedEmbedding('s2')
  report(`R4 stored s2 norm=${e ? Math.hypot(...e).toFixed(6) : 'null'} v0=${e ? e[0].toFixed(6) : '-'} v9=${e ? e[9].toFixed(6) : '-'}`)
}

// R5 — the dance on a table whose index was created over EXISTING data.
{
  const s = await scenario('r5')
  for (let i = 1; i <= 3; i++) await s.insert(`s${i}`, vec(i))
  await s.createIndex()
  await s.dropIndex()
  await s.setEmbedding('s2', vec(9))
  await s.createIndex()
  report(`R5 dance(idx-data)  read  q9 k=3 -> ${await s.search(readConn, vec(9), 3)}`)
  report(`R5 dance(idx-data)  write q9 k=3 -> ${await s.search(writeConn, vec(9), 3)}`)
}

// R6 — R4 with a CHECKPOINT between recreate and search (write-time workaround?).
{
  const s = await scenario('r6')
  await s.createIndex()
  for (let i = 1; i <= 3; i++) await s.insert(`s${i}`, vec(i))
  await s.dropIndex()
  await s.setEmbedding('s2', vec(9))
  await s.createIndex()
  await checkpoint()
  report(`R6 dance+checkpoint read  q9 k=3 -> ${await s.search(readConn, vec(9), 3)}`)
}

// R7 — R2 with a CHECKPOINT between insert and search.
{
  const s = await scenario('r7')
  await s.createIndex()
  await s.insert('a', vec(1))
  await s.insert('b', vec(2))
  await checkpoint()
  report(`R7 idx->ins+ckpt    read  q2 k=2 -> ${await s.search(readConn, vec(2), 2)}`)
}

// R8 — index → insert a → CHECKPOINT → insert b → search b (extraction case
// with a checkpoint BETWEEN the seed insert and the later insert).
{
  const s = await scenario('r8')
  await s.createIndex()
  await s.insert('a', vec(1))
  await checkpoint()
  await s.insert('b', vec(2))
  report(`R8 ins,CKPT,ins     read  q2 k=2 -> ${await s.search(readConn, vec(2), 2)}`)
  report(`R8 ins,CKPT,ins     write q2 k=2 -> ${await s.search(writeConn, vec(2), 2)}`)
  const e = await s.storedEmbedding('b')
  report(`R8 stored b norm=${e ? Math.hypot(...e).toFixed(6) : 'null'}`)
}

// R9 — index → inserts → CHECKPOINT → dance (drop, SET, recreate) → search
// (skill-adopt case with the seeds checkpointed before the re-embed).
{
  const s = await scenario('r9')
  await s.createIndex()
  for (let i = 1; i <= 3; i++) await s.insert(`s${i}`, vec(i))
  await checkpoint()
  await s.dropIndex()
  await s.setEmbedding('s2', vec(9))
  await s.createIndex()
  report(`R9 CKPT,dance       read  q9 k=3 -> ${await s.search(readConn, vec(9), 3)}`)
  report(`R9 CKPT,dance       write q9 k=3 -> ${await s.search(writeConn, vec(9), 3)}`)
  report(`R9 CKPT,dance       read  q1 k=3 -> ${await s.search(readConn, vec(1), 3)}`)
  const e = await s.storedEmbedding('s2')
  report(`R9 stored s2 norm=${e ? Math.hypot(...e).toFixed(6) : 'null'} v0=${e ? e[0].toFixed(6) : '-'} v9=${e ? e[9].toFixed(6) : '-'}`)
}

// R10 — checkpoint BETWEEN drop+SET and recreate (split-dance) — how the WAL
// threshold could land mid-dance.
{
  const s = await scenario('r10')
  await s.createIndex()
  for (let i = 1; i <= 3; i++) await s.insert(`s${i}`, vec(i))
  await s.dropIndex()
  await s.setEmbedding('s2', vec(9))
  await checkpoint()
  await s.createIndex()
  report(`R10 dance w/ mid-CKPT read q9 k=3 -> ${await s.search(readConn, vec(9), 3)}`)
}

report('RAW PROBE DONE')
process.exit(0)
