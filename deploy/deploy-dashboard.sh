#!/usr/bin/env bash
# deploy-dashboard.sh — Build dashboard locally and deploy to VPS
# Run from Mac: bash deploy/deploy-dashboard.sh
set -euo pipefail

# Deployment target. REQUIRED, and deliberately without a default.
#
# This used to be a hardcoded `root@<ip>` pointing at one specific server.
# That address was later reassigned by the hosting provider to an unrelated
# customer, and the script kept pointing at it — while line ~48 passes
# PATCHWORK_BRIDGE_TOKEN and DASHBOARD_PASSWORD to whatever host it names.
# A deploy script that guesses its target is the bug; refusing to guess is
# the fix. Nothing here is secret, but a wrong default aims real
# credentials at a real stranger.
if [ -z "${PATCHWORK_VPS:-}" ]; then
  cat >&2 <<'ERR'
error: PATCHWORK_VPS is not set.

  Set it to the ssh destination for YOUR server, e.g.

      PATCHWORK_VPS=root@203.0.113.10  bash deploy/deploy-dashboard.sh
      PATCHWORK_VPS=deploy@example.com bash deploy/deploy-dashboard.sh

  An ssh config alias works too (see deploy/macos/README.md).

  There is no default on purpose: this script sends deployment
  credentials to whatever host it is given.
ERR
  exit 1
fi
VPS="$PATCHWORK_VPS"

# Site-specific settings. These defaults suit a single-site install; override
# per deployment. They are NOT secrets — they are paths and process names.
REMOTE_DIR="${PATCHWORK_REMOTE_DIR:-/opt/patchwork-dashboard}"
PM2_NAME="${PATCHWORK_PM2_NAME:-patchwork-dashboard}"
PORT="${PATCHWORK_DASHBOARD_PORT:-3200}"
NGINX_CONF="${PATCHWORK_NGINX_CONF:-/etc/nginx/sites-available/patchwork}"
DASHBOARD_URL="${PATCHWORK_DASHBOARD_URL:-https://your.tld/dashboard}"
# Written into the remote .env.local. VAPID_SUBJECT must be a mailto: you own.
BRIDGE_URL="${PATCHWORK_BRIDGE_URL:-https://your.tld}"
VAPID_SUBJECT="${PATCHWORK_VAPID_SUBJECT:-mailto:admin@your.tld}"

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
# Pass secrets as positional args (NOT inside the heredoc body) so the
# single-quoted heredoc still preserves remote-shell `$X` references but
# the operator's local env reaches the VPS. Without this, the previous
# `${PATCHWORK_BRIDGE_TOKEN:-REPLACE_ME}` inside the heredoc evaluated on
# the remote, where the var doesn't exist, and always wrote REPLACE_ME.
# shellcheck disable=SC2087
ssh "$VPS" bash -s -- \
  "${PATCHWORK_BRIDGE_TOKEN:-REPLACE_ME}" "${DASHBOARD_PASSWORD:-}" \
  "$REMOTE_DIR" "$PM2_NAME" "$PORT" "$BRIDGE_URL" "$VAPID_SUBJECT" <<'REMOTE'
set -euo pipefail
# `${N:-}` so an empty/missing positional arg doesn't trip `set -u`.
#
# The site settings are passed in rather than repeated here. They used to be
# declared twice — once locally and once inside this heredoc — so overriding
# the local copy silently changed nothing on the remote side. Two sources of
# truth for the same path is a bug waiting for someone to trust the wrong one.
PATCHWORK_BRIDGE_TOKEN="${1:-REPLACE_ME}"
DASHBOARD_PASSWORD="${2:-}"
REMOTE_DIR="${3:-/opt/patchwork-dashboard}"
PM2_NAME="${4:-patchwork-dashboard}"
PORT="${5:-3200}"
BRIDGE_URL="${6:-https://your.tld}"
VAPID_SUBJECT="${7:-mailto:admin@your.tld}"

# Stop existing PM2 process if running
if pm2 list | grep -q "$PM2_NAME"; then
  pm2 stop "$PM2_NAME" || true
  pm2 delete "$PM2_NAME" || true
fi

# Preserve .env.local across the deploy. Without this stash/restore, the
# `rm -rf "$REMOTE_DIR"` below blows away every secret the operator pasted
# (VAPID, PATCHWORK_PUSH_TOKEN, custom DASHBOARD_PASSWORD), and the "if
# already exists, preserve" branch later in this script never fires —
# the file no longer exists by then.
ENV_BACKUP=""
if [ -f "$REMOTE_DIR/.env.local" ]; then
  ENV_BACKUP="$(mktemp /tmp/patchwork-env.XXXXXX)"
  cp -p "$REMOTE_DIR/.env.local" "$ENV_BACKUP"
fi

# Wipe and recreate deploy dir
rm -rf "$REMOTE_DIR"
mkdir -p "$REMOTE_DIR"

if [ -n "$ENV_BACKUP" ] && [ -f "$ENV_BACKUP" ]; then
  cp -p "$ENV_BACKUP" "$REMOTE_DIR/.env.local"
  rm -f "$ENV_BACKUP"
fi

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
PATCHWORK_BRIDGE_URL=${BRIDGE_URL}
PATCHWORK_BRIDGE_TOKEN=${PATCHWORK_BRIDGE_TOKEN:-REPLACE_ME}
VAPID_SUBJECT=${VAPID_SUBJECT}
DASHBOARD_PASSWORD=${DASHBOARD_PASSWORD:-}
ENV
  chmod 600 "$REMOTE_DIR/.env.local"
  echo "Wrote .env.local — review and update secrets if placeholders remain"
fi

# Install PM2 if missing
which pm2 || npm install -g pm2

# Start with PM2
cd "$REMOTE_DIR"
PORT="$PORT" pm2 start server.js --name "$PM2_NAME"

pm2 save
echo "PM2 started: $PM2_NAME on port $PORT"
REMOTE

echo "==> Configuring nginx..."
ssh "$VPS" bash -s -- "$NGINX_CONF" "$PORT" <<'NGINX'
set -euo pipefail
# Passed in, not repeated — see the note on the REMOTE heredoc above.
NGINX_CONF="${1:?nginx conf path not passed}"
# The proxy_pass port MUST track the port pm2 starts the app on. These were
# two independent literals; making the port configurable without threading it
# here would have produced a proxy pointing at nothing.
APP_PORT="${2:?app port not passed}"

# Add SSE location block if missing
if ! grep -q "location /dashboard/api/bridge/stream" "$NGINX_CONF"; then
  # Insert before the closing brace of the SSL server block
  # We insert just before the last `}` that closes the server block listening on 443
  python3 - "$NGINX_CONF" "$APP_PORT" <<'PYEOF'
import sys, re

path = sys.argv[1]
port = sys.argv[2]
with open(path) as f:
    content = f.read()

sse_block = f"""
    # SSE passthrough — no buffering
    location /dashboard/api/bridge/stream {{
        proxy_pass http://127.0.0.1:{port};
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
    }}

    # Dashboard app
    location /dashboard {{
        proxy_pass http://127.0.0.1:{port};
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 60s;
    }}
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
echo "    Dashboard: $DASHBOARD_URL"
