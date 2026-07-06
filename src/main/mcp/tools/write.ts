/**
 * Write tools (§12) — propose_correction.
 *
 * Write policy: propose_correction stages a `staged_writes` row (§21 rule 6 —
 * staged → validated → commit is Claude's ONLY path for correcting memory). It
 * never writes the graph directly; the §13 review flow validates + commits later.
 */
import { randomUUID } from 'node:crypto'
import * as z from 'zod'
import { NODE_LABELS } from '../../storage'
import { stableStringify } from '../callLog'
import { ToolError, parse, jsonSchema, type McpToolDef, type ToolContext } from './shared'

/** Node properties a correction may never patch (identity + provenance). */
const PROTECTED_PATCH_KEYS = ['id', 'created_at', 'updated_at', 'embedding', 'extracted_by', 'confidence'] as const

const ProposeCorrectionInput = z.object({
  node_id: z.string().min(1).describe('Id of the existing node to correct.'),
  patch: z
    .record(z.string(), z.unknown())
    .describe('Property → corrected value. Identity/provenance fields cannot be patched.'),
  reason: z.string().min(1).describe('Why this correction is certainly right.')
})

async function proposeCorrection(args: unknown, ctx: ToolContext): Promise<unknown> {
  const input = parse(ProposeCorrectionInput, args, 'propose_correction')
  const patchKeys = Object.keys(input.patch)
  if (patchKeys.length === 0) {
    throw new ToolError('INVALID_INPUT', 'propose_correction: patch must set at least one property')
  }
  const protectedKeys = patchKeys.filter((k) => (PROTECTED_PATCH_KEYS as readonly string[]).includes(k))
  if (protectedKeys.length > 0) {
    throw new ToolError(
      'INVALID_INPUT',
      `propose_correction: patch may not touch identity/provenance fields (${protectedKeys.join(', ')})`
    )
  }

  // Claude's writes target existing nodes only (§18): resolve the id across
  // all labels with direct reads before staging anything.
  const matches = (
    await Promise.all(
      NODE_LABELS.map(async (label) => {
        const rows = await ctx.engine.cypher(`MATCH (n:${label} {id: $id}) RETURN n.id AS id LIMIT 1`, {
          id: input.node_id
        })
        return rows.length > 0 ? label : null
      })
    )
  ).filter((label): label is (typeof NODE_LABELS)[number] => label !== null)
  if (matches.length === 0) {
    throw new ToolError('NOT_FOUND', `node '${input.node_id}' does not exist — corrections target existing nodes only`)
  }
  if (matches.length > 1) {
    throw new ToolError(
      'INVALID_INPUT',
      `node id '${input.node_id}' is ambiguous across labels ${matches.join(', ')} — cannot stage a correction`
    )
  }
  const targetLabel = matches[0] as string

  const id = randomUUID()
  // The ONLY write this tool performs, and it is to SQLite staging — never the
  // graph (§21 rule 6). The §13 review flow validates + commits later.
  ctx.db
    .prepare(
      `INSERT INTO staged_writes (id, proposed_by, kind, target_label, target_id, payload_json)
       VALUES (?, ?, 'propose_correction', ?, ?, ?)`
    )
    .run(
      id,
      `claude-mcp:${ctx.sessionId}`,
      targetLabel,
      input.node_id,
      stableStringify({ patch: input.patch, reason: input.reason })
    )
  return {
    staged: true,
    stagedWriteId: id,
    targetLabel,
    targetId: input.node_id,
    status: 'staged',
    note: 'Correction staged for validation and user review — nothing is committed to the graph until approved.'
  }
}

export const WRITE_TOOL_DEFS: readonly McpToolDef[] = [
  {
    name: 'propose_correction',
    description:
      'Propose a correction to an EXISTING node when something is certainly wrong. The correction is staged for validation and user review — it is never written to the graph directly.',
    inputSchema: jsonSchema(ProposeCorrectionInput),
    handle: proposeCorrection
  }
]
