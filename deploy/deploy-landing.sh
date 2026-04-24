#!/usr/bin/env bash
# deploy-landing.sh — Deploy static landing page to VPS
# Run from Mac: bash deploy/deploy-landing.sh
set -euo pipefail

VPS="root@185.167.97.141"
LANDING_DIR="/var/www/patchwork-landing"
NGINX_CONF="/etc/nginx/sites-available/patchworkos"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

echo "==> Copying landing page to VPS..."
ssh "$VPS" "mkdir -p $LANDING_DIR"
scp "$REPO_ROOT/landing/index.html" "$VPS:$LANDING_DIR/index.html"

echo "==> Updating nginx to serve landing page at root..."
ssh "$VPS" bash <<'REMOTE'
set -euo pipefail
NGINX_CONF="/etc/nginx/sites-available/patchworkos"

# Insert landing page root location if not already present
if ! grep -q "location = /" "$NGINX_CONF"; then
  python3 - "$NGINX_CONF" <<'PYEOF'
import sys, re

path = sys.argv[1]
with open(path) as f:
    content = f.read()

landing_blocks = """
    # Static landing page at root
    location = / {
        root /var/www/patchwork-landing;
        try_files /index.html =404;
    }

    # Bridge API paths — proxy to bridge
    location ~ ^/(mcp|oauth|notify|\.well-known|metrics|health|approvals|activity|sessions|traces|recipes|connectors|settings|schemas|push) {
        proxy_pass http://127.0.0.1:3284;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 3600s;
        proxy_send_timeout 3600s;
    }
"""

# Insert before the SSE/dashboard blocks (before first "location /dashboard")
# or before the last closing brace if those don't exist
if 'location /dashboard' in content:
    idx = content.find('    # SSE passthrough')
    if idx == -1:
        idx = content.find('    location /dashboard')
else:
    idx = content.rfind('\n}')

if idx == -1:
    idx = content.rfind('\n}')

new_content = content[:idx] + landing_blocks + content[idx:]
with open(path, 'w') as f:
    f.write(new_content)
print("nginx: landing + bridge location blocks inserted")
PYEOF
else
  echo "nginx: landing location already present, skipping"
fi

nginx -t && systemctl reload nginx
echo "nginx reloaded"
REMOTE

echo ""
echo "==> Deploy complete!"
echo "    Landing page: https://patchworkos.com"
