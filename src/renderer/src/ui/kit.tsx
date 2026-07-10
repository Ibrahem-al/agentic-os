/**
 * Shared UI kit (phase 10) — the ONE component grammar all nine panels use
 * (PRODUCT.md principle 5: learning one panel teaches all nine). Styling
 * follows DESIGN.md exactly: dark locked, DENSITY 7 (34px rows, hairline
 * dividers, mono numerals), MOTION 2 (feedback transitions only).
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { statusColor } from '../design-tokens'
import type { IpcError } from '../lib/ipc'
import { Icon } from './icons'

// ── status grammar ────────────────────────────────────────────────────────────

const STATUS_TEXT: Record<string, string> = {
  ok: 'text-ok',
  warn: 'text-warn',
  err: 'text-err',
  undo: 'text-undo',
  accent: 'text-accent'
}
const STATUS_BG: Record<string, string> = {
  ok: 'bg-ok/15',
  warn: 'bg-warn/15',
  err: 'bg-err/15',
  undo: 'bg-undo/15',
  accent: 'bg-accent/15'
}

/**
 * Status word → the shared color grammar; unmapped statuses render neutral.
 * `data-status` always carries the RAW backend word (tests + design tokens key
 * off it); `label` is the plain-language display text and `title` the tooltip
 * that explains it, both from lib/plain.
 */
export function Badge({
  status,
  label,
  title
}: {
  status: string
  label?: string
  title?: string
}): React.JSX.Element {
  const token = statusColor[status]
  const textCls = token !== undefined ? (STATUS_TEXT[token] ?? 'text-ink-mute') : 'text-ink-mute'
  const bgCls = token !== undefined ? (STATUS_BG[token] ?? 'bg-raised') : 'bg-raised'
  return (
    <span
      className={`inline-block rounded-full px-2 py-0.5 font-mono text-[11px] leading-4 whitespace-nowrap ${textCls} ${bgCls}`}
      data-status={status}
      {...(title !== undefined ? { title } : {})}
    >
      {label ?? status}
    </span>
  )
}

/** Inline confidence: mono value + 32×3 meter (filled portion only). */
export function Confidence({ value }: { value: number | null | undefined }): React.JSX.Element | null {
  if (value == null) return null
  const clamped = Math.max(0, Math.min(1, value))
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className="font-mono text-[11px] text-ink-mute">{clamped.toFixed(2)}</span>
      <span className="inline-block h-[3px] w-8 bg-line" aria-hidden="true">
        <span
          className={`block h-full ${clamped >= 0.6 ? 'bg-ok' : 'bg-warn'}`}
          style={{ width: `${Math.round(clamped * 100)}%` }}
        />
      </span>
    </span>
  )
}

// ── buttons & inputs ──────────────────────────────────────────────────────────

type ButtonVariant = 'primary' | 'danger' | 'danger-ghost' | 'ghost'

export function Button({
  variant = 'ghost',
  size = 'dense',
  disabled,
  onClick,
  children,
  testId,
  title,
  type = 'button'
}: {
  variant?: ButtonVariant
  size?: 'dense' | 'default'
  disabled?: boolean
  onClick?: () => void
  children: ReactNode
  testId?: string
  title?: string
  type?: 'button' | 'submit'
}): React.JSX.Element {
  const base =
    'inline-flex items-center gap-1.5 rounded-md font-medium whitespace-nowrap transition-colors duration-120 ' +
    'disabled:opacity-45 disabled:cursor-not-allowed active:translate-y-px select-none cursor-pointer'
  const sizing = size === 'dense' ? 'h-7 px-2.5 text-[12px]' : 'h-8 px-3 text-[13px]'
  const look =
    variant === 'primary'
      ? 'bg-accent text-accent-ink hover:bg-accent/85'
      : variant === 'danger'
        ? 'bg-err/85 text-ink hover:bg-err'
        : // A calmer destructive look for actions that sit beside a primary one:
          // a hairline error border instead of a full red fill (brief §5).
          variant === 'danger-ghost'
          ? 'border border-err/40 text-err hover:bg-err/10'
          : 'border border-line-strong text-ink hover:bg-raised'
  return (
    <button
      type={type}
      className={`${base} ${sizing} ${look}`}
      disabled={disabled}
      onClick={onClick}
      {...(testId !== undefined ? { 'data-testid': testId } : {})}
      {...(title !== undefined ? { title } : {})}
    >
      {children}
    </button>
  )
}

