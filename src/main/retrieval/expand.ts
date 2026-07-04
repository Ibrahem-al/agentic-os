/**
 * Graph expansion (§18 read path step 2). From the seed hits:
 *   project → its skills / MCPs / plugins / components,
 *   matched tags (caller-requested by name, or TAGGED from seeds)
 *     → preferences APPLIES_TO them,
 *   skill (seed or project-derived) → active SkillVersion + recent Examples,
 * and ALWAYS the global Tag's preferences.
 *
 * Read-only by construction (§21 "no writes in this path"): every statement is
 * MATCH/UNWIND/RETURN and avoids the engine's mutation-detector keywords, so
 * everything runs on the direct read connection — the integration tests assert
 * the write-lane journal never grows during retrieval.
 */
import { RETRIEVAL_RECENT_EXAMPLES } from '../config'
import type { StorageEngine } from '../storage'
import { mergeCandidate, type Candidate } from './fusion'

export interface ExpansionOutcome {
  /** Preferences applying to the global Tag(s) — always bundled (§18 step 1). */
  readonly globalPreferenceIds: string[]
  /** Tag ids that mediated preference expansion (requested + seed-derived). */
  readonly matchedTagIds: string[]
}

function idsOf(rows: readonly Record<string, unknown>[]): string[] {
  return rows.map((r) => String(r['id']))
}

/**
 * Expand from the current seed candidates, merging discovered nodes into the
 * candidate map with their hop distance (min hop wins on re-discovery).
 */
export async function expandGraph(
  engine: StorageEngine,
  candidates: Map<string, Candidate>,
  requestedTags: readonly string[]
): Promise<ExpansionOutcome> {
  const seeds = [...candidates.values()]
  const seedIds = (label: Candidate['label']): string[] =>
    seeds.filter((c) => c.label === label).map((c) => c.id)

  const projectIds = seedIds('Project')

  // project → skills / MCPs / plugins / components (hop 1)
  const skillHops = new Map<string, number>()
  for (const id of seedIds('Skill')) skillHops.set(id, 0)
  if (projectIds.length > 0) {
    const [skills, mcps, plugins, components] = await Promise.all([
      engine.cypher(
        'UNWIND $ids AS pid MATCH (p:Project {id: pid})-[:USES]->(s:Skill) RETURN DISTINCT s.id AS id',
        { ids: projectIds }
      ),
      engine.cypher(
        'UNWIND $ids AS pid MATCH (p:Project {id: pid})-[:USES]->(m:MCP) RETURN DISTINCT m.id AS id',
        { ids: projectIds }
      ),
      engine.cypher(
        'UNWIND $ids AS pid MATCH (p:Project {id: pid})-[:USES]->(g:Plugin) RETURN DISTINCT g.id AS id',
        { ids: projectIds }
      ),
      engine.cypher(
        'UNWIND $ids AS pid MATCH (p:Project {id: pid})-[:HAS_COMPONENT]->(c:Component) RETURN DISTINCT c.id AS id',
        { ids: projectIds }
      )
    ])
    for (const id of idsOf(skills)) {
      mergeCandidate(candidates, { label: 'Skill', id, graphHops: 1 })
      if (!skillHops.has(id)) skillHops.set(id, 1)
    }
    for (const id of idsOf(mcps)) mergeCandidate(candidates, { label: 'MCP', id, graphHops: 1 })
    for (const id of idsOf(plugins)) mergeCandidate(candidates, { label: 'Plugin', id, graphHops: 1 })
    for (const id of idsOf(components)) mergeCandidate(candidates, { label: 'Component', id, graphHops: 1 })
  }

  // matched tags: requested by name (hop 0) ∪ TAGGED from seed hits (hop 1)
  const tagHops = new Map<string, number>()
  if (requestedTags.length > 0) {
    const rows = await engine.cypher('MATCH (t:Tag) WHERE t.name IN $names RETURN t.id AS id', {
      names: [...requestedTags]
    })
    for (const id of idsOf(rows)) tagHops.set(id, 0)
  }
  const taggedSources = (['Project', 'Skill', 'Knowledge'] as const).filter(
    (label) => seedIds(label).length > 0
  )
  const taggedRows = await Promise.all(
    taggedSources.map((label) =>
      engine.cypher(
        `UNWIND $ids AS nid MATCH (n:${label} {id: nid})-[:TAGGED]->(t:Tag) RETURN DISTINCT t.id AS id`,
        { ids: seedIds(label) }
      )
    )
  )
  for (const id of taggedRows.flatMap(idsOf)) {
    if (!tagHops.has(id)) tagHops.set(id, 1)
  }

  // tag → preferences APPLIES_TO it (one hop past the tag)
  const matchedTagIds = [...tagHops.keys()]
  if (matchedTagIds.length > 0) {
    const rows = await engine.cypher(
      'MATCH (pref:Preference)-[:APPLIES_TO]->(t:Tag) WHERE t.id IN $ids RETURN DISTINCT pref.id AS id, t.id AS tag',
      { ids: matchedTagIds }
    )
    for (const row of rows) {
      const hops = (tagHops.get(String(row['tag'])) ?? 1) + 1
      mergeCandidate(candidates, { label: 'Preference', id: String(row['id']), graphHops: hops })
    }
  }

  // ALWAYS the global Tag's preferences (§18 read path step 1)
  const globalPrefRows = await engine.cypher(
    'MATCH (pref:Preference)-[:APPLIES_TO]->(t:Tag) WHERE t.is_global = true RETURN DISTINCT pref.id AS id'
  )
  const globalPreferenceIds = idsOf(globalPrefRows).sort()

  // skill (seed hop 0 or project-derived hop 1) → active version + recent examples
  const skillIds = [...skillHops.keys()]
  if (skillIds.length > 0) {
    const [versionRows, exampleRows] = await Promise.all([
      engine.cypher(
        "UNWIND $ids AS sid MATCH (s:Skill {id: sid})-[:HAS_VERSION]->(v:SkillVersion) WHERE v.status = 'active' RETURN DISTINCT sid AS skill, v.id AS id",
        { ids: skillIds }
      ),
      engine.cypher(
        'UNWIND $ids AS sid MATCH (s:Skill {id: sid})-[:HAS_EXAMPLE]->(e:Example) RETURN sid AS skill, e.id AS id ORDER BY e.created_at DESC, e.id',
        { ids: skillIds }
      )
    ])
    for (const row of versionRows) {
      const hops = (skillHops.get(String(row['skill'])) ?? 1) + 1
      mergeCandidate(candidates, { label: 'SkillVersion', id: String(row['id']), graphHops: hops })
    }
    const perSkill = new Map<string, number>()
    for (const row of exampleRows) {
      const skill = String(row['skill'])
      const taken = perSkill.get(skill) ?? 0
      if (taken >= RETRIEVAL_RECENT_EXAMPLES) continue
      perSkill.set(skill, taken + 1)
      const hops = (skillHops.get(skill) ?? 1) + 1
      mergeCandidate(candidates, { label: 'Example', id: String(row['id']), graphHops: hops })
    }
  }

  return { globalPreferenceIds, matchedTagIds }
}
