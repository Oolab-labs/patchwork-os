#!/usr/bin/env bash
# Generate MCP configuration for connecting an IDE or agent to the claude-ide-bridge.
#
# Usage:
#   bash scripts/gen-mcp-config.sh <target> [--write]
#
# Targets:
#   cursor           Outputs .cursor/mcp.json content
#   antigravity      Outputs mcp_config.json content for Google Antigravity
#   codex            Outputs ~/.codex/config.toml section for OpenAI Codex CLI
#   claude-desktop   Outputs claude_desktop_config.json entry for Claude Desktop app
#
# Flags:
#   --write       Write the config to the correct location (asks confirmation)
#
# Example:
#   bash scripts/gen-mcp-config.sh cursor
#   bash scripts/gen-mcp-config.sh codex --write
#   bash scripts/gen-mcp-config.sh claude-web --host mybridge.example.com --token <tok>

set -euo pipefail

CLAUDE_DIR="${CLAUDE_CONFIG_DIR:-$HOME/.claude}"
LOCK_DIR="$CLAUDE_DIR/ide"

TARGET="${1:-}"
WRITE=false
REMOTE_HOST=""
REMOTE_TOKEN=""

# Parse flags (handle --host <val> and --token <val> for the remote target)
_argv=("$@")
for (( _i=1; _i<${#_argv[@]}; _i++ )); do
  case "${_argv[$_i]}" in
    --write) WRITE=true ;;
    --host)  REMOTE_HOST="${_argv[$((_i+1))]:-}"; ((_i++)) ;;
    --token) REMOTE_TOKEN="${_argv[$((_i+1))]:-}"; ((_i++)) ;;
  esac
done

# --- Usage ---
if [[ -z "$TARGET" || "$TARGET" == "--help" || "$TARGET" == "-h" ]]; then
  echo "Usage: $0 <target> [--write]"
  echo ""
  echo "Targets: cursor | antigravity | codex | claude-desktop | remote | claude-web"
  echo "  cursor           .cursor/mcp.json"
  echo "  antigravity      mcp_config.json for Google Antigravity"
  echo "  codex            ~/.codex/config.toml section for OpenAI Codex CLI"
  echo "  claude-desktop   claude_desktop_config.json for Claude Desktop app"
  echo "  remote           ~/.claude/mcp.json entry for a remote bridge over HTTP"
  echo "                   Requires: --host <host:port> --token <token>"
  echo "  claude-web       Custom Connector snippet for claude.ai web"
  echo "                   Requires: --host <host:port> --token <token>"
  echo ""
  echo "Flags:"
  echo "  --write          Write config to the correct location (not applicable for claude-web)"
  echo "  --host <h:port>  Remote host and port (remote / claude-web targets)"
  echo "  --token <tok>    Auth token (remote / claude-web targets; get via: claude-ide-bridge print-token)"
  exit 0
fi

# --- Find the most recent valid lock file ---
find_lock() {
  local best_lock=""
  local best_mtime=0
  local locks
  locks=$(find "$LOCK_DIR" -maxdepth 1 -name "*.lock" 2>/dev/null) || true
  for lock in $locks; do
    [[ -f "$lock" ]] || continue
    mtime=$(stat -f "%m" "$lock" 2>/dev/null || stat -c "%Y" "$lock" 2>/dev/null || echo 0)
    if (( mtime > best_mtime )); then
      best_mtime=$mtime
      best_lock=$lock
    fi
  done
  echo "$best_lock"
}

