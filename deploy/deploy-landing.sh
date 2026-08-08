#!/usr/bin/env bash
# deploy-landing.sh — Deploy static landing page to VPS
# Run from Mac: bash deploy/deploy-landing.sh
set -euo pipefail

# Deployment target. REQUIRED, no default — see deploy/deploy-dashboard.sh
# for why. The address that used to sit here was reassigned by the hosting
# provider to an unrelated customer.
if [ -z "${PATCHWORK_VPS:-}" ]; then
  cat >&2 <<'ERR'
error: PATCHWORK_VPS is not set.

  Set it to the ssh destination for YOUR server, e.g.

      PATCHWORK_VPS=root@203.0.113.10 bash deploy/deploy-landing.sh

  There is no default on purpose.
ERR
  exit 1
fi
VPS="$PATCHWORK_VPS"

LANDING_DIR="${PATCHWORK_LANDING_DIR:-/var/www/patchwork-landing}"
NGINX_CONF="${PATCHWORK_NGINX_CONF:-/etc/nginx/sites-available/patchwork}"
LANDING_URL="${PATCHWORK_LANDING_URL:-https://your.tld}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

echo "==> Copying landing page + assets to VPS..."
ssh "$VPS" "mkdir -p $LANDING_DIR"
# index.html plus the favicon + manifest browsers probe at apex. Without
# these the browser console fills with /favicon.svg and /manifest.json
# 401s on every page load (nginx falls through to the dashboard middleware
# for paths that don't have an explicit `location`).
scp "$REPO_ROOT/landing/index.html"   "$VPS:$LANDING_DIR/index.html"
scp "$REPO_ROOT/landing/favicon.ico"  "$VPS:$LANDING_DIR/favicon.ico"
scp "$REPO_ROOT/landing/favicon.svg"  "$VPS:$LANDING_DIR/favicon.svg"
scp "$REPO_ROOT/landing/manifest.json" "$VPS:$LANDING_DIR/manifest.json"

echo "==> Updating nginx to serve landing page at root..."
ssh "$VPS" bash -s -- "$NGINX_CONF" "$LANDING_DIR" <<'REMOTE'
set -euo pipefail
# Passed in rather than repeated: these were declared twice, so overriding
# the local copy silently changed nothing on the remote side.
NGINX_CONF="${1:?nginx conf path not passed}"
LANDING_DIR="${2:?landing dir not passed}"

# Insert landing page root location if not already present
if ! grep -q "location = /" "$NGINX_CONF"; then
  python3 - "$NGINX_CONF" "$LANDING_DIR" <<'PYEOF'
import sys, re

path = sys.argv[1]
landing = sys.argv[2]
with open(path) as f:
    content = f.read()

landing_blocks = """
    # Static landing page at root
    location = / {
        root __LANDING_DIR__;
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

landing_blocks = landing_blocks.replace("__LANDING_DIR__", landing)

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

# Independent idempotency block for the apex asset locations — these were
# added after the original landing block, so existing installs miss them.
if ! grep -q "location = /favicon.ico" "$NGINX_CONF"; then
  python3 - "$NGINX_CONF" "$LANDING_DIR" <<'PYEOF'
import sys

path = sys.argv[1]
landing = sys.argv[2]
with open(path) as f:
    content = f.read()

asset_blocks = """
    # Apex assets — favicon + PWA manifest browsers probe at root
    location = /favicon.ico {
        root __LANDING_DIR__;
        try_files /favicon.ico =404;
        access_log off;
    }
    location = /favicon.svg {
        root __LANDING_DIR__;
        try_files /favicon.svg =404;
        access_log off;
    }
    location = /manifest.json {
        root __LANDING_DIR__;
        try_files /manifest.json =404;
        access_log off;
    }
"""

asset_blocks = asset_blocks.replace("__LANDING_DIR__", landing)

# Insert immediately after the existing `location = /` block
marker = '    location = / {'
idx = content.find(marker)
if idx == -1:
    print("WARN: could not find `location = /` to anchor; appending to end", flush=True)
    idx = content.rfind('\n}')
    new_content = content[:idx] + asset_blocks + content[idx:]
else:
    # find end of the location = / block
    end = content.find('    }', idx)
    end = content.find('\n', end) + 1 if end != -1 else idx
    new_content = content[:end] + asset_blocks + content[end:]

with open(path, 'w') as f:
    f.write(new_content)
print("nginx: apex asset location blocks inserted")
PYEOF
else
  echo "nginx: apex asset locations already present, skipping"
fi

nginx -t && systemctl reload nginx
echo "nginx reloaded"
REMOTE

echo ""
echo "==> Deploy complete!"
echo "    Landing page: $LANDING_URL"
