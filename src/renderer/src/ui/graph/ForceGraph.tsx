/**
 * Force-directed graph canvas — the Obsidian-style knowledge-graph renderer.
 *
 * Hand-rolled (no graph library, matching the app's no-extra-deps stance and the
 * way Obsidian itself works): a spring/charge/gravity simulation on an HTML
 * canvas with grid-bucketed repulsion so it stays smooth into the thousands of
 * nodes. Interaction is the Obsidian grammar — scroll to zoom about the cursor,
 * drag the background to pan, drag a node to pull it, hover to light up a node
 * and its neighbors while the rest dims, click to select, double-click to open.
 *
 * The hot loop runs entirely on refs (positions, camera, alpha) and draws each
 * frame only when something changed (`dirty`), so a settled graph idles at zero
 * CPU. React state is not touched per frame; selection/hover surface to the
 * parent through callbacks. Node positions persist by key across prop changes,
 * so filtering a label or entering local-graph mode animates instead of jumping.
 */
import { useCallback, useEffect, useImperativeHandle, useRef } from 'react'
import type { GraphEdgeDto, GraphNodeDto, IpcNodeLabel } from '../../../../shared/ipc'
import { color } from '../../design-tokens'
import { buildAdjacency, nodeRadius } from './model'
import { colorForLabel, withAlpha } from './colors'

// ── physics constants (world units) ─────────────────────────────────────────
const REPULSION = 6500 // charge strength (inverse-square, capped)
const REPULSION_RANGE = 280 // ignore repulsion beyond this (grid cell size)
const SPRING_LENGTH = 46 // ideal edge length before node radii
const SPRING_K = 0.045 // edge stiffness
const GRAVITY = 0.02 // pull toward origin (keeps components on screen)
const FRICTION = 0.82 // velocity retained per tick
const MAX_SPEED = 32 // clamp so a hot start can't explode
const ALPHA_DECAY = 0.985 // cooling per tick
const ALPHA_MIN = 0.02 // below this the sim is considered settled
const ALPHA_REHEAT_DRAG = 0.2 // dragging a node nudges its neighbors, not the whole graph
const ALPHA_REHEAT_DATA = 0.9 // COLD start only — the very first layout forms from the spiral seed
const ALPHA_REHEAT_WARM = 0.12 // re-filter / local mode / search over an EXISTING layout: a gentle settle, never a re-explosion

// ── camera / view constants ──────────────────────────────────────────────────
const MIN_SCALE = 0.04
const MAX_SCALE = 6
const CLICK_SLOP_PX = 4 // movement under this = a click, not a drag/pan
const LABEL_MIN_SCREEN_R = 6.5 // draw a node's label once it is at least this big on screen
const MIN_SCREEN_R = 1.6 // a node never shrinks below this many pixels

interface SimNode {
  readonly key: string
  readonly label: IpcNodeLabel
  readonly id: string
  readonly display: string
  readonly degree: number
  readonly r: number
  x: number
  y: number
  vx: number
  vy: number
  fixed: boolean
}

interface SimEdge {
  readonly s: number
  readonly t: number
}

interface Camera {
  x: number
  y: number
  scale: number
}

/** Imperative handle so the panel's toolbar can re-fit the view. */
export interface ForceGraphHandle {
  fit(): void
}

export interface ForceGraphProps {
  readonly nodes: readonly GraphNodeDto[]
  readonly edges: readonly GraphEdgeDto[]
  /** The selected node key (persisted ring) — from a click, mirrored by the parent. */
  readonly selectedKey: string | null
  /** A search-focused key: centered + highlighted without needing a click. */
  readonly focusKey: string | null
  /** Bumping this number requests a relax-then-fit (toolbar "Fit", mode changes). */
  readonly fitSignal: number
  readonly onSelect: (node: GraphNodeDto | null) => void
  readonly onOpen: (node: GraphNodeDto) => void
  readonly handleRef?: React.Ref<ForceGraphHandle>
}

