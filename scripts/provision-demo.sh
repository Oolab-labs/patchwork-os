#!/usr/bin/env bash
# provision-demo.sh — one-shot setup for a claude-ide-bridge demo instance
# Tested on Ubuntu 22.04 / 24.04.
#
# Usage (run as root or with sudo):
#   curl -fsSL https://raw.githubusercontent.com/Oolab-labs/claude-ide-bridge/main/scripts/provision-demo.sh | bash
#
# Or clone the repo and run locally:
#   bash scripts/provision-demo.sh
set -euo pipefail

BRIDGE_PORT="${BRIDGE_PORT:-18765}"
BRIDGE_VERSION="${BRIDGE_VERSION:-latest}"
TOKEN_FILE="/etc/claude-ide-bridge/token"

# ── 1. Install Docker if not present ──────────────────────────────────────────
if ! command -v docker &>/dev/null; then
  echo "Installing Docker..."
  curl -fsSL https://get.docker.com | sh
  systemctl enable --now docker
fi

# ── 2. Generate a stable auth token ──────────────────────────────────────────
mkdir -p /etc/claude-ide-bridge
if [[ ! -f "$TOKEN_FILE" ]]; then
  node -e "console.log(require('crypto').randomUUID())" > "$TOKEN_FILE"
  chmod 600 "$TOKEN_FILE"
  echo "Generated new auth token → $TOKEN_FILE"
else
  echo "Reusing existing auth token from $TOKEN_FILE"
fi
TOKEN=$(cat "$TOKEN_FILE")

# ── 3. Pull and start the bridge ──────────────────────────────────────────────
echo "Starting claude-ide-bridge v${BRIDGE_VERSION} on port ${BRIDGE_PORT}..."
docker rm -f claude-ide-bridge 2>/dev/null || true
docker run -d \
  --name claude-ide-bridge \
  --restart unless-stopped \
  -p "${BRIDGE_PORT}:${BRIDGE_PORT}" \
  -e "CLAUDE_IDE_BRIDGE_TOKEN=${TOKEN}" \
  -e "PORT=${BRIDGE_PORT}" \
  "ghcr.io/oolab-labs/claude-ide-bridge:${BRIDGE_VERSION}" \
  --workspace /workspace --bind 0.0.0.0

# ── 4. Wait for healthy ───────────────────────────────────────────────────────
echo -n "Waiting for bridge to be healthy..."
for i in $(seq 1 20); do
  if curl -sf "http://127.0.0.1:${BRIDGE_PORT}/ping" &>/dev/null; then
    echo " ready."
    break
  fi
  sleep 1
  echo -n "."
done

# ── 5. Print connection details ───────────────────────────────────────────────
PUBLIC_IP=$(curl -sf https://api.ipify.org || echo "<your-server-ip>")
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  Claude IDE Bridge demo instance is running"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""
echo "  Endpoint : http://${PUBLIC_IP}:${BRIDGE_PORT}"
echo "  Token    : ${TOKEN}"
echo "  Ping     : http://${PUBLIC_IP}:${BRIDGE_PORT}/ping"
echo ""
echo "  OAuth discovery:"
echo "    http://${PUBLIC_IP}:${BRIDGE_PORT}/.well-known/oauth-authorization-server"
echo ""
echo "  MCP endpoint (Streamable HTTP):"
echo "    http://${PUBLIC_IP}:${BRIDGE_PORT}/mcp"
echo ""
echo "  To check status:  docker logs claude-ide-bridge"
echo "  To stop:          docker stop claude-ide-bridge"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
