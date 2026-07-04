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
/** 30 min of MCP silence per session id → session considered ended. */
export const MCP_INACTIVITY_TIMEOUT_MS = 30 * 60 * 1000

// ── Filesystem layout ────────────────────────────────────────────────────────
/** Spool folder for pending (unprocessed) session transcripts. */
export const SPOOL_DIR = join(homedir(), '.agentic-os', 'pending-sessions')
/** User rules folder. */
export const RULES_DIR = join(homedir(), '.agentic-os', 'rules')

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

// ── Background-job retry ─────────────────────────────────────────────────────
/** 3 attempts, backoff 1 m / 5 m / 25 m, then defer to next run + flag. */
export const JOB_RETRY_ATTEMPTS = 3
export const JOB_RETRY_BACKOFF_MS = [60_000, 300_000, 1_500_000] as const

// ── Spend ────────────────────────────────────────────────────────────────────
/** Per-task spend ceiling (USD); per-task override allowed; live total in dashboard. */
export const SPEND_CEILING_USD_DEFAULT = 0.5

// ── Chunking ─────────────────────────────────────────────────────────────────
/** Split on headings/code fences; target ~512 tokens with 64 overlap. */
export const CHUNK_TARGET_TOKENS = 512
export const CHUNK_OVERLAP_TOKENS = 64

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
