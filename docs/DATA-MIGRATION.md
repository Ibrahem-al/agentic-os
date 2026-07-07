# Data safety: update, reinstall, uninstall & migration

This is the durable, human-readable contract for how Agentic OS moves your data
safely across installs, updates, re-downloads, reinstalls and uninstalls. It
**mirrors the code, and the code is authoritative**: the installer logic lives
in `build/installer.nsh`, the app-side logic in `src/main/storage/{reset,manifest,appdata,migrations}.ts`,
the constants in `src/main/config.ts`, and the invariants are CI-enforced by
`tests/unit/installer.invariants.test.ts`, `tests/unit/storage.reset.test.ts`
and `tests/unit/storage.manifest.test.ts`.

## Where your data lives

Everything is under the per-user Electron `userData` directory
(`app.getPath('userData')`), which on Windows is `%APPDATA%\agentic-os`
(NSIS: `$APPDATA\${APP_FILENAME}`).

| Path (under userData)      | What it is                                                        | Critical? | Backed up on reset? |
| -------------------------- | ---------------------------------------------------------------- | --------- | ------------------- |
| `graph/`                   | RyuGraph memory graph — **the crown jewels**                     | yes       | yes (closed-file copy) |
| `appdata.db` (+ `-wal`/`-shm`) | SQLite: traces, tasks, mcp_calls, staged_writes, spend, approvals, audit_log, skill_*, runner_* | yes | yes (`VACUUM INTO`) |
| `keychain.bin`             | `safeStorage`-encrypted secrets (API keys, MCP/hook/runner tokens) | yes     | yes (copy)          |
| `settings.json`            | Non-secret model/provider settings                               | no        | yes (copy)          |
| `mcp-servers.json`         | External MCP servers this app consumes                          | no        | yes (copy)          |
| `watched-folders.json`     | Watched-folder ingestion definitions                            | no        | yes (copy)          |
| `trigger-state.json`       | Watcher baselines (file/url content hashes)                     | no        | yes (copy)          |
| `exports/`                 | Weekly CSV/Cypher exports                                        | no        | yes (copy)          |
| `models/`                  | Pinned ONNX reranker weights                                    | no (re-downloadable) | **no** — large, checksum-pinned, re-fetched on demand |
| `bin/`                     | Managed Deno binary                                             | no (re-downloadable) | **no** — re-downloaded on demand |
| `backups/`                 | All snapshots (see below)                                       | —         | never cleared       |
| `data-manifest.json`       | Machine-readable inventory + schema versions (the "note")      | —         | regenerated on boot |

## The four safety invariants

1. **Silent runs never destroy data.** electron-updater applies updates by
   running the NSIS installer **silently (`/S`)**. Every installer/uninstaller
   dialog has an `/SD` default set to the **keep-data / update** answer, and the
   destructive installer branch sits behind *two* dialogs (silent defaults
   `IDYES`=update, then `IDNO`=no-reset), so a silent run **structurally cannot**
   request a wipe. On the uninstaller side, `/S` **or** `--updated` route to
   keep-data before any prompt.
2. **Back up before any destructive operation.** A "reinstall from scratch" or
   "remove data" first **moves/snapshots** the existing data to a recoverable
   backup **with integrity checks**, and only then clears — never an
   irreversible `rm`.
3. **Downgrade guards are preserved.** An on-disk schema **newer** than this
   build refuses to be touched — `appdata.db` (`user_version` throw in
   `openAppData`) and the graph (`GraphSchemaNewerError`). The snapshot path
   (`snapshotAppDataDb`) opens the store **read-only** and applies no
   schema/pragma, so snapshotting never weakens these guards.
4. **Reuse, single config home.** The reset reuses the existing backup
   machinery (`snapshotDir`, `VACUUM INTO`, `appDataPaths().backupsDir`); the
   only new names (`RESET_MARKER_FILENAME`, `DATA_MANIFEST_FILENAME`,
   `PRE_RESET_BACKUP_LABEL`, `UNINSTALL_BACKUP_DIRNAME`) live once in
   `config.ts` and are mirrored into `build/installer.nsh` under test.

