#!/bin/bash
# Elicitation hook: Pre-answer "which file?" questions using the active editor.
#
# When Claude wants to ask the user a question (elicitation/create), this hook
# inspects the request schema. If any field looks like it wants a file path
# (field name contains "file", "path", or "uri"), it pre-fills that field with
# the currently active editor's path from the bridge — avoiding the question
# entirely when the answer is already obvious from the user's context.
#
# Input: JSON on stdin — the elicitation request (title, message, requestedSchema)
# Output:
#   - JSON with hookSpecificOutput containing the pre-filled answer, OR
#   - Empty output (exit 0) to let Claude ask the question normally

set -euo pipefail

INPUT=$(cat)

# Find bridge lock file
LOCK_DIR="${CLAUDE_CONFIG_DIR:-$HOME/.claude}/ide"
LOCK_FILE=$(ls "$LOCK_DIR"/*.lock 2>/dev/null | head -1)

if [ -z "$LOCK_FILE" ]; then
  exit 0  # No bridge — let Claude ask normally
fi

PORT=$(basename "$LOCK_FILE" .lock)
AUTH_TOKEN=$(jq -r '.authToken // ""' "$LOCK_FILE" 2>/dev/null)

if [ -z "$AUTH_TOKEN" ]; then
  exit 0
fi

# Check if the elicitation schema has a file-like field
SCHEMA=$(echo "$INPUT" | jq -r '.requestedSchema // {}' 2>/dev/null)
FILE_FIELD=$(echo "$SCHEMA" | jq -r '
  .properties // {} |
  to_entries[] |
  select(.key | test("file|path|uri"; "i")) |
  .key
' 2>/dev/null | head -1)

if [ -z "$FILE_FIELD" ]; then
  exit 0  # No file-like field — let Claude ask normally
fi

# Query the bridge for the active editor
CONTEXT=$(curl -sf --max-time 2 \
  -H "Authorization: Bearer $AUTH_TOKEN" \
  "http://127.0.0.1:$PORT/health" 2>/dev/null)

ACTIVE_FILE=$(echo "$CONTEXT" | jq -r '.activeFile // ""' 2>/dev/null)

if [ -z "$ACTIVE_FILE" ] || [ "$ACTIVE_FILE" = "null" ]; then
  exit 0  # No active file — let Claude ask normally
fi

# Return the pre-filled answer
jq -n \
  --arg field "$FILE_FIELD" \
  --arg value "$ACTIVE_FILE" \
  '{
    hookSpecificOutput: {
      hookEventName: "Elicitation",
      preFilledFields: { ($field): $value },
      message: ("Pre-filling \($field) with active editor: \($value)")
    }
  }'
