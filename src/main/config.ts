/**
 * Central configuration — every value in spec §20 lives here and nowhere else.
 * All other modules import from this file; never re-declare a default elsewhere.
 *
 * This module is intentionally free of `electron` imports so it can be loaded
 * from unit tests and standalone scripts. Paths that depend on Electron's
 * `userData` directory are exposed as functions taking that directory.
 */
import { homedir } from 'node:os'
import { join } from 'node:path'

/** Product / repo name. */
export const PRODUCT_NAME = 'agentic-os'

// ── MCP server ───────────────────────────────────────────────────────────────
/** MCP server: Streamable HTTP on 127.0.0.1:4517, bearer token generated on first run. */
export const MCP_HOST = '127.0.0.1'
export const MCP_PORT = 4517
export const MCP_TRANSPORT = 'streamable-http' as const
/** Session-end hook endpoint (same server). */
export const HOOK_SESSION_END_PATH = '/hooks/session-end'
export const HOOK_SESSION_END_URL = `http://${MCP_HOST}:${MCP_PORT}${HOOK_SESSION_END_PATH}`
/** Max bytes of a session-end hook POST body (payloads are tiny JSON; rule 12). */
export const HOOK_MAX_BODY_BYTES = 256 * 1024
/** 30 min of MCP silence per session id → session considered ended. */
export const MCP_INACTIVITY_TIMEOUT_MS = 30 * 60 * 1000
/**
 * MCP endpoint path + server identity. The path matches the §12 connection
 * helper (`claude mcp add ... http://127.0.0.1:4517/mcp`); name/version are
 * what the server reports during the MCP initialize handshake.
 */
export const MCP_ENDPOINT_PATH = '/mcp'
export const MCP_URL = `http://${MCP_HOST}:${MCP_PORT}${MCP_ENDPOINT_PATH}`
export const MCP_SERVER_NAME = PRODUCT_NAME
export const MCP_SERVER_VERSION = '0.0.1'
/**
 * Values below are not in §20 — conservative rule-12 picks, recorded in the
 * phase-05 report.
 */
/** Max bytes of a POST body the MCP HTTP endpoint accepts. */
export const MCP_MAX_BODY_BYTES = 4 * 1024 * 1024
/**
 * mcp_calls keeps the args hash always (phase-05 doc); the full args JSON is
 * kept alongside only up to this size (§6 extraction wants the args, but
 * ingest_document can carry whole documents — those log hash-only).
 */
export const MCP_CALL_ARGS_JSON_MAX_BYTES = 16 * 1024
/** search_memory: default and max result count (k). */
export const SEARCH_MEMORY_DEFAULT_K = 8
export const SEARCH_MEMORY_MAX_K = 30
/** External MCP servers the OS consumes as a client (§12), in userData. */
export const MCP_SERVERS_CONFIG_FILENAME = 'mcp-servers.json'

// ── Filesystem layout ────────────────────────────────────────────────────────
/**
 * The ~/.agentic-os base (§20 spool + rules). AGENTIC_OS_DOT_DIR is the test
 * seam (e2e/smoke runs must never drain the user's real spool or load their
 * real rules) — the same hermeticity pattern as AGENTIC_OS_USER_DATA_DIR.
 */
const DOT_DIR = process.env['AGENTIC_OS_DOT_DIR'] ?? join(homedir(), '.agentic-os')
/** Spool folder for pending (unprocessed) session transcripts. */
export const SPOOL_DIR = join(DOT_DIR, 'pending-sessions')
/** User rules folder. */
export const RULES_DIR = join(DOT_DIR, 'rules')

/** App-data subpaths, resolved against Electron's `userData` dir (spec §20 "App data"). */
export function appDataPaths(userDataDir: string): {
  graphDir: string
  appDb: string
  modelsDir: string
  backupsDir: string
  exportsDir: string
} {
  return {
    /** RyuGraph on-disk database. */
    graphDir: join(userDataDir, 'graph'),
    /** SQLite: traces, tasks, mcp_calls, staged_writes, spend. */
    appDb: join(userDataDir, 'appdata.db'),
    /** ONNX reranker weights. */
    modelsDir: join(userDataDir, 'models'),
    backupsDir: join(userDataDir, 'backups'),
    exportsDir: join(userDataDir, 'exports')
  }
}

