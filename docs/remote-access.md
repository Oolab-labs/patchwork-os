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

    # Proxy all paths — OAuth endpoints (/.well-known/*, /oauth/*) must be reachable
    # alongside the MCP endpoint (/mcp) for claude.ai custom connectors to work.
    location / {
        proxy_pass http://127.0.0.1:<BRIDGE_PORT>;
        proxy_http_version 1.1;

        # Required for SSE (GET /mcp) and WebSocket upgrades
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;

        # Required for SSE streaming — disable buffering
        proxy_buffering off;
        proxy_cache off;
        proxy_read_timeout 3600s;

        # Forward auth header
        proxy_set_header Authorization $http_authorization;
        proxy_pass_header Authorization;
    }
}
```

Get a certificate with Certbot:
```bash
certbot --nginx -d bridge.yourdomain.com
```

Then generate your MCP config and update the URL to `https://`:
```bash
bash scripts/gen-mcp-config.sh remote --host bridge.yourdomain.com --token <TOKEN>
```

> **Note:** `gen-mcp-config.sh remote` outputs `http://` — change it to `https://` manually after TLS is in place.

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

## OAuth 2.0 (for claude.ai Custom Connectors)

claude.ai uses OAuth 2.0 + PKCE to authenticate with the bridge. Pass two extra flags when running the bridge remotely:

```bash
claude-ide-bridge \
  --bind 0.0.0.0 \
  --fixed-token $TOKEN \
  --issuer-url https://bridge.yourdomain.com \
  --cors-origin https://claude.ai
```

| Flag | Purpose |
|------|---------|
| `--issuer-url <url>` | Your public HTTPS URL. Activates OAuth 2.0 and sets the issuer in all discovery documents. |
| `--cors-origin <url>` | Adds `Access-Control-Allow-Origin` for the given origin on all responses (including 401s). Repeatable for multiple origins. |

**Authorization flow:**

1. claude.ai discovers OAuth metadata at `/.well-known/oauth-protected-resource` and `/.well-known/oauth-authorization-server`
2. claude.ai registers a dynamic client at `POST /oauth/register` (RFC 7591)
3. claude.ai redirects you to `GET /oauth/authorize` — enter your bridge token and click **Authorize**
4. claude.ai exchanges the auth code for an access token at `POST /oauth/token`
5. claude.ai uses the access token as a `Bearer` token on all subsequent `/mcp` requests

Access tokens expire after **1 hour**. claude.ai re-authorizes automatically.

### CORS

The `--cors-origin` flag is required for claude.ai because its connector makes browser-side requests. Without it, the browser blocks the 401 challenge response and the OAuth flow never starts.

You can repeat the flag for multiple trusted origins:
```bash
--cors-origin https://claude.ai --cors-origin https://app.yourdomain.com
```

Or set via environment variable (comma-separated):
```bash
CLAUDE_IDE_BRIDGE_CORS_ORIGINS=https://claude.ai,https://app.yourdomain.com
```

---

## Security Model

- **Bearer token required** on every request to `/mcp` (POST, GET, DELETE)
- Token is stored in `~/.claude/ide/<port>.lock` with `chmod 600`
- CORS `OPTIONS` preflight does not require auth — browsers send it automatically
- OAuth access tokens are opaque 32-byte base64url strings; auth codes are single-use with 5 min TTL
- Session IDs are `crypto.randomUUID()` (122 bits of entropy)
- Sessions expire after **10 minutes of inactivity** and are pruned every 2 minutes
- Maximum **5 concurrent HTTP sessions**; oldest idle session is evicted when capacity is reached

### Token rotation

The auth token changes every restart unless `--fixed-token` is set. For claude.ai connectors, always use `--fixed-token` — the OAuth access token issued to claude.ai stays valid independently, but a new bridge token invalidates it, requiring re-authorization.

```bash
TOKEN=$(uuidgen)   # generate once, store securely
claude-ide-bridge --fixed-token $TOKEN --issuer-url https://... --cors-origin https://claude.ai
```

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

### MCP endpoints

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `OPTIONS` | `/mcp` | None | CORS preflight |
| `POST` | `/mcp` | Bearer | Send JSON-RPC request/notification. `initialize` creates a session. |
| `GET` | `/mcp` | Bearer + `Mcp-Session-Id` | Open SSE stream for server-push notifications |
| `DELETE` | `/mcp` | Bearer + `Mcp-Session-Id` | Terminate session |
| `GET` | `/ping` | None | Health check — returns `{"ok":true,"v":"<version>"}` |

### OAuth 2.0 endpoints (enabled with `--issuer-url`)

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `GET` | `/.well-known/oauth-authorization-server` | None | RFC 8414 authorization server metadata |
| `GET` | `/.well-known/oauth-protected-resource` | None | RFC 9396 protected resource metadata |
| `POST` | `/oauth/register` | None | RFC 7591 dynamic client registration |
| `GET` | `/oauth/authorize` | None | Authorization page (enter bridge token to approve) |
| `POST` | `/oauth/authorize` | None | Form submission — issues auth code on approval |
| `POST` | `/oauth/token` | None | Exchange auth code for access token |
| `POST` | `/oauth/revoke` | None | Revoke an access token (RFC 7009) |

### Headers

| Header | Direction | Description |
|--------|-----------|-------------|
| `Authorization: Bearer <token>` | Request | Required on all POST/GET/DELETE to `/mcp` |
| `Mcp-Session-Id: <uuid>` | Request | Required on all requests after initialize |
| `Mcp-Session-Id: <uuid>` | Response | Returned by server on successful initialize |

---

## Troubleshooting

**`401 Unauthorized`** — Wrong or missing Bearer token. Retrieve the current token:
```bash
python3 -c "import json; d=json.load(open('$(ls -t ~/.claude/ide/*.lock | head -1)')); print(d['authToken'])"
```

**MCP config updated but Claude Code still uses the old URL** — Claude Code reads MCP config from two places. Check and update both:
```bash
# Project-level (takes precedence for Claude Code CLI)
cat .mcp.json

# User-level
cat ~/.claude/settings.json
```
Update the `url` and `Authorization` header in whichever file has the stale entry.

**`503 HTTP session capacity reached`** — Max 5 HTTP sessions active. The bridge evicts
the oldest idle session (idle > 60s) automatically. If all 5 are genuinely active, wait
for sessions to expire (10 min idle TTL) or DELETE an existing session.

**`404 Session not found or expired — re-initialize`** — Session expired (10 min idle)
or bridge restarted. Send a new `initialize` request to get a fresh session.

**SSE stream disconnects every few seconds** — A reverse proxy is timing out the
connection. Ensure `proxy_read_timeout` is set to at least 3600s (nginx) or that
`proxy_buffering off` is configured.

**CORS errors in browser** — The bridge only sends `Access-Control-Allow-Origin` for
origins listed via `--cors-origin`. If you see CORS errors, ensure you passed
`--cors-origin https://claude.ai` (or the appropriate client origin) when starting the
bridge. You can also set `CLAUDE_IDE_BRIDGE_CORS_ORIGINS=https://claude.ai` in the
environment. Note: OPTIONS preflight requests are always allowed regardless of origin.
