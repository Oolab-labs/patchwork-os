#!/usr/bin/env bash
# Full orchestrator for bridge + claude + remote-control.
# Manages all three in tmux panes with health monitoring.
#
# Usage:
#   ./scripts/start-all.sh [--workspace <path>] [--notify <ntfy-topic>]
#   npm run start-all -- --workspace /path/to/project
#
# Controls:
#   Ctrl+C in any pane — stops that process only
#   Ctrl+B, D          — detach (everything keeps running)
#   tmux kill-session -t claude-all — stop everything

set -uo pipefail

SESSION="claude-all"
SCRIPT_PATH="$(cd "$(dirname "$0")" && pwd)/$(basename "$0")"
BRIDGE_DIR="$(cd "$(dirname "$0")/.." && pwd)"
WORKSPACE="."
NTFY_TOPIC=""
BRIDGE_READY_TIMEOUT=30

# --- Parse args ---
while [[ $# -gt 0 ]]; do
  case "$1" in
    --workspace) WORKSPACE="$2"; shift 2 ;;
    --notify)    NTFY_TOPIC="$2"; shift 2 ;;
    *)           echo "Unknown option: $1" >&2; exit 1 ;;
  esac
done
WORKSPACE="$(cd "$WORKSPACE" && pwd)" || { echo "Error: workspace directory not found" >&2; exit 1; }

# --- Dependency checks ---
command -v tmux >/dev/null 2>&1 || {
  echo "Error: tmux is required. Install with: brew install tmux" >&2
  exit 1
}
command -v claude >/dev/null 2>&1 || {
  echo "Error: claude CLI not found on PATH." >&2
  exit 1
}
command -v node >/dev/null 2>&1 || {
  echo "Error: node is required." >&2
  exit 1
}

# --- tmux session management ---
if [[ -z "${TMUX:-}" ]]; then
  if tmux has-session -t "$SESSION" 2>/dev/null; then
    echo "Session '$SESSION' already running. Attaching..."
    exec tmux attach -t "$SESSION"
  fi
  # Create session detached, re-run this script inside it, then attach
  tmux new-session -d -s "$SESSION" -x 200 -y 50
  tmux send-keys -t "$SESSION" "\"$SCRIPT_PATH\" --workspace \"$WORKSPACE\"$([ -n "$NTFY_TOPIC" ] && echo " --notify \"$NTFY_TOPIC\"")" Enter
  exec tmux attach -t "$SESSION"
fi

# --- We're inside tmux now (running in pane 0) ---
echo "=== Claude IDE Bridge Full Orchestrator ==="
echo "  Ctrl+C in any pane — stops that process"
echo "  Ctrl+B, D — detach (keeps running)"
echo "  tmux kill-session -t $SESSION — stop everything"
[[ -n "$NTFY_TOPIC" ]] && echo "  Push notifications: ntfy.sh/$NTFY_TOPIC"
echo ""

# Detect caffeinate (macOS-only)
caffeinate_cmd=""
command -v caffeinate >/dev/null 2>&1 && caffeinate_cmd="caffeinate -i"

# --- Notification helper (with 60s cooldown for non-critical notifications) ---
LAST_NOTIFY_TIME=0
NOTIFY_COOLDOWN=60

notify() {
  local msg="$1"
  local priority="${2:-default}"
  echo "[$(date '+%H:%M:%S')] $msg"
  if [[ -n "$NTFY_TOPIC" ]]; then
    local now
    now=$(date +%s)
    # Skip cooldown for high-priority notifications
    if [[ "$priority" != "high" ]] && (( now - LAST_NOTIFY_TIME < NOTIFY_COOLDOWN )); then
      return
    fi
    LAST_NOTIFY_TIME=$now
    curl -s --max-time 10 --connect-timeout 5 \
      -H "Title: Claude IDE Bridge" -H "Priority: $priority" \
      -d "$msg" "https://ntfy.sh/$NTFY_TOPIC" >/dev/null 2>&1 &
  fi
}

