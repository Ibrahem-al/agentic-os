/**
 * Rebuild the RyuGraph Node binding for Electron on Windows.
 *
 * Why: the npm-shipped win32 prebuilt (ryujs-win32-x64.node) binds its imports
 * to node.exe with no delay-load hook, so require()-ing it inside electron.exe
 * is an uncatchable native crash (verified in phase 00). cmake-js injects the
 * win_delay_load_hook when targeting the Electron runtime, which makes the
 * resulting binary work under BOTH electron.exe and node.exe. Linux/macOS
 * prebuilts resolve symbols from the host binary at dlopen time and need none
 * of this.
 *
 * The build compiles the full RyuGraph engine from the npm-shipped ryu-source/
 * (MSVC + ninja via VS Build Tools, ~30-60 min first time; ninja is
 * incremental after that). On success, node_modules/ryugraph/ryujs.node is
 * replaced (original kept as ryujs-node-prebuilt.node) and an .electron-safe
 * marker is stamped — src/main gates the in-main RyuGraph spike on it.
 */
'use strict'

const { execSync, execFileSync } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const repoRoot = path.resolve(__dirname, '..', '..')
const ryuDir = path.join(repoRoot, 'node_modules', 'ryugraph')
const marker = path.join(ryuDir, '.electron-safe')
const workDir = path.join(os.tmpdir(), 'ryu-electron-build')
const srcDir = path.join(workDir, 'ryu-source')
const buildDir = path.join(workDir, 'build')

if (process.platform !== 'win32') {
  console.log('[ryu-rebuild] non-Windows platform: npm prebuilt is Electron-safe, nothing to do')
  process.exit(0)
}

const electronVersion = JSON.parse(
  fs.readFileSync(path.join(repoRoot, 'node_modules', 'electron', 'package.json'), 'utf8')
).version

/**
 * A matching marker is NOT proof the binary is still the Electron build:
 * `npm install` re-runs ryugraph's install script, which copies the npm
 * prebuilt back over ryujs.node and leaves the stale marker in place (found
 * live in phase 13 — the clobbered binary hard-crashes electron.exe). Trust
 * the marker only when ryujs.node differs byte-wise from every prebuilt copy.
 */
function clobberedByPrebuilt() {
  const installed = path.join(ryuDir, 'ryujs.node')
  if (!fs.existsSync(installed)) return true
  const prebuiltCopies = [
    path.join(ryuDir, 'ryujs-node-prebuilt.node'),
    path.join(ryuDir, 'prebuilt', 'ryujs-win32-x64.node')
  ]
  const installedBytes = fs.readFileSync(installed)
  return prebuiltCopies.some((p) => fs.existsSync(p) && installedBytes.equals(fs.readFileSync(p)))
}

if (fs.existsSync(marker) && fs.readFileSync(marker, 'utf8').trim() === electronVersion) {
  if (!clobberedByPrebuilt()) {
    console.log(`[ryu-rebuild] ryujs.node already rebuilt for Electron ${electronVersion}, skipping`)
    process.exit(0)
  }
  // Fast path: the incremental build tree usually still holds the last
  // Electron-safe output — restore it instead of paying a rebuild.
  const cached = path.join(srcDir, 'tools', 'nodejs_api', 'build', 'ryujs.node')
  if (fs.existsSync(cached) && !fs.readFileSync(cached).equals(fs.readFileSync(path.join(ryuDir, 'prebuilt', 'ryujs-win32-x64.node')))) {
    fs.copyFileSync(cached, path.join(ryuDir, 'ryujs.node'))
    console.log('[ryu-rebuild] ryujs.node was clobbered by an npm install — restored the Electron-safe build from the incremental tree')
    process.exit(0)
  }
  console.log('[ryu-rebuild] ryujs.node was clobbered by an npm install and no cached build exists — rebuilding')
}

function findVsTool(rel) {
  const vswhere = path.join(
    process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)',
    'Microsoft Visual Studio', 'Installer', 'vswhere.exe'
  )
  const vsRoot = execFileSync(
    vswhere,
    ['-latest', '-products', '*', '-requires', 'Microsoft.VisualStudio.Component.VC.Tools.x86.x64', '-property', 'installationPath'],
    { encoding: 'utf8' }
  ).trim()
  if (!vsRoot) throw new Error('Visual Studio Build Tools with C++ workload not found')
  const p = path.join(vsRoot, rel)
  if (!fs.existsSync(p)) throw new Error(`missing VS component: ${p}`)
  return p
}

