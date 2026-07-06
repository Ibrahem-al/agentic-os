# Phase 19 report — scheduled agent-mode extraction (§8 Phase 5 / FP-5)

**Branch:** `feat/mcp-expansion-subscription-reasoner`. Opus 3-stage ultracode workflow (`wf_eff3fcae-e99`): runner agent-mode + connect-back fake → handler integration → verify. Orchestrator independently confirmed token hygiene + zero dep creep. The scheduler now auto-launches a headless `claude -p` that connects back to loopback MCP and submits via the staged-write tools — **behind `runner.mode:'agent'`, opt-in atop the runner opt-in.**

**Prime directive held:** ADD, never REMOVE. Ships OFF (`runner.enabled=false` AND `mode='completion'` default). Even a fully hijacked child can only stage proposals into the §5 gates. **No new npm dependency.**

## What was built
- **`runner/mcpConfig.ts`** — per-task `.mcp.json` writer; the token on disk is the **literal `${AGENTIC_OS_RUNNER_TOKEN}`** (§10.5/P0.3), the raw task id in `X-Agentic-Os-Runner-Task`, filename sanitized for win32, deleted after the run.
- **`runner/agent.ts`** — `runAgentMode`: pre-assignable `--session-id`, writes the config, spawns (reusing `spawnClaude`) `claude -p … --mcp-config --strict-mcp-config --allowedTools "…read_session,get_pending_work,submit_extraction_items" --disallowedTools Bash,… --append-system-prompt "<scope guard>" --settings {"disableAllHooks":true} --session-id <uuid>` with the **real token only in the child env**, `RUNNER_AGENT_TIMEOUT_MS` watchdog, config deleted in `finally`.
- **Handler routing** (`triggers/sessionEnd.ts` + `agents/extraction/agent.ts`) — `EXTRACTION_AGENT_WORKFLOW` (collect → deterministic → **spawn-agent** → delegate-load (18) → resolve → verify → write); `resolveExtractionRoute` (live `enabled ∧ healthy ∧ mode==='agent'` gate) routes a primary extraction to agent mode, else today's path. `stageAll` threaded into `dispositionOf` (every fuzzy item stages; deterministic facts still commit).
- **P0.5 recursive-extraction closure** — tombstone-before-spawn (`extract-<uuid>` status `done` INSERT OR IGNORE **before** the spawn → dedups the child's own SessionEnd hook POST) + post-exit backstop; **`InactivityMonitor.selectQuiet` now excludes `session_kind='runner'`** (the missing piece).
- **P1.6 injection downgrade** — a regex-only scan at routing time persists findings to `injection_flags` (source `runner:<taskId>`); `injectionPolicy='downgrade'` (default) extracts a flagged transcript in **completion mode** (no tools).
- **Containment** — server-side per-task template `{read_session, get_pending_work, submit_extraction_items}` (`registerRunnerTaskTemplate`/`releaseRunnerTaskTemplate` + session reaper §10.15) narrows 14b's READ+STAGING default; a non-template tool → `PERMISSION_DENIED` regardless of `--allowedTools`.
- **Test seam** — `fake-runner.mjs` gained an agent-mode branch that **connects back** to loopback MCP over `node:http` (initialize → `notifications/initialized` → `tools/call submit_extraction_items`, SSE parse), expanding `${AGENTIC_OS_RUNNER_TOKEN}` from env — validated against the **real `@modelcontextprotocol/sdk` transport**.

## Reused (already committed)
14b (runner-token dual-auth + session-kind tagging + gauge split + READ+STAGING allowlist + `RUNNER_SESSION_MAX_TOOL_CALLS` + task binding); 17 (spawn/watchdog/health/lanes/zombie/telemetry); 18 (the delegate variant + `runner_submissions`). This phase only added the agent-mode spawn + the safety closures + the wiring.

## Verification (DoD)
- Orchestrator: token literal on disk (never the real token) + real token only in child env; `package.json`/lock diff **0 lines**; lint+typecheck clean; isolated `runner.agent`(unit 11 + int 4) + `agents.extraction-agent-mode`(6) = **21 passed**.
- Verify agent full offline suite: **839 passed | 12 skipped** (+22 vs phase-18); sole failure the `security.conformance`-docker load flake (green in isolation 22/22); the connect-back E2E ran **6 times flake-free**.
- Audit CONFIRMED (6 pts): DEFAULT==TODAY; token hygiene; P0.5 both halves; containment (per-task template + strict-mcp-config + disallowedTools + stageAll→review); no new dep; croner slots + task kinds unchanged.

## Next — phase-20 (hardening & honesty, the final phase)
Model-version bookkeeping (P1.8); review-queue batch UX + Ollama-required approve preflight (P1.7); first-enable consent dialog + README/website "local-first" honesty copy (P1.10); settings independence-warning (P1.11) + HARD-override warnings; retrieval single-iteration clamp on subscription (§10.4); CI canary (P2); the recorded ToS re-check (§6.1).
