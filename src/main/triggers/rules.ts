/**
 * User-coded rules (§17 agent #5, §7 "user-coded rules") — declarative
 * `{ trigger, condition, action }` JSON files in ~/.agentic-os/rules/
 * (*.rule.json), zod-validated against the §17 shape, and EXACTLY what §13
 * enforces against: each valid ENABLED rule registers the agent id
 * `rule:<id>` with its declared capabilities and NO standing grants (the
 * phase-09 decision — a user rule's side-effecting actions queue for the
 * dashboard; §13 "prompt before writes, network calls, spend").
 *
 * Two action kinds (the phase-31 authoring feature; both were always §7's
 * intent — "the action calls a skill OR runs the user's own code"):
 *   - `code`   — the user's own entry file, run ONLY in the Deno/Docker
 *                sandbox lane under hand-declared capabilities (§21 rule 3).
 *   - `preset` — a no-code shortcut that enqueues one of a small whitelist of
 *                EXISTING safe system task kinds (export/prune/skill/scan). It
 *                runs no user code and needs no hand-written capabilities;
 *                the minimal detection caps are AUTO-DERIVED from the trigger.
 * A top-level optional `enabled` (default true) lets a rule be paused without
 * deletion; a disabled rule still fully validates and lists but is not armed.
 *
 * Load-time validation is fail-fast and per-file: an invalid file is reported
 * (dashboard + boot log) and skipped; it can never half-run. Scope coherence
 * is checked here too — a rule may only WATCH what it declared it can touch
 * (watch path within fsRead, watch url host within netDomains), so detection
 * itself stays inside the §13 capability envelope.
 *
 * Condition DSL (v1): the spec's example grammar, literally —
 * `<dotted.path> contains '<literal>'` evaluated against the trigger event
 * object. Anything else is a load-time validation error (fail-fast beats
 * silently-always-true). Recorded phase-11 decision.
 *
 * `analyzeRule` is the SINGLE validator: it collects field-addressed issues
 * (for the authoring dry-run) and, when clean, the normalized LoadedRule.
 * `parseRuleFile` delegates to it and throws the first error verbatim, so
 * every pre-existing loader message and test stays byte-stable.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
import { Cron } from 'croner'
import * as z from 'zod'
import { TASK_PRIORITY } from '../config'
import type { CapabilityDeclaration } from '../kernel'
import {
  CapabilityError,
  EMPTY_CAPABILITIES,
  isDomainAllowed,
  isPathWithin,
  parseCapabilities,
  pathsAllowed
} from '../security'
import type { PermissionEngine } from '../security'

export const RULE_FILE_SUFFIX = '.rule.json'

/** The agent id a rule's every kernel action is attributed to (§13). */
export function ruleAgentId(ruleId: string): string {
  return `rule:${ruleId}`
}

// ── No-code preset whitelist ────────────────────────────────────────────────
//
// A preset fires an EXISTING system task kind whose handler already runs
// under its own kernel gates (system-attributed). The whitelist is
// deliberately tiny and side-effect-safe: no kind whose payload references a
// session/file/other-rule (extraction, ingest-file, rule-action, workflow) is
// exposed, so a preset can never synthesize arbitrary work.

export const RULE_PRESETS = {
  'memory-export': { taskKind: 'export', priority: TASK_PRIORITY.maintenance, needsFolder: false },
  'graph-prune': { taskKind: 'prune', priority: TASK_PRIORITY.maintenance, needsFolder: false },
  'skill-improvement': { taskKind: 'skill-improvement', priority: TASK_PRIORITY.skillImprove, needsFolder: false },
  'folder-scan': { taskKind: 'watch-scan', priority: TASK_PRIORITY.watchScan, needsFolder: true }
} as const

export type RulePresetName = keyof typeof RULE_PRESETS

const PRESET_NAMES = ['memory-export', 'graph-prune', 'skill-improvement', 'folder-scan'] as const

// ── §17 shape ─────────────────────────────────────────────────────────────────

const WatchTriggerSchema = z.object({
  type: z.literal('watch'),
  /** Poll an HTTP(S) resource (fetch + hash detection). */
  url: z.string().min(1).optional(),
  /** Watch a local file/folder (chokidar detection). */
  path: z.string().min(1).optional(),
  /** Poll cadence for url watches (§17 example: 30). */
  intervalMin: z.number().positive().optional()
})

