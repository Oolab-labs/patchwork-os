#!/bin/bash
# TeammateIdle hook: Notify when a team agent goes idle.
#
# Fires in multi-agent (Agent Teams) sessions when a teammate agent finishes
# its current task and is waiting for more work. Reports bridge health so
# the leader agent knows IDE tools are available for follow-up coordination.
#
# Input:  JSON on stdin — { agent_id, agent_type, agent_name, ... }
# Output: JSON on stdout — hookSpecificOutput (informational), or exit 0

set -euo pipefail

INPUT=$(cat)
AGENT_ID=$(echo "$INPUT" | jq -r '.agent_id // ""' 2>/dev/null)
AGENT_NAME=$(echo "$INPUT" | jq -r '.agent_name // ""' 2>/dev/null)
AGENT_TYPE=$(echo "$INPUT" | jq -r '.agent_type // ""' 2>/dev/null)

LABEL="${AGENT_NAME:-${AGENT_TYPE:-${AGENT_ID:-teammate}}}"

LOCK_DIR="${CLAUDE_CONFIG_DIR:-$HOME/.claude}/ide"
LOCK_FILE=$(ls "$LOCK_DIR"/*.lock 2>/dev/null | head -1)

if [ -z "$LOCK_FILE" ]; then
  exit 0  # No bridge — nothing useful to report
fi

PORT=$(basename "$LOCK_FILE" .lock)

READY=$(curl -sf --max-time 2 "http://127.0.0.1:$PORT/ready" 2>/dev/null)
if [ $? -ne 0 ]; then
  exit 0  # Bridge not responding — skip
fi

EXTENSION=$(echo "$READY" | jq -r '.extensionConnected // false')
TOOL_COUNT=$(echo "$READY" | jq -r '.toolCount // "unknown"')

jq -n \
  --arg label "$LABEL" \
  --arg port "$PORT" \
  --arg ext "$EXTENSION" \
  --arg tools "$TOOL_COUNT" \
  '{
    hookSpecificOutput: {
      hookEventName: "TeammateIdle",
      message: ("Teammate " + $label + " is now idle. Bridge on port " + $port + " ready (" + $tools + " tools, extension: " + $ext + "). You can delegate another task or query IDE state.")
    }
  }'
