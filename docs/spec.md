# Agentic OS — System Specification (v4 · Handoff Edition)

**Variant:** single-app · embedded · local-first · self-hosted (technical users)
**Status:** **build-ready handoff.** This document is the single source of truth for the implementing agent. Defaults are in §20, hard rules in §21, repo layout in §22, build phases in §23 + `docs/phases/`. Anything under "Optional / deferred" must NOT be built.

---

## 0. How to read this spec (implementing agent)

- The **body is authoritative**. There is no changelog; superseded decisions have been removed.
- `§n` cross-references point inside this file. Concrete values (ports, thresholds, model names, timings) live in the **§20 Defaults table** — never invent a value that exists there.
- **§21 Hard rules** override convenience. If two passages seem to conflict, the more specific section wins; record the interpretation in your phase report.
- Work is split into phases (`docs/phases/phase-NN-*.md`). Build only your assigned phase.

---

## 1. Context and constraints

A single **Electron desktop app** that runs entirely on the user's machine with no required cloud infrastructure. The app is published as source for technical users to download and run.

- One installable app. No *cloud* servers; the only required local dependency is **Ollama** (local models — a local daemon, not a networked service). The default code-execution sandbox is **Deno**, a single binary the app fetches and manages (no daemon). **Docker is optional**: required only when a user rule declares a non-JS/TS language (§11), with detect-and-guide setup like Ollama's.
- No persistent cloud resources owned by the developer.
- The Electron app is primarily the **tracking dashboard + scheduling UI** (panels in §3); the heavy lifting is the in-process backend.

**Architecture rule:** every persistence and search capability is *embedded, in-process* inside the one app — never a networked service. The only local daemons are Ollama (required) and Docker (optional, §11).

---

## 2. Core retrieval principles

- **Three-way hybrid retrieval:** semantic (vector) + structural (graph) + lexical (keyword), fused, then reranked.
- **Self-correcting loop:** generate → evaluate → (pass? return : rewrite query and retry). *(Bounded — see §15.)*
- **BGE-M3** as the only embedding model, everywhere (1024-dim).

---

## 3. Runtime — Electron desktop

A real Node.js backend runs in-process: background processes, filesystem access, ability to embed databases and spawn local services.

**Dashboard (v1 panels):** memory browser (explore the graph), review queue (approve/reject staged writes + skill adoptions), audit/undo log, spend monitor, scheduled-tasks/watchers manager, trace/observability viewer (native panel over the local SQLite trace store), an ingestion panel (file/folder pick for knowledge + codebase ingestion, §18), and skill-performance analytics. The review queue and watcher manager aren't optional polish — the staged-write and skill-adoption gates are unusable without them.

**Updates & migration:** app auto-update via `electron-updater`; the store carries a `schema_version` with ordered migration scripts run on launch, and the graph is **backed up before any migration** so an update can never corrupt accumulated memory.

---

## 4. Intelligence — Claude orchestrates; the OS serves and learns

**The orchestrator is external.** Claude (Claude Code or any MCP client) connects to the OS over MCP and performs the *user's* tasks (the OS itself is never the thing being built by this orchestrator at runtime). The OS does **not** run an autonomous internal brain. Its jobs are: (a) serve relevant context on demand, and (b) run background agents that learn from finished sessions.

**Local tier (always on):** **Ollama** serves BGE-M3 embeddings and a small LLM for routing, cheap evaluation, and the cheap parts of extraction. The **reranker runs in-process** — bge-reranker-v2-m3 as a quantized ONNX cross-encoder via `onnxruntime-node` (Ollama exposes no rerank endpoint; its embed API returns embeddings, not the classification-head relevance scores a cross-encoder produces, so it would silently mis-rank). Lazy-loaded with an idle-unload timer (~300–600MB while resident). Free, private, offline. **Setup:** on launch the app detects Ollama; if missing it links the installer and offers a one-click pull of the required models (no silent bundling).

**Cloud reasoning tier (provider-agnostic):** the hard-reasoning brain behind one interface — Claude / OpenAI / Gemini / OpenRouter. Bring-your-own key, stored in the OS keychain (§14), with a live spend display. Used by background agents (e.g. fuzzy extraction, skill refinement), not as a session orchestrator.

**Reranker:** in-process ONNX cross-encoder by default; cloud reranker available as an optional toggle. (Future synergy: with ONNX runtime already in-process, BGE-M3 embeddings could also move in-process, leaving Ollama needed only for the small LLM.)

---

## 5. Storage — RyuGraph (embedded)

One embedded engine providing **vector + graph + full-text**, with Cypher. This *is* the system's persistent memory — there is no separate "memory engine."

