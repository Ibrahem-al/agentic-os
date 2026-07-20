/**
 * A tiny, SAFE markdown-lite renderer for update patch notes (the GitHub release
 * body, an untrusted string in UpdaterStatusDto.releaseNotes — main already
 * strips HTML + caps length). We render the closed grammar parsed by
 * `releaseNotesParser` as React elements whose children are all strings, so React
 * escapes everything: there is NO `dangerouslySetInnerHTML` and NO way for the
 * notes to inject markup — the second of two independent safety layers.
 *
 * Inline (applied here): `**bold**` / `__bold__`, `` `code` ``, and
 * `[text](url)` → the text ONLY (the URL is dropped, so there is no link scheme
 * to validate; a bare URL stays as visible, non-clickable text).
 */
import type { ReactNode } from 'react'
import { parseReleaseNotes } from './releaseNotesParser'

const INLINE_RE = /(\*\*|__)(.+?)\1|`([^`]+?)`|\[([^\]]+?)\]\([^)]*\)/g

/** Tokenize one text run into React nodes (bold / code / link-text / literal). */
function renderInline(text: string, keyBase: string): ReactNode[] {
  const out: ReactNode[] = []
  let last = 0
  let i = 0
  INLINE_RE.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = INLINE_RE.exec(text)) !== null) {
    if (m.index > last) out.push(text.slice(last, m.index))
    if (m[2] !== undefined) {
      out.push(<strong key={`${keyBase}-${i}`}>{m[2]}</strong>)
    } else if (m[3] !== undefined) {
      out.push(
        <code key={`${keyBase}-${i}`} className="rounded bg-raised px-1 font-mono text-[11px]">
          {m[3]}
        </code>
      )
    } else if (m[4] !== undefined) {
      out.push(m[4]) // link text only — URL discarded (no scheme to validate)
    }
    last = INLINE_RE.lastIndex
    i += 1
  }
  if (last < text.length) out.push(text.slice(last))
  return out
}

/** Render the patch notes as safe React elements. */
export function ReleaseNotes({ text }: { text: string }): React.JSX.Element {
  const blocks = parseReleaseNotes(text)
  return (
    <div className="flex flex-col gap-1.5 text-[12px] leading-5 text-ink">
      {blocks.map((block, i) => {
        if (block.kind === 'heading') {
          return (
            <p key={i} className="font-medium">
              {renderInline(block.text, `h${i}`)}
            </p>
          )
        }
        if (block.kind === 'code') {
          return (
            <pre key={i} className="overflow-x-auto rounded bg-raised px-2 py-1.5 font-mono text-[11px] whitespace-pre-wrap">
              {block.text}
            </pre>
          )
        }
        if (block.kind === 'list') {
          return (
            <ul key={i} className="flex list-disc flex-col gap-0.5 pl-4">
              {block.items.map((item, j) => (
                <li key={j}>{renderInline(item, `l${i}-${j}`)}</li>
              ))}
            </ul>
          )
        }
        return <p key={i}>{renderInline(block.text, `p${i}`)}</p>
      })}
    </div>
  )
}
