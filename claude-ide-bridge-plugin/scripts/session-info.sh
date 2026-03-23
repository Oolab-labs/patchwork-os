#!/bin/bash
# SessionStart hook: Report bridge status at session start
#
# Input: JSON on stdin with session metadata
# Output: JSON on stdout with bridge status message

# Find the bridge lock file
LOCK_DIR="${CLAUDE_CONFIG_DIR:-$HOME/.claude}/ide"
LOCK_FILE=$(ls "$LOCK_DIR"/*.lock 2>/dev/null | head -1)

if [ -z "$LOCK_FILE" ]; then
  jq -n '{
    hookSpecificOutput: {
      hookEventName: "SessionStart",
      message: "IDE Bridge: No bridge instance detected. Start the bridge with `npm start` or `npm run start-all` to enable IDE tools."
    }
  }'
  exit 0
fi

PORT=$(basename "$LOCK_FILE" .lock)
AUTH_TOKEN=$(jq -r '.authToken' "$LOCK_FILE" 2>/dev/null)
WORKSPACE=$(jq -r '.workspace // "unknown"' "$LOCK_FILE" 2>/dev/null)
IDE_NAME=$(jq -r '.ideName // "External"' "$LOCK_FILE" 2>/dev/null)

# Check bridge health and get tool count + extension status from /ready
READY=$(curl -sf "http://127.0.0.1:$PORT/ready" 2>/dev/null)
if [ $? -ne 0 ]; then
  jq -n --arg port "$PORT" '{
    hookSpecificOutput: {
      hookEventName: "SessionStart",
      message: ("IDE Bridge: Lock file found on port " + $port + " but bridge is not responding. It may have crashed.")
    }
  }'
  exit 0
fi

EXTENSION=$(echo "$READY" | jq -r '.extensionConnected // false')
TOOL_COUNT=$(echo "$READY" | jq -r '.toolCount // "unknown"')

jq -n \
  --arg port "$PORT" \
  --arg ws "$WORKSPACE" \
  --arg ide "$IDE_NAME" \
  --arg ext "$EXTENSION" \
  --arg tools "$TOOL_COUNT" \
  '{
    hookSpecificOutput: {
      hookEventName: "SessionStart",
      message: ("IDE Bridge: Connected on port " + $port + " | IDE: " + $ide + " | Extension: " + $ext + " | Tools: " + $tools + " | Workspace: " + $ws)
    }
  }'
