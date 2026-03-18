#!/usr/bin/env bash
# deploy/install-vps-service.sh
# One-shot setup: systemd service + nginx reverse proxy for claude-ide-bridge.
# Run from the repo root on the VPS as root.
#
# Usage:
#   bash deploy/install-vps-service.sh
#
# What it does:
#   1. Validates .env.vps and dist/index.js exist
#   2. Installs systemd service → auto-start on boot
#   3. Installs nginx site config → HTTPS reverse proxy on bridge.massappealdesigns.co.ke
#   4. Obtains TLS cert via Certbot
#   5. Stops tmux bridge session (now superseded by systemd)
#   6. Starts and enables the service
#   7. Prints status and connection info

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SERVICE_NAME="claude-ide-bridge"
SERVICE_FILE="$REPO_ROOT/deploy/claude-ide-bridge.service"
NGINX_CONF="$REPO_ROOT/deploy/nginx-claude-bridge.conf"
NGINX_SITE="/etc/nginx/sites-available/claude-bridge"
NGINX_ENABLED="/etc/nginx/sites-enabled/claude-bridge"
DOMAIN="bridge.massappealdesigns.co.ke"
ENV_FILE="$REPO_ROOT/.env.vps"

echo "=== Claude IDE Bridge — VPS Service Installer ==="
echo ""

# ── 1. Pre-flight checks ───────────────────────────────────────────────────────
[[ "$(id -u)" -eq 0 ]] || { echo "Error: run as root (sudo bash deploy/install-vps-service.sh)" >&2; exit 1; }

[[ -f "$ENV_FILE" ]] || { echo "Error: $ENV_FILE not found. Create it first." >&2; exit 1; }
source "$ENV_FILE"
[[ -n "${FIXED_TOKEN:-}" ]] || { echo "Error: FIXED_TOKEN not set in $ENV_FILE" >&2; exit 1; }
[[ -n "${PORT:-}" ]]        || { echo "Error: PORT not set in $ENV_FILE" >&2; exit 1; }
[[ -n "${WORKSPACE:-}" ]]   || { echo "Error: WORKSPACE not set in $ENV_FILE" >&2; exit 1; }

DIST="$REPO_ROOT/dist/index.js"
[[ -f "$DIST" ]] || { echo "Error: $DIST not found. Run: npm run build" >&2; exit 1; }

command -v nginx    >/dev/null 2>&1 || { echo "Error: nginx not found. Install: apt install nginx" >&2; exit 1; }
command -v certbot  >/dev/null 2>&1 || { echo "Error: certbot not found. Install: apt install certbot python3-certbot-nginx" >&2; exit 1; }
command -v systemctl>/dev/null 2>&1 || { echo "Error: systemd not available." >&2; exit 1; }

echo "✓ Pre-flight checks passed"
echo "  PORT=$PORT  WORKSPACE=$WORKSPACE"
echo ""

# ── 2. Systemd service ─────────────────────────────────────────────────────────
echo "Installing systemd service..."
cp "$SERVICE_FILE" "/etc/systemd/system/${SERVICE_NAME}.service"
systemctl daemon-reload
systemctl enable "$SERVICE_NAME"
echo "✓ Systemd service installed and enabled"

# ── 3. nginx site ──────────────────────────────────────────────────────────────
echo "Installing nginx site config..."

# Add connection upgrade map to nginx.conf if missing
if ! grep -q "connection_upgrade" /etc/nginx/nginx.conf; then
    sed -i '/^http {/a\\tmap $http_upgrade $connection_upgrade {\n\t\tdefault upgrade;\n\t\t'"''"'\t\tclose;\n\t}' /etc/nginx/nginx.conf
    echo "✓ Added connection_upgrade map to nginx.conf"
fi

cp "$NGINX_CONF" "$NGINX_SITE"
[[ -L "$NGINX_ENABLED" ]] || ln -s "$NGINX_SITE" "$NGINX_ENABLED"

# Remove default site if present (avoids port 80 conflict during certbot challenge)
[[ -L "/etc/nginx/sites-enabled/default" ]] && rm -f "/etc/nginx/sites-enabled/default" && echo "✓ Removed nginx default site"

nginx -t
systemctl reload nginx
echo "✓ nginx config installed and reloaded"

# ── 4. TLS certificate ─────────────────────────────────────────────────────────
echo ""
echo "Obtaining TLS certificate for $DOMAIN ..."
certbot --nginx -d "$DOMAIN" --non-interactive --agree-tos --register-unsafely-without-email \
    --redirect || {
    echo ""
    echo "⚠  Certbot failed. Common reasons:"
    echo "   - DNS not yet pointing to this server (check: dig $DOMAIN)"
    echo "   - Port 80 blocked by firewall (check: ufw allow 80)"
    echo ""
    echo "You can re-run certbot manually:"
    echo "   certbot --nginx -d $DOMAIN"
    echo ""
}
echo "✓ TLS certificate obtained"

# ── 5. Stop tmux bridge session (superseded by systemd) ───────────────────────
if command -v tmux >/dev/null 2>&1; then
    if tmux has-session -t "bridge" 2>/dev/null; then
        echo "Stopping tmux 'bridge' session (now managed by systemd)..."
        tmux kill-session -t "bridge" 2>/dev/null || true
        echo "✓ tmux bridge session stopped"
    fi
fi

# ── 6. Start service ───────────────────────────────────────────────────────────
echo "Starting claude-ide-bridge service..."
systemctl restart "$SERVICE_NAME"

# Wait for healthy
echo -n "Waiting for bridge to be healthy..."
for i in $(seq 1 20); do
    if curl -sf --max-time 3 "http://127.0.0.1:${PORT}/health" >/dev/null 2>&1; then
        echo " ready."
        break
    fi
    sleep 1
    echo -n "."
    if [[ $i -eq 20 ]]; then
        echo " timed out."
        echo "Check: journalctl -u $SERVICE_NAME -n 50"
    fi
done

# ── 7. Summary ─────────────────────────────────────────────────────────────────
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  Claude IDE Bridge — VPS service active"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""
echo "  MCP endpoint:  https://$DOMAIN/mcp"
echo "  Health check:  https://$DOMAIN/health"
echo "  Local:         http://127.0.0.1:${PORT}/mcp"
echo "  Token:         ${FIXED_TOKEN}"
echo ""
echo "  Service management:"
echo "    systemctl status $SERVICE_NAME"
echo "    journalctl -u $SERVICE_NAME -f"
echo "    systemctl restart $SERVICE_NAME"
echo ""
echo "  To update bridge after npm publish:"
echo "    npm install -g claude-ide-bridge"
echo "    npm run build"
echo "    systemctl restart $SERVICE_NAME"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
