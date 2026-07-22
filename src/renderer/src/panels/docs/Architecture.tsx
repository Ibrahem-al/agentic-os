/** Docs → Architecture (ported from the engineering handbook). */
import { Callout, Code, CodeBlock, DocHeader, DocProse, H2, Li, P, SpecTable, Strong, Ul } from '../../ui/docs'

const BOOT: [string, string][] = [
  [
    'bootStorage()',
    'Apply any launch-staged graph operation (backup / restore / reset) and recover or quarantine a torn WAL before opening anything, then open appdata.db (SQLite/WAL) and the RyuGraph engine with its vendored vector/FTS extensions by absolute path. If a previous process is still releasing its exclusive lock, opening retries for about ten seconds before it gives up.'
  ],
  ['bootModels()', 'Keychain (auto-generates the MCP bearer token), settings, then Ollama detection: ready / models-missing / daemon-not-running.'],
  ['bootKernel()', 'Telemetry, the permission engine + audit log + injection scanner, the Kernel, the LangGraph runner, and the context manager.'],
  ['bootMcp()', 'Build the shared reranker + retriever, start the MCP server on 127.0.0.1:4517. EADDRINUSE just disables MCP for that launch.'],
  ['bootAgents()', 'Register the extraction and skill-improvement workflows. The cloud tier arms only if the active provider has a key.'],
  ['bootTriggers()', 'The system becomes autonomous: task queue, session-end hook, schedules, watchers. The spool drains before the queue starts.'],
  ['bootIpc() → updater → window', 'Register typed IPC handlers, start the background updater, and create the BrowserWindow last, over a fully booted system.']
]

