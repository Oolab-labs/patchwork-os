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
IDE_NAME=""
BRIDGE_READY_TIMEOUT=30
LAST_CLAUDE_RESTART=0

# --- Parse args ---
while [[ $# -gt 0 ]]; do
  case "$1" in
    --workspace) WORKSPACE="$2"; shift 2 ;;
    --notify)    NTFY_TOPIC="$2"; shift 2 ;;
    --ide)       IDE_NAME="$2"; shift 2 ;;
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
  tmux send-keys -t "$SESSION" "\"$SCRIPT_PATH\" --workspace \"$WORKSPACE\"$([ -n "$NTFY_TOPIC" ] && echo " --notify \"$NTFY_TOPIC\"")$([ -n "$IDE_NAME" ] && echo " --ide \"$IDE_NAME\"")" Enter
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
BRIDGE_IDE_FLAGS=""
if [[ -n "$IDE_NAME" ]]; then
  _ide_lower="$(echo "$IDE_NAME" | tr '[:upper:]' '[:lower:]')"
  BRIDGE_IDE_FLAGS="--ide-name $(printf '%q' "$IDE_NAME") --editor $(printf '%q' "$_ide_lower")"
fi
# Use compiled dist when src/ is absent (npm install), tsx during local development
if [[ -f "$BRIDGE_DIR/src/index.ts" ]]; then
  BRIDGE_BIN="npx tsx src/index.ts"
else
  BRIDGE_BIN="node dist/index.js"
fi
BRIDGE_CMD="cd $(printf '%q' "$BRIDGE_DIR") && $BRIDGE_BIN --workspace $(printf '%q' "$WORKSPACE")${BRIDGE_IDE_FLAGS:+ $BRIDGE_IDE_FLAGS}"
CLAUDE_CMD="cd $(printf '%q' "$WORKSPACE") && unset CLAUDECODE && CLAUDE_CODE_IDE_SKIP_VALID_CHECK=true claude --ide"

# Export for subshell access
export NTFY_TOPIC

