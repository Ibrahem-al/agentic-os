#!/usr/bin/env bash
# Autonomous phase loop: fresh Claude Code session per phase, runs until all phases done.
# WARNING: pre-grants edit+bash permissions to run unattended. Review before using.
set -euo pipefail
PHASES=(00-scaffold 01-storage 02-models 03-retrieval 04-kernel 05-mcp 06-knowledge-ingestion 07-codebase-ingestion 08-extraction-agent 09-security 10-dashboard 11-triggers 12-skill-improvement 13-hardening-release)
START="${1:-00}"
# Headless effort ceiling is xhigh (max/ultracode are interactive-session-only).
effort_for() { case "$1" in 01|03|04|07|08|09|11|12|13) echo xhigh;; *) echo high;; esac; }
for P in "${PHASES[@]}"; do
  NN="${P%%-*}"
  [[ "$NN" < "$START" ]] && continue
  if grep -Eq "\|\s*${NN}\s*\|[^|]*\|\s*done\s*\|" docs/PROGRESS.md; then
    echo "== Phase $NN already done, skipping"; continue
  fi
  echo "==================== PHASE $NN: $P ===================="
  claude -p "Your goal: complete Phase ${NN} end to end without stopping. Read CLAUDE.md, docs/PROGRESS.md, the two most recent reports in docs/progress/, then docs/phases/phase-${P}.md and every spec section it lists. Read this prompt and the phase document TWICE before writing any code. Use subagents whenever they help; two subagents must never write the same core module concurrently. You cannot ask the user anything: resolve ambiguities via spec §21 and §20 and record every such decision in the phase report. The goal is reached only when every Definition of Done item passes and the end-of-phase protocol is complete (verification -> docs/progress/phase-${NN}-report.md -> PROGRESS.md row marked done -> git commit)." \
    --effort "$(effort_for ${NN})" \
    --permission-mode acceptEdits \
    --allowedTools "Bash" \
    --max-turns 500 \
    || { echo "!! Phase $NN exited non-zero — stopping."; exit 1; }
  ls docs/progress/phase-${NN}-*.md >/dev/null 2>&1 \
    || { echo "!! Phase $NN produced no report — stopping so it cannot cascade."; exit 1; }
  echo "== Phase $NN complete."
done
echo "ALL PHASES DONE."
