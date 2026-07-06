/**
 * Gated write (§17 step 4): high-confidence extractions commit through the
 * single write lane with full provenance; low-confidence ones commit only
 * with an independent verifier's blessing; everything else lands in the
 * `staged_writes` human review queue (§13) — never the graph.
 *
 * The WHOLE graph mutation is ONE lane job (§21 rule 1) built from
 * idempotent operations (upserts + MERGE edges + INSERT OR IGNORE staging),
 * so a crash inside this step re-runs cleanly on resume and readers never see
 * a half-extracted session interleaved with other writers.
 *
 * Provenance (§21 rule 4): every node that carries provenance columns
 * (Component, Preference) and EVERY edge is stamped `extracted_by` +
 * `confidence` at write time; Component/Preference additionally get
 * `EXTRACTED_FROM → Session`. Labels whose §18 schema has no provenance
 * columns (Session, Project, MCP, Plugin, Correction, Tag) carry provenance
 * on their extraction-written edges instead — the same convention codebase
 * ingestion set in phase 07.
 */
import { createHash } from 'node:crypto'
import type BetterSqlite3 from 'better-sqlite3'
import type { EdgeProps, NodeLabel, NodeRef, StorageEngine, WriteTx } from '../../storage'
import type { AuditLog } from '../../security'
import {
  extractionProvenance,
  itemKeyOf,
  normalizeItemText,
  type CollectedState,
  type DeterministicPlan,
  type ExtractionPass,
  type ExtractionResult,
  type FuzzyExtractionState,
  type PlannedTag,
  type ResolveState,
  type VerificationResult,
  type VerifyState
} from './types'
import { WRITE_GATE_CONFIDENCE } from './verify'

const sha256Hex = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex')

// ── Per-item gate decision ───────────────────────────────────────────────────

type Disposition =
  | { readonly commit: true; readonly confidence: number; readonly pass: ExtractionPass }
  | { readonly commit: false; readonly reason: string }

function dispositionOf(
  itemKey: string,
  confidence: number,
  tierPass: ExtractionPass,
  verification: VerifyState
): Disposition {
  if (confidence >= WRITE_GATE_CONFIDENCE) return { commit: true, confidence, pass: tierPass }
  const verdict: VerificationResult | undefined = verification.results.find((r) => r.itemKey === itemKey)
  if (verdict !== undefined && verdict.verdict === 'confirm') {
    if (verdict.confidence !== null && verdict.confidence >= WRITE_GATE_CONFIDENCE) {
      // The independent verifier (a different model than the extractor)
      // agreed — commit at the verifier's confidence.
      return { commit: true, confidence: verdict.confidence, pass: 'llm-local+verified' }
    }
    return {
      commit: false,
      reason: `verifier confirmed but at confidence ${verdict.confidence ?? 'n/a'} — still below the ${WRITE_GATE_CONFIDENCE} gate`
    }
  }
  if (verdict !== undefined && verdict.verdict === 'reject') {
    return { commit: false, reason: `extractor/verifier disagreement — verifier rejected${verdict.note ? `: ${verdict.note}` : ''}` }
  }
  if (verdict !== undefined) {
    return {
      commit: false,
      reason: `confidence ${confidence.toFixed(2)} below the ${WRITE_GATE_CONFIDENCE} gate — ${verdict.note ?? 'verifier unavailable'}`
    }
  }
  return { commit: false, reason: `confidence ${confidence.toFixed(2)} below the ${WRITE_GATE_CONFIDENCE} gate` }
}

// ── Staged-write rows (the §13 review queue) ─────────────────────────────────

interface StagedEdge {
  readonly type: string
  readonly from: NodeRef
  readonly to: NodeRef
  readonly props: EdgeProps
}

interface StagedItem {
  readonly id: string
  readonly targetLabel: NodeLabel
  readonly targetId: string
  readonly payload: Record<string, unknown>
}

