/**
 * Memory panel (phase 10, spec §3 "explore the graph"): browse label counts →
 * paged node lists, hybrid search (vector + keyword + rerank) across the
 * retrievable labels, and a master-detail node inspector with edge navigation
 * and a back stack. VARIANCE 4: two-column 3fr/2fr split, each side scrolls
 * independently.
 *
 * Plain-language redesign: the counts lead with a CompositionBar ("what memory
 * holds") over a labelled list where each category carries a one-line
 * description; search hits read as text + a single "match" meter with the raw
 * ranking signals tucked behind a Disclosure; the inspector leads with the
 * human handle and keeps ids / complex JSON behind "Technical details". The
 * label chip keeps its exact two-span "<Label> <count>" contract (e2e selects
 * it by accessible name); the plain description lives in a SEPARATE element.
 */
import { useCallback, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import type {
  IpcNodeLabel,
  JsonValue,
  MemoryEdgeDto,
  MemoryNodeSummaryDto,
  MemorySearchHitDto
} from '../../../shared/ipc'
import { IpcError, call, useIpc } from '../lib/ipc'
import { truncate } from '../lib/format'
import {
  Button,
  Confidence,
  DataTable,
  Disclosure,
  EmptyState,
  ErrorState,
  KV,
  LoadingRows,
  PanelHeader,
  SectionHeader,
  TextInput,
  Timestamp
} from '../ui/kit'
import type { Column } from '../ui/kit'
import { CompositionBar } from '../ui/viz'
import { Icon } from '../ui/icons'

const PAGE_SIZE = 50

/**
 * One plain sentence per graph label so a less technical reader knows what each
 * category actually is. Record over IpcNodeLabel keeps this exhaustive — a new
 * label fails the build until it gets a description here.
 */
const LABEL_DESCRIPTIONS: Readonly<Record<IpcNodeLabel, string>> = {
  Session: 'Past work sessions',
  Project: 'Projects it knows',
  Skill: 'Learned abilities',
  SkillVersion: 'Skill revisions',
  Example: 'Examples it learned from',
  Correction: 'Corrections you made',
  Preference: 'Your preferences',
  MCP: 'Technical building blocks',
  Plugin: 'Technical building blocks',
  Component: 'Technical building blocks',
  Document: 'Documents added',
  Knowledge: 'Facts and notes',
  Tag: 'Labels'
}

// Cycled across the composition segments so adjacent categories stay distinct;
// tokens only (see viz CompTint), never semantic here — memory holds no state.
const COMP_TINTS = ['accent', 'ok', 'warn', 'undo', 'mute'] as const

interface NodeRef {
  readonly label: IpcNodeLabel
  readonly id: string
  /** Human handle carried from the list row / edge so the inspector can lead with it. */
  readonly display?: string
}

interface ListState {
  readonly label: IpcNodeLabel
  readonly rows: readonly MemoryNodeSummaryDto[]
  readonly total: number
  readonly loading: boolean
  readonly error: IpcError | null
}

interface SearchState {
  readonly query: string
  readonly hits: readonly MemorySearchHitDto[] | null
  readonly loading: boolean
  readonly error: IpcError | null
}

function toIpcError(err: unknown): IpcError {
  return err instanceof IpcError ? err : new IpcError('INTERNAL', String(err))
}

function nodeKey(ref: { readonly label: IpcNodeLabel; readonly id: string }): string {
  return `${ref.label}:${ref.id}`
}

/** Raw graph edge/prop token → plain lowercase words ("RELATES_TO" → "relates to"). */
function plainWords(raw: string): string {
  return raw.toLowerCase().replace(/_/g, ' ')
}

// ── prop rendering ────────────────────────────────────────────────────────────

function renderPropValue(key: string, value: JsonValue): ReactNode {
  if ((key === 'created_at' || key === 'updated_at') && typeof value === 'string') {
    return <Timestamp iso={value} />
  }
  if (typeof value === 'string') {
    return <span className="font-mono text-[12px] break-words whitespace-pre-wrap">{value}</span>
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return <span className="font-mono text-[12px]">{String(value)}</span>
  }
  return (
    <span className="font-mono text-[12px] break-words whitespace-pre-wrap">{JSON.stringify(value)}</span>
  )
}

// ── edges ─────────────────────────────────────────────────────────────────────

function groupEdges(edges: readonly MemoryEdgeDto[]): readonly (readonly [string, readonly MemoryEdgeDto[]])[] {
  const map = new Map<string, MemoryEdgeDto[]>()
  for (const edge of edges) {
    const bucket = map.get(edge.type)
    if (bucket !== undefined) bucket.push(edge)
    else map.set(edge.type, [edge])
  }
  return [...map.entries()]
}

function EdgeSection({
  title,
  emptyText,
  edges,
  onNavigate
}: {
  title: string
  emptyText: string
  edges: readonly MemoryEdgeDto[]
  onNavigate: (ref: NodeRef) => void
}): React.JSX.Element {
  return (
    <section className="mt-5">
      <SectionHeader meta={edges.length === 0 ? undefined : String(edges.length)}>{title}</SectionHeader>
      {edges.length === 0 ? (
        <div className="text-[12px] text-ink-mute">{emptyText}</div>
      ) : (
        groupEdges(edges).map(([type, group]) => (
          <div key={type} className="mb-3">
            <div className="border-b border-line pb-1 text-[12px] text-ink-mute">{plainWords(type)}</div>
            <ul>
              {group.map((edge, i) => {
                // Provenance (where the edge came from) rides in the tooltip — a
                // technical id, not the first thing the row should say.
                const extractedBy =
                  typeof edge.props['extracted_by'] === 'string' ? edge.props['extracted_by'] : null
                const confidence =
                  typeof edge.props['confidence'] === 'number' ? edge.props['confidence'] : null
                const detail = extractedBy !== null ? `${nodeKey(edge)} · ${extractedBy}` : nodeKey(edge)
                return (
                  <li
                    key={`${edge.label}:${edge.id}:${i}`}
                    className="flex min-h-[34px] flex-wrap items-center gap-x-2.5 gap-y-0.5 border-b border-line py-1.5"
                  >
                    <button
                      type="button"
                      onClick={() => onNavigate({ label: edge.label, id: edge.id, display: edge.display })}
                      className="min-w-0 cursor-pointer text-left text-[12px] text-accent transition-colors duration-120 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
                      title={detail}
                    >
                      {truncate(edge.display, 120)}
                    </button>
                    {confidence !== null && <Confidence value={confidence} />}
                  </li>
                )
              })}
            </ul>
          </div>
        ))
      )}
    </section>
  )
}

// ── inspector ─────────────────────────────────────────────────────────────────

function Inspector({
  nodeRef,
  canBack,
  onBack,
  onNavigate
}: {
  nodeRef: NodeRef
  canBack: boolean
  onBack: () => void
  onNavigate: (ref: NodeRef) => void
}): React.JSX.Element {
  const detail = useIpc('memory.node', { label: nodeRef.label, id: nodeRef.id })
  if (detail.error !== null) return <ErrorState error={detail.error} onRetry={detail.reload} />
  if (detail.loading || detail.data === null) return <LoadingRows rows={6} />

  const node = detail.data
  const extractedBy = typeof node.props['extracted_by'] === 'string' ? node.props['extracted_by'] : null
  const confidence = typeof node.props['confidence'] === 'number' ? node.props['confidence'] : null
  const entries = Object.entries(node.props).filter(
    ([key, value]) => value !== null && key !== 'extracted_by' && key !== 'confidence'
  )
  // Plain-first: primitive props read in the KV; nested JSON is technical detail.
  const simple = entries.filter(([, value]) => typeof value !== 'object')
  const complex = entries.filter(([, value]) => typeof value === 'object')
  const heading = nodeRef.display ?? node.id

  return (
    <div className="px-4 py-3">
      <div className="flex items-center gap-2.5">
        {canBack && <Button onClick={onBack}>back</Button>}
        <span className="text-[12px] text-ink-mute">{node.label}</span>
      </div>
      <div className="mt-1.5 text-[14px] break-words">{heading}</div>
      {(extractedBy !== null || confidence !== null) && (
        <div className="mt-2.5 flex flex-wrap items-center gap-x-2.5 gap-y-1 border-b border-line pb-2.5 text-[12px] text-ink-mute">
          {extractedBy !== null && (
            <span>
              where this came from: <span className="font-mono text-[11px]">{extractedBy}</span>
            </span>
          )}
          {confidence !== null && <Confidence value={confidence} />}
        </div>
      )}
      <div className="mt-3">
        {simple.length === 0 ? (
          <div className="text-[12px] text-ink-mute">Nothing else is recorded about this.</div>
        ) : (
          <KV entries={simple.map(([key, value]) => ({ k: plainWords(key), v: renderPropValue(key, value) }))} />
        )}
      </div>
      {complex.length > 0 && (
        <div className="mt-3">
          <Disclosure summary="Technical details">
            <div className="mb-2 text-[12px] text-ink-mute">
              id <span className="font-mono break-all">{node.id}</span>
            </div>
            <KV entries={complex.map(([key, value]) => ({ k: key, v: renderPropValue(key, value) }))} />
          </Disclosure>
        </div>
      )}
      <EdgeSection
        title="Connected to"
        emptyText="This isn't connected to anything else yet."
        edges={node.outgoing}
        onNavigate={onNavigate}
      />
      <EdgeSection
        title="Connected from"
        emptyText="Nothing else points to this yet."
        edges={node.incoming}
        onNavigate={onNavigate}
      />
    </div>
  )
}

// ── tables ────────────────────────────────────────────────────────────────────

const LIST_COLUMNS: readonly Column<MemoryNodeSummaryDto>[] = [
  {
    key: 'display',
    header: 'what it is',
    render: (row) => <span>{truncate(row.display, 160)}</span>
  },
  {
    key: 'updated',
    header: 'last updated',
    className: 'whitespace-nowrap',
    render: (row) => <Timestamp iso={row.updatedAt} />
  }
]

// ── panel ─────────────────────────────────────────────────────────────────────

export default function MemoryPanel(): React.JSX.Element {
  const counts = useIpc('memory.counts', undefined)
  const [query, setQuery] = useState('')
  const [search, setSearch] = useState<SearchState | null>(null)
  const [list, setList] = useState<ListState | null>(null)
  const [stack, setStack] = useState<readonly NodeRef[]>([])
  const listGen = useRef(0)
  const searchGen = useRef(0)

  const current = stack.length > 0 ? stack[stack.length - 1] : undefined
  const currentKey = current !== undefined ? nodeKey(current) : null

  const loadPage = useCallback((label: IpcNodeLabel, prior: readonly MemoryNodeSummaryDto[]) => {
    const gen = ++listGen.current
    setList((old) => ({
      label,
      rows: prior,
      total: old !== null && old.label === label ? old.total : prior.length,
      loading: true,
      error: null
    }))
    call('memory.list', { label, limit: PAGE_SIZE, offset: prior.length })
      .then((res) => {
        if (listGen.current !== gen) return
        setList({ label, rows: [...prior, ...res.rows], total: res.total, loading: false, error: null })
      })
      .catch((err: unknown) => {
        if (listGen.current !== gen) return
        setList({ label, rows: prior, total: prior.length, loading: false, error: toIpcError(err) })
      })
  }, [])

  const runSearch = useCallback((raw: string) => {
    const trimmed = raw.trim()
    if (trimmed === '') return
    const gen = ++searchGen.current
    setSearch({ query: trimmed, hits: null, loading: true, error: null })
    call('memory.search', { query: trimmed })
      .then((hits) => {
        if (searchGen.current !== gen) return
        setSearch({ query: trimmed, hits, loading: false, error: null })
      })
      .catch((err: unknown) => {
        if (searchGen.current !== gen) return
        setSearch({ query: trimmed, hits: null, loading: false, error: toIpcError(err) })
      })
  }, [])

  const clearSearch = useCallback(() => {
    searchGen.current += 1
    setSearch(null)
    setQuery('')
  }, [])

  const inspect = useCallback((ref: NodeRef) => {
    setStack([ref])
  }, [])

  const navigate = useCallback((ref: NodeRef) => {
    setStack((old) => {
      const top = old.length > 0 ? old[old.length - 1] : undefined
      if (top !== undefined && top.label === ref.label && top.id === ref.id) return old
      return [...old, ref]
    })
  }, [])

  const goBack = useCallback(() => {
    setStack((old) => old.slice(0, -1))
  }, [])

  // ── left column bodies ──────────────────────────────────────────────────────

  let browseBody: ReactNode
  if (counts.error !== null) {
    browseBody = <ErrorState error={counts.error} onRetry={counts.reload} />
  } else if (counts.data === null) {
    browseBody = <LoadingRows rows={6} />
  } else {
    const total = counts.data.reduce((sum, c) => sum + c.count, 0)
    const segments = counts.data.map((c, i) => ({
      label: c.label,
      count: c.count,
      tint: COMP_TINTS[i % COMP_TINTS.length] ?? 'accent'
    }))
    browseBody = (
      <>
        <div className="border-b border-line px-4 py-3">
          <CompositionBar segments={segments} ariaLabel="What memory holds" />
          <div className="mt-2 text-[12px] text-ink-mute">
            {total === 0
              ? 'Nothing remembered yet.'
              : `${total.toLocaleString()} ${total === 1 ? 'thing' : 'things'} remembered`}
          </div>
        </div>
        <div className="flex flex-col gap-1 px-4 py-3">
          {counts.data.map((c) => {
            const selected = list !== null && list.label === c.label
            return (
              <div key={c.label}>
                {/* Two spans only, no extra content — e2e selects this button by its
                    "<Label> <count>" accessible name (a title does not change that).
                    The plain description moves into the tooltip to keep the list
                    compact instead of an always-visible line under every chip. */}
                <button
                  type="button"
                  onClick={() => loadPage(c.label, [])}
                  title={LABEL_DESCRIPTIONS[c.label]}
                  className={`inline-flex cursor-pointer items-baseline gap-1.5 rounded-md px-2 py-1 text-[12px] transition-colors duration-120 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent ${
                    selected
                      ? 'bg-raised text-ink shadow-[inset_2px_0_0_var(--color-accent)]'
                      : 'text-ink-mute hover:bg-raised hover:text-ink'
                  }`}
                >
                  <span>{c.label}</span>
                  <span className="font-mono text-[11px]">{c.count}</span>
                </button>
              </div>
            )
          })}
        </div>
        {list === null ? (
          <EmptyState>Pick a category above to see what&apos;s in it, or search everything.</EmptyState>
        ) : (
          <>
            <div className="px-4">
              <SectionHeader
                meta={
                  <span className="font-mono text-[11px]">
                    {list.rows.length} of {list.total}
                  </span>
                }
              >
                {list.label}
              </SectionHeader>
            </div>
            {list.error !== null && (
              <ErrorState error={list.error} onRetry={() => loadPage(list.label, list.rows)} />
            )}
            <DataTable
              columns={LIST_COLUMNS}
              rows={list.rows}
              rowKey={nodeKey}
              onRowClick={inspect}
              selectedKey={currentKey}
              empty={list.loading ? 'loading' : `Nothing under ${list.label} yet.`}
            />
            {list.loading && <LoadingRows rows={3} />}
            {!list.loading && list.rows.length < list.total && (
              <div className="px-4 py-3">
                <Button onClick={() => loadPage(list.label, list.rows)}>Show more</Button>
              </div>
            )}
          </>
        )}
      </>
    )
  }

  let searchBody: ReactNode = null
  if (search !== null) {
    if (search.loading) {
      searchBody = <LoadingRows />
    } else if (search.error !== null) {
      searchBody = <ErrorState error={search.error} onRetry={() => runSearch(search.query)} />
    } else {
      const hits = search.hits ?? []
      searchBody = (
        <>
          <div className="px-4">
            <SectionHeader
              meta={
                <span className="font-mono text-[11px]">
                  {hits.length} {hits.length === 1 ? 'match' : 'matches'}
                </span>
              }
            >
              Results for &apos;{search.query}&apos;
            </SectionHeader>
          </div>
          {hits.length === 0 ? (
            <EmptyState>Nothing matched &apos;{search.query}&apos;. Try different words.</EmptyState>
          ) : (
            <ul>
              {hits.map((hit) => {
                const key = nodeKey(hit)
                const selected = currentKey === key
                return (
                  <li
                    key={key}
                    data-rowkey={key}
                    className={`border-b border-line px-4 py-3 ${
                      selected ? 'bg-raised shadow-[inset_2px_0_0_var(--color-accent)]' : ''
                    }`}
                  >
                    <button
                      type="button"
                      onClick={() => inspect({ label: hit.label, id: hit.id, display: hit.text })}
                      className="block w-full cursor-pointer text-left text-[13px] break-words transition-colors duration-120 hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
                    >
                      {truncate(hit.text, 200)}
                    </button>
                    <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px] text-ink-mute">
                      <span className="inline-flex items-center gap-1.5">
                        match <Confidence value={hit.rerankScore} />
                      </span>
                      <span>{hit.label}</span>
                    </div>
                    <div className="mt-1">
                      <Disclosure summary="How this matched">
                        <div className="grid grid-cols-[1fr_auto] gap-x-4 gap-y-1 text-[12px]">
                          <span className="text-ink-mute">meaning match (vector)</span>
                          <span className="text-right font-mono">{hit.signals.vector.toFixed(3)}</span>
                          <span className="text-ink-mute">word match (keyword)</span>
                          <span className="text-right font-mono">{hit.signals.keyword.toFixed(3)}</span>
                          <span className="text-ink-mute">related in memory (graph)</span>
                          <span className="text-right font-mono">{hit.signals.graph.toFixed(3)}</span>
                          <span className="text-ink-mute">combined score (fused)</span>
                          <span className="text-right font-mono">{hit.fusedScore.toFixed(3)}</span>
                        </div>
                      </Disclosure>
                    </div>
                  </li>
                )
              })}
            </ul>
          )}
        </>
      )
    }
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <PanelHeader
        title="Memory"
        subtitle="Everything your assistant knows and remembers"
        icon={<Icon name="memory" size={18} />}
        actions={
          <>
            <TextInput
              value={query}
              onChange={setQuery}
              placeholder="Search everything it knows…"
              ariaLabel="Search everything it knows"
              testId="memory-search-input"
              onEnter={() => runSearch(query)}
              width="w-80"
            />
            {search !== null && <Button onClick={clearSearch}>clear</Button>}
          </>
        }
      />
      <div className="grid min-h-0 flex-1 grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
        <div className="min-h-0 overflow-y-auto border-r border-line">
          {search !== null ? searchBody : browseBody}
        </div>
        <div className="min-h-0 overflow-y-auto" data-testid="memory-inspector">
          {current === undefined ? (
            <EmptyState>Pick something on the left to see its details.</EmptyState>
          ) : (
            <Inspector
              nodeRef={current}
              canBack={stack.length > 1}
              onBack={goBack}
              onNavigate={navigate}
            />
          )}
        </div>
      </div>
    </div>
  )
}