## The four flows

### 1. Silent auto-update (electron-updater)
electron-updater downloads the new installer and runs it `/S`. The 3-way prompt
auto-answers **Update (keep data)**; program files are replaced; `%APPDATA%\agentic-os`
is untouched. The old version is removed by running its uninstaller with
`/S /KEEP_APP_DATA --updated` — which keeps data. On first launch of the new
build, any pending schema **migrations** run **after a pre-migration backup**
(`backups/<stamp>-pre-migration-v<N>/` for the graph, `backups/<stamp>-pre-appdata-v<N>/`
for SQLite). **No data is ever reset on this path.**

### 2. Interactive update (double-click the installer while already installed)
`preInit` shows a **3-way** dialog:

> agentic-os is already installed on this computer.
> **YES** — Update (recommended): your memory graph and all data are KEPT.
> **NO** — Reinstall from scratch: your data is first COPIED to a backup, then the app starts fresh.
> **CANCEL** — do nothing.

Choosing **YES** (also the silent default) behaves exactly like flow 1.
**CANCEL** quits, leaving the existing install untouched.

### 3. Reinstall from scratch (interactive **NO**)
The installer asks a **second, explicit** confirmation (silent default = NO):

> On the next launch the app will FIRST copy your memory graph, databases and
> settings into `%APPDATA%\agentic-os\backups\<timestamp>-pre-reset\` and only
> then start fresh. Nothing is deleted without that backup.

If confirmed, the installer **only writes an intent marker**
`reset-data-requested.json` into `%APPDATA%\agentic-os` (it never deletes
anything). If it cannot even write the marker, it falls back to the safe update
path. On the **next app launch**, before any store opens, the app
(`performPendingReset`) does:

1. **Snapshot** into `backups/<stamp>-pre-reset/`: `graph/` (closed-file copy),
   `appdata.db` (`VACUUM INTO`), and the config files + `exports/` (copy).
   `models/` and `bin/` are not copied (re-downloadable).
2. **Verify the snapshot** *before clearing anything*: the appdata snapshot must
   pass `PRAGMA integrity_check`, and the graph copy's file-count + byte-total
   must equal the source. Write `reset-record.json` (inventory + check results).
3. **Clear** the live store via an explicit allowlist (`graph/`, `appdata.db`,
   `models/`, `bin/`, `exports/`, `runner/`, `keychain.bin`, the config files,
   `.mcp.json`). `backups/` is **structurally never** in the allowlist, so every
   historical backup **and** the new pre-reset snapshot survive.
4. **Remove the marker last.**

Any failure in steps 1–2 happens **before any deletion**: the marker is renamed
`reset-data-requested.json.failed-<stamp>` and **all data is left untouched**.
A crash between clear and marker-removal re-runs idempotently (empty
snapshot + no-op clear, marker removed).

### 4. Uninstall (keep vs. remove)
Interactive uninstall (Add/Remove Programs / one-click) asks:

> Keep your agentic-os data (memory graph, databases, settings)?
> **YES** — keep it (recommended).
> **NO** — remove it; it is first MOVED to `%APPDATA%\agentic-os-backups\<timestamp>`
> (nothing is deleted — delete that folder yourself later if you are sure).

**Remove** is implemented as an **atomic `Rename` (move)** of
`%APPDATA%\agentic-os` into `%APPDATA%\agentic-os-backups\agentic-os-<stamp>` —
**there is no `RMDir /r` of user data anywhere in our code**. If the move fails
(file lock), the data is left in place and the uninstaller says so. A **silent**
uninstall (`/S`) or the update flow's uninstall (`--updated`) always **keeps**
data. `deleteAppDataOnUninstall` is intentionally left unset, so the template's
own delete-app-data block stays inert.

## Backups, downgrade guards, sidecar & manifest — how they interlock

- **`backups/`** holds every snapshot, named by a lexicographically-sortable
  UTC stamp: `<stamp>-pre-migration-v<N>` (graph, before a migration),
  `<stamp>-pre-appdata-v<N>` (SQLite, before a schema upgrade), and
  `<stamp>-pre-reset` (everything, before a reinstall-from-scratch reset).
- **Downgrade guards** (`user_version` throw + `GraphSchemaNewerError`) stop a
  build from touching a **newer** on-disk schema. A reset snapshots such a store
  read-only *before* clearing, so even resetting a newer-versioned store is
  recoverable.
- **The graph sidecar** `graph/schema-version.json` is read *before* the graph
  db opens, so the pre-migration backup runs with no file locks (Windows cannot
  copy an open RyuGraph db).
- **`data-manifest.json`** (schema `manifestVersion: 1`) is (re)written
  atomically on every successful boot with `appVersion`, `schema`
  (`appdataUserVersion`, `graphSchemaVersion`), a cheap asset inventory (path,
  bytes, file count, mtime, criticality), and backup pointers. On boot it is
  first *verified*: a critical asset the previous manifest recorded present but
  now missing/emptied is logged loudly (never blocks, never mutates). The
  manifest's job is "is the data present, plausibly intact, which schema
  versions" — the *strong* integrity checks live in the reset/migration paths.

### For an external tool moving data (re-download / migration helper)
Read `data-manifest.json` and **refuse to move data into an older build**: if
`schema.appdataUserVersion` or `schema.graphSchemaVersion` is **newer** than the
target build understands, stop — this mirrors the in-app downgrade guards
(`openAppData`'s `user_version` throw and `GraphSchemaNewerError`). Use the
inventory + `backups.latest` to confirm the data is present before any move.

## Restore runbooks

Always **quit the app first** (release file locks).

- **From a pre-reset snapshot** (`backups/<stamp>-pre-reset/`):
  copy `graph/` back to `userData/graph`, `appdata.db` back to
  `userData/appdata.db`, and any `keychain.bin` / `*.json` you want to restore;
  then restart. `reset-record.json` in that folder lists exactly what was saved.
- **From a pre-migration snapshot** (`backups/<stamp>-pre-migration-v<N>/`):
  copy its `graph/` contents back to `userData/graph` (this is a graph-only
  snapshot), then restart on the build that produced it.
- **From a pre-appdata snapshot** (`backups/<stamp>-pre-appdata-v<N>/appdata.db`):
  copy that `appdata.db` back to `userData/appdata.db`, then restart on the
  build that produced it.
- **From an uninstall move** (`%APPDATA%\agentic-os-backups\agentic-os-<stamp>`):
  rename it back to `%APPDATA%\agentic-os` **before** reinstalling.

## Caveats

- **`keychain.bin` is user-bound.** Secrets are encrypted with the OS
  `safeStorage` (DPAPI on Windows), so a backup only decrypts for the **same
  Windows user**. Restoring to another account silently loses the secrets — you
  re-enter API keys; tokens regenerate.
- **`models/` and `bin/` are not backed up** — they are large, checksum-pinned
  and re-downloaded on demand.
- The `/S`-detection in the uninstaller depends on electron-builder's invocation
  contract (old uninstaller run with `/S /KEEP_APP_DATA --updated`, and
  one-click `un.onInit` calling `SetSilent`). Both `/S` and `--updated` are
  treated as keep-data; the contract is pinned by the electron-builder version.

## The config ↔ installer sync contract

`RESET_MARKER_FILENAME` (`reset-data-requested.json`) and
`UNINSTALL_BACKUP_DIRNAME` (`agentic-os-backups`) appear in **both**
`src/main/config.ts` and `build/installer.nsh`. `tests/unit/installer.invariants.test.ts`
asserts they match verbatim, that every `MessageBox` carries an `/SD` default,
that the 3-way box defaults to keep-data and the reset-confirm to no, that there
is no `RMDir /r "$APPDATA` and no `--delete-app-data`, and that
`electron-builder.yml` never enables `deleteAppDataOnUninstall`. A future edit
that violates an invariant fails CI.
