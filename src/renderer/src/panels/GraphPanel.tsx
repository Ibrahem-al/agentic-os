/**
 * Knowledge-graph panel — an Obsidian-style force-directed view of the whole
 * §18 memory graph. Loads graph.overview once, then renders it on the ForceGraph
 * canvas with the interactions people expect from Obsidian: scroll to zoom, drag
 * to pan, drag a node, hover to light up a node's neighborhood, click to inspect.
 *
 * Around the canvas: a per-label legend that doubles as a show/hide filter, a
 * search box that finds and centers a node, a "local graph" mode that isolates a
 * node's N-hop neighborhood (like Obsidian's local view), and a selection card
 * that deep-links into the Memory inspector (reusing App's onInspect route).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { GraphNodeDto, IpcNodeLabel } from '../../../shared/ipc'
import { IPC_NODE_LABELS } from '../../../shared/ipc'
import type { PanelProps } from '../App'
import { useIpc } from '../lib/ipc'
import { truncate } from '../lib/format'
import { plural } from '../lib/plain'
import { Button, EmptyState, ErrorState, PanelHeader, Select, TextInput } from '../ui/kit'
import { Icon } from '../ui/icons'
import { ForceGraph, type ForceGraphHandle } from '../ui/graph/ForceGraph'
import { buildAdjacency, neighborhood, subgraph } from '../ui/graph/model'
import { colorForLabel } from '../ui/graph/colors'

type Mode = 'global' | 'local'

const DEPTH_OPTIONS = [
  { value: '1', label: 'Direct links' },
  { value: '2', label: '2 hops' },
  { value: '3', label: '3 hops' }
] as const

export default function GraphPanel({ onInspect }: PanelProps): React.JSX.Element {
  const overview = useIpc('graph.overview', {})
  const graphRef = useRef<ForceGraphHandle>(null)

  const [hidden, setHidden] = useState<ReadonlySet<IpcNodeLabel>>(new Set())
  const [mode, setMode] = useState<Mode>('global')
  const [depth, setDepth] = useState(1)
  const [focusKey, setFocusKey] = useState<string | null>(null)
  const [selected, setSelected] = useState<GraphNodeDto | null>(null)
  const [query, setQuery] = useState('')
  const [fitSignal, setFitSignal] = useState(0)

  const data = overview.data
  const bumpFit = useCallback(() => setFitSignal((s) => s + 1), [])

  // Labels actually present, in the canonical order, with counts — drives the legend.
  const presentLabels = useMemo(() => {
    if (data === null) return [] as { label: IpcNodeLabel; count: number }[]
    const counts = new Map<IpcNodeLabel, number>()
    for (const n of data.nodes) counts.set(n.label, (counts.get(n.label) ?? 0) + 1)
    return IPC_NODE_LABELS.filter((l) => counts.has(l)).map((label) => ({ label, count: counts.get(label) ?? 0 }))
  }, [data])

  // The visible subgraph: label filter first, then (local mode) an N-hop crop.
  const visible = useMemo(() => {
    if (data === null) return { nodes: [], edges: [] }
    const notHidden = (l: IpcNodeLabel): boolean => !hidden.has(l)
    const fNodes = data.nodes.filter((n) => notHidden(n.label))
    const keptKeys = new Set(fNodes.map((n) => n.key))
    const fEdges = data.edges.filter((e) => keptKeys.has(e.source) && keptKeys.has(e.target))
    if (mode === 'local' && focusKey !== null && keptKeys.has(focusKey)) {
      const adj = buildAdjacency(fEdges)
      const keep = neighborhood(focusKey, adj, depth)
      return subgraph(fNodes, fEdges, keep)
    }
    return { nodes: fNodes, edges: fEdges }
  }, [data, hidden, mode, focusKey, depth])

  // Keep the selection card in sync if the underlying node vanished (filter/reload).
  useEffect(() => {
    if (selected === null) return
    if (!visible.nodes.some((n) => n.key === selected.key)) setSelected(null)
  }, [visible.nodes, selected])

  const toggleLabel = useCallback((label: IpcNodeLabel) => {
    setHidden((prev) => {
      const next = new Set(prev)
      if (next.has(label)) next.delete(label)
      else next.add(label)
      return next
    })
  }, [])

  const runSearch = useCallback(
    (raw: string) => {
      const q = raw.trim().toLowerCase()
      if (q === '' || data === null) return
      const hit =
        data.nodes.find((n) => n.display.toLowerCase().startsWith(q)) ??
        data.nodes.find((n) => n.display.toLowerCase().includes(q))
      if (hit === undefined) return
      // Make sure the hit is actually shown, then focus + select it.
      setHidden((prev) => {
        if (!prev.has(hit.label)) return prev
        const next = new Set(prev)
        next.delete(hit.label)
        return next
      })
      setFocusKey(hit.key)
      setSelected(hit)
    },
    [data]
  )

  const enterLocal = useCallback(
    (node: GraphNodeDto) => {
      setHidden((prev) => {
        if (!prev.has(node.label)) return prev
        const next = new Set(prev)
        next.delete(node.label)
        return next
      })
      setMode('local')
      setFocusKey(node.key)
      setSelected(node)
      bumpFit()
    },
    [bumpFit]
  )

  const exitLocal = useCallback(() => {
    setMode('global')
    setFocusKey(null)
    bumpFit()
  }, [bumpFit])

  const onSelectNode = useCallback(
    (node: GraphNodeDto | null) => {
      setSelected(node)
      if (node === null && mode === 'global') setFocusKey(null)
    },
    [mode]
  )

  const openInMemory = useCallback(
    (node: GraphNodeDto) => {
      onInspect?.({ label: node.label, id: node.id })
    },
    [onInspect]
  )

  // ── header ──────────────────────────────────────────────────────────────────
  const header = (
    <PanelHeader
      title="Knowledge graph"
      subtitle="Everything your assistant knows, as a living map — drag, zoom, and hover to explore"
      icon={<Icon name="graph" size={18} />}
      actions={
        <>
          <TextInput
            value={query}
            onChange={setQuery}
            placeholder="Find a node…"
            ariaLabel="Find a node in the graph"
            testId="graph-search-input"
            onEnter={() => runSearch(query)}
            width="w-64"
          />
          {mode === 'local' && (
            <Select
              value={String(depth)}
              onChange={(v) => setDepth(Number(v))}
              options={DEPTH_OPTIONS.map((o) => ({ value: o.value, label: o.label }))}
              ariaLabel="How many hops the local graph shows"
              testId="graph-depth"
            />
          )}
          {mode === 'local' && (
            <Button testId="graph-exit-local" onClick={exitLocal}>
              Full graph
            </Button>
          )}
          <Button testId="graph-fit" onClick={bumpFit}>
            Fit
          </Button>
        </>
      }
    />
  )

  // ── body ────────────────────────────────────────────────────────────────────
  let body: React.JSX.Element
  if (overview.error !== null) {
    body = <ErrorState error={overview.error} onRetry={overview.reload} />
  } else if (data === null) {
    body = (
      <div className="flex h-full items-center justify-center text-[13px] text-ink-mute" role="status">
        Building the graph…
      </div>
    )
  } else if (data.nodes.length === 0) {
    body = (
      <EmptyState icon={<Icon name="graph" size={20} />}>
        Nothing to map yet. As sessions are learned from and you add knowledge, the graph fills in here.
      </EmptyState>
    )
  } else {
    body = (
      <div className="absolute inset-0">
        <ForceGraph
          nodes={visible.nodes}
          edges={visible.edges}
          selectedKey={selected?.key ?? null}
          focusKey={focusKey}
          fitSignal={fitSignal}
          onSelect={onSelectNode}
          onOpen={openInMemory}
          handleRef={graphRef}
        />

        {/* Truncation note (top-left) */}
        {data.truncated && (
          <div className="pointer-events-none absolute left-3 top-3 rounded-md border border-warn/40 bg-warn/10 px-2.5 py-1.5 text-[11px] leading-4 text-warn">
            Large graph — showing the {data.nodes.length.toLocaleString()} most-recent of{' '}
            {data.totalNodes.toLocaleString()} nodes.
          </div>
        )}

        {/* Legend / filter (bottom-left) */}
        <div
          className="absolute bottom-3 left-3 max-h-[46%] w-52 overflow-y-auto rounded-md border border-line bg-surface/95 p-2 shadow-lg"
          data-testid="graph-legend"
        >
          <div className="px-1 pb-1.5 text-[11px] font-medium text-ink-mute">Types — click to hide</div>
          <div className="flex flex-col gap-0.5">
            {presentLabels.map(({ label, count }) => {
              const off = hidden.has(label)
              return (
                <button
                  key={label}
                  type="button"
                  data-testid={`graph-legend-${label}`}
                  aria-pressed={!off}
                  onClick={() => toggleLabel(label)}
                  className={`flex cursor-pointer items-center gap-2 rounded px-1.5 py-1 text-left text-[12px] transition-colors duration-120 hover:bg-raised ${
                    off ? 'opacity-40' : ''
                  }`}
                >
                  <span
                    aria-hidden="true"
                    className="inline-block size-2.5 shrink-0 rounded-full"
                    style={{ backgroundColor: colorForLabel(label) }}
                  />
                  <span className="min-w-0 flex-1 truncate text-ink">{label}</span>
                  <span className="font-mono text-[11px] text-ink-mute">{count}</span>
                </button>
              )
            })}
          </div>
        </div>

        {/* Stats (bottom-right) */}
        <div className="pointer-events-none absolute bottom-3 right-3 rounded-md bg-surface/85 px-2.5 py-1.5 font-mono text-[11px] text-ink-mute">
          {visible.nodes.length.toLocaleString()} nodes · {visible.edges.length.toLocaleString()} links
          {mode === 'local' && <span className="text-accent"> · local</span>}
        </div>

        {/* Selection card (top-right) */}
        {selected !== null && (
          <div
            className="absolute right-3 top-3 w-72 rounded-md border border-line-strong bg-surface p-3 shadow-xl"
            data-testid="graph-detail"
          >
            <div className="flex items-center gap-2">
              <span
                aria-hidden="true"
                className="inline-block size-2.5 shrink-0 rounded-full"
                style={{ backgroundColor: colorForLabel(selected.label) }}
              />
              <span className="text-[12px] text-ink-mute">{selected.label}</span>
              <button
                type="button"
                aria-label="Close details"
                onClick={() => setSelected(null)}
                className="ml-auto cursor-pointer rounded p-0.5 text-ink-mute transition-colors duration-120 hover:bg-raised hover:text-ink"
              >
                <Icon name="x" size={12} />
              </button>
            </div>
            <div className="mt-1.5 text-[14px] leading-5 break-words">{truncate(selected.display, 160)}</div>
            <div className="mt-1 text-[12px] text-ink-mute">
              {plural(selected.degree, 'connection')} in view
            </div>
            <div className="mt-3 flex flex-wrap gap-1.5">
              {onInspect !== undefined && (
                <Button variant="primary" testId="graph-open-memory" onClick={() => openInMemory(selected)}>
                  Open in Memory
                </Button>
              )}
              {mode === 'global' ? (
                <Button testId="graph-focus-local" onClick={() => enterLocal(selected)}>
                  Local graph
                </Button>
              ) : (
                <Button testId="graph-recenter-local" onClick={() => enterLocal(selected)}>
                  Center here
                </Button>
              )}
            </div>
          </div>
        )}
      </div>
    )
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {header}
      <div className="relative min-h-0 flex-1">{body}</div>
    </div>
  )
}
