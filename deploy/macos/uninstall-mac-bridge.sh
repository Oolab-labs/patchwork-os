#!/usr/bin/env bash
# uninstall-mac-bridge.sh — stop + remove the patchwork bridge and tunnel
# LaunchAgents installed by install-mac-bridge.sh.

set -euo pipefail

if [[ "$OSTYPE" != "darwin"* ]]; then
  echo "macOS only." >&2
  exit 1
fi

BRIDGE_PLIST="$HOME/Library/LaunchAgents/com.patchwork.bridge.plist"
TUNNEL_PLIST="$HOME/Library/LaunchAgents/com.patchwork.tunnel.plist"

# bootout: stop + remove the service registration. `|| true` so the
# script doesn't fail when one of them isn't installed.
launchctl bootout "gui/$UID" "$BRIDGE_PLIST" 2>/dev/null || true
launchctl bootout "gui/$UID" "$TUNNEL_PLIST" 2>/dev/null || true

rm -f "$BRIDGE_PLIST" "$TUNNEL_PLIST"

echo "Uninstalled. Logs preserved at ~/Library/Logs/patchwork-{bridge,tunnel}.log"
