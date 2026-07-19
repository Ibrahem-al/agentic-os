/** Docs → Overview (ported from the engineering handbook). */
import { DOC_NAV, DocHeader, DocProse, H2, Li, P, Strong, Ul } from '../../ui/docs'

export function Overview(): React.JSX.Element {
  const sections = DOC_NAV.flatMap((g) => g.links).filter((l) => l.key !== 'overview')
  return (
    <div>
      <DocHeader
        kicker="engineering handbook"
        title="Understand every part of Agentic OS"
        intro="If you were rebuilding Agentic OS from scratch, these pages would tell you how each subsystem works, what it is built on, and why the boundaries sit where they do. Start with the architecture, then follow the data."
      />

      <DocProse>
        <H2>What this is</H2>
        <P>
          Agentic OS is a <Strong>local-first</Strong> desktop app that acts as a memory-and-tool backend for AI agents. Claude
          connects over MCP and does the orchestration; this app serves context on demand, learns from finished sessions, and runs
          background agents. Your memory graph, embeddings, and search index all live on your machine — the reasoning tier is
          bring-your-own.
        </P>

        <H2>The handbook</H2>
        <Ul>
          {sections.map((l) => (
            <Li key={l.key}>
              <Strong>{l.label}.</Strong> {l.blurb}
            </Li>
          ))}
        </Ul>

        <P>Pick a section from the list on the left. Each page stands on its own, but they read best in order.</P>
      </DocProse>
    </div>
  )
}
