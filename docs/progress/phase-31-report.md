# Phase 31 — User-authored scheduled tasks & watchers (Automations)

**Status:** done · **Date:** 2026-07-18 · User-directed feature completing spec agent #5.
**Methodology:** Fable judge-panel planning (3 designs → synthesis) · Opus implementation · Opus adversarial review.

## What the user asked for

> "I want to add a scheduled tasks feature where users can schedule tasks by time or programmatically … use fable subagents for planning and opus max for implementation"

Scope confirmed via one question → **both** action kinds: no-code **presets** *and* sandboxed **code**, each triggerable by **time** (cron) or **watcher** (file/folder change, or url poll).

## Context — this completes a designed-in feature, not net-new

Spec §5 lists agent #5 "User-defined scheduled tasks and always-running watchers (user-authored)"; §7 names "any user-scheduled tasks"; §17 gives the canonical `~/.agentic-os/rules/*.rule.json` shape. Phase 11 built the **runtime** (croner schedules, chokidar watchers, url polls, the Deno/Docker sandbox lanes, §13 capability enforcement, the approval spine) but left rules **read-only** — no authoring surface, and rules loaded **only at boot**. This phase adds the two missing pieces: a **dashboard authoring surface** and **live reload**. It is not on the "Optional / deferred" list.

## What was built

### 1. Schema — the §17 rule model, additively extended (`src/main/triggers/rules.ts`)
- `action` became a `discriminatedUnion('kind', [code, preset])`. **`code`** is unchanged (a sandboxed entry file). **`preset`** is a no-code action naming one of a whitelist (`RULE_PRESETS`): `memory-export`→`export`, `graph-prune`→`prune`, `skill-improvement`→`skill-improvement`, `folder-scan`→`watch-scan`. A preset enqueues its existing **system** task kind (system-attributed, no user code, no sandbox) — deliberately excluding `extraction`/`ingest-file`/`rule-action`/`workflow` (whose payloads could synthesize arbitrary work).
- Top-level optional **`enabled`** (absent ⇒ true) — a disabled rule loads/lists but arms nothing and registers no agent.
- **`derivePresetCapabilities(trigger)`** — presets need no hand-written caps: a path-watch derives `fsRead:[path]`, a url-watch `netDomains:[host]`, a schedule `EMPTY`. `validateTrigger`'s §13 containment then passes by construction.
- **`analyzeRule`** — the body of `parseRuleFile` refactored into ONE field-addressed validator returning `{issues, rule, willScaffoldEntry}`; `parseRuleFile` delegates and throws the first error **verbatim**, so every pre-existing loader message and its 15 tests stay byte-stable. New defense-in-depth: `capabilities.fsWrite` may not include RULES_DIR (a rule may never author rules).
- Backward-compat: every pre-31 file (code action, no `enabled`) parses identically. **Downgrade caveat** (recorded): a 0.1.x runtime strips `enabled` (disabled rule would run) and errors a `preset` action into `ruleErrors` (safe-fail); forward-only auto-update makes this downgrade-only — do not advertise these to old versions.

### 2. Live reload (`src/main/triggers/reload.ts` NEW · `watchers.ts` · `permissions.ts`)
- **`RuleRuntime`** owns the current rule map + the Docker lane. `reload()` is the only mutator; **ordering is the safety mechanism**: register(added+changed agents) → swap the holder → re-detect Docker → `applyRules` (teardown-before-arm) → unregister(removed agents). Register-before-arm ⇒ no fire finds its agent missing; unregister-after-teardown ⇒ a dying watcher's last fire hits a friendly fatal, not a kernel denial. Concurrent reloads **coalesce latest-wins** so an edit is never invisible until reboot.
- `ruleFingerprint` (enabled excluded) drives added/changed/unchanged; `resetBaselineIds = removed-FROM-DISK ∪ trigger-changed` — a plain **disable preserves its baseline** so re-enabling an unchanged watch never re-fires.
- `watchers.ts`: folder vs rule watcher split (folders armed once; rules rebuilt per reload); `armRule`/`applyRules`; `TriggerStateStore.delete`; `fireRule` preset branch + exported `enqueueRuleFire` (shared with run-now); handler guards — a task whose rule vanished / was disabled / became a preset **fatals** rather than running stale code; `dockerLane` is now a thunk read live. `permissions.unregisterAgent`.

### 3. RuleStore (`src/main/triggers/ruleStore.ts` NEW) — dashboard-only authoring
- `list/get/validateDraft/create/update/setEnabled/delete/deleteInvalidFile`. Three disciplines: **never-write-invalid** (validated through `analyzeRule` before any byte hits disk), **audited + reversible** (all writes/deletes via `audit.fileWrite`/`fileDelete` → History rows the user can undo, §21.11), **raw preservation** (mutations edit the RAW on-disk JSON — unknown top-level keys and `~/` forms survive an edit; normalized paths are never round-tripped back). Missing code entries **inside** the rules dir are scaffolded a language-appropriate starter (never overwriting existing code, never outside the dir). Every persist awaits `onMutation` (=`ruleRuntime.reload()`) and surfaces its diff.

