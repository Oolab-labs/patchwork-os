# Remote Access Guide

## Overview

The bridge can run on a remote VPS or container and be accessed by:

- **Claude Code CLI** — connecting over SSH tunnel or direct WebSocket
- **claude.ai custom connectors** — via Streamable HTTP transport with OAuth 2.0

---

## Option 1: VS Code Remote-SSH (Recommended for Dev)

The VS Code extension has `extensionKind: ["workspace"]` — it runs on the remote machine automatically when you open a Remote-SSH connection.

**Steps:**

1. Connect to remote via VS Code Remote-SSH (or Cursor SSH)
2. Install the claude-ide-bridge extension in the remote workspace (VS Code auto-prompts when connecting)
3. SSH into the remote and start the bridge:

   ```bash
   claude-ide-bridge --full --watch --workspace /path/to/project
   ```

4. Claude Code (local) connects to the bridge on the remote automatically via the MCP config

Full tool support: LSP, debugger, editor state, git — all work through the extension on the remote machine.

---

## Option 2: Systemd Service (VPS Long-Running)

### Bootstrap a new VPS

```bash
# On the VPS
curl -fsSL https://raw.githubusercontent.com/Oolab-labs/claude-ide-bridge/main/deploy/bootstrap-new-vps.sh | bash
```

Or manually:

```bash
npm install -g claude-ide-bridge
claude-ide-bridge install-extension  # if VS Code is available on the remote
```

### Install as a systemd service

```bash
# Idempotent — safe to run again to update config
bash $(npm root -g)/claude-ide-bridge/deploy/install-vps-service.sh
```

The script writes a service unit to `/etc/systemd/system/claude-ide-bridge.service`. It starts the bridge with `--bind 0.0.0.0 --fixed-token <uuid> --watch --full`.

```bash
# Check service status
systemctl status claude-ide-bridge

# Follow logs
journalctl -u claude-ide-bridge -f
```

### Fixed token

Use `--fixed-token <uuid>` to prevent token rotation on restart:

```bash
claude-ide-bridge --fixed-token $(uuidgen) --bind 0.0.0.0 --full --watch
```

Store the token in a secrets manager or environment variable — never commit it to version control.

---

## Option 3: Reverse Proxy with TLS (Required for claude.ai)

claude.ai custom connectors require HTTPS. Place nginx or Caddy in front of the bridge.

### nginx config

```nginx
server {
    listen 443 ssl;
    server_name bridge.yourdomain.com;

    ssl_certificate     /etc/letsencrypt/live/bridge.yourdomain.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/bridge.yourdomain.com/privkey.pem;

    location / {
        proxy_pass http://127.0.0.1:18765;
        proxy_http_version 1.1;
        proxy_set_header Upgrade    $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host       $host;

        # Required for SSE streaming — disable buffering
        proxy_buffering off;
        proxy_cache off;
        proxy_read_timeout 86400s;
    }
}
```

> `proxy_read_timeout 86400` is required. nginx's default of 60 seconds kills long-lived WebSocket and SSE connections.

### Caddy config (simpler, auto-TLS)

```
bridge.yourdomain.com {
    reverse_proxy localhost:18765
}
```

Caddy handles certificate provisioning and renewal automatically via Let's Encrypt.

### Firewall

Only expose port 443 (HTTPS) publicly. Keep the bridge port bound to `127.0.0.1`:

```bash
ufw allow 443/tcp
ufw deny 18765/tcp   # keep internal only
```

---

## Option 4: OAuth 2.0 for claude.ai Connectors

Activate OAuth mode by passing `--issuer-url`:

```bash
claude-ide-bridge \
  --issuer-url https://bridge.yourdomain.com \
  --cors-origin https://claude.ai \
  --fixed-token <bridge-token> \
  --full --watch
```

### OAuth endpoints

| Endpoint | Purpose |
|---|---|
| `/.well-known/oauth-authorization-server` | RFC 8414 server metadata discovery |
| `/.well-known/oauth-protected-resource` | RFC 9396 protected resource metadata |
| `/oauth/register` | Dynamic client registration (RFC 7591) |
| `/oauth/authorize` | Authorization approval page — enter bridge token here |
| `/oauth/token` | Token exchange |
| `/oauth/revoke` | Token revocation (RFC 7009) |

### Adding to claude.ai

1. In claude.ai → Settings → Connectors → Add custom connector
2. Enter `https://bridge.yourdomain.com` as the server URL
3. claude.ai discovers OAuth metadata automatically via the `/.well-known/` endpoints
4. Authorize: enter your bridge token in the `/oauth/authorize` approval page
5. Access tokens are valid 24 hours; re-authorize when expired (no refresh tokens)

### CORS

Allow the claude.ai origin:

```bash
--cors-origin https://claude.ai
```

Or via environment variable:

```bash
export CLAUDE_IDE_BRIDGE_CORS_ORIGINS=https://claude.ai
```

For multiple origins, comma-separate them:

```bash
export CLAUDE_IDE_BRIDGE_CORS_ORIGINS=https://claude.ai,https://other.example.com
```

### Design notes

- PKCE S256 is mandatory — plain PKCE is rejected
- Auth codes: single-use, 5-minute TTL
- Access tokens: opaque base64url, 24-hour TTL
- No refresh tokens — clients re-authorize after expiry
- All string comparisons are timing-safe (`crypto.timingSafeEqual`)
- OAuth access tokens work for **HTTP/MCP transport only** — WebSocket auth only accepts the bridge token via the `x-claude-code-ide-authorization` header

---

## SSH Tunnel (No Public Domain Needed)

If you don't have a domain or TLS certificate, forward the bridge port locally:

```bash
ssh -L 18765:localhost:18765 user@vps-ip -N
```

Then configure Claude Code to connect to `ws://127.0.0.1:18765` as if the bridge were running locally. No reverse proxy or HTTPS required for this path.

---

## `--vps` Flag

Expands the `runCommand` allowlist to include common server administration tools:

```bash
claude-ide-bridge --vps --full --watch
```

Additional allowed commands when `--vps` is active: `curl`, `systemctl`, `docker`, `docker-compose`, `pm2`, `nginx`, `certbot`.

---

## Getting the Auth Token on a Remote Server

```bash
# SSH into the server, then:
claude-ide-bridge print-token

# Or specify a port explicitly:
claude-ide-bridge print-token --port 18765

# Or read the lock file directly:
cat ~/.claude/ide/18765.lock | python3 -m json.tool
```

The lock file is at `~/.claude/ide/<port>.lock` and contains `pid`, `workspace`, `authToken`, and `isBridge: true`.

---

## Headless Mode (No IDE)

The bridge runs headlessly without a VS Code connection. CLI tools (`runCommand`, `getGitStatus`, `getGitDiff`, etc.) work in headless mode. LSP and debugger tools require the VS Code extension.

Start the bridge without opening VS Code:

```bash
claude-ide-bridge --full --watch --workspace /path/to/project
```

The bridge will report extension status as disconnected in `getBridgeStatus`. Tools marked `extensionRequired: true` return an error with reconnect instructions when the extension is not connected.

For LSP fallback in headless mode, `typescript-language-server` must be installed globally:

```bash
npm install -g typescript-language-server typescript
```

When installed, `goToDefinition`, `findReferences`, and `getTypeSignature` fall back to the local LSP automatically.

---

## Troubleshooting

### Systemd service fails to start

```bash
journalctl -u claude-ide-bridge --no-pager -n 50
```

Common causes:

- Port 18765 is already in use — check with `ss -tlnp | grep 18765`
- `node` is not on `PATH` in the systemd environment — use an absolute path in `ExecStart` (e.g. `/usr/local/bin/claude-ide-bridge`)
- Missing `--workspace` flag — the service must know which directory to serve

### nginx returns 502 Bad Gateway

The bridge is not running or is bound to the wrong address. Verify:

```bash
systemctl status claude-ide-bridge
ss -tlnp | grep 18765
```

Confirm the bridge was started with `--bind 0.0.0.0` (default binds to `127.0.0.1` only, which is correct when nginx is on the same host).

### WebSocket or SSE connections drop after ~60 seconds

Add `proxy_read_timeout 86400;` to the nginx `location` block. The default timeout of 60 seconds terminates long-lived WebSocket and SSE connections.

### OAuth authorization page returns 400

`--issuer-url` must match the public HTTPS URL exactly — no trailing slash, must be `https://`. Example: `--issuer-url https://bridge.yourdomain.com`.

### claude.ai connector shows "Unauthorized"

The access token has expired (24-hour TTL). Re-authorize by visiting `/oauth/authorize` and entering your bridge token again.

### SSL certificate renewal breaks nginx

For Caddy: certificates renew automatically, no action needed.

For certbot with nginx:

```bash
# Add to cron or systemd timer
certbot renew --nginx
```

Or use the certbot systemd timer that ships with most distros:

```bash
systemctl enable --now certbot.timer
```

### Bridge token lost after restart

Use `--fixed-token <uuid>` to pin the token across restarts. Without this flag the bridge generates a new token each start, which invalidates any stored client configs.

```bash
# Generate a stable token once, store it securely
export BRIDGE_TOKEN=$(uuidgen)
claude-ide-bridge --fixed-token "$BRIDGE_TOKEN" --bind 0.0.0.0 --full --watch
```
