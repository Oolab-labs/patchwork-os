#!/usr/bin/env bash
# Patchwork PreToolUse approval hook.
#
# Claude Code invokes this before every tool call. The hook POSTs the pending
# call to the bridge /approvals endpoint, blocks until the dashboard decides,
# then exits 0 (allow) or 2 (block) so CC honours the decision.
#
# Install: add to ~/.claude/settings.json under hooks.PreToolUse:
#   {
#     "matcher": "*",
#     "hooks": [{ "type": "command", "command": "patchwork-approval-hook" }]
#   }
#
# Environment:
#   TOOL_NAME       — CC-provided tool name (Claude Code injects)
#   TOOL_SPECIFIER  — CC-provided specifier (Bash command, Read path, etc.)
#   TOOL_PARAMS     — CC-provided JSON-encoded params
#
# Bridge discovery:
#   1. PATCHWORK_BRIDGE_PORT env var
#   2. Newest ~/.claude/ide/*.lock file with isBridge:true

set -euo pipefail

LOCK_DIR="${CLAUDE_CONFIG_DIR:-$HOME/.claude}/ide"
TOOL_NAME="${TOOL_NAME:-${1:-}}"
TOOL_SPECIFIER="${TOOL_SPECIFIER:-${2:-}}"
TOOL_PARAMS="${TOOL_PARAMS:-{}}"

if [[ -z "$TOOL_NAME" ]]; then
  # No tool name provided — allow to avoid blocking CC startup.
  exit 0
fi

# Find bridge port + token.
port="${PATCHWORK_BRIDGE_PORT:-}"
token=""
if [[ -n "$port" && -f "$LOCK_DIR/$port.lock" ]]; then
  token=$(python3 -c "import json,sys; print(json.load(open('$LOCK_DIR/$port.lock')).get('authToken',''))" 2>/dev/null || true)
elif [[ -d "$LOCK_DIR" ]]; then
  newest=$(ls -t "$LOCK_DIR"/*.lock 2>/dev/null | head -1 || true)
  if [[ -n "$newest" ]]; then
    port=$(basename "$newest" .lock)
    token=$(python3 -c "import json,sys; d=json.load(open('$newest')); print(d.get('authToken','') if d.get('isBridge') else '')" 2>/dev/null || true)
  fi
fi

if [[ -z "$port" || -z "$token" ]]; then
  # No bridge running — allow by default so CC keeps working offline.
  exit 0
fi

# POST and wait. 5-minute timeout matches ApprovalQueue TTL.
body=$(python3 -c "
import json,os
print(json.dumps({
  'toolName': os.environ.get('TOOL_NAME',''),
  'specifier': os.environ.get('TOOL_SPECIFIER',''),
  'params': json.loads(os.environ.get('TOOL_PARAMS','{}') or '{}'),
  'summary': os.environ.get('TOOL_SUMMARY',''),
}))
")

response=$(curl -sS --max-time 310 \
  -H "Authorization: Bearer $token" \
  -H "Content-Type: application/json" \
  -X POST \
  -d "$body" \
  "http://127.0.0.1:$port/approvals" 2>/dev/null || echo '{"decision":"allow","reason":"bridge_unreachable"}')

decision=$(python3 -c "import json,sys; print(json.loads('''$response''').get('decision','allow'))" 2>/dev/null || echo "allow")

if [[ "$decision" == "deny" ]]; then
  echo "Patchwork: approval denied for $TOOL_NAME" >&2
  exit 2
fi
exit 0
