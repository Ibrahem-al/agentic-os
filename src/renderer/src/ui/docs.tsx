/**
 * In-app documentation atoms (the "Docs" panel) — the prose/spec/callout
 * grammar ported from the marketing site's engineering handbook, remapped onto
 * the app's OKLCH tokens so the same content reads natively inside the console.
 * Pure presentation, renderer-only (no Node, no IPC). Kept separate from
 * kit.tsx because these are long-form reading atoms, not cockpit instruments.
 */
import { useState, type ReactNode } from 'react'

const cn = (...parts: (string | false | null | undefined)[]): string => parts.filter(Boolean).join(' ')

/* --------------------------------------------------------- doc navigation */

export type DocKey =
  | 'overview'
  | 'architecture'
  | 'mcp'
  | 'retrieval'
  | 'memory'
  | 'agents'
  | 'security'
  | 'stack'
  | 'build'

export interface DocLink {
  key: DocKey
  label: string
  blurb: string
}
export interface DocGroup {
  title: string
  links: DocLink[]
}

export const DOC_NAV: DocGroup[] = [
  {
    title: 'start',
    links: [{ key: 'overview', label: 'Overview', blurb: 'What Agentic OS is and how the pieces fit.' }]
  },
  {
    title: 'system design',
    links: [
      { key: 'architecture', label: 'Architecture', blurb: 'The layered system, boot order, and data flow.' },
      { key: 'mcp', label: 'MCP server & connection', blurb: 'Transport, auth, the tool surface, and how Claude connects.' }
    ]
  },
  {
    title: 'internals',
    links: [
      { key: 'retrieval', label: 'Retrieval pipeline', blurb: 'Hybrid search, fusion, rerank, and the self-correcting loop.' },
      { key: 'memory', label: 'Memory & storage', blurb: 'RyuGraph, the graph schema, and the single write lane.' },
      { key: 'agents', label: 'Background agents', blurb: 'Extraction and the nightly skill-improvement loop.' },
      { key: 'security', label: 'Security & sandbox', blurb: 'Deno/Docker lanes, permissions, audit, and undo.' }
    ]
  },
  {
    title: 'engineering',
    links: [
      { key: 'stack', label: 'Tech stack', blurb: 'Every dependency, what it does, and why it is here.' },
      { key: 'build', label: 'Build & ship', blurb: 'Native rebuild, packaging for Mac/Windows, CI, and tests.' }
    ]
  }
]

export const DOC_ORDER: DocLink[] = DOC_NAV.flatMap((g) => g.links)

/* ------------------------------------------------------------ prose atoms */

export function DocProse({ children }: { children: ReactNode }): React.JSX.Element {
  return <div className="flex max-w-[74ch] flex-col gap-5">{children}</div>
}

function slug(children: ReactNode): string {
  return String(children)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '')
}

export function H2({ children }: { children: ReactNode }): React.JSX.Element {
  return (
    <h2 id={slug(children)} className="mt-8 scroll-mt-24 text-[clamp(1.35rem,2.4vw,1.7rem)] font-semibold tracking-[-0.02em] text-ink">
      {children}
    </h2>
  )
}

export function H3({ children }: { children: ReactNode }): React.JSX.Element {
  return (
    <h3 id={slug(children)} className="mt-4 scroll-mt-24 text-[16px] font-semibold text-ink">
      {children}
    </h3>
  )
}

export function P({ children }: { children: ReactNode }): React.JSX.Element {
  return <p className="text-[14.5px] leading-relaxed text-ink-mute">{children}</p>
}

export function Ul({ children }: { children: ReactNode }): React.JSX.Element {
  return <ul className="flex flex-col gap-2 text-[14.5px] leading-relaxed text-ink-mute">{children}</ul>
}

export function Li({ children }: { children: ReactNode }): React.JSX.Element {
  return (
    <li className="flex gap-2.5">
      <span className="mt-2 size-1 shrink-0 rounded-full bg-accent/70" />
      <span className="min-w-0">{children}</span>
    </li>
  )
}

export function Strong({ children }: { children: ReactNode }): React.JSX.Element {
  return <strong className="font-semibold text-ink">{children}</strong>
}