export function Architecture(): React.JSX.Element {
  return (
    <div>
      <DocHeader
        kicker="system design"
        title="Architecture"
        intro="Agentic OS is a local-first Electron desktop app that serves memory and tools to an external AI orchestrator. Claude connects over MCP and does the work; the app serves context on demand, learns from finished sessions, and runs background agents. The memory graph, embeddings, and search index live on your machine; the reasoning tier is bring-your-own — local models by default, an optional cloud key or your Claude subscription for the heavy lifting."
      />

      <DocProse>
        <H2>The stack, top to bottom</H2>
        <P>
          Seven layers carry a request from the orchestrator down to the models and back. Claude is deliberately outside the box: it is
          the orchestrator, and the app is its memory and tools.
        </P>

        <H2>Two invariants everything else obeys</H2>
        <Ul>
          <Li>
            <Strong>All graph writes funnel through one serialized write lane.</Strong> RyuGraph is a single-writer engine, so every
            mutation from every background agent is enqueued FIFO, one at a time. Provenance is stamped by the engine at write time,
            never by the caller.
          </Li>
          <Li>
            <Strong>The entire retrieval path is read-only.</Strong> It never touches the write lane. A test asserts the lane&apos;s
            enqueue count is unchanged across a retrieval.
          </Li>
        </Ul>

        <H2>The Electron shape</H2>
        <P>
          electron-vite builds three independent targets. <Code>main</Code> and <Code>preload</Code> externalize every dependency
          (native modules load from <Code>node_modules</Code> at runtime); <Code>renderer</Code> is React + Tailwind v4. The renderer has{' '}
          <Strong>no Node access</Strong>: context isolation is on, node integration off, and the one privileged boundary is a typed IPC
          bridge.
        </P>
        <CodeBlock
          label="src/shared/ipc.ts · every response crosses as a discriminated result"
          code={`export type IpcResult<T> =
  | { ok: true;  data: T }
  | { ok: false; code: string; message: string }

// The preload exposes ONE generic invoke<C>(channel, req). Because it is
// generic over the channel union, the renderer cannot name a channel that
// does not exist in the shared contract. Missing subsystems surface as a
// structured UNAVAILABLE, never a blank screen.`}
        />

        <H2>Boot sequence</H2>
        <P>
          Each stage is wrapped in its own try/catch and logs a boot line; a failed subsystem never aborts the rest of boot. The window
          is created <Strong>last</Strong>, so the dashboard reads a fully (or partially) booted system. A second launch focuses the
          running window rather than starting a doomed process — the graph holds an exclusive OS lock a second instance could never take
          — and when a subsystem is down the dashboard&apos;s <Strong>Reconnect</Strong> button re-runs the failed stack, in the same
          dependency order, without a restart.
        </P>
      </DocProse>

      <ol className="my-8 flex flex-col gap-2.5">
        {BOOT.map(([name, desc], i) => (
          <li key={name} className="flex gap-4 rounded-md border border-line bg-surface/40 px-4 py-3">
            <span className="mt-0.5 font-mono text-[12px] text-accent">{String(i + 1).padStart(2, '0')}</span>
            <div>
              <div className="font-mono text-[13px] text-ink">{name}</div>
              <div className="mt-1 text-[13px] leading-relaxed text-ink-mute">{desc}</div>
            </div>
          </li>
        ))}
      </ol>

      <DocProse>
        <H2>Two stores, one memory</H2>
        <P>
          The graph store is <Strong>learned memory</Strong>; SQLite is the <Strong>machinery</Strong> that must survive restarts but is
          not part of the ontology.
        </P>
        <SpecTable
          head={['store', 'engine', 'holds']}
          rows={[
            ['userData/graph/', 'RyuGraph', 'the §18 memory ontology: projects, skills, preferences, knowledge, sessions, components, and their edges + embeddings + full-text indexes'],
            ['userData/appdata.db', 'better-sqlite3 (WAL)', 'traces, tasks, mcp_calls, staged_writes, spend, approvals, audit_log, workflow checkpoints, skill bookkeeping'],
            ['userData/models/', 'files', 'the int8 ONNX reranker weights, downloaded on first retrieval'],
            ['userData/backups/', 'files', 'integrity-verified snapshots of both stores: automatic (scheduled) and manual, plus the pre-migration, pre-restore, and pre-reset safety snapshots']
          ]}
        />

        <H2>Durability and recovery</H2>
        <P>
          A torn or corrupt graph WAL — the classic aftermath of a hard kill — no longer bricks the app. It is{' '}
          <Strong>quarantined and preserved</Strong>, never deleted, and the store recovers to its last checkpoint. Periodic,
          dirty-gated WAL checkpointing bounds worst-case loss from a hard kill to about two minutes, and per-subsystem boot diagnostics
          — surfaced on the dashboard and via <Code>get_app_status</Code> — report exactly why any subsystem is degraded.
        </P>
        <P>
          Backups are first-class: a manual <Code>Backup now</Code> and automatic snapshots on a chosen interval, with retention by
          count or age that only ever prunes automatic backups. Any backup restores to that exact point — the current state is
          snapshotted first, so a restore is itself undoable — and the whole store exports to a folder with machine-bound secrets
          excluded. Every one of these graph-touching operations stages and applies at launch, before the database opens, with an
          integrity-verified snapshot at each fail-safe boundary.
        </P>

        <H2>Data flow: a get_context call</H2>
        <P>
          One read leaves exactly one <Code>mcp_calls</Code> row and one <Code>kernel.mcp-call</Code> span, and never a graph write.
        </P>
        <CodeBlock
          label="get_context, end to end"
          code={`Claude Code ── POST /mcp (Bearer, JSON-RPC tools/call get_context) ──▶ MCP server
  1. path /mcp, else 404
  2. bearer auth: timing-safe compare vs keychain 'mcp.bearerToken'  (fail → 401)
  3. session routing by mcp-session-id
  4. dispatchTool → kernel.execute('mcp:<session>', {kind:'mcp-call'}, fn)
       permissions.check → allow (read tier)   → span 'kernel.mcp-call'
       fn(): retriever.retrieve(task, tags)
             embed → vector 30/label + fts 30 → fuse (0.5/0.2/0.3)
             → graph expansion → rerank (ONNX) → top-8 in budget
             → always add global preferences → critic vs rubric
             → pass ≥0.7 | rewrite & retry (≤5) | non-improvement | budget
       return ContextBundle { confidence, iterations, items[], globalPreferences[] }
  finally: McpCallLog.record → INSERT mcp_calls (ok, args_hash, duration)`}
        />

        <Callout tone="accent" title="Claude's only write path">
          Of the ~42 MCP tools, most are read-only; the rest stage proposals or trigger sanctioned jobs. <Code>propose_correction</Code>{' '}
          writes a row to the SQLite <Code>staged_writes</Code> table, never the graph. The correction becomes real only after a human
          approves it in the review queue. &quot;Claude is confident&quot; is not itself a permission check.
        </Callout>

        <H2>Non-negotiables</H2>
        <Ul>
          <Li>All graph writes through the single write lane; provenance stamped on every extraction write.</Li>
          <Li>User and rule code only in the Deno or Docker sandbox lane, never the host.</Li>
          <Li>Defaults (ports, thresholds, model names) come from one config module; nothing is invented elsewhere.</Li>
          <Li>TypeScript strict everywhere. The renderer has no Node access; typed IPC only.</Li>
        </Ul>
      </DocProse>
    </div>
  )
}