export function TextInput({
  value,
  onChange,
  placeholder,
  label,
  ariaLabel,
  mono,
  testId,
  onEnter,
  width
}: {
  value: string
  onChange: (value: string) => void
  placeholder?: string
  label?: string
  /** Accessible name for label-less inputs (header filters, search). */
  ariaLabel?: string
  mono?: boolean
  testId?: string
  onEnter?: () => void
  width?: string
}): React.JSX.Element {
  const name = ariaLabel ?? label
  const input = (
    <input
      type="text"
      value={value}
      onChange={(e) => onChange(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' && onEnter !== undefined) onEnter()
      }}
      {...(placeholder !== undefined ? { placeholder } : {})}
      {...(testId !== undefined ? { 'data-testid': testId } : {})}
      {...(name !== undefined && name !== '' ? { 'aria-label': name } : {})}
      className={`h-8 rounded-md border border-line-strong bg-raised px-2.5 text-[13px] text-ink placeholder:text-ink-mute
        focus:border-accent focus:outline-none transition-colors duration-120 ${mono === true ? 'font-mono text-[12px]' : ''} ${width ?? 'w-full'}`}
    />
  )
  if (label === undefined) return input
  return (
    <label className="flex flex-col gap-1">
      <span className="text-[12px] text-ink-mute">{label}</span>
      {input}
    </label>
  )
}

export function Select({
  value,
  onChange,
  options,
  label,
  ariaLabel,
  testId
}: {
  value: string
  onChange: (value: string) => void
  options: readonly { value: string; label: string }[]
  label?: string
  /** Accessible name for label-less selects (header filters). */
  ariaLabel?: string
  testId?: string
}): React.JSX.Element {
  const name = ariaLabel ?? label
  const select = (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      {...(testId !== undefined ? { 'data-testid': testId } : {})}
      {...(name !== undefined && name !== '' ? { 'aria-label': name } : {})}
      className="h-8 rounded-md border border-line-strong bg-raised px-2 text-[13px] text-ink focus:border-accent focus:outline-none"
    >
      {options.map((option) => (
        <option key={option.value} value={option.value}>
          {option.label}
        </option>
      ))}
    </select>
  )
  if (label === undefined) return select
  return (
    <label className="flex flex-col gap-1">
      <span className="text-[12px] text-ink-mute">{label}</span>
      {select}
    </label>
  )
}

/**
 * Boolean switch (role="switch"). Renders no text of its own — pass an
 * accessible `label`. Accent track + light knob when on, hairline track when
 * off; MOTION 2 feedback transition only. Focus ring comes from the global
 * :focus-visible rule, matching Button/Select.
 */
export function Toggle({
  checked,
  onChange,
  label,
  disabled,
  testId
}: {
  checked: boolean
  onChange: (checked: boolean) => void
  label: string
  disabled?: boolean
  testId?: string
}): React.JSX.Element {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      {...(testId !== undefined ? { 'data-testid': testId } : {})}
      className={`relative inline-flex h-5 w-9 shrink-0 items-center rounded-full border transition-colors duration-120
        cursor-pointer select-none disabled:cursor-not-allowed disabled:opacity-45 ${
          checked ? 'border-accent bg-accent' : 'border-line-strong bg-raised'
        }`}
    >
      <span
        aria-hidden="true"
        className={`inline-block size-3.5 rounded-full transition-transform duration-120 ${
          checked ? 'translate-x-[18px] bg-accent-ink' : 'translate-x-[3px] bg-ink-mute'
        }`}
      />
    </button>
  )
}

// ── layout ────────────────────────────────────────────────────────────────────

/**
 * Panel header row: title left, actions right (VARIANCE 4: left-aligned). The
 * redesign adds an optional subdued `icon` left of the title and a one-line
 * plain-English `subtitle` under it (every panel gets one — brief §Design rules).
 */
export function PanelHeader({
  title,
  subtitle,
  icon,
  meta,
  actions
}: {
  title: string
  subtitle?: string
  icon?: ReactNode
  meta?: ReactNode
  actions?: ReactNode
}): React.JSX.Element {
  return (
    <header className="border-b border-line px-5 py-3">
      <div className="flex items-baseline gap-3">
        <div className="flex items-center gap-2">
          {icon !== undefined && <span className="text-ink-mute">{icon}</span>}
          <h1 className="text-[20px] font-semibold leading-7">{title}</h1>
        </div>
        {meta !== undefined && <div className="text-[12px] text-ink-mute">{meta}</div>}
        {actions !== undefined && <div className="ml-auto flex items-center gap-2">{actions}</div>}
      </div>
      {subtitle !== undefined && <p className="mt-0.5 text-[12px] text-ink-mute">{subtitle}</p>}
    </header>
  )
}

