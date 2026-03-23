#!/bin/bash
# TaskCompleted hook: Log task completion and check bridge health.
#
# Fires when a background Task (Agent tool call) completes. Uses the
# last_assistant_message field (added in Claude Code 2.1.47) to surface
# a brief summary of what the agent did, and checks bridge health so the
# parent agent knows IDE tools are still available for follow-up work.
#
# Input:  JSON on stdin — { agent_id, agent_type, agent_name,
#                           last_assistant_message, task_id, ... }
# Output: JSON on stdout — hookSpecificOutput (informational)

set -euo pipefail

INPUT=$(cat)
AGENT_NAME=$(echo "$INPUT" | jq -r '.agent_name // ""' 2>/dev/null)
AGENT_TYPE=$(echo "$INPUT" | jq -r '.agent_type // ""' 2>/dev/null)
LAST_MSG=$(echo "$INPUT" | jq -r '.last_assistant_message // ""' 2>/dev/null)

LABEL="${AGENT_NAME:-${AGENT_TYPE:-task}}"

# Truncate the last message to a reasonable summary length
if [ ${#LAST_MSG} -gt 200 ]; then
  LAST_MSG="${LAST_MSG:0:197}..."
fi

LOCK_DIR="${CLAUDE_CONFIG_DIR:-$HOME/.claude}/ide"
LOCK_FILE=$(ls "$LOCK_DIR"/*.lock 2>/dev/null | head -1)

if [ -z "$LOCK_FILE" ]; then
  # Still report completion even without bridge
  jq -n \
    --arg label "$LABEL" \
    --arg msg "$LAST_MSG" \
    '{
      hookSpecificOutput: {
        hookEventName: "TaskCompleted",
        message: ("Task " + $label + " completed." + (if $msg != "" then " Summary: " + $msg else "" end))
      }
    }'
  exit 0
fi

PORT=$(basename "$LOCK_FILE" .lock)

READY=$(curl -sf --max-time 2 "http://127.0.0.1:$PORT/ready" 2>/dev/null)
BRIDGE_OK=$?

if [ $BRIDGE_OK -ne 0 ]; then
  jq -n \
    --arg label "$LABEL" \
    --arg msg "$LAST_MSG" \
    --arg port "$PORT" \
    '{
      hookSpecificOutput: {
        hookEventName: "TaskCompleted",
        message: ("Task " + $label + " completed." + (if $msg != "" then " Summary: " + $msg else "" end) + " WARNING: Bridge on port " + $port + " is not responding — IDE tools may be unavailable.")
      }
    }'
  exit 0
fi

EXTENSION=$(echo "$READY" | jq -r '.extensionConnected // false')
TOOL_COUNT=$(echo "$READY" | jq -r '.toolCount // "unknown"')

jq -n \
  --arg label "$LABEL" \
  --arg msg "$LAST_MSG" \
  --arg port "$PORT" \
  --arg ext "$EXTENSION" \
  --arg tools "$TOOL_COUNT" \
  '{
    hookSpecificOutput: {
      hookEventName: "TaskCompleted",
      message: ("Task " + $label + " completed." + (if $msg != "" then " Summary: " + $msg else "" end) + " Bridge ready — port " + $port + " | " + $tools + " tools | extension: " + $ext)
    }
  }'
