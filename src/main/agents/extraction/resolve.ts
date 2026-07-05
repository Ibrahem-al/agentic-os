/**
 * Entity resolution (§17 step 3): write-path dedup, distinct from the
 * retrieval loop. New-vs-existing is decided TIERED per §20:
 *
 *   stable-key match where stable ids exist
 *     → cosine ≥ 0.90 merge
 *     → 0.75–0.90 LLM tiebreak (local small LLM, YES/NO)
 *     → < 0.75 new node
 *
 * Preferences reuse the BGE-M3 vector index directly (they are retrievable).
 * Components are STRUCTURAL (§18: no stored embedding), so their cosine tier
 * embeds both sides at resolution time — the exact text retrieval renders for
 * a Component — against a token-overlap prefilter of the project's existing
 * components (recorded decision: the index cannot serve structural labels).
 *
 * A failed tiebreak (local tier down, unparseable verdict) resolves to 'new'
 * with the item's confidence capped at 0.5 — persistent uncertainty routes to
 * the review queue via the write gate instead of silently merging or dropping.
 */
import { createHash } from 'node:crypto'
import {
  ENTITY_MERGE_COSINE,
  ENTITY_TIEBREAK_COSINE_LOW,
  EXTRACTION_TIEBREAK_MAX_TOKENS
} from '../../config'
import { tagSlug } from '../../ingest'
import type { StorageEngine } from '../../storage'
import { extractJsonObject } from './fuzzy'
import {
  normalizeItemText,
  type DeterministicPlan,
  type ExtractionEmbedder,
  type ExtractionLlm,
  type FuzzyExtractionState,
  type PlannedTag,
  type ResolutionDecision,
  type ResolveState,
  type ResolvedComponent,
  type ResolvedCorrection,
  type ResolvedPreference
} from './types'

const sha256Hex = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex')
const sha12 = (text: string): string => sha256Hex(text).slice(0, 12)

export const TIEBREAK_SYSTEM_PROMPT =
  'You are an entity resolution judge for a memory graph. Decide whether two records refer to the same thing. ' +
  'Reply with ONLY JSON: {"same": true} or {"same": false}.'

/** The exact text retrieval renders for a Component (render.ts) — embed that. */
const componentRender = (name: string, type: string): string =>
  type === '' ? `component ${name}` : `component ${name} (${type})`

function cosine(a: readonly number[], b: readonly number[]): number {
  let dot = 0
  let normA = 0
  let normB = 0
  for (let i = 0; i < a.length && i < b.length; i++) {
    const x = a[i] ?? 0
    const y = b[i] ?? 0
    dot += x * y
    normA += x * x
    normB += y * y
  }
  if (normA === 0 || normB === 0) return 0
  return dot / (Math.sqrt(normA) * Math.sqrt(normB))
}

const tokensOf = (text: string): Set<string> => new Set(text.toLowerCase().match(/[a-z0-9]+/g) ?? [])

/** Candidates sharing ≥1 name token with the item, best-overlap first, capped. */
const PREFILTER_CAP = 10

function prefilterByOverlap<T extends { name: string }>(candidateName: string, existing: readonly T[]): T[] {
  const itemTokens = tokensOf(candidateName)
  if (itemTokens.size === 0) return []
  return existing
    .map((candidate) => {
      let overlap = 0
      for (const token of tokensOf(candidate.name)) if (itemTokens.has(token)) overlap += 1
      return { candidate, overlap }
    })
    .filter((entry) => entry.overlap > 0)
    .sort((a, b) => b.overlap - a.overlap)
    .slice(0, PREFILTER_CAP)
    .map((entry) => entry.candidate)
}

/**
 * Ask the local small LLM whether two records are the same entity, with
 * constrained decoding to `{"same": boolean}` (the local model narrates
 * unconstrained — phase-08 finding). Fallback for unconstrained fakes/models:
 * the LAST standalone YES/NO in the reply wins — the model concludes after
 * reasoning. Null = unavailable/unparseable → the caller keeps the item as
 * 'new' with its confidence capped for review.
 */
