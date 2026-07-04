/**
 * Real-safeStorage keychain check (phase 02 DoD: "keys round-trip through
 * safeStorage; grep proves no plaintext key ever hits disk or logs").
 *
 * Runs the REAL Keychain class (bundled from src/main/models/keychain.ts via
 * esbuild) inside a REAL Electron main process, so encryption goes through
 * the OS backend (DPAPI on Windows). It:
 *   1. stores a canary API key + generates the MCP bearer token,
 *   2. re-opens the keychain and asserts both round-trip,
 *   3. scans every byte written under the temp userData dir for the canary,
 *   4. writes a JSON verdict (stdout is unreliable for Electron on Windows —
 *      phase-00 finding 7), path from KEYCHAIN_CHECK_RESULT or a default.
 *
 * Usage: npx electron scripts/ci/electron-keychain-check.cjs
 */
const { app, safeStorage } = require('electron')
const { mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { join, dirname } = require('node:path')

const CANARY = 'sk-agenticos-plaintext-canary-8842'
const resultPath = process.env.KEYCHAIN_CHECK_RESULT || join(tmpdir(), 'agentic-os-keychain-check.json')

function bundleKeychain() {
  const esbuild = require('esbuild')
  const outfile = join(tmpdir(), `agentic-os-keychain-bundle-${process.pid}.cjs`)
  esbuild.buildSync({
    entryPoints: [join(__dirname, '..', '..', 'src', 'main', 'models', 'keychain.ts')],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    outfile,
    external: ['electron'],
    logLevel: 'silent'
  })
  return { module: require(outfile), outfile }
}

function scanForPlaintext(dir, needle) {
  const hits = []
  for (const entry of readdirSync(dir, { withFileTypes: true, recursive: true })) {
    if (!entry.isFile()) continue
    const filePath = join(entry.parentPath ?? entry.path, entry.name)
    if (readFileSync(filePath).includes(needle)) hits.push(filePath)
  }
  return hits
}

async function main() {
  const result = { ok: false, platform: process.platform, electron: process.versions.electron }
  let userDataDir = null
  let bundlePath = null
  try {
    await app.whenReady()
    result.encryptionAvailable = safeStorage.isEncryptionAvailable()
    if (!result.encryptionAvailable) throw new Error('safeStorage.isEncryptionAvailable() is false on this machine')

    const { module: keychainModule, outfile } = bundleKeychain()
    bundlePath = outfile
    const { Keychain } = keychainModule

    userDataDir = mkdtempSync(join(tmpdir(), 'agentic-os-keychain-check-'))
    const filePath = join(userDataDir, 'keychain.bin')

    // 1. store a canary key + the MCP bearer token through REAL safeStorage
    const keychain = new Keychain({ filePath, safeStorage })
    keychain.setApiKey('anthropic', CANARY)
    const token = keychain.ensureMcpBearerToken()

    // 2. a fresh instance must decrypt the same values back
    const reloaded = new Keychain({ filePath, safeStorage })
    result.roundTrip = reloaded.getApiKey('anthropic') === CANARY
    result.bearerTokenStable = reloaded.ensureMcpBearerToken() === token && /^[A-Za-z0-9_-]{40,}$/.test(token)
    if (!result.roundTrip) throw new Error('API key did not round-trip through safeStorage')
    if (!result.bearerTokenStable) throw new Error('MCP bearer token not stable/idempotent')

    // 3. no file under userData may contain the plaintext canary
    const hits = scanForPlaintext(userDataDir, CANARY)
    result.plaintextHits = hits
    if (hits.length > 0) throw new Error(`plaintext key found on disk: ${hits.join(', ')}`)

    result.ok = true
  } catch (err) {
    result.error = err && err.message ? err.message : String(err)
  } finally {
    if (userDataDir) rmSync(userDataDir, { recursive: true, force: true })
    if (bundlePath) rmSync(bundlePath, { force: true })
    mkdirSync(dirname(resultPath), { recursive: true })
    writeFileSync(resultPath, JSON.stringify(result, null, 2))
    console.log(`[keychain-check] ${result.ok ? 'PASS' : 'FAIL'} → ${resultPath}`)
    app.exit(result.ok ? 0 : 1)
  }
}

void main()