- Plays the combined role of the original Qdrant + FalkorDB, in-process, no server.
- Wrapped behind a **thin storage-abstraction layer** so the engine is swappable; version-pinned.
- **Concurrency:** RyuGraph (like upstream Kùzu) is single-writer. All writes from all background agents go through **one serialized write lane** in the kernel. This is fine because no write path is latency-critical.
- **Fallback on file (two-tier):** *Longevity fallback:* better-sqlite3 + sqlite-vec + FTS5 with the graph as plain edge tables — hedges ecosystem death of the Kùzu lineage; loses Cypher, which is acceptable in a fallback scenario since the read path is only 1–2 hops (JOIN territory). *Contention fallback:* Vela-Engineering's multi-writer Kùzu fork if the single write lane ever bottlenecks — note it shares RyuGraph's archived-Kùzu lineage risk, so it is contention insurance, not longevity insurance.
- **Extension bundling:** vector search and full-text are extensions in the Kùzu lineage and the official extension server is discontinued — but RyuGraph **≥ v0.11.3 ships official extensions pre-installed**. Pin ≥ v0.11.3 and add a CI check that vector + FTS load *offline* on every target platform (mac arm64/x64, Windows, Linux) — never fetch at runtime, or the app breaks offline. CI also verifies the Node binding builds against Electron's ABI (week-1 derisk, §19 step 1).
- **Scheduled export job (memory insurance):** a weekly automated dump of the full graph to CSV/Cypher statements, alongside the pre-migration backups (§3), so accumulated memory is never trapped in the engine. Runs as a §7 time-scheduled task. Exports stay Neo4j-compatible if migration is ever needed.
- Note: upstream Kùzu was archived Oct 2025; RyuGraph (Predictable Labs, MIT) is the maintained fork.

---

## 6. Memory — three lifetime levels + nightly improvement

Memory is organised by **how long it lives**. All persistent levels share the one RyuGraph store (different node types — see the schema in §18 — not separate databases).

1. **Working memory (hot)** — the current task's context; ephemeral. *Tech:* in-process Node objects + the model's context window. No database.
2. **Daily memory (short-term)** — today's raw session and experience logs. *Tech:* RyuGraph, date-tagged (`Session` nodes). Consumed by the extraction + nightly jobs, then pruned: drop the raw transcript, keep the distilled nodes/edges.
3. **Long-term memory (durable)** — what persists. *Tech:* RyuGraph + BGE-M3 embeddings (via Ollama). Two kinds of content:
   - **Knowledge** — ingested facts and documents ("what's true").
   - **Skill** — skills + their distilled improvements ("how to do things, better over time"), versioned via `SkillVersion`.

### Session capture — two sources

- **MCP-call log (reliable backbone):** every tool call Claude makes against the OS's MCP server is logged server-side, in a format the OS controls. This is the authoritative record of which skills / MCPs / plugins fired.
- **Session transcript file (best-effort):** the richer conversation transcript — path delivered by the `SessionEnd` hook for Claude Code, located via file watcher for other clients. The format is undocumented and version-dependent, so it's brittle — supplementary, not the backbone.

### Session-end detection (three-tier)

1. **Primary — Claude Code `SessionEnd` hook:** a one-time guided setup merges a hook entry into the user's `~/.claude/settings.json` (careful merge — never clobber existing hooks). On session end the hook POSTs its stdin JSON (`session_id`, `transcript_path`, `cwd`, `reason`) to the OS's local endpoint. Deterministic, officially documented, fires exactly at session end, and hands over the exact transcript path plus a `session_id` that correlates directly with the MCP-call log. If the OS app isn't running, the hook command falls back to appending its JSON to a spool folder (`~/.agentic-os/pending-sessions/`), drained on next launch — no session is lost to timing.
2. **Secondary — MCP-log inactivity timeout (any client):** if a session's MCP calls go quiet for N minutes, treat the session as ended. A heuristic, but client-agnostic and built on the log the OS controls — it only has to catch non-Claude-Code MCP clients.
3. **File watcher demoted to transcript enrichment:** chokidar no longer *triggers* extraction. For non-hook clients it only helps locate transcript files; for Claude Code the hook already provides the path. (chokidar stays in the stack regardless — watched-folder knowledge ingestion, §7.)

### Claude's writes are gated

During a session Claude reads/retrieves only. It may write to the graph **only** to correct something it is certain is wrong — and even then the write is **staged and validated** (a separate check / user-visible diff via the audit log) before commit. "Claude is confident" is not itself a permission check.

### Nightly skill-improvement job *(scheduled, §7)*

Reads daily experience, upgrades long-term skill memory:

1. **Example accumulation** — distil successes/failures into per-skill examples, injected when that skill next runs.
2. **Prompt refinement (gated)** — the cloud brain rewrites a skill's instructions from recent failures. Adopted *only if it beats the current `SkillVersion`*. **Reality check:** auto-benchmarking works cleanly for *verifiable* skills (does it run, does the API return 200). *Stylistic* skills ("don't left-indent unnecessarily; make it symmetric") can't be unit-tested — they need an LLM-as-judge against the stated preference **plus** a regression set of past corrections, and likely a human approve/reject gate. (See §18 write paths.)

Not included: nightly fine-tuning (Optional).

---

## 7. Triggers & automation

