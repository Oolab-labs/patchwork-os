#!/usr/bin/env bash
# Patchwork PreToolUse approval hook.
#
# Claude Code invokes this before every tool call with a JSON payload on stdin:
#   {
#     "session_id": "...",
#     "transcript_path": "...",
#     "cwd": "...",
#     "permission_mode": "default|acceptEdits|plan|auto|dontAsk|bypassPermissions",
#     "hook_event_name": "PreToolUse",
#     "tool_name": "Bash",
#     "tool_input": { ... tool-specific params ... },
#     "tool_use_id": "toolu_..."
#   }
#
# The hook POSTs the pending call to the bridge /approvals endpoint, blocks
# until the dashboard decides, then emits a hookSpecificOutput JSON on stdout
# (exit 0 for allow, exit 2 for deny — stderr reason shown to CC).
#
# Install: add to ~/.claude/settings.json under hooks.PreToolUse:
#   {
#     "matcher": "*",
#     "hooks": [{ "type": "command", "command": "patchwork-approval-hook" }]
#   }
#
# Bridge discovery:
#   1. PATCHWORK_BRIDGE_PORT env var (override)
#   2. Newest ~/.claude/ide/*.lock file with isBridge:true

set -euo pipefail

LOCK_DIR="${CLAUDE_CONFIG_DIR:-$HOME/.claude}/ide"

# Read the full stdin payload — CC always sends JSON here for PreToolUse.
# Fall back to env vars for backwards compat + manual invocation.
PATCHWORK_HOOK_PAYLOAD=""
if [[ ! -t 0 ]]; then
  PATCHWORK_HOOK_PAYLOAD=$(cat || true)
fi
export PATCHWORK_HOOK_PAYLOAD

if [[ -n "$PATCHWORK_HOOK_PAYLOAD" ]]; then
  # Extract 4 fields via python3. Payload is read from env, never interpolated
  # into the script — no injection surface.
  parsed=$(python3 - <<'PY' 2>/dev/null || true
import json, os, sys
try:
    d = json.loads(os.environ.get("PATCHWORK_HOOK_PAYLOAD", "") or "{}")
except Exception:
    d = {}
print(d.get("tool_name", ""))
print(d.get("permission_mode", ""))
# Re-serialize tool_input so we can round-trip it through a single string var.
print(json.dumps(d.get("tool_input", {}) or {}))
print(d.get("session_id", ""))
PY
)
  tool_name=$(sed -n '1p' <<<"$parsed")
  permission_mode=$(sed -n '2p' <<<"$parsed")
  tool_input=$(sed -n '3p' <<<"$parsed")
  session_id=$(sed -n '4p' <<<"$parsed")
else
  # Legacy / manual-invocation fallback.
  tool_name="${TOOL_NAME:-${1:-}}"
  permission_mode="${CLAUDE_PERMISSION_MODE:-}"
  tool_input="${TOOL_PARAMS:-{}}"
  session_id=""
fi

# No tool name → nothing to gate. Allow to avoid blocking CC startup / probes.
if [[ -z "$tool_name" ]]; then
  exit 0
fi

# bypassPermissions: CC has explicitly opted out of the permission layer.
# Fail open so our dashboard doesn't lie about what it's intercepting.
if [[ "$permission_mode" == "bypassPermissions" ]]; then
  exit 0
fi

# Find bridge port + token.
port="${PATCHWORK_BRIDGE_PORT:-}"
token=""
if [[ -n "$port" && -f "$LOCK_DIR/$port.lock" ]]; then
  token=$(python3 -c "import json; print(json.load(open('$LOCK_DIR/$port.lock')).get('authToken',''))" 2>/dev/null || true)
elif [[ -d "$LOCK_DIR" ]]; then
  newest=$(ls -t "$LOCK_DIR"/*.lock 2>/dev/null | head -1 || true)
  if [[ -n "$newest" ]]; then
    port=$(basename "$newest" .lock)
    token=$(python3 -c "import json; d=json.load(open('$newest')); print(d.get('authToken','') if d.get('isBridge') else '')" 2>/dev/null || true)
  fi
fi

# No bridge running → allow by default so CC keeps working offline.
if [[ -z "$port" || -z "$token" ]]; then
  exit 0
fi

# Build request body. Fields are passed through env to python to avoid
# shell-quoting pitfalls.
export PATCHWORK_TOOL_NAME="$tool_name"
export PATCHWORK_TOOL_INPUT="$tool_input"
export PATCHWORK_PERMISSION_MODE="$permission_mode"
export PATCHWORK_SESSION_ID="$session_id"

request_body=$(python3 - <<'PY'
import json, os
try:
    params = json.loads(os.environ.get("PATCHWORK_TOOL_INPUT", "") or "{}")
    if not isinstance(params, dict):
        params = {"value": params}
except Exception:
    params = {}
print(json.dumps({
    "toolName": os.environ.get("PATCHWORK_TOOL_NAME", ""),
    "specifier": "",
    "params": params,
    "summary": "",
    "permissionMode": os.environ.get("PATCHWORK_PERMISSION_MODE", ""),
    "sessionId": os.environ.get("PATCHWORK_SESSION_ID", ""),
}))
PY
)

# 5-minute timeout matches ApprovalQueue TTL.
response=$(curl -sS --max-time 310 \
  -H "Authorization: Bearer $token" \
  -H "Content-Type: application/json" \
  -X POST \
  -d "$request_body" \
  "http://127.0.0.1:$port/approvals" 2>/dev/null || echo '{"decision":"allow","reason":"bridge_unreachable"}')

# Parse decision via env — never interpolate $response into python -c.
export PATCHWORK_HOOK_RESPONSE="$response"
decision_reason=$(python3 - <<'PY' 2>/dev/null || true
import json, os
try:
    d = json.loads(os.environ.get("PATCHWORK_HOOK_RESPONSE", "") or "{}")
except Exception:
    d = {}
print(d.get("decision", "allow"))
print(d.get("reason", ""))
PY
)
decision=$(sed -n '1p' <<<"$decision_reason")
reason=$(sed -n '2p' <<<"$decision_reason")
decision="${decision:-allow}"

if [[ "$decision" == "deny" ]]; then
  # Emit structured output for modern CC; exit 2 for older versions.
  # Use python to embed the reason safely (handles quotes/special chars).
  export PATCHWORK_DENY_REASON="${reason:-patchwork rejected}"
  python3 - <<'PY'
import json, os
print(json.dumps({
    "hookSpecificOutput": {
        "hookEventName": "PreToolUse",
        "permissionDecision": "deny",
        "permissionDecisionReason": os.environ.get("PATCHWORK_DENY_REASON", "patchwork rejected"),
    }
}))
PY
  echo "Patchwork: approval denied for $tool_name${reason:+ ($reason)}" >&2
  exit 2
fi

# Allow path: exit 0 silently. CC defaults to allow on clean exit.
exit 0
