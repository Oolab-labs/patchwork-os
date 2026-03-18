# IP Allowlist & Network Access Docs

This document covers how to control network access to a remotely-exposed Claude IDE Bridge instance — relevant for self-hosters running the bridge on a VPS or behind a tunnel.

---

## Local mode (default — no allowlist needed)

By default the bridge binds to `127.0.0.1:0` (loopback, random port). Only processes on the same machine can connect. No firewall rules are needed and no data leaves the host.

```bash
# Default — loopback only
claude-ide-bridge
```

---

## Remote mode — exposing the bridge

When you want an AI assistant running on a different machine (e.g. claude.ai) to reach your bridge, you have two options: an ngrok tunnel, or a direct VPS binding.

### Option A — ngrok (recommended for most users)

ngrok creates an HTTPS tunnel from a public URL to your local bridge. Access is controlled by:

1. **The bridge bearer token** — every request must carry `Authorization: Bearer <token>`. Without it the bridge returns `401`.
2. **OAuth (optional)** — when `--issuer-url` is set, the bridge issues short-lived OAuth tokens via the authorization code flow. The bearer token is still required to initiate the OAuth flow.
3. **ngrok IP restrictions (ngrok paid plans)** — you can lock the tunnel to specific source IPs in the ngrok dashboard under *Endpoints → your tunnel → IP Restrictions*.

```bash
# Start bridge with a fixed token and issuer URL
claude-ide-bridge \
  --fixed-token $(uuidgen) \
  --issuer-url https://YOUR-SUBDOMAIN.ngrok-free.app

# In a separate terminal, start the tunnel
ngrok http 9000 --domain YOUR-SUBDOMAIN.ngrok-free.app
```

**ngrok IP allowlist (paid plans):**
In the ngrok dashboard → Endpoints → your endpoint → Traffic Policy, add:
```yaml
on_http_request:
  - actions:
      - type: restrict-ips
        config:
          enforce: true
          allow:
            - 1.2.3.4/32   # Anthropic QA IP or your own client IP
```

### Option B — direct VPS binding

Bind the bridge to the VPS's public interface and use firewall rules to restrict access.

```bash
# Bind to a specific interface
claude-ide-bridge --bind 0.0.0.0 --port 9000 --fixed-token $(uuidgen)
```

**UFW (Ubuntu):**
```bash
# Allow only specific source IPs
ufw allow from 1.2.3.4 to any port 9000
ufw allow from 5.6.7.8 to any port 9000
ufw deny 9000
```

**iptables:**
```bash
iptables -A INPUT -p tcp --dport 9000 -s 1.2.3.4 -j ACCEPT
iptables -A INPUT -p tcp --dport 9000 -j DROP
```

**Note:** Always use TLS in front of a publicly-bound bridge (nginx + Let's Encrypt, or Caddy). The bridge itself speaks plain HTTP; TLS termination must happen at the reverse proxy.

---

## Anthropic QA / test account access

For the claude.ai plugin submission, Anthropic's QA team needs a stable demo instance. The demo bridge at `brushed-burt-swatheable.ngrok-free.app` is configured as follows:

| Setting | Value |
|---|---|
| Endpoint | `https://brushed-burt-swatheable.ngrok-free.app` |
| Auth | Fixed bearer token (share privately with Anthropic) |
| OAuth issuer | `https://brushed-burt-swatheable.ngrok-free.app` |
| Workspace | Read-only demo workspace (no write tools enabled on demo) |
| Uptime | Managed via tmux session `bridge` on the VPS |

To start/restart the demo instance:
```bash
# On the VPS
tmux attach -t bridge
# Ctrl-C to stop, then:
npm run remote
```

---

## Environment variables

| Variable | Description |
|---|---|
| `CLAUDE_IDE_BRIDGE_TOKEN` | Sets the fixed auth token (must be a valid UUID) |
| `CLAUDE_IDE_BRIDGE_ISSUER_URL` | Sets the OAuth issuer URL |
| `CLAUDE_IDE_BRIDGE_PORT` | Port to listen on (default: random) |

---

## Security checklist for self-hosters

- [ ] Use `--fixed-token` with a cryptographically random UUID (`uuidgen` or `node -e "console.log(require('crypto').randomUUID())"`)
- [ ] Never expose the bridge token in public URLs, logs, or source control
- [ ] Use TLS (ngrok or nginx) — the bridge does not terminate TLS itself
- [ ] Restrict source IPs at the firewall or ngrok level when possible
- [ ] Enable OAuth (`--issuer-url`) for claude.ai connections so tokens are short-lived
- [ ] Run the bridge as a non-root user
- [ ] Monitor `/metrics` and `/health` endpoints for unexpected activity
