# Agentic OS SessionEnd hook (spec 6/20) -- Windows PowerShell 5.1 compatible.
# Claude Code pipes the session-end JSON (session_id, transcript_path, cwd,
# reason) to stdin; we POST it to the app's hook endpoint. On ANY failure --
# app not running, non-2xx, timeout -- the payload is spooled to
# %USERPROFILE%\.agentic-os\pending-sessions\ so no session is ever lost.
# ALWAYS exits 0: a hook failure must never break the user's Claude Code
# session.
param(
  [string]$Token = '',
  [string]$Url = 'http://127.0.0.1:4517/hooks/session-end'
)

$ErrorActionPreference = 'Stop'

$payload = [Console]::In.ReadToEnd()
if ([string]::IsNullOrEmpty($payload)) { exit 0 }

try {
  Invoke-RestMethod -Method Post -Uri $Url `
    -Headers @{ Authorization = "Bearer $Token" } `
    -ContentType 'application/json' `
    -Body $payload `
    -TimeoutSec 10 | Out-Null
  exit 0
} catch {
  try {
    $spool = Join-Path $env:USERPROFILE '.agentic-os\pending-sessions'
    New-Item -ItemType Directory -Force -Path $spool | Out-Null
    $name = '{0}-{1}.json' -f (Get-Date).ToUniversalTime().ToString('yyyyMMddTHHmmssfff'), $PID
    # UTF8Encoding($false) = UTF-8 without BOM ([IO.File]::WriteAllText's
    # default is NOT reliably BOM-free on .NET Framework).
    [IO.File]::WriteAllText((Join-Path $spool $name), $payload, (New-Object System.Text.UTF8Encoding($false)))
  } catch {
    # Spooling itself failed -- still never break the user's session.
  }
  exit 0
}
