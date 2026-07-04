# Phase 02 — Model layer (local + cloud + keychain + spend)
**Goal:** every model capability behind clean interfaces: Ollama embed/generate, in-process ONNX reranker, provider-agnostic cloud brain, secure keys, spend metering.
**Read first:** spec §4, §14, §20, §21(7); phase-01 report.

## Build
- `src/main/models/ollama.ts` — detect daemon (GET /api/tags), guided-install state (status enum the dashboard reads later), one-click pull of `bge-m3` + `qwen3:4b`; `embed(texts) -> number[1024][]`; `generate(prompt, opts)`.
- `src/main/models/reranker.ts` — download int8 ONNX of `BAAI/bge-reranker-v2-m3` to `userData/models/` on first use (checksum-verified, resumable); `onnxruntime-node` session; `rerank(query, docs) -> scores`; lazy-load + 5-min idle unload (§20). Ollama is NOT involved here — its embed API cannot return cross-encoder scores.
- `src/main/models/cloud.ts` — one `CloudBrain` interface `complete(messages, opts)`; adapters: Anthropic, OpenAI, Gemini, OpenRouter (plain fetch, streaming optional). Active provider in settings.
- Keychain: `safeStorage`-encrypted blob on disk for API keys + the MCP bearer token (created here, used Phase 05).
- `SpendMeter`: per-call cost from a static price table → `spend` table; `checkBudget(taskId)` throws when a per-task ceiling ($0.50 default) is exceeded.

## Definition of Done
- [ ] Unit tests with mocked HTTP for all adapters; reranker test reranks a fixture (golden order asserted).
- [ ] Live gated test (`OLLAMA=1 npm test`): embeds 2 texts via bge-m3, generates 1 short completion.
- [ ] Keys round-trip through safeStorage; grep proves no plaintext key ever hits disk or logs.
- [ ] Spend test: ceiling halts a simulated task.
**Do NOT:** wire retrieval or agents; no UI.
