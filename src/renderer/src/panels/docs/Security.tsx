/** Docs → Security & sandbox (ported from the engineering handbook). */
import { Callout, Code, CodeBlock, DocHeader, DocProse, H2, H3, P, SpecTable, Strong } from '../../ui/docs'

export function Security(): React.JSX.Element {
  return (
    <div>
      <DocHeader
        kicker="internals"
        title="Security & sandbox"
        intro="The safety spine is built before anything autonomous runs. Every agent action routes through one permission chokepoint that is default-deny. User and rule code runs only inside a Deno permission sandbox or a deny-by-default Docker container, never on the host. Every write logs a reversible delta, so any mistake is undoable."
      />

      <DocProse>
        <H2>The permission engine</H2>
        <P>
          <Code>kernel.execute(agentId, action, fn)</Code> is the chokepoint every action passes
          through. The engine is <Strong>default-deny</Strong>: an unregistered agent is hard-blocked.
          Reads auto-allow; the four side-effecting tiers are scope-checked, then gated.
        </P>
      </DocProse>

      <div className="my-8 grid gap-4 rounded-lg border border-line bg-surface/40 p-5 sm:grid-cols-2 sm:p-6">
        <div>
          <div className="mb-2 font-mono text-[11px] text-ok">auto-allow · read tier</div>
          <div className="flex flex-wrap gap-1.5 font-mono text-[11px] text-ink-mute">
            {['storage-read', 'retrieval', 'model-call', 'workflow-step', 'fs-read (in scope)'].map((t) => (
              <span key={t} className="rounded bg-raised px-2 py-1">{t}</span>
            ))}
          </div>
        </div>
        <div>
          <div className="mb-2 font-mono text-[11px] text-warn">gated · scope-check then approve</div>
          <div className="flex flex-wrap gap-1.5 font-mono text-[11px] text-ink-mute">
            {['write', 'net', 'spend', 'sandbox'].map((t) => (
              <span key={t} className="rounded bg-raised px-2 py-1">{t}</span>
            ))}
          </div>
        </div>
      </div>

      <DocProse>
        <P>
          Without a standing grant, a gated action inserts a pending-approval row and returns{' '}
          <Strong>not executed</Strong> until the dashboard approves it. Approvals persist per action
          signature, so retrying after approval succeeds, and a decision taken while the app is closed
          applies next boot. Internal agents (system, extraction, skill-improvement, MCP sessions) get
          justified standing grants; user rules get none.
        </P>

        <H2>One capability model, two lanes</H2>
        <P>
          A capability declaration is the single source of truth for both sandbox lanes and the kernel
          gates. Empty arrays and zero spend mean deny.
        </P>
        <CodeBlock
          label="CapabilityDeclaration"
          code={`{ fsRead: string[], fsWrite: string[], netDomains: string[],
  tools: string[], maxSpendUSD: number }

// Deno lane   → --no-prompt --no-remote plus --allow-read/write/net
//               only for the declared paths and domains.
// Docker lane → --network none --cap-drop ALL --read-only --user uid:gid,
//               scoped :ro / :rw mounts. A declaration with netDomains
//               THROWS: plain docker run cannot enforce per-domain egress,
//               so network-capable rules belong in the Deno lane.`}
        />
        <SpecTable
          head={['lane', 'runs', 'network']}
          rows={[
            ['Deno', 'JS / TS rule code, managed Deno binary (sha256-pinned)', 'per-domain allow-list enforced'],
            ['Docker', 'any other language, alpine container', 'fails closed, no network at all'],
          ]}
        />
        <P>
          Both lanes share one contract: the program gets one JSON document on stdin and must print
          one JSON document to stdout. Anything else is a structured error. Output is bounded to 1 MiB
          and a wall-clock deadline is enforced with SIGKILL.
        </P>

        <H2>Audit log and working undo</H2>
        <P>
          Every committed action logs a reversible delta, captured <Strong>before</Strong> it runs: a
          created node&apos;s inverse is a delete, an updated node&apos;s inverse is the pre-image of
          only the touched properties, a file write&apos;s inverse is the backed-up original. Raw
          mutating Cypher has no generic inverse, so the whole action is flagged irreversible rather
          than half-undone. Undo applies the inverse through the same write lane and is itself audited.
        </P>
        <Callout tone="accent" title="Undo by source">
          Because provenance is stamped on everything, one query can purge everything extracted from a
          poisoned session.
        </Callout>

        <H2>Untrusted content and the injection scanner</H2>
        <P>
          Ingested and tool content is typed as <Code>UntrustedText</Code>, which is deliberately not
          assignable to <Code>string</Code>. It can only reach storage or a prompt through two named
          sink functions, and its coercion traps return a redacted marker so accidental interpolation
          leaks nothing.
        </P>
        <P>
          At ingest, an injection scanner runs a deterministic regex pass and an optional local-LLM
          verdict. A flag <Strong>never blocks ingestion</Strong>. Content stores as inert data
          regardless, and the finding lands in the review queue. Detection is the fallible layer;
          containment and undo are the reliable ones.
        </P>

        <H3>The $0.50 budget ceiling</H3>
        <P>
          Every cloud-touching agent checks the per-task ceiling <Strong>before</Strong> spending and
          records cost after, so a runaway loop halts on the first call past the ceiling. The spend
          tier is also pre-checked at the permission layer, giving two independent enforcement points.
        </P>
      </DocProse>
    </div>
  )
}