/* ------------------------------------------------------------- code atoms */

/** Inline mono token for prose. */
export function Code({ children }: { children: ReactNode }): React.JSX.Element {
  return <code className="rounded bg-raised px-1.5 py-0.5 font-mono text-[0.86em] text-ink">{children}</code>
}

export function CodeBlock({ code, label }: { code: string; label?: string }): React.JSX.Element {
  const [copied, setCopied] = useState(false)
  const copy = (): void => {
    navigator.clipboard?.writeText(code).then(
      () => {
        setCopied(true)
        window.setTimeout(() => setCopied(false), 1600)
      },
      () => undefined
    )
  }
  const lines = code.replace(/\n$/, '').split('\n')
  return (
    <div className="min-w-0 overflow-hidden rounded-md border border-line-strong bg-bg">
      <div className="flex items-center justify-between border-b border-line bg-surface px-3 py-1.5">
        <span className="font-mono text-[11px] text-ink-faint">{label ?? ''}</span>
        <button
          type="button"
          onClick={copy}
          className="cursor-pointer rounded px-1.5 py-0.5 font-mono text-[11px] text-ink-mute transition-colors hover:bg-raised hover:text-ink"
          aria-label="copy code"
        >
          {copied ? <span className="text-ok">copied</span> : 'copy'}
        </button>
      </div>
      <pre className="overflow-x-auto px-4 py-3 font-mono text-[12.5px] leading-[1.7]">
        <code>
          {lines.map((line, i) => (
            <div key={i} className={isComment(line) ? 'text-ink-faint' : 'text-ink'}>
              {line || ' '}
            </div>
          ))}
        </code>
      </pre>
    </div>
  )
}

const isComment = (line: string): boolean => {
  const t = line.trimStart()
  return t.startsWith('#') || t.startsWith('//')
}

/* --------------------------------------------------------------- callout */

/** A hairline-framed aside for docs. */
export function Callout({
  children,
  tone = 'neutral',
  title
}: {
  children: ReactNode
  tone?: 'neutral' | 'accent' | 'warn'
  title?: string
}): React.JSX.Element {
  const border = tone === 'accent' ? 'border-accent/30' : tone === 'warn' ? 'border-warn/30' : 'border-line-strong'
  const bar = tone === 'accent' ? 'bg-accent' : tone === 'warn' ? 'bg-warn' : 'bg-line-strong'
  return (
    <div className={cn('flex gap-3 rounded-md border bg-surface/60 px-4 py-3', border)}>
      <span className={cn('mt-0.5 w-0.5 shrink-0 self-stretch rounded-full', bar)} />
      <div className="min-w-0 text-[13.5px] leading-relaxed text-ink-mute">
        {title !== undefined && <span className="font-medium text-ink">{title}. </span>}
        {children}
      </div>
    </div>
  )
}

/* --------------------------------------------------------------- spec table */

export function SpecTable({ head, rows }: { head: string[]; rows: ReactNode[][] }): React.JSX.Element {
  return (
    <div className="overflow-x-auto rounded-md border border-line">
      <table className="w-full border-collapse text-[13px]">
        <thead>
          <tr className="bg-surface text-left">
            {head.map((h) => (
              <th key={h} className="border-b border-line-strong px-3 py-2 font-mono text-[11px] font-normal text-ink-mute">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i} className="border-b border-line last:border-0">
              {r.map((cell, j) => (
                <td key={j} className={cn('px-3 py-2 align-top', j === 0 && 'font-mono text-[12px] text-ink')}>
                  {cell}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

/* -------------------------------------------------------------- page header */

export function DocHeader({ kicker, title, intro }: { kicker: string; title: string; intro: string }): React.JSX.Element {
  return (
    <header className="border-b border-line pb-6">
      <div className="font-mono text-[11px] tracking-wide text-accent">{kicker}</div>
      <h1 className="mt-2 text-[clamp(1.9rem,4vw,2.6rem)] font-semibold tracking-[-0.03em] text-ink">{title}</h1>
      <p className="mt-4 max-w-[70ch] text-[clamp(1rem,1.5vw,1.15rem)] leading-relaxed text-ink-mute">{intro}</p>
    </header>
  )
}
