#!/bin/sh
# Agentic OS SessionEnd hook (spec 6/20). Claude Code pipes the session-end
# JSON (session_id, transcript_path, cwd, reason) to stdin; we POST it to the
# app's hook endpoint. On ANY failure -- curl missing, app not running,
# non-2xx -- the payload is spooled to ~/.agentic-os/pending-sessions/ so no
# session is ever lost. ALWAYS exits 0: a hook failure must never break the
# user's Claude Code session.
#
#   $1 = bearer token
#   $2 = endpoint URL (optional; default = spec 20 hook endpoint)

TOKEN="${1:-}"
URL="${2:-http://127.0.0.1:4517/hooks/session-end}"

PAYLOAD=$(cat)
if [ -z "$PAYLOAD" ]; then
  exit 0
fi

if command -v curl >/dev/null 2>&1; then
  if printf '%s' "$PAYLOAD" | curl -fsS -m 10 -X POST \
    -H "Authorization: Bearer $TOKEN" \
    -H "Content-Type: application/json" \
    --data-binary @- \
    "$URL" >/dev/null 2>&1; then
    exit 0
  fi
fi

# App unreachable (or curl absent): spool the payload instead.
SPOOL="$HOME/.agentic-os/pending-sessions"
mkdir -p "$SPOOL" 2>/dev/null
STAMP=$(date -u +%Y%m%dT%H%M%S 2>/dev/null || echo unknown)
printf '%s' "$PAYLOAD" > "$SPOOL/$STAMP-$$.json" 2>/dev/null

exit 0