const ScheduleTriggerSchema = z.object({
  type: z.literal('schedule'),
  /** Cron expression, local time (same grammar as the §20 schedules). */
  cron: z.string().min(1)
})

const CodeActionSchema = z.object({
  /** v1 code actions run ONLY in a sandbox lane (§7). */
  kind: z.literal('code'),
  lang: z.string().min(1),
  /** Entry file, resolved against the rule file's own directory. */
  entry: z.string().min(1)
})

const PresetActionSchema = z.object({
  /** No-code: enqueue a whitelisted existing system task kind. */
  kind: z.literal('preset'),
  preset: z.enum(PRESET_NAMES),
  /** folder-scan only: a WatchedFolderStore entry NAME (never a path). */
  folder: z.string().min(1).optional()
})

const RuleFileSchema = z.object({
  id: z
    .string()
    .regex(/^[a-zA-Z0-9][a-zA-Z0-9-_]{0,63}$/, 'id must be alphanumeric with -/_ (max 64 chars)'),
  trigger: z.discriminatedUnion('type', [WatchTriggerSchema, ScheduleTriggerSchema]),
  condition: z.string().min(1).optional(),
  action: z.discriminatedUnion('kind', [CodeActionSchema, PresetActionSchema]),
  /** Absent = enabled (backward compatible with every pre-31 rule file). */
  enabled: z.boolean().optional(),
  modelTier: z.enum(['local', 'cloud']).optional(),
  capabilities: z.unknown().optional()
})

/** The on-disk JSON shape (input side of the schema) — seeds the edit form. */
export type RuleFileJson = z.input<typeof RuleFileSchema>

export type RuleTrigger =
  | { readonly type: 'watch'; readonly url: string; readonly intervalMin: number }
  | { readonly type: 'watch'; readonly path: string }
  | { readonly type: 'schedule'; readonly cron: string }

export type RuleAction =
  | { readonly kind: 'code'; readonly lang: string; readonly entry: string; readonly lane: 'deno' | 'docker' }
  | { readonly kind: 'preset'; readonly preset: RulePresetName; readonly taskKind: string; readonly folder: string | null }

export interface LoadedRule {
  readonly id: string
  /** Absolute path of the .rule.json file. */
  readonly file: string
  readonly trigger: RuleTrigger
  readonly condition: RuleCondition | null
  readonly action: RuleAction
  /** Absent-in-file ⇒ true. A disabled rule loads/lists but is never armed. */
  readonly enabled: boolean
  readonly modelTier: 'local' | 'cloud'
  /** Hand-written (code) or auto-derived from the trigger (preset). */
  readonly capabilities: CapabilityDeclaration
}

export interface RuleLoadError {
  readonly file: string
  readonly error: string
}

export interface RuleLoadResult {
  readonly rules: readonly LoadedRule[]
  readonly errors: readonly RuleLoadError[]
}

// ── Field-addressed analysis (the single validator) ──────────────────────────

export interface RuleIssue {
  /** Dotted field path (e.g. 'trigger.cron', 'action.entry') the issue is about. */
  readonly field: string
  readonly severity: 'error' | 'warning'
  readonly message: string
}

export interface RuleAnalysisCtx {
  /** 'must-exist': the code entry must already exist (loader). 'scaffold-ok': a
   *  missing entry INSIDE the rules dir is fine — it will be scaffolded. */
  readonly entryMode: 'must-exist' | 'scaffold-ok'
  /** Ids that already exist (authoring dup-id check; excludes the edited id). */
  readonly existingIds?: ReadonlySet<string>
  /** Known watched-folder names (folder-scan strict check at author time). */
  readonly watchedFolderNames?: ReadonlySet<string>
  /** false ⇒ a docker-lane language warns (save still allowed, matches boot). */
  readonly dockerAvailable?: boolean
}

export interface RuleAnalysis {
  readonly issues: readonly RuleIssue[]
  /** Non-null only when there are no error-severity issues. */
  readonly rule: LoadedRule | null
  /** A code entry that is missing but inside the rules dir (scaffold-ok mode). */
  readonly willScaffoldEntry: boolean
}

// ── Condition DSL ─────────────────────────────────────────────────────────────

