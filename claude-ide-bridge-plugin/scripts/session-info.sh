#!/bin/bash
# SessionStart hook: Report bridge status at session start
#
# Input: JSON on stdin with session metadata.
#        rate_limits field (added Claude Code 2.1.80): 5-hour and 7-day usage
#        windows with percentage consumed.
# Output: JSON on stdout with bridge status message

INPUT=$(cat)

# Extract rate limit info (added Claude Code 2.1.80)
RATE_5H=$(echo "$INPUT" | jq -r '.rate_limits.["5hour"].percentUsed // ""' 2>/dev/null)
RATE_7D=$(echo "$INPUT" | jq -r '.rate_limits.["7day"].percentUsed // ""' 2>/dev/null)

# Build rate limit suffix (only shown when above 50% to avoid noise)
RATE_SUFFIX=""
if [ -n "$RATE_5H" ] && [ "$RATE_5H" != "null" ]; then
  PCT_5H=$(echo "$RATE_5H" | awk '{printf "%d", $1 * 100}')
  if [ "$PCT_5H" -ge 50 ] 2>/dev/null; then
    RATE_SUFFIX=" | 5h quota: ${PCT_5H}%"
  fi
fi
if [ -n "$RATE_7D" ] && [ "$RATE_7D" != "null" ]; then
  PCT_7D=$(echo "$RATE_7D" | awk '{printf "%d", $1 * 100}')
  if [ "$PCT_7D" -ge 80 ] 2>/dev/null; then
    RATE_SUFFIX="${RATE_SUFFIX} | 7d quota: ${PCT_7D}%"
  fi
fi

# Find the bridge lock file
LOCK_DIR="${CLAUDE_CONFIG_DIR:-$HOME/.claude}/ide"
LOCK_FILE=$(ls "$LOCK_DIR"/*.lock 2>/dev/null | head -1)

if [ -z "$LOCK_FILE" ]; then
  jq -n --arg rate "$RATE_SUFFIX" '{
    hookSpecificOutput: {
      hookEventName: "SessionStart",
      message: ("IDE Bridge: No bridge instance detected. Start the bridge with `npm start` or `npm run start-all` to enable IDE tools." + $rate)
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
  jq -n --arg port "$PORT" --arg rate "$RATE_SUFFIX" '{
    hookSpecificOutput: {
      hookEventName: "SessionStart",
      message: ("IDE Bridge: Lock file found on port " + $port + " but bridge is not responding. It may have crashed." + $rate)
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
  --arg rate "$RATE_SUFFIX" \
  '{
    hookSpecificOutput: {
      hookEventName: "SessionStart",
      message: ("IDE Bridge: Connected on port " + $port + " | IDE: " + $ide + " | Extension: " + $ext + " | Tools: " + $tools + " | Workspace: " + $ws + $rate)
    }
  }'
