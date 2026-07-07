/**
 * Frameless custom title bar (the app's single brand home). Full-width 30px
 * chrome: -webkit-app-region:drag on the header, no-drag on every control.
 * On macOS the native traffic lights stay — we render no control cluster and
 * inset the brand to clear them. On win32/linux we draw crisp SVG window
 * controls whose maximize button tracks live isMaximized state.
 */
import { useEffect, useState } from 'react'

/**
 * React.CSSProperties omits the (non-standard) WebkitAppRegion property, so we
 * build the style object and cast it — never `any`, never a plain typed literal
 * (which would trip an excess-property error).
 */
const appRegion = (value: 'drag' | 'no-drag'): React.CSSProperties => ({ WebkitAppRegion: value }) as React.CSSProperties

/**
 * Live maximize state for the maximize/restore icon: seeded once from the main
 * process, kept current via the push subscription, unsubscribed on unmount —
 * mirrors IngestPanel's onIngestProgress subscribe/unsubscribe discipline.
 */
function useMaximized(): boolean {
  const [maximized, setMaximized] = useState(false)
  useEffect(() => {
    let cancelled = false
    void window.agenticOS.window.isMaximized().then((value) => {
      if (!cancelled) setMaximized(value)
    })
    const unsubscribe = window.agenticOS.window.onMaximizeChange(setMaximized)
    return () => {
      cancelled = true
      unsubscribe()
    }
  }, [])
  return maximized
}

const iconMinimize = (
  <svg width="9" height="9" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1" aria-hidden="true">
    <line x1="0.5" y1="5" x2="9.5" y2="5" />
  </svg>
)

const iconMaximize = (
  <svg width="9" height="9" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1" aria-hidden="true">
    <rect x="1" y="1" width="8" height="8" />
  </svg>
)

const iconRestore = (
  <svg width="9" height="9" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1" aria-hidden="true">
    <path d="M3 3 V1.5 H8.5 V7 H7" />
    <rect x="1" y="3" width="6" height="6" />
  </svg>
)

const iconClose = (
  <svg width="9" height="9" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1" aria-hidden="true">
    <path d="M1 1 L9 9 M9 1 L1 9" />
  </svg>
)

const controlBase =
  'flex h-full w-[40px] cursor-default items-center justify-center text-ink-mute transition-colors duration-120'

interface WindowControlProps {
  label: string
  testId: string
  onClick: () => void
  variant: 'neutral' | 'close'
  children: React.ReactNode
}

function WindowControl({ label, testId, onClick, variant, children }: WindowControlProps): React.JSX.Element {
  const variantClasses =
    variant === 'close'
      ? 'hover:bg-err hover:text-ink active:bg-err/80'
      : 'hover:bg-raised hover:text-ink active:bg-line-strong'
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      data-testid={testId}
      style={appRegion('no-drag')}
      onClick={onClick}
      className={`${controlBase} ${variantClasses}`}
    >
      {children}
    </button>
  )
}

export default function TitleBar(): React.JSX.Element {
  const isMac = window.agenticOS.platform === 'darwin'
  const maximized = useMaximized()

  return (
    <header
      data-testid="title-bar"
      style={appRegion('drag')}
      className="z-20 flex h-[30px] shrink-0 select-none items-center justify-between border-b border-line bg-surface"
    >
      <div className={isMac ? 'flex items-center gap-1.5 pl-[72px]' : 'flex items-center gap-1.5 pl-2.5'}>
        <span aria-hidden="true" className="size-1.5 rounded-[2px] bg-accent" />
        <span className="text-[11px] font-semibold tracking-tight text-ink">agentic-os</span>
        <span className="font-mono text-[10px] text-ink-faint">operations console</span>
      </div>

      {!isMac && (
        <div className="flex h-full items-stretch">
          <WindowControl
            label="Minimize"
            testId="win-minimize"
            variant="neutral"
            onClick={() => window.agenticOS.window.minimize()}
          >
            {iconMinimize}
          </WindowControl>
          <WindowControl
            label={maximized ? 'Restore' : 'Maximize'}
            testId="win-maximize"
            variant="neutral"
            onClick={() => window.agenticOS.window.toggleMaximize()}
          >
            {maximized ? iconRestore : iconMaximize}
          </WindowControl>
          <WindowControl
            label="Close"
            testId="win-close"
            variant="close"
            onClick={() => window.agenticOS.window.close()}
          >
            {iconClose}
          </WindowControl>
        </div>
      )}
    </header>
  )
}