const TIEBREAK_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: { same: { type: 'boolean' } },
  required: ['same']
}

async function llmTiebreak(
  llm: ExtractionLlm,
  kind: 'preference' | 'component',
  a: string,
  b: string
): Promise<boolean | null> {
  try {
    const result = await llm.generate(
      `Do these two ${kind} records refer to the same ${kind}?\nA: ${a}\nB: ${b}\n` +
        'Reply with JSON: {"same": true} or {"same": false}.',
      {
        system: TIEBREAK_SYSTEM_PROMPT,
        maxTokens: EXTRACTION_TIEBREAK_MAX_TOKENS,
        temperature: 0,
        format: TIEBREAK_SCHEMA
      }
    )
    const parsed = extractJsonObject(result.text)
    if (parsed !== null && typeof parsed['same'] === 'boolean') return parsed['same']
    const matches = [...result.text.matchAll(/\b(yes|no)\b/gi)]
    const last = matches[matches.length - 1]
    if (last === undefined) return null
    return last[1]!.toLowerCase() === 'yes'
  } catch {
    return null
  }
}

export interface ResolveOptions {
  readonly engine: StorageEngine
  readonly embedder: ExtractionEmbedder
  readonly llm: ExtractionLlm
  readonly sessionNodeId: string
  readonly plan: DeterministicPlan
  readonly extraction: FuzzyExtractionState
}

