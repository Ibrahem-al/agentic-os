# Phase 12 — Skill-improvement agent + eval harness
**Goal:** nightly, event-gated self-improvement with a no-regression adoption gate, versioning, and drift watch.
**Read first:** spec §6 (nightly job), §17 (skill-improvement design), §18 write paths, §20; **read `docs/reference/skill-creator/` in full — its SKILL.md format and grader/comparator prompts are reimplemented, never guessed**; phase reports 04, 08, 11.

## Build (Phase-04 workflow, manual "improve now" trigger + the 02:00 slot)
1. Event gate: only skills with new `Correction`s / failure `Example`s since last run.
2. Test set: that skill's Corrections → regression cases; pad with a few synthetic cases (cloud brain).
3. Candidate: cloud brain rewrites instructions → new `SkillVersion(status=candidate)`; skills persist in SKILL.md format (frontmatter + body) so they stay portable to/from Claude Code.
4. Benchmark: verifiable skills → assertion grader (adapted from skill-creator's grader prompt); stylistic → blind A/B comparator judged by a *different* model/tier; train/held-out split, multiple runs, score on held-out.
5. Adoption gate: verifiable = net-positive AND zero regression on previously-fixed corrections → flip candidate→active, active→retired. Stylistic = same benchmark, then a one-click approval row in the review queue. Per-skill setting.
6. Drift watch: corrections-rate over the next 20 uses vs. predecessor → flag (auto-revert configurable, default off). Versions retained for rollback.

## Definition of Done
- [ ] Synthetic skill with seeded corrections: candidate generated, benchmarked, adopted only when the harness says net-positive + no regression (test both outcomes).
- [ ] Stylistic path lands in the review queue, not auto-adopted.
- [ ] Rollback restores the prior version; drift flag fires on a seeded regression stream.
- [ ] Skill round-trips losslessly to a `SKILL.md` file on disk.
