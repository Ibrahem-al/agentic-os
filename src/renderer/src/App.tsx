export default function App(): React.JSX.Element {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-3">
      <h1 className="text-3xl font-semibold tracking-tight">Agentic OS</h1>
      <p className="text-sm text-zinc-400">
        Phase 00 scaffold — dashboard panels arrive in phase 10.
      </p>
      <p className="font-mono text-xs text-zinc-500">
        renderer: {window.agenticOS.platform} · v{window.agenticOS.appVersion}
      </p>
    </main>
  )
}