export interface RuleCondition {
  readonly source: string
  readonly path: readonly string[]
  readonly needle: string
}

const CONDITION_RE = /^\s*([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)\s+contains\s+'([^']*)'\s*$/

/** Parse the v1 condition grammar; throws a descriptive Error on anything else. */
export function parseRuleCondition(source: string): RuleCondition {
  const match = CONDITION_RE.exec(source)
  if (match === null) {
    throw new Error(
      `unsupported condition '${source}' — v1 supports exactly: <dotted.path> contains '<literal>' (spec §17)`
    )
  }
  const [, path, needle] = match
  return { source, path: (path ?? '').split('.'), needle: needle ?? '' }
}

/** Evaluate a parsed condition against a trigger event. Missing path ⇒ false. */
export function evaluateRuleCondition(condition: RuleCondition, event: Record<string, unknown>): boolean {
  let value: unknown = event
  for (const key of condition.path) {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
    value = (value as Record<string, unknown>)[key]
  }
  if (value === undefined || value === null) return false
  const text =
    typeof value === 'string'
      ? value
      : typeof value === 'number' || typeof value === 'boolean'
        ? String(value)
        : JSON.stringify(value)
  return text.includes(condition.needle)
}

// ── Loading + validation ──────────────────────────────────────────────────────

const expandHome = (p: string): string =>
  p === '~' || p.startsWith('~/') || p.startsWith('~\\') ? join(homedir(), p.slice(1)) : p

/**
 * Minimal detection capabilities for a preset (no hand-written caps): a path
 * watch may read its target, a url watch may reach its host, a schedule needs
 * nothing. Malformed url/path ⇒ empty caps; `analyzeTrigger` then emits the
 * precise error. `validateTrigger`'s containment check passes by construction.
 */
export function derivePresetCapabilities(rawTrigger: unknown): CapabilityDeclaration {
  const t =
    typeof rawTrigger === 'object' && rawTrigger !== null
      ? (rawTrigger as { type?: unknown; path?: unknown; url?: unknown })
      : null
  try {
    if (t !== null && t.type === 'watch' && typeof t.path === 'string') {
      return { ...EMPTY_CAPABILITIES, fsRead: [resolve(expandHome(t.path))] }
    }
    if (t !== null && t.type === 'watch' && typeof t.url === 'string') {
      return { ...EMPTY_CAPABILITIES, netDomains: [new URL(t.url).host.toLowerCase()] }
    }
  } catch {
    // Fall through to empty; the trigger check produces the precise error.
  }
  return { ...EMPTY_CAPABILITIES }
}

type PushIssue = (field: string, message: string, severity?: 'error' | 'warning') => void

/** Validate a trigger against the (declared or derived) capabilities. */
function analyzeTrigger(
  raw: z.output<typeof RuleFileSchema>['trigger'],
  capabilities: CapabilityDeclaration,
  push: PushIssue
): RuleTrigger | null {
  if (raw.type === 'schedule') {
    try {
      const probe = new Cron(raw.cron, { paused: true }, () => undefined)
      probe.stop()
    } catch (err) {
      push('trigger.cron', `trigger.cron '${raw.cron}' is not a valid cron expression: ${String(err)}`)
      return null
    }
    return { type: 'schedule', cron: raw.cron }
  }
  const hasUrl = raw.url !== undefined
  const hasPath = raw.path !== undefined
  if (hasUrl === hasPath) {
    push('trigger', "a watch trigger needs exactly one of 'url' or 'path'")
    return null
  }
  if (hasUrl) {
    let parsed: URL
    try {
      parsed = new URL(raw.url ?? '')
    } catch {
      push('trigger.url', `trigger.url '${raw.url}' is not a valid URL`)
      return null
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      push('trigger.url', `trigger.url must be http(s), got '${parsed.protocol}'`)
      return null
    }
    if (!isDomainAllowed(parsed.host, capabilities.netDomains)) {
      push(
        'trigger.url',
        `trigger.url host '${parsed.host}' is not in the rule's capabilities.netDomains — a rule may only watch what it declared (§13)`
      )
      return null
    }
    if (raw.intervalMin === undefined) {
      push('trigger.intervalMin', 'a url watch needs intervalMin (poll cadence, minutes)')
      return null
    }
    return { type: 'watch', url: parsed.toString(), intervalMin: raw.intervalMin }
  }
  const watchPath = resolve(expandHome(raw.path ?? ''))
  if (!isAbsolute(watchPath)) {
    push('trigger.path', `trigger.path must be absolute, got '${raw.path}'`)
    return null
  }
  if (!pathsAllowed([watchPath], capabilities.fsRead)) {
    push(
      'trigger.path',
      `trigger.path '${watchPath}' is not within the rule's capabilities.fsRead — a rule may only watch what it declared (§13)`
    )
    return null
  }
  return { type: 'watch', path: watchPath }
}

