# Phase 04 — Kernel: workflow runner, context manager, tracing
**Goal:** the mediation layer every background agent will run through, with durable workflows and OTel tracing into SQLite.
**Read first:** spec §9, §10, §20; phase reports 01–03.

## Build
- `src/main/kernel/runner.ts` — `WorkflowRunner` interface: `define(name, steps[])`, `run(name, input) -> jobId`, `resume(jobId)`. `LangGraphRunner` implements it with `@langchain/langgraph` + a SQLite checkpointer (appdata.db). **Agent code never imports LangGraph directly** (§9).
- `src/main/kernel/context.ts` — assembles background-agent prompts within the active provider's budget; summarize-don't-truncate when long (small LLM).
- `src/main/telemetry/` — OpenTelemetry SDK; span per kernel action / workflow step / model call → `SqliteSpanExporter` writing the `traces` table. Trace ids propagate through workflows.
- `kernel.execute(agentId, action)` facade: permission check is a pass-through stub tagged `// PHASE-09` + audit hook stub; every action already creates a span.

## Definition of Done
- [ ] A 3-step demo workflow runs; killing the process mid-step-2 and calling `resume` completes it (test does a real re-instantiation).
- [ ] Spans for the demo run exist in `traces` with correct parent-child ids.
- [ ] Context manager test: oversized input gets summarized, not truncated (assert key fact survives).
**Do NOT:** real permissions (Phase 09), no agents yet.