const vcvars = findVsTool('VC\\Auxiliary\\Build\\vcvars64.bat')
const cmakeBin = path.dirname(findVsTool('Common7\\IDE\\CommonExtensions\\Microsoft\\CMake\\CMake\\bin\\cmake.exe'))
const ninjaBin = path.dirname(findVsTool('Common7\\IDE\\CommonExtensions\\Microsoft\\CMake\\Ninja\\ninja.exe'))

// 1. Copy the source out of the repo (OneDrive/synced paths wreck build perf)
// unless an incremental tree is already there.
if (!fs.existsSync(path.join(srcDir, 'CMakeLists.txt'))) {
  console.log(`[ryu-rebuild] copying ryu-source to ${srcDir} …`)
  fs.rmSync(workDir, { recursive: true, force: true })
  fs.mkdirSync(workDir, { recursive: true })
  fs.cpSync(path.join(ryuDir, 'ryu-source'), srcDir, { recursive: true })

  // 2. Pin the CMakeLists' cmake-js introspection to the Electron runtime so
  // CMAKE_JS_SRC includes win_delay_load_hook.cc and node.lib is Electron's.
  const cml = path.join(srcDir, 'tools', 'nodejs_api', 'CMakeLists.txt')
  const electronArgs = `--runtime electron --runtime-version ${electronVersion} --arch x64`
  fs.writeFileSync(
    cml,
    fs.readFileSync(cml, 'utf8').replace(/cmake-js (print-cmakejs-(?:include|lib|src))/g, `cmake-js $1 ${electronArgs}`)
  )
}

// 2b. The hook source alone is inert: the target must also link with
// /DELAYLOAD:node.exe + delayimp.lib so node.exe imports resolve through the
// hook (which redirects them to the host executable — electron.exe or
// node.exe). cmake-js only injects these flags when it drives the build
// itself, so patch them into the target.
{
  const cml = path.join(srcDir, 'tools', 'nodejs_api', 'CMakeLists.txt')
  const delayPatch = [
    'if(WIN32)',
    '  target_link_options(ryujs PRIVATE "/DELAYLOAD:node.exe")',
    '  target_link_libraries(ryujs PRIVATE delayimp)',
    'endif()'
  ].join('\n')
  const text = fs.readFileSync(cml, 'utf8')
  if (!text.includes('DELAYLOAD:node.exe')) {
    fs.writeFileSync(cml, text + '\n' + delayPatch + '\n')
  }
}

// 3. nodejs_api needs its own node_modules (node-addon-api, cmake-js).
console.log('[ryu-rebuild] npm install for nodejs_api …')
execSync('npm install --include=dev --no-audit --no-fund', {
  cwd: path.join(srcDir, 'tools', 'nodejs_api'),
  stdio: 'inherit'
})

// 4. Configure + build with MSVC env from vcvars64 — via a generated batch
// file, because nested quotes in a single `cmd /c` string get mangled.
const batch = path.join(workDir, 'build-electron.cmd')
fs.writeFileSync(
  batch,
  [
    '@echo off',
    `call "${vcvars}" >nul`,
    'if errorlevel 1 exit /b 1',
    `set "Path=${cmakeBin};${ninjaBin};%Path%"`,
    `set CMAKE_BUILD_PARALLEL_LEVEL=${Math.max(2, os.cpus().length - 2)}`,
    `cmake -G Ninja -B "${buildDir}" -S "${srcDir}" -DCMAKE_BUILD_TYPE=Release -DBUILD_NODEJS=TRUE -DBUILD_SHELL=FALSE`,
    'if errorlevel 1 exit /b 1',
    `cmake --build "${buildDir}"`,
    ''
  ].join('\r\n')
)
console.log('[ryu-rebuild] building (first build takes a while) …')
execFileSync('cmd.exe', ['/d', '/c', batch], { stdio: 'inherit' })

// 5. Install the Electron-safe binary and stamp the marker.
const built = path.join(srcDir, 'tools', 'nodejs_api', 'build', 'ryujs.node')
if (!fs.existsSync(built)) throw new Error(`build finished but ${built} is missing`)
const backup = path.join(ryuDir, 'ryujs-node-prebuilt.node')
if (!fs.existsSync(backup)) fs.copyFileSync(path.join(ryuDir, 'ryujs.node'), backup)
fs.copyFileSync(built, path.join(ryuDir, 'ryujs.node'))
fs.writeFileSync(marker, electronVersion + '\n')
console.log(`[ryu-rebuild] installed Electron-safe ryujs.node (Electron ${electronVersion}); original kept as ryujs-node-prebuilt.node`)
