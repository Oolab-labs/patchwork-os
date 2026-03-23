# Deploy

Production VPS deployment files for claude-ide-bridge.

> **Deployment targets:** The **systemd + nginx** path (this directory) is the
> production-supported deployment for VPS/remote use. A `Dockerfile` and
> `docker-compose.yml` exist in the repo root as an alternative for
> containerised environments, but are not actively tested against the systemd
> config — if you use Docker, treat it as a community-supported path and keep
> it in sync with any service config changes.

## Files

| File | Purpose |
|------|---------|
| `bootstrap-new-vps.sh` | **Full fresh-server setup** — Node.js, clone, build, user, firewall, systemd, nginx, Certbot |
| `install-vps-service.sh` | **Idempotent updater** — re-installs service + nginx after `git pull` on an existing server |
| `nginx-claude-bridge.conf.template` | nginx config reference (domain + port injected by scripts) |
| `claude-ide-bridge.service.template` | systemd unit reference (paths + user injected by scripts) |
| `claude-ide-bridge@.service` | Template unit for multi-user demo instances (alternate pattern) |
| `ecosystem.config.js.example` | PM2 ecosystem config template (alternative to systemd) |

## First-time setup (new VPS)

```bash
# Option A: run remotely on fresh server
DOMAIN=bridge.example.com bash <(curl -fsSL https://raw.githubusercontent.com/Oolab-labs/claude-ide-bridge/main/deploy/bootstrap-new-vps.sh)

# Option B: after cloning the repo
DOMAIN=bridge.example.com bash deploy/bootstrap-new-vps.sh
```

The bootstrap script handles everything end-to-end:
1. Installs Node.js 20, nginx, certbot
2. Creates a dedicated `claude-bridge` system user (non-root)
3. Clones the repo to `/opt/claude-ide-bridge`
4. Runs `npm ci && npm run build`
5. Generates `.env.vps` with a random auth token
6. Opens ports 80/443 in ufw
7. Installs and enables the systemd service
8. Writes the nginx config with your domain injected
9. Runs Certbot for HTTPS
10. Starts the bridge and confirms it's healthy

**Required:** `DOMAIN` env var pointing to a subdomain that resolves to your VPS IP.

**Optional overrides:**

| Variable | Default | Description |
|----------|---------|-------------|
| `REPO_URL` | GitHub upstream | Git repo to clone |
| `INSTALL_DIR` | `/opt/claude-ide-bridge` | Where to install |
| `SERVICE_USER` | `claude-bridge` | System user to run as |
| `PORT` | `9000` | Bridge listen port |
| `BRANCH` | `main` | Git branch |
| `SKIP_CERTBOT` | `0` | Set to `1` to skip TLS (DNS not ready) |

## Updating an existing server

```bash
cd /opt/claude-ide-bridge   # or wherever INSTALL_DIR is
git pull
npm ci
npm run build
bash deploy/install-vps-service.sh
```

`install-vps-service.sh` re-generates the systemd unit and nginx config from the current state of `.env.vps`, then restarts the service automatically. It auto-detects the domain and service user from the existing installation — no config needed.

## Day-to-day management

```bash
# View live logs
journalctl -u claude-ide-bridge -f

# Check status
systemctl status claude-ide-bridge

# Restart after code change
npm run build && systemctl restart claude-ide-bridge

# Stop (won't restart until manually started)
systemctl stop claude-ide-bridge
```

## Using PM2 instead of systemd

PM2 is a simpler alternative when you're running as root, already have PM2 installed, or prefer not to configure systemd manually.

> **Important:** The bridge picks a **random port** by default. The port in your PM2 start command **must match** the port in your nginx `proxy_pass` directive, or every restart will cause a 502 Bad Gateway.

### Quick start with PM2

```bash
# Replace 4748 and YOUR_TOKEN_HERE with your nginx proxy_pass port and auth token
pm2 delete claude-bridge 2>/dev/null || true
pm2 start /root/claude-ide-bridge/dist/index.js \
  --name claude-bridge \
  -- --port 4748 --bind 0.0.0.0 --vps --fixed-token YOUR_TOKEN_HERE
pm2 save
```

Retrieve your token anytime:
```bash
cat ~/.claude/ide/*.lock | node -e "const d=require('fs').readFileSync('/dev/stdin','utf8').trim(); console.log(JSON.parse(d).authToken)"
# or if you have a .env.vps:
grep FIXED_TOKEN /root/claude-ide-bridge/.env.vps
```

### Persist across reboots

```bash
# Generate and run the startup command PM2 prints
pm2 startup
# (run the command it outputs, then:)
pm2 save
```

### Using an ecosystem file

For repeatable deployments, use the included example:

```bash
cp deploy/ecosystem.config.js.example ecosystem.config.js
# Edit ecosystem.config.js: set cwd, port, and fixed-token
pm2 start ecosystem.config.js
pm2 save
```

### Day-to-day management with PM2

```bash
# View live logs
pm2 logs claude-bridge

# Check status
pm2 status

# Restart after code change
npm run build && pm2 restart claude-bridge

# Stop
pm2 stop claude-bridge
```

## MCP endpoint

```
https://<your-domain>/mcp
```

Use in `.mcp.json` for Claude Desktop, claude.ai Custom Connectors, or any remote MCP client:

```json
{
  "mcpServers": {
    "claude-ide-bridge": {
      "type": "http",
      "url": "https://your-domain/mcp",
      "headers": {
        "Authorization": "Bearer ${BRIDGE_TOKEN}"
      }
    }
  }
}
```

Set `BRIDGE_TOKEN` in your shell profile. Retrieve the token anytime:

```bash
grep FIXED_TOKEN /opt/claude-ide-bridge/.env.vps
```
