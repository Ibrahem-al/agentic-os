/**
 * RuleStore (§7/§17, phase 31) — the dashboard's authoring surface over the
 * user-rule files in ~/.agentic-os/rules/*.rule.json. Mirrors the
 * WatchedFolderStore pattern, with three discipline points:
 *
 *  1. NEVER WRITE INVALID — every create/update/enable is validated through
 *     the single `analyzeRule` validator BEFORE any byte hits disk. A code
 *     rule whose entry file is missing but sits inside the rules dir is
 *     scaffolded a starter first (so the written rule is immediately valid).
 *  2. AUDITED + REVERSIBLE — all writes/deletes go through `audit.fileWrite`
 *     / `audit.fileDelete` (pre-image → backups/audit/<id>/), so each mutation
 *     is a History row the user can undo (§21 rule 11).
 *  3. RAW PRESERVATION — mutations edit the RAW on-disk JSON, never a
 *     round-tripped LoadedRule (which holds machine-absolute paths and drops
 *     hand-authored extras). `~/`-style paths and unknown top-level keys
 *     survive an edit.
 *
 * Authoring is DASHBOARD-ONLY (never MCP, §21 rule 6): a rule is executable
 * intent plus a capability self-declaration, so it may never come from Claude.
 * Applying a change without restart is the caller's `onMutation` hook (wired
 * to RuleRuntime.reload), awaited after every successful persist.
 */
import { existsSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { isPathWithin } from '../security'
import type { RuleReloadResult } from './reload'
import {
  RULE_FILE_SUFFIX,
  analyzeRule,
  loadRules,
  type LoadedRule,
  type RuleAnalysis,
  type RuleLoadError
} from './rules'

const RULE_ID_RE = /^[a-zA-Z0-9][a-zA-Z0-9-_]{0,63}$/
const KNOWN_TOP_KEYS = new Set(['id', 'trigger', 'condition', 'action', 'enabled', 'modelTier', 'capabilities'])

export class RuleStoreError extends Error {
  constructor(
    readonly code: 'INVALID_INPUT' | 'NOT_FOUND' | 'INVALID_STATE',
    message: string
  ) {
    super(message)
    this.name = 'RuleStoreError'
  }
}

/** The minimal audit surface the store needs (structural — no class import). */
export interface RuleStoreAudit {
  fileWrite(agentId: string, filePath: string, content: string | Buffer): { actionId: string }
  fileDelete(agentId: string, filePath: string): { actionId: string }
}

export interface RuleStoreEntry {
  readonly rule: LoadedRule
  /** The verbatim on-disk JSON (seeds the edit form). */
  readonly raw: unknown
}

export interface RuleStoreDeps {
  readonly rulesDir: string
  readonly audit: RuleStoreAudit
  /** Audit actor (§13) — 'user:dashboard'. */
  readonly actor: string
  /** Live watched-folder names (folder-scan preset strict check). */
  readonly watchedFolderNames: () => readonly string[]
  /** Whether Docker is available (a docker-lane language warns when false). */
  readonly dockerAvailable: () => boolean
  /** Awaited after EVERY successful persist — wired to RuleRuntime.reload().
   *  Its diff is surfaced to the caller so the UI can report what changed. */
  readonly onMutation: () => Promise<RuleReloadResult>
}

export interface RuleMutationOutcome {
  readonly rule: LoadedRule
  readonly auditActionId: string
  readonly reload: RuleReloadResult
}

export class RuleStore {
  private readonly deps: RuleStoreDeps

  constructor(deps: RuleStoreDeps) {
    this.deps = deps
  }

  /** Every rule (valid, incl. disabled) plus the files that failed to load. */
  list(): { entries: RuleStoreEntry[]; errors: RuleLoadError[] } {
    const loaded = loadRules(this.deps.rulesDir)
    const entries = loaded.rules.map((rule) => ({ rule, raw: this.readRaw(rule.file) }))
    return { entries, errors: [...loaded.errors] }
  }

  get(id: string): RuleStoreEntry | null {
    return this.list().entries.find((e) => e.rule.id === id) ?? null
  }

  /** Dry-run validation of a draft (no writes) — powers the form's live check. */
  validateDraft(draft: unknown, opts: { excludeId?: string } = {}): RuleAnalysis {
    const draftId = this.extractId(draft)
    const file = draftId !== null && RULE_ID_RE.test(draftId) ? this.canonicalPath(draftId) : join(this.deps.rulesDir, `draft${RULE_FILE_SUFFIX}`)
    return analyzeRule(draft, file, this.deps.rulesDir, {
      entryMode: 'scaffold-ok',
      existingIds: this.knownIdsExcept(opts.excludeId),
      watchedFolderNames: new Set(this.deps.watchedFolderNames()),
      dockerAvailable: this.deps.dockerAvailable()
    })
  }

  async create(draft: unknown): Promise<RuleMutationOutcome> {
    const analysis = this.validateDraft(draft, {})
    const rule = this.requireValid(analysis)
    const target = this.canonicalPath(rule.id)
    // A file already at the canonical name (even an unparseable one with no
    // extractable id) must never be clobbered.
    if (existsSync(target)) {
      throw new RuleStoreError('INVALID_STATE', `a rule file already exists at ${target} — fix or delete it first`)
    }
    return this.persist(draft, rule, target, analysis.willScaffoldEntry)
  }

  async update(id: string, draft: unknown): Promise<RuleMutationOutcome> {
    const draftId = this.extractId(draft)
    if (draftId !== id) {
      throw new RuleStoreError('INVALID_INPUT', 'a rule id is permanent — delete and recreate to rename it')
    }
    const existing = this.get(id)
    if (existing === null) throw new RuleStoreError('NOT_FOUND', `no rule with id '${id}'`)
    const nextRaw = this.mergeRaw(existing.raw, draft)
    const analysis = analyzeRule(nextRaw, existing.rule.file, this.deps.rulesDir, {
      entryMode: 'scaffold-ok',
      existingIds: this.knownIdsExcept(id),
      watchedFolderNames: new Set(this.deps.watchedFolderNames()),
      dockerAvailable: this.deps.dockerAvailable()
    })
    const rule = this.requireValid(analysis)
    return this.persist(nextRaw, rule, existing.rule.file, analysis.willScaffoldEntry)
  }

  async setEnabled(id: string, enabled: boolean): Promise<RuleMutationOutcome> {
    const existing = this.get(id)
    if (existing === null) throw new RuleStoreError('NOT_FOUND', `no rule with id '${id}'`)
    const nextRaw = this.asObject(existing.raw)
    // Absent ⇒ enabled, so the enabled state clears the key rather than store true.
    if (enabled) delete nextRaw['enabled']
    else nextRaw['enabled'] = false
    const analysis = analyzeRule(nextRaw, existing.rule.file, this.deps.rulesDir, {
      entryMode: 'must-exist',
      existingIds: this.knownIdsExcept(id),
      watchedFolderNames: new Set(this.deps.watchedFolderNames()),
      dockerAvailable: this.deps.dockerAvailable()
    })
    const rule = this.requireValid(analysis)
    return this.persist(nextRaw, rule, existing.rule.file, analysis.willScaffoldEntry)
  }

  /** Delete the rule DEFINITION (never the code entry file it points at). */
  async delete(id: string): Promise<{ entryFile: string | null; auditActionId: string; reload: RuleReloadResult }> {
    const existing = this.get(id)
    if (existing === null) throw new RuleStoreError('NOT_FOUND', `no rule with id '${id}'`)
    const { actionId } = this.deps.audit.fileDelete(this.deps.actor, existing.rule.file)
    const reload = await this.deps.onMutation()
    const entryFile = existing.rule.action.kind === 'code' ? existing.rule.action.entry : null
    return { entryFile, auditActionId: actionId, reload }
  }

  /** Remove a *.rule.json that failed to load (only inside the rules dir). */
  async deleteInvalidFile(file: string): Promise<{ auditActionId: string; reload: RuleReloadResult }> {
    if (!isPathWithin(file, this.deps.rulesDir) || !file.toLowerCase().endsWith(RULE_FILE_SUFFIX)) {
      throw new RuleStoreError('INVALID_INPUT', `not a rule file inside the rules folder: ${file}`)
    }
    if (!existsSync(file)) throw new RuleStoreError('NOT_FOUND', `no file at ${file}`)
    const { actionId } = this.deps.audit.fileDelete(this.deps.actor, file)
    const reload = await this.deps.onMutation()
    return { auditActionId: actionId, reload }
  }

  // ── internals ──────────────────────────────────────────────────────────────

  private async persist(
    rawToWrite: unknown,
    rule: LoadedRule,
    target: string,
    willScaffoldEntry: boolean
  ): Promise<RuleMutationOutcome> {
    // Scaffold a starter entry first (only when genuinely missing — never
    // overwrite existing user code) so the persisted rule validates as-is.
    let scaffolded: string | null = null
    if (willScaffoldEntry && rule.action.kind === 'code' && !existsSync(rule.action.entry)) {
      this.deps.audit.fileWrite(this.deps.actor, rule.action.entry, scaffoldEntry(rule.action.lang, rule.action.lane))
      scaffolded = rule.action.entry
    }
    const content = `${JSON.stringify(rawToWrite, null, 2)}\n`
    try {
      const { actionId } = this.deps.audit.fileWrite(this.deps.actor, target, content)
      const reload = await this.deps.onMutation()
      return { rule, auditActionId: actionId, reload }
    } catch (err) {
      // The rule file failed to persist — remove the orphan starter we just
      // scaffolded (best-effort) so a failed create leaves nothing behind.
      if (scaffolded !== null) {
        try {
          rmSync(scaffolded, { force: true })
        } catch {
          /* best-effort */
        }
      }
      throw err
    }
  }

  private canonicalPath(id: string): string {
    return join(this.deps.rulesDir, `${id}${RULE_FILE_SUFFIX}`)
  }

  private requireValid(analysis: RuleAnalysis): LoadedRule {
    if (analysis.rule !== null) return analysis.rule
    const firstError = analysis.issues.find((i) => i.severity === 'error')
    throw new RuleStoreError('INVALID_INPUT', firstError?.message ?? 'invalid rule')
  }

  private readRaw(file: string): unknown {
    try {
      return JSON.parse(readFileSync(file, 'utf8'))
    } catch {
      return {}
    }
  }

  private asObject(value: unknown): Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
      ? { ...(value as Record<string, unknown>) }
      : {}
  }

  private extractId(draft: unknown): string | null {
    const obj = this.asObject(draft)
    return typeof obj['id'] === 'string' ? obj['id'] : null
  }

  /**
   * Merge a draft onto the current raw: unknown top-level keys are carried
   * through verbatim (never destroy hand-authored extras); known keys are
   * taken from the draft, with the optional ones cleared when the draft omits
   * them (and `enabled` cleared when it is the default true).
   */
  private mergeRaw(currentRaw: unknown, draft: unknown): Record<string, unknown> {
    const out: Record<string, unknown> = {}
    const current = this.asObject(currentRaw)
    for (const [key, value] of Object.entries(current)) {
      if (!KNOWN_TOP_KEYS.has(key)) out[key] = value
    }
    const d = this.asObject(draft)
    out['id'] = d['id']
    out['trigger'] = d['trigger']
    out['action'] = d['action']
    // condition/capabilities are editor-driven (omitted ⇒ intentionally cleared).
    for (const optional of ['condition', 'capabilities'] as const) {
      if (d[optional] !== undefined) out[optional] = d[optional]
    }
    // modelTier has NO editor control — an omitting draft must not silently
    // reset a hand-authored 'cloud' rule to 'local'; carry the on-disk value.
    if (d['modelTier'] !== undefined) out['modelTier'] = d['modelTier']
    else if (current['modelTier'] !== undefined) out['modelTier'] = current['modelTier']
    if (d['enabled'] === false) out['enabled'] = false
    return out
  }

  /** Every id already claimed on disk (loaded rules + best-effort from broken
   *  files' raw JSON), minus the id being edited. */
  private knownIdsExcept(excludeId?: string): Set<string> {
    const ids = new Set<string>()
    const loaded = loadRules(this.deps.rulesDir)
    for (const rule of loaded.rules) ids.add(rule.id)
    for (const err of loaded.errors) {
      const rawId = this.extractId(this.readRaw(err.file))
      if (rawId !== null) ids.add(rawId)
    }
    if (excludeId !== undefined) ids.delete(excludeId)
    return ids
  }
}

