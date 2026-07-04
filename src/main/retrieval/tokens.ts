/**
 * Token counting for bundle assembly (§18 read path step 3, §10).
 *
 * §10's context manager calls for per-provider tokenizers, but no cloud
 * provider ships a local tokenizer in the §20 stack (Anthropic exposes only a
 * counting API; tiktoken would be a new dependency). Phase-03 therefore uses a
 * per-provider *estimating* counter behind the TokenCounter interface —
 * deliberately conservative (overestimates tokens, so a bundle never blows a
 * real budget) — and phase 04's context manager can swap real tokenizers in
 * without touching the pipeline. Rule-12 pick, recorded in the phase report.
 */
import { CLOUD_PROVIDER_DEFAULT, type CloudProvider } from '../config'

export interface TokenCounter {
  count(text: string): number
}

/**
 * Conservative characters-per-token divisors for ASCII text. English prose
 * averages ~4 chars/token on all four providers' tokenizers; using lower
 * divisors overestimates counts by ~15–25% as a safety margin.
 */
const CHARS_PER_TOKEN: Readonly<Record<CloudProvider, number>> = {
  anthropic: 3.3,
  openai: 3.6,
  gemini: 3.6,
  openrouter: 3.6
}

/** Estimating TokenCounter for the given provider (default: active default). */
export function estimatingTokenCounter(provider: CloudProvider = CLOUD_PROVIDER_DEFAULT): TokenCounter {
  const divisor = CHARS_PER_TOKEN[provider]
  return {
    count(text: string): number {
      if (text.length === 0) return 0
      // Non-ASCII (CJK etc.) tokenizes near 1 token/char; billing it at a
      // full token each keeps the estimate an overestimate universally.
      let nonAscii = 0
      for (let i = 0; i < text.length; i++) {
        if (text.charCodeAt(i) > 0x7f) nonAscii += 1
      }
      return Math.ceil((text.length - nonAscii) / divisor) + nonAscii
    }
  }
}
