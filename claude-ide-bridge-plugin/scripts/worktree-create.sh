#!/bin/bash
# WorktreeCreate hook: Inject bridge workspace context when a worktree is created.
#
# Fires when Claude Code creates a new git worktree (via `isolation: worktree`
# on a subagent). Reports which bridge workspace maps to the new worktree so
# the subagent knows which bridge instance (if any) covers its working directory.
#
# Input:  JSON on stdin — { worktree_path, branch }
# Output: JSON on stdout — hookSpecificOutput with bridge mapping info

set -euo pipefail

INPUT=$(cat)
WORKTREE_PATH=$(echo "$INPUT" | jq -r '.worktree_path // empty')

if [ -z "$WORKTREE_PATH" ]; then
  exit 0
fi

LOCK_DIR="${CLAUDE_CONFIG_DIR:-$HOME/.claude}/ide"
LOCK_FILE=$(ls "$LOCK_DIR"/*.lock 2>/dev/null | head -1)

if [ -z "$LOCK_FILE" ]; then
  jq -n --arg wt "$WORKTREE_PATH" '{
    hookSpecificOutput: {
      hookEventName: "WorktreeCreate",
      message: ("Worktree created at " + $wt + ". No bridge is running — IDE tools (LSP, debugger, diagnostics) will not be available in the worktree. The worktree agent can still use file, git, and terminal tools.")
    }
  }'
  exit 0
fi

PORT=$(basename "$LOCK_FILE" .lock)
WORKSPACE=$(jq -r '.workspace // ""' "$LOCK_FILE" 2>/dev/null)

# Check if the worktree is inside the bridge's workspace
SAME_REPO=false
if [ -n "$WORKSPACE" ] && [ "$WORKSPACE" != "null" ]; then
  # Both should share the same git root
  BRIDGE_GIT_ROOT=$(git -C "$WORKSPACE" rev-parse --show-toplevel 2>/dev/null || echo "")
  WORKTREE_GIT_ROOT=$(git -C "$WORKTREE_PATH" rev-parse --show-toplevel 2>/dev/null || echo "")
  if [ -n "$BRIDGE_GIT_ROOT" ] && [ "$BRIDGE_GIT_ROOT" = "$WORKTREE_GIT_ROOT" ]; then
    SAME_REPO=true
  fi
fi

if [ "$SAME_REPO" = "true" ]; then
  jq -n --arg wt "$WORKTREE_PATH" --arg port "$PORT" --arg ws "$WORKSPACE" '{
    hookSpecificOutput: {
      hookEventName: "WorktreeCreate",
      message: ("Worktree created at " + $wt + ". Bridge on port " + $port + " covers the same repo (workspace: " + $ws + "). IMPORTANT: The worktree agent shares the bridge with the main session. File edits in the worktree are isolated (different branch) but the bridge extension reflects whichever file VS Code has open — coordinate with the main session to avoid diagnostic/LSP confusion. Prefer read-only IDE tools (getDiagnostics, getHover, findReferences) in worktree agents.")
    }
  }'
else
  jq -n --arg wt "$WORKTREE_PATH" --arg port "$PORT" '{
    hookSpecificOutput: {
      hookEventName: "WorktreeCreate",
      message: ("Worktree created at " + $wt + ". Bridge on port " + $port + " covers a different workspace — IDE extension tools are not scoped to this worktree. Use file, git, and terminal tools for worktree edits.")
    }
  }'
fi
