/**
 * The pure block parser for update patch notes (the GitHub release body, an
 * untrusted string — main already strips HTML + caps length). Kept in a
 * JSX-free `.ts` module so it is unit-testable under the node tsconfig; the React
 * renderer lives in `releaseNotes.tsx` and imports from here.
 *
 * Supported grammar — deliberately nothing more:
 *   `#{1,6} ` heading · `-`/`*`/`+`/`N.` bullets (one flat level) ·
 *   ```` ``` ```` fenced verbatim · blank line = separator · else = paragraph.
 * Inline formatting (`**bold**`, `` `code` ``, `[text](url)` → text only) is
 * applied by the renderer, not here.
 */
export type ReleaseNotesBlock =
  | { readonly kind: 'heading'; readonly text: string }
  | { readonly kind: 'para'; readonly text: string }
  | { readonly kind: 'code'; readonly text: string }
  | { readonly kind: 'list'; readonly items: readonly string[] }

const HEADING_RE = /^\s{0,3}#{1,6}\s+(.*)$/
const BULLET_RE = /^\s*(?:[-*+]|\d+\.)\s+(.*)$/
const FENCE_RE = /^\s*```/

/** Parse notes text into a flat block list. Pure + total (never throws). */
export function parseReleaseNotes(text: string): ReleaseNotesBlock[] {
  const blocks: ReleaseNotesBlock[] = []
  let list: string[] | null = null
  let fence: string[] | null = null
  const flushList = (): void => {
    if (list !== null && list.length > 0) blocks.push({ kind: 'list', items: list })
    list = null
  }
  for (const line of text.split(/\r?\n/)) {
    if (FENCE_RE.test(line)) {
      if (fence === null) {
        flushList()
        fence = []
      } else {
        blocks.push({ kind: 'code', text: fence.join('\n') })
        fence = null
      }
      continue
    }
    if (fence !== null) {
      fence.push(line)
      continue
    }
    const heading = HEADING_RE.exec(line)
    if (heading !== null) {
      flushList()
      blocks.push({ kind: 'heading', text: heading[1]!.trim() })
      continue
    }
    const bullet = BULLET_RE.exec(line)
    if (bullet !== null) {
      ;(list ??= []).push(bullet[1]!.trim())
      continue
    }
    if (line.trim() === '') {
      flushList()
      continue
    }
    flushList()
    blocks.push({ kind: 'para', text: line.trim() })
  }
  // Graceful close of an unterminated fence.
  if (fence !== null && fence.length > 0) blocks.push({ kind: 'code', text: fence.join('\n') })
  flushList()
  return blocks
}
