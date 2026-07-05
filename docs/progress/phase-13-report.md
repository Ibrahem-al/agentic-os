# Phase 13 report — Scheduler hardening, packaging, full E2E (v0.1.0)

**Status:** done · **Date:** 2026-07-05

## What was built

Phase 13 hardened the scheduler per §8, wired `electron-updater`/`electron-builder` with the §21.9 migrations-with-backup proof on the real packaged app, shipped the golden-path E2E as the release gate, benchmarked retrieval on a 10k-node graph, wrote the README, polished the dashboard, and — because this phase pushed the repo to GitHub and ran CI for the **first time in the project's history** — found and fixed a set of pre-existing, environment-conditional defects that no dev machine had ever surfaced, including two genuine upstream RyuGraph faults.

### The repo went public-side (private GitHub + first-ever CI)

`gh repo create Ibrahem-al/agentic-os --private` + push (user-approved; the user refreshed the `workflow` OAuth scope so `.github/workflows/` could land). The first CI run (phase-12 code, untouched) failed on ubuntu and windows — every failure pre-existing and invisible until real runner hardware executed the suite:

1. **Vector distances of exactly 1** (`agents.skillimprove` adopt on ubuntu 2/2 attempts + windows 1/2; `agents.extraction` project-embedding on windows 1/2; macOS arm64 always green; no dev machine reproduces it) — see "the RyuGraph vector story" below.
2. **Docker conformance on windows-latest**: GitHub's Windows runners run *Windows containers*; the lane passed `--read-only`/alpine flags to a daemon that can never honor them.
3. **Docker conformance on ubuntu-latest**: `write inside fsWrite … path not reachable in this container` — a real lane defect (below).
4. **`ingest.codebase` re-ingest `created: 2` vs `1` on windows-latest**: CRLF checkout. GitHub's runners use `core.autocrlf=true`; `tests/fixtures/mini-repo/` had no eol pin, so unit content hashes were computed over CRLF bytes and the test's LF rewrite of one file also moved a second unit's hash. Mechanism reproduced locally by CRLF-ifying the fixture (exact CI failure), fixed with a `.gitattributes` `eol=lf` pin (index was already all-LF — checkout-behavior-only change). All other byte-sensitive fixtures audited: already pinned or built from code.
5. **The phase-00 "offline storage check"** ran the *whole* integration suite under per-OS network denial — legitimate localhost servers (MCP HTTP, session-end hook, sandbox probes) exist since phase 05 and fail by design. Scoped to `tests/integration/storage.*` — which restores the check's §21.2 meaning (vector+FTS load offline).

### The RyuGraph vector story (two upstream faults, root-caused and neutralized)

The headline CI failure was an investigation odyssey, run as a dedicated agent with probe scripts against both binaries and Docker:

- **The "prebuilt vs source-build" theory was disproven.** The npm prebuilt passes the exact failing tests on the dev machine (binary swap), in Docker (glibc 2.41), on every probe scenario (insert-after-index, bulk-then-index, the drop→SET→recreate dance, all checkpoint placements, thread counts 1/2/4/20). The failures are **runner-hardware-conditional**: ubuntu failed identically on two fresh VMs; windows failed attempt 1 and passed attempt 2 (GitHub's fleet is a heterogeneous Xeon/EPYC mix); arm64 macOS never fails.
- **Fault #1 — NAPI list binding** (`ryu-source/tools/nodejs_api/src_cpp/node_util.cpp` `TransformNapiValue`): a JS array parameter's list type is inferred from **element[0] only**. A vector whose first element is integral (0 is common in the test fakes' bag-of-words embeddings) binds as `LIST[INT64]`, and every fractional element's float64 bits are **reinterpreted as int64** (~4.6e18) before the `CAST` — silent stored-vector corruption. Proven mechanism: a stored dim read back as `4598322828981305344` == the bit pattern of `fround(0.258199)` exactly.
- **Why it looked hardware-conditional**: write and query mangle self-consistently, so most tests still measured distance 0 — *until* the corrupted ~4.6e18 magnitudes overflow float32 cosine accumulation, which only happens with enough non-zero elements (longer texts), and whose result depends on which SimSIMD kernel the CPU dispatches (f64-accumulating kernels stay finite; f32 paths overflow → the `ab == 0`/NaN guard → distance exactly 1). Real bge-m3 embeddings (dim0 essentially never integral, magnitudes ≤ 1) were never affected — **but the §21-relevant point is that the graph was storing corrupted vectors for any embedding starting with an integral value.**
- **The lossless fix (ours, engine-level)**: embeddings are **never bound as parameters** anymore. `embeddingLiteral()` inlines every vector into the Cypher text with forced decimal points (guaranteed `DOUBLE` parsing — numeric promotion at the parser is value-preserving, unlike the NAPI bit-reinterpretation): `upsertNode` creates, the re-embed dance, `vectorSearch`, and the new `indexServes` all use it. `encodeParams` now **refuses** the poison combination (integral first element + fractional elements) for raw `cypher()` callers instead of silently corrupting. Perf cost: unmeasurable against the 10k-graph benchmark (statement parse of ~20 KB literals).
- **Fault #2 — index-serves-zeros (defense in depth)**: because the overflow fingerprint was environment-conditional and the upstream scan-state code has an independently suspicious buffer-recycling path, `rebuildEmbedding` now **self-verifies** after every re-embed (exact-match `QUERY_VECTOR_INDEX`, float32 tolerance), heals once (CHECKPOINT + fresh index rebuild), and on a second miss **fails the lane job loudly** — a silently broken index would degrade every retrieval until the next rebuild (§21). On healthy environments this costs one k=4 query per re-embed (rare: skill adoption/rollback).
- **Diagnostics kept**: `scripts/diag/ryu-vector-probe.mjs` (10 scenarios × both connections, CPU-model banner) runs as a **non-gating** CI step on every OS — permanent evidence for the upstream issue and a regression tripwire. Upstream filing vs predictable-labs/ryugraph is the recorded follow-up; `npm view ryugraph versions` shows 25.9.1 is the latest (nothing newer to consent to; the §20 pin stands).

### Docker lane — real product defect fixed

`detectDocker()` now checks the daemon's `Server.Os`: a Windows-containers daemon reports unavailable with switch-to-Linux guidance (conformance tests skip with that message; boot line + rule runner inherit it). The ubuntu failure was a genuine lane bug: the container ran as root but `--cap-drop ALL` removes `CAP_DAC_OVERRIDE`, and a **native** Linux daemon's bind mounts expose real host ownership — so root-in-container could not create files in an `fsWrite` mount owned by the non-root runner user (Docker Desktop's file-sharing layer masked this on every dev machine). The lane now runs containers as the **host uid:gid** on POSIX (`dockerHostUserArgs`), making in-container permissions agree exactly with what the host user may do — never more. Rootless-daemon caveat recorded in the function doc. Conformance suite: 22/22 locally (18 original + 4 new environment pins).

### Scheduler policy (§8, build item 1)

- **Priority classes** — numeric bands on the existing `tasks.priority` mirror column (no schema change, durable across restarts): `TASK_CLASS_BAND = { user: 1000, background: 0 }`; enqueue priority = band + kind priority. The dashboard's "improve now" rides the user band; all autonomous work stays background with phase-11's relative order intact. **Aging is capped** at `TASK_AGING_MAX_BONUS = 500` — below the band width, so a background task can never out-rank a user-initiated one, while within-class aging still prevents starvation. The "live" class is not a queue construct: live MCP work is the yield gate.
- **Cooperative yield at step boundaries** — `LangGraphRunner` accepts a `yieldPoint`; every step awaits it *before* running (after the previous step's checkpoint is durable — provably cannot corrupt or reorder checkpoints; `run()` and `resume()` share the node closures). Boot wires `createInflightYield(() => mcpServer.inflightCalls)` with the queue's own recheck/cap constants (1 s / 60 s) — a long extraction or benchmark now defers to a live MCP call between steps, and only between steps (§8 "no mid-generation preemption").
- **Cloud single lane + provider rate limits** — every `CloudBrain.complete` rides one module-level FIFO lane (at most one cloud HTTP call in flight process-wide), with per-provider start-to-start spacing (`CLOUD_LANE_MIN_INTERVAL_MS = 250`, rule 12) and in-lane HTTP-429 handling: Retry-After honored (seconds or HTTP-date, capped 60 s), default 2 s, up to 2 retries **while holding the lane** so parallel callers can't stampede a rate-limited provider. Non-429 errors unchanged (the §20 task queue owns coarse retries).
- **Local pool** — `OllamaClient.embed/generate` ride a counting semaphore (`LOCAL_POOL_CONCURRENCY = 4`); `status()` deliberately bypasses (dashboard responsiveness), `pull()` too (a model download must neither starve nor be starved).
- **Task-row retention** (phase-11/12 nominated) — the nightly prune now also sweeps done/failed task rows older than 14 days (`TASK_ROW_RETENTION_DAYS`, matches transcript retention) **except** extraction rows and `extract-*` workflow rows (the §6 exactly-once dedup tokens — sweeping them would allow re-extraction), plus the checkpoints of finished workflow jobs (the real disk weight; done jobs never resume). Deliberately not audited: appdata queue bookkeeping, like spend rows (recorded).

### Updates, migrations, packaging (build item 2)

- **electron-updater 6.8.9** — `bootUpdater()`: dev builds log-and-skip; packaged builds set autoDownload + autoInstallOnAppQuit, log-only listeners, `checkForUpdatesAndNotify()` that can never take boot down. Feed = GitHub releases (config in electron-builder.yml); honest caveat: while the repo is private the check logs an auth error harmlessly — releases going public arms it with zero code change.
- **The §21.9 proof runs on the real packaged app**: `AGENTIC_OS_TEST_MIGRATION_V2=1` (recorded rule-12 seam, read at engine-open time) appends a v1000 probe migration to the registry. `scripts/smoke/packaged-smoke.mjs` launches the **packaged exe** twice: fresh boot (schema v1) → quit → relaunch with the env ("the update") → asserts the boot log's `pre-migration backup:` note, `schema v1000`, and the `backups/<stamp>-pre-migration-v1000/` dir on disk. **PASS on the real NSIS-unpacked build.**
- **Storage hardening while there**: the graph store now **refuses to open** a store whose SchemaVersion is newer than the build (two layers: sidecar pre-open + authoritative in-graph check; previously it silently ran and even rewrote the sidecar) — mirroring appdata's guard; and `appdata.db` gets its own pre-upgrade snapshot (`VACUUM INTO backups/<stamp>-pre-appdata-v<N>/appdata.db`) — the §21.9 spirit applied to the second database.
- **electron-builder 26.15.3** (`electron-builder.yml`): appId `dev.agentic-os.desktop`; `npmRebuild: false` (the repo's `rebuild:native` owns natives — builder must never touch them); asar with native modules + tree-sitter/web-tree-sitter unpacked; `extraResources` ship the vendored RyuGraph extensions (native code loads them by absolute path — `process.resourcesPath/extensions/…` when packaged) and the hook scripts (`…/hooks` — an external shell must execute them); heavy dead weight excluded (ryugraph `ryu-source/` 404 MB, `prebuilt/` 93 MB, better-sqlite3 intermediates, other-platform onnx binaries). Targets: win NSIS (per-user), mac dmg+zip (arm64 + x64, unsigned — recorded), linux AppImage+deb. Win-unpacked total 580 MB (asar 71 MB, unpacked natives 120 MB, Electron shell ~355 MB).
- **`scripts/build/before-pack.cjs`**: refuses to pack on win32 unless `ryujs.node` is the Electron-safe build (marker version match **and byte-difference from both npm prebuilt copies**) and the target platform's vendored extensions exist.
- **A packaging landmine found live**: any `npm install` re-runs ryugraph's install script and **silently clobbers** the Electron-safe `ryujs.node` back to the npm prebuilt while the stale marker still says "safe" — the packaged/dev app then hard-crashes Electron. `rebuild-ryugraph-electron.cjs` now byte-compares against the prebuilts even when the marker matches, restores from the incremental build tree when possible, and rebuilds otherwise; the before-pack gate catches it at pack time as defense in depth.
- Boot smoke committed as real source at last (`scripts/smoke/boot-smoke.mjs`, cross-platform; it had only ever existed as an untracked `out/` artifact).

### Golden-path E2E — the release gate (build item 3)

`tests/e2e/golden-path.spec.ts`: 8 serial arrow-named tests against the **production build** under Playwright's Electron driver, with **scripted models over HTTP** — `tests/fixtures/fake-model-server.ts` impersonates both tiers on one `node:http` server (Ollama `/api/tags`, `/api/embed` = the deterministic bag-of-words embedding, `/api/generate` dispatched on the production marker prompts; OpenAI `/v1/chat/completions` for the cloud tier), driven through the phase-13 env seams: `AGENTIC_OS_OLLAMA_BASE_URL`, `AGENTIC_OS_CLOUD_BASE_URL`, `AGENTIC_OS_RERANKER_FILES` (a tiny real-ONNX + real-tokenizer fixture with true sha256 pins — the production Reranker runs the real onnxruntime session with zero downloads), `AGENTIC_OS_PRINT_MCP_TOKEN` / `AGENTIC_OS_PRINT_HOOK_TOKEN` (stdout token capture), `AGENTIC_OS_LINUX_PASSWORD_STORE` (CI keystore). The flow, state asserted at every arrow:

fresh profile (Skill 1 / Session 0 / Component 0 chips) → `ingest_codebase` over a real MCP SDK client (≥12 Components, chip appears) → `get_context` (a Component in the bundle, `haltReason=passed`, confidence high) → `get_skill` (the USED backbone) → transcript with an explicit correction + preference, `POST /hooks/session-end` (200, `extract-<sid>`) → extraction populates memory (Session 1; committed Preference with `extraction@0.0.1/llm-local` provenance in the inspector; committed Correction; **exactly one** low-confidence item staged) → staged write approved in the review queue (diff shown → toast → statement in the memory browser) → **audited file write undone** (byte-compare of the restored file on disk) → API key set through the settings panel → relaunch (memory survives; `[agents] … cloud tier: openai` — the restart-to-arm flow the README documents) → skill flipped to `verifiable`, "improve now" → the skill job runs testset(cloud)→candidate(cloud)→benchmark(local ×3)→adopt → ledger `adopted` badge, instructions carry the candidate marker → a fresh MCP client's `get_skill` serves the **learned** version. The learning loop, closed over the same protocol Claude uses.

18 fixture unit tests pin every fake-server marker/reply against the production constants and parsers (drift in either direction fails `npm test`). Local: 8 passed in 44.8 s (build included), re-run 30.6 s, zero flakes.

### Perf sanity (build item 4)

`tests/fixtures/perf-seed.ts` + `tests/integration/retrieval.perf.test.ts` (env-gated `PERF=1`; a dedicated CI step runs it on ubuntu): a deterministic 10,000-node / 17,027-edge graph across all 13 labels / 15 edge types (4,000 Knowledge / 1,500 Preference / 2,500 Component / …), seeded in one write-lane job (batched multi-pattern CREATEs + UNWIND edges, ~112 s), methodology identical to the phase-03 benchmark (sub-ms model fakes, 3 warmups, 30 measured passes over 5 rotating queries).

**Numbers (this machine):** see Verification below — `retrieve()` p50 ≈ 368 ms / p95 ≈ 399 ms under concurrent load, comfortably under the 500 ms assertion (the phase-03 48-node baseline was 117 ms — the pipeline's graph-size sensitivity is sub-linear thanks to the fused-candidate caps). Deviations: none needed — the pre-identified levers (prepared-statement caching, expansion overlap) stay untouched and recorded as future headroom.

### Dashboard polish + README (build item 5)

- Modal **focus trap** (the phase-10 P2 explicitly deferred here): Tab/Shift-Tab cycle inside every kit modal, focus returns to the opener on close (WCAG 2.4.3). **Arrow-key row navigation** in all DataTables (the other P2). Rail-level **drift badge** (phase-12's "cheap visibility win"): `skills.driftSummary` channel (open, un-reverted flags) → warn-token pill on the skills nav entry. Dead `appVersion` preload field removed (it would have reported 0.0.1 forever in packaged builds; the footer uses `app.status`). Audit checklist re-verified (aria labels, focus-visible, reduced-motion, empty/error states, no console noise); the subsystem footer kept per its phase-10 mandate. 28 px dense targets remain recorded as-is (declared mouse/keyboard cockpit).
- `README.md`: what it is, architecture sketch, requirements (Ollama + models, optional Docker with the Linux-containers caveat, optional cloud key with the restart-to-arm note), installer + from-source setup (the Windows `rebuild:native` reality), connecting Claude Code (`claude mcp add …` + hook install + spool semantics), updates & data safety (§21.9 story), known v0.1.0 limitations, dev commands.

### CI (rewritten workflow)

`test` (3 OS × lint/typecheck/full suite + the scoped offline storage checks + the vector probe + the ubuntu PERF step + the Electron-ABI/keychain checks) · `e2e-linux` (every push: xvfb + `AGENTIC_OS_LINUX_PASSWORD_STORE=basic`, the full Playwright run incl. the golden path) · `e2e-macos` (main/tags/dispatch — the 10× private-repo minute multiplier is why) · `package` (tags/dispatch: 3-OS installers as artifacts, `CSC_IDENTITY_AUTO_DISCOVERY=false`, the Windows ryugraph Electron build cached by ryugraph+Electron version so only the first tag pays the ~30-60 min MSVC build). Windows e2e is deliberately not in CI (the ryugraph source build makes it uneconomical; dev machines + the local golden path cover it — recorded).

## Definition of Done — outcomes

1. **Golden-path E2E green in CI on at least two OSes** — PASS: run 28736044125 (full-matrix dispatch on the phase branch, then re-proven on main) — `e2e-linux: success` and `e2e-macos: success`, each running all four specs including the 8-arrow golden path against the production build on scripted models (plus Windows green locally, 11 passed). The same run's `test` jobs are green on all three OSes and its `package` jobs uploaded the three installer artifact sets (windows 145 MB, ubuntu 694 MB, macos 707 MB).
2. **Installer boots; guided Ollama setup appears** — PASS, with the recorded deviation that no clean VM was available (user-approved plan): the NSIS installer (`agentic-os-0.1.0-win-x64.exe`, 146 MB) was silently installed per-user on this machine; `scripts/smoke/packaged-smoke.mjs` against the INSTALLED exe passed both launches (fresh boot with every subsystem line + `[models] ollama not detected` on a hermetic dead port; then the §21.9 update path: `AGENTIC_OS_TEST_MIGRATION_V2=1` relaunch → `schema v1000` + `pre-migration backup:` line + the `backups/<stamp>-pre-migration-v1000/` dir on disk); a Playwright drive of the installed app then proved the guided setup RENDERS (settings panel: `daemon-not-running` badge + `https://ollama.com/download` + one-click pulls — screenshot at `docs/progress/assets/phase-13/installed-guided-ollama-setup.png`, footer showing v0.1.0 and all subsystem dots up); silent uninstall afterwards. The same job definition builds the mac/linux artifacts in CI on tags.
3. **Perf numbers + deviations recorded** — see Verification; no deviations needed (p50 well under the line without touching the recorded levers).

## Verification (this machine unless noted)

```
npm run lint          clean
npm run typecheck     clean (tsconfig.node + tsconfig.web)
npm run build         clean (electron-vite production build)
npm test              Test Files 65 passed | 4 skipped (69) · Tests 618 passed | 12 skipped (630)  [exit 0]
                      (630 = phase-12's 573 + 57 new)
ELECTRON_RUN_AS_NODE  Test Files 24 passed | 4 skipped (28) · Tests 228 passed | 12 skipped (240)  [exit 0]
  (tests/integration under Electron runtime; first attempt hit the known
   forks-teardown flake post-report — clean rerun reported everything)
npx playwright test   11 passed, 1 env-gated skip [exit 0, 1.7 m] — dashboard review/audit/ingest
                      (ingest on real bge-m3) + ALL 8 golden-path arrows on scripted models
PERF=1 (10k graph)    retrieve(): p50 = 358.1 ms · p95 = 387.8 ms  (n=30, 5 queries × 6)   < 500 ✓
                      singlePass: p50 = 358.9 ms · p95 = 393.5 ms  (n=30)
                      10,000 nodes / 17,027 edges, seed 114.3 s, index sanity distance 1.07e-14
                      (phase-03 48-node baseline: 117 ms → 143 ms with the binding fix; the
                       fixture-graph latency pin stays green)
npm run smoke:boot    PASS [exit 0] — all subsystem lines incl. the new [updater] line; seeded
                      spool file drained → extraction task done during the smoke
npm run smoke:packaged (vs the INSTALLED app) PASS [exit 0] — launch 1 full boot + guided-Ollama
                      line; launch 2 = the §21.9 update-path proof (v1000 + pre-migration backup)
CI                    the workflow's first green in project history. Iterated on branch
                      ci-phase-13 (6 runs — each red exposed a genuine cross-platform bug,
                      catalogued in findings 15-18 and the RyuGraph story); final full-matrix
                      dispatch run 28736044125: ALL 8 JOBS GREEN —
                        test (ubuntu / macos / windows): success (incl. offline storage
                          checks, the ubuntu PERF step at p50 180-193 ms/query, Electron-ABI
                          suites, windows keychain/native checks)
                        e2e-linux: success · e2e-macos: success  (golden path incl.)
                        package (ubuntu / macos / windows): success — installer artifacts
                          uploaded (145 MB win NSIS · 694 MB AppImage+deb · 707 MB dmg+zip
                          arm64+x64); the windows leg built ryugraph from source under MSVC
                          on the runner and cached it for future tags
                      then squash-merged to main (this commit) and tagged v0.1.0.
```

## Key decisions & findings (recorded)

1. **Embeddings are inlined as Cypher literals, never bound as parameters** — the lossless neutralization of the ryugraph 25.9.1 NAPI list-binding fault (element[0]-based type inference + int64 bit-reinterpretation of fractional elements). `encodeParams` refuses the poison pattern for raw callers. Filing upstream is the follow-up; the §20 pin stands (25.9.1 is the latest release).
2. **Re-embeds self-verify and fail loudly** — checkpoint+rebuild heals once; a second miss throws rather than leaving a silently broken index (§21). The non-gating CI probe keeps collecting hardware evidence.
3. **Priority classes are numeric bands with capped aging**, not a schema change — durable, and phase-11's within-background ordering (ruleAction 20 > extraction/ingest 10 > watchScan 5 > maintenance 0) is preserved exactly. Only manual "improve now" rides the user band today; the mapping is one constant away for future user-initiated kinds.
4. **The retention sweep never touches §6 exactly-once tokens** (extraction task rows, `extract-*` workflow rows); checkpoints of done workflow jobs are always sweepable (resume() no-ops on done). The sweep is deliberately un-audited appdata bookkeeping (recorded deviation from "audit everything": §13's discipline covers the graph + files).
5. **The update-path proof is an env-gated probe migration (v1000), not a fake production migration** — the real registry stays honest ([v1]); the packaged smoke exercises the full §21.9 machinery (sidecar → pre-open backup → ordered migration → SchemaVersion) through the production boot path on the real packaged exe.
6. **Graph downgrade = refusal** (new guard, two layers) — an update that is actually a rollback can no longer corrupt accumulated memory; appdata.db now gets a pre-upgrade `VACUUM INTO` snapshot as well.
7. **Docker containers run as the host uid on POSIX** — the CAP_DAC_OVERRIDE/bind-mount finding means root-in-container was both too weak (couldn't write user-owned mounts on native daemons) and conceptually too strong; matching the host user makes DAC agree exactly with the §13 capability grant. Windows-containers daemons are detected and guided.
8. **`npm install` clobbers the win32 Electron-safe ryugraph binary** (its install script re-copies the prebuilt, stale marker intact) — now self-healed by `rebuild:native` (byte-compare + restore) and hard-gated by before-pack. This bit us live twice during the phase.
9. **The fake-model-server markers are unit-pinned against production constants and parsers** — the golden path cannot silently drift from the real prompts/formats; either side moving fails `npm test`.
10. **CI minute economics shaped the workflow** (private repo: macOS 10×, Windows 2×): macOS e2e on main/tags only; the package job on tags/dispatch only; Windows e2e delegated to dev machines. Recorded as policy, not accident.
11. **mac x64 caveat**: onnxruntime-node 1.27.0 ships no darwin-x64 binary — the mac-x64 artifact builds but its reranker cannot load (README known-limitations note; the phase doc's target list is honored, the limitation is upstream's).
12. **Provenance versions stay `@0.0.1`** while the app ships 0.1.0 — they version the extractor/ingester pipeline implementations (unchanged this phase), not the product; changing them would churn every provenance-pinning test for zero information. `MCP_SERVER_VERSION` did bump to 0.1.0 (handshake identity).
13. **Driver fault while testing the backup**: content-reading live RyuGraph store files from a test process makes the next same-process open die natively (same family as the one-store-per-file rule) — the update-path test asserts byte-untouchedness via metadata + sidecar bytes only (recorded in-code).
14. **npm audit**: 3 pre-existing high-severity findings, all dev-only transitive via the pinned electron-vite/vite toolchain (phase-02 note). Re-audited: unchanged, accepted risk for v0.1.0 within the §20 pins (a toolchain bump is off-spec).
15. **First-Linux-run archaeology** (bugs that only real runners could surface, each fixed + pinned): (a) the seed CLIs' `isMain` guard hand-built `file:///${argv[1]}` — POSIX absolute paths yield `file:////…`, the comparison never matches, and the seed exits 0 with empty stdout (the e2e seeds had NEVER worked on Linux); `pathToFileURL` now. (b) `console.log` + `process.exit(0)` drops async-buffered pipe output on Linux (Windows pipe writes are sync) — the seeds' JSON result now goes out via `writeSync(1, …)`. (c) A `(getuid = process.getuid)`-style default parameter cannot be tested by passing explicit `undefined` — the default resolves anyway (the `--user` pin returned the runner's real uid).
16. **Each ryugraph `Database` reserves ~8 TiB of virtual address space** — ten sequential opens in one process exhausted the runners' mmap budget (`Mmap for size 8796093022208 failed`); the diagnostic probe now runs all scenarios in ONE database with per-scenario tables. Worth knowing for any future multi-store tooling.
17. **Quit-speed vs safeStorage**: WM_CLOSE-ing the whole Electron process TREE (taskkill /T) makes the browser process exit before flushing `Local State` (the Chromium os_crypt key) — the next launch cannot decrypt `keychain.bin`. The packaged smoke closes only the root (will-quit runs, key flushes) and instead reaps port-holding stragglers before the next launch. The golden path's UI-driven relaunch proves the normal quit path round-trips keys correctly.
18. **The vitest exit-code flake is now filtered, narrowly**: the documented ryugraph forks-teardown fault kills a worker AFTER its files report (zero test failures, exit 1). `onUnhandledError` in vitest.config.ts suppresses exactly `Worker (forks emitted error|exited unexpectedly)` — every other unhandled error still fails the run. On CI this flake had a ~100% hit rate across enough workers to make `npm test` red on every OS eventually; the filter makes the signal the TESTS again.

## Deferred / recorded out-of-scope (the consolidated phase-11/12 backlog)

- **Rules live-reload** (boot-only loading stands; dashboard shows rules + errors) — recorded out-of-scope (phase-11 "nicety").
- **Per-skill failure backoff** for permanently failing rewrites — spend stays bounded by the $0.50 ceiling; out-of-scope (phase-12 decision 10).
- **Ledger sync on audit-panel undo of adoptions** — `rollbackSkillAdoption` remains the sanctioned path; README documents the caveat (phase-12 decision 11).
- **Failure-example accumulation (§6 item 1)** — still unowned by any phase doc; the gate/rewriter consume Examples when something creates them. Ships as a recorded v0.1.0 spec-vs-phases gap.
- **Cloud reranker toggle** (§4 optional) — silently dropped between phases 02 and 10; recorded here explicitly as not built.
- **Live re-arm of the cloud tier on key entry** — restart-to-arm stands, documented in README and exercised by the golden path.
- **Prepared-statement caching / expansion overlap** — the 10k benchmark passes without them; they remain the recorded perf levers.
- **Watched-folder live re-watch** on config change (scan-now works immediately) — out-of-scope.
- Upstream ryugraph issue filing (both faults, with `scripts/diag/ryu-vector-probe.mjs` as the repro) — the one true follow-up this phase creates.

## Instructions for whoever comes next

- **Releasing**: bump `package.json`, tag `vX.Y.Z`, push — CI builds the three installers as artifacts and (once releases are published) electron-updater picks them up. The Windows package job's first tag run pays the ryugraph MSVC build; the cache makes later tags cheap.
- **After any `npm install` on Windows**: run `npm run rebuild:native` (seconds on a warm tree) — or trust before-pack/boot to catch the clobber.
- **The golden path is the release gate**: `npm run test:e2e` locally, `e2e-linux`/`e2e-macos` in CI. If it reds on an arrow, the failure names the arrow; the fake-server request log + unmatched markers + app stdout print on failure.
- **If the CI vector probe ever prints a non-zero distance**, that's the upstream fault reproducing on that runner pool — the engine's self-verify/heal/fail-loud path is the safety net; grab the probe output for the upstream issue.
- The `skills.driftSummary` channel + rail badge exist; the skills panel remains the per-skill drill-down.