// ── Models ───────────────────────────────────────────────────────────────────
/** The only embedding model, everywhere (Ollama). */
export const EMBEDDING_MODEL = 'bge-m3'
export const EMBEDDING_DIM = 1024
/** Small local LLM (Ollama); user-swappable in settings. */
export const SMALL_LLM_MODEL = 'qwen3:4b'
/** In-process cross-encoder reranker. */
export const RERANKER_MODEL = 'BAAI/bge-reranker-v2-m3'
export const RERANKER_QUANTIZATION = 'int8' as const
/** Lazy-load the reranker; unload after 5 min idle. */
export const RERANKER_IDLE_UNLOAD_MS = 5 * 60 * 1000

// ── Ollama (local model tier, §4) ────────────────────────────────────────────
/**
 * Ollama daemon endpoint. Not a §20 value — this is Ollama's own upstream
 * default port, adopted per §21 rule 12 (recorded in the phase-02 report).
 */
export const OLLAMA_BASE_URL = 'http://127.0.0.1:11434'
/** Installer link shown by the guided-install flow when no daemon is found. */
export const OLLAMA_INSTALL_URL = 'https://ollama.com/download'
/** The models the one-click pull installs (§4 setup): embeddings + small LLM. */
export const OLLAMA_REQUIRED_MODELS: readonly string[] = [EMBEDDING_MODEL, SMALL_LLM_MODEL]

// ── Reranker distribution (int8 ONNX of BAAI/bge-reranker-v2-m3) ────────────
/**
 * Pinned int8 ONNX export of RERANKER_MODEL plus its tokenizer, downloaded to
 * userData/models/ on first use (checksum-verified, resumable). Source:
 * onnx-community/bge-reranker-v2-m3-ONNX on Hugging Face; the sha256 values
 * are the repo's LFS oids, independently verified against a local download
 * on 2026-07-04 (tokenizer_config.json is not LFS — hash computed locally).
 */
const RERANKER_REPO_URL = 'https://huggingface.co/onnx-community/bge-reranker-v2-m3-ONNX/resolve/main'
export const RERANKER_ONNX_URL = `${RERANKER_REPO_URL}/onnx/model_int8.onnx`
export const RERANKER_ONNX_SHA256 = '912fc1215c2dbff6499700534bd8d31253af01573861abbfc43afd1fab6cce5d'
export const RERANKER_ONNX_BYTES = 570_727_094
export const RERANKER_ONNX_FILENAME = 'bge-reranker-v2-m3-int8.onnx'
export const RERANKER_TOKENIZER_URL = `${RERANKER_REPO_URL}/tokenizer.json`
export const RERANKER_TOKENIZER_SHA256 = '8bf8afbfd11306bd872018c53bfdf2e160a56f8edbcf49933324404791c148d3'
export const RERANKER_TOKENIZER_FILENAME = 'bge-reranker-v2-m3-tokenizer.json'
export const RERANKER_TOKENIZER_CONFIG_URL = `${RERANKER_REPO_URL}/tokenizer_config.json`
export const RERANKER_TOKENIZER_CONFIG_SHA256 = 'b87c8703482b0300d3da30e201519aa641f6a450f5eb5bf1e624afbf70c74d80'
export const RERANKER_TOKENIZER_CONFIG_FILENAME = 'bge-reranker-v2-m3-tokenizer_config.json'
/**
 * Max (query, doc) sequence length fed to the cross-encoder. The model
 * accepts 8192; retrieval chunks target ~512 tokens (§20), so 1024 bounds
 * latency/memory with headroom. Rule-12 pick, recorded in the phase report.
 */
export const RERANKER_MAX_SEQUENCE_TOKENS = 1024
/** Docs scored per ONNX run; bounds peak memory. Rule-12 pick. */
export const RERANKER_BATCH_SIZE = 8