### 4. IPC — dashboard-only, never MCP (`src/shared/ipc.ts` · `src/main/ipc.ts`)
- 9 channels: `rules.list/validate/create/update/setEnabled/delete/deleteInvalid/runNow/reload` + `IPC_RULE_PRESETS` + DTOs. **No MCP counterpart** (§21.6 — a rule is user-authored executable intent + a capability self-declaration; verified no `rule*` tool in the MCP registry or the four permission tool-sets). `run-now` bypasses the condition (tests the action) but a code rule still hits the same sandbox + approval spine. `audit.undo` gained a hook: undoing a rule-file op inside RULES_DIR re-arms (or re-breaks, correctly) the rule live. Boot wiring: `RuleRuntime`+`RuleStore` constructed before the handler that reads them; `triggerInstances` gains both, drops the boot `rules` snapshot; `ruleErrors` became a thunk (the staleness fix).

### 5. UI (`src/renderer/src/panels/automations/*` NEW · `lib/cron.ts` NEW · `TasksPanel.tsx`)
- New **Automations** section: a table (id · plain-language When · Does · Next run · on/off Toggle · Run now/Edit/Delete), a **New automation** editor modal (trigger builder — schedule presets hourly/daily-at/weekly + custom cron; file/folder via native picker; url + interval — and an action picker preset|code with a capabilities editor), live debounced validation with inline field errors, broken-file error rows with a delete-to-clean action, and undoable toasts. `lib/cron.ts` (pure, unit-tested) build/match/describe helpers. The read-only rule list was removed from the old `AutomationBody` (which now shows only the built-in system schedules).

## Adversarial review (Opus, 4 dimensions → refute-by-default verify)

13 agents; **8 confirmed / 1 refuted**. All 8 **fixed**:
- **HIGH** — a `reloadOnce()` throw (e.g. a baseline write failing on a full/locked disk) permanently wedged the reload machinery (`inFlight` never cleared) AND left every rule trigger disarmed (teardown ran before the throw, re-arm never did). Fixed: `try/finally` clears `inFlight`; the baseline-reset loop is now best-effort (a persist failure warns, never aborts the re-arm). Regression test pins recovery.
- **MEDIUM ×2** — editing any rule silently dropped its `modelTier` (`cloud`→`local`) and a schedule rule's `condition` (both editor-uneditable/hidden while `mergeRaw` cleared omitted keys). Fixed: `mergeRaw` carries `modelTier` from disk when the draft omits it; the editor now shows + round-trips `condition` for **all** trigger types (the backend evaluates conditions for schedule fires too). Regression test pins modelTier.
- **LOW ×5** — in-flight poll/detect re-persisting a baseline for a just-removed rule (membership guard added); scaffold-then-failed-write orphan (best-effort cleanup + test); `scaffoldEntry` emitting Python for a shell rule (now language-aware + test); folder-scan with zero watched folders producing a cryptic zod error (editor omits an empty folder → friendly message); the refuted one — the RULES_DIR fsWrite guard being lexical-only — correctly refuted (a rule can't obtain write access to RULES_DIR in the first place).

## Definition-of-Done — commands run

- `npm run typecheck` (node + web) → **clean**. `npm run lint` → **clean**. `npm run build` → **all 3 bundles built**.
- **Unit suite: 743 passed / 0 failed** (67 files). New/updated tests (all green): `cron` (build/match round-trips, descriptions), `triggers.rules.presets` (preset matrix, capability derivation, enabled flag + registerRuleAgents skip, analyzeRule field mapping, fsWrite-RULES_DIR), `triggers.ruleStore` (create/update/setEnabled/delete + dup-id + scaffold + raw-preservation + never-write-invalid + modelTier carry + sh scaffold + orphan cleanup), `triggers.reload` (diff + unregister + baseline preserve-on-disable + coalescing + throw-recovery), plus narrowed `triggers.rules`/`triggers.watchers` for the new types. Writing the tests **caught + fixed a real bug** (baseline reset fired on a plain disable).
- **Visual verification** (throwaway Playwright over the hermetic seeded app, since removed): opened Background work → the Automations section renders; the editor opens (schedule builder with live "Next run: 7/19/2026, 9:00:00 AM", preset + code modes, capabilities editor); creating a `daily-export` schedule+preset persisted and appeared live in the table ("Every day at 09:00 · Export your memory") — the full renderer→IPC→RuleStore→reload→refresh path with no restart.
- NO new npm dependencies. NO appdata migration (rules are file-based). `DEFAULT == TODAY` (no rules on disk ⇒ empty section, byte-identical runtime).

## For the next session
- The nav-table "Next run" uses the shared `Timestamp` (relative) which renders a future cron as "0s ago" — a pre-existing component behavior (the built-in schedules show it identically), not introduced here; a future polish could add an "in Xh" direction.
- Deferred (recorded): no chokidar self-watch on RULES_DIR (hand-edits apply via the **Reload** button or next boot); watched-**folder** add/remove still applies at next boot (unchanged from phase 11); no rule rename (id immutable — delete+recreate); no MCP surface of any kind.
