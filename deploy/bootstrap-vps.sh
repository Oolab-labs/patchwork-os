#!/usr/bin/env bash
# deploy/bootstrap-vps.sh
# Full VPS bootstrap for patchworkos.com
# Run as root on a fresh Ubuntu 24.04 VPS
# Usage: bash bootstrap-vps.sh

set -euo pipefail

DOMAIN="patchworkos.com"
EMAIL="support@gigsecure.co.ke"
BRIDGE_PORT=3284
BRIDGE_USER="patchwork"
BRIDGE_HOME="/opt/patchwork"
NODE_VERSION="22"

# ── Colours ──────────────────────────────────────────────────────────────────
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; NC='\033[0m'
info()  { echo -e "${GREEN}[bootstrap]${NC} $*"; }
warn()  { echo -e "${YELLOW}[bootstrap]${NC} $*"; }
error() { echo -e "${RED}[bootstrap]${NC} $*"; exit 1; }

# ── 1. System updates ─────────────────────────────────────────────────────────
info "Updating system packages..."
apt-get update -qq
apt-get upgrade -y -qq
apt-get install -y -qq curl wget gnupg2 ca-certificates lsb-release \
  nginx certbot python3-certbot-nginx ufw git jq unzip

# ── 2. Node.js ────────────────────────────────────────────────────────────────
info "Installing Node.js ${NODE_VERSION}..."
curl -fsSL https://deb.nodesource.com/setup_${NODE_VERSION}.x | bash - >/dev/null
apt-get install -y -qq nodejs
node --version
npm --version

# ── 3. Service user ───────────────────────────────────────────────────────────
info "Creating service user '${BRIDGE_USER}'..."
id "${BRIDGE_USER}" &>/dev/null || useradd -r -m -d "${BRIDGE_HOME}" -s /bin/bash "${BRIDGE_USER}"
mkdir -p "${BRIDGE_HOME}"
chown "${BRIDGE_USER}:${BRIDGE_USER}" "${BRIDGE_HOME}"

# ── 4. Install bridge globally ────────────────────────────────────────────────
info "Installing patchwork-os from npm..."
npm install -g patchwork-os@alpha 2>&1 | tail -5
# `patchwork-os` ships three bin aliases: `patchwork` (preferred),
# `patchwork-os`, and the legacy `claude-ide-bridge`. Use the canonical
# `patchwork` name for the systemd unit + nginx config below.
BRIDGE_BIN="$(which patchwork)"
info "Bridge binary: ${BRIDGE_BIN}"

# ── 5. Generate fixed token ───────────────────────────────────────────────────
FIXED_TOKEN="$(uuidgen | tr '[:upper:]' '[:lower:]')"
info "Generated bridge token (save this!): ${FIXED_TOKEN}"

# Persist token to a file readable only by root + patchwork user
TOKEN_FILE="/etc/patchwork/bridge-token"
mkdir -p /etc/patchwork
echo "${FIXED_TOKEN}" > "${TOKEN_FILE}"
chown root:"${BRIDGE_USER}" "${TOKEN_FILE}"
chmod 640 "${TOKEN_FILE}"

# ── 6. Systemd service ────────────────────────────────────────────────────────
info "Writing systemd service..."
cat > /etc/systemd/system/patchwork-bridge.service <<EOF
[Unit]
Description=Patchwork OS — Claude IDE Bridge
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=${BRIDGE_USER}
Group=${BRIDGE_USER}
WorkingDirectory=${BRIDGE_HOME}
Environment=NODE_ENV=production
Environment=HOME=${BRIDGE_HOME}

ExecStart=${BRIDGE_BIN} \\
  --bind 0.0.0.0 \\
  --port ${BRIDGE_PORT} \\
  --vps \\
  --issuer-url https://${DOMAIN} \\
  --cors-origin https://claude.ai \\
  --cors-origin https://app.patchworkos.com \\
  --fixed-token ${FIXED_TOKEN}

Restart=always
RestartSec=5
StandardOutput=journal
StandardError=journal
SyslogIdentifier=patchwork-bridge

# Hardening
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=read-only
ReadWritePaths=${BRIDGE_HOME}
PrivateTmp=true

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable patchwork-bridge

# ── 7. UFW firewall ───────────────────────────────────────────────────────────
info "Configuring firewall..."
ufw --force reset >/dev/null
ufw default deny incoming >/dev/null
ufw default allow outgoing >/dev/null
ufw allow ssh >/dev/null
ufw allow http >/dev/null
ufw allow https >/dev/null
ufw --force enable >/dev/null
ufw status

# ── 8. Nginx config — HTTP only first (certbot needs nginx up to issue cert) ──
info "Writing nginx config (HTTP only)..."
cat > /etc/nginx/sites-available/patchworkos <<'NGINX'
server {
    listen 80;
    listen [::]:80;
    server_name patchworkos.com www.patchworkos.com;

    location /.well-known/acme-challenge/ { root /var/www/html; }

    location / {
        proxy_pass         http://127.0.0.1:3284;
        proxy_http_version 1.1;
        proxy_set_header   Upgrade $http_upgrade;
        proxy_set_header   Connection "upgrade";
        proxy_set_header   Host $host;
        proxy_set_header   X-Real-IP $remote_addr;
        proxy_set_header   X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header   X-Forwarded-Proto $scheme;
        proxy_read_timeout 3600s;
        proxy_send_timeout 3600s;
    }
}
NGINX

ln -sf /etc/nginx/sites-available/patchworkos /etc/nginx/sites-enabled/patchworkos
rm -f /etc/nginx/sites-enabled/default

nginx -t
systemctl reload nginx

# ── 9. TLS certificate ────────────────────────────────────────────────────────
info "Issuing Let's Encrypt certificate for ${DOMAIN}..."
certbot --nginx \
  -d "${DOMAIN}" \
  -d "www.${DOMAIN}" \
  --non-interactive \
  --agree-tos \
  --email "${EMAIL}" \
  --redirect

# Certbot rewrites the nginx config with SSL — reload to apply
systemctl reload nginx

# ── 10. Start bridge ──────────────────────────────────────────────────────────
info "Starting bridge service..."
systemctl start patchwork-bridge
sleep 3
systemctl is-active patchwork-bridge && info "Bridge is running." || warn "Bridge may have failed — check: journalctl -u patchwork-bridge -n 50"

# ── 11. Print summary ─────────────────────────────────────────────────────────
echo ""
echo -e "${GREEN}═══════════════════════════════════════════════════${NC}"
echo -e "${GREEN}  Patchwork OS — VPS bootstrap complete${NC}"
echo -e "${GREEN}═══════════════════════════════════════════════════${NC}"
echo ""
echo "  Domain:       https://${DOMAIN}"
echo "  Bridge port:  ${BRIDGE_PORT} (internal, nginx proxied)"
echo "  Token file:   ${TOKEN_FILE}"
echo "  Token:        ${FIXED_TOKEN}"
echo ""
echo "  Service:      systemctl status patchwork-bridge"
echo "  Logs:         journalctl -u patchwork-bridge -f"
echo "  Nginx logs:   tail -f /var/log/nginx/access.log"
echo ""
echo -e "${YELLOW}  Save the token above — you'll need it to connect Claude Code.${NC}"
echo ""
echo "  To connect Claude Code remotely:"
echo "    claude mcp add patchwork https://${DOMAIN}/mcp --token ${FIXED_TOKEN}"
echo ""