REMOTE_CMD="cd $(printf '%q' "$WORKSPACE") && unset CLAUDECODE && $caffeinate_cmd bash -c '
delay=1; max_delay=300; failures=0
while true; do
  start=\$(date +%s)
  claude remote-control
  code=\$?
  elapsed=\$(( \$(date +%s) - start ))
  [ \$code -eq 130 ] && { echo \"Exited by Ctrl+C.\"; exit 0; }
  if [ \$elapsed -ge 60 ]; then failures=0; delay=1
  else
    failures=\$((failures+1))
    exp=\$((failures>6?6:failures-1)); p=1; for _ in \$(seq 1 \$exp); do p=\$((p*2)); done; delay=\$((5*p))
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
        # Validate: readable JSON with a running PID (path passed as argv to avoid injection)
        lock_pid=$(python3 -c "import json,sys; d=json.load(open(sys.argv[1])); print(d.get('pid',''))" -- "$lock" 2>/dev/null || true)
        if [[ -n "$lock_pid" ]] && kill -0 "$lock_pid" 2>/dev/null; then
          new_lock="$lock"
          break 2
        fi
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

# Prune stale lock files so --ide finds exactly one valid IDE (the one we just started).
# A lock is stale if its PID is dead. Paths passed as argv to avoid shell injection.
for stale in ~/.claude/ide/*.lock; do
  [[ -f "$stale" ]] || continue
  [[ "$stale" == "$LOCK_FILE" ]] && continue
  stale_pid=$(python3 -c "import json,sys; d=json.load(open(sys.argv[1])); print(d.get('pid',''))" -- "$stale" 2>/dev/null || true)
  if [[ -z "$stale_pid" ]] || ! kill -0 "$stale_pid" 2>/dev/null; then
    rm -f "$stale"
    echo "Removed stale lock: $(basename "$stale")"
  fi
done

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
    tmux send-keys -t "${SESSION}:0.${pane}" C-c 2>/dev/null || true
  done
  sleep 1
  for pane in 3 2 1; do
    tmux kill-pane -t "${SESSION}:0.${pane}" 2>/dev/null || true
  done
}
trap cleanup EXIT

while true; do
  sleep 10
  if [[ ! -f "$LOCK_FILE" ]]; then
    notify "Bridge died! Restarting all processes..." "high"
    # Kill any stale caffeinate processes before restart to prevent accumulation
    pkill -f "caffeinate -i" 2>/dev/null || true
    # Send Ctrl+C to all process panes (including bridge in case it's still alive)
    tmux send-keys -t "${SESSION}:0.1" C-c
    tmux send-keys -t "${SESSION}:0.2" C-c
    tmux send-keys -t "${SESSION}:0.3" C-c
    # Wait for bridge (pane 1) and claude (pane 2) to actually stop
    for _ in $(seq 1 10); do
      pane1_cmd=$(tmux display-message -t "${SESSION}:0.1" -p '#{pane_current_command}' 2>/dev/null || echo "")
      pane2_cmd=$(tmux display-message -t "${SESSION}:0.2" -p '#{pane_current_command}' 2>/dev/null || echo "")
      pane1_idle=false; pane2_idle=false
      [[ "$pane1_cmd" == "bash" || "$pane1_cmd" == "zsh" || -z "$pane1_cmd" ]] && pane1_idle=true
      [[ "$pane2_cmd" == "bash" || "$pane2_cmd" == "zsh" || -z "$pane2_cmd" ]] && pane2_idle=true
      $pane1_idle && $pane2_idle && break
      sleep 1
    done

    # Verify old bridge process is truly dead using the lock file PID before it disappears
    if [[ -f "$LOCK_FILE" ]]; then
      old_pid=$(python3 -c "import json,sys; d=json.load(open(sys.argv[1])); print(d.get('pid',''))" -- "$LOCK_FILE" 2>/dev/null || echo "")
      if [[ -n "$old_pid" ]]; then
        for _ in $(seq 1 10); do
          kill -0 "$old_pid" 2>/dev/null || break
          sleep 1
        done
      fi
    fi

    # Give bridge time to clean up lock file after exiting
    sleep 2

    # Snapshot locks again before restarting bridge
    EXISTING_LOCKS=$(ls ~/.claude/ide/*.lock 2>/dev/null | sort)

    # Restart bridge in pane 1
    tmux send-keys -t "${SESSION}:0.1" "$BRIDGE_CMD" Enter

    # Wait for new lock file (don't update LOCK_FILE on failure to avoid
    # empty-string bug where [[ ! -f "" ]] is always true → infinite restart loop)
    NEW_LOCK=$(wait_for_new_lock "$EXISTING_LOCKS" "$BRIDGE_READY_TIMEOUT")
    if [[ -z "$NEW_LOCK" ]]; then
      notify "Bridge failed to restart!" "high"
      continue
    fi
    LOCK_FILE="$NEW_LOCK"

    echo "Health monitor now watching: $(basename "$LOCK_FILE")"

    # Restart claude with --resume to pick up same session
    tmux send-keys -t "${SESSION}:0.2" "$CLAUDE_CMD --resume $SESSION_UUID" Enter
    sleep 3
    # Restart remote-control
    tmux send-keys -t "${SESSION}:0.3" "$REMOTE_CMD" Enter
    notify "All processes restarted"
  else
    # Bridge is alive — check if Claude CLI (pane 2) has exited
    pane2_cmd=$(tmux display-message -t "${SESSION}:0.2" -p '#{pane_current_command}' 2>/dev/null || echo "")
    if [[ "$pane2_cmd" == "bash" || "$pane2_cmd" == "zsh" || -z "$pane2_cmd" ]]; then
      # Verify bridge is actually healthy before restarting just the CLI
      BRIDGE_PORT=$(basename "$LOCK_FILE" .lock)
      if curl -sf --max-time 5 "http://127.0.0.1:${BRIDGE_PORT}/health" >/dev/null 2>&1; then
        # Cooldown: don't restart more than once per 30s
        now=$(date +%s)
        if [[ $(( now - LAST_CLAUDE_RESTART )) -ge 30 ]]; then
          LAST_CLAUDE_RESTART=$now
          echo "[$(date +%H:%M:%S)] Claude CLI died. Restarting with --resume..."
          notify "Claude CLI died. Restarting with --resume..."
          tmux send-keys -t "${SESSION}:0.2" "$CLAUDE_CMD --resume $SESSION_UUID" Enter
        fi
      fi
    fi
  fi
done
