#!/bin/bash
# SubagentStart hook: Verify bridge is healthy before IDE-dependent subagents run
#
# Input: JSON on stdin with agent metadata
# Output: Exit 0 if healthy, exit 2 with message if bridge is down

# Find the bridge lock file
LOCK_DIR="${CLAUDE_CONFIG_DIR:-$HOME/.claude}/ide"
LOCK_FILE=$(ls "$LOCK_DIR"/*.lock 2>/dev/null | head -1)

if [ -z "$LOCK_FILE" ]; then
  echo "IDE Bridge is not running. Start it before using IDE subagents." >&2
  exit 2
fi

PORT=$(basename "$LOCK_FILE" .lock)

# Check bridge health
HEALTH=$(curl -sf "http://127.0.0.1:$PORT/health" 2>/dev/null)
if [ $? -ne 0 ]; then
  echo "IDE Bridge on port $PORT is not responding. Restart it before using IDE subagents." >&2
  exit 2
fi

exit 0