// ── Cloud reasoning tier (§4: provider-agnostic, bring-your-own key) ─────────
export const CLOUD_PROVIDERS = ['anthropic', 'openai', 'gemini', 'openrouter'] as const
export type CloudProvider = (typeof CLOUD_PROVIDERS)[number]
/** §4 lists "Claude / OpenAI / Gemini / OpenRouter" — Claude first (rule 12). */
export const CLOUD_PROVIDER_DEFAULT: CloudProvider = 'anthropic'
/**
 * Default model per provider (settings-overridable). Not §20 values — current
 * flagship/default tier per provider as of 2026-07-04 (rule 12, recorded).
 */
export const CLOUD_DEFAULT_MODELS: Readonly<Record<CloudProvider, string>> = {
  anthropic: 'claude-opus-4-8',
  openai: 'gpt-5.5',
  gemini: 'gemini-2.5-pro',
  openrouter: 'openai/gpt-5.5'
}
/** Default completion cap — spend-conservative; callers raise it as needed. */
export const CLOUD_MAX_TOKENS_DEFAULT = 4096

// ── Kernel / context manager (§9, §10) ──────────────────────────────────────
/**
 * Context-window sizes used to derive the prompt budget per provider (§10
 * "within the active provider's token budget"). Not §20 values — conservative
 * floors per rule 12 (recorded in the phase-04 report): a smaller window only
 * makes summarization kick in earlier, never overflows a real model.
 */
export const PROVIDER_CONTEXT_WINDOW_TOKENS: Readonly<Record<CloudProvider, number>> = {
  anthropic: 200_000,
  openai: 200_000,
  gemini: 1_000_000,
  openrouter: 128_000
}
/**
 * The local small LLM's usable window. Ollama's default num_ctx is 4096;
 * summarization chunks are sized so prompt + output always fit inside it.
 */
export const LOCAL_LLM_CONTEXT_WINDOW_TOKENS = 4096
/** Estimated tokens of section content fed to one summarize call. */
export const CONTEXT_SUMMARIZE_CHUNK_TOKENS = 2048
/** Re-summarize rounds before giving up (output caps make >1 rare). */
export const CONTEXT_SUMMARIZE_MAX_ROUNDS = 3
/**
 * Fraction of a summary's token target requested as the model's num_predict.
 * The estimating counter overestimates real tokens by up to ~25%, so capping
 * output below target keeps the *estimate* of the summary under target too.
 */
export const CONTEXT_SUMMARY_OUTPUT_FRACTION = 0.6
/** Below this per-section summary target the budget is too small to be honest. */
export const CONTEXT_MIN_SUMMARY_TOKENS = 32

// ── Retrieval ────────────────────────────────────────────────────────────────
/** Vector top-30 per label + FTS top-30 → fuse → rerank → top-8 to bundle. */
export const RETRIEVAL_VECTOR_TOP_K = 30
export const RETRIEVAL_FTS_TOP_K = 30
export const RETRIEVAL_FUSION_WEIGHTS = {
  vector: 0.5,
  keyword: 0.2,
  graphProximity: 0.3
} as const
export const RETRIEVAL_BUNDLE_TOP_N = 8
/**
 * Values below are not in §20 — conservative rule-12 picks, recorded in the
 * phase-03 report.
 */
/** Fused candidates handed to the cross-encoder (bounds rerank latency). */
export const RETRIEVAL_RERANK_TOP_K = 50
/** Default context-bundle token budget (callers may override per call). */
export const RETRIEVAL_BUNDLE_TOKEN_BUDGET = 8192
/** Recent Examples pulled per skill during graph expansion (§18 read path). */
export const RETRIEVAL_RECENT_EXAMPLES = 3
/** Graph-proximity signal per hop from a seed hit: decay^hops (seed = 1.0). */
export const RETRIEVAL_GRAPH_DECAY = 0.5