# claude-desktop target does not need a running bridge -- delegate to the dedicated script
if [[ "$TARGET" == "claude-desktop" ]]; then
  DEDICATED="${BASH_SOURCE[0]%/*}/gen-claude-desktop-config.sh"
  if [[ -f "$DEDICATED" ]]; then
    exec bash "$DEDICATED" ${WRITE:+--write}
  fi
  # Fallback inline if dedicated script is missing
  SHIM_PATH="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/mcp-stdio-shim.cjs"
  if [[ "$(uname)" == "Darwin" ]]; then
    OUTPUT_PATH="${HOME}/Library/Application Support/Claude/claude_desktop_config.json"
  else
    OUTPUT_PATH="${APPDATA:-${HOME}/.config}/Claude/claude_desktop_config.json"
  fi
  CONFIG=$(SHIM_PATH="$SHIM_PATH" python3 - <<'PYEOF'
import json, os
shim = os.environ["SHIM_PATH"]
print(json.dumps({"mcpServers": {"claude-ide-bridge": {"command": "node", "args": [shim]}}}, indent=2))
PYEOF
)
  echo "=== Claude Desktop MCP config ==="
  echo "Path: $OUTPUT_PATH"
  echo ""
  echo "$CONFIG"
  echo ""
  echo "The shim auto-discovers the running bridge via lock files."
  echo "Restart Claude Desktop after writing the config."
  if $WRITE; then
    TMP_PATH="${OUTPUT_PATH}.tmp"
    mkdir -p "$(dirname "$OUTPUT_PATH")"
    if [[ -f "$OUTPUT_PATH" ]]; then
      cp "$OUTPUT_PATH" "${OUTPUT_PATH}.$(date +%Y%m%d%H%M%S).bak"
    fi
    printf '%s\n' "$CONFIG" > "$TMP_PATH"
    mv "$TMP_PATH" "$OUTPUT_PATH"
    echo "Written: $OUTPUT_PATH"
  fi
  exit 0
fi

# --- Remote target: no lock file needed — caller supplies host and token ---
if [[ "$TARGET" == "remote" ]]; then
  if [[ -z "$REMOTE_HOST" || -z "$REMOTE_TOKEN" ]]; then
    echo "Error: remote target requires --host <host:port> and --token <token>" >&2
    echo "  Get the token with: claude-ide-bridge print-token" >&2
    exit 1
  fi
  OUTPUT_PATH="${HOME}/.claude/mcp.json"
  CONFIG=$(cat <<EOF
{
  "mcpServers": {
    "claude-ide-bridge-remote": {
      "type": "http",
      "url": "http://${REMOTE_HOST}/mcp",
      "headers": {
        "Authorization": "Bearer ${REMOTE_TOKEN}"
      }
    }
  }
}
EOF
)
  echo "=== Remote bridge MCP config ==="
  echo "Bridge: http://${REMOTE_HOST}/mcp"
  echo ""
  echo "$CONFIG"
  echo ""
  echo "Note: Use HTTPS in production — put nginx or Caddy in front with TLS."
  echo "Tip:  Claude Code supports \${VAR:-default} in .mcp.json. Replace the token value"
  echo "      with \${BRIDGE_TOKEN} and set BRIDGE_TOKEN in your shell profile to avoid"
  echo "      storing the token in the config file. See docs/remote-access.md for details."
  if $WRITE; then
    TMP_PATH="${OUTPUT_PATH}.tmp"
    mkdir -p "$(dirname "$OUTPUT_PATH")"
    if [[ -f "$OUTPUT_PATH" ]]; then
      BACKUP="${OUTPUT_PATH}.$(date +%Y%m%d%H%M%S).bak"
      cp "$OUTPUT_PATH" "$BACKUP"
      echo "Backed up existing config to $(basename "$BACKUP")"
    fi
    printf '%s\n' "$CONFIG" > "$TMP_PATH"
    mv "$TMP_PATH" "$OUTPUT_PATH"
    echo "Written: $OUTPUT_PATH"
  fi
  exit 0
fi

