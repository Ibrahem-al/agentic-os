# Phase 05 — MCP server & client + call log
**Goal:** the OS speaks MCP: Streamable HTTP server with the exact §12 tool surface, every call logged; plus the outbound MCP client manager.
**Read first:** spec §12, §6 (capture), §20, §21(6); phase reports 03–04.

## Build
- `@modelcontextprotocol/sdk` server, Streamable HTTP on `127.0.0.1:4517`, bearer-token auth (Phase 02 keychain). Tools — exactly these, no others: `get_context` (wraps Phase 03), `search_memory`, `list_skills`, `get_skill`, `propose_correction` (→ `staged_writes` row, NEVER a direct graph write), `ingest_document` + `ingest_codebase` (register now; return a clear NOT_IMPLEMENTED error until Phases 06/07 fill them).
- **Call log:** middleware writes every request to `mcp_calls` (tool, args hash, session id from the transport, timestamp, duration, ok/err). This is the experience backbone — it must be impossible to invoke a tool without a log row.
- Connection helper: prints `claude mcp add --transport http agentic-os http://127.0.0.1:4517/mcp --header "Authorization: Bearer <token>"` and writes a sample `.mcp.json`.
- MCP client manager: add/remove external servers from a config file; list their tools (consumed by agents later).

## Definition of Done
- [ ] Integration test with the SDK client: auth rejected without token; `get_context` returns a bundle from the fixture graph; `propose_correction` lands in `staged_writes` and the graph is untouched.
- [ ] Every test call has an `mcp_calls` row (assert count).
- [ ] Manual smoke: real Claude Code connects and calls `get_context` (paste transcript snippet in the report).
**Do NOT:** implement ingestion bodies; no hook endpoint yet (Phase 11).
