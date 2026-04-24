#!/usr/bin/env bash
# deploy-dashboard.sh — Build dashboard locally and deploy to VPS
# Run from Mac: bash deploy/deploy-dashboard.sh
set -euo pipefail

VPS="root@185.167.97.141"
REMOTE_DIR="/opt/patchwork-dashboard"
PM2_NAME="patchwork-dashboard"
PORT=3200
NGINX_CONF="/etc/nginx/sites-available/patchworkos"
DASHBOARD_URL="https://patchworkos.com/dashboard"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
DASHBOARD_DIR="$REPO_ROOT/dashboard"

echo "==> Building dashboard..."
cd "$DASHBOARD_DIR"
npm run build

echo "==> Packaging standalone build..."
TARBALL="/tmp/patchwork-dashboard.tar.gz"
STAGE="/tmp/patchwork-dashboard-stage"
rm -rf "$STAGE" && mkdir -p "$STAGE"

# Copy standalone output
cp -r "$DASHBOARD_DIR/.next/standalone/." "$STAGE/"
# Standalone needs static assets in .next/static
mkdir -p "$STAGE/.next/static"
cp -r "$DASHBOARD_DIR/.next/static/." "$STAGE/.next/static/"
# Copy public dir if it exists
if [ -d "$DASHBOARD_DIR/public" ]; then
  cp -r "$DASHBOARD_DIR/public/." "$STAGE/public/"
fi

tar -czf "$TARBALL" --no-xattrs -C "$STAGE" .

echo "==> Copying tarball to VPS..."
scp "$TARBALL" "$VPS:/tmp/patchwork-dashboard.tar.gz"

echo "==> Deploying on VPS..."
# shellcheck disable=SC2087
ssh "$VPS" bash <<'REMOTE'
set -euo pipefail
REMOTE_DIR="/opt/patchwork-dashboard"
PM2_NAME="patchwork-dashboard"
PORT=3200

# Stop existing PM2 process if running
if pm2 list | grep -q "$PM2_NAME"; then
  pm2 stop "$PM2_NAME" || true
  pm2 delete "$PM2_NAME" || true
fi

# Wipe and recreate deploy dir
rm -rf "$REMOTE_DIR"
mkdir -p "$REMOTE_DIR"

# Extract
tar -xzf /tmp/patchwork-dashboard.tar.gz -C "$REMOTE_DIR"
rm /tmp/patchwork-dashboard.tar.gz

# Copy static assets into standalone's expected location
mkdir -p "$REMOTE_DIR/.next"
if [ -d "$REMOTE_DIR/.next/static" ]; then
  echo "static dir already in place"
else
  # tar may have extracted flat; handle both layouts
  if [ -d /tmp/dashboard-static ]; then
    cp -r /tmp/dashboard-static "$REMOTE_DIR/.next/static"
  fi
fi

# Also copy public dir if present
if [ -d "$REMOTE_DIR/public" ]; then
  echo "public dir in place"
fi

# Write .env.local — secrets must be set via environment before running this script:
#   PATCHWORK_BRIDGE_TOKEN, DASHBOARD_PASSWORD
# PATCHWORK_BRIDGE_TOKEN is the bridge auth token (from: patchwork print-token)
# DASHBOARD_PASSWORD protects the dashboard UI (leave blank to disable auth)
if [ -f "$REMOTE_DIR/.env.local" ]; then
  echo ".env.local already exists on VPS — preserving (delete manually to reset)"
else
  cat > "$REMOTE_DIR/.env.local" <<ENV
NEXT_PUBLIC_BASE_PATH=/dashboard
PATCHWORK_BRIDGE_URL=https://patchworkos.com
PATCHWORK_BRIDGE_TOKEN=${PATCHWORK_BRIDGE_TOKEN:-REPLACE_ME}
VAPID_SUBJECT=mailto:support@gigsecure.co.ke
DASHBOARD_PASSWORD=${DASHBOARD_PASSWORD:-}
ENV
  chmod 600 "$REMOTE_DIR/.env.local"
  echo "Wrote .env.local — review and update secrets if placeholders remain"
fi

# Install PM2 if missing
which pm2 || npm install -g pm2

# Start with PM2
cd "$REMOTE_DIR"
PORT=3200 pm2 start server.js --name "$PM2_NAME"

pm2 save
echo "PM2 started: $PM2_NAME on port $PORT"
REMOTE

echo "==> Configuring nginx..."
ssh "$VPS" bash <<'NGINX'
set -euo pipefail
NGINX_CONF="/etc/nginx/sites-available/patchworkos"

# Add SSE location block if missing
if ! grep -q "location /dashboard/api/bridge/stream" "$NGINX_CONF"; then
  # Insert before the closing brace of the SSL server block
  # We insert just before the last `}` that closes the server block listening on 443
  python3 - "$NGINX_CONF" <<'PYEOF'
import sys, re

path = sys.argv[1]
with open(path) as f:
    content = f.read()

sse_block = """
    # SSE passthrough — no buffering
    location /dashboard/api/bridge/stream {
        proxy_pass http://127.0.0.1:3200;
        proxy_http_version 1.1;
        proxy_buffering off;
        proxy_cache off;
        proxy_read_timeout 86400s;
        proxy_send_timeout 86400s;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        add_header X-Accel-Buffering no;
    }

    # Dashboard app
    location /dashboard {
        proxy_pass http://127.0.0.1:3200;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 60s;
    }
"""

# Find the ssl/443 server block and insert before its closing brace
# Strategy: find last `}` in file and insert before it
idx = content.rfind('\n}')
if idx == -1:
    print("ERROR: could not find closing brace in nginx config", file=sys.stderr)
    sys.exit(1)

new_content = content[:idx] + sse_block + content[idx:]
with open(path, 'w') as f:
    f.write(new_content)
print("nginx: location blocks inserted")
PYEOF
else
  echo "nginx: location blocks already present, skipping"
fi

nginx -t && systemctl reload nginx
echo "nginx reloaded"
NGINX

echo ""
echo "==> Deploy complete!"
echo "    Dashboard: https://patchworkos.com/dashboard"
