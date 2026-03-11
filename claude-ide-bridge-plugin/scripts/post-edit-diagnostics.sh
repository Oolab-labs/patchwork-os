#!/bin/bash
# PostToolUse hook: Surface diagnostics after file edits
# Runs after Edit or Write tool calls to check for new errors
#
# Input: JSON on stdin with tool_input containing file_path
# Output: JSON on stdout with a message for Claude about new diagnostics

INPUT=$(cat)
FILE_PATH=$(echo "$INPUT" | jq -r '.tool_input.file_path // .tool_input.filePath // empty')

if [ -z "$FILE_PATH" ]; then
  exit 0
fi

# Find the bridge lock file to get the port
LOCK_DIR="${CLAUDE_CONFIG_DIR:-$HOME/.claude}/ide"
LOCK_FILE=$(ls "$LOCK_DIR"/*.lock 2>/dev/null | head -1)

if [ -z "$LOCK_FILE" ]; then
  exit 0
fi

PORT=$(basename "$LOCK_FILE" .lock)
AUTH_TOKEN=$(jq -r '.authToken' "$LOCK_FILE" 2>/dev/null)

if [ -z "$AUTH_TOKEN" ]; then
  exit 0
fi

# Check bridge health
HEALTH=$(curl -sf "http://127.0.0.1:$PORT/health" 2>/dev/null)
if [ $? -ne 0 ]; then
  exit 0
fi

# Output a message telling Claude to check diagnostics for the edited file
jq -n --arg file "$FILE_PATH" '{
  hookSpecificOutput: {
    hookEventName: "PostToolUse",
    message: ("File edited: " + $file + ". Consider running getDiagnostics to check for new errors.")
  }
}'
