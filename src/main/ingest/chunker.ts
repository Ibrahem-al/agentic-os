/**
 * Structure-aware document chunker (§20 chunking: split on headings/code
 * fences, target ~512 tokens, 64 overlap).
 *
 * The document is first parsed into atomic blocks — ATX headings, fenced code
 * blocks, and blank-line-separated paragraphs — then blocks are packed
 * greedily into chunks up to the token target:
 *
 * - a heading ALWAYS starts a new chunk (headings are chunk boundaries);
 * - a code fence is atomic — a boundary never falls inside it — unless the
 *   block alone exceeds the target, in which case it is split by lines and
 *   every piece is re-wrapped in the original fence markers;
 * - when a chunk fills mid-section, the next chunk is seeded with the last
 *   ~overlap tokens of the previous one (line-granular), so no fact sits
 *   unreadably on a cut point. Overlap is never carried across a heading
 *   boundary — the heading IS the clean break.
 *
 * Token counts use the phase-03 estimating counter (conservative: it
 * overestimates, so "~512" holds against any real tokenizer). Pure module —
 * no storage, no models, no I/O.
 */
import { CHUNK_OVERLAP_TOKENS, CHUNK_TARGET_TOKENS } from '../config'
import { estimatingTokenCounter, type TokenCounter } from '../retrieval/tokens'

export type ChunkFormat = 'markdown' | 'plain'

export interface ChunkOptions {
  /** markdown = headings + fences are structure; plain = paragraphs only. */
  readonly format?: ChunkFormat
  readonly targetTokens?: number
  readonly overlapTokens?: number
}

export interface DocumentChunk {
  /** 0-based position within the document. */
  readonly index: number
  /** The chunk text exactly as it appears in the source (+ overlap seed). */
  readonly text: string
  /** Estimated tokens of `text`. */
  readonly tokens: number
  /** Enclosing heading titles at this chunk's start (outermost first). */
  readonly headingTrail: readonly string[]
}

interface Block {
  readonly kind: 'heading' | 'code' | 'paragraph'
  readonly text: string
  /** Heading level 1..6; 0 for non-headings. */
  readonly level: number
}

const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})/
const FENCE_CLOSE = /^ {0,3}(`{3,}|~{3,})\s*$/
const ATX_HEADING = /^ {0,3}(#{1,6})\s+\S/

function parseMarkdownBlocks(text: string): Block[] {
  const lines = text.split('\n')
  const blocks: Block[] = []
  let para: string[] = []
  const flushPara = (): void => {
    const joined = para.join('\n')
    if (joined.trim() !== '') blocks.push({ kind: 'paragraph', text: joined, level: 0 })
    para = []
  }
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] as string
    const fence = FENCE_OPEN.exec(line)
    if (fence) {
      flushPara()
      const marker = fence[1] as string
      const codeLines = [line]
      i += 1
      for (; i < lines.length; i++) {
        codeLines.push(lines[i] as string)
        const close = FENCE_CLOSE.exec(lines[i] as string)
        if (close && (close[1] as string)[0] === marker[0] && (close[1] as string).length >= marker.length) break
      }
      blocks.push({ kind: 'code', text: codeLines.join('\n'), level: 0 })
      continue
    }
    const heading = ATX_HEADING.exec(line)
    if (heading) {
      flushPara()
      blocks.push({ kind: 'heading', text: line.trim(), level: (heading[1] as string).length })
      continue
    }
    if (line.trim() === '') {
      flushPara()
      continue
    }
    para.push(line)
  }
  flushPara()
  return blocks
}

function parsePlainBlocks(text: string): Block[] {
  return text
    .split(/\n[ \t]*\n/)
    .map((p) => p.replace(/^\n+|\n+$/g, ''))
    .filter((p) => p.trim() !== '')
    .map((p) => ({ kind: 'paragraph' as const, text: p, level: 0 }))
}

/** Trailing lines of `text` totalling at most `budget` estimated tokens. */
function overlapTail(text: string, budget: number, counter: TokenCounter): string {
  if (budget < 1) return ''
  const lines = text.split('\n')
  const tail: string[] = []
  let tokens = 0
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i] as string
    if (line.trim() === '' && tail.length === 0) continue
    const lineTokens = counter.count(line) + 1
    if (tokens + lineTokens > budget) break
    tail.unshift(line)
    tokens += lineTokens
  }
  return tail.join('\n').trim() === '' ? '' : tail.join('\n')
}

/** Hard character split for a single line longer than the piece budget. */
function splitLongLine(line: string, budgetTokens: number, counter: TokenCounter): string[] {
  const pieces: string[] = []
  let rest = line
  // ~3 chars/token lower bound keeps every slice under budget for the
  // estimating counter; loop guards against pathological non-ASCII anyway.
  const sliceChars = Math.max(8, Math.floor(budgetTokens * 3))
  while (counter.count(rest) > budgetTokens && rest.length > sliceChars) {
    pieces.push(rest.slice(0, sliceChars))
    rest = rest.slice(sliceChars)
  }
  if (rest !== '') pieces.push(rest)
  return pieces
}

/**
 * Split one oversized block into ≤target pieces (line-granular, overlap
 * carried between consecutive pieces). Code blocks keep their fence markers
 * on every piece so no chunk carries an unterminated fence.
 */
function splitOversizedBlock(
  block: Block,
  target: number,
  overlap: number,
  counter: TokenCounter
): string[] {
  let bodyLines: string[]
  let prefix = ''
  let suffix = ''
  if (block.kind === 'code') {
    const all = block.text.split('\n')
    prefix = all[0] as string
    const last = all[all.length - 1] as string
    const closed = all.length > 1 && FENCE_CLOSE.test(last)
    suffix = closed ? last : (FENCE_OPEN.exec(prefix)?.[1] ?? '```')
    bodyLines = all.slice(1, closed ? -1 : undefined)
  } else {
    bodyLines = block.text.split('\n')
  }
  const wrapTokens = prefix === '' ? 0 : counter.count(`${prefix}\n${suffix}\n`)
  const budget = Math.max(16, target - wrapTokens)

  const pieces: string[][] = []
  let current: string[] = []
  let currentTokens = 0
  const pushPiece = (): void => {
    if (current.length > 0) pieces.push(current)
    current = []
    currentTokens = 0
  }
  for (const line of bodyLines) {
    const lineTokens = counter.count(line) + 1
    if (lineTokens > budget) {
      // Pathological single line (minified content): hard character split.
      pushPiece()
      for (const slice of splitLongLine(line, budget, counter)) pieces.push([slice])
      continue
    }
    if (currentTokens + lineTokens > budget && current.length > 0) {
      const finished = current
      pieces.push(finished)
      const tail = overlapTail(finished.join('\n'), overlap, counter)
      current = tail === '' ? [] : tail.split('\n')
      currentTokens = tail === '' ? 0 : counter.count(tail)
      // Overlap must never eat the whole budget — forward progress wins.
      if (currentTokens + lineTokens > budget) {
        current = []
        currentTokens = 0
      }
    }
    current.push(line)
    currentTokens += lineTokens
  }
  pushPiece()
  const wrap = (lines: string[]): string =>
    prefix === '' ? lines.join('\n') : [prefix, ...lines, suffix].join('\n')
  return pieces.map(wrap)
}

