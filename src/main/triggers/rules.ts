/**
 * User-coded rules (§17 agent #5, §7 "user-coded rules") — declarative
 * `{ trigger, condition, action }` JSON files in ~/.agentic-os/rules/
 * (*.rule.json), zod-validated against exactly the §17 shape, and EXACTLY
 * what §13 enforces against: each valid rule registers the agent id
 * `rule:<id>` with its declared capabilities and NO standing grants (the
 * phase-09 decision — a user rule's side-effecting actions queue for the
 * dashboard; §13 "prompt before writes, network calls, spend").
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
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
import { Cron } from 'croner'
import * as z from 'zod'
import type { CapabilityDeclaration } from '../kernel'
import { CapabilityError, isDomainAllowed, parseCapabilities, pathsAllowed } from '../security'
import type { PermissionEngine } from '../security'

export const RULE_FILE_SUFFIX = '.rule.json'

/** The agent id a rule's every kernel action is attributed to (§13). */
export function ruleAgentId(ruleId: string): string {
  return `rule:${ruleId}`
}

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

const RuleFileSchema = z.object({
  id: z
    .string()
    .regex(/^[a-zA-Z0-9][a-zA-Z0-9-_]{0,63}$/, 'id must be alphanumeric with -/_ (max 64 chars)'),
  trigger: z.discriminatedUnion('type', [WatchTriggerSchema, ScheduleTriggerSchema]),
  condition: z.string().min(1).optional(),
  action: z.object({
    /** v1 executes code actions only (§7: always in a sandbox lane). */
    kind: z.literal('code'),
    lang: z.string().min(1),
    /** Entry file, resolved against the rule file's own directory. */
    entry: z.string().min(1)
  }),
  modelTier: z.enum(['local', 'cloud']).optional(),
  capabilities: z.unknown().optional()
})

export type RuleTrigger =
  | { readonly type: 'watch'; readonly url: string; readonly intervalMin: number }
  | { readonly type: 'watch'; readonly path: string }
  | { readonly type: 'schedule'; readonly cron: string }

export interface LoadedRule {
  readonly id: string
  /** Absolute path of the .rule.json file. */
  readonly file: string
  readonly trigger: RuleTrigger
  readonly condition: RuleCondition | null
  readonly action: {
    readonly kind: 'code'
    readonly lang: string
    /** Absolute entry path (validated to exist at load). */
    readonly entry: string
    /** §7: JS/TS → Deno lane; any other language → Docker lane. */
    readonly lane: 'deno' | 'docker'
  }
  readonly modelTier: 'local' | 'cloud'
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

const expandHome = (p: string): string => (p === '~' || p.startsWith('~/') || p.startsWith('~\\') ? join(homedir(), p.slice(1)) : p)

function validateTrigger(
  raw: z.output<typeof RuleFileSchema>['trigger'],
  capabilities: CapabilityDeclaration
): RuleTrigger {
  if (raw.type === 'schedule') {
    try {
      const probe = new Cron(raw.cron, { paused: true }, () => undefined)
      probe.stop()
    } catch (err) {
      throw new Error(`trigger.cron '${raw.cron}' is not a valid cron expression: ${String(err)}`)
    }
    return { type: 'schedule', cron: raw.cron }
  }
  const hasUrl = raw.url !== undefined
  const hasPath = raw.path !== undefined
  if (hasUrl === hasPath) {
    throw new Error("a watch trigger needs exactly one of 'url' or 'path'")
  }
  if (hasUrl) {
    let parsed: URL
    try {
      parsed = new URL(raw.url ?? '')
    } catch {
      throw new Error(`trigger.url '${raw.url}' is not a valid URL`)
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new Error(`trigger.url must be http(s), got '${parsed.protocol}'`)
    }
    if (!isDomainAllowed(parsed.host, capabilities.netDomains)) {
      throw new Error(
        `trigger.url host '${parsed.host}' is not in the rule's capabilities.netDomains — a rule may only watch what it declared (§13)`
      )
    }
    if (raw.intervalMin === undefined) {
      throw new Error('a url watch needs intervalMin (poll cadence, minutes)')
    }
    return { type: 'watch', url: parsed.toString(), intervalMin: raw.intervalMin }
  }
  const watchPath = resolve(expandHome(raw.path ?? ''))
  if (!isAbsolute(watchPath)) throw new Error(`trigger.path must be absolute, got '${raw.path}'`)
  if (!pathsAllowed([watchPath], capabilities.fsRead)) {
    throw new Error(
      `trigger.path '${watchPath}' is not within the rule's capabilities.fsRead — a rule may only watch what it declared (§13)`
    )
  }
  return { type: 'watch', path: watchPath }
}

/** Parse + validate ONE rule file's content. Throws with a precise reason. */
export function parseRuleFile(file: string, content: string, ruleDir: string): LoadedRule {
  let json: unknown
  try {
    json = JSON.parse(content)
  } catch (err) {
    throw new Error(`not valid JSON: ${err instanceof Error ? err.message : String(err)}`)
  }
  const parsed = RuleFileSchema.safeParse(json)
  if (!parsed.success) {
    const detail = parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ')
    throw new Error(`does not match the §17 rule shape — ${detail}`)
  }
  const data = parsed.data
  let capabilities: CapabilityDeclaration
  try {
    capabilities = parseCapabilities(data.capabilities ?? {})
  } catch (err) {
    if (err instanceof CapabilityError) throw new Error(`capabilities: ${err.message}`)
    throw err
  }
  const trigger = validateTrigger(data.trigger, capabilities)
  const condition = data.condition === undefined ? null : parseRuleCondition(data.condition)
  const entry = resolve(ruleDir, expandHome(data.action.entry))
  if (!existsSync(entry) || !statSync(entry).isFile()) {
    throw new Error(`action.entry '${data.action.entry}' does not resolve to a file (looked at ${entry})`)
  }
  const lang = data.action.lang.toLowerCase()
  const lane: 'deno' | 'docker' = lang === 'ts' || lang === 'js' || lang === 'typescript' || lang === 'javascript' ? 'deno' : 'docker'
  return {
    id: data.id,
    file,
    trigger,
    condition,
    action: { kind: 'code', lang, entry, lane },
    modelTier: data.modelTier ?? 'local',
    capabilities
  }
}

/**
 * Load every *.rule.json in the rules folder. Invalid files land in `errors`
 * (with the exact reason) and are skipped; a duplicate id keeps the first
 * file and rejects the later one.
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
 * Register each rule as a §13 agent: its declared capabilities, NO standing
 * grants (every gated tier defaults to 'ask' → pending-approval rows the
 * dashboard decides; phase-09 decision 2).
 */
export function registerRuleAgents(permissions: PermissionEngine, rules: readonly LoadedRule[]): void {
  for (const rule of rules) {
    permissions.registerAgent(ruleAgentId(rule.id), { capabilities: rule.capabilities })
  }
}
