#!/usr/bin/env bash
# Generate or update claude_desktop_config.json so Claude Desktop connects
# to the running claude-ide-bridge via the stdio shim.
#
# Run with `bash`, do not source this script.
#
# Usage:
#   bash scripts/gen-claude-desktop-config.sh          # Print config
#   bash scripts/gen-claude-desktop-config.sh --write   # Write to config file
#
# The shim auto-discovers the running bridge via lock files in ~/.claude/ide/.
# No port or token needs to be hard-coded -- just start the bridge first.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SHIM_PATH="${SCRIPT_DIR}/mcp-stdio-shim.cjs"

# --- Detect config path ---
if [[ "$(uname)" == "Darwin" ]]; then
  CONFIG_PATH="${HOME}/Library/Application Support/Claude/claude_desktop_config.json"
else
  CONFIG_PATH="${APPDATA:-${HOME}/.config}/Claude/claude_desktop_config.json"
fi

WRITE=false
for arg in "$@"; do
  case "$arg" in
    --write) WRITE=true ;;
    --help|-h)
      echo "Usage: $0 [--write]"
      echo ""
      echo "Generates a claude_desktop_config.json entry so Claude Desktop"
      echo "connects to the running claude-ide-bridge via the stdio shim."
      echo ""
      echo "  --write   Merge into ${CONFIG_PATH}"
      echo "            (backs up existing config first)"
      exit 0
      ;;
  esac
done

# --- Verify shim exists ---
if [[ ! -f "$SHIM_PATH" ]]; then
  echo "Error: stdio shim not found at $SHIM_PATH" >&2
  echo "Make sure you're running this from the bridge repo." >&2
  exit 1
fi

# --- Verify bridge is running (optional, warn only) ---
CLAUDE_DIR="${CLAUDE_CONFIG_DIR:-$HOME/.claude}"
LOCK_DIR="$CLAUDE_DIR/ide"
LOCK_COUNT=$(find "$LOCK_DIR" -maxdepth 1 -name "*.lock" 2>/dev/null | wc -l | tr -d ' ')
if [[ "$LOCK_COUNT" -eq 0 ]]; then
  echo "Warning: No bridge lock files found. Start the bridge first (npm run start-all)." >&2
  echo "The config will still be generated -- the shim will connect when the bridge starts." >&2
  echo ""
fi

# --- Build or merge config ---
# Pass SHIM_PATH via env var to avoid path injection in python -c string
if [[ -f "$CONFIG_PATH" ]]; then
  MERGED=$(SHIM_PATH="$SHIM_PATH" CONFIG_PATH="$CONFIG_PATH" python3 - <<'PYEOF'
import json, os, sys
shim = os.environ["SHIM_PATH"]
config_path = os.environ["CONFIG_PATH"]
try:
    with open(config_path, "r") as f:
        config = json.load(f)
except (json.JSONDecodeError, FileNotFoundError):
    config = {}
if "mcpServers" not in config:
    config["mcpServers"] = {}
config["mcpServers"]["claude-ide-bridge"] = {
    "command": "node",
    "args": [shim]
}
print(json.dumps(config, indent=2))
PYEOF
)
else
  MERGED=$(SHIM_PATH="$SHIM_PATH" python3 - <<'PYEOF'
import json, os
shim = os.environ["SHIM_PATH"]
config = {
    "mcpServers": {
        "claude-ide-bridge": {
            "command": "node",
            "args": [shim]
        }
    }
}
print(json.dumps(config, indent=2))
PYEOF
)
fi

echo "=== Claude Desktop MCP Config ==="
echo "Config path: $CONFIG_PATH"
echo ""
echo "$MERGED"

if $WRITE; then
  echo ""
  # Atomic write: write to .tmp then mv to prevent partial writes
  TMP_PATH="${CONFIG_PATH}.tmp"
  mkdir -p "$(dirname "$CONFIG_PATH")"
  # Back up existing config with timestamp to avoid clobbering previous backups
  if [[ -f "$CONFIG_PATH" ]]; then
    BACKUP="${CONFIG_PATH}.$(date +%Y%m%d%H%M%S).bak"
    cp "$CONFIG_PATH" "$BACKUP"
    echo "Backed up existing config to $(basename "$BACKUP")"
  fi
  printf '%s\n' "$MERGED" > "$TMP_PATH"
  mv "$TMP_PATH" "$CONFIG_PATH"
  echo "Written: $CONFIG_PATH"
  echo ""
  echo "Restart Claude Desktop to pick up the new config."
  echo "Then ask Claude: \"What files are open in my IDE?\""
else
  echo ""
  echo "Run with --write to save this config, or copy it manually to:"
  echo "  $CONFIG_PATH"
fi
