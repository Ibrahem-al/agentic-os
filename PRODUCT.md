# Product

## Register

product

## Users

Two audiences now share the dashboard. **Less technical people** who want to see and control what their assistant remembers and does: they need plain-English labels, visual overviews that answer "what's going on?" at a glance, and technical detail tucked behind tooltips and "Details" expanders rather than in their face. And **technical operators (developers)** monitoring the autonomous, local-first AI memory system over MCP: reviewing proposed memory changes, approving or denying queued agent actions, undoing mistakes, watching spend, tracing agent reasoning, and feeding the system new knowledge. Sessions range from a five-second glance to a long ambient watch; ambient light is low. The dashboard is the ONLY interface to the §13 safety gates (approvals, history/undo) — if it is unclear, the safety spine is unusable for either audience.

## Product Purpose

Agentic OS is an Electron desktop app that serves memory and tools to external AI agents and learns from finished sessions. The dashboard is its console: a visualization-first **Home** overview plus focused panels over real local stores — memory, approvals, history, agent runs, spending, background work, skills, add-knowledge, settings — grouped into **Decisions / Knowledge / Activity** so the shape of the system is legible before any table is read. Success = anyone, technical or not, can see what's going on in five seconds, find any fact, decide any pending action, and reverse any mistake in seconds, without reading documentation.

## Brand Personality

Instrumental, calm, precise. The interface is an instrument panel, not a marketing surface: it reports state truthfully, makes destructive actions deliberate, and never decorates. Emotional goal: quiet confidence that the autonomous system is observable and reversible.

## Anti-references

- AI-slop SaaS dashboards: purple glows, gradient text, hero-metric cards, glassmorphism, identical card grids.
- Consumer analytics tools that hide data behind whitespace. We are roomier than the old cockpit (approachability now outranks raw density), but overviews still answer real questions — no whitespace for its own sake.
- Terminal cosplay: fake scanlines, neon-on-black hacker aesthetics, decorative mono noise.
- Anything animated for its own sake. Motion only as feedback.

## Design Principles

1. **State is the hero.** Status (waiting/in progress/saved/declined/error/needs a look) is the most important thing on every row; color carries semantics, never decoration. The plain label leads; the raw backend word stays in `data-status` and a tooltip for operators.
2. **Plain language first, detail on demand.** Labels and copy are plain sentence-case English; ids, hashes, model names, and JSON live behind tooltips and "Details" expanders — visible when wanted, never the first thing a row says.
3. **Show, then tell.** Overviews lead with a small, honest visualization (a strip, a bar, a meter) that answers a question at a glance, then the table beneath it carries the specifics. Home answers "what's going on?" in five seconds.
4. **Approachable density.** Roomier than the old cockpit — ~40px rows, generous gutters, one primary reading order per screen (density dialed from 7 toward ~5). Calmer, not emptier: every pixel still earns its place.
5. **Destructive is deliberate.** Approve/decline/undo always show what will change (diffs, deltas) and never sit where a stray click lands.
6. **Truth over polish, one language everywhere.** Empty states say in plain words why they are empty and what will fill them; errors surface verbatim backend messages; the plain-language vocabulary is defined once (`lib/plain.ts`) so learning one panel teaches all of them.

## Accessibility & Inclusion

WCAG AA contrast minimum on all text (4.5:1 body, 3:1 large/bold) against dark surfaces. Full keyboard operability for review/approve/reject/undo flows. Visible focus rings. Color is never the only carrier of state (badges carry text). `prefers-reduced-motion` honored trivially (motion is hover/active feedback only). Screen-reader labels on all icon-only controls.
