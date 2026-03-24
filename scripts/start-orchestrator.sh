#!/usr/bin/env bash
# Orchestrator launcher: starts the meta-bridge that coordinates multiple IDE windows.
#
# Use this instead of start-all.sh when you have several IDE windows open simultaneously
# and want Claude to be able to work across all of them.  Each IDE window must already
# have the claude-ide-bridge extension running — this script connects to them all.
#
# Pane layout:
#   0 — health monitor (this script)
#   1 — orchestrator bridge  (port 4746 by default)
#   2 — claude --ide         (connects to the orchestrator, sees all workspaces)
#
# Usage:
#   ./scripts/start-orchestrator.sh [--port N] [--notify <ntfy-topic>]
#   npm run start-orchestrator
#
# Options:
#   --port <N>        Orchestrator port (default: 4746)
#   --notify <topic>  Push notifications via ntfy.sh
#   --verbose         Enable verbose orchestrator logging

set -uo pipefail

trap 'echo "[monitor] Caught signal, stopping..."; tmux kill-session -t "${SESSION:-claude-orch}" 2>/dev/null; exit 0' SIGINT SIGTERM

SESSION="claude-orch"
SCRIPT_PATH="$(cd "$(dirname "$0")" && pwd)/$(basename "$0")"
BRIDGE_DIR="$(cd "$(dirname "$0")/.." && pwd)"
ORCH_PORT=4746
NTFY_TOPIC=""
VERBOSE_FLAG=""
ORCH_READY_TIMEOUT="${ORCH_READY_TIMEOUT:-20}"

# --- Parse args ---
while [[ $# -gt 0 ]]; do
  case "$1" in
    --port)    ORCH_PORT="$2"; shift 2 ;;
    --notify)  NTFY_TOPIC="$2"; shift 2 ;;
    --verbose) VERBOSE_FLAG="--verbose"; shift ;;
    *)         echo "Unknown option: $1" >&2; exit 1 ;;
  esac
done

# --- Dependency checks ---
command -v tmux >/dev/null 2>&1 || { echo "Error: tmux is required (brew install tmux)" >&2; exit 1; }
command -v claude >/dev/null 2>&1 || { echo "Error: claude CLI not found on PATH" >&2; exit 1; }
command -v node >/dev/null 2>&1 || { echo "Error: node is required" >&2; exit 1; }

# --- tmux session management ---
if [[ -z "${TMUX:-}" ]]; then
  if tmux has-session -t "$SESSION" 2>/dev/null; then
    echo "Session '$SESSION' already running. Attaching..."
    exec tmux attach -t "$SESSION"
  fi
  tmux new-session -d -s "$SESSION" -x 200 -y 50
  tmux send-keys -t "$SESSION" \
    "\"$SCRIPT_PATH\" --port \"$ORCH_PORT\"$([ -n "$NTFY_TOPIC" ] && echo " --notify \"$NTFY_TOPIC\"")$([ -n "$VERBOSE_FLAG" ] && echo " --verbose")" \
    Enter
  exec tmux attach -t "$SESSION"
fi

# --- Inside tmux ---
echo "=== Claude IDE Bridge Orchestrator ==="
echo "  Port: $ORCH_PORT"
echo "  Ctrl+C in any pane — stops that process"
echo "  Ctrl+B then D — detach (keeps running)"
echo "  tmux kill-session -t $SESSION — stop everything"
[[ -n "$NTFY_TOPIC" ]] && echo "  Push notifications: ntfy.sh/$NTFY_TOPIC"
echo ""

# Use compiled dist when src/ is absent (npm install), tsx during local dev
if [[ -f "$BRIDGE_DIR/src/index.ts" ]]; then
  BRIDGE_BIN="npx tsx src/index.ts"
else
  BRIDGE_BIN="node dist/index.js"
fi

ORCH_CMD="cd $(printf '%q' "$BRIDGE_DIR") && $BRIDGE_BIN orchestrator --port $ORCH_PORT${VERBOSE_FLAG:+ $VERBOSE_FLAG}"
CLAUDE_CMD="unset CLAUDECODE && CLAUDE_CODE_IDE_SKIP_VALID_CHECK=true claude --ide"

export NTFY_TOPIC

# --- Notification helper ---
LAST_NOTIFY_TIME=0
NOTIFY_COOLDOWN=60