Tasks start from:
- **Session-end** — fires the extraction agent. *Tech:* Claude Code `SessionEnd` hook → local endpoint (primary); MCP-log inactivity timeout (fallback, any client). `chokidar` remains for watched-folder knowledge ingestion and transcript location for non-hook clients.
- **Time schedules** (cron-like) — fires the nightly skill job and any user-scheduled tasks. *Tech:* `croner` / node-cron.
- **Always-running watchers** — e.g. "when a new CNN article drops, do X." **Budget rule:** the watcher does cheap *detection* locally (poll a feed, diff a file); it only spends the cloud brain when the trigger actually fires, and every spend counts against the §14 budget.
- **User-coded rules** — user-defined `{ trigger, condition, action }` tasks (task-definition format in §17). The action calls a skill or runs the user's own code — **JS/TS by default in the Deno permission sandbox; any other language in the optional Docker sandbox (§11) — always under the rule's declared capabilities, never in the host process.** Arbitrary code is fine *because* it's sandboxed: the input a watcher processes (web content, etc.) is untrusted, so its handler must be contained.

Triggers *create* tasks; tasks enter the scheduler (§8).

---

## 8. Resource scheduler

Decides order when multiple tasks contend. *Tech:* a custom in-process priority queue (no Redis/BullMQ — that would reintroduce a server), **mirrored in a SQLite `tasks` table** (type, payload, priority, run_after, attempts, status — in the same local SQLite file as the trace store). The in-memory heap is the speed layer; SQLite is the durability layer: enqueue = insert, and on launch pending/deferred rows reload, so queued tasks survive crashes and reboots. The dashboard's scheduled-tasks panel reads this same table.
- **Single write lane** (§5): all graph writes serialize through it.
- Live MCP session (user waiting) is prioritized; background work yields; **aging** prevents background starvation.
- Cloud brain = a single lane (also respecting provider rate limits); cheap local work runs in a parallel pool.
- **No mid-generation preemption** — scheduling at step boundaries (cooperative yield).

---

## 9. Kernel — the mediation layer *(enforces §10–§14)*

All in-app. One module every background agent goes through to reason, read/write the store, or use a tool. Permissions, budgets, logging, provider-swapping, and scheduling live in **one place**.

