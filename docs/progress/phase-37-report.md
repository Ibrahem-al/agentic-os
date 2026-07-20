# Phase 37 — Phone / other-device access over the local network (opt-in)

**Status:** done · **Date:** 2026-07-20 · User-directed ("connecting the phone is not working well … connect their phone to allow the user to connect their phone and continue work from there"). §21 rule 12 deviation (recorded below).

## Why "connecting the phone" didn't work
The MCP server binds `127.0.0.1` (the §21.7 localhost-only default), so nothing off the machine — a phone on the same Wi-Fi included — can ever reach it. There was no LAN feature to fix; there was no LAN feature at all. This adds one, **default OFF** and consent-gated, so a user who wants to continue their work from a phone can opt in.

## What was built
A single toggle in **Settings → Claude connection** — "Let a phone or other device on my network connect" — that, when enabled, binds the MCP server to the LAN and shows the address to point a device at.

- **Setting (`src/main/models/settings.ts`).** New `NetworkSettings { lanAccess: boolean }`, `settings.network?`, `defaultNetworkSettings()` (`{ lanAccess: false }` — the secure default), and a loud `parseNetwork` validator. Absent on disk → absent after load (`DEFAULT == TODAY`); an empty `{}` normalizes to `lanAccess:false`. Re-exported from the `./models` barrel (`defaultNetworkSettings` + type `NetworkSettings`).
- **Boot bind (`src/main/index.ts`).** `bootMcp` reads `network.lanAccess` and passes `host: '0.0.0.0'` to the server **only** when enabled (the server already accepts `deps.host`). `lanIpv4()` finds the first non-internal IPv4; `mcpLanUrl()` returns `http://<lan-ip>:<port>/mcp` only when the server is actually LAN-bound this launch, else null. A LAN bind logs the reachable URL (bearer-auth reminder). Read at boot → a toggle takes effect on the **next launch** (the card says so).
- **DTO (`src/main/ipc.ts`, `src/main/reads/status.ts` + `types.ts`, `src/shared/ipc.ts`).** `SettingsDto.mcp` gains `lanAccess` (the toggle STATE) and `lanUrl` (the actual LAN address, null until a restart binds it). **Key design point:** `lanAccess` is sourced from **persisted settings** (`getSettingsSummary` now surfaces `network`), NOT from the boot-time dep — so flipping the toggle and `applyDto(fresh)` keeps the checkbox on immediately instead of snapping back until the restart. `lanUrl` stays boot-derived (the real binding). The `ModelSettingsPatchDto.network` merge in `settings.save` follows the reasoning/runner precedent (explicit-field rebuild would otherwise drop it; an omitted patch preserves the on-disk section).
- **UI (`src/renderer/src/panels/SettingsPanel.tsx`).** A `Toggle` bound to `dto.mcp.lanAccess`, gated on **enable** behind a consent `Modal` (an "I understand this opens access to my local network" checkbox gating the "Allow" button — the exact sensitive-egress consent pattern); **disable** revokes immediately. When on and bound, a copyable LAN URL + "use the same token as above" + a warning that anyone on the network with the token can reach memory/tools; when on but not yet bound, "Restart the app to start listening on your network."

## §21 rule-12 deviation (recorded)
Rule 7 says user/rule code and the server stay localhost-only. This keeps **127.0.0.1 the default**; the `0.0.0.0` bind happens **only** after an explicit, consent-gated opt-in, is still behind the timing-safe bearer token, and the UI states the exposure plainly. The user's request — continue work from a phone — is unachievable without it.

## Files touched
`src/main/models/settings.ts` + `src/main/models/index.ts` (network setting + validator + barrel), `src/main/index.ts` (host bind, `lanIpv4`/`mcpLanUrl`), `src/main/ipc.ts` (`mcpLanUrl` dep, `lanAccess`/`lanUrl` DTO, `network` merge in `settings.save`), `src/main/reads/status.ts` + `src/main/reads/types.ts` (surface `network` in the summary), `src/shared/ipc.ts` (DTO + patch types), `src/renderer/src/panels/SettingsPanel.tsx` (toggle + consent modal + LAN-URL card). Tests: `tests/unit/models.settings.test.ts` (network roundtrip/normalize/reject), `tests/integration/ipc.settings.test.ts` (save persists + DTO state reflects immediately + preserve-across-omit + never-materialized-on-default).

## Definition-of-Done — commands run
- `npm run typecheck` (node + web) → **clean**. `npm run lint` → **clean**. `npm test` → green (the two load-flakes, `retrieval.latency` + `runner.completion` timing, pass in isolation and are unrelated). Settings unit + ipc integration: **31 passed**.
- No new deps. No appdata change (settings.json is plain JSON). `DEFAULT == TODAY`: a fresh install has no `network` section and stays localhost-only.
