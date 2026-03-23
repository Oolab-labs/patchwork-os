#!/bin/bash
# StopFailure hook: Log API errors that ended the turn.
#
# Fires when a turn ends due to an API error (rate limit, auth failure, etc.)
# rather than normal completion. Checks bridge health so the user knows
# whether the bridge itself is still operational, and logs the error type
# for diagnostics.
#
# Input: JSON on stdin — { error_type, error_message, ... }
# Output: JSON on stdout with hookSpecificOutput (informational only)
#         or empty (exit 0) if bridge is not running.

set -euo pipefail

INPUT=$(cat)
ERROR_TYPE=$(echo "$INPUT" | jq -r '.error_type // "unknown"' 2>/dev/null)
ERROR_MSG=$(echo "$INPUT" | jq -r '.error_message // ""' 2>/dev/null)

LOCK_DIR="${CLAUDE_CONFIG_DIR:-$HOME/.claude}/ide"
LOCK_FILE=$(ls "$LOCK_DIR"/*.lock 2>/dev/null | head -1)

if [ -z "$LOCK_FILE" ]; then
  exit 0
fi

PORT=$(basename "$LOCK_FILE" .lock)

# Check if bridge is still alive after the API failure
READY=$(curl -sf --max-time 2 "http://127.0.0.1:$PORT/ready" 2>/dev/null)
BRIDGE_OK=$?

if [ $BRIDGE_OK -ne 0 ]; then
  jq -n \
    --arg err "$ERROR_TYPE" \
    --arg port "$PORT" \
    '{
      hookSpecificOutput: {
        hookEventName: "StopFailure",
        message: ("Turn ended with API error (" + $err + "). IDE Bridge on port " + $port + " is also not responding — it may have restarted. Run `npm run start-all` if IDE tools are unavailable.")
      }
    }'
  exit 0
fi

# Bridge is fine — just report the error type so Claude has context
jq -n \
  --arg err "$ERROR_TYPE" \
  --arg msg "$ERROR_MSG" \
  '{
    hookSpecificOutput: {
      hookEventName: "StopFailure",
      message: ("Turn ended due to API error: " + $err + (if $msg != "" then " — " + $msg else "" end) + ". IDE Bridge is still running.")
    }
  }'
