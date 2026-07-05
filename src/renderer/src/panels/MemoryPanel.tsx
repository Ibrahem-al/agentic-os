/**
 * Memory panel (phase 10, spec §3 "explore the graph"): browse label counts →
 * paged node lists, hybrid search (vector + keyword + rerank) across the
 * retrievable labels, and a master-detail node inspector with edge navigation
 * and a back stack. VARIANCE 4: two-column 3fr/2fr split, each side scrolls
 * independently.
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

const PAGE_SIZE = 50

interface NodeRef {
  readonly label: IpcNodeLabel
  readonly id: string
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
  edges,
  onNavigate
}: {
  title: string
  edges: readonly MemoryEdgeDto[]
  onNavigate: (ref: NodeRef) => void
}): React.JSX.Element {
  return (
    <section className="mt-5">
      <SectionHeader meta={edges.length === 0 ? undefined : String(edges.length)}>{title}</SectionHeader>
      {edges.length === 0 ? (
        <div className="text-[12px] text-ink-mute">no {title} edges</div>
      ) : (
        groupEdges(edges).map(([type, group]) => (
          <div key={type} className="mb-3">
            <div className="border-b border-line pb-1 font-mono text-[11px] text-ink-mute">{type}</div>
            <ul>
              {group.map((edge, i) => {
                const extractedBy =
                  typeof edge.props['extracted_by'] === 'string' ? edge.props['extracted_by'] : null
                const confidence =
                  typeof edge.props['confidence'] === 'number' ? edge.props['confidence'] : null
                return (
                  <li
                    key={`${edge.label}:${edge.id}:${i}`}
                    className="flex min-h-[34px] flex-wrap items-center gap-x-2.5 gap-y-0.5 border-b border-line py-1.5"
                  >
                    <button
                      type="button"
                      onClick={() => onNavigate({ label: edge.label, id: edge.id })}
                      className="min-w-0 cursor-pointer text-left text-[12px] text-accent transition-colors duration-120 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
                      title={nodeKey(edge)}
                    >
                      {truncate(edge.display, 120)}
                    </button>
                    <span className="font-mono text-[11px] text-ink-faint">{edge.label}</span>
                    {extractedBy !== null && (
                      <span className="font-mono text-[11px] text-ink-mute">{extractedBy}</span>
                    )}
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
  const entries = Object.entries(node.props)
    .filter(([key, value]) => value !== null && key !== 'extracted_by' && key !== 'confidence')
    .map(([key, value]) => ({ k: key, v: renderPropValue(key, value) }))

  return (
    <div className="px-4 py-3">
      <div className="flex items-center gap-2.5">
        {canBack && <Button onClick={onBack}>back</Button>}
        <span className="font-mono text-[12px] text-ink-mute">{node.label}</span>
      </div>
      <div className="mt-1.5 font-mono text-[12px] break-all">{node.id}</div>
      {(extractedBy !== null || confidence !== null) && (
        <div className="mt-2.5 flex flex-wrap items-center gap-2.5 border-b border-line pb-2.5">
          {extractedBy !== null && (
            <span className="font-mono text-[11px] text-ink-mute">{extractedBy}</span>
          )}
          {confidence !== null && <Confidence value={confidence} />}
        </div>
      )}
      <div className="mt-3">
        {entries.length === 0 ? (
          <div className="text-[12px] text-ink-mute">no properties</div>
        ) : (
          <KV entries={entries} />
        )}
      </div>
      <EdgeSection title="outgoing" edges={node.outgoing} onNavigate={onNavigate} />
      <EdgeSection title="incoming" edges={node.incoming} onNavigate={onNavigate} />
    </div>
  )
}

// ── tables ────────────────────────────────────────────────────────────────────

const LIST_COLUMNS: readonly Column<MemoryNodeSummaryDto>[] = [
  {
    key: 'display',
    header: 'display',
    render: (row) => <span>{truncate(row.display, 160)}</span>
  },
  {
    key: 'updated',
    header: 'updated',
    className: 'whitespace-nowrap',
    render: (row) => <Timestamp iso={row.updatedAt} />
  }
]

const SEARCH_COLUMNS: readonly Column<MemorySearchHitDto>[] = [
  {
    key: 'label',
    header: 'label',
    className: 'whitespace-nowrap',
    render: (hit) => <span className="font-mono text-[11px] text-ink-mute">{hit.label}</span>
  },
  {
    key: 'text',
    header: 'text',
    render: (hit) => <span>{truncate(hit.text, 160)}</span>
  },
  {
    key: 'score',
    header: 'rerank',
    className: 'text-right whitespace-nowrap',
    render: (hit) => <span className="font-mono">{hit.rerankScore.toFixed(2)}</span>
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
    browseBody = (
      <>
        <div className="flex flex-wrap gap-1.5 px-4 py-3">
          {counts.data.map((c) => {
            const selected = list !== null && list.label === c.label
            return (
              <button
                key={c.label}
                type="button"
                onClick={() => loadPage(c.label, [])}
                className={`flex cursor-pointer items-baseline gap-1.5 rounded-md px-2 py-1 text-[12px] transition-colors duration-120 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent ${
                  selected
                    ? 'bg-raised text-ink shadow-[inset_2px_0_0_var(--color-accent)]'
                    : 'text-ink-mute hover:bg-raised hover:text-ink'
                }`}
              >
                <span>{c.label}</span>
                <span className="font-mono text-[11px]">{c.count}</span>
              </button>
            )
          })}
        </div>
        {list === null ? (
          <EmptyState>pick a label above to list its nodes, or search</EmptyState>
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
              empty={list.loading ? 'loading' : `no ${list.label} nodes yet`}
            />
            {list.loading && <LoadingRows rows={3} />}
            {!list.loading && list.rows.length < list.total && (
              <div className="px-4 py-3">
                <Button onClick={() => loadPage(list.label, list.rows)}>load more</Button>
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
              meta={<span className="font-mono text-[11px]">{hits.length} hits</span>}
            >
              results for &apos;{search.query}&apos;
            </SectionHeader>
          </div>
          <DataTable
            columns={SEARCH_COLUMNS}
            rows={hits}
            rowKey={nodeKey}
            onRowClick={inspect}
            selectedKey={currentKey}
            empty={`no hits for '${search.query}' in memory`}
          />
        </>
      )
    }
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <PanelHeader
        title="memory"
        actions={
          <>
            <TextInput
              value={query}
              onChange={setQuery}
              placeholder="search memory (vector + keyword + rerank)"
              ariaLabel="search memory"
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
            <EmptyState>select a node to inspect it</EmptyState>
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
