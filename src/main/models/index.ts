/**
 * Model layer barrel (§4, §14) — the rest of the app imports from here.
 */
export {
  OllamaClient,
  OllamaError,
  type FetchLike,
  type GenerateOptions,
  type GenerateResult,
  type OllamaState,
  type OllamaStatus,
  type PullProgress
} from './ollama'
export {
  Reranker,
  RerankerError,
  type DownloadProgress,
  type PairTokenizer,
  type PinnedFile,
  type RerankSession,
  type SessionFactory,
  type TokenizerFactory
} from './reranker'
export {
  AnthropicAdapter,
  CloudBrainError,
  GeminiAdapter,
  OpenAIAdapter,
  OpenRouterAdapter,
  createCloudBrain,
  resetCloudLaneForTests,
  type ChatMessage,
  type ChatRole,
  type CloudAdapterOptions,
  type CloudBrain,
  type CloudProvider,
  type Completion,
  type CompleteOptions,
  type Usage
} from './cloud'
export {
  Keychain,
  KeychainError,
  KEYCHAIN_FILENAME,
  MCP_BEARER_TOKEN_SECRET,
  RUNNER_TOKEN_SECRET,
  SESSION_END_HOOK_TOKEN_SECRET,
  apiKeySecretName,
  keychainPath,
  type KnownSecretName,
  type SafeStorageLike
} from './keychain'
export { CallBudget, CallBudgetExceededError, RunnerQuotaError } from './callBudget'
export {
  FALLBACK_PRICE,
  PRICE_TABLE,
  SpendCeilingExceededError,
  SpendMeter,
  meteredComplete,
  priceFor,
  type ModelPrice,
  type SpendRecord
} from './spend'
export {
  SETTINGS_FILENAME,
  activeCloudModel,
  defaultModelSettings,
  loadModelSettings,
  saveModelSettings,
  settingsPath,
  type ModelSettings
} from './settings'
