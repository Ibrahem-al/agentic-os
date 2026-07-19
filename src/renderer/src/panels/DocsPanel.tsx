/**
 * Docs panel — the engineering handbook, brought in-app from the marketing
 * site so the same reference lives where the work happens. A left doc-nav
 * (grouped) drives a single scrollable reading column; prev/next walks the
 * pages in order. Pure reading surface: renderer-only, no IPC, no Node.
 */
import { useRef, useState } from 'react'
import { Button, PanelHeader } from '../ui/kit'
import { Icon } from '../ui/icons'
import { DOC_NAV, DOC_ORDER, type DocKey } from '../ui/docs'
import { Overview } from './docs/Overview'
import { Architecture } from './docs/Architecture'
import { Mcp } from './docs/Mcp'
import { Retrieval } from './docs/Retrieval'
import { Memory } from './docs/Memory'
import { Agents } from './docs/Agents'
import { Security } from './docs/Security'
import { Stack } from './docs/Stack'
import { Build } from './docs/Build'

const PAGES: Record<DocKey, () => React.JSX.Element> = {
  overview: Overview,
  architecture: Architecture,
  mcp: Mcp,
  retrieval: Retrieval,
  memory: Memory,
  agents: Agents,
  security: Security,
  stack: Stack,
  build: Build
}

export default function DocsPanel(): React.JSX.Element {
  const [current, setCurrent] = useState<DocKey>('overview')
  const contentRef = useRef<HTMLDivElement>(null)
  const Page = PAGES[current]
  const idx = DOC_ORDER.findIndex((l) => l.key === current)
  const prev = idx > 0 ? (DOC_ORDER[idx - 1] ?? null) : null
  const next = idx >= 0 && idx < DOC_ORDER.length - 1 ? (DOC_ORDER[idx + 1] ?? null) : null

  const go = (key: DocKey): void => {
    setCurrent(key)
    contentRef.current?.scrollTo({ top: 0 })
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <PanelHeader
        title="Docs"
        subtitle="The engineering handbook — how every part of Agentic OS works"
        icon={<Icon name="doc" size={18} />}
      />
      <div className="flex min-h-0 flex-1">
        <nav className="w-60 shrink-0 overflow-y-auto border-r border-line px-3 py-4" aria-label="documentation">
          {DOC_NAV.map((group) => (
            <div key={group.title} className="mb-4">
              <div className="px-2 pb-1 font-mono text-[11px] uppercase tracking-wide text-ink-faint">{group.title}</div>
              {group.links.map((link) => {
                const active = current === link.key
                return (
                  <button
                    key={link.key}
                    type="button"
                    onClick={() => go(link.key)}
                    data-testid={`doc-nav-${link.key}`}
                    aria-current={active ? 'page' : undefined}
                    className={`block w-full cursor-pointer rounded-md px-2 py-1.5 text-left text-[13px] transition-colors duration-120 ${
                      active ? 'bg-raised text-ink' : 'text-ink-mute hover:bg-raised/50 hover:text-ink'
                    }`}
                  >
                    {link.label}
                  </button>
                )
              })}
            </div>
          ))}
        </nav>

        <div ref={contentRef} className="min-w-0 flex-1 overflow-y-auto px-8 py-7" data-testid="docs-content">
          <div className="mx-auto max-w-[80ch]">
            <Page />
            <div className="mt-14 flex items-center justify-between gap-3 border-t border-line pt-5">
              {prev !== null ? (
                <Button onClick={() => go(prev.key)} testId="doc-prev">
                  ← {prev.label}
                </Button>
              ) : (
                <span />
              )}
              {next !== null ? (
                <Button onClick={() => go(next.key)} testId="doc-next">
                  {next.label} →
                </Button>
              ) : (
                <span />
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