function stagedItem(
  sessionNodeId: string,
  itemKey: string,
  op: 'create' | 'merge',
  targetLabel: NodeLabel,
  targetId: string,
  nodeProps: Record<string, unknown> | null,
  edges: readonly StagedEdge[],
  tagCreates: readonly PlannedTag[],
  provenance: { extracted_by: string; confidence: number },
  evidence: string,
  reason: string
): StagedItem {
  return {
    // Deterministic id: a crash-resumed write step re-inserts with OR IGNORE
    // instead of duplicating review rows.
    id: `sw-${sha256Hex(`${sessionNodeId}\n${itemKey}`).slice(0, 16)}`,
    targetLabel,
    targetId,
    payload: {
      op,
      node: nodeProps === null ? null : { label: targetLabel, id: targetId, props: nodeProps },
      // New retrievable nodes are embedded at commit time by the review flow
      // (statements are in the payload); embeddings are not staged.
      embedOnCommit: targetLabel === 'Preference' && op === 'create',
      edges: edges.map((e) => ({ type: e.type, from: e.from, to: e.to, props: e.props })),
      tagCreates: tagCreates.map((t) => ({ id: t.id, name: t.name })),
      provenance,
      evidence,
      reason,
      session: sessionNodeId
    }
  }
}

// ── The gated write ──────────────────────────────────────────────────────────

export interface GatedWriteOptions {
  readonly engine: StorageEngine
  readonly db: BetterSqlite3.Database
  readonly collected: CollectedState
  readonly plan: DeterministicPlan
  readonly extraction: FuzzyExtractionState
  readonly resolution: ResolveState
  readonly verification: VerifyState
  /**
   * §13 audit (phase 09): when present, the session's ONE lane job records a
   * reversible delta — the per-action complement of §18's undo-by-source.
   */
  readonly audit?: AuditLog
}

