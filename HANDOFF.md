# HANDOFF — how to run this build

## One-time setup
1. Create the repo folder (`agentic-os`), `git init`.
2. Copy into it: `CLAUDE.md` (repo root) and the whole `docs/` folder from this bundle (`docs/spec.md`, `docs/PROGRESS.md`, `docs/phases/`, empty `docs/progress/`).
3. Commit: `git add -A && git commit -m "handoff docs"`.
4. Open Claude Code in that folder.

## Running the build — two modes

### Mode A — interactive goal, one phase per session (recommended for 00 and 10)
Use the pre-filled prompts in `PROMPTS.md` — each states the `/effort` level to set first. Template:

```
ultrathink. Your goal: complete Phase NN end to end. Work continuously until it is done — do not stop to check in.

Read CLAUDE.md, docs/PROGRESS.md, the two most recent reports in docs/progress/, then docs/phases/phase-NN-*.md and every spec section it lists under "Read first". Read this prompt and the phase document TWICE before writing any code — the second pass is for requirements the first pass skimmed.

Use subagents whenever you judge they will help; the one rule is that two subagents must never write the same core module concurrently. Only interrupt me for decisions that genuinely need my input (installs, credentials, destructive choices).

The goal is reached only when every Definition of Done item passes and the end-of-phase protocol from CLAUDE.md is complete (verification commands -> docs/progress/phase-NN-report.md -> PROGRESS.md row -> git commit). Then stop so I can /clear before the next phase.
```

### Mode B — fully autonomous loop (run-build.sh)
Runs every remaining phase back-to-back, **fresh context per phase** (each `claude -p` is its own session — better than one long session, which degrades from compaction). It cannot pause to ask you anything, so it pre-grants permissions: review the flags, run it only on a machine/repo you are comfortable letting it modify, and do Phase 00 in Mode A first so installs happen with you watching.

```bash
./run-build.sh          # runs phases not yet marked done in PROGRESS.md
./run-build.sh 05       # start from a specific phase
```

It stops on the first phase that fails to produce a report, so a bad phase never cascades. Check `docs/progress/` between runs whenever you like — the loop is resumable.

## Permission mode
Run Claude Code in its default permission mode (don't turn on auto-accept or bypass-permissions). That way it natively prompts you before every install/shell command on top of the prompt's instructions.

## Model choice
Run every phase on **Claude Fable 5** if your plan allows — this build is architecture-dense and the phases where model quality compounds hardest are 01 (storage), 08 (extraction), 09 (security), and 12 (skill-improvement). If you need to economize, Sonnet-class is fine for 00, 06, 10, 13; never economize on 09.

## /clear discipline
- **Yes, /clear after every completed phase.** Fresh context per phase is the design: the repo + reports carry all state, and a fresh window means full attention on the current phase.
- Never /clear mid-phase. The checkpoint is the end-of-phase commit + report — anything not written to disk dies with the context.
- If a phase goes sideways (context bloated, Claude confused): tell it to write an interim report of exactly where it is, commit work-in-progress on a branch, /clear, and restart the phase with "resume from the interim report".

## If Phase 00 hits the RyuGraph blocker
Phase 00's spike is allowed to stop the build if no Electron-compatible RyuGraph binding exists. If `docs/progress/BLOCKER.md` appears, come back to me with it — the spec's §5 SQLite fallback is the pre-decided escape hatch and I'll rewrite Phase 01 for it.

## Watch-items per phase (what to skim in each report)
00: did the spike *really* run offline · 01: write-lane test honest? · 05: real Claude Code connected? · 07: self-ingest counts sane? · 09: conformance suite covers escapes, not happy paths · 10: screenshots don't look like default-shadcn slop · 11: spool drain proven · 13: E2E green on two OSes.
