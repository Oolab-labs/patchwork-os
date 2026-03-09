#!/usr/bin/env bash
# Auto-restart wrapper for claude remote-control.
# Prevents macOS idle sleep, auto-restarts on disconnect, runs in tmux.
#
# Usage:
#   ./scripts/start-remote.sh [--notify <ntfy-topic>]
#   npm run remote
#
# Controls:
#   Ctrl+C        — exit cleanly (no restart)
#   Ctrl+B, D     — detach tmux (keeps running)
#   tmux attach -t claude-remote  — reattach

set -uo pipefail

SESSION_NAME="claude-remote"
NTFY_TOPIC=""

# --- Parse args ---
while [[ $# -gt 0 ]]; do
  case "$1" in
    --notify) NTFY_TOPIC="$2"; shift 2 ;;
    *)        echo "Unknown option: $1" >&2; exit 1 ;;
  esac
done

# --- Dependency checks ---
command -v tmux >/dev/null 2>&1 || {
  echo "Error: tmux is required. Install with: brew install tmux" >&2
  exit 1
}
command -v claude >/dev/null 2>&1 || {
  echo "Error: claude CLI not found on PATH." >&2
  exit 1
}

# --- tmux session management ---
# If not already inside tmux, create or attach to session
if [[ -z "${TMUX:-}" ]]; then
  exec tmux new-session -As "$SESSION_NAME" "$0 $([ -n "$NTFY_TOPIC" ] && echo "--notify $NTFY_TOPIC")"
fi

echo "=== Remote Control auto-restart wrapper ==="
echo "  Ctrl+C to exit cleanly"
echo "  Ctrl+B, D to detach (keeps running)"
echo "  tmux attach -t $SESSION_NAME to reattach"
[[ -n "$NTFY_TOPIC" ]] && echo "  Push notifications: ntfy.sh/$NTFY_TOPIC"
echo ""

# --- Auto-restart loop with exponential backoff ---
# Use export so the subshell can access variables without quote-splicing
export RESTART_BASE_DELAY=5
export RESTART_MAX_DELAY=300
export MAX_CONSECUTIVE_FAILURES=50
export HEALTHY_RUNTIME=60
export NTFY_TOPIC

# Detect caffeinate (macOS-only; skip on Linux)
CAFFEINATE=""
if command -v caffeinate >/dev/null 2>&1; then
  CAFFEINATE="caffeinate -i"
fi

# SIGTERM handler: forward signal to child process group
cleanup() {
  echo ""
  echo "Received termination signal. Shutting down..."
  kill -- -$$ 2>/dev/null
  exit 0
}
trap cleanup TERM HUP

$CAFFEINATE bash -c '
  delay=$RESTART_BASE_DELAY
  consecutive_failures=0

  while true; do
    start_time=$(date +%s)
    claude remote-control
    exit_code=$?
    elapsed=$(( $(date +%s) - start_time ))

    # Ctrl+C (SIGINT) — exit cleanly
    if [ $exit_code -eq 130 ]; then
      echo ""
      echo "Exited by user (Ctrl+C)."
      exit 0
    fi

    # Reset backoff if the process ran for a healthy duration
    if [ "$elapsed" -ge "$HEALTHY_RUNTIME" ]; then
      consecutive_failures=0
      delay=$RESTART_BASE_DELAY
    else
      consecutive_failures=$((consecutive_failures + 1))
      delay=$(( RESTART_BASE_DELAY * (2 ** (consecutive_failures > 6 ? 6 : consecutive_failures - 1)) ))
      [ "$delay" -gt "$RESTART_MAX_DELAY" ] && delay=$RESTART_MAX_DELAY
    fi

    # Circuit breaker: stop after too many rapid failures
    if [ "$consecutive_failures" -ge "$MAX_CONSECUTIVE_FAILURES" ]; then
      echo ""
      echo "Too many consecutive failures ($MAX_CONSECUTIVE_FAILURES). Giving up."
      echo "Check that \"claude remote-control\" works on its own, then retry."
      if [ -n "$NTFY_TOPIC" ]; then
        curl -s --max-time 10 --connect-timeout 5 \
          -H "Title: Claude Remote" -H "Priority: high" \
          -d "Circuit breaker: too many failures ($MAX_CONSECUTIVE_FAILURES). Giving up." \
          "https://ntfy.sh/$NTFY_TOPIC" >/dev/null 2>&1 &
      fi
      exit 1
    fi

    echo ""
    echo "[$(date "+%H:%M:%S")] Remote control disconnected (exit $exit_code). Restarting in ${delay}s..."

    # Send ntfy notification on disconnect
    if [ -n "$NTFY_TOPIC" ]; then
      curl -s --max-time 10 --connect-timeout 5 \
        -H "Title: Claude Remote" -d "Disconnected (exit $exit_code). Restarting in ${delay}s..." \
        "https://ntfy.sh/$NTFY_TOPIC" >/dev/null 2>&1 &
    fi

    sleep "$delay"
  done
'