- **Orchestrator:** background agents are defined as plain step lists against a thin internal **workflow-runner interface**; **LangGraph.js** implements it (state machine + checkpointing). Same swap-ability principle as the storage abstraction (§5) — agent code never imports LangGraph directly.
- **Observability:** everything is instrumented with **OpenTelemetry**; LangGraph.js step events and checkpoints emit spans that sink to a **local SQLite trace store** (its own file, so high-frequency span writes never contend with the graph's single write lane). The dashboard's native trace panel (waterfall + step inspector) reads it directly — in v1, since the dashboard is the cockpit for an autonomous system. Because OTel is the instrumentation layer, exporting to a self-hosted Langfuse later is configuration, not rework (optional, power users — see Optional/deferred). Traces cover the OS's own MCP tool calls and background-job steps; Claude's internal reasoning is not visible to the OS.

---

## 10. Context manager

Assembles each background-agent prompt within the active provider's token budget. Summarizes older content when a job runs long (no blind truncation). Checkpoints state between steps (LangGraph.js checkpointer, accessed via the workflow-runner interface) so long jobs pause, resume, and survive a restart. Token counting uses per-provider tokenizers.

---

## 11. Tool manager

The registry of everything agents can do: saved **skills** + connected **MCP servers** + a few **native tools** (file ops, web fetch, optional sandboxed code execution). It loads them, exposes them, **locks side-effecting calls** so concurrent agents don't collide, and routes every call through the permission layer.

- **Sandbox (two lanes, one policy):** *Default lane — Deno:* JS/TS user-rule actions and sandboxed code execution run under Deno's permission sandbox; the permission engine (§13) derives `--allow-read` / `--allow-write` / `--allow-net=<domains>` flags directly from the declared capabilities (a near 1:1 mapping). Single managed binary, no daemon, millisecond startup — good for latency-sensitive watcher handlers. *Polyglot lane — Docker (optional):* rules declaring any other language run in a deny-by-default container whose scoped volume mounts + network policy derive from the same capability declaration; if Docker is missing the app detects and guides install (§1). In both lanes the sandbox's limits *are* the agent's scope. **Cost of two lanes:** a shared conformance test suite keeps the two enforcement paths behavior-equivalent (same capability declaration → same effective allow/deny outcomes).

---

## 12. MCP — open to any AI tool

- The OS exposes itself as a **standard MCP server** — the primary interface the orchestrator uses. Every call is logged server-side (`mcp_calls` table, keyed by the transport session id) as the experience backbone (§6).
- **Transport:** Streamable HTTP bound to `127.0.0.1:<mcp_port>` (§20) with a locally generated bearer token (stored via §14). stdio does not fit — the server lives inside the long-running Electron app, which MCP clients do not spawn. Connection helper prints the exact `claude mcp add --transport http ...` command and writes a sample `.mcp.json`.
- **v1 tool surface (exact, build no others):**

| Tool | Purpose |
|---|---|
| `get_context(task, tags?)` | Runs the full §18 read path + §15 loop; returns the assembled context bundle |
| `search_memory(query, labels?, k?)` | Direct hybrid search over retrievable nodes, no loop |
| `list_skills()` / `get_skill(name)` | Skill discovery; `get_skill` returns the active `SkillVersion` body + recent examples |
| `propose_correction(node_id, patch, reason)` | Claude's only write path — staged into the review flow (§13), never a direct commit |
| `ingest_document(path_or_content, tags?)` | Knowledge ingestion pipeline (§18) |
| `ingest_codebase(path, project?)` | Codebase ingestion pipeline (§18) |

- It is also an MCP **client**, able to consume external MCP servers the user adds.

---

## 13. Access / permissions

The safety spine for an app running agents on the user's machine.
- **Capability-based, default-deny:** each agent scoped to specific folders, network domains, and tools (declared in its definition — §17).
- **Enforced at the kernel boundary:** every agent action routes through the kernel (§9), which checks it against the agent's declared capabilities before executing, applying the tiered gates below. The same capability declaration derives the sandbox limits — Deno permission flags or container volume mounts + network policy (§11). One chokepoint, one policy check. (A policy engine like Cedar/OPA is a future upgrade if the logic outgrows plain code.)
- **Tiered gates:** auto-allow safe reads/retrieval; prompt before writes, network calls, messages, or spend; hard-block destructive or out-of-scope actions.
- **Staged writes:** both Claude's gated corrections and the extraction agent's ambiguous writes are staged and validated (separate check / user-visible diff) before commit.
- **Inter-agent isolation:** agents share only via the store, never by reading each other's context.
- **Prompt-injection defense (layered):** ingested / tool / document content is treated as *data, never instructions* — it can never itself trigger an ungated tool call. On top of that: (1) **detection** — ingested documents are scanned for embedded instructions, and actions that diverge from the stated task are flagged before running; (2) **containment** — capability scoping + tiered gates cap what any hijacked agent can do; (3) **undo** — the audit log reverses anything that slips through. Detection is the fallible layer; containment and undo are the reliable ones. Source trust-tagging is added before enabling URL ingestion and autonomous watchers.
- **Audit + undo log:** every committed action by every AI agent is logged with a **reversible delta** — for graph writes, the inverse mutation / pre-image; for file ops, a pre-change backup — so any change can be undone from the dashboard. Provenance (§18) adds **undo-by-source** on top: purge everything extracted from a given session in one query. Irreversible actions (sent messages, network POSTs, spend) cannot be undone and are instead guarded by the prompt-before gates. (Distinct from observability traces, which are for debugging reasoning.)

---

## 14. Keychain + spend

- API keys in the OS secure keychain via Electron `safeStorage` (never plaintext).
- Live running spend display; per-task budget ceiling that halts the loop (§15); watcher spend (§7) counts against it.

---

## 15. Loop safety + failure recovery

- Max-iteration cap (~5 per query); stop-on-non-improvement; always return best-effort with a confidence flag.
- Per-task token/cost budget that halts the loop.
- Evaluation uses a **separate prompt and tier** from generation (e.g. a local-model critic against a rubric) to reduce self-judging bias.
- **Failure recovery:**
  - *Live tool-call failure* → the OS returns a clean structured error to Claude over MCP; Claude (the orchestrator) decides whether to retry or adapt. No pause-and-notify.
  - *Background-job failure* → retry with backoff, then defer to the next scheduled run, flagged in the log (deferral state persists in the §8 tasks table, so it survives restarts). Not time-critical, so deferring beats degrading.

---

## 16. Architecture — how it fits together

```
EXTERNAL      Claude (Claude Code / any MCP client)  =  the orchestrator
ORCHESTRATOR  connects over MCP · does the building work · reads context
   |  (MCP: read/retrieve live; gated, staged writes only)
   v
MCP SERVER    OS exposes a standard MCP server (and is an MCP client)
   |          every call logged server-side = reliable experience backbone
   v
KERNEL        scheduler · context mgr · tool mgr · permissions · budget · audit
(in-app)      orchestrator: LangGraph.js runs each BACKGROUND agent's steps
              observability: OTel spans -> local SQLite + native trace panel
   |
BACKGROUND    extraction (session-end signal) · skill-improvement (scheduled)
AGENTS        user-defined scheduled tasks · always-running watchers
   |
RETRIEVAL     hybrid: vector + graph + keyword -> rerank -> (loop, bounded)
   |
STORAGE       RyuGraph (embedded: vector + graph + full-text) = persistent memory
              single serialized write lane
   |
SERVICE       local tier (Ollama: BGE-M3 + small model · in-process ONNX reranker)
              cloud brain (BYO key, provider-agnostic)
   |
TRIGGERS      session-end hook (+ inactivity fallback) · time schedules · watchers
   |
HARDWARE      user's machine — CPU/GPU/disk · filesystem · network
```

---

## 17. Agent model

This is a **multi-agent system of the lifecycle / event-driven kind**, not a real-time collaborative swarm. Each agent is a single-purpose specialist that fires at its own moment and contributes to the shared graph independently; they coordinate only through the store (serialized via the write lane).

The agents:

1. **Orchestrator = Claude (external).** Fires during an active session. Calls the MCP for context, does the work. Not defined by the OS.
2. **Retrieval loop.** Fires on every context request. Runs the hybrid RAG + graph + self-correcting loop (§2, §15, §18 read path). A pipeline, not an autonomous agent.
3. **Extraction agent.** Fires on the session-end signal (`SessionEnd` hook, or the MCP-log inactivity fallback). Reads the MCP-call log + transcript, extracts entities and relationships, writes to the graph. (Full design below.)
4. **Skill-improvement agent.** Fires on schedule (event-gated). Refines skills from corrections + failure examples, benchmarks, versions. (Full design below.)
5. **User-defined scheduled tasks** and **always-running watchers.** User-authored.

**Agent / task definition format.** Internal workers (3, 4) are hardcoded roles. User tasks (5) are declarative JSON files in `~/.agentic-os/rules/*.rule.json`, zod-validated, and are exactly what §13 enforces against. Shape:

```json
{
  "id": "cnn-ai-watch",
  "trigger": { "type": "watch", "url": "https://cnn.com/rss", "intervalMin": 30 },
  "condition": "item.title contains 'AI'",
  "action": { "kind": "code", "lang": "ts", "entry": "summarize.ts" },
  "modelTier": "local",
  "capabilities": { "fsRead": [], "fsWrite": ["~/agentic-out"], "netDomains": ["cnn.com"], "maxSpendUSD": 0.10 }
}
```

When collaborative (swarm) multi-agent could earn its place later: if the extraction agent can't reliably parse a long session in one pass, split it into parallel sub-extractors (skills / relationships / preferences) and merge. Build it as one agent first.

### Extraction agent — detailed design

Turns a finished session into graph nodes and edges. Pipeline:

1. **Deterministic pass (no model).** Read the MCP-call log for the facts the OS already controls — which `Skill` / `MCP` / `Plugin` fired, which `Project`. Accurate by construction; no LLM, nothing to hallucinate.
2. **Fuzzy multi-pass extraction (LLM).** Focused passes over the transcript for the parts that need reasoning: `Component`s and their connections, `Preference`s, explicit `Correction`s. Local-first; escalate the whole session to the cloud when local confidence is low or the session is large.
3. **Entity resolution (write-path dedup — distinct from the retrieval loop).** For each extracted entity, new-vs-existing is decided tiered: deterministic key-match where stable IDs exist (skill id, MCP/plugin name, project path) → embedding-similarity match (cosine over threshold) for fuzzy nodes (preferences, components, knowledge) → LLM tiebreak only at the borderline. Reuses the BGE-M3 vector index but is its own step.
4. **Gated write.** High-confidence → commit. Low-confidence → the cloud pass acts as an independent verifier (a different model/tier from the extractor, so it can't rubber-stamp its own work — same principle as §15's separate critic); the step-2 cloud escalation doubles as this reviewer. Genuine disagreement or persistent uncertainty → human review queue in the dashboard.

**Correction signal scope:** explicit user corrections only for v1 (clear negative or redirecting feedback). Inferred signals (silent edits, re-runs) are deferred until the loop is proven, since a wrong inferred correction actively mis-trains a skill.

### Skill-improvement agent — detailed design

Fires nightly, but only on skills that accrued new `Correction`s or failure `Example`s since the last run (event-gated); also exposes a manual "improve this skill now" trigger. Reuses Anthropic's **skill-creator** methodology, prompts, and skill format — reimplemented in-process (LangGraph.js), not by driving an interactive session.

Per skill with new signal:

1. **Build the test set.** Turn that skill's past `Correction`s into regression cases ("given this situation, does the skill now avoid the corrected mistake?"), optionally topped up with a few synthetic cases for coverage.
2. **Propose a candidate.** The cloud brain rewrites the skill's instructions from recent failures → a new `SkillVersion` (status candidate). Skills are stored in `SKILL.md` format (frontmatter + body + optional bundled scripts/references/assets), so they stay portable to/from Claude Code.
3. **Benchmark candidate vs active.** Verifiable outcomes → assertion checks (skill-creator's `grader` prompt). Stylistic outcomes → blind A/B between candidate and active outputs (skill-creator's `comparator` prompt), judged by a different model/tier. Split cases train/held-out, run each multiple times, score by held-out to avoid overfitting.
4. **Adoption gate.** Verifiable skills: adopt if net-positive *and* no regression on any previously-fixed correction → flip candidate→active, active→retired. Stylistic skills: same benchmark, but surface for one-click human approval before adopting (the judge is fallible on subjective quality). Set per-skill.
5. **Live drift watch.** After adoption, track the corrections rate against the new active version; if it draws more corrections than its predecessor over the next N uses, flag (or auto-revert) using the retained `SkillVersion` history.

Borrowed from skill-creator: the `SKILL.md` format, the grader/comparator prompts, and the train/held-out + best-by-test-score logic. Not borrowed: its description-triggering optimizer (`run_loop.py`) — retrieval surfaces skills here, not `available_skills` triggering — and its interactive/subagent execution, which LangGraph.js orchestrates in-process instead.

---

## 18. Graph schema (memory ontology)

A labeled property graph. **Two classes of node:**

- **Retrievable** (carry a BGE-M3 `embedding` + full-text index; the hybrid search matches against these): `Project`, `Skill`, `Preference`, `Knowledge`.
- **Structural** (no embedding; reached by traversal from a retrievable hit): `Session`, `SkillVersion`, `Example`, `Correction`, `MCP`, `Plugin`, `Component`, `Document`, `Tag`.

### Node types

| Node | Class | Key properties |
|---|---|---|
| `Session` | structural | id, started_at, ended_at, transcript_ref, tier=daily |
| `Project` | retrievable | id, name, summary, embedding |
| `Skill` | retrievable | id, name, instructions, current_version, embedding |
| `SkillVersion` | structural | id, instructions, benchmark_score, status=candidate\|active\|retired, created_at |
| `Example` | structural | id, kind=success\|failure, content, created_at |
| `Correction` | structural | id, content, created_at |
| `Preference` | retrievable | id, statement, embedding |
| `MCP` | structural | id, name, config_ref |
| `Plugin` | structural | id, name, config_ref |
| `Component` | structural | id, name, type=page\|route\|model\|service\|… |
| `Document` | structural | id, source, content_hash, ingested_at |
| `Knowledge` | retrievable | id, content, embedding (a structure-aware chunk of a `Document`) |
| `Tag` | structural | id, name, is_global (bool) |

`MCP` and `Plugin` are **separate labels** (they carry different metadata; a plugin may bundle its own skills/components). `Component` is at **meaningful-unit granularity** (a page, an API route, a data model) — not file-level. `Preference` is **tag-scoped** via `APPLIES_TO`; one `Tag` has `is_global=true` and is always included in retrieval, so baseline preferences are always at least considered.

### Provenance (v3.1)

- **All nodes** carry `created_at` / `updated_at`.
- **Extraction-written nodes** (`Component`, `Preference`, session-derived `Knowledge`) additionally carry `extracted_by` (pipeline pass + extractor version, e.g. `extraction@1.2/llm-local`) and `confidence` (0–1; model-relative — interpret only alongside `extracted_by`), plus an `EXTRACTED_FROM` edge to their source `Session`. The prune job keeps `Session` stubs forever, so provenance survives transcript pruning.
- Provenance fields are **structural metadata**: never embedded, never matched by the hybrid search. They serve three consumers — fusion scoring may downweight low-confidence/stale nodes; the review queue displays source session, pipeline pass, and confidence next to every staged write; and cleanup gains **undo-by-source** — one query purges everything extracted from a poisoned session (complements §13's per-action undo deltas).

### Relationships

```
(Session)        -[:PRODUCED]->      (Project)
(Session)        -[:USED]->          (Skill | MCP | Plugin)
(Project)        -[:USES]->          (Skill | MCP | Plugin)
(Project)        -[:HAS_COMPONENT]-> (Component)
(Component)      -[:DEPENDS_ON]->    (Component)
(Component)      -[:CONNECTS_TO]->   (Component)
(Skill)          -[:HAS_VERSION]->   (SkillVersion)
(Skill)          -[:HAS_EXAMPLE]->   (Example)
(Correction)     -[:OBSERVED_IN]->   (Session)
(Correction)     -[:IMPROVED]->      (Skill)
(Preference)     -[:DERIVED_FROM]->  (Correction)
(Preference)     -[:APPLIES_TO]->    (Tag)
(Document)       -[:HAS_CHUNK]->     (Knowledge)
(Component|Preference|Knowledge) -[:EXTRACTED_FROM]-> (Session)
(Project|Skill|Knowledge) -[:TAGGED]-> (Tag)
```

### Read path (retrieval loop)

1. Embed the task with BGE-M3; run two arms in parallel — vector similarity and full-text/keyword — over the retrievable nodes. Always include the global `Tag`'s preferences.
2. Graph-expand from the seed hits: project → its skills/tools/components; matched tags → preferences `APPLIES_TO` them; each skill → active `SkillVersion` + recent `Example`s.
3. Fuse (vector + keyword + graph-proximity), rerank with the in-process ONNX cross-encoder (bge-reranker-v2-m3), assemble within the token budget (§10). Re-query with a rewritten query if the bundle scores poorly (bounded, §15).

### Write paths

- **Extraction agent (session-end trigger):** full pipeline in §17. In graph terms: create `Session`; match/create `Project`; `MERGE` `Skill`/`MCP`/`Plugin` used (`USES`/`USED`); extract `Component`s + their edges; detect explicit `Correction`s (`OBSERVED_IN`); tag everything; stamp provenance (`EXTRACTED_FROM` the session, `extracted_by`, `confidence`); embed new retrievable nodes. Low-confidence writes go to a cloud verifier, then a human-review queue (§13).
- **Skill-improvement agent (scheduled, event-gated):** full pipeline in §17. In graph terms: gather `Correction`s that `IMPROVED` a skill + recent failure `Example`s → propose a candidate `SkillVersion` → benchmark vs active → adopt (flip candidate→active, active→retired) only on a net-positive, no-regression win, with human approval for stylistic skills. `SkillVersion` history retained for rollback + drift watch.
- **Claude's gated writes:** existing nodes only, staged + validated before commit.
- **Codebase ingestion (`ingest_codebase` MCP tool / dashboard folder pick):** walk the folder respecting `.gitignore` (skip `node_modules`, binaries, files > 1 MB) → **Tree-sitter** parses per language (TS/JS/Python grammars in v1) → `Component` nodes at meaningful-unit granularity (exported functions/classes, routes, data models — never one-node-per-file) + `DEPENDS_ON` edges from imports → `HAS_COMPONENT` from the matched/created `Project` → README/docstrings/markdown go through the knowledge pipeline below as `Knowledge` chunks tied to the same Project. Content-hash per source unit: re-ingest replaces only changed units. Provenance: `extracted_by = codebase-ingest@<version>`, `confidence = 1.0` (parsing is deterministic).
- **Knowledge ingestion (manual upload + watched folders):** structure-aware chunk (split on headers / code blocks) → BGE-M3 embed locally → create a `Document` + its `Knowledge` chunks (`HAS_CHUNK`) → tag chunks to the `Tag` taxonomy. Content-hash dedup: identical re-adds skip; changed docs re-chunk and replace their old chunks (no versioning — stale facts are replaced, with `ingested_at` for freshness). No model needed beyond local embeddings; full GraphRAG entity extraction deferred (Optional).

### Lifetime / prune

`Session` is daily. After N days the prune job drops `transcript_ref` (raw transcript) but keeps the `Session` stub and all distilled edges — keep the lessons, forget the transcripts.

### RyuGraph implementation notes

HNSW vector index on the `embedding` property of the four retrievable labels; full-text index on their text properties; everything else is plain Cypher. All writes queue through the single serialized write lane (§5, §8).

---

## 19. Build order

1. **Storage + retrieval** — RyuGraph embedded + the §18 schema + hybrid search, behind the abstraction layer. **Week-1 derisk:** pin ≥ v0.11.3, confirm vector + FTS extensions load offline, and confirm the Node binding builds against Electron's ABI on all target platforms.
2. **Intelligence wiring** — local tier (Ollama, with detect/guide setup) + provider-agnostic cloud brain + keychain.
3. **The loop** — generate → evaluate → retry, with loop safety + budget guard.
4. **Kernel + workflow runner (LangGraph.js behind a thin interface) + context manager + tracing (OTel → local SQLite trace store + native panel).**
5. **MCP server + client** — expose the OS; start logging the experience backbone.
6. **Knowledge ingestion** — manual + watched folders populate `Knowledge`.
7. **Codebase ingestion** — Tree-sitter → `Component` graph + code `Knowledge` (`ingest_codebase`).
8. **Extraction agent** — fill the graph from finished sessions.
9. **Sandbox (Deno lane + optional Docker lane) + access/permissions + audit/undo log + staged writes** — lock it down before agents touch real files or run code; includes the lane-conformance test suite.
10. **Dashboard** — review queue, audit/undo, spend, memory browser, watcher manager, traces, ingestion. Needed before autonomous triggers go live.
11. **Triggers & automation** — `SessionEnd` hook setup + inactivity fallback, schedules, watchers, user-coded rules (in the sandbox), durable task queue.
12. **Skill-improvement agent + benchmark/eval harness.**
13. **Resource scheduler hardening + packaging/auto-update + full E2E.**

The authoritative per-phase breakdown (goals, definitions of done, skills to use) lives in `docs/phases/phase-00 … phase-13` — one phase per implementing session.

---

## 20. Defaults (authoritative values — never invent alternatives)

| Setting | Value |
|---|---|
| Product / repo name | `agentic-os` |
| MCP server | Streamable HTTP, `127.0.0.1:4517`, bearer token auto-generated on first run |
| Hook endpoint | `POST http://127.0.0.1:4517/hooks/session-end` (same server) |
| Spool folder | `~/.agentic-os/pending-sessions/` |
| User rules folder | `~/.agentic-os/rules/` |
| App data | Electron `userData` dir: `graph/` (RyuGraph), `appdata.db` (SQLite: `traces`, `tasks`, `mcp_calls`, `staged_writes`, `spend`), `models/` (ONNX reranker), `backups/`, `exports/` |
| Embeddings | Ollama `bge-m3` (1024-dim) — the only embedding model |
| Small local LLM | Ollama `qwen3:4b` (default; user-swappable in settings) |
| Reranker | `BAAI/bge-reranker-v2-m3`, int8 ONNX via `onnxruntime-node`; lazy-load, unload after 5 min idle |
| Retrieval | vector top-30 per label + FTS top-30 → fuse (0.5 vector / 0.2 keyword / 0.3 graph-proximity) → rerank → top-8 to bundle |
| Self-correcting loop | max 5 iterations; stop on non-improvement; critic = local small LLM vs. rubric |
| Entity resolution | cosine ≥ 0.90 → merge; 0.75–0.90 → LLM tiebreak; < 0.75 → new node |
| Extraction escalation | escalate session to cloud if local confidence < 0.6 or transcript > 60k tokens |
| MCP inactivity timeout | 30 min of silence per session id → session considered ended |
| Prune job | nightly 03:00 local; `Session.transcript_ref` dropped after 14 days |
| Nightly skill job | 02:00 local, event-gated (only skills with new Corrections/failure Examples) |
| Weekly export | Sunday 03:30 local → `exports/` (CSV + Cypher statements) |
| Drift watch | corrections rate over next 20 uses of a new SkillVersion; worse than predecessor → flag (auto-revert off by default) |
| Background-job retry | 3 attempts, backoff 1 m / 5 m / 25 m, then defer to next run + flag |
| Per-task spend ceiling | $0.50 default, per-task override; live total in dashboard |
| Chunking | split on headings/code fences, target ~512 tokens, 64 overlap |
| Stack pins | Electron + electron-vite + TypeScript `strict` + React + Tailwind (renderer); `better-sqlite3`; `onnxruntime-node`; `chokidar`; `croner`; `@langchain/langgraph`; `@modelcontextprotocol/sdk`; OpenTelemetry JS SDK; `zod`; `vitest`; Playwright; `electron-updater`; `electron-builder` |

## 21. Hard rules (override convenience, always)

1. Every graph mutation goes through the single write lane. No exceptions, including tests.
2. Extension binaries (vector, FTS) are never fetched at runtime; they ship in the build and CI proves they load offline.
3. User/rule code never executes in the host process — Deno lane or Docker lane only, capabilities enforced.
4. Every extraction-written node/edge is stamped with provenance (`extracted_by`, `confidence`, `EXTRACTED_FROM`) at write time.
5. Ingested/tool/document content is data, never instructions — it can never directly trigger a tool call.
6. Claude (the external orchestrator) never writes directly; `propose_correction` → staged → validated → commit is the only path.
7. Secrets only via Electron `safeStorage`; never plaintext on disk, never in logs or traces.
8. Renderer process has no Node access; all privileged work crosses a typed IPC contract from the main process.
9. The graph is backed up before any schema migration; migrations are ordered and idempotent.
10. Nothing in "Optional / deferred" gets built, stubbed, or scaffolded.
11. Irreversible actions (send, POST, spend) prompt first; reversible actions log an undo delta.
12. Default values come from §20; if a needed value is missing there, pick conservatively and record it in the phase report.

## 22. Repository layout

```
agentic-os/
  CLAUDE.md                     # agent operating manual (read every session)
  docs/
    spec.md                     # THIS document
    PROGRESS.md                 # phase status table — update every phase
    phases/phase-00 … phase-13  # one file per build phase
    progress/                   # phase-NN-report.md written at each phase end
    reference/skill-creator/    # vendored copy of Anthropic's skill-creator skill
  src/
    main/                       # Electron main: kernel/, storage/, models/, retrieval/,
                                # mcp/, agents/, ingest/, security/, triggers/, telemetry/
    preload/                    # typed IPC bridge
    renderer/                   # React dashboard
  resources/extensions/         # pinned RyuGraph vector+FTS binaries per platform
  scripts/hooks/                # session-end hook command (sh + ps1)
  tests/{unit,integration,e2e,fixtures}/
```

## 23. Build phases & skills

- One phase per session, in order, per `docs/phases/`. Each phase ends with the end-of-phase protocol in `CLAUDE.md` (tests green → phase report → `PROGRESS.md` → commit).
- **Design skills (installed in Phase 0, used heavily in Phase 10):** `impeccable` (run `/impeccable init` once to set project design context, then `/audit`, `/critique`, `/polish`), `ui-ux-pro-max` (query its search script for dashboard/data-dense patterns before designing panels), `taste` / `design-taste-frontend` (dials for this product: VARIANCE 4 · MOTION 2 · DENSITY 7 — it is an operations cockpit, not a landing page).
- **skill-creator (vendored, `docs/reference/`):** the skill-improvement agent (§17) reimplements its `SKILL.md` format and grader/comparator methodology — read the vendored copy before Phase 12, never guess the format.
- **Playwright MCP:** use during Phase 10 to drive the dev-server dashboard, screenshot, and iterate visually instead of coding blind.
- **Subagents:** use them whenever they help — parallel test suites, independent panels, research spikes. One rule: two subagents must never write the same core module concurrently.


---

## Optional / deferred — do NOT build any of these

- **"Send to my Claude Code"** — a button that hands a heavy task to the user's own Claude Code session. Deferred: terms-of-service and UX questions unresolved.

- **GraphRAG entity extraction from knowledge** — richer multi-hop knowledge graph, deferred from §18 (chunk + embed + tag ships first).
- **User-preference modeling** — broader than the prompt-refinement gate.
- **Memory hot-cache tier** — a speed layer in front of the store, if retrieval latency becomes an issue.
- **Nightly fine-tuning of the local model.**
- **LlamaIndex.TS** — for parsing/chunking the knowledge-ingestion pipeline if you'd rather not roll your own.
- **Concurrent cloud-brain pool** — graduate from the single lane if throughput demands it.
- **Vela multi-writer fork** — swap in if the single write lane bottlenecks (same archived-Kùzu lineage as RyuGraph, so contention insurance only — longevity insurance is the SQLite fallback in §5).
- **Cedar/OPA policy engine** — if capability logic outgrows the kernel-boundary check (§13).
- **Self-hosted Langfuse** — optional OTel exporter target for a full trace + eval + annotation UI. Power users only: it's a six-service Docker stack (web, worker, Postgres, ClickHouse, Redis, S3/MinIO; ClickHouse is mandatory), far heavier than the OS itself.
