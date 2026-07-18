/**
 * Hand-drawn 16×16 line icons for the nav rail and inline affordances. One
 * consistent grammar: currentColor stroke (so tokens like text-ink-mute drive
 * the color), 1.5px weight, round caps/joins, no fills. Decorative by default
 * (aria-hidden) — the label beside an icon carries the meaning; icon-only
 * controls supply their own aria-label on the surrounding button.
 */

export type IconName =
  | 'home'
  | 'memory'
  | 'approvals'
  | 'history'
  | 'spending'
  | 'tasks'
  | 'runs'
  | 'skills'
  | 'ingest'
  | 'settings'
  | 'search'
  | 'folder'
  | 'doc'
  | 'code'
  | 'check'
  | 'x'
  | 'undo'
  | 'chevron'
  | 'info'
  | 'alert'
  | 'lock'
  | 'graph'

// Each entry is the inner geometry for a 16×16 viewBox; the wrapper supplies
// the shared stroke grammar. Zero-length "h.01" segments render as round dots.
const PATHS: Record<IconName, React.JSX.Element> = {
  home: (
    <>
      <path d="M2.5 7.5 8 3l5.5 4.5" />
      <path d="M4 6.9V13h8V6.9" />
    </>
  ),
  memory: (
    <>
      <ellipse cx="8" cy="4.3" rx="4.5" ry="1.8" />
      <path d="M3.5 4.3v7.4c0 1 2 1.8 4.5 1.8s4.5-.8 4.5-1.8V4.3" />
      <path d="M3.5 8c0 1 2 1.8 4.5 1.8S12.5 9 12.5 8" />
    </>
  ),
  approvals: (
    <>
      <circle cx="8" cy="8" r="5.5" />
      <path d="M5.5 8 7.2 9.7 10.6 6.3" />
    </>
  ),
  history: (
    <>
      <circle cx="8" cy="8" r="5.5" />
      <path d="M8 4.8V8l2.4 1.4" />
    </>
  ),
  spending: (
    <>
      <circle cx="8" cy="8" r="5.5" />
      <path d="M8 4.6v6.8" />
      <path d="M9.8 6.1c-.3-.7-1-1-1.8-1-1 0-1.8.5-1.8 1.4 0 2 3.8 1 3.8 3 0 .9-.9 1.4-2 1.4-.8 0-1.6-.3-2-1" />
    </>
  ),
  tasks: (
    <>
      <path d="M3 4.5h.01M3 8h.01M3 11.5h.01" />
      <path d="M6 4.5h7M6 8h7M6 11.5h7" />
    </>
  ),
  runs: (
    <>
      <circle cx="5" cy="4" r="1.5" />
      <circle cx="5" cy="12" r="1.5" />
      <circle cx="11" cy="8" r="1.5" />
      <path d="M5 5.5v5" />
      <path d="M5 8h4.5" />
    </>
  ),
  skills: (
    <path d="M8 2.5c.4 2.6 1.5 3.7 4 4-2.5.3-3.6 1.4-4 4-.4-2.6-1.5-3.7-4-4 2.5-.3 3.6-1.4 4-4Z" />
  ),
  ingest: (
    <>
      <path d="M3 9.5v3h10v-3" />
      <path d="M8 2.5v6.5" />
      <path d="M5.5 6.5 8 9l2.5-2.5" />
    </>
  ),
  settings: (
    <>
      <circle cx="8" cy="8" r="2.2" />
      <path d="M8 1.6v1.8M8 12.6v1.8M1.6 8h1.8M12.6 8h1.8M3.5 3.5l1.3 1.3M11.2 11.2l1.3 1.3M12.5 3.5l-1.3 1.3M4.8 11.2l-1.3 1.3" />
    </>
  ),
  search: (
    <>
      <circle cx="7" cy="7" r="4" />
      <path d="M10 10 13.5 13.5" />
    </>
  ),
  folder: (
    <path d="M2.5 5.2c0-.6.4-1 1-1h3l1.4 1.4h4.6c.6 0 1 .4 1 1v5.2c0 .6-.4 1-1 1h-9c-.6 0-1-.4-1-1V5.2Z" />
  ),
  doc: (
    <>
      <path d="M4 2.5h5l3 3v8H4z" />
      <path d="M9 2.5v3h3" />
      <path d="M6 8.8h4M6 11.2h4" />
    </>
  ),
  code: (
    <>
      <path d="M6 5 2.5 8 6 11" />
      <path d="M10 5 13.5 8 10 11" />
    </>
  ),
  check: <path d="M3 8.5 6.5 12 13 4.5" />,
  x: <path d="M4 4 12 12M12 4 4 12" />,
  undo: (
    <>
      <path d="M3.2 7.5H9a3.3 3.3 0 0 1 0 6.6H6.5" />
      <path d="M5.7 5 3 7.6l2.7 2.6" />
    </>
  ),
  chevron: <path d="M6 4 10 8 6 12" />,
  info: (
    <>
      <circle cx="8" cy="8" r="5.5" />
      <path d="M8 7.3v3.4" />
      <path d="M8 5.2h.01" />
    </>
  ),
  alert: (
    <>
      <path d="M8 3 14 13H2z" />
      <path d="M8 6.6v3" />
      <path d="M8 11.3h.01" />
    </>
  ),
  lock: (
    <>
      <path d="M4.5 7.5h7v5.5h-7z" />
      <path d="M6 7.5V5.75a2 2 0 0 1 4 0V7.5" />
    </>
  ),
  graph: (
    <>
      <circle cx="4" cy="4.5" r="1.6" />
      <circle cx="12" cy="4" r="1.6" />
      <circle cx="8" cy="12" r="1.6" />
      <path d="M5.4 5.4 7 10.5M10.7 5.1 8.7 10.6M5.5 4.3h5" />
    </>
  )
}

export function Icon({
  name,
  size = 16,
  className
}: {
  name: IconName
  size?: number
  className?: string
}): React.JSX.Element {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...(className !== undefined ? { className } : {})}
    >
      {PATHS[name]}
    </svg>
  )
}