/** Golden-angle spiral seed position for a node with no placed neighbors. */
function spiralPosition(i: number): { x: number; y: number } {
  const angle = i * 2.399963229728653
  const radius = 14 * Math.sqrt(i + 1)
  return { x: Math.cos(angle) * radius, y: Math.sin(angle) * radius }
}

export function ForceGraph({
  nodes,
  edges,
  selectedKey,
  focusKey,
  fitSignal,
  onSelect,
  onOpen,
  handleRef
}: ForceGraphProps): React.JSX.Element {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const canvasRef = useRef<HTMLCanvasElement | null>(null)

  // ── mutable engine state (never triggers React re-render) ──────────────────
  const simNodesRef = useRef<SimNode[]>([])
  const indexByKeyRef = useRef<Map<string, number>>(new Map())
  const simEdgesRef = useRef<SimEdge[]>([])
  const adjacencyRef = useRef<Map<string, Set<string>>>(new Map())
  const positionsRef = useRef<Map<string, { x: number; y: number }>>(new Map())
  const cameraRef = useRef<Camera>({ x: 0, y: 0, scale: 1 })
  const alphaRef = useRef(0)
  const dirtyRef = useRef(true)
  const needsFitRef = useRef(false)
  const hasFitRef = useRef(false)
  const sizeRef = useRef({ w: 1, h: 1, dpr: 1 })

  const hoverKeyRef = useRef<string | null>(null)
  const selectedKeyRef = useRef<string | null>(selectedKey)
  const focusKeyRef = useRef<string | null>(focusKey)
  selectedKeyRef.current = selectedKey
  focusKeyRef.current = focusKey

  const onSelectRef = useRef(onSelect)
  const onOpenRef = useRef(onOpen)
  onSelectRef.current = onSelect
  onOpenRef.current = onOpen

  const dragRef = useRef<{ idx: number; grabDx: number; grabDy: number; moved: number } | null>(null)
  const panRef = useRef<{ sx: number; sy: number; camX: number; camY: number; moved: number } | null>(null)

  // ── coordinate transforms ──────────────────────────────────────────────────
  const worldToScreen = useCallback((wx: number, wy: number): { x: number; y: number } => {
    const { w, h } = sizeRef.current
    const cam = cameraRef.current
    return { x: (wx - cam.x) * cam.scale + w / 2, y: (wy - cam.y) * cam.scale + h / 2 }
  }, [])
  const screenToWorld = useCallback((sx: number, sy: number): { x: number; y: number } => {
    const { w, h } = sizeRef.current
    const cam = cameraRef.current
    return { x: (sx - w / 2) / cam.scale + cam.x, y: (sy - h / 2) / cam.scale + cam.y }
  }, [])

  // ── fit the whole graph to the viewport ─────────────────────────────────────
  const fit = useCallback((): void => {
    const sim = simNodesRef.current
    const { w, h } = sizeRef.current
    if (sim.length === 0) {
      cameraRef.current = { x: 0, y: 0, scale: 1 }
      dirtyRef.current = true
      return
    }
    let minX = Infinity
    let minY = Infinity
    let maxX = -Infinity
    let maxY = -Infinity
    for (const n of sim) {
      if (n.x - n.r < minX) minX = n.x - n.r
      if (n.y - n.r < minY) minY = n.y - n.r
      if (n.x + n.r > maxX) maxX = n.x + n.r
      if (n.y + n.r > maxY) maxY = n.y + n.r
    }
    const pad = 60
    const spanX = Math.max(maxX - minX, 1) + pad * 2
    const spanY = Math.max(maxY - minY, 1) + pad * 2
    const scale = Math.max(MIN_SCALE, Math.min(MAX_SCALE, Math.min(w / spanX, h / spanY), 1.4))
    cameraRef.current = { x: (minX + maxX) / 2, y: (minY + maxY) / 2, scale }
    dirtyRef.current = true
  }, [])

  useImperativeHandle(handleRef, () => ({ fit }), [fit])

  // ── (re)build the simulation from props, preserving positions by key ────────
  useEffect(() => {
    const prevPositions = positionsRef.current
    const nextNodes: SimNode[] = []
    const indexByKey = new Map<string, number>()
    let spiralCounter = prevPositions.size
    let newCount = 0

    for (const node of nodes) {
      const prior = prevPositions.get(node.key)
      let pos = prior
      if (pos === undefined) {
        newCount++
        // Place a new node near its already-placed neighbors, else on the spiral.
        const neighbors = adjacencyRef.current.get(node.key)
        let sumX = 0
        let sumY = 0
        let placed = 0
        if (neighbors !== undefined) {
          for (const nk of neighbors) {
            const p = prevPositions.get(nk)
            if (p !== undefined) {
              sumX += p.x
              sumY += p.y
              placed++
            }
          }
        }
        pos =
          placed > 0
            ? { x: sumX / placed + (Math.random() * 24 - 12), y: sumY / placed + (Math.random() * 24 - 12) }
            : spiralPosition(spiralCounter++)
      }
      indexByKey.set(node.key, nextNodes.length)
      nextNodes.push({
        key: node.key,
        label: node.label,
        id: node.id,
        display: node.display,
        degree: node.degree,
        r: nodeRadius(node.degree),
        x: pos.x,
        y: pos.y,
        vx: 0,
        vy: 0,
        fixed: false
      })
    }

    const nextEdges: SimEdge[] = []
    for (const edge of edges) {
      const s = indexByKey.get(edge.source)
      const t = indexByKey.get(edge.target)
      if (s !== undefined && t !== undefined && s !== t) nextEdges.push({ s, t })
    }

    simNodesRef.current = nextNodes
    indexByKeyRef.current = indexByKey
    simEdgesRef.current = nextEdges
    adjacencyRef.current = buildAdjacency(edges)
    // Refresh the persistent position map to the current set.
    const nextPositions = new Map<string, { x: number; y: number }>()
    for (const n of nextNodes) nextPositions.set(n.key, { x: n.x, y: n.y })
    positionsRef.current = nextPositions

    // Reheat gently: a COLD start (no prior layout) needs full energy to form;
    // a WARM rebuild (re-filter / local mode / search over an existing layout,
    // positions preserved by key) needs only a nudge so nodes ease into place
    // instead of re-exploding across the canvas on every interaction.
    const cold = prevPositions.size === 0
    const newFraction = nextNodes.length > 0 ? newCount / nextNodes.length : 0
    alphaRef.current = cold ? ALPHA_REHEAT_DATA : Math.min(0.3, ALPHA_REHEAT_WARM + newFraction * 0.4)
    dirtyRef.current = true
    if (!hasFitRef.current && nextNodes.length > 0) needsFitRef.current = true
  }, [nodes, edges])

  // ── hover / node picking ────────────────────────────────────────────────────
  const pickNode = useCallback((screenX: number, screenY: number): number | null => {
    const sim = simNodesRef.current
    const cam = cameraRef.current
    let best: number | null = null
    let bestDist = Infinity
    for (let i = 0; i < sim.length; i++) {
      const n = sim[i]!
      const sp = worldToScreen(n.x, n.y)
      const rr = Math.max(n.r * cam.scale, MIN_SCREEN_R) + 4
      const dx = sp.x - screenX
      const dy = sp.y - screenY
      const d = dx * dx + dy * dy
      if (d <= rr * rr && d < bestDist) {
        bestDist = d
        best = i
      }
    }
    return best
  }, [worldToScreen])

  // ── one physics tick (grid-bucketed repulsion) ──────────────────────────────
  const step = useCallback((): void => {
    const sim = simNodesRef.current
    const edgesArr = simEdgesRef.current
    const alpha = alphaRef.current
    if (sim.length === 0) return

    const fx = new Float64Array(sim.length)
    const fy = new Float64Array(sim.length)

    // Repulsion via a spatial hash grid (only near pairs interact).
    const cell = REPULSION_RANGE
    const grid = new Map<string, number[]>()
    const cellKey = (x: number, y: number): string => `${Math.floor(x / cell)},${Math.floor(y / cell)}`
    for (let i = 0; i < sim.length; i++) {
      const n = sim[i]!
      const k = cellKey(n.x, n.y)
      const bucket = grid.get(k)
      if (bucket !== undefined) bucket.push(i)
      else grid.set(k, [i])
    }
    for (let i = 0; i < sim.length; i++) {
      const a = sim[i]!
      const cx = Math.floor(a.x / cell)
      const cy = Math.floor(a.y / cell)
      for (let gx = cx - 1; gx <= cx + 1; gx++) {
        for (let gy = cy - 1; gy <= cy + 1; gy++) {
          const bucket = grid.get(`${gx},${gy}`)
          if (bucket === undefined) continue
          for (const j of bucket) {
            if (j <= i) continue
            const b = sim[j]!
            let dx = a.x - b.x
            let dy = a.y - b.y
            let distSq = dx * dx + dy * dy
            if (distSq > REPULSION_RANGE * REPULSION_RANGE) continue
            if (distSq < 0.01) {
              // Coincident nodes: nudge apart deterministically-ish.
              dx = (i - j) * 0.1 + 0.1
              dy = 0.1
              distSq = dx * dx + dy * dy
            }
            const dist = Math.sqrt(distSq)
            const force = REPULSION / distSq
            const ux = dx / dist
            const uy = dy / dist
            fx[i]! += ux * force
            fy[i]! += uy * force
            fx[j]! -= ux * force
            fy[j]! -= uy * force
          }
        }
      }
    }

    // Springs along edges.
    for (const e of edgesArr) {
      const a = sim[e.s]!
      const b = sim[e.t]!
      const dx = b.x - a.x
      const dy = b.y - a.y
      let dist = Math.sqrt(dx * dx + dy * dy)
      if (dist < 0.01) dist = 0.01
      const target = SPRING_LENGTH + a.r + b.r
      const force = SPRING_K * (dist - target)
      const ux = (dx / dist) * force
      const uy = (dy / dist) * force
      fx[e.s]! += ux
      fy[e.s]! += uy
      fx[e.t]! -= ux
      fy[e.t]! -= uy
    }

    // Gravity toward origin + integrate.
    for (let i = 0; i < sim.length; i++) {
      const n = sim[i]!
      if (n.fixed) {
        n.vx = 0
        n.vy = 0
        continue
      }
      const ax = fx[i]! - n.x * GRAVITY
      const ay = fy[i]! - n.y * GRAVITY
      n.vx = (n.vx + ax * alpha) * FRICTION
      n.vy = (n.vy + ay * alpha) * FRICTION
      const speed = Math.hypot(n.vx, n.vy)
      if (speed > MAX_SPEED) {
        n.vx = (n.vx / speed) * MAX_SPEED
        n.vy = (n.vy / speed) * MAX_SPEED
      }
      n.x += n.vx
      n.y += n.vy
      const p = positionsRef.current.get(n.key)
      if (p !== undefined) {
        p.x = n.x
        p.y = n.y
      }
    }

    alphaRef.current = alpha * ALPHA_DECAY
  }, [])

  // ── draw one frame ──────────────────────────────────────────────────────────
  const draw = useCallback((): void => {
    const canvas = canvasRef.current
    if (canvas === null) return
    const ctx = canvas.getContext('2d')
    if (ctx === null) return
    const { w, h, dpr } = sizeRef.current
    const sim = simNodesRef.current
    const cam = cameraRef.current

    ctx.save()
    ctx.scale(dpr, dpr)
    ctx.fillStyle = color.bg
    ctx.fillRect(0, 0, w, h)

    // Active highlight: hover wins, else the search-focus, else the selection.
    const active = hoverKeyRef.current ?? focusKeyRef.current ?? selectedKeyRef.current
    const highlight = active !== null ? adjacencyRef.current.get(active) : undefined
    const isLit = (key: string): boolean => active === null || key === active || (highlight?.has(key) ?? false)

    // Edges.
    ctx.lineWidth = 1
    for (const e of simEdgesRef.current) {
      const a = sim[e.s]!
      const b = sim[e.t]!
      const incident = active !== null && (a.key === active || b.key === active)
      if (active !== null && !incident) {
        ctx.strokeStyle = 'oklch(1 0 0 / 3.5%)'
      } else if (incident) {
        ctx.strokeStyle = withAlpha(color.accent, 0.55)
      } else {
        ctx.strokeStyle = color.line
      }
      const pa = worldToScreen(a.x, a.y)
      const pb = worldToScreen(b.x, b.y)
      ctx.beginPath()
      ctx.moveTo(pa.x, pa.y)
      ctx.lineTo(pb.x, pb.y)
      ctx.stroke()
    }

    // Nodes.
    for (const n of sim) {
      const sp = worldToScreen(n.x, n.y)
      const rr = Math.max(n.r * cam.scale, MIN_SCREEN_R)
      // Cull nodes well outside the viewport.
      if (sp.x < -rr - 40 || sp.x > w + rr + 40 || sp.y < -rr - 40 || sp.y > h + rr + 40) continue
      const lit = isLit(n.key)
      const base = colorForLabel(n.label)
      ctx.beginPath()
      ctx.arc(sp.x, sp.y, rr, 0, Math.PI * 2)
      ctx.fillStyle = lit ? base : withAlpha(base, 0.16)
      ctx.fill()
      // Hairline separation from the background.
      ctx.lineWidth = 1
      ctx.strokeStyle = withAlpha(color.bg, lit ? 0.55 : 0.2)
      ctx.stroke()
      // Rings for the focused / selected / hovered node.
      if (n.key === selectedKeyRef.current || n.key === focusKeyRef.current) {
        ctx.lineWidth = 2
        ctx.strokeStyle = color.accent
        ctx.beginPath()
        ctx.arc(sp.x, sp.y, rr + 3, 0, Math.PI * 2)
        ctx.stroke()
      } else if (n.key === hoverKeyRef.current) {
        ctx.lineWidth = 1.5
        ctx.strokeStyle = color.ink
        ctx.beginPath()
        ctx.arc(sp.x, sp.y, rr + 2, 0, Math.PI * 2)
        ctx.stroke()
      }
    }

    // Labels — drawn last so they sit above nodes; gated by on-screen size so
    // they fade in as you zoom (plus always for the active node + neighbors).
    ctx.textAlign = 'center'
    ctx.textBaseline = 'top'
    ctx.font = '11px system-ui, sans-serif'
    for (const n of sim) {
      const sp = worldToScreen(n.x, n.y)
      const rr = Math.max(n.r * cam.scale, MIN_SCREEN_R)
      if (sp.x < -60 || sp.x > w + 60 || sp.y < -20 || sp.y > h + 20) continue
      const lit = active === null || isLit(n.key)
      const emphasized = active !== null && (n.key === active || (highlight?.has(n.key) ?? false))
      if (rr < LABEL_MIN_SCREEN_R && !emphasized) continue
      if (!lit) continue
      const text = n.display.length > 26 ? `${n.display.slice(0, 25)}…` : n.display
      ctx.fillStyle = emphasized ? color.ink : color.inkFaint
      ctx.fillText(text, sp.x, sp.y + rr + 3)
    }

    ctx.restore()
  }, [worldToScreen])

  // ── animation loop ──────────────────────────────────────────────────────────
  useEffect(() => {
    let raf = 0
    const frame = (): void => {
      const interacting = dragRef.current !== null || panRef.current !== null
      // Let the layout relax below a threshold, then frame it once per request.
      if (needsFitRef.current && alphaRef.current < 0.25) {
        fit()
        needsFitRef.current = false
        hasFitRef.current = true
      }
      if (alphaRef.current > ALPHA_MIN) {
        step()
        dirtyRef.current = true
      }
      if (dirtyRef.current || interacting) {
        draw()
        dirtyRef.current = false
      }
      raf = requestAnimationFrame(frame)
    }
    raf = requestAnimationFrame(frame)
    return () => cancelAnimationFrame(raf)
  }, [step, draw, fit])

  // ── canvas sizing (DPR-aware) ───────────────────────────────────────────────
  useEffect(() => {
    const container = containerRef.current
    const canvas = canvasRef.current
    if (container === null || canvas === null) return
    const resize = (): void => {
      const rect = container.getBoundingClientRect()
      const dpr = window.devicePixelRatio || 1
      const w = Math.max(1, Math.floor(rect.width))
      const h = Math.max(1, Math.floor(rect.height))
      sizeRef.current = { w, h, dpr }
      canvas.width = Math.floor(w * dpr)
      canvas.height = Math.floor(h * dpr)
      canvas.style.width = `${w}px`
      canvas.style.height = `${h}px`
      dirtyRef.current = true
    }
    resize()
    const ro = new ResizeObserver(resize)
    ro.observe(container)
    return () => ro.disconnect()
  }, [])

  // ── native wheel (needs passive:false to preventDefault) ────────────────────
  useEffect(() => {
    const canvas = canvasRef.current
    if (canvas === null) return
    const onWheel = (e: WheelEvent): void => {
      e.preventDefault()
      const rect = canvas.getBoundingClientRect()
      const cx = e.clientX - rect.left
      const cy = e.clientY - rect.top
      const before = screenToWorld(cx, cy)
      const cam = cameraRef.current
      const factor = Math.exp(-e.deltaY * 0.0015)
      cam.scale = Math.max(MIN_SCALE, Math.min(MAX_SCALE, cam.scale * factor))
      // Keep the world point under the cursor stationary.
      const { w, h } = sizeRef.current
      cam.x = before.x - (cx - w / 2) / cam.scale
      cam.y = before.y - (cy - h / 2) / cam.scale
      dirtyRef.current = true
    }
    canvas.addEventListener('wheel', onWheel, { passive: false })
    return () => canvas.removeEventListener('wheel', onWheel)
  }, [screenToWorld])

  // ── external fit request (toolbar "Fit" / mode change): re-frame only ───────
  // Do NOT reheat — "Fit" should re-center the current layout, not re-jiggle it;
  // a mode change already set its own gentle alpha in the rebuild effect.
  useEffect(() => {
    needsFitRef.current = true
    dirtyRef.current = true
  }, [fitSignal])

  // ── center the camera on a newly focused node (search / local-graph seed) ───
  useEffect(() => {
    if (focusKey === null) return
    const idx = indexByKeyRef.current.get(focusKey)
    if (idx === undefined) return
    const n = simNodesRef.current[idx]
    if (n === undefined) return
    const cam = cameraRef.current
    cam.x = n.x
    cam.y = n.y
    cam.scale = Math.max(cam.scale, 0.7)
    dirtyRef.current = true
  }, [focusKey])

  // ── pointer interaction ─────────────────────────────────────────────────────
  const localPoint = (e: React.PointerEvent<HTMLCanvasElement>): { x: number; y: number } => {
    const rect = e.currentTarget.getBoundingClientRect()
    return { x: e.clientX - rect.left, y: e.clientY - rect.top }
  }

  const onPointerDown = useCallback(
    (e: React.PointerEvent<HTMLCanvasElement>): void => {
      const rect = e.currentTarget.getBoundingClientRect()
      const sx = e.clientX - rect.left
      const sy = e.clientY - rect.top
      e.currentTarget.setPointerCapture(e.pointerId)
      const idx = pickNode(sx, sy)
      if (idx !== null) {
        const n = simNodesRef.current[idx]!
        const world = screenToWorld(sx, sy)
        n.fixed = true
        dragRef.current = { idx, grabDx: n.x - world.x, grabDy: n.y - world.y, moved: 0 }
      } else {
        const cam = cameraRef.current
        panRef.current = { sx, sy, camX: cam.x, camY: cam.y, moved: 0 }
      }
    },
    [pickNode, screenToWorld]
  )

  const onPointerMove = useCallback(
    (e: React.PointerEvent<HTMLCanvasElement>): void => {
      const { x: sx, y: sy } = localPoint(e)
      const drag = dragRef.current
      const pan = panRef.current
      if (drag !== null) {
        const n = simNodesRef.current[drag.idx]!
        const world = screenToWorld(sx, sy)
        n.x = world.x + drag.grabDx
        n.y = world.y + drag.grabDy
        n.vx = 0
        n.vy = 0
        drag.moved += Math.abs(e.movementX) + Math.abs(e.movementY)
        const p = positionsRef.current.get(n.key)
        if (p !== undefined) {
          p.x = n.x
          p.y = n.y
        }
        alphaRef.current = Math.max(alphaRef.current, ALPHA_REHEAT_DRAG)
        dirtyRef.current = true
      } else if (pan !== null) {
        const cam = cameraRef.current
        cam.x = pan.camX - (sx - pan.sx) / cam.scale
        cam.y = pan.camY - (sy - pan.sy) / cam.scale
        pan.moved += Math.abs(e.movementX) + Math.abs(e.movementY)
        dirtyRef.current = true
      } else {
        const idx = pickNode(sx, sy)
        const key = idx !== null ? simNodesRef.current[idx]!.key : null
        if (key !== hoverKeyRef.current) {
          hoverKeyRef.current = key
          if (canvasRef.current !== null) canvasRef.current.style.cursor = key !== null ? 'pointer' : 'grab'
          dirtyRef.current = true
        }
      }
    },
    [pickNode, screenToWorld]
  )

  const endPointer = useCallback((e: React.PointerEvent<HTMLCanvasElement>): void => {
    const drag = dragRef.current
    const pan = panRef.current
    if (drag !== null) {
      const n = simNodesRef.current[drag.idx]!
      n.fixed = false
      if (drag.moved < CLICK_SLOP_PX) {
        onSelectRef.current({ key: n.key, label: n.label, id: n.id, display: n.display, degree: n.degree })
      }
      dragRef.current = null
    } else if (pan !== null) {
      if (pan.moved < CLICK_SLOP_PX) onSelectRef.current(null)
      panRef.current = null
    }
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId)
  }, [])

  const onDoubleClick = useCallback(
    (e: React.MouseEvent<HTMLCanvasElement>): void => {
      const rect = e.currentTarget.getBoundingClientRect()
      const idx = pickNode(e.clientX - rect.left, e.clientY - rect.top)
      if (idx !== null) {
        const n = simNodesRef.current[idx]!
        onOpenRef.current({ key: n.key, label: n.label, id: n.id, display: n.display, degree: n.degree })
      }
    },
    [pickNode]
  )

  return (
    <div ref={containerRef} className="absolute inset-0 overflow-hidden">
      <canvas
        ref={canvasRef}
        data-testid="graph-canvas"
        className="block touch-none select-none"
        style={{ cursor: 'grab' }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endPointer}
        onPointerCancel={endPointer}
        onDoubleClick={onDoubleClick}
      />
    </div>
  )
}
