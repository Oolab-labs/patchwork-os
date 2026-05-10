#!/usr/bin/env bash
# install-mac-bridge.sh — make the bridge + reverse tunnel persistent on macOS
# via launchd LaunchAgents (auto-start at login, auto-restart on crash,
# auto-reconnect on network change via autossh).
#
# Usage (interactive):
#   bash deploy/macos/install-mac-bridge.sh
#
# Usage (env-driven, idempotent re-install):
#   VPS_HOST=185.167.97.141 VPS_USER=root BRIDGE_PORT=63906 \
#   VPS_PORT=3285 BRIDGE_TOKEN="$(uuidgen | tr '[:upper:]' '[:lower:]')" \
#   bash deploy/macos/install-mac-bridge.sh
#
# Tip: prefer the VPS IP (or a `~/.ssh/config` Host alias) over the
# public domain. The domain may resolve via DNS that drifts, putting
# you on a different machine after a redeploy and breaking host-key
# verification. The IP is whatever your deploy script targets — a
# stable identity across rebuilds.
#
# Using a ~/.ssh/config alias (cleanest):
#   # in ~/.ssh/config:
#   #   Host pw-bridge
#   #       HostName 185.167.97.141
#   #       User wesh
#   #       IdentityFile ~/.ssh/id_ed25519
#   VPS_HOST=pw-bridge VPS_USER=wesh \
#   bash deploy/macos/install-mac-bridge.sh
#   # → tunnel.plist uses `pw-bridge` as the SSH target (User from
#   #   ssh_config wins over the plist's user@host form when an alias
#   #   exists; we still set both so the resolution is explicit).
#
# After install:
#   tail -f ~/Library/Logs/patchwork-bridge.log
#   tail -f ~/Library/Logs/patchwork-tunnel.log
#
# Update VPS .env.local PATCHWORK_BRIDGE_TOKEN to match the printed token,
# then `pm2 restart patchwork-dashboard` on the VPS.
#
# Uninstall: bash deploy/macos/uninstall-mac-bridge.sh

set -euo pipefail

# ──────────────────────────────────────────────────────────────────────
# Sanity checks
# ──────────────────────────────────────────────────────────────────────

if [[ "$OSTYPE" != "darwin"* ]]; then
  echo "This script is for macOS (launchd). Detected: $OSTYPE" >&2
  exit 1
fi

if ! command -v claude-ide-bridge >/dev/null 2>&1; then
  echo "claude-ide-bridge not found on PATH." >&2
  echo "Install with:  npm install -g patchwork-os" >&2
  exit 1
fi

# Real-path resolution: a symlinked global install (npm link) breaks the
# LaunchAgent because launchd's sandbox follows the symlink target into
# ~/Documents and EPERMs on file IO. Recommend a real install.
BRIDGE_REAL="$(readlink -f "$(command -v claude-ide-bridge)" 2>/dev/null || \
               python3 -c "import os,sys; print(os.path.realpath('$(command -v claude-ide-bridge)'))")"
case "$BRIDGE_REAL" in
  *Documents*|*Desktop*|*Downloads*)
    echo "⚠️  claude-ide-bridge is symlinked into a sandboxed user-data folder:"
    echo "   $BRIDGE_REAL"
    echo "   LaunchAgent startup will fail with EPERM under the macOS sandbox."
    echo "   Fix: cd to the patchwork-os repo, run \`npm pack && npm install -g patchwork-os-*.tgz\`"
    echo "   Or: \`npm install -g patchwork-os\` from the public registry."
    echo ""
    read -p "   Continue anyway? [y/N] " -r yn
    [[ "$yn" =~ ^[Yy]$ ]] || exit 1
    ;;
esac

if ! command -v autossh >/dev/null 2>&1; then
  echo "autossh not found. Installing via Homebrew…"
  if ! command -v brew >/dev/null 2>&1; then
    echo "Homebrew not found. Install from https://brew.sh and re-run." >&2
    exit 1
  fi
  brew install autossh
fi

# ──────────────────────────────────────────────────────────────────────
# Gather config (env-driven with interactive fallback)
# ──────────────────────────────────────────────────────────────────────

VPS_HOST="${VPS_HOST:-}"
VPS_USER="${VPS_USER:-$USER}"
BRIDGE_PORT="${BRIDGE_PORT:-63906}"
VPS_PORT="${VPS_PORT:-3285}"
BRIDGE_TOKEN="${BRIDGE_TOKEN:-}"
WORKSPACE="${WORKSPACE:-$PWD}"
SSH_KEY="${SSH_KEY:-$HOME/.ssh/id_ed25519}"
[[ -f "$SSH_KEY" ]] || SSH_KEY="$HOME/.ssh/id_rsa"

if [[ -z "$VPS_HOST" ]]; then
  cat <<'PROMPT'

VPS target — three choices, in increasing order of stability:

  (1) Public domain     e.g. bridge.your.tld
      DNS-resolved each connection. Drifts during redeploys → host-key churn.

  (2) VPS IP            e.g. 185.167.97.141
      Stable per VPS. Doesn't survive a VPS rebuild but doesn't drift between.

  (3) ~/.ssh/config alias  e.g. pw-bridge
      Most stable. Pins IP + identity in one place; the rest of the
      stack (this script, deploy.sh, manual ssh) all use the alias.
      Update one ssh_config entry on a rebuild, everything follows.

PROMPT
  read -p "VPS host (IP or ssh alias preferred): " VPS_HOST
fi
if [[ -z "$VPS_HOST" ]]; then
  echo "VPS host is required." >&2
  exit 1
fi

