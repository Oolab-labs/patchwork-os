#!/bin/bash
# ConfigChange hook: Detect config file changes that affect the bridge.
#
# Fires when Claude Code detects a change to settings files during a session
# (added in Claude Code 2.1.49). Checks whether the changed file is related
# to the bridge (MCP config, permissions) and warns if the bridge may need
# to be reconnected or restarted for the change to take effect.
#
# Input:  JSON on stdin — { config_path, config_type, ... }
# Output: JSON on stdout — hookSpecificOutput (warning if bridge-relevant),
#         or exit 0 if the change is not bridge-related

set -euo pipefail

INPUT=$(cat)
CONFIG_PATH=$(echo "$INPUT" | jq -r '.config_path // ""' 2>/dev/null)
CONFIG_TYPE=$(echo "$INPUT" | jq -r '.config_type // ""' 2>/dev/null)

if [ -z "$CONFIG_PATH" ]; then
  exit 0
fi

# Check if this is a bridge-relevant config file
IS_BRIDGE_RELEVANT=false
REASON=""

case "$CONFIG_PATH" in
  */.mcp.json|*/mcp.json)
    IS_BRIDGE_RELEVANT=true
    REASON="MCP server configuration changed — bridge MCP connection may need reconnect (/mcp reconnect)"
    ;;
  */.claude/settings.json|*/.claude/settings.local.json)
    IS_BRIDGE_RELEVANT=true
    REASON="Claude settings changed — permissions or bridge hooks may have been updated"
    ;;
  */claude_desktop_config.json)
    IS_BRIDGE_RELEVANT=true
    REASON="Claude Desktop config changed — restart Claude Desktop for bridge MCP changes to take effect"
    ;;
esac

if [ "$IS_BRIDGE_RELEVANT" = "false" ]; then
  exit 0
fi

LOCK_DIR="${CLAUDE_CONFIG_DIR:-$HOME/.claude}/ide"
LOCK_FILE=$(ls "$LOCK_DIR"/*.lock 2>/dev/null | head -1)

BRIDGE_STATUS="Bridge not running"
if [ -n "$LOCK_FILE" ]; then
  PORT=$(basename "$LOCK_FILE" .lock)
  READY=$(curl -sf --max-time 2 "http://127.0.0.1:$PORT/ready" 2>/dev/null)
  if [ $? -eq 0 ]; then
    BRIDGE_STATUS="Bridge running on port $PORT"
  else
    BRIDGE_STATUS="Bridge lock found on port $PORT but not responding"
  fi
fi

jq -n \
  --arg path "$CONFIG_PATH" \
  --arg reason "$REASON" \
  --arg bridge "$BRIDGE_STATUS" \
  '{
    hookSpecificOutput: {
      hookEventName: "ConfigChange",
      message: ("Config changed: " + $path + ". " + $reason + ". Status: " + $bridge)
    }
  }'
