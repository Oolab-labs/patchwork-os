#!/bin/bash
# PostCompact hook: Re-inject bridge status after Claude compacts context.
#
# After compaction Claude loses the injected IDE state from session start.
# This hook fires immediately after compaction completes and re-reports the
# current bridge status so Claude has fresh context without waiting for the
# next InstructionsLoaded event.
#
# Input: JSON on stdin with compaction metadata
# Output: JSON on stdout with bridge status message

LOCK_DIR="${CLAUDE_CONFIG_DIR:-$HOME/.claude}/ide"
LOCK_FILE=$(ls "$LOCK_DIR"/*.lock 2>/dev/null | head -1)

if [ -z "$LOCK_FILE" ]; then
  # No bridge — nothing useful to inject
  exit 0
fi

PORT=$(basename "$LOCK_FILE" .lock)
WORKSPACE=$(jq -r '.workspace // "unknown"' "$LOCK_FILE" 2>/dev/null)
IDE_NAME=$(jq -r '.ideName // "External"' "$LOCK_FILE" 2>/dev/null)

READY=$(curl -sf --max-time 2 "http://127.0.0.1:$PORT/ready" 2>/dev/null)
if [ $? -ne 0 ]; then
  # Bridge not responding — don't inject stale info
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
      hookEventName: "PostCompact",
      message: ("IDE Bridge context restored after compaction — port " + $port + " | " + $tools + " tools | Extension: " + $ext + " | IDE: " + $ide + " | Workspace: " + $ws)
    }
  }'