export async function resolveEntities(options: ResolveOptions): Promise<ResolveState> {
  const { engine, embedder, llm, sessionNodeId, plan, extraction } = options
  const warnings: string[] = []

  // ── Everything to embed, in ONE batch (§18: BGE-M3 everywhere) ─────────────
  const texts: string[] = []
  const indexOf = new Map<string, number>()
  const enqueue = (text: string): number => {
    const existing = indexOf.get(text)
    if (existing !== undefined) return existing
    const index = texts.length
    texts.push(text)
    indexOf.set(text, index)
    return index
  }

  for (const pref of extraction.preferences) enqueue(pref.statement)
  for (const component of extraction.components) enqueue(componentRender(component.name, component.type))

  // Existing components of the session's project (the stable-key + cosine
  // candidate pool). Structural nodes have no stored embedding, so the
  // prefiltered candidates are embedded fresh below.
  interface ExistingComponent {
    id: string
    name: string
    type: string
  }
  let existingComponents: ExistingComponent[] = []
  if (plan.project !== null && !plan.project.create && extraction.components.length > 0) {
    const rows = await engine.cypher(
      'MATCH (p:Project {id: $pid})-[:HAS_COMPONENT]->(c:Component) RETURN c.id AS id, c.name AS name, c.type AS type',
      { pid: plan.project.id }
    )
    existingComponents = rows.map((r) => ({
      id: String(r['id']),
      name: String(r['name'] ?? ''),
      type: String(r['type'] ?? '')
    }))
  }
  const cosineCandidates = new Map<string, ExistingComponent[]>()
  for (const component of extraction.components) {
    const shortlist = prefilterByOverlap(component.name, existingComponents)
    cosineCandidates.set(component.name, shortlist)
    for (const candidate of shortlist) enqueue(componentRender(candidate.name, candidate.type))
  }

  if (plan.project?.create) enqueue(`${plan.project.name} — ${plan.project.summary ?? ''}`.trim())

  const embeddings = texts.length > 0 ? await embedder.embed(texts) : []
  const embeddingOf = (text: string): number[] => {
    const index = indexOf.get(text)
    const embedding = index === undefined ? undefined : embeddings[index]
    if (!embedding) throw new Error(`resolution: no embedding computed for '${text.slice(0, 60)}…'`)
    return embedding
  }

  // ── Preferences: vector index → cosine bands → tiebreak ────────────────────
  const preferenceCountRows = await engine.cypher('MATCH (p:Preference) RETURN count(p) AS c')
  const preferenceCount = Number(preferenceCountRows[0]?.['c'] ?? 0)

  const preferences: ResolvedPreference[] = []
  const plannedNewPrefs: { statement: string; embedding: number[]; index: number }[] = []
  for (const pref of extraction.preferences) {
    const embedding = embeddingOf(pref.statement)
    let confidence = pref.confidence

    // Intra-batch first: two near-duplicate statements from the same session
    // must not both become nodes — the duplicate folds into the survivor.
    let intraMatch: { statement: string; index: number } | null = null
    for (const prior of plannedNewPrefs) {
      if (cosine(embedding, prior.embedding) >= ENTITY_MERGE_COSINE) {
        intraMatch = prior
        break
      }
    }
    if (intraMatch !== null) {
      const survivor = preferences[intraMatch.index]!
      preferences[intraMatch.index] = {
        ...survivor,
        confidence: Math.max(survivor.confidence, confidence),
        tags: [...new Set([...survivor.tags, ...pref.tags])]
      }
      preferences.push({
        ...pref,
        resolution: { kind: 'merge', id: survivor.resolution.id, similarity: 1, via: 'intra-batch' },
        embedding: null
      })
      continue
    }

    let resolution: ResolutionDecision | null = null
    if (preferenceCount > 0) {
      const hits = await engine.vectorSearch('Preference', embedding, Math.min(5, preferenceCount))
      const best = hits[0]
      if (best !== undefined) {
        const similarity = 1 - best.distance
        if (similarity >= ENTITY_MERGE_COSINE) {
          resolution = { kind: 'merge', id: best.id, similarity, via: 'cosine' }
        } else if (similarity >= ENTITY_TIEBREAK_COSINE_LOW) {
          const rows = await engine.cypher('MATCH (p:Preference {id: $id}) RETURN p.statement AS s LIMIT 1', {
            id: best.id
          })
          const existingStatement = String(rows[0]?.['s'] ?? '')
          const verdict = await llmTiebreak(llm, 'preference', pref.statement, existingStatement)
          if (verdict === true) {
            resolution = { kind: 'merge', id: best.id, similarity, via: 'llm-tiebreak' }
          } else if (verdict === null) {
            confidence = Math.min(confidence, 0.5)
            warnings.push(
              `preference tiebreak unavailable for '${pref.statement.slice(0, 60)}' (${similarity.toFixed(2)} similar to ${best.id}) — kept as new, confidence capped for review`
            )
          }
        }
      }
    }
    if (resolution === null) {
      const id = `pref-${sha12(`${sessionNodeId}\n${normalizeItemText(pref.statement)}`)}`
      resolution = { kind: 'new', id }
      plannedNewPrefs.push({ statement: pref.statement, embedding, index: preferences.length })
    }
    preferences.push({
      ...pref,
      confidence,
      resolution,
      embedding: resolution.kind === 'new' ? embedding : null
    })
  }

  // ── Components: stable-key → in-memory cosine → tiebreak ───────────────────
  const components: ResolvedComponent[] = []
  for (const component of extraction.components) {
    let confidence = component.confidence
    let resolution: ResolutionDecision | null = null
    const normName = normalizeItemText(component.name)

    const stableKeyMatch = existingComponents.find((c) => normalizeItemText(c.name) === normName)
    if (stableKeyMatch !== undefined) {
      resolution = { kind: 'merge', id: stableKeyMatch.id, similarity: 1, via: 'stable-key' }
    } else {
      const embedding = embeddingOf(componentRender(component.name, component.type))
      let best: { candidate: ExistingComponent; similarity: number } | null = null
      for (const candidate of cosineCandidates.get(component.name) ?? []) {
        const similarity = cosine(embedding, embeddingOf(componentRender(candidate.name, candidate.type)))
        if (best === null || similarity > best.similarity) best = { candidate, similarity }
      }
      if (best !== null && best.similarity >= ENTITY_MERGE_COSINE) {
        resolution = { kind: 'merge', id: best.candidate.id, similarity: best.similarity, via: 'cosine' }
      } else if (best !== null && best.similarity >= ENTITY_TIEBREAK_COSINE_LOW) {
        const verdict = await llmTiebreak(
          llm,
          'component',
          componentRender(component.name, component.type),
          componentRender(best.candidate.name, best.candidate.type)
        )
        if (verdict === true) {
          resolution = { kind: 'merge', id: best.candidate.id, similarity: best.similarity, via: 'llm-tiebreak' }
        } else if (verdict === null) {
          confidence = Math.min(confidence, 0.5)
          warnings.push(
            `component tiebreak unavailable for '${component.name}' (${best.similarity.toFixed(2)} similar to ${best.candidate.id}) — kept as new, confidence capped for review`
          )
        }
      }
    }
    if (resolution === null) {
      resolution = { kind: 'new', id: `cmp-x-${sha12(`${sessionNodeId}\n${normName}`)}` }
    }
    components.push({ ...component, confidence, resolution })
  }

  // ── Corrections: observations, keyed per session — no cross-session dedup ──
  const corrections: ResolvedCorrection[] = []
  for (const correction of extraction.corrections) {
    let skillId: string | null = null
    if (correction.skill !== null) {
      const fromPlan = plan.skills.find((s) => s.name === correction.skill)
      if (fromPlan !== undefined) {
        skillId = fromPlan.id
      } else {
        const rows = await engine.cypher('MATCH (s:Skill) WHERE s.name = $name RETURN s.id AS id LIMIT 1', {
          name: correction.skill
        })
        skillId = rows[0] ? String(rows[0]['id']) : null
        if (skillId === null) {
          warnings.push(`correction names skill '${correction.skill}' but no such Skill node exists — IMPROVED edge skipped`)
        }
      }
    }
    corrections.push({
      ...correction,
      id: `corr-${sha12(`${sessionNodeId}\n${normalizeItemText(correction.content)}`)}`,
      skillId
    })
  }

  // ── Tags (§18 "tag everything"): preference tags + the project's name tag ──
  const tagNames = new Map<string, string>() // normalized → display
  for (const pref of preferences) {
    for (const tag of pref.tags) {
      const name = tag.trim()
      if (name !== '') tagNames.set(name.toLowerCase(), name)
    }
  }
  const tags: PlannedTag[] = []
  const planTag = async (name: string): Promise<PlannedTag> => {
    const rows = await engine.cypher('MATCH (t:Tag) WHERE t.name = $name RETURN t.id AS id LIMIT 1', { name })
    const row = rows[0]
    if (row) return { id: String(row['id']), name, create: false }
    let id = `tag-${tagSlug(name) || sha256Hex(name).slice(0, 8)}`
    const taken = await engine.cypher('MATCH (t:Tag {id: $id}) RETURN t.id AS id LIMIT 1', { id })
    if (taken.length > 0) id = `${id}-${sha256Hex(name).slice(0, 6)}`
    return { id, name, create: true }
  }
  for (const name of [...tagNames.values()].sort()) tags.push(await planTag(name))

  let projectTag: PlannedTag | null = null
  let projectAlreadyTagged = false
  if (plan.project !== null) {
    projectTag = tags.find((t) => t.name === plan.project!.name) ?? (await planTag(plan.project.name))
    if (!plan.project.create) {
      const rows = await engine.cypher(
        'MATCH (p:Project {id: $pid})-[:TAGGED]->(t:Tag {id: $tid}) RETURN p.id AS id LIMIT 1',
        { pid: plan.project.id, tid: projectTag.id }
      )
      projectAlreadyTagged = rows.length > 0
    }
  }

  const projectEmbedding = plan.project?.create
    ? embeddingOf(`${plan.project.name} — ${plan.project.summary ?? ''}`.trim())
    : null

  return {
    components,
    preferences,
    corrections,
    tags,
    projectTag,
    projectAlreadyTagged,
    projectEmbedding,
    warnings
  }
}
