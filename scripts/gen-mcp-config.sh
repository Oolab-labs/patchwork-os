#!/usr/bin/env bash
# Generate MCP configuration for connecting an IDE or agent to the claude-ide-bridge.
#
# Usage:
#   bash scripts/gen-mcp-config.sh <target> [--write]
#
# Targets:
#   cursor        Outputs .cursor/mcp.json content
#   antigravity   Outputs mcp_config.json content for Google Antigravity
#   codex         Outputs ~/.codex/config.toml section for OpenAI Codex CLI
#
# Flags:
#   --write       Write the config to the correct location (asks confirmation)
#
# Example:
#   bash scripts/gen-mcp-config.sh cursor
#   bash scripts/gen-mcp-config.sh codex --write

set -euo pipefail

CLAUDE_DIR="${CLAUDE_CONFIG_DIR:-$HOME/.claude}"
LOCK_DIR="$CLAUDE_DIR/ide"

TARGET="${1:-}"
WRITE=false

for arg in "$@"; do
  [[ "$arg" == "--write" ]] && WRITE=true
done

# --- Usage ---
if [[ -z "$TARGET" || "$TARGET" == "--help" || "$TARGET" == "-h" ]]; then
  echo "Usage: $0 <target> [--write]"
  echo ""
  echo "Targets: cursor | antigravity | codex"
  echo "  cursor        .cursor/mcp.json"
  echo "  antigravity   mcp_config.json for Google Antigravity"
  echo "  codex         ~/.codex/config.toml section for OpenAI Codex CLI"
  echo ""
  echo "Flags:"
  echo "  --write   Write config to the correct location"
  exit 0
fi

# --- Find the most recent valid lock file ---
find_lock() {
  local best_lock=""
  local best_mtime=0
  for lock in "$LOCK_DIR"/*.lock 2>/dev/null; do
    [[ -f "$lock" ]] || continue
    mtime=$(stat -f "%m" "$lock" 2>/dev/null || stat -c "%Y" "$lock" 2>/dev/null || echo 0)
    if (( mtime > best_mtime )); then
      best_mtime=$mtime
      best_lock=$lock
    fi
  done
  echo "$best_lock"
}

LOCK_FILE=$(find_lock)

if [[ -z "$LOCK_FILE" ]]; then
  echo "Error: No bridge lock file found in $LOCK_DIR" >&2
  echo "Make sure the bridge is running first: npm run start-all" >&2
  exit 1
fi

# Parse lock file (requires python3 or jq)
parse_lock() {
  local field="$1"
  if command -v python3 >/dev/null 2>&1; then
    python3 -c "import json,sys; d=json.load(open('$LOCK_FILE')); print(d['$field'])"
  elif command -v jq >/dev/null 2>&1; then
    jq -r ".$field" "$LOCK_FILE"
  else
    echo "Error: python3 or jq is required to parse lock file" >&2
    exit 1
  fi
}

PORT=$(parse_lock "authToken" 2>/dev/null || true)
# Actually parse port and authToken
PORT=$(basename "$LOCK_FILE" .lock)
AUTH_TOKEN=$(parse_lock "authToken")

WS_URL="ws://127.0.0.1:${PORT}"
HTTP_URL="http://127.0.0.1:${PORT}"

echo "Found bridge: port=${PORT} lock=$(basename "$LOCK_FILE")"
echo ""

# --- Generate config per target ---
case "$TARGET" in
  cursor)
    OUTPUT_PATH="${HOME}/.cursor/mcp.json"
    CONFIG=$(cat <<EOF
{
  "mcpServers": {
    "claude-ide-bridge": {
      "url": "${WS_URL}",
      "headers": {
        "x-claude-ide-extension": "${AUTH_TOKEN}"
      }
    }
  }
}
EOF
)
    echo "=== Cursor MCP config (.cursor/mcp.json or project/.cursor/mcp.json) ==="
    echo "$CONFIG"
    ;;

  antigravity)
    OUTPUT_PATH="${HOME}/.antigravity/mcp_config.json"
    CONFIG=$(cat <<EOF
{
  "mcpServers": {
    "claude-ide-bridge": {
      "transport": "websocket",
      "url": "${WS_URL}",
      "headers": {
        "x-claude-ide-extension": "${AUTH_TOKEN}"
      }
    }
  }
}
EOF
)
    echo "=== Google Antigravity MCP config ==="
    echo "(In Antigravity: Agent session → dropdown → Manage MCP Servers → edit mcp_config.json)"
    echo ""
    echo "$CONFIG"
    ;;

  codex)
    OUTPUT_PATH="${HOME}/.codex/config.toml"
    # Codex CLI supports stdio and streamable HTTP — use the bridge's HTTP endpoint
    CONFIG=$(cat <<EOF
# Add this to ~/.codex/config.toml to connect to claude-ide-bridge
# The bridge must be running before starting codex.

[mcp_servers.claude-ide-bridge]
# Streamable HTTP transport (bridge HTTP server)
url = "${HTTP_URL}/mcp"
http_headers = { "x-claude-ide-extension" = "${AUTH_TOKEN}" }
enabled = true
EOF
)
    echo "=== OpenAI Codex CLI MCP config (~/.codex/config.toml) ==="
    echo "$CONFIG"
    echo ""
    echo "Note: The bridge must expose a /mcp streamable HTTP endpoint."
    echo "If it doesn't yet, use the stdio shim instead:"
    echo "  command = \"node\""
    echo "  args = [\"$(cd "$(dirname "$0")/.." && pwd)/scripts/mcp-stdio-shim.js\", \"${PORT}\", \"${AUTH_TOKEN}\"]"
    ;;

  *)
    echo "Error: Unknown target '$TARGET'. Use: cursor | antigravity | codex" >&2
    exit 1
    ;;
esac

# --- Write mode ---
if $WRITE; then
  echo ""
  echo "Write to: $OUTPUT_PATH"
  read -r -p "Confirm? [y/N] " confirm
  if [[ "$confirm" =~ ^[Yy]$ ]]; then
    # Back up existing file
    if [[ -f "$OUTPUT_PATH" ]]; then
      cp "$OUTPUT_PATH" "${OUTPUT_PATH}.bak"
      echo "Backed up existing config to ${OUTPUT_PATH}.bak"
    fi
    mkdir -p "$(dirname "$OUTPUT_PATH")"
    echo "$CONFIG" > "$OUTPUT_PATH"
    echo "Written: $OUTPUT_PATH"
  else
    echo "Aborted."
  fi
fi
