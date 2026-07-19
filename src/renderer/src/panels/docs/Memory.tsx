/** Docs → Memory & storage (ported from the engineering handbook). */
import { Callout, Code, CodeBlock, DocHeader, DocProse, H2, H3, P, SpecTable, Strong } from '../../ui/docs'

const RETRIEVABLE: string[] = ['Project', 'Skill', 'Preference', 'Knowledge']
const STRUCTURAL: string[] = [
  'Session',
  'SkillVersion',
  'Example',
  'Correction',
  'MCP',
  'Plugin',
  'Component',
  'Document',
  'Tag'
]

function LabelChip({ name, tone }: { name: string; tone: 'ok' | 'neutral' }): React.JSX.Element {
  return (
    <span
      className={
        tone === 'ok'
          ? 'rounded-md border border-ok/30 bg-ok/10 px-2.5 py-1 font-mono text-[12px] text-ok'
          : 'rounded-md border border-line bg-raised px-2.5 py-1 font-mono text-[12px] text-ink-mute'
      }
    >
      {name}
    </span>
  )
}

export function Memory(): React.JSX.Element {
  return (
    <div>
      <DocHeader
        kicker="internals"
        title="Memory & storage"
        intro="The persistent memory is RyuGraph: a single embedded engine that does vector search, graph traversal, and full-text search with Cypher, in-process, with no server. It is the system's memory. A separate SQLite database holds the operational machinery. Every graph write funnels through one serialized lane."
      />

      <DocProse>
        <H2>RyuGraph, embedded</H2>
        <P>
          RyuGraph plays the combined role of a vector store and a graph database in one on-disk
          file. It is the maintained MIT fork of Kùzu. Vector and full-text are native extensions,
          loaded by <Strong>absolute path from the build</Strong>, never fetched at runtime. The
          engine opens one database with two connections: a write connection the lane serializes, and
          a read connection for direct reads.
        </P>
        <Callout title="Single-writer, by design">
          RyuGraph is single-writer, and no write path is latency-critical, so serializing every
          mutation through one FIFO lane is the concurrency-correctness foundation. Reads never queue.
        </Callout>

        <H2>The graph schema</H2>
        <P>
          Thirteen node labels in two classes. <Strong>Retrievable</Strong> nodes carry a bge-m3
          embedding and a full-text index, so hybrid search matches them. <Strong>Structural</Strong>{' '}
          nodes have no embedding and are reached by traversal.
        </P>
      </DocProse>

      <div className="my-8 flex flex-col gap-5 rounded-lg border border-line bg-surface/40 p-5 sm:p-6">
        <div>
          <div className="mb-2 font-mono text-[11px] text-ok">retrievable · embedding + full-text</div>
          <div className="flex flex-wrap gap-1.5">
            {RETRIEVABLE.map((n) => (
              <LabelChip key={n} name={n} tone="ok" />
            ))}
          </div>
        </div>
        <div>
          <div className="mb-2 font-mono text-[11px] text-ink-faint">structural · reached by traversal</div>
          <div className="flex flex-wrap gap-1.5">
            {STRUCTURAL.map((n) => (
              <LabelChip key={n} name={n} tone="neutral" />
            ))}
          </div>
        </div>
      </div>

      <DocProse>
        <H3>Relationships</H3>
        <P>Fifteen edge types over 23 from/to pairs. The ones that carry the memory:</P>
        <SpecTable
          head={['edge', 'from → to']}
          rows={[
            ['PRODUCED / USED / USES', 'Session/Project → Skill · MCP · Plugin'],
            ['HAS_COMPONENT / DEPENDS_ON', 'Project → Component → Component'],
            ['HAS_VERSION / HAS_EXAMPLE', 'Skill → SkillVersion · Example'],
            ['IMPROVED / DERIVED_FROM', 'Correction → Skill · Preference → Correction'],
            ['APPLIES_TO / TAGGED', 'Preference → Tag · anything → Tag'],
            ['HAS_CHUNK / EXTRACTED_FROM', 'Document → Knowledge · node → Session']
          ]}
        />
        <P>
          Every node and edge carries engine-stamped <Code>created_at</Code> / <Code>updated_at</Code>.
          Extraction-written labels (Component, Preference, Knowledge) and every relationship also
          carry <Code>extracted_by</Code> and <Code>confidence</Code>, so extraction can stamp
          provenance on anything it writes. Provenance is structural metadata: never embedded, never
          matched by search.
        </P>

        <H2>The single write lane</H2>
        <P>
          <Code>WriteLane</Code> is a dependency-free async FIFO. Every mutation is enqueued and runs
          one at a time, never overlapping; a ring journal proves FIFO and max-concurrency-1. A failed
          job rejects its caller but the lane advances. Reentrancy is a hard error, so a job can never
          deadlock behind itself.
        </P>
        <CodeBlock
          label="every write routes here"
          code={`upsertNode → lane.enqueue('upsertNode:<label>', …)
createEdge → lane.enqueue('createEdge:<type>', …)
withWrite  → lane.enqueue('withWrite', …)   // hands fn a reserved WriteTx
cypher     → mutating? lane : readConn        // conservative regex detection

// Provenance is stamped by the engine at write time: created_at/updated_at
// on create, extracted_by/confidence passed verbatim by the extraction agent.
// Callers may not supply timestamps.`}
        />

        <H2>Migrations and backups</H2>
        <P>
          The graph store carries a schema version as a node, plus a sidecar JSON read before the db
          is opened. Before any migration runs, the <Strong>whole graph directory is copied</Strong> to{' '}
          <Code>backups/&lt;stamp&gt;-pre-migration-v&lt;N&gt;/</Code>. The app refuses to open a store
          newer than itself. <Code>appdata.db</Code> is snapshotted with <Code>VACUUM INTO</Code>{' '}
          before its own schema upgrades.
        </P>
        <H3>Crash recovery</H3>
        <P>
          A torn or corrupt graph WAL from a hard kill is <Strong>quarantined and preserved</Strong>{' '}
          rather than deleted, and the store recovers to its last checkpoint — a crash no longer
          disables the app. Periodic, dirty-gated checkpointing bounds worst-case loss from a hard
          kill to about two minutes.
        </P>
        <H3>Automatic and manual backups</H3>
        <P>
          Beyond the pre-migration snapshot, the store backs itself up on a schedule you set — every
          6 or 12 hours, daily, or weekly — alongside a manual <Code>Backup now</Code>. Retention
          keeps the last N or the last D days, and pruning only ever removes automatic backups. Any
          backup restores to that exact point, snapshotting the current state first so the restore is
          undoable; a data reset makes you type <Code>RESET</Code>, takes a final snapshot, and never
          deletes backups. Each of these operations stages and applies at launch, before the database
          opens.
        </P>
        <H3>Your memory is never trapped</H3>
        <P>
          A weekly export job (Sunday 03:30) dumps every node and edge to Neo4j-compatible CSV plus a
          Cypher script and a manifest, under <Code>exports/&lt;date&gt;/</Code>.
        </P>
      </DocProse>
    </div>
  )
}
