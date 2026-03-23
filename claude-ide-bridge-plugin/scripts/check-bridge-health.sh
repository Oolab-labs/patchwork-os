#!/bin/bash
# SubagentStart hook: Verify bridge is healthy before IDE-dependent subagents run
#
# Input: JSON on stdin with agent metadata including agent_id and agent_type
#        (agent_id and agent_type added in Claude Code 2.1.69)
# Output: Exit 0 if healthy, exit 2 with message if bridge is down

set -euo pipefail

INPUT=$(cat)
AGENT_ID=$(echo "$INPUT" | jq -r '.agent_id // ""' 2>/dev/null)
AGENT_TYPE=$(echo "$INPUT" | jq -r '.agent_type // ""' 2>/dev/null)
AGENT_NAME=$(echo "$INPUT" | jq -r '.agent_name // ""' 2>/dev/null)

# Find the bridge lock file
LOCK_DIR="${CLAUDE_CONFIG_DIR:-$HOME/.claude}/ide"
LOCK_FILE=$(ls "$LOCK_DIR"/*.lock 2>/dev/null | head -1)

if [ -z "$LOCK_FILE" ]; then
  LABEL="${AGENT_TYPE:-subagent}${AGENT_NAME:+ ($AGENT_NAME)}"
  echo "IDE Bridge is not running. Start it before using IDE subagents (${LABEL})." >&2
  exit 2
fi

PORT=$(basename "$LOCK_FILE" .lock)

# Check bridge is ready (includes extensionConnected + toolCount)
READY=$(curl -sf --max-time 3 "http://127.0.0.1:$PORT/ready" 2>/dev/null)
if [ $? -ne 0 ]; then
  LABEL="${AGENT_TYPE:-subagent}${AGENT_NAME:+ ($AGENT_NAME)}"
  echo "IDE Bridge on port $PORT is not responding. Restart it before using IDE subagents (${LABEL})." >&2
  exit 2
fi

EXTENSION=$(echo "$READY" | jq -r '.extensionConnected // false')
if [ "$EXTENSION" = "false" ]; then
  LABEL="${AGENT_TYPE:-subagent}${AGENT_NAME:+ ($AGENT_NAME)}"
  echo "IDE Bridge is running but the VS Code extension is not connected (port $PORT). LSP and debugger tools will fail for ${LABEL}. Open VS Code to reconnect." >&2
  # Exit 0 — let the subagent proceed; it can still use non-extension tools
fi

exit 0
