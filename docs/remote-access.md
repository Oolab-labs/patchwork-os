# Remote Access — Streamable HTTP Transport

The bridge exposes a **Streamable HTTP** MCP endpoint (`POST/GET/DELETE /mcp`) that lets
any MCP client with network access connect — not just Claude Code CLI.

This enables the core "chat with your IDE from anywhere" workflow:

- **Claude Desktop app** → Custom Connectors UI → bridge running on your laptop
- **claude.ai web** → Custom Connectors → bridge behind a reverse proxy
- **OpenAI Codex CLI** → `~/.codex/config.toml` → bridge HTTP endpoint
- **Any MCP-compatible tool** → standard Streamable HTTP spec (2025-03-26)

---

## Quick Start (local)

The `/mcp` endpoint is available immediately on the same port as the WebSocket server.
No extra flags needed — it starts with the bridge.

```bash
# Start the bridge
npm run start-all

# Test the endpoint
LOCK=~/.claude/ide/*.lock
PORT=$(basename $LOCK .lock)
TOKEN=$(python3 -c "import json; d=json.load(open('$LOCK')); print(d['authToken'])")

curl -s -X POST "http://localhost:$PORT/mcp" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-11-25","capabilities":{},"clientInfo":{"name":"test","version":"1.0"}}}'
```

---

## Connect Claude Desktop (local machine)

Claude Desktop supports two connection methods:

### Option A — stdio shim (recommended, no network required)

```bash
bash scripts/gen-claude-desktop-config.sh --write
# Restart Claude Desktop
```

This uses the existing stdio shim, which reads the lock file and connects over WebSocket
on the loopback interface. No TLS, no extra config. Works out of the box.

### Option B — Custom Connectors (Streamable HTTP)

In Claude Desktop: **Settings → Integrations → Custom Connectors → Add**

```
URL: http://127.0.0.1:<PORT>/mcp
Headers:
  Authorization: Bearer <TOKEN>
```

Retrieve port and token from the lock file:
```bash
LOCK=$(ls -t ~/.claude/ide/*.lock | head -1)
PORT=$(basename "$LOCK" .lock)
python3 -c "import json; d=json.load(open('$LOCK')); print('PORT:', '$PORT', '| TOKEN:', d['authToken'])"
```

---

## Remote Access (across machines / internet)

The bridge binds to `127.0.0.1` by default. To access it from another machine
you need a **reverse proxy with TLS**. Claude Desktop's Custom Connectors require HTTPS.

### Setup with Caddy (recommended)

