# PROMPTS — copy/paste one per session, in order

**Routine per phase:** set the effort level shown → paste the prompt → let it run → review the report → `/clear` → next.
(Or skip pasting entirely with `./run-build.sh` after Phase 00.)

| Effort | Phases |
|---|---|
| high | 00, 02, 05, 06, 10 |
| xhigh | 03, 04, 07, 11 |
| max | 01, 08, 12 |
| ultracode | 09, 13 (audit-shaped work — review each workflow plan before approving) |


## Phase 00 — before pasting, run: `/effort high`

```
Your goal: complete Phase 00 end to end. Work continuously until it is done — do not stop to check in.

Read CLAUDE.md, docs/PROGRESS.md, the two most recent reports in docs/progress/, then docs/phases/phase-00-scaffold.md and every spec section it lists under "Read first". Read this prompt and the phase document TWICE before writing any code — the second pass is for requirements the first pass skimmed.

Use subagents whenever you judge they will help; the one rule is that two subagents must never write the same core module concurrently. Only interrupt me for decisions that genuinely need my input (installs, credentials, destructive choices).

The goal is reached only when every Definition of Done item passes and the end-of-phase protocol from CLAUDE.md is complete (verification commands → docs/progress/phase-00-report.md → PROGRESS.md row → git commit). Then stop so I can /clear before the next phase.
```


## Phase 01 — before pasting, run: `/effort max`

```
Your goal: complete Phase 01 end to end. Work continuously until it is done — do not stop to check in.

Read CLAUDE.md, docs/PROGRESS.md, the two most recent reports in docs/progress/, then docs/phases/phase-01-storage.md and every spec section it lists under "Read first". Read this prompt and the phase document TWICE before writing any code — the second pass is for requirements the first pass skimmed.

Use subagents whenever you judge they will help; the one rule is that two subagents must never write the same core module concurrently. Only interrupt me for decisions that genuinely need my input (installs, credentials, destructive choices).

The goal is reached only when every Definition of Done item passes and the end-of-phase protocol from CLAUDE.md is complete (verification commands → docs/progress/phase-01-report.md → PROGRESS.md row → git commit). Then stop so I can /clear before the next phase.
```


## Phase 02 — before pasting, run: `/effort high`

```
Your goal: complete Phase 02 end to end. Work continuously until it is done — do not stop to check in.

Read CLAUDE.md, docs/PROGRESS.md, the two most recent reports in docs/progress/, then docs/phases/phase-02-models.md and every spec section it lists under "Read first". Read this prompt and the phase document TWICE before writing any code — the second pass is for requirements the first pass skimmed.

Use subagents whenever you judge they will help; the one rule is that two subagents must never write the same core module concurrently. Only interrupt me for decisions that genuinely need my input (installs, credentials, destructive choices).

The goal is reached only when every Definition of Done item passes and the end-of-phase protocol from CLAUDE.md is complete (verification commands → docs/progress/phase-02-report.md → PROGRESS.md row → git commit). Then stop so I can /clear before the next phase.
```


## Phase 03 — before pasting, run: `/effort xhigh`

```
Your goal: complete Phase 03 end to end. Work continuously until it is done — do not stop to check in.

Read CLAUDE.md, docs/PROGRESS.md, the two most recent reports in docs/progress/, then docs/phases/phase-03-retrieval.md and every spec section it lists under "Read first". Read this prompt and the phase document TWICE before writing any code — the second pass is for requirements the first pass skimmed.

Use subagents whenever you judge they will help; the one rule is that two subagents must never write the same core module concurrently. Only interrupt me for decisions that genuinely need my input (installs, credentials, destructive choices).

The goal is reached only when every Definition of Done item passes and the end-of-phase protocol from CLAUDE.md is complete (verification commands → docs/progress/phase-03-report.md → PROGRESS.md row → git commit). Then stop so I can /clear before the next phase.
```


## Phase 04 — before pasting, run: `/effort xhigh`

