# Phase 23 report — installer reinstall guard + rebuilt installer

**Branch:** `feat/mcp-expansion-subscription-reasoner`. Requested: rebuild the installer, and make it check whether the app is already installed and prompt the user to remove it first. Opus (direct, max effort — a small, intricate, verified-against-template NSIS change coupled to the build).

## The reinstall guard
The app ships a **oneClick per-user** NSIS installer (`electron-builder.yml` → `nsis.oneClick:true, perMachine:false`), which by default **silently** auto-uninstalls an existing version and reinstalls. Requested behavior: prompt first.

- **`build/installer.nsh`** (new) — auto-included by electron-builder (`getResource(nsis.include, "installer.nsh")` resolves `build/installer.nsh` from `buildResources`; confirmed in `platformPackager.js:584-590`). Defines a **`preInit`** macro:
  - runs at the very top of `.onInit` (`installer.nsi:56`), **before** electron-builder's own auto-uninstall in `installUtil.nsh` (`:91`), so declining aborts before anything is touched;
  - reads the per-user `HKCU` uninstall entry via the template-defined `${UNINSTALL_REGISTRY_KEY}` (canonical "is it installed?" probe);
  - if installed → `MessageBox MB_YESNO`: **Yes** → proceed (electron-builder removes the old version, keeping user data, then installs); **No** → `Quit` (cancel; existing app untouched);
  - **`/SD IDYES`** — critical: electron-updater applies auto-updates by running the installer **silently (`/S`)**; the silent default must be "proceed" or an update would hang on the dialog. Interactive double-click still shows the prompt.
  - Core NSIS only (`ReadRegStr`/`StrCmp`/`MessageBox`/`Quit`) — no LogicLib dependency.
- **`electron-builder.yml`** — a discoverability comment pointing at the guard.

## Rebuild
`npm run rebuild:native` (Electron-safe natives — the before-pack gate passed: "win32 ryugraph OK: Electron-safe ryujs.node") → `npm run build` (electron-vite) → `npm run package` (electron-builder 26.15.3). Produced `dist/agentic-os-0.1.0-win-x64.exe` (152,587,998 bytes, ~80 KB larger than the pre-guard build — consistent with the added macro + strings) + signed uninstaller + blockmap. `dist/` is gitignored (the installer artifact is not committed).

## Verification
- **Guard included — authoritatively confirmed:** `getResource(undefined, "installer.nsh")` returns `build/installer.nsh` (present in `build/`), `NsisTarget` `!include`s it, and makensis compiled with **`-WX` (warnings-as-errors) and succeeded** — a malformed macro would have failed the build.
- **Logic verified against electron-builder's own NSIS template:** `preInit` fires before the auto-uninstall; `HKCU` + `${UNINSTALL_REGISTRY_KEY}` is the exact key the template writes/deletes (`APP_GUID`/`UNINSTALL_APP_KEY = 292301e4-…`); `/SD IDYES` preserves silent auto-update.
- **Not done autonomously (machine-touching):** seeing the actual dialog requires an interactive double-click (a scripted `/S` run auto-proceeds by design), and a normal run **launches the app** (`RUN_AFTER_FINISH`). To verify visually: run the installer once (installs + launches), then run it again → the "already installed" prompt appears. A supervised silent-install + registry-check + silent-uninstall smoke can be run on request.

## Note
The installer copy still calls the product "local-first"/"local-first memory-and-tool backend" (the `AppDescription`/NSIS metadata) — accurate for the default install (the subscription runner is off by default). The website "local-first" copy honesty edit is tracked separately (website repo).
