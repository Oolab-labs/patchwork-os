# SSH Session Resilience

When using Claude Code remotely via SSH (e.g., from a phone), network interruptions can disrupt your session. This guide covers how the bridge handles disconnections and how to maximize resilience.

## How It Works

The bridge architecture has a key advantage: **Claude Code ↔ Bridge communication uses a localhost WebSocket**, which is completely independent of your SSH connection. When SSH drops, the localhost WebSocket is unaffected — as long as the processes survive.

```
Phone (SSH) ──── network ────→ Dev Machine
                                  ├── Claude Code CLI ←──localhost──→ Bridge
                                  └── VS Code Extension ←──localhost──→ Bridge
```

## tmux: The Primary Defense

The `start-all.sh` script runs everything inside a **tmux session**. When SSH disconnects, tmux detaches but all processes continue running. On reconnect:

```bash
# Reconnect to the existing session
tmux attach -t claude-all
```

Everything is exactly where you left it — Claude Code, the bridge, and any running operations.

**If you run the bridge without tmux**, it will warn you:
```
WARNING: Not running inside tmux or screen. SSH disconnection will kill this process.
  Recommended: use 'npm run start-all' or wrap in tmux/screen.
```

## Grace Period

When Claude Code disconnects from the bridge (e.g., process restart, brief network blip), the bridge preserves the session state for a configurable grace period (default: 30 seconds). If Claude Code reconnects within that window, it reattaches seamlessly — no state is lost.

For environments with longer disconnections, increase the grace period:

```bash
# CLI flag
npx claude-ide-bridge --grace-period 120000  # 2 minutes

# Environment variable
CLAUDE_IDE_BRIDGE_GRACE_PERIOD=300000 npx claude-ide-bridge  # 5 minutes
```

Range: 5,000–600,000 ms (5 seconds to 10 minutes).

## SSH Client Hardening

Add these settings to `~/.ssh/config` on your phone/laptop to prevent premature disconnections:

```
Host your-dev-machine
  ServerAliveInterval 30
  ServerAliveCountMax 3
  TCPKeepAlive yes
```

- **ServerAliveInterval 30**: Send a keepalive packet every 30 seconds
- **ServerAliveCountMax 3**: Disconnect after 3 missed responses (90 seconds)
- **TCPKeepAlive yes**: Enable TCP-level keepalive to maintain NAT entries

## Alternative: mosh

[mosh](https://mosh.org/) is a UDP-based remote terminal that survives IP changes, roaming, and sleep/wake cycles. If your SSH client supports it:

```bash
# Install on dev machine
brew install mosh   # macOS
apt install mosh    # Ubuntu/Debian

# Connect from phone
mosh your-dev-machine
```

mosh eliminates the SSH disconnection problem at the transport layer entirely.

## Monitoring During Disconnection

After reconnecting, check what happened while you were away:

```bash
# Read the bridge's auth token from the lock file
TOKEN=$(cat ~/.claude/ide/*.lock | python3 -c "import sys,json; print(json.load(sys.stdin)['authToken'])")
PORT=$(ls ~/.claude/ide/*.lock | grep -o '[0-9]*')

# Check bridge health and recent activity
curl -s -H "Authorization: Bearer $TOKEN" http://127.0.0.1:$PORT/health | python3 -m json.tool
```

The `/health` endpoint reports:
- `lastConnectAt` / `lastDisconnectAt` — when the last connection event occurred
- `activeSessions` / `sessionsInGrace` — current session states
- `recentActivity` — the last 10 tool calls with timestamps and status

## What Survives vs. What's Lost

| Scenario | tmux? | Result |
|----------|-------|--------|
| SSH drops, reconnect within grace period | Yes | **Nothing lost** — full session continuity |
| SSH drops, reconnect after grace period | Yes | Claude Code still alive, bridge creates new session. Conversation history preserved via `--resume` |
| SSH drops | No | **Everything lost** — Claude Code dies with SSH session |
| Bridge crashes | Yes | Health monitor auto-restarts bridge + Claude Code with `--resume` |
| Phone sleeps briefly | Yes | tmux keeps running, reconnect when phone wakes |

## Recommended Setup

1. Always use `npm run start-all` (launches tmux automatically)
2. Configure SSH keepalive in `~/.ssh/config`
3. Increase grace period if you expect longer disconnections
4. Use `tmux attach -t claude-all` to reconnect after SSH drops