export function SectionHeader({ children, meta }: { children: ReactNode; meta?: ReactNode }): React.JSX.Element {
  return (
    <div className="flex items-baseline gap-2 pt-1 pb-2">
      <h2 className="text-[14px] font-semibold">{children}</h2>
      {meta !== undefined && <span className="text-[12px] text-ink-mute">{meta}</span>}
    </div>
  )
}

// ── states ────────────────────────────────────────────────────────────────────

/**
 * Empty state: says why it's empty + what populates it (PRODUCT.md #4). The
 * redesign adds an optional subdued `icon` above the sentence and an optional
 * `action` (a button/link to the thing that fills it) below.
 */
export function EmptyState({
  children,
  action,
  icon
}: {
  children: ReactNode
  action?: ReactNode
  icon?: ReactNode
}): React.JSX.Element {
  return (
    <div className="px-5 py-10 text-center text-[13px] text-ink-mute">
      {icon !== undefined && <div className="mb-2 flex justify-center text-ink-mute">{icon}</div>}
      <div>{children}</div>
      {action !== undefined && <div className="mt-3 flex justify-center">{action}</div>}
    </div>
  )
}

/**
 * Progressive-disclosure expander for technical detail (ids, JSON, raw signals)
 * — the redesign moves cockpit density behind these so a row leads with a plain
 * sentence. Chevron rotates on open (feedback transition; global reduced-motion
 * collapses it); children sit in a bg-surface inset.
 */
export function Disclosure({
  summary,
  children,
  testId,
  defaultOpen = false
}: {
  summary: ReactNode
  children: ReactNode
  testId?: string
  defaultOpen?: boolean
}): React.JSX.Element {
  const [open, setOpen] = useState(defaultOpen)
  return (
    <div {...(testId !== undefined ? { 'data-testid': testId } : {})}>
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((prev) => !prev)}
        className="flex w-full cursor-pointer items-center gap-1.5 rounded-md py-1 text-left text-[12px] text-ink-mute transition-colors duration-120 hover:text-ink"
      >
        <Icon
          name="chevron"
          size={12}
          className={`shrink-0 transition-transform duration-120 ${open ? 'rotate-90' : ''}`}
        />
        <span className="min-w-0">{summary}</span>
      </button>
      {open && <div className="mt-1 rounded-md bg-surface px-3 py-2">{children}</div>}
    </div>
  )
}

/** Backend errors verbatim — they are written for operators. */
export function ErrorState({ error, onRetry }: { error: IpcError; onRetry?: () => void }): React.JSX.Element {
  return (
    <div className="mx-5 my-4 rounded-md border border-err/40 bg-err/10 px-4 py-3" role="alert">
      <div className="font-mono text-[11px] text-err">{error.code}</div>
      <div className="mt-1 text-[13px]">{error.message}</div>
      {onRetry !== undefined && (
        <div className="mt-2">
          <Button onClick={onRetry}>retry</Button>
        </div>
      )}
    </div>
  )
}

/** Skeleton rows shaped like the table they replace (no spinners). */
export function LoadingRows({ rows = 5 }: { rows?: number }): React.JSX.Element {
  return (
    <div className="px-5 py-3" aria-label="loading" role="status">
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="flex h-[34px] items-center border-b border-line">
          <div className="h-3 rounded bg-raised" style={{ width: `${30 + ((i * 17) % 45)}%` }} />
        </div>
      ))}
    </div>
  )
}

// ── table ─────────────────────────────────────────────────────────────────────

export interface Column<T> {
  readonly key: string
  readonly header: string
  /** Extra cell classes (e.g. 'font-mono', 'text-right', width utilities). */
  readonly className?: string
  render(row: T): ReactNode
}

/**
 * The dense table: sticky header, hairline rows, hover raise, optional row
 * selection (2px accent inset). Rows need a stable key.
 */