notify() {
  local msg="$1"
  local priority="${2:-default}"
  echo "[$(date '+%H:%M:%S')] $msg"
  if [[ -n "$NTFY_TOPIC" ]]; then
    local now; now=$(date +%s)
    if [[ "$priority" != "high" ]] && (( now - LAST_NOTIFY_TIME < NOTIFY_COOLDOWN )); then
      return
    fi
    LAST_NOTIFY_TIME=$now
    curl -s --max-time 10 --connect-timeout 5 \
      -H "Title: Claude IDE Orchestrator" -H "Priority: $priority" \
      -d "$msg" "https://ntfy.sh/$NTFY_TOPIC" >/dev/null 2>&1 &
  fi
}

# --- Wait for orchestrator to be ready (polls /ping) ---
wait_for_orchestrator() {
  local port="$1"
  local timeout="$2"
  for _ in $(seq 1 "$timeout"); do
    if curl -sf --max-time 2 "http://127.0.0.1:${port}/ping" >/dev/null 2>&1; then
      return 0
    fi
    sleep 1
  done
  return 1
}

# --- Create panes ---
tmux split-window -v -t "$SESSION"   # pane 1: orchestrator
tmux split-window -v -t "$SESSION"   # pane 2: claude
tmux select-layout -t "$SESSION" even-vertical

# Pane 1: Orchestrator
tmux send-keys -t "${SESSION}:0.1" "$ORCH_CMD" Enter

echo "Waiting for orchestrator to start on port $ORCH_PORT..."
if ! wait_for_orchestrator "$ORCH_PORT" "$ORCH_READY_TIMEOUT"; then
  notify "Orchestrator failed to start within ${ORCH_READY_TIMEOUT}s" "high"
  echo "Check pane 1 for errors. Press Ctrl+C to exit."
  while true; do sleep 60; done
fi
notify "Orchestrator ready on port $ORCH_PORT"

# Pane 2: Claude connected to orchestrator
tmux send-keys -t "${SESSION}:0.2" "$CLAUDE_CMD" Enter

# --- Cleanup on exit ---
cleanup() {
  echo ""
  echo "Shutting down..."
  tmux send-keys -t "${SESSION}:0.1" C-c 2>/dev/null
  tmux send-keys -t "${SESSION}:0.2" C-c 2>/dev/null
  sleep 2
  tmux kill-pane -t "${SESSION}:0.2" 2>/dev/null || true
  tmux kill-pane -t "${SESSION}:0.1" 2>/dev/null || true
}
trap cleanup EXIT

# --- Health monitor ---
echo ""
echo "Health monitor active. Watching orchestrator on port $ORCH_PORT"
echo "---"

LAST_CLAUDE_RESTART=0

while true; do
  sleep 10

  if ! curl -sf --max-time 3 "http://127.0.0.1:${ORCH_PORT}/ping" >/dev/null 2>&1; then
    notify "Orchestrator on port $ORCH_PORT unreachable — restarting..." "high"

    tmux send-keys -t "${SESSION}:0.1" C-c
    tmux send-keys -t "${SESSION}:0.2" C-c
    sleep 3

    tmux send-keys -t "${SESSION}:0.1" "$ORCH_CMD" Enter

    if ! wait_for_orchestrator "$ORCH_PORT" "$ORCH_READY_TIMEOUT"; then
      notify "Orchestrator failed to restart!" "high"
      continue
    fi
    notify "Orchestrator restarted"

    tmux send-keys -t "${SESSION}:0.2" "$CLAUDE_CMD" Enter
  else
    # Orchestrator healthy — check if Claude exited
    pane2_cmd=$(tmux display-message -t "${SESSION}:0.2" -p '#{pane_current_command}' 2>/dev/null || echo "")
    if [[ "$pane2_cmd" == "bash" || "$pane2_cmd" == "zsh" || -z "$pane2_cmd" ]]; then
      now=$(date +%s)
      if (( now - LAST_CLAUDE_RESTART >= 30 )); then
        LAST_CLAUDE_RESTART=$now
        echo "[$(date '+%H:%M:%S')] Claude exited. Restarting..."
        notify "Claude exited. Restarting..."
        tmux send-keys -t "${SESSION}:0.2" "$CLAUDE_CMD" Enter
      fi
    fi
  fi
done
