#!/usr/bin/env bash
# VPS startup script for claude-ide-bridge.
# Starts the bridge on a fixed port inside tmux, with optional ngrok tunnel.
#
# Usage:
#   bash scripts/start-vps.sh [--port 9000] [--token <fixed-token>] [--ngrok]
#   npm run vps
#
# Controls:
#   tmux attach -t bridge   — view bridge logs
#   tmux attach -t ngrok    — view ngrok status
#   Ctrl+B, D               — detach (keeps running)
#   bash scripts/start-vps.sh --stop  — kill all sessions

set -uo pipefail

# ── Defaults ─────────────────────────────────────────────────────────────────
PORT=9000
WORKSPACE="/root/claude-ide-bridge"
FIXED_TOKEN="f3fbe7ca-b547-4d22-8338-69e7ec8845c9"
START_NGROK=false
STOP=false
BRIDGE_SESSION="bridge"
NGROK_SESSION="ngrok"

# ── Parse args ────────────────────────────────────────────────────────────────
while [[ $# -gt 0 ]]; do
  case "$1" in
    --port)    PORT="$2"; shift 2 ;;
    --token)   FIXED_TOKEN="$2"; shift 2 ;;
    --ngrok)   START_NGROK=true; shift ;;
    --stop)    STOP=true; shift ;;
    *)         echo "Unknown option: $1" >&2; exit 1 ;;
  esac
done

# ── Stop mode ─────────────────────────────────────────────────────────────────
if [[ "$STOP" == true ]]; then
  echo "Stopping bridge and ngrok sessions..."
  tmux kill-session -t "$BRIDGE_SESSION" 2>/dev/null && echo "  v bridge stopped" || echo "  - bridge not running"
  tmux kill-session -t "$NGROK_SESSION"  2>/dev/null && echo "  v ngrok stopped"  || echo "  - ngrok not running"
  exit 0
fi

# ── Dependency checks ─────────────────────────────────────────────────────────
command -v tmux >/dev/null 2>&1 || { echo "Error: tmux not found. Run: apt install tmux" >&2; exit 1; }
command -v node >/dev/null 2>&1 || { echo "Error: node not found." >&2; exit 1; }

DIST="$WORKSPACE/dist/index.js"
if [[ ! -f "$DIST" ]]; then
  echo "Error: $DIST not found. Run: npm run build" >&2
  exit 1
fi

# ── Kill stale bridge session ─────────────────────────────────────────────────
tmux kill-session -t "$BRIDGE_SESSION" 2>/dev/null || true

# ── Bridge session (auto-restart loop) ───────────────────────────────────────
BRIDGE_CMD="node $DIST --port $PORT --workspace $WORKSPACE --fixed-token $FIXED_TOKEN"

tmux new-session -d -s "$BRIDGE_SESSION" -x 220 -y 50 bash
sleep 0.3

tmux send-keys -t "$BRIDGE_SESSION" "while true; do
  echo \"[\$(date '+%H:%M:%S')] Starting bridge on port $PORT...\"
  $BRIDGE_CMD
  EXIT=\$?
  if [ \$EXIT -eq 130 ]; then echo 'Stopped by user (Ctrl+C).'; break; fi
  echo \"[\$(date '+%H:%M:%S')] Bridge exited (code \$EXIT). Restarting in 5s...\"
  sleep 5
done" Enter

echo "v Bridge started  →  tmux attach -t $BRIDGE_SESSION"

# ── Optional ngrok session ────────────────────────────────────────────────────
if [[ "$START_NGROK" == true ]]; then
  if ! command -v ngrok >/dev/null 2>&1; then
    echo "Warning: ngrok not found — skipping tunnel." >&2
  else
    tmux kill-session -t "$NGROK_SESSION" 2>/dev/null || true
    tmux new-session -d -s "$NGROK_SESSION" -x 220 -y 50 \
      "ngrok http $PORT --log stdout"
    echo "v Ngrok started   →  tmux attach -t $NGROK_SESSION"
  fi
fi

# ── Summary ───────────────────────────────────────────────────────────────────
echo ""
echo "  Port:      $PORT"
echo "  Token:     $FIXED_TOKEN"
echo "  Workspace: $WORKSPACE"
echo ""
echo "Useful commands:"
echo "  tmux attach -t $BRIDGE_SESSION          # view bridge logs"
[[ "$START_NGROK" == true ]] && echo "  tmux attach -t $NGROK_SESSION           # view ngrok"
echo "  bash scripts/start-vps.sh --stop    # stop everything"
echo ""