/** Self-correcting loop: max 5 iterations; stop on non-improvement; critic = small local LLM vs. rubric. */
export const LOOP_MAX_ITERATIONS = 5
/** Normalized critic score (0..1) at/above which a bundle passes (rule 12). */
export const RETRIEVAL_CRITIC_PASS_SCORE = 0.7
/** Completion caps for the loop's local critic / query-rewrite calls (rule 12). */
export const RETRIEVAL_CRITIC_MAX_TOKENS = 256
export const RETRIEVAL_REWRITE_MAX_TOKENS = 128

// ── Entity resolution ────────────────────────────────────────────────────────
/** cosine ≥ 0.90 → merge; 0.75–0.90 → LLM tiebreak; < 0.75 → new node. */
export const ENTITY_MERGE_COSINE = 0.9
export const ENTITY_TIEBREAK_COSINE_LOW = 0.75

// ── Extraction ───────────────────────────────────────────────────────────────
/** Escalate a session to the cloud tier below this local confidence. */
export const EXTRACTION_ESCALATE_CONFIDENCE = 0.6
/** …or above this transcript size (tokens). */
export const EXTRACTION_ESCALATE_TRANSCRIPT_TOKENS = 60_000
/**
 * Provenance stamp for extraction-written nodes/edges (§18 "pipeline pass +
 * extractor version", e.g. `extraction@0.0.1/llm-local`). The version tracks
 * package.json; the pass suffix (`/deterministic`, `/llm-local`, `/llm-cloud`,
 * `/llm-local+verified`) is appended by the agent per §18's example shape.
 */
export const EXTRACTION_PROVENANCE = 'extraction@0.0.1'
/**
 * Values below are not in §20 — conservative rule-12 picks, recorded in the
 * phase-08 report. The per-item WRITE gate reuses
 * EXTRACTION_ESCALATE_CONFIDENCE (0.6): §20 defines that figure as the "low
 * confidence" line for extraction output, and the gated write is that line's
 * per-item application (no second threshold invented).
 */
/** Estimated transcript tokens per LOCAL fuzzy-pass call (fits the 4096 num_ctx window with prompt + output). */
export const EXTRACTION_LOCAL_CHUNK_TOKENS = 2048
/** Estimated transcript tokens per CLOUD fuzzy-pass call (fits the 128k conservative provider floor). */
export const EXTRACTION_CLOUD_CHUNK_TOKENS = 100_000
/** Output cap (num_predict / max_tokens) for one fuzzy-pass reply. */
export const EXTRACTION_PASS_MAX_TOKENS = 800
/** Items kept per fuzzy pass per call (defensive cap on runaway JSON). */
export const EXTRACTION_MAX_ITEMS_PER_PASS = 20
/** Output cap for one cloud-verifier reply. */
export const EXTRACTION_VERIFIER_MAX_TOKENS = 300
/** Output cap for one entity-resolution tiebreak reply (YES/NO, narration-tolerant). */
export const EXTRACTION_TIEBREAK_MAX_TOKENS = 64

// ── Background jobs (cron expressions, local time) ───────────────────────────
/** Nightly prune, 03:00 local. */
export const PRUNE_JOB_CRON = '0 3 * * *'
/** `Session.transcript_ref` dropped after 14 days. */
export const TRANSCRIPT_RETENTION_DAYS = 14
/** Nightly skill-improvement job, 02:00 local (event-gated). */
export const SKILL_JOB_CRON = '0 2 * * *'
/** Weekly export, Sunday 03:30 local → exports/ (CSV + Cypher statements). */
export const EXPORT_JOB_CRON = '30 3 * * 0'

// ── Skill drift watch ────────────────────────────────────────────────────────
/** Corrections rate observed over the next 20 uses of a new SkillVersion. */
export const DRIFT_WATCH_USES = 20
/** Auto-revert is off by default; worse-than-predecessor only flags. */
export const DRIFT_AUTO_REVERT = false

// ── Skill-improvement agent (§17 agent #4, phase 12) ─────────────────────────
/**
 * Provenance stamp on HAS_VERSION edges written by the improvement agent
 * (Skill/SkillVersion carry no provenance columns per §18 — the edge carries
 * it, the phase-07/08 convention). Version tracks package.json.
 */