```
Your goal: complete Phase 04 end to end. Work continuously until it is done — do not stop to check in.

Read CLAUDE.md, docs/PROGRESS.md, the two most recent reports in docs/progress/, then docs/phases/phase-04-kernel.md and every spec section it lists under "Read first". Read this prompt and the phase document TWICE before writing any code — the second pass is for requirements the first pass skimmed.

Use subagents whenever you judge they will help; the one rule is that two subagents must never write the same core module concurrently. Only interrupt me for decisions that genuinely need my input (installs, credentials, destructive choices).

The goal is reached only when every Definition of Done item passes and the end-of-phase protocol from CLAUDE.md is complete (verification commands → docs/progress/phase-04-report.md → PROGRESS.md row → git commit). Then stop so I can /clear before the next phase.
```


## Phase 05 — before pasting, run: `/effort high`

```
Your goal: complete Phase 05 end to end. Work continuously until it is done — do not stop to check in.

Read CLAUDE.md, docs/PROGRESS.md, the two most recent reports in docs/progress/, then docs/phases/phase-05-mcp.md and every spec section it lists under "Read first". Read this prompt and the phase document TWICE before writing any code — the second pass is for requirements the first pass skimmed.

Use subagents whenever you judge they will help; the one rule is that two subagents must never write the same core module concurrently. Only interrupt me for decisions that genuinely need my input (installs, credentials, destructive choices).

The goal is reached only when every Definition of Done item passes and the end-of-phase protocol from CLAUDE.md is complete (verification commands → docs/progress/phase-05-report.md → PROGRESS.md row → git commit). Then stop so I can /clear before the next phase.
```


## Phase 06 — before pasting, run: `/effort high`

```
Your goal: complete Phase 06 end to end. Work continuously until it is done — do not stop to check in.

Read CLAUDE.md, docs/PROGRESS.md, the two most recent reports in docs/progress/, then docs/phases/phase-06-knowledge-ingestion.md and every spec section it lists under "Read first". Read this prompt and the phase document TWICE before writing any code — the second pass is for requirements the first pass skimmed.

Use subagents whenever you judge they will help; the one rule is that two subagents must never write the same core module concurrently. Only interrupt me for decisions that genuinely need my input (installs, credentials, destructive choices).

The goal is reached only when every Definition of Done item passes and the end-of-phase protocol from CLAUDE.md is complete (verification commands → docs/progress/phase-06-report.md → PROGRESS.md row → git commit). Then stop so I can /clear before the next phase.
```


## Phase 07 — before pasting, run: `/effort xhigh`

```
Your goal: complete Phase 07 end to end. Work continuously until it is done — do not stop to check in.

Read CLAUDE.md, docs/PROGRESS.md, the two most recent reports in docs/progress/, then docs/phases/phase-07-codebase-ingestion.md and every spec section it lists under "Read first". Read this prompt and the phase document TWICE before writing any code — the second pass is for requirements the first pass skimmed.

Use subagents whenever you judge they will help; the one rule is that two subagents must never write the same core module concurrently. Only interrupt me for decisions that genuinely need my input (installs, credentials, destructive choices).

The goal is reached only when every Definition of Done item passes and the end-of-phase protocol from CLAUDE.md is complete (verification commands → docs/progress/phase-07-report.md → PROGRESS.md row → git commit). Then stop so I can /clear before the next phase.
```


## Phase 08 — before pasting, run: `/effort max`

```
Your goal: complete Phase 08 end to end. Work continuously until it is done — do not stop to check in.

Read CLAUDE.md, docs/PROGRESS.md, the two most recent reports in docs/progress/, then docs/phases/phase-08-extraction-agent.md and every spec section it lists under "Read first". Read this prompt and the phase document TWICE before writing any code — the second pass is for requirements the first pass skimmed.

Use subagents whenever you judge they will help; the one rule is that two subagents must never write the same core module concurrently. Only interrupt me for decisions that genuinely need my input (installs, credentials, destructive choices).

The goal is reached only when every Definition of Done item passes and the end-of-phase protocol from CLAUDE.md is complete (verification commands → docs/progress/phase-08-report.md → PROGRESS.md row → git commit). Then stop so I can /clear before the next phase.
```


## Phase 09 — before pasting, run: `/effort ultracode`

