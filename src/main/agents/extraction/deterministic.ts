/**
 * Deterministic pass (§17 step 1): the facts the OS already controls — no
 * model, nothing to hallucinate, confidence 1.0.
 *
 * Sources, per the §6 capture design:
 * - `mcp_calls` rows (the reliable backbone): successful `get_skill` calls
 *   name Skills that provably exist in the graph — they were just served;
 * - transcript record facts (deterministic parse, not model output): which
 *   external MCP servers / plugins / skills fired as tool_use records, and
 *   the session's cwd for the Project match.
 *
 * Everything here PLANS; the gated-write step commits (§21 rule 1: one lane
 * job). Reads are direct, like every read path.
 */
import { createHash } from 'node:crypto'
import { basename } from 'node:path'
import { rootKeyOf, tagSlug } from '../../ingest'
import type { StorageEngine } from '../../storage'
import type { CollectedState, DeterministicPlan, PlannedRef } from './types'

const sha256Hex = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex')

/** Names of skills the session provably used, from calls + transcript. */
function usedSkillNames(collected: CollectedState): string[] {
  const names = new Set<string>()
  for (const call of collected.calls) {
    if (call.tool !== 'get_skill' || !call.ok) continue
    const name = call.params?.['name']
    if (typeof name === 'string' && name.trim() !== '') names.add(name.trim())
  }
  for (const name of collected.transcript?.skillNames ?? []) names.add(name)
  return [...names].sort()
}

/**
 * Match-or-plan a structural MCP/Plugin node by exact name (§18 write path:
 * "MERGE Skill/MCP/Plugin used"). Created ids are readable slugs, suffixed on
 * the improbable collision — same convention as Tag ids.
 */
async function planNamedNode(
  engine: StorageEngine,
  label: 'MCP' | 'Plugin',
  name: string
): Promise<PlannedRef> {
  const rows = await engine.cypher(`MATCH (n:${label}) WHERE n.name = $name RETURN n.id AS id LIMIT 1`, { name })
  const row = rows[0]
  if (row) return { id: String(row['id']), name, create: false }
  const prefix = label === 'MCP' ? 'mcp' : 'plugin'
  let id = `${prefix}-${tagSlug(name) || sha256Hex(name).slice(0, 8)}`
  const taken = await engine.cypher(`MATCH (n:${label} {id: $id}) RETURN n.id AS id LIMIT 1`, { id })
  if (taken.length > 0) id = `${id}-${sha256Hex(name).slice(0, 6)}`
  return { id, name, create: true }
}

/**
 * Project match by cwd path identity (§17: "deterministic key-match where
 * stable IDs exist (… project path)"). Order mirrors phase-07's planProject:
 * path-derived id → the project already owning this root's components →
 * exact-name match on the folder basename → plan a create. The created
 * summary is a deterministic stub — this pass runs no model; a later
 * codebase ingest of the same root will find this node by the same id.
 */
async function planProjectByCwd(
  engine: StorageEngine,
  cwd: string,
  sessionNodeId: string,
  notes: string[]
): Promise<(PlannedRef & { summary?: string }) | null> {
  const rootKey = rootKeyOf(cwd)
  const pathDerivedId = `proj-${rootKey}`

  const byPath = await engine.cypher('MATCH (p:Project {id: $id}) RETURN p.name AS name LIMIT 1', {
    id: pathDerivedId
  })
  const pathRow = byPath[0]
  if (pathRow) {
    return { id: pathDerivedId, name: String(pathRow['name'] ?? basename(cwd)), create: false }
  }

  const byComponents = await engine.cypher(
    `MATCH (p:Project)-[:HAS_COMPONENT]->(c:Component)
     WHERE c.id STARTS WITH $prefix RETURN DISTINCT p.id AS id, p.name AS name LIMIT 1`,
    { prefix: `cmp-${rootKey}-` }
  )
  const componentRow = byComponents[0]
  if (componentRow) {
    return { id: String(componentRow['id']), name: String(componentRow['name'] ?? basename(cwd)), create: false }
  }

  const name = basename(cwd)
  if (name !== '') {
    const byName = await engine.cypher('MATCH (p:Project) WHERE p.name = $name RETURN p.id AS id LIMIT 1', {
      name
    })
    const nameRow = byName[0]
    if (nameRow) return { id: String(nameRow['id']), name, create: false }
  }

  if (name === '') {
    notes.push(`project: cwd '${cwd}' has no basename — no Project matched or created`)
    return null
  }
  return {
    id: pathDerivedId,
    name,
    create: true,
    summary: `Project first seen in extraction of session ${sessionNodeId} (working directory: ${cwd}).`
  }
}

/** The §17 step-1 pass: plan Session + USED refs + Project, reads only. */
export async function planDeterministic(
  engine: StorageEngine,
  collected: CollectedState
): Promise<DeterministicPlan> {
  const notes: string[] = []

  // Session timing: the call log brackets it; transcript timestamps widen it.
  let startedMs: number | null = null
  let endedMs: number | null = null
  for (const call of collected.calls) {
    const end = call.startedUnixMs + (call.durationMs ?? 0)
    if (startedMs === null || call.startedUnixMs < startedMs) startedMs = call.startedUnixMs
    if (endedMs === null || end > endedMs) endedMs = end
  }
  for (const iso of [collected.transcript?.startedAt, collected.transcript?.endedAt]) {
    if (iso === null || iso === undefined) continue
    const ms = Date.parse(iso)
    if (Number.isNaN(ms)) continue
    if (startedMs === null || ms < startedMs) startedMs = ms
    if (endedMs === null || ms > endedMs) endedMs = ms
  }

  // Skills: matched to EXISTING Skill nodes only. A skill name seen in the
  // transcript with no graph node is a client-local skill, not OS memory —
  // creating an empty Skill shell would pollute list_skills and the
  // skill-improvement loop (recorded decision).
  const skills: PlannedRef[] = []
  for (const name of usedSkillNames(collected)) {
    const rows = await engine.cypher('MATCH (s:Skill) WHERE s.name = $name RETURN s.id AS id LIMIT 1', { name })
    const row = rows[0]
    if (row) {
      skills.push({ id: String(row['id']), name, create: false })
    } else {
      notes.push(`skill '${name}' was used but has no Skill node — skipped (existing skills only)`)
    }
  }

  const mcps: PlannedRef[] = []
  for (const name of collected.transcript?.mcpServers ?? []) {
    mcps.push(await planNamedNode(engine, 'MCP', name))
  }
  const plugins: PlannedRef[] = []
  for (const name of collected.transcript?.pluginNames ?? []) {
    plugins.push(await planNamedNode(engine, 'Plugin', name))
  }

  const project =
    collected.cwd !== null && collected.cwd.trim() !== ''
      ? await planProjectByCwd(engine, collected.cwd.trim(), collected.sessionNodeId, notes)
      : null
  if (collected.cwd === null) notes.push('project: no cwd available (no transcript cwd, none supplied) — session has no Project')

  return {
    session: {
      id: collected.sessionNodeId,
      startedAt: startedMs === null ? null : new Date(startedMs).toISOString(),
      endedAt: endedMs === null ? null : new Date(endedMs).toISOString(),
      transcriptRef: collected.transcriptPath
    },
    skills,
    mcps,
    plugins,
    project,
    notes
  }
}