export const SKILL_IMPROVEMENT_PROVENANCE = 'skill-improvement@0.0.1'
/**
 * Values below are not in §20 — conservative rule-12 picks, recorded in the
 * phase-12 report. The benchmark methodology figures (3 runs per case per
 * configuration, 0.4 held-out fraction, best-by-held-out) are reimplemented
 * from the vendored skill-creator reference (docs/reference/skill-creator/),
 * per the phase doc's "never guessed" mandate.
 */
/** Synthetic coverage cases the cloud brain pads the test set with ("a few"). */
export const SKILL_SYNTHETIC_CASES = 3
/** Cap on correction-derived regression cases per benchmark (cost bound). */
export const SKILL_MAX_CORRECTION_CASES = 8
/** Runs per case per configuration (skill-creator: runs_per_configuration 3). */
export const SKILL_BENCHMARK_RUNS = 3
/** Fraction of cases held out for scoring (skill-creator run_loop default). */
export const SKILL_HOLDOUT_FRACTION = 0.4
/** Skills processed per nightly run (wall-clock bound; the rest stay gated). */
export const SKILL_IMPROVEMENT_MAX_PER_RUN = 5
/** Output cap for the cloud synthetic-case call. */
export const SKILL_CASE_GEN_MAX_TOKENS = 2000
/** Output cap for the cloud SKILL.md rewrite (a whole skill file). */
export const SKILL_REWRITE_MAX_TOKENS = 4096
/** Output cap for one local case execution (the benchmarked output). */
export const SKILL_GENERATION_MAX_TOKENS = 600
/** Output cap for one local grader verdict ({passed, evidence}). */
export const SKILL_GRADER_MAX_TOKENS = 200
/** Output cap for one cloud blind-comparator verdict ({winner, reasoning}). */
export const SKILL_COMPARATOR_MAX_TOKENS = 400

// ── Background-job retry ─────────────────────────────────────────────────────
/** 3 attempts, backoff 1 m / 5 m / 25 m, then defer to next run + flag. */
export const JOB_RETRY_ATTEMPTS = 3
export const JOB_RETRY_BACKOFF_MS = [60_000, 300_000, 1_500_000] as const

// ── Triggers & scheduler (§7/§8 — phase 11) ─────────────────────────────────
/**
 * Values below are not in §20 — conservative rule-12 picks, recorded in the
 * phase-11 report.
 */
/** Waiting time that lifts a queued task's effective priority by +1 (§8 aging). */
export const TASK_AGING_INTERVAL_MS = 5 * 60 * 1000
/** Re-check cadence while background dispatch yields to a live MCP call (§8). */
export const TASK_YIELD_RECHECK_MS = 1000
/** Max total yield per dispatch — §8 aging: background must never starve. */
export const TASK_YIELD_MAX_MS = 60_000
/**
 * Default enqueue priorities (higher runs first). User-authored rule actions
 * are the most user-visible; extraction/ingest are routine; nightly
 * maintenance is the least urgent.
 */
export const TASK_PRIORITY = {
  ruleAction: 20,
  extraction: 10,
  ingestFile: 10,
  /** Manual "improve now" — user-initiated, routine-tier like extraction. */
  skillImprove: 10,
  watchScan: 5,
  maintenance: 0
} as const
/** Cadence of the §6 MCP-log inactivity sweep (the 30-min figure is §20). */
export const INACTIVITY_CHECK_INTERVAL_MS = 5 * 60 * 1000
/** chokidar awaitWriteFinish stability window for watched files (§7). */
export const WATCHER_DEBOUNCE_MS = 1000
/** URL-watch poll bodies kept for hashing/conditions (bounded, §7 cheap detection). */
export const WATCHER_URL_CONTENT_MAX_BYTES = 64 * 1024
/** Floor on a url watcher's poll interval (a rule's intervalMin never polls hotter). */
export const WATCHER_URL_MIN_INTERVAL_MS = 15_000
/** Watcher baselines (file/url content hashes), in userData. */
export const TRIGGER_STATE_FILENAME = 'trigger-state.json'
/** Tag stamped on autonomously ingested documents (§13 source trust-tagging v1). */
export const AUTO_INGEST_TRUST_TAG = 'auto-ingested'