/**
 * The single validator. Parses + checks one rule VALUE (already JSON-decoded),
 * collecting every field-addressed issue; returns the normalized LoadedRule
 * only when nothing is error-severity. `ruleDir` is the rules directory the
 * entry resolves against (and which no rule may write into).
 */
export function analyzeRule(json: unknown, file: string, ruleDir: string, ctx: RuleAnalysisCtx): RuleAnalysis {
  const issues: RuleIssue[] = []
  const push: PushIssue = (field, message, severity = 'error') => issues.push({ field, severity, message })
  const done = (): RuleAnalysis => ({ issues, rule: null, willScaffoldEntry: false })

  // A friendly discriminator message beats zod's opaque union error.
  const obj = typeof json === 'object' && json !== null && !Array.isArray(json) ? (json as Record<string, unknown>) : null
  const rawAction = obj !== null && typeof obj['action'] === 'object' && obj['action'] !== null ? (obj['action'] as Record<string, unknown>) : null
  const rawKind = rawAction !== null ? rawAction['kind'] : undefined
  if (typeof rawKind === 'string' && rawKind !== 'code' && rawKind !== 'preset') {
    push('action.kind', `action.kind must be 'code' or 'preset' (got '${rawKind}')`)
    return done()
  }

  const parsed = RuleFileSchema.safeParse(json)
  if (!parsed.success) {
    const detail = parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ')
    const field = parsed.error.issues[0]?.path.join('.') || '(root)'
    push(field, `does not match the §17 rule shape — ${detail}`)
    return done()
  }
  const data = parsed.data

  // Capabilities: hand-written (code) or auto-derived (preset).
  let capabilities: CapabilityDeclaration
  if (data.action.kind === 'preset') {
    if (data.capabilities !== undefined) {
      push('capabilities', 'preset capabilities are auto-derived from the trigger — remove the capabilities field')
    }
    capabilities = derivePresetCapabilities(data.trigger)
  } else {
    try {
      capabilities = parseCapabilities(data.capabilities ?? {})
    } catch (err) {
      const message = err instanceof CapabilityError ? `capabilities: ${err.message}` : String(err)
      push('capabilities', message)
      return done()
    }
    // Defense in depth: no rule may author rules (write into the rules dir).
    const writesRulesDir = capabilities.fsWrite.some(
      (root) => isPathWithin(root, ruleDir) || isPathWithin(ruleDir, root)
    )
    if (writesRulesDir) push('capabilities.fsWrite', 'capabilities.fsWrite may not include the rules directory')
  }

  const trigger = analyzeTrigger(data.trigger, capabilities, push)

  let condition: RuleCondition | null = null
  if (data.condition !== undefined) {
    try {
      condition = parseRuleCondition(data.condition)
    } catch (err) {
      push('condition', err instanceof Error ? err.message : String(err))
    }
  }

  let action: RuleAction | null = null
  let willScaffoldEntry = false
  if (data.action.kind === 'preset') {
    const preset = data.action.preset
    const meta = RULE_PRESETS[preset]
    const folder = data.action.folder ?? null
    if (meta.needsFolder && folder === null) {
      push('action.folder', `the '${preset}' preset needs a folder — choose one of your watched folders`)
    }
    if (!meta.needsFolder && folder !== null) {
      push('action.folder', `the '${preset}' preset does not take a folder`)
    }
    if (
      meta.needsFolder &&
      folder !== null &&
      ctx.watchedFolderNames !== undefined &&
      !ctx.watchedFolderNames.has(folder)
    ) {
      push('action.folder', `no watched folder named '${folder}' — add it under Watched folders first`)
    }
    action = { kind: 'preset', preset, taskKind: meta.taskKind, folder: meta.needsFolder ? folder : null }
  } else {
    const lang = data.action.lang.toLowerCase()
    const lane: 'deno' | 'docker' =
      lang === 'ts' || lang === 'js' || lang === 'typescript' || lang === 'javascript' ? 'deno' : 'docker'
    const entry = resolve(ruleDir, expandHome(data.action.entry))
    const entryExists = existsSync(entry) && statSync(entry).isFile()
    if (!entryExists) {
      if (ctx.entryMode === 'scaffold-ok' && isPathWithin(entry, ruleDir)) {
        willScaffoldEntry = true
      } else {
        const hint =
          ctx.entryMode === 'scaffold-ok'
            ? ' — point at an existing file, or use a path inside the rules folder to scaffold a starter'
            : ''
        push('action.entry', `action.entry '${data.action.entry}' does not resolve to a file (looked at ${entry})${hint}`)
      }
    }
    if (lane === 'docker' && ctx.dockerAvailable === false) {
      push(
        'action.lang',
        `'${lang}' runs in the Docker sandbox, which isn't available right now — install/start Docker or the rule will fail when it fires`,
        'warning'
      )
    }
    action = { kind: 'code', lang, entry, lane }
  }

  if (ctx.existingIds !== undefined && ctx.existingIds.has(data.id)) {
    push('id', `a rule with id '${data.id}' already exists`)
  }

  const hasError = issues.some((i) => i.severity === 'error')
  const rule: LoadedRule | null =
    hasError || trigger === null || action === null
      ? null
      : {
          id: data.id,
          file,
          trigger,
          condition,
          action,
          enabled: data.enabled ?? true,
          modelTier: data.modelTier ?? 'local',
          capabilities
        }
  return { issues, rule, willScaffoldEntry }
}

