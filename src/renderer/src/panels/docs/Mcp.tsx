/** Docs → MCP server & connection (ported from the engineering handbook). */
import { Callout, Code, CodeBlock, DocHeader, DocProse, H2, H3, P, SpecTable, Strong } from '../../ui/docs'

const CLAUDE_MCP_ADD =
  'claude mcp add --transport http agentic-os http://127.0.0.1:4517/mcp --header "Authorization: Bearer <token>"'

const FLOW: { t: string; d: string }[] = [
  { t: 'Claude Code', d: 'MCP client' },
  { t: 'POST /mcp', d: 'streamable HTTP' },
  { t: 'bearer auth', d: 'timing-safe' },
  { t: 'dispatchTool', d: 'the chokepoint' },
  { t: 'kernel.execute', d: 'permission + span' },
  { t: 'tool.handle', d: '1 of ~38' },
  { t: 'mcp_calls', d: 'always logged' }
]

export function Mcp(): React.JSX.Element {
  return (
    <div>
      <DocHeader
        kicker="system design"
        title="MCP server & connection"
        intro="The Model Context Protocol server is the app's inbound surface. Claude Code, or any MCP client, connects over loopback HTTP with a bearer token and calls one of ~38 tools — reads, staged-write proposals, and control triggers. Every call is mediated by the kernel and logged to a server-side ledger. This is the reliable backbone the whole system learns from."
      />

      <DocProse>
        <H2>Transport, host, and port</H2>
        <P>
          The transport is <Strong>Streamable HTTP, not stdio</Strong>: the server lives inside the
          long-running Electron app, which MCP clients do not spawn. It binds loopback only.
        </P>
        <SpecTable
          head={['constant', 'value']}
          rows={[
            ['MCP_URL', <Code key="u">http://127.0.0.1:4517/mcp</Code>],
            ['MCP_TRANSPORT', 'streamable-http'],
            ['bearer token', 'randomBytes(32).base64url, in the OS keychain (safeStorage)'],
            ['MCP_MAX_BODY_BYTES', '4 MB (POST cap → 413)'],
            ['second path', '/hooks/session-end (dedicated token)']
          ]}
        />

        <H2>How a request is authenticated</H2>
        <P>
          Before any session routing, every request&apos;s bearer token is compared to the keychain
          token with a SHA-256 + <Code>timingSafeEqual</Code> check. A miss returns 401 with{' '}
          <Code>WWW-Authenticate: Bearer</Code> and is deliberately <Strong>not</Strong> logged to{' '}
          <Code>mcp_calls</Code>. The real token is never printed by default; the boot log shows only a{' '}
          <Code>&lt;token&gt;</Code> placeholder.
        </P>

        <H2>The chokepoint</H2>
        <P>
          The server uses the low-level SDK <Code>Server</Code>, not <Code>McpServer</Code>, precisely
          so a single <Code>CallTool</Code> handler covers every tool call including unknown names and
          invalid args. Logging happens in that handler&apos;s <Code>finally</Code>, so no code path
          can invoke a tool without leaving a row. Every call also runs inside{' '}
          <Code>kernel.execute(...)</Code>, which produces a span and applies the permission seam.
        </P>
      </DocProse>

      <div className="my-8 overflow-x-auto rounded-lg border border-line bg-surface/40 p-5">
        <div className="flex min-w-max items-stretch gap-2">
          {FLOW.map((n, i) => (
            <div key={n.t} className="flex items-center gap-2">
              <div className="rounded-md border border-line bg-bg px-3 py-2 text-center">
                <div className="text-[12.5px] font-medium text-ink">{n.t}</div>
                <div className="mt-0.5 font-mono text-[10px] text-ink-faint">{n.d}</div>
              </div>
              {i < FLOW.length - 1 && <span className="font-mono text-ink-faint">→</span>}
            </div>
          ))}
        </div>
      </div>

      <DocProse>
        <H2>The tool surface</H2>
        <P>
          The original v1 surface is the seven tools below. It has since grown to about 38 — read
          tools for every dashboard view, staged-write tools that drive the whole learning loop, and
          control tools that trigger sanctioned internal jobs — but the shape never changes:{' '}
          <Strong>reads open, writes land only as staged proposals, and the human-gated approve /
          reject / undo / grant decisions stay off the tool surface entirely.</Strong> zod schemas are
          the validators, and <Code>z.toJSONSchema()</Code> derives the advertised{' '}
          <Code>tools/list</Code> schema from the same definition, so validation and advertisement can
          never drift. The seven originals, most of them read-only:
        </P>
        <SpecTable
          head={['tool', 'access', 'what it does']}
          rows={[
            ['get_context', 'read', 'Full hybrid retrieval + self-correcting loop. Returns a token-budgeted bundle with a confidence flag and always-included global preferences.'],
            ['search_memory', 'read', 'Direct hybrid search over the four retrievable labels. Fuse + one rerank, no graph expansion, no loop.'],
            ['list_skills', 'read', 'All skills with their current version.'],
            ['get_skill', 'read', 'A skill by name, its active version, and recent examples.'],
            ['propose_correction', 'stage', "Claude's ONLY write path. Inserts one row to staged_writes. Never the graph."],
            ['ingest_document', 'write', 'Chunk → embed → one write-lane job. Content-hash dedup makes re-adds no-ops.'],
            ['ingest_codebase', 'write', 'Tree-sitter component graph + doc digests. Unchanged re-ingest writes nothing.']
          ]}
        />

        <Callout tone="warn" title="propose_correction is staging, not writing">
          It validates the patch (no protected keys), resolves the target across all 13 node labels,
          and inserts a <Code>staged_writes</Code> row. The graph is provably untouched. The review
          flow validates and commits later, with a human-visible diff.
        </Callout>

        <H2>Connect Claude Code</H2>
        <H3>1. Add the server</H3>
        <P>The Settings panel renders this exact command with your real token:</P>
        <CodeBlock label="terminal" code={CLAUDE_MCP_ADD} />
        <P>
          A project-scope <Code>.mcp.json</Code> is also written into the app&apos;s data directory:
        </P>
        <CodeBlock
          label=".mcp.json"
          code={`{
  "mcpServers": {
    "agentic-os": {
      "type": "http",
      "url": "http://127.0.0.1:4517/mcp",
      "headers": { "Authorization": "Bearer <token>" }
    }
  }
}`}
        />
        <H3>2. Sessions and correlation</H3>
        <P>
          The transport&apos;s <Code>mcp-session-id</Code> (a UUID) is the correlation key. It is also
          the kernel agent id (<Code>mcp:&lt;sessionId&gt;</Code>) and the staged-write proposer
          suffix, so a staged correction, its span, and its <Code>mcp_calls</Code> rows all trace back
          to one session. Multiple clients each get their own isolated transport and server.
        </P>
        <H3>3. Session end</H3>
        <P>
          A Claude Code <Code>SessionEnd</Code> hook POSTs to <Code>/hooks/session-end</Code> when a
          session finishes, which enqueues extraction. If the app is offline, the hook script spools
          the payload to <Code>~/.agentic-os/pending-sessions/</Code> and it drains on next launch. A
          30-minute MCP-inactivity sweep is the fallback for clients without the hook.
        </P>

        <H2>The app is also an MCP client</H2>
        <P>
          It can consume external MCP servers the user adds (HTTP or stdio), configured in{' '}
          <Code>mcp-servers.json</Code>. The config file never holds a token; an HTTP entry names a
          keychain secret that is resolved at connect time.
        </P>
      </DocProse>
    </div>
  )
}