export function DataTable<T>({
  columns,
  rows,
  rowKey,
  onRowClick,
  selectedKey,
  empty,
  testId
}: {
  columns: readonly Column<T>[]
  rows: readonly T[]
  rowKey(row: T): string
  onRowClick?: (row: T) => void
  selectedKey?: string | null
  empty: ReactNode
  testId?: string
}): React.JSX.Element {
  if (rows.length === 0) return <EmptyState>{empty}</EmptyState>
  return (
    <div className="overflow-x-auto" {...(testId !== undefined ? { 'data-testid': testId } : {})}>
      <table className="w-full border-collapse text-[12px]">
        <thead>
          <tr className="sticky top-0 z-10 bg-surface text-left">
            {columns.map((col) => (
              <th key={col.key} className="border-b border-line-strong px-2.5 py-2 font-mono text-[11px] font-normal text-ink-mute whitespace-nowrap">
                {col.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const key = rowKey(row)
            const selected = selectedKey != null && selectedKey === key
            const clickable = onRowClick !== undefined
            return (
              <tr
                key={key}
                data-rowkey={key}
                onClick={clickable ? () => onRowClick(row) : undefined}
                // Clickable rows are keyboard-operable (WCAG 2.1.1): focusable,
                // activated with Enter/Space like the button they act as, with
                // ArrowUp/ArrowDown moving focus between sibling rows
                // (listbox-style; phase-10 recorded P2). Guarded on
                // target === currentTarget so controls inside cells keep their
                // own key handling.
                tabIndex={clickable ? 0 : undefined}
                onKeyDown={
                  clickable
                    ? (e) => {
                        if (e.target !== e.currentTarget) return
                        if (e.key === 'Enter' || e.key === ' ') {
                          e.preventDefault()
                          onRowClick(row)
                        } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                          const sibling =
                            e.key === 'ArrowDown'
                              ? e.currentTarget.nextElementSibling
                              : e.currentTarget.previousElementSibling
                          if (sibling instanceof HTMLElement && sibling.tabIndex >= 0) {
                            e.preventDefault() // keep the scroll container still; focus is the move
                            sibling.focus()
                          }
                        }
                      }
                    : undefined
                }
                className={`border-b border-line transition-colors duration-120 ${
                  clickable ? 'cursor-pointer hover:bg-raised focus-visible:bg-raised' : ''
                } ${selected ? 'bg-raised shadow-[inset_2px_0_0_var(--color-accent)]' : ''}`}
              >
                {columns.map((col) => (
                  <td key={col.key} className={`px-2.5 py-2 align-top ${col.className ?? ''}`}>
                    {col.render(row)}
                  </td>
                ))}
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

/** Key–value grid for inspectors (mono values, wraps long text). */
export function KV({ entries }: { entries: readonly { k: string; v: ReactNode }[] }): React.JSX.Element {
  return (
    <dl className="grid grid-cols-[minmax(96px,max-content)_1fr] gap-x-4 gap-y-1.5 text-[12px]">
      {entries.map(({ k, v }) => (
        <div key={k} className="contents">
          <dt className="font-mono text-[11px] leading-5 text-ink-mute">{k}</dt>
          <dd className="min-w-0 break-words leading-5">{v}</dd>
        </div>
      ))}
    </dl>
  )
}

/** Timestamp with the shared grammar: relative text, absolute on hover. */
export function Timestamp({ iso, ms }: { iso?: string | null; ms?: number }): React.JSX.Element | null {
  const value = iso ?? (ms !== undefined ? new Date(ms).toISOString() : null)
  if (value == null || value === '') return null
  const then = Date.parse(value)
  const seconds = Math.round((Date.now() - then) / 1000)
  let text: string
  if (Number.isNaN(then)) text = value
  else if (seconds < 60) text = `${Math.max(seconds, 0)}s ago`
  else if (seconds < 3600) text = `${Math.round(seconds / 60)}m ago`
  else if (seconds < 172800) text = `${Math.round(seconds / 3600)}h ago`
  else text = value.slice(0, 10)
  return (
    <time dateTime={value} title={value} className="font-mono text-[11px] text-ink-mute whitespace-nowrap">
      {text}
    </time>
  )
}

// ── modal ─────────────────────────────────────────────────────────────────────

/** Tabbable-element query for the modal focus trap (disabled controls excluded). */
const FOCUSABLE_SELECTOR =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'

export function Modal({
  title,
  onClose,
  children,
  footer,
  wide
}: {
  title: string
  onClose: () => void
  children: ReactNode
  footer?: ReactNode
  wide?: boolean
}): React.JSX.Element {
  const dialogRef = useRef<HTMLDivElement | null>(null)

  // Focus lifecycle (runs once per modal): move focus into the dialog so
  // keyboard users land where they acted; return it to the invoking element
  // when the dialog closes (WCAG 2.4.3 focus order).
  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null
    dialogRef.current?.focus()
    return () => opener?.focus()
  }, [])

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        onClose()
        return
      }
      // Focus trap: Tab/Shift+Tab cycle within the dialog's focusable
      // elements (aria-modal promises this; phase-10 recorded P2).
      if (e.key !== 'Tab') return
      const dialog = dialogRef.current
      if (dialog === null) return
      const focusables = Array.from(dialog.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(
        (el) => el.offsetParent !== null
      )
      const first = focusables[0]
      const last = focusables[focusables.length - 1]
      if (first === undefined || last === undefined) {
        // Nothing tabbable — keep focus parked on the dialog container.
        e.preventDefault()
        dialog.focus()
        return
      }
      const active = document.activeElement
      const inside = active instanceof Node && dialog.contains(active)
      if (e.shiftKey) {
        if (!inside || active === first || active === dialog) {
          e.preventDefault()
          last.focus()
        }
      } else if (!inside || active === last) {
        e.preventDefault()
        first.focus()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])
  return (
    <div className="fixed inset-0 z-30 flex items-center justify-center bg-bg/70 p-8" onClick={onClose}>
      <div
        ref={dialogRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onClick={(e) => e.stopPropagation()}
        className={`z-40 flex max-h-[85vh] w-full ${wide === true ? 'max-w-3xl' : 'max-w-xl'} flex-col rounded-md border border-line-strong bg-surface shadow-2xl transition-opacity duration-80`}
      >
        <div className="flex items-center justify-between border-b border-line px-4 py-2.5">
          <h2 className="text-[14px] font-semibold">{title}</h2>
          <Button onClick={onClose} title="close">
            esc
          </Button>
        </div>
        <div className="min-h-0 overflow-y-auto px-4 py-3">{children}</div>
        {footer !== undefined && (
          <div className="flex justify-end gap-2 border-t border-line px-4 py-2.5">{footer}</div>
        )}
      </div>
    </div>
  )
}

// ── toasts ────────────────────────────────────────────────────────────────────

export interface Toast {
  readonly id: number
  readonly kind: 'ok' | 'err' | 'info'
  readonly message: string
}

interface ToastApi {
  notify(kind: Toast['kind'], message: string): void
}

const ToastContext = createContext<ToastApi>({ notify: () => undefined })

export function useToast(): ToastApi {
  return useContext(ToastContext)
}

export function ToastProvider({ children }: { children: ReactNode }): React.JSX.Element {
  const [toasts, setToasts] = useState<readonly Toast[]>([])

  const notify = useCallback((kind: Toast['kind'], message: string) => {
    const id = Date.now() + Math.random()
    setToasts((current) => [...current, { id, kind, message }])
    // Errors stay until dismissed; everything else auto-clears (DESIGN.md).
    if (kind !== 'err') {
      setTimeout(() => setToasts((current) => current.filter((t) => t.id !== id)), 5000)
    }
  }, [])

  const api = useMemo(() => ({ notify }), [notify])

  return (
    <ToastContext.Provider value={api}>
      {children}
      <div className="fixed right-4 bottom-4 z-50 flex w-96 flex-col gap-2" data-testid="toasts">
        {toasts.map((toast) => (
          <div
            key={toast.id}
            role={toast.kind === 'err' ? 'alert' : 'status'}
            className={`rounded-md border border-line-strong bg-surface px-3.5 py-2.5 text-[12px] shadow-xl border-t-[3px] ${
              toast.kind === 'ok' ? 'border-t-ok' : toast.kind === 'err' ? 'border-t-err' : 'border-t-accent'
            }`}
          >
            <div className="flex items-start justify-between gap-2">
              <span className="break-words">{toast.message}</span>
              <button
                type="button"
                aria-label="dismiss"
                className="cursor-pointer font-mono text-[11px] text-ink-mute hover:text-ink"
                onClick={() => setToasts((current) => current.filter((t) => t.id !== toast.id))}
              >
                ×
              </button>
            </div>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  )
}
