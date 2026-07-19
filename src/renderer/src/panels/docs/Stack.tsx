/** Docs → Tech stack (ported from the engineering handbook). */
import { Callout, DocHeader, DocProse, H2, P, Strong } from '../../ui/docs'

interface Dep {
  name: string
  version: string
  role: string
}
interface Group {
  title: string
  intro: string
  deps: Dep[]
}

const GROUPS: Group[] = [
  {
    title: 'Runtime & shell',
    intro: 'A desktop app that hosts a long-running server and a dashboard in one process tree.',
    deps: [
      { name: 'electron', version: '43.0.0', role: 'The desktop shell. Main process runs the MCP server, kernel, and agents; the renderer is a sandboxed React window with no Node access.' },
      { name: 'electron-vite', version: '5.0.0', role: 'Builds the three targets (main / preload / renderer) with HMR. Externalizes deps in main/preload so native modules load at runtime.' },
      { name: 'vite', version: '7.3.6', role: 'The underlying bundler and dev server for the renderer.' },
    ],
  },
  {
    title: 'Interface',
    intro: 'The dashboard: a dense, dark, single-window operations console.',
    deps: [
      { name: 'react / react-dom', version: '19.2', role: 'The renderer. Nine panels over a typed IPC contract; stale data stays visible during reload so dense tables never flash empty.' },
      { name: 'tailwindcss', version: '4.3', role: 'CSS-first design tokens. The default palette is reset to nothing so only the instrument tokens exist.' },
      { name: 'typescript', version: '5.8.3', role: 'Strict everywhere, with noUncheckedIndexedAccess and verbatimModuleSyntax. Two projects: node and web.' },
    ],
  },
  {
    title: 'Memory & storage',
    intro: 'One embedded graph engine is the memory; one SQLite database is the machinery.',
    deps: [
      { name: 'ryugraph', version: '25.9.1', role: 'Embedded vector + graph + full-text store with Cypher. The persistent memory. The MIT-maintained fork of Kùzu.' },
      { name: 'better-sqlite3', version: '12.11.1', role: 'Synchronous SQLite (WAL) for traces, tasks, staged writes, spend, audit, and LangGraph checkpoints. A dual-ABI stash serves both Node and Electron.' },
    ],
  },
  {
    title: 'Models & ML',
    intro: 'A local tier that is always on, plus an optional bring-your-own-key cloud tier.',
    deps: [
      { name: 'onnxruntime-node', version: '1.27.0', role: 'Runs the int8 ONNX cross-encoder (bge-reranker-v2-m3) in-process for reranking. ~570 MB, downloaded once and checksum-verified.' },
      { name: '@huggingface/tokenizers', version: '0.1.3', role: 'Pure-JS XLM-RoBERTa tokenization for the reranker, in-process, no Python.' },
      { name: 'Ollama (external)', version: 'bge-m3 + qwen3:4b', role: 'Serves 1024-dim embeddings and the small local LLM over 127.0.0.1:11434. Detected at launch with guided install.' },
    ],
  },
  {
    title: 'Agents & protocol',
    intro: 'The inbound protocol surface and the durable workflow engine behind background agents.',
    deps: [
      { name: '@modelcontextprotocol/sdk', version: '1.29.0', role: 'The MCP server (streamable HTTP) and the outbound MCP client. zod schemas derive the advertised tool list.' },
      { name: '@langchain/langgraph', version: '1.4.7', role: 'Compiles each background agent (a list of steps) into a linear StateGraph. Durability sync makes checkpoints crash-safe.' },
      { name: '@langchain/langgraph-checkpoint', version: '1.1.3', role: 'The checkpointer contract. An in-house SQLite saver keeps checkpoints in the same appdata.db, with no extra native deps.' },
      { name: 'zod', version: '4.4.3', role: 'Validates every MCP tool input, rule file, and config. One schema is both the runtime validator and the JSON Schema.' },
    ],
  },
  {
    title: 'Ingestion',
    intro: 'Turning documents and codebases into graph memory.',
    deps: [
      { name: 'web-tree-sitter', version: '0.26.10', role: 'WASM Tree-sitter runtime, so the identical parser runs under plain Node and Electron with no dual-ABI dance.' },
      { name: 'tree-sitter-{typescript,javascript,python}', version: '0.23-0.25', role: 'Grammars (as WASM) for extracting meaningful code units and their dependencies.' },
      { name: 'ignore', version: '7.0.5', role: 'Full gitignore semantics for the codebase walk, including nested ignore files and negation.' },
    ],
  },
  {
    title: 'Observability & automation',
    intro: 'Traces for the cockpit, and the triggers that make the system autonomous.',
    deps: [
      { name: '@opentelemetry/*', version: '2.9 / api 1.9', role: 'Spans for every kernel action and workflow step, exported synchronously to the SQLite traces table the dashboard reads.' },
      { name: 'chokidar', version: '5.0.0', role: 'File watching for watched folders and rule file watches.' },
      { name: 'croner', version: '10.0.1', role: 'Cron scheduling for the nightly skill job, prune, and weekly export.' },
      { name: 'electron-updater', version: '6.8.9', role: 'Background auto-update against the GitHub releases feed. Never throws, never shows a dialog.' },
    ],
  },
  {
    title: 'Build & test',
    intro: 'Packaging for three platforms, and the gates that keep it honest.',
    deps: [
      { name: 'electron-builder', version: '26.15.3', role: 'Packages the NSIS installer (Windows), dmg + zip (macOS arm64/x64), and AppImage + deb (Linux). Never rebuilds natives.' },
      { name: '@electron/rebuild', version: '4.1.0', role: 'Produces the Electron-ABI better-sqlite3 stash during the native rebuild step.' },
      { name: 'vitest', version: '4.1.9', role: 'Unit + integration tests, offline against scripted models. Forked pool tolerates the RyuGraph teardown quirk.' },
      { name: '@playwright/test', version: '1.61', role: 'End-to-end tests against the real production build, including the golden-path release gate.' },
    ],
  },
]

export function Stack(): React.JSX.Element {
  return (
    <div>
      <DocHeader
        kicker="engineering"
        title="Tech stack"
        intro="Every dependency, what it does, and why it earns its place. The through-line: an Electron shell hosting a local server and dashboard, an embedded graph engine for memory, a local model tier for embeddings and reranking, and a durable workflow engine for the agents that learn."
      />

      <div className="mt-8 flex flex-col gap-10">
        {GROUPS.map((g) => (
          <section key={g.title}>
            <DocProse>
              <H2>{g.title}</H2>
              <P>{g.intro}</P>
            </DocProse>
            <div className="mt-4 flex flex-col gap-2.5">
              {g.deps.map((d) => (
                <div
                  key={d.name}
                  className="grid gap-2 rounded-md border border-line bg-surface/40 px-4 py-3 sm:grid-cols-[minmax(0,220px)_1fr] sm:gap-5"
                >
                  <div>
                    <div className="font-mono text-[13px] break-all text-ink">{d.name}</div>
                    <div className="mt-0.5 font-mono text-[11px] text-accent">{d.version}</div>
                  </div>
                  <p className="text-[13.5px] leading-relaxed text-ink-mute">{d.role}</p>
                </div>
              ))}
            </div>
          </section>
        ))}
      </div>

      <div className="mt-10">
        <Callout title="One config, one source of truth">
          Every default the system uses (ports, thresholds, model names, token budgets) lives in a
          single <Strong>config module</Strong>. Nothing is re-declared elsewhere, so a value is
          changed in exactly one place.
        </Callout>
      </div>
    </div>
  )
}
