# Agentic OS

A local-first Electron desktop app that is a **memory-and-tool backend for AI agents**. Claude (Claude Code or any MCP client) stays the orchestrator and does the work; Agentic OS serves relevant context on demand, learns from finished sessions, and runs background agents that get better over time — all on your machine, in one embedded graph store.

```
Claude (external orchestrator)
   │  MCP: reads/retrieval live · writes only via staged corrections
   ▼
MCP server (127.0.0.1:4517, bearer auth, every call logged)
   ▼
Kernel — scheduler · context manager · permissions · budget · audit/undo
   ▼
Background agents — extraction (session end) · skill improvement (nightly)
                    user rules · watchers
   ▼
Hybrid retrieval — vector + full-text + graph → cross-encoder rerank → loop
   ▼
RyuGraph (embedded: vector + graph + FTS) = the persistent memory
   ▼
Local models (Ollama: bge-m3 + qwen3) · in-process ONNX reranker
Cloud brain (bring-your-own key, optional)
```

Full design: [`docs/spec.md`](docs/spec.md). Build history: [`docs/PROGRESS.md`](docs/PROGRESS.md) and [`docs/progress/`](docs/progress/).

## What it does

- **Serves context over MCP** — `get_context` runs hybrid retrieval (vector top-30/label + FTS top-30 → weighted fusion → rerank → top-8) inside a bounded self-correcting loop and returns a token-budgeted bundle with a confidence flag. Six more tools: `search_memory`, `list_skills`, `get_skill`, `propose_correction`, `ingest_document`, `ingest_codebase`.
- **Learns from finished sessions** — a `SessionEnd` hook (or an MCP-inactivity fallback) fires the extraction agent: a deterministic pass over the server-side call log plus focused local-LLM passes over the transcript extract components, preferences, and explicit corrections into the graph, each stamped with provenance and confidence. Low-confidence items go to a human review queue, never silently into memory.
- **Improves its skills nightly** — skills that accrued new corrections get a cloud-rewritten candidate, benchmarked against the active version on a train/held-out split (skill-creator methodology). Verifiable skills auto-adopt only on net-positive-with-zero-regressions; stylistic skills always wait for one-click human approval. Every adoption is versioned, drift-watched, and reversible.
- **Runs your automations safely** — user rules (`~/.agentic-os/rules/*.rule.json`) watch files, URLs, or schedules; their code runs **only** in a Deno permission sandbox (or Docker for other languages) under the rule's declared capabilities, with side effects gated behind dashboard approvals.
- **Shows you everything** — a dashboard cockpit: memory browser, review queue, audit log with working undo, spend monitor, task/watcher manager, trace waterfall, skill analytics, ingestion, settings.

## Requirements

- **[Ollama](https://ollama.com/download)** with two models: `bge-m3` (embeddings) and `qwen3:4b` (small local LLM). The app detects a missing daemon or missing models at launch and the Settings panel offers the installer link and one-click pulls.
- **Disk**: the in-process reranker (int8 ONNX of bge-reranker-v2-m3, ~570 MB) downloads to the app's data directory on first retrieval, checksum-verified and resumable.
- **Optional — Docker**: only needed if you write rules in languages other than JS/TS (they run in a deny-by-default Linux container). The Docker daemon must be in Linux-containers mode.
- **Optional — a cloud API key** (Anthropic / OpenAI / Gemini / OpenRouter): powers fuzzy-extraction escalation, independent verification, and skill rewrites. Everything else works fully offline. Keys are stored via the OS keychain (`safeStorage`), never in plaintext; spend is metered with a $0.50-per-task ceiling and a live dashboard total.

## Install

### From an installer (recommended)

Grab the artifact for your OS from the CI `package` job (or a GitHub release): Windows NSIS `.exe`, macOS `.dmg`/`.zip` (arm64 + x64), Linux `.AppImage`/`.deb`. First launch creates the graph store, generates the MCP bearer token, and walks you through Ollama setup in Settings if it isn't running.

macOS builds are currently unsigned — right-click → Open on first launch.

### From source

```bash
npm ci
npm run rebuild:native   # REQUIRED on Windows (ryugraph Electron build, ~30-60 min first time);
                         # quick on macOS/Linux (better-sqlite3 dual-ABI stash)
npm run dev              # Electron app with HMR
```

> **Windows note:** the npm-prebuilt RyuGraph binding crashes Electron; `rebuild:native` replaces it with an Electron-safe source build (needs VS 2022 Build Tools C++) and stamps a marker the app checks at boot.

## Connect Claude Code

1. **MCP server** — Settings panel → "MCP connection" shows the exact command with your token (or set `AGENTIC_OS_PRINT_MCP_TOKEN=1` in dev):

   ```
   claude mcp add --transport http agentic-os http://127.0.0.1:4517/mcp --header "Authorization: Bearer <token>"
   ```

   A sample `.mcp.json` is also written into the app's data directory.

2. **Session-end hook** — Settings panel → "session-end hook" → *install hook*. This safely deep-merges a `SessionEnd` entry into `~/.claude/settings.json` (existing hooks preserved verbatim, backup written, diff shown). When a Claude Code session ends, the hook POSTs to the app so extraction can learn from the session; if the app isn't running, the payload spools to `~/.agentic-os/pending-sessions/` and drains on next launch — no session is lost.

3. **Cloud key (optional)** — Settings panel → provider + *set key*. **Restart the app afterwards** — background agents arm their cloud tier at launch.

## Updates & your data

- Auto-update is wired via `electron-updater` (GitHub releases feed). An update never risks your memory: the graph store carries a schema version, and **the whole graph directory is backed up before any migration runs** (`backups/<stamp>-pre-migration-v<N>/`). The app refuses to open a store *newer* than itself, and `appdata.db` is snapshotted before its own schema upgrades too.
- A weekly export job (Sunday 03:30) dumps the full graph to Neo4j-compatible CSV + Cypher under `exports/` — your memory is never trapped in the engine.

## Known limitations (v0.1.0)

- PDF/rich-document ingestion is deferred (markdown, text, and source files ingest fine).
- Adding a cloud API key requires an app restart to arm the background agents.
- Rules load at boot — add/edit a `.rule.json` and restart (the dashboard lists loaded rules and validation errors).
- `netDomains` capabilities are enforced in the Deno lane only; the Docker lane fails closed on any network request.
- The sanctioned way to roll back a skill adoption is the Skills panel's rollback (or auto-revert) — it keeps the improvement ledger and the graph in sync; the audit panel's generic undo reverses the graph only.
- macOS artifacts are unsigned; auto-update from a private repo requires the releases to be public.

## Development

```bash
npm run dev          # Electron app w/ HMR
npm test             # vitest unit + integration (offline, scripted models)
npm run test:e2e     # Playwright against the production build (incl. the golden-path release gate)
npm run lint && npm run typecheck
npm run rebuild:native   # better-sqlite3 dual-ABI + Windows ryugraph Electron build
npm run seed:demo    # seed a demo profile for the dashboard
npm run smoke:boot   # production-build boot smoke
npm run package      # electron-builder installers into dist/
```

Live-model test gates: `OLLAMA=1` (real bge-m3/qwen3), `RERANKER=1` (real ONNX reranker), `PERF=1` (10k-node retrieval benchmark) — run sequentially with `--no-file-parallelism`.

## License

MIT
