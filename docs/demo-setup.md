# Demo Instance Setup

This guide sets up a persistent, publicly accessible claude-ide-bridge instance for
Anthropic's review team to test against.

## What reviewers can test

A headless demo instance (no IDE attached) gives full access to:

| Category | Tools available |
|---|---|
| OAuth 2.1 flow | `/authorize`, `/token`, `.well-known` endpoints |
| MCP protocol | `tools/list`, `tools/call`, `resources/list`, `prompts/list` |
| File operations | `readFile`, `writeFile`, `findFiles`, `searchAndReplace` |
| Git | `gitStatus`, `gitDiff`, `gitLog`, `gitCommit`, `gitCheckout`, `gitBranch` |
| Process execution | `runCommand`, `runTests` |
| Diagnostics | `bridgeStatus`, `activityLog` |
| HTTP client | `httpRequest` |

Extension-only tools (terminal, LSP, debugger) return a clear `extensionRequired` error
rather than failing opaquely.

## Quickstart — provision a VPS (Ubuntu 22.04+)

**1. Spin up a server** (DigitalOcean, Hetzner, Fly.io, AWS EC2 — any works).
Minimum: 1 vCPU, 512 MB RAM, Ubuntu 22.04.

**2. Open the firewall** on the bridge port (default: 18765):
```bash
ufw allow 18765/tcp
```

**3. Run the provision script** (as root):
```bash
curl -fsSL \
  https://raw.githubusercontent.com/Oolab-labs/claude-ide-bridge/main/scripts/provision-demo.sh \
  | bash
```

The script installs Docker, generates a stable auth token, starts the container, and
prints the connection details.

**4. Verify it's running:**
```bash
curl http://<server-ip>:18765/ping
# → {"ok":true,"v":"2.x.x"}

curl http://<server-ip>:18765/.well-known/oauth-authorization-server
# → {"issuer":"http://...","authorization_endpoint":"...","code_challenge_methods_supported":["S256"],...}
```

## Sharing credentials with Anthropic

Send the review team:

```
MCP endpoint:  http://<server-ip>:18765/mcp
Auth token:    <token from /etc/claude-ide-bridge/token>
OAuth flow:    http://<server-ip>:18765/.well-known/oauth-authorization-server

Test the OAuth flow:
  1. GET  http://<server-ip>:18765/.well-known/oauth-authorization-server
  2. GET  http://<server-ip>:18765/authorize?response_type=code&client_id=test&
           redirect_uri=http://localhost:6274/oauth/callback&
           code_challenge=<S256_challenge>&code_challenge_method=S256
  3. POST http://<server-ip>:18765/token   (exchange code + verifier)
  4. Use returned access_token as Bearer on POST http://<server-ip>:18765/mcp
```

## Keeping the instance alive

The container restarts automatically (`--restart unless-stopped`). To confirm:

```bash
docker ps                          # check it's running
docker logs claude-ide-bridge      # view logs
curl http://localhost:18765/ping   # liveness check
```

The auth token is persisted in `/etc/claude-ide-bridge/token` and survives container
restarts and upgrades.

## Upgrading

```bash
docker pull ghcr.io/oolab-labs/claude-ide-bridge:latest
docker rm -f claude-ide-bridge
bash scripts/provision-demo.sh   # re-runs with existing token
```