// ── Spend ────────────────────────────────────────────────────────────────────
/** Per-task spend ceiling (USD); per-task override allowed; live total in dashboard. */
export const SPEND_CEILING_USD_DEFAULT = 0.5

// ── Chunking ─────────────────────────────────────────────────────────────────
/** Split on headings/code fences; target ~512 tokens with 64 overlap. */
export const CHUNK_TARGET_TOKENS = 512
export const CHUNK_OVERLAP_TOKENS = 64

// ── Knowledge ingestion (§18 write path, phase 06) ──────────────────────────
/**
 * Values below are not in §20 — conservative rule-12 picks, recorded in the
 * phase-06 report.
 */
/** Extensions chunked with markdown structure awareness (headings + fences). */
export const INGEST_MARKDOWN_EXTENSIONS: readonly string[] = ['.md', '.markdown', '.mdx']
/** Plain-text / source extensions chunked on paragraph boundaries. */
export const INGEST_TEXT_EXTENSIONS: readonly string[] = [
  '.txt', '.text', '.rst', '.adoc', '.log', '.csv', '.tsv',
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.json',
  '.py', '.rb', '.go', '.rs', '.java', '.kt', '.swift',
  '.c', '.h', '.cpp', '.hpp', '.cc', '.cs',
  '.sh', '.bash', '.ps1', '.bat', '.sql',
  '.css', '.scss', '.html', '.xml', '.svg',
  '.yaml', '.yml', '.toml', '.ini', '.cfg', '.env.example'
]
/** Rich-document formats explicitly deferred (spec: "PDF etc. are deferred"). */
export const INGEST_DEFERRED_EXTENSIONS: readonly string[] = [
  '.pdf', '.doc', '.docx', '.ppt', '.pptx', '.xls', '.xlsx', '.odt', '.epub', '.rtf'
]
/**
 * Max file size ingested as knowledge. Mirrors the §18 codebase-ingest rule
 * ("skip files > 1 MB") — the only file-size figure the spec states.
 */
export const INGEST_MAX_FILE_BYTES = 1024 * 1024
/** Provenance stamp on ingested Knowledge chunks (deterministic pipeline). */
export const KNOWLEDGE_INGEST_PROVENANCE = 'knowledge-ingest@1.0'
/** Source prefix for documents ingested as inline content (no file path). */
export const INGEST_INLINE_SOURCE_PREFIX = 'inline:'
/** Watched-folder definitions (§7), in userData; live watching lands in phase 11. */
export const WATCHED_FOLDERS_CONFIG_FILENAME = 'watched-folders.json'

// ── Codebase ingestion (§18 write path, phase 07) ────────────────────────────
/**
 * Provenance stamp on Components + edges written by codebase ingestion
 * (§18: `extracted_by = codebase-ingest@<version>`, deterministic parsing →
 * confidence 1.0). The version tracks package.json's `version`.
 */
export const CODEBASE_INGEST_PROVENANCE = 'codebase-ingest@0.0.1'
/**
 * Values below are not in §20 — conservative rule-12 picks, recorded in the
 * phase-07 report.
 */
/** Extensions parsed with Tree-sitter (§18: TS/JS/Python grammars in v1). */
export const CODEBASE_CODE_EXTENSIONS: readonly string[] = [
  '.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs', '.py'
]
/**
 * Source prefix for per-file docstring documents extracted from code — kept
 * distinct from the file's own path so a literal ingest of the same file (via
 * ingest_document / watched folders) never collides with its docstring doc.
 */
export const CODEBASE_DOCS_SOURCE_PREFIX = 'code-docs:'
/** Output cap (num_predict) for the README → Project summary small-LLM call. */
export const CODEBASE_SUMMARY_MAX_TOKENS = 160
/** README characters fed to the summary prompt (fits the 4096 local window). */
export const CODEBASE_README_PROMPT_MAX_CHARS = 6000
/** Fallback Project summary length when the local LLM is unavailable. */
export const CODEBASE_SUMMARY_FALLBACK_MAX_CHARS = 400