# When VPS_HOST is a ~/.ssh/config alias, ssh resolves both User and
# HostName from the config, so VPS_USER becomes redundant. The plist
# still passes user@host to be explicit (and to support the IP-direct
# case where ssh_config has nothing). If `ssh -G $VPS_HOST` reports a
# resolved hostname different from VPS_HOST, treat that as confirmation
# the value is an alias.
if ssh -G "$VPS_HOST" 2>/dev/null | awk '$1 == "hostname"' | grep -qv "^hostname $VPS_HOST$"; then
  echo "Detected '$VPS_HOST' is a ~/.ssh/config alias — host + identity resolved from there."
  IS_SSH_ALIAS=1
else
  IS_SSH_ALIAS=0
fi

if [[ -z "$BRIDGE_TOKEN" ]]; then
  if command -v uuidgen >/dev/null 2>&1; then
    BRIDGE_TOKEN="$(uuidgen)"
  else
    BRIDGE_TOKEN="$(python3 -c 'import uuid; print(uuid.uuid4())')"
  fi
  echo "Generated bridge token: $BRIDGE_TOKEN"
fi

if [[ ! -f "$SSH_KEY" ]]; then
  echo "SSH key not found: $SSH_KEY" >&2
  echo "Either set SSH_KEY=... or generate one with \`ssh-keygen -t ed25519\`." >&2
  exit 1
fi

# ──────────────────────────────────────────────────────────────────────
# Render templates
# ──────────────────────────────────────────────────────────────────────

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LAUNCH_AGENTS="$HOME/Library/LaunchAgents"
LOGS="$HOME/Library/Logs"
BRIDGE_BIN="$(command -v claude-ide-bridge)"
AUTOSSH_BIN="$(command -v autossh)"

mkdir -p "$LAUNCH_AGENTS" "$LOGS"

# SSH target string: bare alias when VPS_HOST is a `~/.ssh/config` Host
# entry, "user@host" form otherwise. The alias case lets ssh_config own
# user + identity + hostname resolution, which is the most stable setup
# (one place to update on a VPS rebuild).
if [ "$IS_SSH_ALIAS" = "1" ]; then
  SSH_TARGET="$VPS_HOST"
  echo "SSH target: $SSH_TARGET (resolved via ~/.ssh/config)"
else
  SSH_TARGET="$VPS_USER@$VPS_HOST"
  echo "SSH target: $SSH_TARGET"
fi

render() {
  local tmpl="$1" out="$2"
  sed \
    -e "s|{{BRIDGE_BIN}}|$BRIDGE_BIN|g" \
    -e "s|{{AUTOSSH_BIN}}|$AUTOSSH_BIN|g" \
    -e "s|{{BRIDGE_PORT}}|$BRIDGE_PORT|g" \
    -e "s|{{VPS_PORT}}|$VPS_PORT|g" \
    -e "s|{{BRIDGE_TOKEN}}|$BRIDGE_TOKEN|g" \
    -e "s|{{VPS_HOST}}|$VPS_HOST|g" \
    -e "s|{{SSH_USER}}|$VPS_USER|g" \
    -e "s|{{SSH_TARGET}}|$SSH_TARGET|g" \
    -e "s|{{SSH_KEY}}|$SSH_KEY|g" \
    -e "s|{{WORKSPACE}}|$WORKSPACE|g" \
    -e "s|{{HOME}}|$HOME|g" \
    "$tmpl" >"$out"
}

BRIDGE_PLIST="$LAUNCH_AGENTS/com.patchwork.bridge.plist"
TUNNEL_PLIST="$LAUNCH_AGENTS/com.patchwork.tunnel.plist"

render "$SCRIPT_DIR/com.patchwork.bridge.plist.template" "$BRIDGE_PLIST"
render "$SCRIPT_DIR/com.patchwork.tunnel.plist.template" "$TUNNEL_PLIST"

# Tighten permissions — these contain the bridge token.
chmod 600 "$BRIDGE_PLIST" "$TUNNEL_PLIST"

# ──────────────────────────────────────────────────────────────────────
# (Re)load
# ──────────────────────────────────────────────────────────────────────

# bootout removes the old service if present (idempotent re-install).
# Errors are non-fatal — first run won't have anything to bootout.
launchctl bootout "gui/$UID" "$BRIDGE_PLIST" 2>/dev/null || true
launchctl bootout "gui/$UID" "$TUNNEL_PLIST" 2>/dev/null || true

launchctl bootstrap "gui/$UID" "$BRIDGE_PLIST"
launchctl bootstrap "gui/$UID" "$TUNNEL_PLIST"

launchctl enable "gui/$UID/com.patchwork.bridge"
launchctl enable "gui/$UID/com.patchwork.tunnel"

# ──────────────────────────────────────────────────────────────────────
# Status
# ──────────────────────────────────────────────────────────────────────

cat <<INFO

────────────────────────────────────────────────────────────────────────
Installed.

  Bridge: 127.0.0.1:$BRIDGE_PORT
  Tunnel: -> $SSH_TARGET:$VPS_PORT
  Token:  $BRIDGE_TOKEN

Logs:
  ~/Library/Logs/patchwork-bridge.log
  ~/Library/Logs/patchwork-tunnel.log

Status:
  launchctl print gui/$UID/com.patchwork.bridge
  launchctl print gui/$UID/com.patchwork.tunnel

Update the VPS dashboard's PATCHWORK_BRIDGE_TOKEN to match the token
above, then \`pm2 restart patchwork-dashboard\` on the VPS so the new
token takes effect:

  ssh $SSH_TARGET 'sed -i "s|^PATCHWORK_BRIDGE_TOKEN=.*|PATCHWORK_BRIDGE_TOKEN=$BRIDGE_TOKEN|" /opt/patchwork-dashboard/.env.local && pm2 restart patchwork-dashboard'

Uninstall: bash deploy/macos/uninstall-mac-bridge.sh
────────────────────────────────────────────────────────────────────────
INFO
