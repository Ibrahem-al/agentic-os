# Phase 39 — Patch notes ("What's new") in the update flow

**Status:** done · **Date:** 2026-07-20 · User-directed ("give patch notes when the user wants to download/install an update"). Design help from a Fable subagent (as requested); implementation Opus.

## The gap
Updates download in the background (`autoDownload`) and the Settings "Updates" section showed only "Version vX is downloaded and ready to install" + a "Restart to update" button — **no indication of what changed**. The `update-available` / `update-downloaded` payloads already carry the GitHub release body (`UpdateInfo.releaseNotes`), but the controller read only `info.version`.

## Design decision (Fable + Opus)
**Keep the seamless background download** — the only real decision point in the model is *Restart to update*, so we surface the release notes right there rather than gating the download (which would add a new IPC action + a new state and break the §3 seamless-updates invariant the packaged smoke proves). The notes appear in the `downloading` and `downloaded` states, above the Restart action.

## What was built

### 1. Notes plumbed into the updater snapshot — `src/main/updater.ts`
- `releaseNotesOf(info)` normalizes `UpdateInfo.releaseNotes` (which may be a **string**, an **Array<{version, note}>** for several skipped versions, or **null/odd shapes**) into one untrusted string, newest-version-first, null-note entries skipped — a **total function** that never throws (the updater must never crash boot).
- `stripReleaseHtml` removes HTML (electron-updater's GitHub provider delivers HTML in some versions): block-closing tags → newlines, all other tags deleted, five entities decoded (`&` last). Length-capped at `RELEASE_NOTES_MAX_CHARS = 10000` (rule-12) with a trailing `…`.
- `releaseMetaFields(info)` adds `releaseNotes` / `releaseName` / `releaseDate`; the metadata is **captured on `update-available` and re-applied to every `download-progress` tick** (which carries only numbers), so the notes stay visible through to `downloaded`. `update-downloaded` prefers its own payload's notes, falling back to what `update-available` captured. `up-to-date` / `error` clear them (no pending update).
- DTO: `UpdaterStatusDto` gains `releaseNotes?` / `releaseName?` / `releaseDate?` (`src/shared/ipc.ts`). The deferred-install path (`ipc.ts`) already spreads `updater.status()`, so the fields survive unchanged.

### 2. Safe markdown-lite renderer — `src/renderer/src/lib/releaseNotes.tsx` (new)
The notes are untrusted markdown and there is no markdown/sanitizer dependency and a strict CSP, so a **closed-grammar** renderer builds only React elements whose children are strings — **no `dangerouslySetInnerHTML`, ever** (the second of two independent safety layers). `parseReleaseNotes(text)` (pure, unit-tested) → blocks: `#{1,6}` headings, `-`/`*`/`+`/`N.` bullets (one flat list), ```` ``` ```` fenced verbatim, blank-line separators, else paragraphs. Inline: `**bold**`/`__bold__`, `` `code` ``, and `[text](url)` rendered as **text only — the URL is discarded**, so there is no link scheme to validate (a bare URL stays visible but non-clickable).

### 3. "What's new" UI — `src/renderer/src/panels/SettingsPanel.tsx`
A `Disclosure` ("What's new in vX", collapsed by default, `key={version}`) in the `downloading`/`downloaded` states, above the actions row, with a muted `releaseName · date` line (name shown only when it adds over the version; date only when it parses — the one guarded renderer-side date parse) and a scrollable notes body. **Hidden entirely when the release has no notes** — the common case while the repo is private, so the fallback is pixel-identical to today's UI.

## Files touched
New: `src/renderer/src/lib/releaseNotes.tsx`, `tests/unit/releaseNotes.test.ts`. Changed: `src/main/updater.ts` (normalization + carry), `src/shared/ipc.ts` (DTO fields), `src/renderer/src/panels/SettingsPanel.tsx` ("What's new" block + header helper), `tests/unit/updater.test.ts` (release-notes assertions).

## Definition-of-Done — commands run
- `npm run typecheck` (node + web) → **clean**. `npm run lint` → **clean**. `npm run build` → **all 3 bundles**.
- Tests: `updater` (string / array-with-nulls / HTML-strip / over-cap-truncate / carried-across-transitions / dropped-on-up-to-date / malformed-omit) + `releaseNotes` (grammar + link-URL-discarded) → **32 passed**.
- No new deps, no new IPC channels, no CSP change, no appdata change. `DEFAULT == TODAY`: a release with no notes renders exactly the prior Updates UI.

## Shipping
Released as **v0.1.16** (version bump + `chore: release` + tag) — this release's own GitHub body is the first patch-notes payload the feature will render for users on the next update.
