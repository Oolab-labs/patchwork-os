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

# ADR-0016: this gate fails CLOSED. If the bridge is unreachable (not running,
# or the /approvals POST errors/times out) the hook DENIES the tool call by
# default — an attacker who can crash or partition the bridge must not thereby
# disable the approval gate. Set PATCHWORK_APPROVAL_FAIL_OPEN=1 to restore the
# legacy allow-on-unreachable behavior (e.g. for offline/dev use where the
# hook is installed but no bridge is expected to be running).
PATCHWORK_APPROVAL_FAIL_OPEN="${PATCHWORK_APPROVAL_FAIL_OPEN:-0}"

# Emit a structured CC deny + exit 2. $1 = human-readable reason.
emit_deny() {
  export PATCHWORK_DENY_REASON="${1:-patchwork rejected}"
  python3 - <<'PY' 2>/dev/null || true
import json, os
print(json.dumps({
    "hookSpecificOutput": {
        "hookEventName": "PreToolUse",
        "permissionDecision": "deny",
        "permissionDecisionReason": os.environ.get("PATCHWORK_DENY_REASON", "patchwork rejected"),
    }
}))
PY
  echo "Patchwork: $1" >&2
  exit 2
}

# Bridge unreachable handler. $1 = short reason token (e.g. "no_bridge").
# Fails closed unless PATCHWORK_APPROVAL_FAIL_OPEN is set truthy.
handle_unreachable() {
  if [[ "$PATCHWORK_APPROVAL_FAIL_OPEN" == "1" || "$PATCHWORK_APPROVAL_FAIL_OPEN" == "true" ]]; then
    echo "Patchwork: bridge unreachable ($1) — PATCHWORK_APPROVAL_FAIL_OPEN set, allowing" >&2
    exit 0
  fi
  emit_deny "approval bridge unreachable ($1) — failing closed (set PATCHWORK_APPROVAL_FAIL_OPEN=1 to override)"
}

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

# Modes where we defer entirely to CC's own permission layer:
#   bypassPermissions = gates explicitly disabled.
#   auto             = CC classifier handles escalation; our queue would block.
# plan mode is NOT skipped here — we forward to the bridge which short-circuits
# per tool (reads → allow, writes → deny) without queuing.
if [[ "$permission_mode" == "bypassPermissions" || "$permission_mode" == "auto" ]]; then
  exit 0
fi

# MCP tools are already gated by CC's allow list. Routing them through the
# bridge approval queue is circular (especially bridge introspection tools)
# and adds latency with no security benefit.
if [[ "$tool_name" == mcp__* ]]; then
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

# No bridge running → fail closed (ADR-0016). Override with
# PATCHWORK_APPROVAL_FAIL_OPEN=1 for offline/dev use.
if [[ -z "$port" || -z "$token" ]]; then
  handle_unreachable "no_bridge"
fi

# Build request body. Fields are passed through env to python to avoid
# shell-quoting pitfalls.
export PATCHWORK_TOOL_NAME="$tool_name"
export PATCHWORK_TOOL_INPUT="$tool_input"
export PATCHWORK_PERMISSION_MODE="$permission_mode"
export PATCHWORK_SESSION_ID="$session_id"

request_body=$(python3 - <<'PY'
import json, os

tool = os.environ.get("PATCHWORK_TOOL_NAME", "")
try:
    params = json.loads(os.environ.get("PATCHWORK_TOOL_INPUT", "") or "{}")
    if not isinstance(params, dict):
        params = {"value": params}
except Exception:
    params = {}

# Derive specifier so evaluateRules can apply Bash(npm run *) / WebFetch(url) rules.
specifier = ""
if tool == "Bash":
    specifier = params.get("command", "")
elif tool in ("WebFetch", "WebSearch"):
    specifier = params.get("url", "")
elif tool in ("Read", "Edit", "Write"):
    specifier = params.get("file_path", "") or params.get("path", "")

print(json.dumps({
    "toolName": tool,
    "specifier": specifier,
    "params": params,
    "summary": "",
    "permissionMode": os.environ.get("PATCHWORK_PERMISSION_MODE", ""),
    "sessionId": os.environ.get("PATCHWORK_SESSION_ID", ""),
}))
PY
)

# 5-minute timeout matches ApprovalQueue TTL.
# ADR-0016: a curl transport failure (bridge crashed mid-request, timeout,
# connection refused) is treated as unreachable → fail closed, NOT allow.
if ! response=$(curl -sS --max-time 310 \
  -H "Authorization: Bearer $token" \
  -H "Content-Type: application/json" \
  -X POST \
  -d "$request_body" \
  "http://127.0.0.1:$port/approvals" 2>/dev/null); then
  handle_unreachable "request_failed"
fi
# Empty body with a clean exit is also a degenerate/unreachable response.
if [[ -z "$response" ]]; then
  handle_unreachable "empty_response"
fi

# Parse decision via env — never interpolate $response into python -c.
# ADR-0016: an unparseable / non-JSON response is a degenerate bridge reply
# (partial write, proxy error page) → treated as unreachable, fail closed.
export PATCHWORK_HOOK_RESPONSE="$response"
decision_reason=$(python3 - <<'PY' 2>/dev/null || true
import json, os
try:
    d = json.loads(os.environ.get("PATCHWORK_HOOK_RESPONSE", "") or "{}")
    if not isinstance(d, dict):
        raise ValueError("not an object")
except Exception:
    print("__parse_error__")
    print("")
else:
    print(d.get("decision", "allow"))
    print(d.get("reason", ""))
PY
)
decision=$(sed -n '1p' <<<"$decision_reason")
reason=$(sed -n '2p' <<<"$decision_reason")

if [[ "$decision" == "__parse_error__" || -z "$decision" ]]; then
  handle_unreachable "bad_response"
fi

if [[ "$decision" == "deny" ]]; then
  emit_deny "approval denied for $tool_name${reason:+ ($reason)}"
fi

# Allow path: exit 0 silently. CC defaults to allow on clean exit.
exit 0
