/**
 * Rule runtime + live reload (§7/§17, phase 31). Owns the CURRENT rule set and
 * applies a create/edit/enable/disable/delete WITHOUT an app restart. Every
 * place that used to read the boot snapshot reads this holder instead:
 *   - registerRuleActionHandler's `rules()` closure → `runtime.rules()`
 *   - the handler's `dockerLane` thunk           → `runtime.dockerLane()`
 *   - getTriggersStatus's rule errors             → `runtime.ruleErrors()`
 *
 * `reload()` is the ONLY mutator and the ordering IS the safety mechanism:
 *   register(added+changed agents) → swap the holder → re-detect Docker →
 *   applyRules (teardown-before-arm) → unregister(removed agents).
 * Registering before arming means no fire ever finds its agent missing;
 * unregistering after teardown means a dying watcher's last fire fails with a
 * friendly "no longer loaded" fatal, not a noisy kernel denial. Concurrent
 * reloads coalesce latest-wins so an edit is never invisible until reboot.
 */
import {
  DockerLane,
  detectDocker,
  type PermissionEngine,
  type SandboxLane
} from '../security'
import {
  loadRules,
  ruleAgentId,
  type LoadedRule,
  type RuleLoadError,
  type RuleLoadResult
} from './rules'
import type { TriggerWatchers } from './watchers'

export interface RuleReloadResult {
  /** Newly-armed rule ids (added, or enabled). */
  readonly added: readonly string[]
  /** Rule ids no longer armed (deleted, or disabled). */
  readonly removed: readonly string[]
  /** Armed rules whose definition changed (same id, different fingerprint). */
  readonly changed: readonly string[]
  /** Count of armed rules that were unchanged. */
  readonly unchanged: number
  /** Rule files that failed §17 validation this pass. */
  readonly errors: readonly RuleLoadError[]
}

export interface RuleRuntimeDeps {
  readonly rulesDir: string
  readonly permissions: PermissionEngine
  readonly watchers: Pick<TriggerWatchers, 'applyRules'>
  /** Test seams. */
  readonly loadRulesImpl?: typeof loadRules
  readonly detectDockerImpl?: () => Promise<{ available: boolean }>
  readonly makeDockerLane?: () => SandboxLane
}

/**
 * Stable identity of a rule's BEHAVIOR (enabled EXCLUDED — active-set
 * membership already handles enable/disable). A change here means the agent
 * must be re-registered and the trigger re-armed.
 */
export function ruleFingerprint(rule: LoadedRule): string {
  return JSON.stringify({
    trigger: rule.trigger,
    condition: rule.condition?.source ?? null,
    action: rule.action,
    modelTier: rule.modelTier,
    capabilities: {
      fsRead: [...rule.capabilities.fsRead].sort(),
      fsWrite: [...rule.capabilities.fsWrite].sort(),
      netDomains: [...rule.capabilities.netDomains].sort(),
      tools: [...rule.capabilities.tools].sort(),
      maxSpendUSD: rule.capabilities.maxSpendUSD
    }
  })
}

/** Stable identity of a rule's TRIGGER only — drives baseline reset. */
function triggerFingerprint(rule: LoadedRule): string {
  return JSON.stringify(rule.trigger)
}

const activeById = (rules: Iterable<LoadedRule>): Map<string, LoadedRule> => {
  const map = new Map<string, LoadedRule>()
  for (const rule of rules) if (rule.enabled) map.set(rule.id, rule)
  return map
}

export class RuleRuntime {
  private readonly deps: RuleRuntimeDeps
  /** ALL loaded rules (incl. disabled — the handler needs precise errors). */
  private current: Map<string, LoadedRule>
  private errorsRef: readonly RuleLoadError[]
  private dockerLaneRef: SandboxLane | null
  private inFlight: Promise<RuleReloadResult> | null = null
  private rerun = false

  constructor(deps: RuleRuntimeDeps, initial: RuleLoadResult, initialDockerAvailable: boolean) {
    this.deps = deps
    this.current = new Map(initial.rules.map((r) => [r.id, r]))
    this.errorsRef = initial.errors
    this.dockerLaneRef = initialDockerAvailable ? this.buildDockerLane() : null
  }

  /** The FULL map (incl. disabled) — the rule-action handler resolves against it. */
  rules(): ReadonlyMap<string, LoadedRule> {
    return this.current
  }

  ruleErrors(): readonly RuleLoadError[] {
    return this.errorsRef
  }

  dockerLane(): SandboxLane | null {
    return this.dockerLaneRef
  }

