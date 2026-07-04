# Phase 02 report — Model layer (local + cloud + keychain + spend)

**Status:** done · **Date:** 2026-07-04

## What was built

`src/main/models/` — every model capability behind clean interfaces (§4, §14):

- **`ollama.ts`** — `OllamaClient` over plain fetch against the local daemon: `status()` returns the §4 guided-install state machine (`daemon-not-running` → installer link / `models-missing` → one-click pull / `ready`) that the phase-10 dashboard reads; `pull(model, onProgress)` streams NDJSON progress; `ensureRequiredModels()` is the one-click pull (fetches only whichever of `bge-m3` / `qwen3:4b` is missing); `embed(texts) → number[1024][]` (POST `/api/embed`, dims validated against `EMBEDDING_DIM`, count-mismatch rejected); `generate(prompt, opts)` (POST `/api/generate`, `stream:false`, **`think:false` by default** — qwen3 is a thinking model and routing/cheap-eval callers want the plain answer; opt back in via `think:true`). Returns text + Ollama-reported token counts.
- **`reranker.ts`** — the in-process cross-encoder (§4: Ollama is NOT involved — its embed API can't return classification-head scores). `Reranker.rerank(query, docs) → number[]` raw logits (higher = more relevant; sigmoid for 0..1). First use downloads the pinned int8 ONNX of `BAAI/bge-reranker-v2-m3` (~570 MB) + tokenizer.json + tokenizer_config.json to `userData/models/` — **resumable** (`.part` file + HTTP `Range`, restart tolerated when a server ignores Range) and **checksum-verified** (sha256 pins in config; mismatch deletes the file and throws; a pre-existing wrong-hash file is moved to `*.corrupt-<ts>` and re-fetched; valid pre-existing files are verified once per process, no re-download). Lazy-load + **idle unload after `RERANKER_IDLE_UNLOAD_MS` (5 min, §20)** with an `unref()`ed timer and an in-flight guard (never unloads mid-rerank; concurrent reranks share a single load). Inference: onnxruntime-node session (int64 `input_ids`/`attention_mask`, pad-token batch padding, `token_type_ids` zero-filled if the graph asks), mini-batches of `RERANKER_BATCH_SIZE`, over-long pairs truncated to `RERANKER_MAX_SEQUENCE_TOKENS` keeping the closing EOS. Tokenization: `@huggingface/tokenizers` (pure-JS XLM-R unigram incl. precompiled charsmap) loading the pinned tokenizer files. Session/tokenizer/fetch are all injectable for tests.
- **`cloud.ts`** — `CloudBrain` interface (`complete(messages, opts) → {text, model, usage, stopReason, reportedCostUsd?}`) with four plain-fetch adapters: **Anthropic** (`/v1/messages`, `x-api-key` + `anthropic-version`, top-level `system`, text blocks concatenated), **OpenAI** (`/v1/chat/completions`, Bearer, `max_completion_tokens`), **Gemini** (`v1beta …:generateContent`, `x-goog-api-key`, `assistant`→`model` role mapping, `systemInstruction`, thinking tokens folded into output usage so spend is honest), **OpenRouter** (OpenAI wire shape + `usage:{include:true}` → the response's `usage.cost` becomes `reportedCostUsd`). `createCloudBrain(provider, {apiKey, model?, fetch?})` factory. Every error path (HTTP + network) is scrubbed of the API key (`[redacted]`) before the message is built — §21 rule 7 defense in depth against providers echoing bad keys.
- **`keychain.ts`** — `Keychain` over an injected `SafeStorageLike` (Electron main passes the real `safeStorage`; the module never imports `electron` so it loads under plain-node vitest). One encrypted blob at `userData/keychain.bin`: the whole secrets map (values AND names) is JSON → `encryptString` → raw ciphertext on disk, written atomically (tmp + rename). `isEncryptionAvailable() === false` → constructor throws (no plaintext fallback, ever). `ensureMcpBearerToken()` generates the §20 bearer token (32 random bytes, base64url) on first run, idempotent — phase 05 consumes it. Undecryptable file → loud actionable error, never a silent reset.
- **`spend.ts`** — `PRICE_TABLE` (USD/MTok, as-of 2026-07-04; Anthropic rows from the Claude API reference, OpenAI/Gemini from their published pricing) + `SpendMeter`: `record()` computes cost (precedence: provider-reported → table → `FALLBACK_PRICE`) and appends to the phase-01 `spend` table; `taskSpendUsd`/`totalSpendUsd` (the §14 live display's data source); `checkBudget(taskId, override?)` throws `SpendCeilingExceededError` at/over the ceiling ($0.50 default, per-task override — §20). `meteredComplete(brain, meter, taskId, messages, opts)` is the budget-gated call shape background agents use: check **before** spending, record after.
- **`settings.ts`** — the non-secret side (§4 "active provider in settings"): `userData/settings.json` with `cloudProvider` (default `anthropic`), per-provider `cloudModels` overrides, optional `smallLlmModel`. Validated load (unknown provider/shape throws), atomic save, `activeCloudModel()` resolution. API keys structurally cannot live here.
- **`index.ts`** — barrel; the rest of the app imports only from here.

Wiring & infra:

- **`config.ts` additions** (per CLAUDE.md, all defaults live here): `OLLAMA_BASE_URL`/`OLLAMA_INSTALL_URL`/`OLLAMA_REQUIRED_MODELS`; the six reranker distribution pins (URLs, sha256s, filenames) + `RERANKER_MAX_SEQUENCE_TOKENS`/`RERANKER_BATCH_SIZE`; `CLOUD_PROVIDERS`/`CloudProvider` type/`CLOUD_PROVIDER_DEFAULT`/`CLOUD_DEFAULT_MODELS`/`CLOUD_MAX_TOKENS_DEFAULT`.
- **`src/main/index.ts`** — `bootModels()` after storage boot: opens the keychain with real safeStorage, ensures the MCP bearer token, loads settings, logs the Ollama guided-install state. Logs names/states only — never a secret value.
- **`scripts/ci/electron-keychain-check.cjs`** — bundles the REAL `Keychain` class (esbuild) and runs it inside a REAL Electron main process with REAL safeStorage (DPAPI): canary API key + bearer token round-trip across instances, then scans every byte under the temp userData for the plaintext canary. Writes a JSON verdict (Windows Electron stdout is unreliable — phase-00 finding 7). Wired into CI's Windows job (Linux/macOS runners have no OS keyring, `isEncryptionAvailable()` is false there by design).
- **`tests/fixtures/onnxFixture.ts`** — hand-encoded ONNX protobuf (~100 lines, no Python toolchain): `logits = ReduceMean(Cast<float>(input_ids), axes=[1])`, dynamic `[batch, seq]` int64 inputs. onnxruntime-node loads and runs it for real, so unit tests exercise the exact session/tensor plumbing the 570 MB model uses, with deterministic golden order (score = mean token id; equal-length docs so padding can't skew it).
- **Dependency added (user-approved):** `@huggingface/tokenizers@0.1.3` (exact pin) — official HF, pure JS/TS, zero runtime deps, ~300 KB; the same tokenizer engine transformers.js v4 uses. Needed because onnxruntime runs the graph but nothing in the §20 stack tokenizes XLM-R.
- **Tests** — 118 total (114 offline + 4 live-gated): unit `models.ollama` (13), `models.cloud` (11), `models.keychain` (8), `models.spend` (12), `models.settings` (6), `models.reranker` (12, real ORT over the fixture) on top of the existing 52 phase-01 tests + config additions; integration `models.live.test.ts` gated on `OLLAMA=1` (embed 2 texts + semantic sanity, one qwen3:4b completion) and `RERANKER=1` (REAL int8 weights, golden order on a capital-of-France fixture).

## Key decisions & findings (read before later phases)

1. **Reranker source pin.** `BAAI/bge-reranker-v2-m3` ships no ONNX; the pinned artifact is the community export **`onnx-community/bge-reranker-v2-m3-ONNX`** → `onnx/model_int8.onnx` (570,727,094 bytes). The sha256 pins in config are the repo's LFS oids AND were independently verified against a local download on 2026-07-04 (`tokenizer_config.json` isn't LFS — hashed locally). `model_quantized.onnx` in that repo is byte-identical to `model_int8.onnx`. The real model's graph inputs are `input_ids` + `attention_mask` (no `token_type_ids`), output `logits [batch,1]`; the session factory tolerates a `token_type_ids`-requiring graph by zero-filling.
2. **Tokenizer.** `@huggingface/tokenizers` handles XLM-R's Unigram + precompiled-charsmap normalizer in pure JS. API: `new Tokenizer(tokenizerJsonObj, tokenizerConfigObj)`; pair encoding via `encode(query, {text_pair: doc})` produces the `<s> q </s></s> d </s>` shape. It exposes **no truncation option** — the Reranker truncates ids itself (head + re-appended `</s>`), verified by test.
3. **Live reranker verified on this machine**: query "What is the capital of France?" over three docs scores paris=7.769, eiffel=-4.819, bananas=-11.010 — the relevant doc wins by a wide margin. First rerank including session load + on-disk checksum verify of the 570 MB file: 4.3 s on this machine; subsequent reranks are fast. The idle-unload keeps the ~600 MB session out of memory when unused.
4. **Ollama specifics:** `/api/embed` takes `input: string[]` and returns `embeddings: number[][]` (bge-m3 → 1024 dims, verified live). `qwen3:4b` under Ollama honors `think:false` (a `think` boolean in the generate payload) — without it, responses carry a thinking preamble that routing/eval callers would have to strip. Required-model matching treats `bge-m3` as satisfied by `bge-m3:latest` (Ollama tag normalization).
5. **OpenRouter reports real cost**: with `usage: {include: true}` in the request body, the response's `usage.cost` is USD; `SpendMeter.record` prefers it over the table (test-pinned). This makes OpenRouter the only provider with exact (not estimated) spend.
6. **Unknown-model pricing is conservative by design**: `priceFor()` falls back to the most expensive known rate ($10/$50 per MTok) and flags `estimated: true` — a mispriced model halts the §14 budget *earlier*, never later. Keep `PRICE_TABLE` fresh when models change (prices as-of 2026-07-04).
7. **`meteredComplete` checks the budget BEFORE the call** — the ceiling can be exceeded by at most one call's cost (recorded), and the blocked call never reaches the provider (test-pinned: $0.15/call fake → 4 completions, halt on the 5th, 4 audit rows).
8. **safeStorage lifecycle**: available on Windows (DPAPI) in real Electron main — full round-trip + on-disk plaintext scan pass (`scripts/ci/electron-keychain-check.cjs`, also on Windows CI). It is NOT available under `ELECTRON_RUN_AS_NODE` or plain node, which is why `SafeStorageLike` is injected and unit tests use a fake. Headless Linux CI has no keyring → check is Windows-CI-only.
9. **Anthropic adapter sends no sampling params** (`temperature`/`top_p` are rejected by current Opus-tier models); `CompleteOptions` deliberately has no temperature field. Default models per provider (config, settings-overridable): `claude-opus-4-8`, `gpt-5.5`, `gemini-2.5-pro`, `openai/gpt-5.5`.
10. **Streaming is deferred** (phase doc: "streaming optional") — the only callers are background agents consuming whole completions. Revisit if a later phase needs incremental output.
11. Conservative picks under §21 rule 12 (recorded; none are §20 values): Ollama base URL `http://127.0.0.1:11434` (upstream default) + installer link `https://ollama.com/download`; `CLOUD_MAX_TOKENS_DEFAULT` 4096 (spend-conservative; callers raise); reranker max sequence 1024 tokens / batch size 8; active-provider default `anthropic` (§4 lists Claude first); settings file `settings.json`; keychain file `keychain.bin`; local artifact names `bge-reranker-v2-m3-{int8.onnx,tokenizer.json,tokenizer_config.json}`; generate defaults `think:false`, `stream:false`.
12. **`npm install` reports 3 high-severity vulnerabilities** — pre-existing (transitive via the pinned electron-vite/vite 7.3.6 toolchain, dev-only), not introduced by `@huggingface/tokenizers` (zero deps). Left for the phase-13 hardening pass rather than an off-spec version bump now.

## Deferred / notes

- Cloud streaming (see finding 10). Reranker cloud-toggle (§4 "cloud reranker available as an optional toggle") is settings surface for phase 10; nothing blocks it.
- The reranker's real weights live at `%APPDATA%/agentic-os/models/` on this machine already (placed from the verified download), so the app's first real rerank won't re-download.
- `PRICE_TABLE` is static by spec ("static price table"); it will drift. The conservative fallback bounds the damage; refresh opportunistically.
- The live test's `defaultUserData()` helper assumes the Windows/`%APPDATA%` (or `~/.config`) layout; macOS would need `~/Library/Application Support` if anyone runs `RERANKER=1` there.

## Instructions for phase 03 (hybrid retrieval & loop)

- Import from `src/main/models` (barrel): `OllamaClient` for embeddings (`embed(texts)`, already 1024-dim-validated) and the small-LLM critic (`generate(prompt, {maxTokens, system})` — thinking already off); `Reranker` for the §20 rerank stage — construct once with `modelsDir: appDataPaths(userData).modelsDir` and share it; it lazy-loads and idle-unloads itself. Scores are raw logits: rank by them directly.
- §20 pipeline constants are all in config: `RETRIEVAL_VECTOR_TOP_K`/`RETRIEVAL_FTS_TOP_K`/`RETRIEVAL_FUSION_WEIGHTS`/`RETRIEVAL_BUNDLE_TOP_N`, `LOOP_MAX_ITERATIONS`.
- The critic must use a separate prompt + the LOCAL tier (§15) — `OllamaClient.generate`, not the CloudBrain.
- If the loop can spend cloud money (it shouldn't in phase 03 — retrieval is local), any cloud call goes through `meteredComplete` with a task id.
- Remember phase-01 finding 8: FTS tokenizer drops some tokens and strips digits — test with robust alphabetic terms.
- Mocked-fetch patterns for Ollama/reranker tests are in `tests/unit/models.{ollama,reranker}.test.ts`; the ONNX fixture builder is reusable (`tests/fixtures/onnxFixture.ts`).
- Don't call the reranker per-label — fuse first, rerank the fused candidate set once (top-30+30 → fuse → rerank → top-8).

## Definition of Done — outputs

### 1. Unit tests with mocked HTTP for all adapters; reranker fixture golden order

`npx vitest run tests/unit` — 10 files, 86 tests. Adapter suites assert wire shape (URL/auth headers/body incl. `max_completion_tokens` vs `max_tokens`, Gemini role mapping + `systemInstruction`, OpenRouter `usage.include`), parsing (text/usage/stop reason/`reportedCostUsd`), and key redaction. `models.reranker.test.ts` downloads the hand-built ONNX fixture through the mocked HTTP layer (checksum + resume + corrupt-file paths) and asserts golden order `['zzzz','mmmm','aaaa']` through a REAL onnxruntime-node session, plus idle unload/reload and single-flight loading.

### 2. Live gated test (`OLLAMA=1 npm test`)

```
OLLAMA=1 RERANKER=1 npm test
Test Files  16 passed (16) · Tests  118 passed (118)   [27.3s]
```

- embeds 2 texts via bge-m3 → 2×1024 finite non-zero vectors; paraphrase ranks closer than the unrelated text by cosine
- generates 1 short completion via qwen3:4b (non-empty, output tokens > 0)
- extra (`RERANKER=1`): the REAL int8 cross-encoder ranks the Paris doc first for "What is the capital of France?"

### 3. Keys round-trip through safeStorage; grep proves no plaintext on disk or logs

Real Electron main + real DPAPI (`npx electron scripts/ci/electron-keychain-check.cjs`):

```json
{ "ok": true, "platform": "win32", "electron": "43.0.0", "encryptionAvailable": true,
  "roundTrip": true, "bearerTokenStable": true, "plaintextHits": [] }
```

(the check greps every byte under the keychain's userData dir for the canary key — zero hits; the script logs only PASS/FAIL, never the key). Unit tests additionally pin: file bytes contain neither secret values nor names, atomic writes leave no tmp files, unavailable encryption throws instead of falling back to plaintext. Dev-smoke userData grep: `GREP CLEAN: no secret names/values in any userData file` (`keychain.bin` = 96 bytes of ciphertext holding the bearer token).

### 4. Spend test: ceiling halts a simulated task

`models.spend.test.ts` over the real appdata.db `spend` table: a 100-iteration runaway loop through `meteredComplete` ($0.15/call on the opus-4-8 table rate) completes exactly 4 calls ($0.60) and halts with `SpendCeilingExceededError` before the 5th ever reaches the provider; 4 audit rows written. Per-task override + $0.50 §20 default + provider-reported-cost precedence all pinned.

### 5. `npm test` / lint / typecheck (offline default)

```
Test Files  15 passed | 1 skipped (16)
Tests  114 passed | 4 skipped (118)      (skips = the OLLAMA/RERANKER live gates)
> eslint .            (clean)
> tsc --noEmit -p tsconfig.node.json && tsc --noEmit -p tsconfig.web.json   (clean)
```

### Extra: integration suite under Electron's runtime (Windows, this machine)

```
ELECTRON_RUN_AS_NODE=1 electron node_modules/vitest/vitest.mjs run tests/integration
Test Files  5 passed | 1 skipped (6) · Tests  28 passed | 4 skipped (32)
```

### Extra: real-app dev smoke (scratch userData)

```
[boot] agentic-os main process starting (MCP reserved at 127.0.0.1:4517)
[native] onnxruntime-node 1.27.0 (runtime 1.27.0) loaded in Electron main
[storage] appdata.db open (WAL: traces, tasks, mcp_calls, staged_writes, spend) at …\dev-smoke-userdata\appdata.db
[storage] ryugraph 25.9.1 open at …\dev-smoke-userdata\graph — schema v1, 1 nodes, vector+FTS from vendored extensions
[models] keychain open (safeStorage-encrypted) — secrets present: mcp.bearerToken
[models] active cloud provider: anthropic
[models] ollama ready (3 models incl. required)
```

Graceful window-close quit; `keychain.bin` created encrypted; no electron processes left.