// ── Security: sandbox lanes (§11, §13 — phase 09) ────────────────────────────
/**
 * Values below are not in §20 — conservative rule-12 picks, recorded in the
 * phase-09 report.
 */
/** Wall-clock kill deadline for one sandbox run (both lanes). */
export const SANDBOX_TIMEOUT_MS_DEFAULT = 30_000
/** Memory cap per sandbox run (MiB): Deno --v8-flags=--max-old-space-size, Docker --memory. */
export const SANDBOX_MEMORY_MB_DEFAULT = 256
/**
 * Managed Deno binary (§11 default lane): exact version + per-platform zip
 * sha256, pinned from the official GitHub release (denoland/deno v2.9.1,
 * released 2026-07-01; digests read from the release API on 2026-07-04 and
 * re-verified against the downloaded archive). Downloaded on first use to
 * userData/bin/ (checksum-verified, resumable) — same pattern as the phase-02
 * reranker weights. Never fetched from anywhere else.
 */
export const DENO_VERSION = '2.9.1'
export const DENO_DOWNLOAD_BASE = 'https://github.com/denoland/deno/releases/download'
export interface DenoAssetPin {
  readonly asset: string
  readonly sha256: string
}
/** Key: `${process.platform}-${process.arch}`. */
export const DENO_PLATFORM_ASSETS: Readonly<Record<string, DenoAssetPin>> = {
  'win32-x64': {
    asset: 'deno-x86_64-pc-windows-msvc.zip',
    sha256: 'ab310b4232cca207d40ffa41867e93aaf9f893802bc76756e74f486a6b21b371'
  },
  'darwin-x64': {
    asset: 'deno-x86_64-apple-darwin.zip',
    sha256: '89cbc8c974247772d9200724741b4e692ef49fe470b2ff555da905817c3daa11'
  },
  'darwin-arm64': {
    asset: 'deno-aarch64-apple-darwin.zip',
    sha256: 'ee3473502118eab301eca93aa6b31d6b0b6c1602d0f59e4cb89d4a262b12f6e7'
  },
  'linux-x64': {
    asset: 'deno-x86_64-unknown-linux-gnu.zip',
    sha256: '710c54d63477d1100844ef4818f19507ce0dbf40510903b1d883f19e394446a2'
  }
}
export function denoDownloadUrl(pin: DenoAssetPin): string {
  return `${DENO_DOWNLOAD_BASE}/v${DENO_VERSION}/${pin.asset}`
}
/** Deny-by-default container image for the Docker (polyglot) lane's runs. */
export const DOCKER_LANE_IMAGE = 'alpine:3.22'

// ── Security: injection scanner (§13 detection layer — phase 09) ─────────────
/** Content prefix (chars) fed to the local-LLM instruction scan (fits the 4096 window). */
export const INJECTION_SCAN_LLM_MAX_CHARS = 4000
/** Output cap for one scanner verdict ({"suspicious": bool, "reason": string}). */
export const INJECTION_SCAN_LLM_MAX_TOKENS = 128

// ── Storage engine ───────────────────────────────────────────────────────────
/**
 * RyuGraph pin. Spec §5 pins "≥ v0.11.3" in Kùzu-lineage numbering; RyuGraph
 * renumbered to CalVer after the fork — npm `ryugraph@25.9.1` is that lineage's
 * successor. Vector + FTS are NOT bundled in the npm build (phase-00 finding 2):
 * the pinned binaries are vendored in resources/extensions/ and loaded by
 * absolute path — never fetched at runtime (§21 rule 2).
 */
export const RYUGRAPH_VERSION_PIN = '25.9.1'
/**
 * Vendored extension directory name under resources/extensions/. Matches the
 * engine's compiled-in RYU_EXTENSION_VERSION (25.9.0 for ryugraph 25.9.1).
 */
export const RYU_EXTENSION_VERSION_DIR = 'v25.9.0'
