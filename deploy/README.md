# Deploy

Production VPS deployment files for claude-ide-bridge.

## Files

| File | Purpose |
|------|---------|
| `claude-ide-bridge.service` | systemd unit — auto-starts bridge on boot, restarts on crash |
| `nginx-claude-bridge.conf` | nginx reverse proxy — HTTPS on `bridge.massappealdesigns.co.ke` |
| `install-vps-service.sh` | One-shot installer — runs both of the above end-to-end |
| `claude-ide-bridge@.service` | Template unit for multi-user demo instances (alternate pattern) |

## Quick Setup

```bash
# From repo root on the VPS, as root:
bash deploy/install-vps-service.sh
```

This will:
1. Install and enable the systemd service (reads from `.env.vps`)
2. Install the nginx site config for `bridge.massappealdesigns.co.ke`
3. Obtain a TLS cert via Certbot
4. Stop the tmux bridge session (now superseded)
5. Start the service and confirm it's healthy

**Prerequisites:**
- `.env.vps` present with `PORT`, `WORKSPACE`, `FIXED_TOKEN` set
- `npm run build` has been run (`dist/index.js` exists)
- DNS: `bridge.massappealdesigns.co.ke` → VPS IP
- Packages: `nginx`, `certbot`, `python3-certbot-nginx`

## Day-to-day management

```bash
# View live logs
journalctl -u claude-ide-bridge -f

# Restart after code change
npm run build && systemctl restart claude-ide-bridge

# Check status
systemctl status claude-ide-bridge

# Stop (won't restart until manually started)
systemctl stop claude-ide-bridge
```

## MCP endpoint

```
https://bridge.massappealdesigns.co.ke/mcp
```

Use this in `.mcp.json` for Claude Desktop, claude.ai Custom Connectors, or any remote MCP client:

```json
{
  "mcpServers": {
    "claude-ide-bridge": {
      "type": "http",
      "url": "https://bridge.massappealdesigns.co.ke/mcp",
      "headers": {
        "Authorization": "Bearer ${BRIDGE_TOKEN}"
      }
    }
  }
}
```

Set `BRIDGE_TOKEN` in your shell profile. Retrieve it anytime:

```bash
claude-ide-bridge print-token
# or directly from .env.vps:
grep FIXED_TOKEN /root/claude-ide-bridge/.env.vps
```

## Updating

```bash
# Pull latest, rebuild, restart
cd /root/claude-ide-bridge
git pull
npm install
npm run build
systemctl restart claude-ide-bridge
```
