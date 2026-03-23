#!/bin/bash
# Stop hook: Log session end and surface the final response summary.
#
# Fires when the main agent's turn ends normally (not due to an API error —
# that's StopFailure). Uses the last_assistant_message field (added in
# Claude Code 2.1.47) to provide a brief summary of the final response.
# Useful for automated workflows that need to capture what Claude did.
#
# Input:  JSON on stdin — { last_assistant_message, stop_reason, ... }
# Output: exit 0 (no hookSpecificOutput needed for normal stop)
#         The hook is intentionally lightweight — just logs to stderr if
#         verbose mode is active via CLAUDE_CODE_VERBOSE.

set -euo pipefail

INPUT=$(cat)
LAST_MSG=$(echo "$INPUT" | jq -r '.last_assistant_message // ""' 2>/dev/null)
STOP_REASON=$(echo "$INPUT" | jq -r '.stop_reason // ""' 2>/dev/null)

# Only emit output if there's something worth surfacing
if [ -z "$LAST_MSG" ] && [ -z "$STOP_REASON" ]; then
  exit 0
fi

# Truncate for readability
if [ ${#LAST_MSG} -gt 300 ]; then
  LAST_MSG="${LAST_MSG:0:297}..."
fi

# Check bridge health on stop — useful for long-running sessions
LOCK_DIR="${CLAUDE_CONFIG_DIR:-$HOME/.claude}/ide"
LOCK_FILE=$(ls "$LOCK_DIR"/*.lock 2>/dev/null | head -1)

if [ -z "$LOCK_FILE" ]; then
  exit 0  # No bridge — don't emit noise
fi

PORT=$(basename "$LOCK_FILE" .lock)
READY=$(curl -sf --max-time 1 "http://127.0.0.1:$PORT/ready" 2>/dev/null)
if [ $? -ne 0 ]; then
  exit 0  # Bridge not responding — don't emit
fi

# Only emit if bridge is healthy (avoids noise on every stop)
# Emit as hookSpecificOutput so it's visible in transcript mode
if [ -n "$LAST_MSG" ]; then
  jq -n \
    --arg msg "$LAST_MSG" \
    --arg reason "$STOP_REASON" \
    '{
      hookSpecificOutput: {
        hookEventName: "Stop",
        message: ("Turn complete" + (if $reason != "" then " (" + $reason + ")" else "" end) + ". Final response: " + $msg)
      }
    }'
fi
