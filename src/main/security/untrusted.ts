/**
 * UntrustedText (§13 prompt-injection defense, §21 rule 5) — the type-level
 * containment layer: ingested / tool / document content is wrapped at its
 * BOUNDARY (file read, MCP argument, watched-folder scan) and travels the
 * pipeline as this class, which is deliberately NOT assignable to string.
 *
 * It can therefore never reach a tool-call constructor, a KernelAction, a
 * sandbox entry path, or a Cypher statement — all of which take `string` —
 * without passing through one of the two NAMED unwrap functions below, whose
 * only legitimate call sites are data sinks:
 *
 *  - `untrustedForStorage(u)` — content becoming inert stored data (node
 *    properties, chunks, embedding input). Stored content is data forever;
 *    the read path returns it as bundle text, never as instructions.
 *  - `untrustedForPromptData(u)` — content embedded in a model prompt AS
 *    DATA (the scanner's subject, extraction transcripts). The model may
 *    describe it; nothing it says becomes a tool call except through the
 *    §13-gated write paths.
 *
 * Coercion traps: toString / Symbol.toPrimitive / toJSON return or produce a
 * redacted marker (never the content), so accidental interpolation into a
 * query, log line, or serialized payload leaks nothing.
 */
import { createHash } from 'node:crypto'

export class UntrustedText {
  readonly #value: string

  private constructor(value: string) {
    this.#value = value
  }

  /** Wrap boundary content. The only way in. */
  static wrap(value: string): UntrustedText {
    return new UntrustedText(value)
  }

  /** Content length (safe metadata). */
  get length(): number {
    return this.#value.length
  }

  /** sha256 of the content (safe metadata — dedup keys, flag rows). */
  get sha256(): string {
    return createHash('sha256').update(this.#value, 'utf8').digest('hex')
  }

  /** True when the content is empty/whitespace (safe predicate). */
  isBlank(): boolean {
    return this.#value.trim() === ''
  }

  /** True when the content contains `needle` (safe predicate; e.g. NUL sniff). */
  includes(needle: string): boolean {
    return this.#value.includes(needle)
  }

  /** Internal accessor for the named unwrap functions below. */
  static valueForSink(u: UntrustedText): string {
    return u.#value
  }

  // ── coercion traps: interpolation/serialization never leaks content ───────
  toString(): string {
    return `[UntrustedText sha256:${this.sha256.slice(0, 8)} length:${this.length}]`
  }

  toJSON(): string {
    return this.toString()
  }

  [Symbol.toPrimitive](): string {
    return this.toString()
  }
}

/** Wrap boundary content (file reads, MCP args, watched-folder scans). */
export function untrusted(value: string): UntrustedText {
  return UntrustedText.wrap(value)
}

/**
 * SINK: the content is becoming inert stored data (§21 rule 5) — chunked,
 * embedded, stored as node properties. Call only inside storage-bound
 * pipelines (ingest/knowledge.ts is the canonical site).
 */
export function untrustedForStorage(u: UntrustedText): string {
  return UntrustedText.valueForSink(u)
}

/**
 * SINK: the content is being embedded in a model prompt AS DATA (scanner
 * subject, extraction transcript). Never concatenate the result into
 * anything that executes.
 */
export function untrustedForPromptData(u: UntrustedText): string {
  return UntrustedText.valueForSink(u)
}
