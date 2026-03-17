#!/bin/bash
# PreToolUse hook: Normalize bridge tool arguments before execution.
#
# Uses the `updatedInput` return field to fix common tool-call mistakes:
#
#   1. Relative file paths → absolute paths
#      Many bridge tools accept a `path`, `filePath`, or `uri` argument.
#      Claude sometimes passes relative paths (e.g. "src/bridge.ts") when
#      the tool expects an absolute path. This hook resolves them against
#      the bridge's workspace root so the tool call succeeds without the
#      user having to correct it.
#
#   2. Missing workspace for multi-root workspace tools
#      If the bridge has a single workspace root and the tool has no path
#      at all, adds a `workspace` hint so the tool has context.
#
# Input:  JSON on stdin — { tool_name, tool_input }
# Output: JSON on stdout — { updatedInput: { ...patchedArgs } }
#         or empty (exit 0) to leave args unchanged.

set -euo pipefail

INPUT=$(cat)
TOOL_NAME=$(echo "$INPUT" | jq -r '.tool_name // empty')

# Only handle bridge MCP tools (they use camelCase names starting with known verbs)
# Skip built-in Claude Code tools (Edit, Write, Bash, Read, Glob, Grep, etc.)
BUILTIN_TOOLS="Edit|Write|Bash|Read|Glob|Grep|WebFetch|WebSearch|NotebookEdit|TodoWrite|Agent|Task"
if echo "$TOOL_NAME" | grep -qE "^($BUILTIN_TOOLS)$"; then
  exit 0
fi

# Find bridge lock file for workspace root
LOCK_DIR="${CLAUDE_CONFIG_DIR:-$HOME/.claude}/ide"
LOCK_FILE=$(ls "$LOCK_DIR"/*.lock 2>/dev/null | head -1)

if [ -z "$LOCK_FILE" ]; then
  exit 0  # No bridge running — nothing to patch
fi

WORKSPACE=$(jq -r '.workspace // ""' "$LOCK_FILE" 2>/dev/null)
if [ -z "$WORKSPACE" ] || [ "$WORKSPACE" = "null" ]; then
  exit 0
fi

TOOL_INPUT=$(echo "$INPUT" | jq -r '.tool_input // {}')

# Identify which path field(s) the tool input contains
# Bridge tools use: path, filePath, uri, file, targetPath, sourcePath
PATH_FIELDS=$(echo "$TOOL_INPUT" | jq -r '
  to_entries[] |
  select(.key | test("^(path|filePath|uri|file|targetPath|sourcePath)$")) |
  select(.value | type == "string") |
  select(.value | startswith("/") | not) |  # relative paths only
  select(.value | length > 0) |
  .key
' 2>/dev/null)

if [ -z "$PATH_FIELDS" ]; then
  exit 0  # No relative path fields — nothing to patch
fi

# Build the updatedInput patch: resolve each relative path to absolute
PATCH=$(echo "$TOOL_INPUT" | jq --arg ws "$WORKSPACE" '
  . as $input |
  reduce (to_entries[] | select(
    (.key | test("^(path|filePath|uri|file|targetPath|sourcePath)$")) and
    (.value | type == "string") and
    (.value | startswith("/") | not) and
    (.value | length > 0)
  )) as $entry (
    $input;
    .[$entry.key] = ($ws + "/" + $entry.value)
  )
' 2>/dev/null)

if [ -z "$PATCH" ] || [ "$PATCH" = "$TOOL_INPUT" ]; then
  exit 0  # No changes
fi

jq -n --argjson updated "$PATCH" '{
  updatedInput: $updated
}'