/**
 * Chunk a document per §20: headings/code fences are structural boundaries,
 * chunks target ~`targetTokens` with `overlapTokens` of line-granular overlap
 * between size-split neighbors. Returns [] for whitespace-only content.
 */
export function chunkDocument(content: string, options: ChunkOptions = {}): DocumentChunk[] {
  const target = options.targetTokens ?? CHUNK_TARGET_TOKENS
  const overlap = options.overlapTokens ?? CHUNK_OVERLAP_TOKENS
  if (!Number.isInteger(target) || target < 16) {
    throw new Error(`chunkDocument: targetTokens must be an integer ≥ 16, got ${target}`)
  }
  if (!Number.isInteger(overlap) || overlap < 0 || overlap >= target) {
    throw new Error(`chunkDocument: overlapTokens must satisfy 0 ≤ overlap < target, got ${overlap}`)
  }
  const counter = estimatingTokenCounter()
  const normalized = content.replace(/\r\n/g, '\n')
  const blocks =
    (options.format ?? 'markdown') === 'plain' ? parsePlainBlocks(normalized) : parseMarkdownBlocks(normalized)

  const chunks: DocumentChunk[] = []
  const trail: { level: number; title: string }[] = []
  let parts: string[] = []
  let partTokens = 0
  const separatorTokens = counter.count('\n\n')

  const trailTitles = (): string[] => trail.map((t) => t.title)
  const flush = (): string => {
    const text = parts.join('\n\n')
    parts = []
    partTokens = 0
    if (text.trim() === '') return ''
    chunks.push({ index: chunks.length, text, tokens: counter.count(text), headingTrail: trailTitles() })
    return text
  }

  for (const block of blocks) {
    if (block.kind === 'heading') {
      // Chunk boundary: flush without overlap — the heading is the clean break.
      flush()
      while (trail.length > 0 && (trail[trail.length - 1] as { level: number }).level >= block.level) trail.pop()
      trail.push({ level: block.level, title: block.text.replace(/^ {0,3}#{1,6}\s+/, '').trim() })
      parts = [block.text]
      partTokens = counter.count(block.text)
      continue
    }

    const blockTokens = counter.count(block.text)
    if (blockTokens > target) {
      // Oversized block: split by lines. Pending prose (e.g. the section's
      // heading) merges into the split so it is never orphaned as a tiny
      // chunk — except before a code fence, whose pieces must stay pure
      // fence-wrapped code.
      let toSplit = block
      if (block.kind !== 'code' && parts.length > 0) {
        toSplit = { kind: 'paragraph', text: `${parts.join('\n\n')}\n\n${block.text}`, level: 0 }
        parts = []
        partTokens = 0
      } else {
        flush()
      }
      const pieces = splitOversizedBlock(toSplit, target, overlap, counter)
      for (let i = 0; i < pieces.length - 1; i++) {
        const piece = pieces[i] as string
        chunks.push({ index: chunks.length, text: piece, tokens: counter.count(piece), headingTrail: trailTitles() })
      }
      const lastPiece = pieces[pieces.length - 1]
      if (lastPiece !== undefined) {
        parts = [lastPiece]
        partTokens = counter.count(lastPiece)
      }
      continue
    }

    const extra = (partTokens > 0 ? separatorTokens : 0) + blockTokens
    if (partTokens + extra > target && partTokens > 0) {
      // Size boundary mid-section: flush and seed the next chunk with overlap.
      const flushed = flush()
      const seed = overlapTail(flushed, overlap, counter)
      if (seed !== '') {
        parts = [seed]
        partTokens = counter.count(seed)
      }
    }
    parts.push(block.text)
    partTokens += (parts.length > 1 ? separatorTokens : 0) + blockTokens
  }
  flush()
  return chunks
}
