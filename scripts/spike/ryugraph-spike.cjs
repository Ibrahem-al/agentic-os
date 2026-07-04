/**
 * Phase-00 RyuGraph de-risk spike (throwaway proof code — NOT the storage layer).
 *
 * Proves, against npm `ryugraph` (pinned 25.9.1, the Kùzu-lineage ">= v0.11.3"
 * successor):
 *   1. the N-API binding loads in the current runtime (plain Node, or
 *      Electron's Node via ELECTRON_RUN_AS_NODE, or the Electron main process),
 *   2. a database can be created on disk,
 *   3. the vector + FTS extensions work with networking disabled — they ship
 *      statically linked in >= v0.11.3-lineage builds, so no INSTALL statement
 *      and no download may ever happen (spec §21 rule 2),
 *   4. a node can be created and queried back.
 *
 * Exported as a function so the Electron main process can run it at launch and
 * the CI offline check can run it standalone (scripts/spike/run-spike.cjs).
 */
'use strict'

const fs = require('node:fs')
const path = require('node:path')

/** RyuGraph's platform string ("win_amd64", "osx_arm64", …) for this process. */
function ryuPlatform() {
  const os = { win32: 'win', darwin: 'osx', linux: 'linux' }[process.platform]
  const arch = { x64: 'amd64', arm64: 'arm64' }[process.arch]
  if (!os || !arch) throw new Error(`unsupported platform ${process.platform}/${process.arch}`)
  return `${os}_${arch}`
}

/**
 * Absolute path of a vendored extension binary in resources/extensions/.
 * Vendored from the official ghcr.io/predictable-labs/extension-repo image,
 * pinned v25.9.0 (the extension version RYU_EXTENSION_VERSION compiled into
 * ryugraph 25.9.1); integrity manifest in resources/extensions/SHA256SUMS.
 */
function vendoredExtensionPath(name) {
  return path.join(
    __dirname, '..', '..', 'resources', 'extensions', 'v25.9.0', ryuPlatform(), name,
    `lib${name}.ryu_extension`
  )
}

/**
 * @param {string} dbDir directory to create the spike database in (wiped first)
 * @param {(line: string) => void} [log]
 * @returns {Promise<{ok: true, ryugraphVersion: string, storageVersion: string, vectorHits: unknown[], ftsHits: unknown[], row: unknown}>}
 */
async function runRyugraphSpike(dbDir, log = console.log) {
  // RYUGRAPH_MODULE_PATH lets the offline harness point at a container-local
  // copy of the package (the npm install step wires ryujs.node per platform).
  const ryu = require(process.env.RYUGRAPH_MODULE_PATH || 'ryugraph')

  fs.rmSync(dbDir, { recursive: true, force: true })
  fs.mkdirSync(dbDir, { recursive: true })
  const dbPath = path.join(dbDir, 'spike.ryugraph')

  log(`[spike] ryugraph binding loaded (package version ${ryu.VERSION ?? 'unknown'})`)
  const db = new ryu.Database(dbPath)
  const conn = new ryu.Connection(db)

  // Version info straight from the engine.
  const versionResult = await conn.query(
    'CALL db_version() RETURN version AS v'
  )
  const versionRows = await versionResult.getAll()
  const engineVersion = versionRows[0]?.v ?? 'unknown'
  log(`[spike] database created on disk at ${dbPath} (engine version ${engineVersion})`)

  // Vector + FTS are NOT bundled inside the ryugraph npm package (contrary to
  // the upstream docs' "pre-installed" claim — verified in phase 00): a bare
  // `LOAD EXTENSION VECTOR` resolves from ~/.ryu/extension/, populated only by
  // a networked INSTALL. So we ship the pinned binaries in resources/extensions/
  // and load them by absolute path — never fetched at runtime (§21 rule 2).
  for (const name of ['vector', 'fts']) {
    const extPath = vendoredExtensionPath(name)
    if (!fs.existsSync(extPath)) throw new Error(`vendored extension missing: ${extPath}`)
    await conn.query(`LOAD EXTENSION '${extPath.replaceAll('\\', '/')}'`)
  }
  const loadedResult = await conn.query('CALL SHOW_LOADED_EXTENSIONS() RETURN *')
  const loaded = await loadedResult.getAll()
  log(`[spike] extensions loaded from vendored binaries: ${JSON.stringify(loaded)}`)

  // 1. Plain graph write + read-back.
  await conn.query(
    'CREATE NODE TABLE SpikeDoc(id INT64, text STRING, emb FLOAT[8], PRIMARY KEY(id))'
  )
  await conn.query(
    "CREATE (:SpikeDoc {id: 1, text: 'ryugraph spike hello world', emb: [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8]})"
  )
  await conn.query(
    "CREATE (:SpikeDoc {id: 2, text: 'a second unrelated document', emb: [0.8, 0.7, 0.6, 0.5, 0.4, 0.3, 0.2, 0.1]})"
  )
  const matchResult = await conn.query(
    'MATCH (d:SpikeDoc) WHERE d.id = 1 RETURN d.id AS id, d.text AS text'
  )
  const rows = await matchResult.getAll()
  if (rows.length !== 1 || rows[0].text !== 'ryugraph spike hello world') {
    throw new Error(`node read-back failed: ${JSON.stringify(rows)}`)
  }
  log(`[spike] node created and queried back: ${JSON.stringify(rows[0])}`)

  // 2. Vector extension — must work offline (statically linked, never fetched).
  await conn.query("CALL CREATE_VECTOR_INDEX('SpikeDoc', 'spike_vec_idx', 'emb')")
  const vecResult = await conn.query(
    "CALL QUERY_VECTOR_INDEX('SpikeDoc', 'spike_vec_idx', CAST([0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8] AS FLOAT[8]), 2) RETURN node.id AS id, distance ORDER BY distance"
  )
  const vectorHits = await vecResult.getAll()
  if (vectorHits.length === 0 || vectorHits[0].id !== 1n && vectorHits[0].id !== 1) {
    throw new Error(`vector search failed: ${JSON.stringify(vectorHits)}`)
  }
  log(`[spike] vector index created + queried: nearest id=${vectorHits[0].id}`)

  // 3. FTS extension — same offline requirement.
  // Note: the FTS index only covers rows present at CREATE_FTS_INDEX time, and
  // the default pipeline drops some tokens (e.g. 'hello') — query 'world'.
  await conn.query("CALL CREATE_FTS_INDEX('SpikeDoc', 'spike_fts_idx', ['text'])")
  const ftsResult = await conn.query(
    "CALL QUERY_FTS_INDEX('SpikeDoc', 'spike_fts_idx', 'world') RETURN node.id AS id, score ORDER BY score DESC"
  )
  const ftsHits = await ftsResult.getAll()
  if (ftsHits.length === 0 || (ftsHits[0].id !== 1n && ftsHits[0].id !== 1)) {
    throw new Error(`FTS search failed: ${JSON.stringify(ftsHits)}`)
  }
  log(`[spike] FTS index created + queried: top hit id=${ftsHits[0].id}`)

  return {
    ok: true,
    ryugraphVersion: String(ryu.VERSION ?? 'unknown'),
    storageVersion: String(engineVersion),
    vectorHits,
    ftsHits,
    row: rows[0]
  }
}

module.exports = { runRyugraphSpike }