```
Your goal: complete Phase 09 end to end. Work continuously until it is done — do not stop to check in.

Read CLAUDE.md, docs/PROGRESS.md, the two most recent reports in docs/progress/, then docs/phases/phase-09-security.md and every spec section it lists under "Read first". Read this prompt and the phase document TWICE before writing any code — the second pass is for requirements the first pass skimmed.

Use subagents whenever you judge they will help; the one rule is that two subagents must never write the same core module concurrently. Only interrupt me for decisions that genuinely need my input (installs, credentials, destructive choices).

The goal is reached only when every Definition of Done item passes and the end-of-phase protocol from CLAUDE.md is complete (verification commands → docs/progress/phase-09-report.md → PROGRESS.md row → git commit). Then stop so I can /clear before the next phase.
```


## Phase 10 — before pasting, run: `/effort high`

```
Your goal: complete Phase 10 end to end. Work continuously until it is done — do not stop to check in.

Read CLAUDE.md, docs/PROGRESS.md, the two most recent reports in docs/progress/, then docs/phases/phase-10-dashboard.md and every spec section it lists under "Read first". Read this prompt and the phase document TWICE before writing any code — the second pass is for requirements the first pass skimmed.

Use subagents whenever you judge they will help; the one rule is that two subagents must never write the same core module concurrently. Only interrupt me for decisions that genuinely need my input (installs, credentials, destructive choices).

The goal is reached only when every Definition of Done item passes and the end-of-phase protocol from CLAUDE.md is complete (verification commands → docs/progress/phase-10-report.md → PROGRESS.md row → git commit). Then stop so I can /clear before the next phase.
```


## Phase 11 — before pasting, run: `/effort xhigh`

```
Your goal: complete Phase 11 end to end. Work continuously until it is done — do not stop to check in.

Read CLAUDE.md, docs/PROGRESS.md, the two most recent reports in docs/progress/, then docs/phases/phase-11-triggers.md and every spec section it lists under "Read first". Read this prompt and the phase document TWICE before writing any code — the second pass is for requirements the first pass skimmed.

Use subagents whenever you judge they will help; the one rule is that two subagents must never write the same core module concurrently. Only interrupt me for decisions that genuinely need my input (installs, credentials, destructive choices).

The goal is reached only when every Definition of Done item passes and the end-of-phase protocol from CLAUDE.md is complete (verification commands → docs/progress/phase-11-report.md → PROGRESS.md row → git commit). Then stop so I can /clear before the next phase.
```


## Phase 12 — before pasting, run: `/effort max`

```
Your goal: complete Phase 12 end to end. Work continuously until it is done — do not stop to check in.

Read CLAUDE.md, docs/PROGRESS.md, the two most recent reports in docs/progress/, then docs/phases/phase-12-skill-improvement.md and every spec section it lists under "Read first". Read this prompt and the phase document TWICE before writing any code — the second pass is for requirements the first pass skimmed.

Use subagents whenever you judge they will help; the one rule is that two subagents must never write the same core module concurrently. Only interrupt me for decisions that genuinely need my input (installs, credentials, destructive choices).

The goal is reached only when every Definition of Done item passes and the end-of-phase protocol from CLAUDE.md is complete (verification commands → docs/progress/phase-12-report.md → PROGRESS.md row → git commit). Then stop so I can /clear before the next phase.
```


## Phase 13 — before pasting, run: `/effort ultracode`

```
Your goal: complete Phase 13 end to end. Work continuously until it is done — do not stop to check in.

Read CLAUDE.md, docs/PROGRESS.md, the two most recent reports in docs/progress/, then docs/phases/phase-13-hardening-release.md and every spec section it lists under "Read first". Read this prompt and the phase document TWICE before writing any code — the second pass is for requirements the first pass skimmed.

Use subagents whenever you judge they will help; the one rule is that two subagents must never write the same core module concurrently. Only interrupt me for decisions that genuinely need my input (installs, credentials, destructive choices).

The goal is reached only when every Definition of Done item passes and the end-of-phase protocol from CLAUDE.md is complete (verification commands → docs/progress/phase-13-report.md → PROGRESS.md row → git commit). Then stop so I can /clear before the next phase.
```
