# Phase 00 report — Scaffold & de-risk

**Status:** done · **Date:** 2026-07-03

## What was built

- **Electron + TypeScript scaffold** (electron-vite 5 / vite 7 / React 19 / Tailwind 4, TS `strict` everywhere):
  - `src/main/index.ts` — boots a window, logs native-module versions, runs the RyuGraph spike at launch.
  - `src/preload/index.ts` + `index.d.ts` — typed `contextBridge` stub (`window.agenticOS`); renderer has no Node access (`nodeIntegration: false`, `contextIsolation: true`).
  - `src/renderer/` — minimal React + Tailwind placeholder page.
  - Empty module folders per spec §22: `src/main/{kernel,storage,models,retrieval,mcp,agents,ingest,security,triggers,telemetry}`, `scripts/hooks/`, `tests/{unit,integration,e2e,fixtures}/`, `resources/extensions/`, `docs/reference/skill-creator/`.
- **`src/main/config.ts`** — every §20 value as named exports (MCP host/port/transport, hook URL, spool/rules dirs, app-data path resolver, models, retrieval weights, loop bound, entity thresholds, escalation, cron strings, retry backoff, spend ceiling, chunking, RyuGraph pin). Electron-free so tests and scripts can import it; §20 times encoded as cron strings (`0 3 * * *`, `0 2 * * *`, `30 3 * * 0`).
- **Native-module pipeline** — `better-sqlite3` 12.11.1 + `onnxruntime-node` 1.27.0 as runtime deps; `npm run rebuild:native` = `electron-rebuild -f -w better-sqlite3` **plus** `scripts/native/rebuild-ryugraph-electron.cjs` (see finding 3). Both modules log versions from Electron main on launch.
- **RyuGraph spike** — `scripts/spike/ryugraph-spike.cjs` (shared) + `scripts/spike/run-spike.cjs` (runner; `npm run spike:ryugraph`). Creates an on-disk DB, loads vendored vector+FTS extension binaries by absolute path, creates nodes, queries back, runs a vector-index query and an FTS query.
- **Vendored extensions** — `resources/extensions/v25.9.0/{win_amd64,linux_amd64,linux_arm64,osx_amd64,osx_arm64}/{vector,fts}/lib*.ryu_extension` (~34 MB) + `SHA256SUMS`, extracted from the official `ghcr.io/predictable-labs/extension-repo:latest` image (the same artifact store the engine's own `INSTALL` statement downloads from; the docs document self-hosting this image).
- **CI** — `.github/workflows/ci.yml`: ubuntu/macos/windows matrix; npm ci → lint → typecheck → vitest; offline extension-load check with real network denial per OS (`unshare -n` / `sandbox-exec deny network*` / outbound firewall rule); Electron-ABI spike run (`ELECTRON_RUN_AS_NODE`) on ubuntu+macos; better-sqlite3+onnxruntime Electron check on windows (`scripts/ci/electron-native-check.cjs`).
- **Tests** — `tests/unit/config.test.ts` (9 assertions pinning §20 values).

## Key decisions & findings (read before phase 01)

1. **RyuGraph version pin.** Spec §5 pins "≥ v0.11.3" (Kùzu-lineage numbering). RyuGraph renumbered to CalVer after the fork; the official npm binding is `ryugraph@25.9.1` (only 25.9.0/25.9.1 exist; N-API via node-addon-api, prebuilt binaries for all five platforms shipped inside the package plus full `ryu-source/`). Interpreted the pin as "the ≥0.11.3 lineage", satisfied by 25.9.1. The engine's compiled-in extension version is **25.9.0** (`RYU_EXTENSION_VERSION`), which is why the vendored directory is `v25.9.0`.
2. **Extensions are NOT pre-installed in the npm build** (upstream docs claim otherwise). A bare `LOAD EXTENSION VECTOR` resolves from `~/.ryu/extension/…`, which only exists after a networked `INSTALL`. Per the phase contingency we vendor the pinned binaries in `resources/extensions/` and the spike loads them **by absolute path** (`LOAD EXTENSION '<file>'`, reported as source `USER`). Integrity: the win_amd64 files extracted from the official ghcr.io image are sha256-identical to what the engine's own `INSTALL` had previously fetched on this machine; manifest committed as `SHA256SUMS`, verified in CI. (A pre-existing `~/.ryu` cache from June was moved aside during local verification so it could not mask a network fetch.) Quirk: upstream serves byte-identical linux amd64/arm64 `libvector` files — looks like an upstream packaging bug on arm64; our CI targets amd64 only.
3. **The win32 npm prebuilt crashes Electron (uncatchable), fixed by rebuild.** `ryujs-win32-x64.node` imports from `node.exe` with no delay-load machinery, so `require('ryugraph')` inside electron.exe on Windows kills the process natively (not a catchable JS error). Fix implemented and verified: `scripts/native/rebuild-ryugraph-electron.cjs` (wired into `rebuild:native`, win32-only) rebuilds the binding from the npm-shipped `ryu-source/` with (a) cmake-js introspection pinned to `--runtime electron` (Electron headers + node.lib + `win_delay_load_hook.cc` in `CMAKE_JS_SRC`) **and (b) an injected `target_link_options(ryujs PRIVATE "/DELAYLOAD:node.exe")` + `delayimp`** — the hook source alone is inert without the linker flag (first attempt failed exactly this way). The resulting binary passes the full spike under electron.exe (RUN_AS_NODE and real main process) **and** plain node.exe (the hook redirects to whichever host executable loaded it), so replacing `node_modules/ryugraph/ryujs.node` is safe for vitest/CI too (original kept as `ryujs-node-prebuilt.node`). Stamps `node_modules/ryugraph/.electron-safe`; `src/main` gates the in-main spike on that marker so a fresh `npm install` can never crash the app. Requires VS 2022 Build Tools C++ (present on this machine; located via vswhere); first build ≈25 min on 18 threads, ninja-incremental afterwards (a marker-hit run is seconds). Linux prebuilt verified Electron-compatible as-is (spike PASS under electron 43 in Docker); macOS uses the same dlopen semantics and is checked in CI.
4. **FTS index behavior (matters for phase 01/03 design):** `CREATE_FTS_INDEX` only indexes rows that exist at creation time — later inserts are not picked up (re-create or use the extension's update path when we design the write lane). The default analyzer also drops some tokens (e.g. `hello` matched nothing while `world`/`ryugraph` matched), so retrieval tests must not assume every literal token is searchable.
5. **`ryugraph`'s `exports` map hides `package.json`** — `require('ryugraph/package.json')` throws; read the file directly if you need the version.
6. **Offline verification on this machine** used Docker `--network none` (network unreachability asserted in-band before the spike ran) with the repo bind-mounted read-only; Windows-native and Electron-runtime runs used the vendored path-loads with the `~/.ryu` cache moved aside. CI additionally enforces offline per-OS as listed above.
7. **Version pins vs. spec §20:** electron-vite 5 requires vite ≤7 → vite 7.3.6; `@tailwindcss/vite` needed 4.3.2 for vite 7. Electron 43.0.0, React 19.2.7, TS 5.8.3 (TS 6 is out but typescript-eslint caps at <6.1 and 5.8 is the conservative choice). Windows Electron stdout is unreliable (GUI subsystem) — spike runner mirrors output to `SPIKE_LOG_FILE` when set; CI's windows Electron check writes JSON to `%TEMP%`.
8. **Later-phase installs deferred:** chokidar, croner, @langchain/langgraph, @modelcontextprotocol/sdk, OTel SDK, zod, Playwright, electron-updater, electron-builder are §20-pinned but not needed by phase 00, so they are not yet installed (CLAUDE.md says ask/install when a phase needs them). `npm run test:e2e` will be added with Playwright in its phase.

## Skills installed (verification)

- `design-taste-frontend` (Leonxlnx/taste-skill): present at `~/.claude/skills/taste` — SKILL.md frontmatter `name: design-taste-frontend`. Available in-session as `taste`.
- `impeccable` plugin: `impeccable@impeccable` in `~/.claude/plugins/installed_plugins.json` (user scope); `/impeccable` skill available in-session.
- `ui-ux-pro-max` plugin: `ui-ux-pro-max@ui-ux-pro-max-skill` installed (user scope); skill available in-session.
- Playwright MCP: installed as the official `playwright@claude-plugins-official` plugin — `claude mcp list` shows `plugin:playwright:playwright: npx @playwright/mcp@latest - ✔ Connected` (same server the phase's `claude mcp add` would register).
- skill-creator: vendored into `docs/reference/skill-creator/` from anthropics/skills @ `9d2f1ae187231d8199c64b5b762e1bdf2244733d` (SKILL.md + agents/ + references/ + scripts/ + eval-viewer/).

## Verification outputs

See "Definition of Done" section below — outputs pasted verbatim.

## Instructions for phase 01

- Import every default from `src/main/config.ts`; extend it rather than declaring constants elsewhere.
- The storage abstraction must load vector+FTS **by absolute path** from `resources/extensions/v25.9.0/<platform>/` (use the platform helper in `scripts/spike/ryugraph-spike.cjs` as reference); never name-based `LOAD`, never `INSTALL`.
- Run `npm run rebuild:native` once per machine/Electron-bump on Windows before expecting RyuGraph in Electron main; gate on `node_modules/ryugraph/.electron-safe` like `src/main/index.ts` does.
- Remember findings 4 (FTS is create-time-static + token pipeline quirks) and 5 (exports map) when designing the write lane and tests.
- The spike scripts are throwaway proof code — do not grow them into the storage layer; delete them once phase 01's real storage tests supersede them.

## Definition of Done — outputs

### 1. `npm run dev` opens a window; main logs versions (incl. in-main RyuGraph spike)

```
[boot] agentic-os main process starting (MCP reserved at 127.0.0.1:4517)
[native] better-sqlite3 12.11.1 (SQLite 3.53.2) loaded in Electron main
[native] onnxruntime-node 1.27.0 (runtime 1.27.0) loaded in Electron main
[spike] ryugraph binding loaded (package version 25.9.1)
[spike] database created on disk at C:\Users\ibrah\AppData\Roaming\agentic-os\spike-data\spike.ryugraph (engine version 25.9.1)
[spike] extensions loaded from vendored binaries: [... win_amd64 vector + fts, source USER ...]
[spike] node created and queried back: {"id":1,"text":"ryugraph spike hello world"}
[spike] vector index created + queried: nearest id=1
[spike] FTS index created + queried: top hit id=1
[spike] ryugraph 25.9.1: offline vector + FTS spike PASS in Electron main
```

### 2. RyuGraph spike passes offline on this machine

Docker `--network none` (hard offline, this machine):

```
--- network check (must fail) ---
network unreachable: OK
--- run spike offline ---
[spike] ryugraph binding loaded (package version 25.9.1)
[spike] database created on disk at /tmp/spike-data/spike.ryugraph (engine version 25.9.1)
[spike] extensions loaded from vendored binaries: [{"extension name":"VECTOR","extension source":"USER","extension path":"/repo/resources/extensions/v25.9.0/linux_amd64/vector/libvector.ryu_extension"},{"extension name":"FTS","extension source":"USER","extension path":"/repo/resources/extensions/v25.9.0/linux_amd64/fts/libfts.ryu_extension"}]
[spike] node created and queried back: {"id":1,"text":"ryugraph spike hello world"}
[spike] vector index created + queried: nearest id=1
[spike] FTS index created + queried: top hit id=1
RYUGRAPH SPIKE PASS
```

Also verified on this machine, all `RYUGRAPH SPIKE PASS` with the same checks:

- Windows, plain node 24 (vendored win_amd64 path-loads, `~/.ryu` cache moved aside so it could not mask a fetch).
- Windows, Electron 43 runtime (`ELECTRON_RUN_AS_NODE`) after `rebuild:native` — `runtime: electron=43.0.0 node=24.17.0`.
- Windows, real Electron main process via `npm run dev` (section 1).
- Linux, Electron 43 runtime inside Docker (`runtime: electron=43.0.0 node=24.17.0`) — proves the unmodified linux prebuilt is Electron-compatible.

### 3. lint / typecheck / test green; CI committed

```
> eslint .            (no findings)
> tsc --noEmit -p tsconfig.node.json && tsc --noEmit -p tsconfig.web.json   (clean)
> vitest run          Test Files 1 passed (1) · Tests 9 passed (9)
```

CI: `.github/workflows/ci.yml` (3-OS matrix, offline extension checks, Electron ABI checks).

### 4. Skills installed — see "Skills installed (verification)" above.