# --- Claude.ai Web Custom Connector target ---
if [[ "$TARGET" == "claude-web" ]]; then
  if [[ -z "$REMOTE_HOST" || -z "$REMOTE_TOKEN" ]]; then
    echo "Error: claude-web target requires --host <host:port> and --token <token>" >&2
    echo "  The bridge must be behind a reverse proxy with TLS for claude.ai to reach it." >&2
    echo "  Get the token with: claude-ide-bridge print-token" >&2
    exit 1
  fi
  # claude.ai Custom Connectors use HTTPS — warn if http:// is implied (no scheme in host)
  if [[ "$REMOTE_HOST" != https://* && "$REMOTE_HOST" != http://* ]]; then
    CONNECTOR_URL="https://${REMOTE_HOST}/mcp"
  else
    CONNECTOR_URL="${REMOTE_HOST}/mcp"
  fi
  echo "=== claude.ai Web — Custom Connector settings ==="
  echo ""
  echo "1. Go to claude.ai → Settings → Custom Connectors → Add connector"
  echo "2. Enter the following:"
  echo ""
  echo "   Name:      Claude IDE Bridge"
  echo "   URL:       ${CONNECTOR_URL}"
  echo "   Auth:      Bearer token"
  echo "   Token:     ${REMOTE_TOKEN}"
  echo ""
  echo "Note: The bridge must be reachable over HTTPS from the public internet."
  echo "      See docs/remote-access.md for a production-ready Caddy/nginx TLS setup."
  echo "Tip:  Rotate the token with: claude-ide-bridge rotate-token"
  echo "      Then update the connector's token in claude.ai settings."
  exit 0
fi

LOCK_FILE=$(find_lock)

if [[ -z "$LOCK_FILE" ]]; then
  echo "Error: No bridge lock file found in $LOCK_DIR" >&2
  echo "Make sure the bridge is running first: npm run start-all" >&2
  exit 1
fi

# Parse lock file (requires python3 or jq)
# Passes $LOCK_FILE and $field via env vars to avoid shell injection in -c string
parse_lock() {
  local field="$1"
  if command -v python3 >/dev/null 2>&1; then
    LOCK_FILE="$LOCK_FILE" LOCK_FIELD="$field" python3 - <<'PYEOF'
import json, os
with open(os.environ["LOCK_FILE"]) as f:
    d = json.load(f)
print(d[os.environ["LOCK_FIELD"]])
PYEOF
  elif command -v jq >/dev/null 2>&1; then
    jq -r --arg f "$field" '.[$f]' "$LOCK_FILE"
  else
    echo "Error: python3 or jq is required to parse lock file" >&2
    exit 1
  fi
}

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
    # Auth uses Authorization: Bearer (not x-claude-ide-extension, which is for WS extension sessions)
    CONFIG=$(cat <<EOF
# Add this to ~/.codex/config.toml to connect to claude-ide-bridge
# The bridge must be running before starting codex.

[mcp_servers.claude-ide-bridge]
# Streamable HTTP transport (bridge HTTP server)
url = "${HTTP_URL}/mcp"
http_headers = { "Authorization" = "Bearer ${AUTH_TOKEN}" }
enabled = true
EOF
)
    echo "=== OpenAI Codex CLI MCP config (~/.codex/config.toml) ==="
    echo "$CONFIG"
    echo ""
    echo "Note: Retrieve the auth token from the lock file at: $LOCK_FILE"
    ;;

  *)
    echo "Error: Unknown target '$TARGET'. Use: cursor | antigravity | codex | claude-desktop | remote | claude-web" >&2
    exit 1
    ;;
esac

# --- Write mode ---
if $WRITE; then
  echo ""
  echo "Write to: $OUTPUT_PATH"
  read -r -p "Confirm? [y/N] " confirm
  if [[ "$confirm" =~ ^[Yy]$ ]]; then
    mkdir -p "$(dirname "$OUTPUT_PATH")"
    # Timestamped backup so repeated --write calls don't clobber each other
    if [[ -f "$OUTPUT_PATH" ]]; then
      BACKUP="${OUTPUT_PATH}.$(date +%Y%m%d%H%M%S).bak"
      cp "$OUTPUT_PATH" "$BACKUP"
      echo "Backed up existing config to $(basename "$BACKUP")"
    fi
    # Atomic write via tmp file to prevent partial writes on interrupt
    TMP_PATH="${OUTPUT_PATH}.tmp"
    printf '%s\n' "$CONFIG" > "$TMP_PATH"
    mv "$TMP_PATH" "$OUTPUT_PATH"
    echo "Written: $OUTPUT_PATH"
  else
    echo "Aborted."
  fi
fi