export async function performGatedWrite(options: GatedWriteOptions): Promise<ExtractionResult> {
  const { engine, db, collected, plan, extraction, resolution, verification, audit } = options
  const sessionNodeId = collected.sessionNodeId
  const sessionRef: NodeRef = { label: 'Session', id: sessionNodeId }
  const deterministic: EdgeProps = { extracted_by: extractionProvenance('deterministic'), confidence: 1.0 }
  const tierPass: ExtractionPass =
    extraction.tier === 'cloud'
      ? 'llm-cloud'
      : extraction.tier === 'subscription'
        ? 'llm-subscription'
        : 'llm-local'

  interface CommittedNode {
    label: NodeLabel
    props: Record<string, unknown>
  }
  const nodes: CommittedNode[] = []
  const edges: StagedEdge[] = []
  const staged: StagedItem[] = []
  const tagById = new Map(resolution.tags.map((t) => [t.id, t]))
  if (resolution.projectTag !== null) tagById.set(resolution.projectTag.id, resolution.projectTag)
  const tagsToCreateNow = new Set<string>()

  // ── Deterministic plan (always committed, confidence 1.0) ──────────────────
  const sessionProps: Record<string, unknown> = { id: sessionNodeId, tier: 'daily' }
  if (plan.session.startedAt !== null) sessionProps['started_at'] = new Date(plan.session.startedAt)
  if (plan.session.endedAt !== null) sessionProps['ended_at'] = new Date(plan.session.endedAt)
  if (plan.session.transcriptRef !== null) sessionProps['transcript_ref'] = plan.session.transcriptRef
  nodes.push({ label: 'Session', props: sessionProps })

  const project = plan.project
  if (project !== null) {
    if (project.create) {
      if (resolution.projectEmbedding === null) {
        throw new Error('gated write: project marked for creation but no embedding was resolved')
      }
      nodes.push({
        label: 'Project',
        props: {
          id: project.id,
          name: project.name,
          summary: project.summary ?? '',
          embedding: [...resolution.projectEmbedding]
        }
      })
    }
    edges.push({ type: 'PRODUCED', from: sessionRef, to: { label: 'Project', id: project.id }, props: deterministic })
    if (resolution.projectTag !== null && (project.create || !resolution.projectAlreadyTagged)) {
      if (resolution.projectTag.create) tagsToCreateNow.add(resolution.projectTag.id)
      edges.push({
        type: 'TAGGED',
        from: { label: 'Project', id: project.id },
        to: { label: 'Tag', id: resolution.projectTag.id },
        props: deterministic
      })
    }
  }

  for (const [label, refs] of [
    ['Skill', plan.skills],
    ['MCP', plan.mcps],
    ['Plugin', plan.plugins]
  ] as const) {
    for (const ref of refs) {
      if (ref.create) nodes.push({ label, props: { id: ref.id, name: ref.name } })
      edges.push({ type: 'USED', from: sessionRef, to: { label, id: ref.id }, props: deterministic })
      if (project !== null) {
        edges.push({ type: 'USES', from: { label: 'Project', id: project.id }, to: { label, id: ref.id }, props: deterministic })
      }
    }
  }

  // ── Components ──────────────────────────────────────────────────────────────
  const committedComponentIdByName = new Map<string, string>()
  let componentsCreated = 0
  let componentsMerged = 0
  interface CommittedComponent {
    id: string
    dependsOn: readonly string[]
    props: EdgeProps
  }
  const committedComponents: CommittedComponent[] = []
  for (const component of resolution.components) {
    const itemKey = itemKeyOf('components', component.name)
    const disposition = dispositionOf(itemKey, component.confidence, tierPass, verification)
    const targetId = component.resolution.id
    if (!disposition.commit) {
      const provenance = { extracted_by: extractionProvenance(tierPass), confidence: component.confidence }
      const stagedEdges: StagedEdge[] = [
        { type: 'EXTRACTED_FROM', from: { label: 'Component', id: targetId }, to: sessionRef, props: provenance }
      ]
      if (component.resolution.kind === 'new' && project !== null) {
        stagedEdges.push({
          type: 'HAS_COMPONENT',
          from: { label: 'Project', id: project.id },
          to: { label: 'Component', id: targetId },
          props: provenance
        })
      }
      staged.push(
        stagedItem(
          sessionNodeId,
          itemKey,
          component.resolution.kind === 'new' ? 'create' : 'merge',
          'Component',
          targetId,
          component.resolution.kind === 'new'
            ? { name: component.name, type: component.type, ...provenance }
            : null,
          stagedEdges,
          [],
          provenance,
          component.evidence,
          disposition.reason
        )
      )
      continue
    }
    const props: EdgeProps = { extracted_by: extractionProvenance(disposition.pass), confidence: disposition.confidence }
    if (component.resolution.kind === 'new') {
      nodes.push({
        label: 'Component',
        props: { id: targetId, name: component.name, type: component.type, ...props }
      })
      if (project !== null) {
        edges.push({
          type: 'HAS_COMPONENT',
          from: { label: 'Project', id: project.id },
          to: { label: 'Component', id: targetId },
          props
        })
      }
      componentsCreated += 1
    } else {
      componentsMerged += 1
    }
    edges.push({ type: 'EXTRACTED_FROM', from: { label: 'Component', id: targetId }, to: sessionRef, props })
    committedComponents.push({ id: targetId, dependsOn: component.dependsOn, props })
    committedComponentIdByName.set(normalizeItemText(component.name), targetId)
  }
  // Component connections (§17 "Components and their connections") among this
  // session's committed components only.
  for (const component of committedComponents) {
    for (const dependencyName of component.dependsOn) {
      const targetId = committedComponentIdByName.get(normalizeItemText(dependencyName))
      if (targetId === undefined || targetId === component.id) continue
      edges.push({
        type: 'DEPENDS_ON',
        from: { label: 'Component', id: component.id },
        to: { label: 'Component', id: targetId },
        props: component.props
      })
    }
  }

  // ── Preferences ─────────────────────────────────────────────────────────────
  let preferencesCreated = 0
  let preferencesMerged = 0
  interface CommittedPreference {
    id: string
    derivedFrom: string | null
    props: EdgeProps
  }
  const committedPreferences: CommittedPreference[] = []
  for (const preference of resolution.preferences) {
    if (preference.resolution.kind === 'merge' && preference.resolution.via === 'intra-batch') {
      continue // folded into its same-session survivor — nothing to write
    }
    const itemKey = itemKeyOf('preferences', preference.statement)
    const disposition = dispositionOf(itemKey, preference.confidence, tierPass, verification)
    const targetId = preference.resolution.id
    const prefTags = preference.tags
      .map((name) => resolution.tags.find((t) => t.name.toLowerCase() === name.toLowerCase()))
      .filter((t): t is PlannedTag => t !== undefined)
    if (resolution.projectTag !== null && !prefTags.some((t) => t.id === resolution.projectTag!.id)) {
      prefTags.push(resolution.projectTag)
    }
    if (!disposition.commit) {
      const provenance = { extracted_by: extractionProvenance(tierPass), confidence: preference.confidence }
      const stagedEdges: StagedEdge[] = [
        { type: 'EXTRACTED_FROM', from: { label: 'Preference', id: targetId }, to: sessionRef, props: provenance }
      ]
      if (preference.resolution.kind === 'new') {
        for (const tag of prefTags) {
          stagedEdges.push({
            type: 'APPLIES_TO',
            from: { label: 'Preference', id: targetId },
            to: { label: 'Tag', id: tag.id },
            props: provenance
          })
        }
      }
      staged.push(
        stagedItem(
          sessionNodeId,
          itemKey,
          preference.resolution.kind === 'new' ? 'create' : 'merge',
          'Preference',
          targetId,
          preference.resolution.kind === 'new' ? { statement: preference.statement, ...provenance } : null,
          stagedEdges,
          prefTags.filter((t) => t.create),
          provenance,
          preference.evidence,
          disposition.reason
        )
      )
      continue
    }
    const props: EdgeProps = { extracted_by: extractionProvenance(disposition.pass), confidence: disposition.confidence }
    if (preference.resolution.kind === 'new') {
      if (preference.embedding === null) {
        throw new Error(`gated write: new preference '${preference.statement.slice(0, 40)}…' has no embedding`)
      }
      nodes.push({
        label: 'Preference',
        props: { id: targetId, statement: preference.statement, embedding: [...preference.embedding], ...props }
      })
      for (const tag of prefTags) {
        if (tag.create) tagsToCreateNow.add(tag.id)
        edges.push({
          type: 'APPLIES_TO',
          from: { label: 'Preference', id: targetId },
          to: { label: 'Tag', id: tag.id },
          props
        })
      }
      preferencesCreated += 1
    } else {
      // Merge = the existing node absorbs this observation: it gains the
      // session's EXTRACTED_FROM edge; its statement, tags and embedding stay
      // untouched (a wrong tag would silently re-scope an established
      // preference — recorded decision).
      preferencesMerged += 1
    }
    edges.push({ type: 'EXTRACTED_FROM', from: { label: 'Preference', id: targetId }, to: sessionRef, props })
    committedPreferences.push({ id: targetId, derivedFrom: preference.derivedFrom, props })
  }

  // ── Corrections (explicit only, v1) ─────────────────────────────────────────
  let correctionsCommitted = 0
  interface CommittedCorrection {
    id: string
    content: string
    evidence: string
  }
  const committedCorrections: CommittedCorrection[] = []
  for (const correction of resolution.corrections) {
    const itemKey = itemKeyOf('corrections', correction.content)
    const disposition = dispositionOf(itemKey, correction.confidence, tierPass, verification)
    const provenance = {
      extracted_by: extractionProvenance(disposition.commit ? disposition.pass : tierPass),
      confidence: disposition.commit ? disposition.confidence : correction.confidence
    }
    const observedIn: StagedEdge = {
      type: 'OBSERVED_IN',
      from: { label: 'Correction', id: correction.id },
      to: sessionRef,
      props: provenance
    }
    const improved: StagedEdge | null =
      correction.skillId === null
        ? null
        : {
            type: 'IMPROVED',
            from: { label: 'Correction', id: correction.id },
            to: { label: 'Skill', id: correction.skillId },
            props: provenance
          }
    if (!disposition.commit) {
      staged.push(
        stagedItem(
          sessionNodeId,
          itemKey,
          'create',
          'Correction',
          correction.id,
          // The Correction label carries no provenance columns (§18) — the
          // stamps live on its edges.
          { content: correction.content },
          improved === null ? [observedIn] : [observedIn, improved],
          [],
          provenance,
          correction.evidence,
          disposition.reason
        )
      )
      continue
    }
    nodes.push({ label: 'Correction', props: { id: correction.id, content: correction.content } })
    edges.push(observedIn)
    if (improved !== null) edges.push(improved)
    committedCorrections.push({ id: correction.id, content: correction.content, evidence: correction.evidence })
    correctionsCommitted += 1
  }

  // Preference ← Correction lineage (§18 DERIVED_FROM), when both committed
  // and the model quoted the correction the preference restates.
  for (const preference of committedPreferences) {
    if (preference.derivedFrom === null) continue
    const quote = normalizeItemText(preference.derivedFrom)
    const match = committedCorrections.find((c) => {
      const content = normalizeItemText(c.content)
      const evidence = normalizeItemText(c.evidence)
      return (
        content.includes(quote) ||
        quote.includes(content) ||
        (evidence !== '' && (evidence.includes(quote) || quote.includes(evidence)))
      )
    })
    if (match === undefined) continue
    edges.push({
      type: 'DERIVED_FROM',
      from: { label: 'Preference', id: preference.id },
      to: { label: 'Correction', id: match.id },
      props: preference.props
    })
  }

  // ── ONE lane job: nodes first, then every edge (§21 rule 1). Audited with
  // a reversible delta when the §13 audit log is wired (phase 09) ────────────
  const tagNodes = [...tagsToCreateNow]
    .map((id) => tagById.get(id))
    .filter((t): t is PlannedTag => t !== undefined)
  const laneJob = async (tx: WriteTx): Promise<void> => {
    for (const node of nodes) {
      await tx.upsertNode(node.label, node.props)
    }
    for (const tag of tagNodes) {
      await tx.upsertNode('Tag', { id: tag.id, name: tag.name, is_global: false })
    }
    for (const edge of edges) {
      await tx.createEdge(edge.type as Parameters<typeof tx.createEdge>[0], edge.from, edge.to, edge.props)
    }
  }
  if (audit !== undefined) {
    await audit.graphWrite(`extraction-agent:${sessionNodeId}`, `extraction of session ${sessionNodeId}`, laneJob)
  } else {
    await engine.withWrite(laneJob)
  }

  // ── Review-queue staging (SQLite, not the graph — §13) ─────────────────────
  const insertStaged = db.prepare(
    `INSERT OR IGNORE INTO staged_writes (id, proposed_by, kind, target_label, target_id, payload_json)
     VALUES (?, ?, 'extraction', ?, ?, ?)`
  )
  for (const item of staged) {
    insertStaged.run(item.id, `extraction-agent:${sessionNodeId}`, item.targetLabel, item.targetId, JSON.stringify(item.payload))
  }

  const warnings = [
    ...collected.warnings,
    ...plan.notes,
    ...extraction.warnings,
    ...resolution.warnings,
    ...verification.warnings
  ]

  return {
    sessionNodeId,
    tier: extraction.tier,
    escalated: extraction.escalated,
    committed: {
      project: project === null ? null : project.create ? 'created' : 'matched',
      usedSkills: plan.skills.length,
      usedMcps: plan.mcps.length,
      usedPlugins: plan.plugins.length,
      components: componentsCreated,
      mergedComponents: componentsMerged,
      preferences: preferencesCreated,
      mergedPreferences: preferencesMerged,
      corrections: correctionsCommitted
    },
    staged: { count: staged.length, ids: staged.map((s) => s.id) },
    warnings
  }
}