/** A minimal, contract-correct starter for a scaffolded code entry (one JSON
 *  doc in on stdin → one JSON doc out on stdout), matched to the LANGUAGE (not
 *  just the lane — the docker lane covers both Python and shell). */
function scaffoldEntry(lang: string, lane: 'deno' | 'docker'): string {
  if (lane === 'deno') {
    return [
      '// Agentic OS rule action (Deno sandbox).',
      '// Reads the trigger event as one JSON document on stdin and writes one',
      '// JSON document to stdout. Runs under the capabilities your rule declares.',
      'const input = JSON.parse(await new Response(Deno.stdin.readable).text())',
      '// input.trigger — the event that fired this rule (schedule / file / url).',
      'console.log(JSON.stringify({ ok: true, saw: input.trigger?.kind ?? null }))',
      ''
    ].join('\n')
  }
  if (lang === 'py' || lang === 'python') {
    return [
      '# Agentic OS rule action (Docker sandbox).',
      '# Reads the trigger event as one JSON document on stdin and writes one',
      '# JSON document to stdout. Runs under the capabilities your rule declares.',
      'import sys, json',
      'data = json.load(sys.stdin)',
      "# data['trigger'] — the event that fired this rule (schedule / file / url).",
      "print(json.dumps({ 'ok': True, 'saw': (data.get('trigger') or {}).get('kind') }))",
      ''
    ].join('\n')
  }
  // Shell (and any other docker-lane language): read the event, emit one JSON doc.
  return [
    '#!/bin/sh',
    '# Agentic OS rule action (Docker sandbox).',
    '# The trigger event arrives as one JSON document on stdin; emit one on stdout.',
    'cat > /dev/null',
    "echo '{\"ok\":true}'",
    ''
  ].join('\n')
}
