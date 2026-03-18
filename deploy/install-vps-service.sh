#!/usr/bin/env bash
# deploy/install-vps-service.sh
# Idempotent updater — re-installs the systemd service and nginx config
# on an already-bootstrapped server after a git pull.
#
# For FIRST-TIME setup on a new VPS, use bootstrap-new-vps.sh instead.
#
# Usage (run as root from repo root):
#   bash deploy/install-vps-service.sh
#
# Optional environment overrides:
#   DOMAIN        Override domain (default: read from existing nginx config or prompt)
#   PORT          Override port   (default: read from .env.vps)
#   SERVICE_USER  Override user   (default: auto-detect from existing service)

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SERVICE_NAME="claude-ide-bridge"
ENV_FILE="$REPO_ROOT/.env.vps"

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; NC='\033[0m'
info()    { echo -e "${GREEN}✓${NC} $*"; }
warn()    { echo -e "${YELLOW}⚠${NC}  $*"; }
err()     { echo -e "${RED}✗${NC} $*" >&2; }

echo "=== Claude IDE Bridge — Service Updater ==="
echo ""

# ── Pre-flight ────────────────────────────────────────────────────────────────
[[ "$(id -u)" -eq 0 ]] || { err "Run as root: sudo bash deploy/install-vps-service.sh"; exit 1; }
[[ -f "$ENV_FILE" ]]   || { err "$ENV_FILE not found. Run bootstrap-new-vps.sh first."; exit 1; }

source "$ENV_FILE"
[[ -n "${FIXED_TOKEN:-}" ]] || { err "FIXED_TOKEN not set in $ENV_FILE"; exit 1; }
[[ -n "${PORT:-}" ]]        || { err "PORT not set in $ENV_FILE"; exit 1; }
[[ -n "${WORKSPACE:-}" ]]   || { err "WORKSPACE not set in $ENV_FILE"; exit 1; }

DIST="$REPO_ROOT/dist/index.js"
[[ -f "$DIST" ]] || { err "$DIST not found. Run: npm run build"; exit 1; }

command -v nginx     >/dev/null 2>&1 || { err "nginx not found. Run bootstrap-new-vps.sh first."; exit 1; }
command -v systemctl >/dev/null 2>&1 || { err "systemd not available."; exit 1; }

# Detect service user from existing unit file, fall back to env or default
EXISTING_USER=$(grep -Po '(?<=^User=).+' /etc/systemd/system/${SERVICE_NAME}.service 2>/dev/null || echo "")
SERVICE_USER="${SERVICE_USER:-${EXISTING_USER:-claude-bridge}}"

# Detect domain from existing nginx config
EXISTING_DOMAIN=$(grep -Po '(?<=server_name )[\w.-]+' /etc/nginx/sites-available/claude-bridge 2>/dev/null | head -1 || echo "")
DOMAIN="${DOMAIN:-$EXISTING_DOMAIN}"

if [[ -z "$DOMAIN" ]]; then
  err "Cannot determine DOMAIN. Set it: DOMAIN=bridge.example.com bash deploy/install-vps-service.sh"
  exit 1
fi

info "Repo:         $REPO_ROOT"
info "Domain:       $DOMAIN"
info "Port:         $PORT"
info "Service user: $SERVICE_USER"
echo ""

# ── Systemd service ───────────────────────────────────────────────────────────
echo "Updating systemd service..."

cat > "/etc/systemd/system/${SERVICE_NAME}.service" <<SERVICE
[Unit]
Description=Claude IDE Bridge MCP Server
Documentation=https://github.com/Oolab-labs/claude-ide-bridge
After=network.target
StartLimitIntervalSec=120
StartLimitBurst=5

[Service]
Type=simple
User=$SERVICE_USER
WorkingDirectory=$REPO_ROOT

# Load config — FIXED_TOKEN, PORT, WORKSPACE
EnvironmentFile=$ENV_FILE

# Bridge process
ExecStart=/usr/bin/node $REPO_ROOT/dist/index.js \\
    --port \${PORT} \\
    --workspace \${WORKSPACE} \\
    --fixed-token \${FIXED_TOKEN} \\
    --grace-period 120000 \\
    --vps

KillMode=mixed
KillSignal=SIGTERM
TimeoutStopSec=15
Restart=always
RestartSec=5

StandardOutput=journal
StandardError=journal
SyslogIdentifier=claude-ide-bridge

NoNewPrivileges=true
PrivateTmp=true

[Install]
WantedBy=multi-user.target
SERVICE

