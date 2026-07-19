/** Docs → Retrieval pipeline (ported from the engineering handbook). */
import { Callout, Code, CodeBlock, DocHeader, DocProse, H2, H3, Li, P, SpecTable, Strong, Ul } from '../../ui/docs'

export function Retrieval(): React.JSX.Element {
  return (
    <div>
      <DocHeader
        kicker="internals"
        title="Retrieval pipeline"
        intro="get_context assembles context with a hybrid search wrapped in a bounded, self-correcting loop. Vector and full-text arms fuse with graph proximity, a cross-encoder reranks the fused head, and a local critic decides whether the bundle is good enough or the query should be rewritten and retried. It runs entirely on the local tier and spends no cloud money."
      />

      <DocProse>
        <H2>One pass, seven stages</H2>
        <P>The read path (<Code>runReadPath</Code>) runs these stages over the four retrievable labels: Project, Skill, Preference, and Knowledge.</P>
        <Ul>
          <Li><Strong>Embed.</Strong> The query is embedded once with bge-m3 (1024-dim).</Li>
          <Li><Strong>Two search arms, parallel.</Strong> Vector top-30 per label and full-text top-30 overall. The full-text query is sanitized to plain word characters because the tokenizer strips punctuation.</Li>
          <Li><Strong>Graph expansion.</Strong> Project → skills/MCPs/plugins/components at hop 1; matched tags → their preferences; skills → their active version and recent examples. Global preferences are always included.</Li>
          <Li><Strong>Fusion.</Strong> Per-arm sub-scores normalize to [0,1] and combine with the weights below. Graph proximity is earned, not automatic: a seed hit gets no default graph signal.</Li>
          <Li><Strong>Rerank.</Strong> The fused head (up to 50 candidates) is reranked once by the cross-encoder. Fuse first, rerank the fused set, never per label.</Li>
          <Li><Strong>Final ordering.</Strong> <Code>sigmoid(rerankLogit) + 0.3 × graph</Code>, because the cross-encoder only reads text and its absolute logits carry a class bias.</Li>
          <Li><Strong>Token-budgeted assembly.</Strong> Global preferences enter first, always. The reranked top-8 fill the remaining budget in rank order.</Li>
        </Ul>

        <H2>The numbers</H2>
        <SpecTable
          head={['constant', 'value', 'role']}
          rows={[
            ['RETRIEVAL_VECTOR_TOP_K', '30', 'vector hits per retrievable label'],
            ['RETRIEVAL_FTS_TOP_K', '30', 'full-text hits, single overall cut'],
            ['RETRIEVAL_FUSION_WEIGHTS', '0.5 / 0.2 / 0.3', 'vector / keyword / graph proximity'],
            ['RETRIEVAL_GRAPH_DECAY', '0.5', 'graph score = 0.5 ^ hops'],
            ['RETRIEVAL_RERANK_TOP_K', '50', 'fused candidates handed to the cross-encoder'],
            ['RETRIEVAL_BUNDLE_TOP_N', '8', 'items in the returned bundle'],
            ['RETRIEVAL_BUNDLE_TOKEN_BUDGET', '8,192', 'token budget (overridable per call)']
          ]}
        />

        <H2>The self-correcting loop</H2>
        <P>
          The single pass is wrapped in a bounded loop: run the pass, have a <Strong>separate</Strong>{' '}
          local critic score the bundle against a relevance / coverage / specificity rubric, and if it
          fails, rewrite the query and retry.
        </P>
        <CodeBlock
          label="loop control"
          code={`pass → local critic vs rubric → (pass? return : rewrite query → retry)

LOOP_MAX_ITERATIONS         = 5     // then return best-effort
RETRIEVAL_CRITIC_PASS_SCORE = 0.7   // normalized score to pass

halt reasons: passed | non-improvement | max-iterations
              | budget-exceeded | loop-error

confidence is binary: 'high' iff the critic passed 0.7, else 'low'.
The critic uses the LOCAL tier (qwen3, thinking off) and a prompt
different from the one that produced the content, to reduce self-bias.`}
        />
        <Callout title="Always returns best-effort">
          If the budget is exceeded with no bundle yet, the loop still runs one free local pass (pure
          local reads, $0) and returns it. Retrieval never fails closed.
        </Callout>

        <H3>Measured latency</H3>
        <P>
          The offline pipeline machinery runs at p50 ≈ 117 ms. Live on CPU, one pass is ~1.7 s,
          dominated by the models: a bge-m3 query embed ≈ 465 ms and the warm int8 rerank ≈ 30 ms per
          document.
        </P>
      </DocProse>
    </div>
  )
}