[Caddy](https://caddyserver.com) handles TLS automatically via Let's Encrypt.

**1. Install Caddy** on the machine running the bridge:
```bash
# macOS
brew install caddy

# Linux
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | sudo apt-key add -
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | sudo tee /etc/apt/sources.list.d/caddy-stable.list
sudo apt update && sudo apt install caddy
```

**2. Configure Caddy** (`Caddyfile`):
```
bridge.yourdomain.com {
    # Only expose the /mcp endpoint — not the full bridge WebSocket
    handle /mcp* {
        reverse_proxy 127.0.0.1:{$BRIDGE_PORT}
    }

    # Optional: block all other paths
    respond 404
}
```

**3. Start Caddy**:
```bash
BRIDGE_PORT=<your-bridge-port> caddy run
```

**4. Connect Claude Desktop**:
```
URL: https://bridge.yourdomain.com/mcp
Headers:
  Authorization: Bearer <TOKEN>
```

---

### Setup with nginx

**nginx config** (`/etc/nginx/sites-available/bridge`):
```nginx
server {
    listen 443 ssl;
    server_name bridge.yourdomain.com;

    ssl_certificate     /etc/letsencrypt/live/bridge.yourdomain.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/bridge.yourdomain.com/privkey.pem;

    # Only proxy /mcp — reject everything else
    location /mcp {
        proxy_pass http://127.0.0.1:<BRIDGE_PORT>;
        proxy_http_version 1.1;

        # Required for SSE (GET /mcp) streaming
        proxy_buffering off;
        proxy_cache off;
        proxy_read_timeout 3600s;

        # Forward auth header
        proxy_set_header Authorization $http_authorization;
        proxy_pass_header Authorization;
    }

    location / {
        return 404;
    }
}
```

Get a certificate with Certbot:
```bash
certbot --nginx -d bridge.yourdomain.com
```

---

### Bind flag

By default the bridge only listens on `127.0.0.1`. If your reverse proxy is on a
different machine (e.g. a VPS front-end), you may need to bind to all interfaces:

```bash
npm run start-all -- --bind 0.0.0.0
```

> **Warning**: `--bind 0.0.0.0` exposes the bridge to all network interfaces.
> Always place it behind a TLS reverse proxy and ensure firewall rules are in place.
> The auth token is still required for every request.

---

## Security Model

- **Bearer token required** on every request to `/mcp` (POST, GET, DELETE)
- Token is stored in `~/.claude/ide/<port>.lock` with `chmod 600`
- CORS preflight (`OPTIONS`) does not require auth — browsers send it before any request
- Session IDs are `crypto.randomUUID()` (122 bits of entropy)
- Sessions expire after **30 minutes of inactivity** and are pruned automatically
- Maximum **5 concurrent HTTP sessions** (separate from WebSocket sessions)

### Token rotation

The auth token changes every time the bridge restarts (it's generated fresh at startup).
If you use a Custom Connector with a hardcoded token, you'll need to update it after
restarting the bridge.

For long-lived setups, consider wrapping the bridge in a script that reads the current
token from the lock file and passes it to your reverse proxy config dynamically.

### Env var expansion in `.mcp.json`

Claude Code supports `${VAR:-default}` syntax in `.mcp.json` values. Keep the token out of the file:

```json
{
  "mcpServers": {
    "claude-ide-bridge-remote": {
      "type": "http",
      "url": "https://bridge.yourdomain.com/mcp",
      "headers": {
        "Authorization": "Bearer ${BRIDGE_TOKEN}"
      }
    }
  }
}
```

Set `BRIDGE_TOKEN` in your shell profile (`.zshrc`, `.bashrc`) or via a secrets manager. Retrieve the current token with:

```bash
claude-ide-bridge print-token
```

This way the token never appears in version-controlled config files.

---

## Endpoint reference

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `OPTIONS` | `/mcp` | None | CORS preflight |
| `POST` | `/mcp` | Bearer | Send JSON-RPC request/notification. `initialize` creates a session. |
| `GET` | `/mcp` | Bearer + `Mcp-Session-Id` | Open SSE stream for server-push notifications |
| `DELETE` | `/mcp` | Bearer + `Mcp-Session-Id` | Terminate session |

### Headers

| Header | Direction | Description |
|--------|-----------|-------------|
| `Authorization: Bearer <token>` | Request | Required on all POST/GET/DELETE |
| `Mcp-Session-Id: <uuid>` | Request | Required on all requests after initialize |
| `Mcp-Session-Id: <uuid>` | Response | Returned by server on successful initialize |

---

## Troubleshooting

**`401 Unauthorized`** — Wrong or missing Bearer token. Retrieve the current token:
```bash
python3 -c "import json; d=json.load(open('$(ls -t ~/.claude/ide/*.lock | head -1)')); print(d['authToken'])"
```

**`503 HTTP session capacity reached`** — Max 5 HTTP sessions active. Wait for idle
sessions to expire (30 min) or DELETE an existing session.

**`404 Session not found or expired — re-initialize`** — Session expired (30 min idle)
or bridge restarted. Send a new `initialize` request to get a fresh session.

**SSE stream disconnects every few seconds** — A reverse proxy is timing out the
connection. Ensure `proxy_read_timeout` is set to at least 3600s (nginx) or that
`proxy_buffering off` is configured.

**CORS errors in browser** — The `Access-Control-Allow-Origin: *` header is set on all
`/mcp` responses. If you see CORS errors, check that the browser is sending an
`Authorization` header (some fetch configurations require explicit opt-in).