systemctl daemon-reload
systemctl enable "$SERVICE_NAME"
info "Systemd service updated"

# ── nginx ─────────────────────────────────────────────────────────────────────
echo "Updating nginx config..."

# Add connection_upgrade map if missing
if ! grep -q "connection_upgrade" /etc/nginx/nginx.conf 2>/dev/null; then
  perl -i -0pe 's/(http \{)/$1\n    map \$http_upgrade \$connection_upgrade {\n        default upgrade;\n        '"''"'     close;\n    }/' /etc/nginx/nginx.conf
  info "Added connection_upgrade map to nginx.conf"
fi

# Write site config with domain and port injected
cat > "/etc/nginx/sites-available/claude-bridge" <<NGINX
# Claude IDE Bridge — nginx reverse proxy
# Domain: $DOMAIN  Port: ${PORT}
# Updated by install-vps-service.sh on $(date -u +%Y-%m-%dT%H:%M:%SZ)

server {
    listen 80;
    listen [::]:80;
    server_name $DOMAIN;

    location /.well-known/acme-challenge/ {
        root /var/www/html;
    }

    location / {
        return 301 https://\$host\$request_uri;
    }
}

server {
    listen 443 ssl http2;
    listen [::]:443 ssl http2;
    server_name $DOMAIN;

    # TLS — managed by Certbot
    # ssl_certificate     /etc/letsencrypt/live/$DOMAIN/fullchain.pem;
    # ssl_certificate_key /etc/letsencrypt/live/$DOMAIN/privkey.pem;
    # include /etc/letsencrypt/options-ssl-nginx.conf;
    # ssl_dhparam /etc/letsencrypt/ssl-dhparams.pem;

    add_header X-Content-Type-Options nosniff always;
    add_header X-Frame-Options DENY always;
    add_header Strict-Transport-Security "max-age=31536000; includeSubDomains" always;

    location /mcp {
        proxy_pass http://127.0.0.1:${PORT};
        proxy_http_version 1.1;
        proxy_buffering off;
        proxy_cache off;
        proxy_read_timeout 3600s;
        proxy_send_timeout 3600s;
        proxy_connect_timeout 10s;
        proxy_set_header Authorization \$http_authorization;
        proxy_pass_header Authorization;
        proxy_set_header Mcp-Session-Id \$http_mcp_session_id;
        proxy_pass_header Mcp-Session-Id;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection \$connection_upgrade;
    }

    location /health {
        proxy_pass http://127.0.0.1:${PORT};
        proxy_http_version 1.1;
        proxy_connect_timeout 5s;
        proxy_read_timeout 10s;
    }

    location /.well-known/ {
        proxy_pass http://127.0.0.1:${PORT};
        proxy_http_version 1.1;
        proxy_connect_timeout 5s;
        proxy_read_timeout 10s;
    }

    location / {
        return 404;
    }
}
NGINX

[[ -L "/etc/nginx/sites-enabled/claude-bridge" ]] || \
  ln -s /etc/nginx/sites-available/claude-bridge /etc/nginx/sites-enabled/claude-bridge

[[ -L "/etc/nginx/sites-enabled/default" ]] && \
  rm -f /etc/nginx/sites-enabled/default

nginx -t
systemctl reload nginx
info "nginx config updated"

# ── Stop tmux session if still running (superseded by systemd) ────────────────
if command -v tmux >/dev/null 2>&1 && tmux has-session -t "bridge" 2>/dev/null; then
  tmux kill-session -t "bridge" 2>/dev/null || true
  info "Stopped legacy tmux bridge session"
fi

# ── Restart service ───────────────────────────────────────────────────────────
echo "Restarting service..."
systemctl restart "$SERVICE_NAME"

echo -n "Waiting for bridge..."
for i in $(seq 1 20); do
  if curl -sf --max-time 3 "http://127.0.0.1:${PORT}/health" >/dev/null 2>&1; then
    echo " ready."
    break
  fi
  sleep 1; echo -n "."
  if [[ $i -eq 20 ]]; then
    echo " timed out."
    warn "Check: journalctl -u $SERVICE_NAME -n 50"
  fi
done

# ── Summary ───────────────────────────────────────────────────────────────────
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  Claude IDE Bridge — service updated"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""
echo "  MCP endpoint:  https://$DOMAIN/mcp"
echo "  Local:         http://127.0.0.1:${PORT}/mcp"
echo "  Token:         ${FIXED_TOKEN}"
echo ""
echo "  journalctl -u $SERVICE_NAME -f"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
