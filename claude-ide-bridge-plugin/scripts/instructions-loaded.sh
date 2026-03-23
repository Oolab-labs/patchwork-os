#!/bin/bash
# InstructionsLoaded hook: Report live bridge status when CLAUDE.md is loaded.
#
# Fires every time CLAUDE.md is loaded (including after /clear), giving Claude
# an up-to-date view of bridge state at the exact moment it reads its instructions.
#
# Input: JSON on stdin with session metadata
# Output: JSON on stdout with bridge status message (or empty on failure)

LOCK_DIR="${CLAUDE_CONFIG_DIR:-$HOME/.claude}/ide"
LOCK_FILE=$(ls "$LOCK_DIR"/*.lock 2>/dev/null | head -1)

if [ -z "$LOCK_FILE" ]; then
  jq -n '{
    hookSpecificOutput: {
      hookEventName: "InstructionsLoaded",
      message: "IDE Bridge: Not running. Start with `npm run start-all` to enable IDE tools."
    }
  }'
  exit 0
fi

PORT=$(basename "$LOCK_FILE" .lock)
WORKSPACE=$(jq -r '.workspace // "unknown"' "$LOCK_FILE" 2>/dev/null)
IDE_NAME=$(jq -r '.ideName // "External"' "$LOCK_FILE" 2>/dev/null)

READY=$(curl -sf --max-time 2 "http://127.0.0.1:$PORT/ready" 2>/dev/null)
if [ $? -ne 0 ]; then
  jq -n --arg port "$PORT" '{
    hookSpecificOutput: {
      hookEventName: "InstructionsLoaded",
      message: ("IDE Bridge: Lock found on port " + $port + " but bridge is not responding.")
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
      hookEventName: "InstructionsLoaded",
      message: ("IDE Bridge ready — port " + $port + " | " + $tools + " tools | Extension: " + $ext + " | IDE: " + $ide + " | Workspace: " + $ws)
    }
  }'