# --- Reusable command strings ---
BRIDGE_CMD="cd \"$BRIDGE_DIR\" && npx tsx src/index.ts --workspace \"$WORKSPACE\""
CLAUDE_CMD="cd \"$WORKSPACE\" && unset CLAUDECODE && CLAUDE_CODE_IDE_SKIP_VALID_CHECK=true claude"

# Export for subshell access
export NTFY_TOPIC

REMOTE_CMD="cd \"$WORKSPACE\" && $caffeinate_cmd bash -c '
delay=5; max_delay=300; failures=0
while true; do
  start=\$(date +%s)
  claude remote-control
  code=\$?
  elapsed=\$(( \$(date +%s) - start ))
  [ \$code -eq 130 ] && { echo \"Exited by Ctrl+C.\"; exit 0; }
  if [ \$elapsed -ge 60 ]; then failures=0; delay=5
  else
    failures=\$((failures+1))
    delay=\$((5 * (2 ** (failures>6?6:failures-1))))
    [ \$delay -gt \$max_delay ] && delay=\$max_delay
  fi
  if [ \$failures -ge 50 ]; then
    echo \"Too many failures. Giving up.\"
    if [ -n \"\$NTFY_TOPIC\" ]; then
      curl -s --max-time 10 --connect-timeout 5 -H \"Title: Claude Remote\" -H \"Priority: high\" \
        -d \"Circuit breaker: too many failures. Giving up.\" \"https://ntfy.sh/\$NTFY_TOPIC\" >/dev/null 2>&1 &
    fi
    exit 1
  fi
  echo \"[\$(date +%H:%M:%S)] Disconnected (exit \$code). Restarting in \${delay}s...\"
  if [ -n \"\$NTFY_TOPIC\" ]; then
    curl -s --max-time 10 --connect-timeout 5 -H \"Title: Claude Remote\" \
      -d \"Disconnected (exit \$code). Restarting in \${delay}s...\" \"https://ntfy.sh/\$NTFY_TOPIC\" >/dev/null 2>&1 &
  fi
  sleep \$delay
done'"

# --- Create 3 additional panes (pane 0 = orchestrator, 1 = bridge, 2 = claude, 3 = remote) ---
tmux split-window -v -t "$SESSION"    # pane 1 for bridge
tmux split-window -v -t "$SESSION"    # pane 2 for claude
tmux split-window -v -t "$SESSION"    # pane 3 for remote-control
tmux select-layout -t "$SESSION" even-vertical

# --- Helper: wait for a NEW lock file (ignores pre-existing ones) ---
wait_for_new_lock() {
  local existing_locks="$1"
  local timeout="$2"
  local new_lock=""
  for _ in $(seq 1 "$timeout"); do
    # Find lock files that weren't in the pre-existing set
    while IFS= read -r lock; do
      if [[ -n "$lock" ]] && ! echo "$existing_locks" | grep -qF "$lock"; then
        new_lock="$lock"
        break 2
      fi
    done < <(ls -t ~/.claude/ide/*.lock 2>/dev/null)
    sleep 1
  done
  echo "$new_lock"
}

# Snapshot existing lock files before starting bridge
EXISTING_LOCKS=$(ls ~/.claude/ide/*.lock 2>/dev/null | sort)

# Pane 1: Bridge
tmux send-keys -t "${SESSION}:0.1" "$BRIDGE_CMD" Enter

# Wait for bridge readiness by detecting a NEW lock file
echo "Waiting for bridge to start..."
LOCK_FILE=$(wait_for_new_lock "$EXISTING_LOCKS" "$BRIDGE_READY_TIMEOUT")

if [[ -z "$LOCK_FILE" ]]; then
  notify "Bridge failed to start within ${BRIDGE_READY_TIMEOUT}s" "high"
  echo "Check pane 1 for errors."
  # Don't exit — keep orchestrator running so user can debug
  echo "Press Ctrl+C to exit orchestrator."
  sleep infinity
fi
notify "Bridge started (lock: $(basename "$LOCK_FILE"))"

# Pane 2: Claude CLI with session ID for resume support
# Workspace-specific UUID file (hash workspace path to avoid collisions)
WS_HASH=$(echo -n "$WORKSPACE" | shasum -a 256 | cut -c1-12)
mkdir -p "$HOME/.claude"
SESSION_UUID_FILE="$HOME/.claude/claude-all-session-${WS_HASH}"
if command -v uuidgen >/dev/null 2>&1; then
  SESSION_UUID=$(uuidgen | tr '[:upper:]' '[:lower:]')
elif [[ -f /proc/sys/kernel/random/uuid ]]; then
  SESSION_UUID=$(cat /proc/sys/kernel/random/uuid)
else
  SESSION_UUID=$(python3 -c "import uuid; print(uuid.uuid4())" 2>/dev/null || date +%s%N | sha256sum | head -c 32)
fi
echo "$SESSION_UUID" > "$SESSION_UUID_FILE"

tmux send-keys -t "${SESSION}:0.2" "$CLAUDE_CMD --session-id $SESSION_UUID" Enter

# Give claude a moment to start, then launch remote-control
sleep 3

# Pane 3: Remote control with auto-restart loop
tmux send-keys -t "${SESSION}:0.3" "$REMOTE_CMD" Enter

# --- Health monitor (runs in pane 0 — the orchestrator pane) ---
echo ""
echo "Health monitor active. Watching: $(basename "$LOCK_FILE")"
echo "---"

# Clean up child panes on exit — send SIGINT, wait, then escalate to kill-pane
cleanup() {
  echo ""
  echo "Orchestrator shutting down..."
  tmux send-keys -t "${SESSION}:0.1" C-c 2>/dev/null
  tmux send-keys -t "${SESSION}:0.2" C-c 2>/dev/null
  tmux send-keys -t "${SESSION}:0.3" C-c 2>/dev/null
  # Wait up to 5s for panes to exit gracefully, then force-kill
  for _ in $(seq 1 5); do
    sleep 1
    all_idle=true
    for pane in 1 2 3; do
      cmd=$(tmux display-message -t "${SESSION}:0.${pane}" -p '#{pane_current_command}' 2>/dev/null || echo "")
      [[ "$cmd" != "bash" && "$cmd" != "zsh" && -n "$cmd" ]] && { all_idle=false; break; }
    done
    $all_idle && break
  done
  # Force-kill any remaining panes
  for pane in 1 2 3; do
    tmux send-keys -t "${SESSION}:0.${pane}" "" 2>/dev/null || true
  done
}
trap cleanup EXIT

while true; do
  sleep 10
  if [[ ! -f "$LOCK_FILE" ]]; then
    notify "Bridge died! Restarting all processes..." "high"
    # Send Ctrl+C to all process panes (including bridge in case it's still alive)
    tmux send-keys -t "${SESSION}:0.1" C-c
    tmux send-keys -t "${SESSION}:0.2" C-c
    tmux send-keys -t "${SESSION}:0.3" C-c
    # Wait for processes to actually stop
    for _ in $(seq 1 10); do
      pane2_cmd=$(tmux display-message -t "${SESSION}:0.2" -p '#{pane_current_command}' 2>/dev/null || echo "")
      [[ "$pane2_cmd" == "bash" || "$pane2_cmd" == "zsh" || -z "$pane2_cmd" ]] && break
      sleep 1
    done

    # Give bridge time to exit after Ctrl+C
    sleep 2

    # Snapshot locks again before restarting bridge
    EXISTING_LOCKS=$(ls ~/.claude/ide/*.lock 2>/dev/null | sort)

    # Restart bridge in pane 1
    tmux send-keys -t "${SESSION}:0.1" "$BRIDGE_CMD" Enter

    # Wait for new lock file
    LOCK_FILE=$(wait_for_new_lock "$EXISTING_LOCKS" "$BRIDGE_READY_TIMEOUT")
    if [[ -z "$LOCK_FILE" ]]; then
      notify "Bridge failed to restart!" "high"
      continue
    fi

    echo "Health monitor now watching: $(basename "$LOCK_FILE")"

    # Restart claude with --resume to pick up same session
    tmux send-keys -t "${SESSION}:0.2" "$CLAUDE_CMD --resume $SESSION_UUID" Enter
    sleep 3
    # Restart remote-control
    tmux send-keys -t "${SESSION}:0.3" "$REMOTE_CMD" Enter
    notify "All processes restarted"
  fi
done
