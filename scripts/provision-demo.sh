#!/usr/bin/env bash
# provision-demo.sh — one-shot setup for a claude-ide-bridge demo instance
# Runs directly via Node (no Docker). Sets up a systemd service for persistence.
# Tested on Ubuntu 22.04 / 24.04.
#
# Usage (run as root or with sudo):
#   bash scripts/provision-demo.sh
set -euo pipefail

BRIDGE_PORT="${BRIDGE_PORT:-18765}"
BRIDGE_USER="bridge"
INSTALL_DIR="/opt/claude-ide-bridge"
TOKEN_FILE="/etc/claude-ide-bridge/token"
SERVICE_NAME="claude-ide-bridge"

# ── 1. Install Node.js 20 if not present ──────────────────────────────────────
if ! command -v node &>/dev/null || [[ "$(node -e 'console.log(parseInt(process.version.slice(1)))')" -lt 20 ]]; then
  echo "Installing Node.js 20..."
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt-get install -y nodejs
fi
echo "Node $(node --version) / npm $(npm --version)"

# ── 2. Create a dedicated system user ─────────────────────────────────────────
if ! id "$BRIDGE_USER" &>/dev/null; then
  useradd --system --no-create-home --shell /usr/sbin/nologin "$BRIDGE_USER"
fi

# ── 3. Install the bridge globally ────────────────────────────────────────────
echo "Installing claude-ide-bridge..."
npm install -g claude-ide-bridge
BRIDGE_BIN="$(which claude-ide-bridge)"
echo "Installed at: $BRIDGE_BIN"

# ── 4. Generate a stable auth token ───────────────────────────────────────────
mkdir -p /etc/claude-ide-bridge
if [[ ! -f "$TOKEN_FILE" ]]; then
  node -e "console.log(require('crypto').randomUUID())" > "$TOKEN_FILE"
  chmod 600 "$TOKEN_FILE"
  chown "$BRIDGE_USER:$BRIDGE_USER" "$TOKEN_FILE" 2>/dev/null || true
  echo "Generated new auth token → $TOKEN_FILE"
else
  echo "Reusing existing auth token from $TOKEN_FILE"
fi
TOKEN=$(cat "$TOKEN_FILE")

# ── 5. Create workspace and config dirs ───────────────────────────────────────
mkdir -p "$INSTALL_DIR/workspace"
mkdir -p "$INSTALL_DIR/claude/ide"
chown -R "$BRIDGE_USER:$BRIDGE_USER" "$INSTALL_DIR"

# ── 6. Write systemd service ──────────────────────────────────────────────────
cat > "/etc/systemd/system/${SERVICE_NAME}.service" <<SERVICE
[Unit]
Description=Claude IDE Bridge
After=network.target
Wants=network.target

[Service]
Type=simple
User=$BRIDGE_USER
Environment=CLAUDE_IDE_BRIDGE_TOKEN=$TOKEN
Environment=CLAUDE_CONFIG_DIR=$INSTALL_DIR/claude
ExecStart=$BRIDGE_BIN --workspace $INSTALL_DIR/workspace --bind 0.0.0.0 --port $BRIDGE_PORT
Restart=on-failure
RestartSec=5
StartLimitBurst=5
StartLimitIntervalSec=60

[Install]
WantedBy=multi-user.target
SERVICE

systemctl daemon-reload
systemctl enable "$SERVICE_NAME"
systemctl restart "$SERVICE_NAME"

# ── 7. Open firewall ──────────────────────────────────────────────────────────
if command -v ufw &>/dev/null && ufw status | grep -q "Status: active"; then
  ufw allow "${BRIDGE_PORT}/tcp" comment "claude-ide-bridge"
  echo "ufw: opened port $BRIDGE_PORT"
fi

# ── 8. Wait for healthy ───────────────────────────────────────────────────────
echo -n "Waiting for bridge to be healthy..."
for i in $(seq 1 30); do
  if curl -sf "http://127.0.0.1:${BRIDGE_PORT}/ping" &>/dev/null; then
    echo " ready."
    break
  fi
  sleep 1
  echo -n "."
  if [[ $i -eq 30 ]]; then
    echo " timed out. Check: journalctl -u $SERVICE_NAME -n 50"
    exit 1
  fi
done

# ── 9. Print connection details ───────────────────────────────────────────────
PUBLIC_IP=$(curl -sf https://api.ipify.org 2>/dev/null || hostname -I | awk '{print $1}')
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  Claude IDE Bridge demo instance is running"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""
echo "  Endpoint : http://${PUBLIC_IP}:${BRIDGE_PORT}"
echo "  Token    : ${TOKEN}"
echo ""
echo "  Verify:"
echo "    curl http://${PUBLIC_IP}:${BRIDGE_PORT}/ping"
echo "    curl http://${PUBLIC_IP}:${BRIDGE_PORT}/.well-known/oauth-authorization-server"
echo ""
echo "  MCP endpoint (Streamable HTTP):"
echo "    http://${PUBLIC_IP}:${BRIDGE_PORT}/mcp"
echo ""
echo "  Service management:"
echo "    systemctl status $SERVICE_NAME"
echo "    journalctl -u $SERVICE_NAME -f"
echo "    systemctl restart $SERVICE_NAME"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
