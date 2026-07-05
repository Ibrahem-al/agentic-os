# Product

## Register

product

## Users

Technical operators (developers) monitoring an autonomous, local-first AI memory system. They open the dashboard on a second monitor while Claude works over MCP: reviewing staged memory writes, approving or denying queued agent actions, undoing bad commits, watching spend, tracing agent reasoning, and feeding the system new knowledge. Sessions are long, ambient light is low, glances are short. The dashboard is the ONLY interface to the §13 safety gates (review queue, approvals, audit/undo) — if it is unclear, the safety spine is unusable.

## Product Purpose

Agentic OS is an Electron desktop app that serves memory and tools to external AI agents and learns from finished sessions. The dashboard is its cockpit: nine panels over real local stores (graph memory, staged writes, approvals, audit log, traces, spend, tasks, skills, ingestion, settings). Success = an operator can find any fact, decide any pending action, and reverse any mistake in seconds, without reading documentation.

## Brand Personality

Instrumental, calm, precise. The interface is an instrument panel, not a marketing surface: it reports state truthfully, makes destructive actions deliberate, and never decorates. Emotional goal: quiet confidence that the autonomous system is observable and reversible.

## Anti-references

- AI-slop SaaS dashboards: purple glows, gradient text, hero-metric cards, glassmorphism, identical card grids.
- Consumer analytics tools that hide data behind whitespace (this is a cockpit; density is a feature).
- Terminal cosplay: fake scanlines, neon-on-black hacker aesthetics, decorative mono noise.
- Anything animated for its own sake. Motion only as feedback.

## Design Principles

1. **State is the hero.** Status (staged/pending/committed/denied/error/flagged) is the most important pixel on every row; color carries semantics, never decoration.
2. **Density with hierarchy.** Tight rows, hairline dividers, mono numerals — but every screen has exactly one primary reading order.
3. **Destructive is deliberate.** Approve/reject/undo/deny always show what will change (diffs, deltas) and never sit where a stray click lands.
4. **Truth over polish.** Empty states say why they are empty; errors surface verbatim backend messages (they are written for operators); nothing pretends to be loading when it is broken.
5. **One instrument, one language.** Every panel shares the same table, badge, timestamp, and confidence grammar — learning one panel teaches all nine.

## Accessibility & Inclusion

WCAG AA contrast minimum on all text (4.5:1 body, 3:1 large/bold) against dark surfaces. Full keyboard operability for review/approve/reject/undo flows. Visible focus rings. Color is never the only carrier of state (badges carry text). `prefers-reduced-motion` honored trivially (motion is hover/active feedback only). Screen-reader labels on all icon-only controls.
