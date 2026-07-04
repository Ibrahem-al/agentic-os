import { app, BrowserWindow, shell } from 'electron'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { MCP_HOST, MCP_PORT, PRODUCT_NAME, RYUGRAPH_VERSION_PIN } from './config'

// Native modules are CJS; load them through require so the bundler leaves them
// external and Electron resolves them from node_modules at runtime.
const require = createRequire(import.meta.url)

/** Phase-00 proof: native-module pipeline works inside Electron main. */
function logNativeModuleVersions(): void {
  const betterSqlite3Pkg = require('better-sqlite3/package.json') as { version: string }
  const BetterSqlite3 = require('better-sqlite3') as typeof import('better-sqlite3')
  const probe = new BetterSqlite3(':memory:')
  const row = probe.prepare('SELECT sqlite_version() AS v').get() as { v: string }
  probe.close()
  console.log(`[native] better-sqlite3 ${betterSqlite3Pkg.version} (SQLite ${row.v}) loaded in Electron main`)

  const ortPkg = require('onnxruntime-node/package.json') as { version: string }
  const ort = require('onnxruntime-node') as { env?: { versions?: Record<string, string> } }
  const ortRuntimeVersion = ort.env?.versions?.['common'] ?? ortPkg.version
  console.log(`[native] onnxruntime-node ${ortPkg.version} (runtime ${ortRuntimeVersion}) loaded in Electron main`)
}

/** Phase-00 proof: RyuGraph binding + offline vector/FTS extensions in Electron main. */
async function runRyugraphSpikeInMain(): Promise<void> {
  // ryugraph's `exports` map hides package.json from require — read it directly.
  const { readFileSync, existsSync } = require('node:fs') as typeof import('node:fs')
  const ryuPkgPath = join(app.getAppPath(), 'node_modules', 'ryugraph', 'package.json')
  const ryuPkg = JSON.parse(readFileSync(ryuPkgPath, 'utf8')) as { version: string }
  if (ryuPkg.version !== RYUGRAPH_VERSION_PIN) {
    console.warn(`[spike] ryugraph ${ryuPkg.version} does not match pin ${RYUGRAPH_VERSION_PIN}`)
  }
  // The npm prebuilt ryujs.node binds its imports to node.exe with no
  // delay-load hook, so require()-ing it inside electron.exe on Windows is an
  // uncatchable native crash. `npm run rebuild:native` replaces it with an
  // Electron-targeted cmake-js build and stamps this marker; until then, skip.
  if (process.platform === 'win32') {
    const marker = join(app.getAppPath(), 'node_modules', 'ryugraph', '.electron-safe')
    if (!existsSync(marker)) {
      console.warn(
        '[spike] ryugraph prebuilt is not Electron-safe on win32 — run `npm run rebuild:native`; skipping in-main spike'
      )
      return
    }
  }
  const spikePath = join(app.getAppPath(), 'scripts', 'spike', 'ryugraph-spike.cjs')
  const { runRyugraphSpike } = require(spikePath) as {
    runRyugraphSpike: (dbDir: string) => Promise<{ ok: boolean }>
  }
  const dbDir = join(app.getPath('userData'), 'spike-data')
  await runRyugraphSpike(dbDir)
  console.log(`[spike] ryugraph ${ryuPkg.version}: offline vector + FTS spike PASS in Electron main`)
}

function createWindow(): void {
  const win = new BrowserWindow({
    width: 1200,
    height: 800,
    title: PRODUCT_NAME,
    webPreferences: {
      preload: join(import.meta.dirname, '../preload/index.mjs'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  win.webContents.setWindowOpenHandler((details) => {
    void shell.openExternal(details.url)
    return { action: 'deny' }
  })

  if (process.env['ELECTRON_RENDERER_URL']) {
    void win.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    void win.loadFile(join(import.meta.dirname, '../renderer/index.html'))
  }
}

void app.whenReady().then(async () => {
  console.log(`[boot] ${PRODUCT_NAME} main process starting (MCP reserved at ${MCP_HOST}:${MCP_PORT})`)
  try {
    logNativeModuleVersions()
  } catch (err) {
    console.error('[native] native-module load FAILED', err)
  }
  try {
    await runRyugraphSpikeInMain()
  } catch (err) {
    console.error('[spike] ryugraph spike FAILED in Electron main', err)
  }

  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
