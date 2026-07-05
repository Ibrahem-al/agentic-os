/**
 * electron-builder beforePack hook (wired in electron-builder.yml).
 *
 * The packaging config sets npmRebuild:false — `npm run rebuild:native` owns
 * every native artifact. This hook fails the build EARLY (before any packing)
 * when those artifacts are missing or stale, instead of shipping an app that
 * hard-crashes electron.exe (win32 ryujs.node) or boots without vector/FTS
 * (missing vendored RyuGraph extensions).
 *
 * Asserted:
 *  - win32 targets: node_modules/ryugraph/.electron-safe exists and the
 *    Electron version recorded inside it (rebuild-ryugraph-electron.cjs writes
 *    `<electron version>\n`) matches devDependencies.electron — otherwise the
 *    top-level ryujs.node is the npm prebuilt (uncatchable native crash in
 *    electron.exe) or was built against a different Electron ABI.
 *  - all platforms: resources/extensions/v25.9.0/<platform>/{vector,fts}
 *    contain the .ryu_extension files for the platform/arch being packed.
 */
'use strict'

const fs = require('node:fs')
const path = require('node:path')

const repoRoot = path.resolve(__dirname, '..', '..')
// Must match config.ts RYU_EXTENSION_VERSION_DIR (ryugraph 25.9.1 → engine
// extension version 25.9.0) and the extraResources mapping in the yml.
const EXTENSION_VERSION_DIR = 'v25.9.0'

/** electron-builder Arch enum value → vendored-extension arch suffix. */
function archName(arch) {
  // Arch enum: 0=ia32, 1=x64, 2=armv7l, 3=arm64, 4=universal.
  switch (arch) {
    case 1:
      return 'amd64'
    case 3:
      return 'arm64'
    case 4:
      return 'universal'
    default:
      return null
  }
}

/** Electron platform name → vendored-extension OS prefix. */
function osName(electronPlatformName) {
  switch (electronPlatformName) {
    case 'win32':
      return 'win'
    case 'darwin':
      return 'osx'
    case 'linux':
      return 'linux'
    default:
      return null
  }
}

function assertExtensionDir(platformDir) {
  const base = path.join(repoRoot, 'resources', 'extensions', EXTENSION_VERSION_DIR)
  const missing = []
  for (const [ext, file] of [
    ['vector', 'libvector.ryu_extension'],
    ['fts', 'libfts.ryu_extension']
  ]) {
    const p = path.join(base, platformDir, ext, file)
    if (!fs.existsSync(p)) missing.push(p)
  }
  if (missing.length > 0) {
    throw new Error(
      `[before-pack] vendored RyuGraph extensions missing for ${platformDir}:\n` +
        missing.map((m) => `  - ${m}`).join('\n') +
        `\nThe packaged app loads vector+FTS from resources/extensions/${EXTENSION_VERSION_DIR} by absolute path (§21 rule 2 — never fetched). Restore the vendored files before packaging.`
    )
  }
  console.log(`[before-pack] vendored extensions OK: ${EXTENSION_VERSION_DIR}/${platformDir} (vector + fts)`)
}

function assertWin32RyuGraphElectronSafe() {
  const ryuDir = path.join(repoRoot, 'node_modules', 'ryugraph')
  const marker = path.join(ryuDir, '.electron-safe')
  const guidance =
    'The npm-prebuilt ryujs.node hard-crashes electron.exe on win32. Run `npm run rebuild:native` (builds the Electron-safe binding and stamps node_modules/ryugraph/.electron-safe), then package again.'

  if (!fs.existsSync(path.join(ryuDir, 'ryujs.node'))) {
    throw new Error(`[before-pack] node_modules/ryugraph/ryujs.node is missing. Run \`npm install\`, then \`npm run rebuild:native\`.`)
  }
  if (!fs.existsSync(marker)) {
    throw new Error(`[before-pack] node_modules/ryugraph/.electron-safe is missing — ryujs.node is the npm prebuilt. ${guidance}`)
  }

  // rebuild-ryugraph-electron.cjs writes the Electron version it built
  // against (`fs.writeFileSync(marker, electronVersion + '\n')`).
  const built = fs.readFileSync(marker, 'utf8').trim()
  const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'))
  const pinned = String((pkg.devDependencies || {}).electron || '').replace(/^[\^~=]+/, '')
  if (pinned === '') {
    throw new Error('[before-pack] devDependencies.electron not found in package.json — cannot verify the ryugraph rebuild target')
  }
  if (built !== pinned) {
    throw new Error(
      `[before-pack] node_modules/ryugraph/.electron-safe records Electron ${built}, but devDependencies.electron is ${pinned} — ryujs.node was rebuilt against a different Electron ABI. ${guidance}`
    )
  }

  // The marker alone is not proof: any later `npm install` re-runs ryugraph's
  // install script, which copies prebuilt/ryujs-win32-x64.node back over
  // ryujs.node while the stale marker survives (observed live during phase
  // 13). Byte-compare against the npm prebuilt copies so a silently reverted
  // binary can never ship.
  const installed = fs.readFileSync(path.join(ryuDir, 'ryujs.node'))
  for (const prebuiltName of ['ryujs-node-prebuilt.node', path.join('prebuilt', `ryujs-win32-${process.arch}.node`)]) {
    const prebuiltPath = path.join(ryuDir, prebuiltName)
    if (fs.existsSync(prebuiltPath) && installed.equals(fs.readFileSync(prebuiltPath))) {
      throw new Error(
        `[before-pack] node_modules/ryugraph/ryujs.node is byte-identical to the npm prebuilt (${prebuiltName}) despite the .electron-safe marker — a later \`npm install\` re-ran ryugraph's install script and reverted it. Delete node_modules/ryugraph/.electron-safe, then ${guidance}`
      )
    }
  }
  console.log(`[before-pack] win32 ryugraph OK: Electron-safe ryujs.node (built for Electron ${built}, differs from npm prebuilt)`)
}

/** @param {{ electronPlatformName: string, arch: number }} context */
module.exports = async function beforePack(context) {
  const os = osName(context.electronPlatformName)
  if (os === null) {
    throw new Error(`[before-pack] unexpected electronPlatformName: ${context.electronPlatformName}`)
  }

  if (os === 'win') assertWin32RyuGraphElectronSafe()

  const arch = archName(context.arch)
  if (arch === null) {
    throw new Error(`[before-pack] unsupported arch value: ${context.arch} (no vendored RyuGraph extensions for it)`)
  }
  // A mac universal build would need both slices' extensions present.
  const platformDirs = arch === 'universal' ? [`${os}_amd64`, `${os}_arm64`] : [`${os}_${arch}`]
  for (const dir of platformDirs) assertExtensionDir(dir)
}
