/** Docs → Background agents (ported from the engineering handbook). */
import { Callout, DocHeader, DocProse, H2, H3, Li, P, SpecTable, Strong, Ul } from '../../ui/docs'

function StepFlow({ steps, terminal }: { steps: string[]; terminal?: string }): React.JSX.Element {
  return (
    <div className="my-6 overflow-x-auto">
      <div className="flex min-w-max items-center gap-2">
        {steps.map((s, i) => (
          <div key={s} className="flex items-center gap-2">
            <span className="rounded-md border border-line bg-surface px-3 py-2 font-mono text-[12.5px] text-ink">
              {s}
            </span>
            {i < steps.length - 1 && <span className="font-mono text-ink-faint">→</span>}
          </div>
        ))}
        {terminal && (
          <>
            <span className="font-mono text-ink-faint">→</span>
            <span className="rounded-md border border-accent/40 bg-accent/10 px-3 py-2 font-mono text-[12.5px] text-accent">
              {terminal}
            </span>
          </>
        )}
      </div>
    </div>
  )
}

export function Agents(): React.JSX.Element {
  return (
    <div>
      <DocHeader
        kicker="internals"
        title="Background agents"
        intro="Two agents run as durable LangGraph workflows: extraction turns one finished session into graph memory, and skill improvement rewrites and benchmarks skills that have accrued corrections. Both checkpoint every step to SQLite, so a crash mid-run resumes from the last completed step without re-buying earlier model calls."
      />

      <DocProse>
        <H2>Extraction: learning from a finished session</H2>
        <P>Three convergent triggers, deduped to exactly one extraction per session:</P>
        <Ul>
          <Li><Strong>The SessionEnd hook</Strong> POSTs the session id and transcript path to the app, which enqueues extraction.</Li>
          <Li><Strong>The spool drain</Strong> replays sessions that arrived while the app was closed.</Li>
          <Li><Strong>An inactivity sweep</Strong> catches sessions silent past 30 minutes that have no extraction task yet.</Li>
        </Ul>
      </DocProse>

      <StepFlow steps={['collect', 'deterministic', 'extract', 'resolve', 'verify']} terminal="write" />

      <DocProse>
        <Ul>
          <Li><Strong>collect</Strong> reads the server-side call log and parses the transcript.</Li>
          <Li><Strong>deterministic</Strong> plans the facts the OS controls at confidence 1.0: skills used, MCPs/plugins, the project by working directory, session timing. It matches existing nodes only, never inventing shells.</Li>
          <Li><Strong>extract</Strong> runs focused local-LLM passes (components, preferences, corrections) with constrained JSON decoding. A malformed item is dropped, never a crash; a missing confidence becomes 0.5.</Li>
          <Li><Strong>resolve</Strong> deduplicates against memory with a tiered ladder: stable-key, then cosine ≥ 0.90 merge, then an LLM tiebreak in the 0.75-0.90 band, then a new node.</Li>
          <Li><Strong>verify</Strong> sends below-gate items to an independent verifier that must be a different model than the extractor.</Li>
          <Li><Strong>write</Strong> commits or stages each item through one audited write-lane job.</Li>
        </Ul>

        <Callout tone="warn" title="The 0.6 write gate">
          Items at or above 0.6 confidence commit. Below that, an item commits only if an independent
          verifier confirms it; otherwise it is <Strong>staged to the review queue</Strong> with a
          human-readable reason. Low-confidence memory never lands silently.
        </Callout>

        <H3>Escalation</H3>
        <P>
          Two gates push a session to the optional cloud tier: a transcript over 60k tokens, or a
          local confidence below 0.6. Both fall back to the local result if no cloud key is
          configured. Every cloud call is metered against the task&apos;s $0.50 ceiling.
        </P>

        <H2>Skill improvement: getting better overnight</H2>
        <P>
          At 02:00, or on a manual &quot;improve now,&quot; skills that accrued new corrections or
          failure examples get a candidate rewrite, benchmarked against the active version. It
          reimplements the skill-creator methodology in-process.
        </P>
      </DocProse>

      <StepFlow steps={['plan', 'testset', 'candidate', 'benchmark']} terminal="adopt / stage" />

      <DocProse>
        <Ul>
          <Li><Strong>plan</Strong> event-gates on new signal since the last run and scans for drift.</Li>
          <Li><Strong>testset</Strong> turns each correction into a regression case and pads with synthetic cases, then splits 60/40 into train and a held-out set the rewriter never sees.</Li>
          <Li><Strong>candidate</Strong> asks the cloud brain to rewrite the SKILL.md from recent failures. It sees the corrections, never the test cases.</Li>
          <Li><Strong>benchmark</Strong> runs candidate vs active on the LOCAL tier: an assertion grader for verifiable skills, a blind A/B comparator (judged by the cloud tier) for stylistic ones.</Li>
        </Ul>

        <SpecTable
          head={['skill kind', 'adoption rule']}
          rows={[
            ['verifiable', 'auto-adopt only when net-positive on the held-out split AND zero regressions on previously-fixed corrections'],
            ['stylistic', 'never auto-adopted; a candidate is staged for one-click human approval']
          ]}
        />
        <P>
          Every adoption is versioned (candidate → active, prior active → retired) and the skill
          re-embeds so retrieval serves the new version immediately. New versions are{' '}
          <Strong>drift-watched</Strong> over their first 20 uses; a worse corrections-per-use rate can
          flag or auto-revert. Every version flip is a reversible audited delta.
        </P>
      </DocProse>
    </div>
  )
}