/** Parse + validate ONE rule file's content. Throws with a precise reason. */
export function parseRuleFile(file: string, content: string, ruleDir: string): LoadedRule {
  let json: unknown
  try {
    json = JSON.parse(content)
  } catch (err) {
    throw new Error(`not valid JSON: ${err instanceof Error ? err.message : String(err)}`)
  }
  const analysis = analyzeRule(json, file, ruleDir, { entryMode: 'must-exist' })
  if (analysis.rule === null) {
    const firstError = analysis.issues.find((i) => i.severity === 'error')
    throw new Error(firstError?.message ?? 'invalid rule')
  }
  return analysis.rule
}

/**
 * Load every *.rule.json in the rules folder. Invalid files land in `errors`
 * (with the exact reason) and are skipped; a duplicate id keeps the first
 * file and rejects the later one. DISABLED rules are fully validated and
 * returned (with `enabled:false`) — the consumers (agents/watchers) filter to
 * the enabled subset; an invalid-while-disabled file still surfaces its error.
 */
export function loadRules(rulesDir: string): RuleLoadResult {
  let entries: string[]
  try {
    entries = readdirSync(rulesDir)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { rules: [], errors: [] }
    throw err
  }
  const rules: LoadedRule[] = []
  const errors: RuleLoadError[] = []
  const seen = new Map<string, string>()
  for (const name of entries.sort()) {
    if (!name.toLowerCase().endsWith(RULE_FILE_SUFFIX)) continue
    const file = join(rulesDir, name)
    try {
      const rule = parseRuleFile(file, readFileSync(file, 'utf8'), rulesDir)
      const firstFile = seen.get(rule.id)
      if (firstFile !== undefined) {
        throw new Error(`duplicate rule id '${rule.id}' (already defined by ${firstFile})`)
      }
      seen.set(rule.id, file)
      rules.push(rule)
    } catch (err) {
      errors.push({ file, error: err instanceof Error ? err.message : String(err) })
    }
  }
  return { rules, errors }
}

/**
 * Register each ENABLED rule as a §13 agent: its declared capabilities, NO
 * standing grants (every gated tier defaults to 'ask' → pending-approval rows
 * the dashboard decides; phase-09 decision 2). Disabled rules are skipped.
 */
export function registerRuleAgents(permissions: PermissionEngine, rules: readonly LoadedRule[]): void {
  for (const rule of rules) {
    if (!rule.enabled) continue
    permissions.registerAgent(ruleAgentId(rule.id), { capabilities: rule.capabilities })
  }
}