  /**
   * Reload from disk and apply the delta. Concurrent calls coalesce: a call
   * arriving while a reload runs sets a trailing re-run (latest-wins) and
   * resolves to the final state — an edit is never left invisible until reboot.
   */
  reload(): Promise<RuleReloadResult> {
    if (this.inFlight !== null) {
      this.rerun = true
      return this.inFlight
    }
    this.inFlight = this.runReloadLoop()
    return this.inFlight
  }

  private async runReloadLoop(): Promise<RuleReloadResult> {
    // finally (not a success-path assignment): if a reload rejects, inFlight
    // MUST still clear, or every future reload() coalesces onto the dead
    // rejected promise and live authoring is wedged until restart.
    try {
      let result: RuleReloadResult
      do {
        this.rerun = false
        result = await this.reloadOnce()
      } while (this.rerun)
      return result
    } finally {
      this.inFlight = null
    }
  }

  private async reloadOnce(): Promise<RuleReloadResult> {
    let next: RuleLoadResult
    try {
      next = (this.deps.loadRulesImpl ?? loadRules)(this.deps.rulesDir)
    } catch (err) {
      // Keep the OLD set fully live — nothing half-applied; report the failure.
      return {
        added: [],
        removed: [],
        changed: [],
        unchanged: activeById(this.current.values()).size,
        errors: [{ file: this.deps.rulesDir, error: err instanceof Error ? err.message : String(err) }]
      }
    }

    const oldActive = activeById(this.current.values())
    const newActive = activeById(next.rules)

    const addedRules: LoadedRule[] = []
    const changedRules: { prev: LoadedRule; cur: LoadedRule }[] = []
    let unchanged = 0
    for (const [id, cur] of newActive) {
      const prev = oldActive.get(id)
      if (prev === undefined) addedRules.push(cur)
      else if (ruleFingerprint(prev) !== ruleFingerprint(cur)) changedRules.push({ prev, cur })
      else unchanged++
    }
    const removed: string[] = []
    for (const id of oldActive.keys()) if (!newActive.has(id)) removed.push(id)

    const added = addedRules.map((r) => r.id)
    const changed = changedRules.map((c) => c.cur.id)
    const triggerChanged = changedRules
      .filter((c) => triggerFingerprint(c.prev) !== triggerFingerprint(c.cur))
      .map((c) => c.cur.id)

    // 1. Register agents for added + changed active rules BEFORE arming, so no
    //    fire ever finds its `rule:<id>` agent missing (re-registration replaces).
    for (const rule of [...addedRules, ...changedRules.map((c) => c.cur)]) {
      this.deps.permissions.registerAgent(ruleAgentId(rule.id), { capabilities: rule.capabilities })
    }

    // 2. Swap the holder (ALL rules incl. disabled) + the error list. Every
    //    rule-action task that STARTS from now resolves the new definition.
    this.current = new Map(next.rules.map((r) => [r.id, r]))
    this.errorsRef = next.errors

    // 3. Re-detect Docker and swap the lane (removes the last restart need).
    await this.refreshDockerLane()

    // 4. Re-arm the trigger runtime (teardown-before-arm). Reset baselines ONLY
    //    for rules removed FROM DISK or whose trigger changed — a disable (still
    //    on disk) preserves its baseline so re-enabling an unchanged watch never
    //    re-fires; a deleted-then-recreated id gets a fresh baseline.
    const nextIds = new Set(next.rules.map((r) => r.id))
    const removedFromDisk = removed.filter((id) => !nextIds.has(id))
    const resetBaselineIds = [...new Set([...removedFromDisk, ...triggerChanged])]
    await this.deps.watchers.applyRules([...newActive.values()], resetBaselineIds)

    // 5. Unregister removed agents AFTER teardown (a dying watcher's last fire
    //    then hits the friendly "no longer loaded" fatal, not a kernel denial).
    for (const id of removed) this.deps.permissions.unregisterAgent(ruleAgentId(id))

    return { added, removed, changed, unchanged, errors: next.errors }
  }

  private buildDockerLane(): SandboxLane {
    return this.deps.makeDockerLane ? this.deps.makeDockerLane() : new DockerLane()
  }

  private async refreshDockerLane(): Promise<void> {
    let available: boolean
    try {
      const detection = this.deps.detectDockerImpl ? await this.deps.detectDockerImpl() : await detectDocker()
      available = detection.available
    } catch {
      return // keep the current lane on a detection failure
    }
    const have = this.dockerLaneRef !== null
    if (available && !have) this.dockerLaneRef = this.buildDockerLane()
    else if (!available && have) this.dockerLaneRef = null
  }
}
