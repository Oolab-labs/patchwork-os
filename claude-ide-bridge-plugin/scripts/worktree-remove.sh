#!/bin/bash
# WorktreeRemove hook: Clean up bridge context when a worktree is removed.
#
# Fires when Claude Code removes a git worktree that was created via
# `isolation: worktree` on a subagent. Informs Claude that IDE state tied
# to the worktree (open files, diagnostics) may now be stale.
#
# Input:  JSON on stdin — { worktree_path, branch }
# Output: JSON on stdout — hookSpecificOutput (informational)

set -euo pipefail

INPUT=$(cat)
WORKTREE_PATH=$(echo "$INPUT" | jq -r '.worktree_path // empty')
BRANCH=$(echo "$INPUT" | jq -r '.branch // ""')

if [ -z "$WORKTREE_PATH" ]; then
  exit 0
fi

LOCK_DIR="${CLAUDE_CONFIG_DIR:-$HOME/.claude}/ide"
LOCK_FILE=$(ls "$LOCK_DIR"/*.lock 2>/dev/null | head -1)

if [ -z "$LOCK_FILE" ]; then
  exit 0  # No bridge running — nothing to report
fi

PORT=$(basename "$LOCK_FILE" .lock)
WORKSPACE=$(jq -r '.workspace // ""' "$LOCK_FILE" 2>/dev/null)

# Check if the removed worktree was inside the bridge's workspace
SAME_REPO=false
if [ -n "$WORKSPACE" ] && [ "$WORKSPACE" != "null" ]; then
  BRIDGE_GIT_ROOT=$(git -C "$WORKSPACE" rev-parse --show-toplevel 2>/dev/null || echo "")
  # Worktree dir is gone by this point — compare against stored branch/path info
  if [ -n "$BRIDGE_GIT_ROOT" ] && echo "$WORKTREE_PATH" | grep -q "$BRIDGE_GIT_ROOT"; then
    SAME_REPO=true
  fi
fi

if [ "$SAME_REPO" = "true" ]; then
  jq -n --arg wt "$WORKTREE_PATH" --arg branch "$BRANCH" --arg port "$PORT" '{
    hookSpecificOutput: {
      hookEventName: "WorktreeRemove",
      message: ("Worktree removed: " + $wt + (if $branch != "" then " (branch: " + $branch + ")" else "" end) + ". Bridge on port " + $port + " is still running. Any open files or diagnostics from the worktree are now stale — VS Code may show phantom errors for the removed paths.")
    }
  }'
else
  jq -n --arg wt "$WORKTREE_PATH" '{
    hookSpecificOutput: {
      hookEventName: "WorktreeRemove",
      message: ("Worktree removed: " + $wt + ". Bridge was not tracking this worktree.")
    }
  }'
fi
