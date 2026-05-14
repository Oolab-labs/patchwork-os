# Bridge Restart Endpoint

## Overview

The bridge now supports graceful in-place restarts via a new `POST /restart` endpoint. This allows users to apply configuration changes (like switching AI drivers) without manually restarting the bridge process.

## Endpoint Details

### `POST /restart`

**Authentication**: Requires Bearer token

**Request**: No body required

**Responses**:

- **202 Accepted** - Restart initiated successfully
  ```json
  {
    "ok": true,
    "message": "Restart initiated. Bridge will shut down gracefully.",
    "activeSessions": 2
  }
  ```

- **409 Conflict** - Restart blocked due to active work
  ```json
  {
    "ok": false,
    "error": "restart_blocked",
    "reason": "3 tool calls in progress",
    "activeSessions": 2,
    "inFlightCalls": 3,
    "busySessions": [
      "abc12345 (2 tools: file.read, git.status)",
      "def67890 (1 tool: file.write)"
    ]
  }
  ```

- **503 Service Unavailable** - Restart endpoint not configured
  ```json
  {
    "ok": false,
    "error": "restart_unavailable",
    "reason": "Restart endpoint not configured"
  }
  ```

## Safety Checks

The endpoint performs the following safety checks before allowing a restart:

1. **Session Inspection**: Iterates through all active bridge sessions
2. **In-Flight Tool Detection**: Checks each session for `activeToolCalls > 0`
3. **Rejection on Active Work**: Returns 409 if any tool calls are in progress
4. **Graceful Shutdown**: Only triggers SIGTERM when safe (no active work)

## Implementation Details

### Backend (`src/server.ts`)

- Added `restartCheckFn` callback property to `Server` class
- Endpoint checks callback, counts in-flight calls, and triggers SIGTERM if safe
- 100ms delay before SIGTERM to ensure HTTP response is delivered

### Bridge Wiring (`src/bridge.ts`)

- Wires up `server.restartCheckFn` during bridge initialization
- Callback iterates `this.sessions`, calls `transport.getStats()` on each
- Returns session count, in-flight call count, and busy session details

### Dashboard UI (`dashboard/src/app/settings/page.tsx`)

- Added restart state management: `restartPending`, `restartBusy`, `restartMsg`
- Modified `setPrimary()` to set `restartPending` when driver changes
- Added `restartBridge()` function to call `/api/bridge/restart`
- Added prominent "Restart Required" card with "Restart Bridge" button
- Shows detailed error messages if restart is blocked (e.g., active tool calls)

## User Experience

### Before (Manual Restart)

1. User changes AI driver in dashboard
2. Dashboard shows: "Restart Claude Code (quit and re-open, then run /ide) to activate the new driver."
3. User must manually quit and restart the bridge
4. User must wait for bridge to come back online
5. Dashboard reconnects automatically

### After (Automatic Restart)

1. User changes AI driver in dashboard
2. Dashboard shows: "Gemini set as primary. Click 'Restart Bridge' below to activate."
3. Prominent "Restart Required" card appears with blue "Restart Bridge" button
4. User clicks button
5. If safe (no active work):
   - Bridge sends SIGTERM to itself
   - Process manager (systemd/launchd/pm2) auto-restarts bridge
   - Dashboard shows "Bridge is restarting..."
   - Page reconnects when bridge comes back online
6. If blocked (active tool calls):
   - Dashboard shows: "3 tool calls in progress" with session details
   - User can retry when work completes

## Process Manager Requirements

The restart endpoint relies on a process manager to automatically restart the bridge after SIGTERM:

- **systemd** (Linux): `Restart=always` in service file
- **launchd** (macOS): `KeepAlive` in plist
- **pm2** (Node.js): `--restart-delay` flag
- **Docker**: `restart: unless-stopped` in compose file

Without a process manager, the bridge will shut down and not restart automatically.

## Testing

Comprehensive test coverage in `src/__tests__/restart.test.ts`:

- ✅ Returns 503 when `restartCheckFn` not configured
- ✅ Returns 202 when no sessions are active
- ✅ Returns 409 when tool calls are in-flight
- ✅ Returns 202 when sessions exist but idle
- ✅ Requires authentication (401 without Bearer token)

Run tests:
```bash
npx vitest run src/__tests__/restart.test.ts
```

## Example Usage

### cURL

```bash
# Attempt restart
curl -X POST http://localhost:3101/restart \
  -H "Authorization: Bearer your-bridge-token"

# Response (success)
{
  "ok": true,
  "message": "Restart initiated. Bridge will shut down gracefully.",
  "activeSessions": 0
}

# Response (blocked)
{
  "ok": false,
  "error": "restart_blocked",
  "reason": "2 tool calls in progress",
  "activeSessions": 1,
  "inFlightCalls": 2,
  "busySessions": ["abc12345 (2 tools: file.read, git.status)"]
}
```

### Dashboard

1. Navigate to **Settings** → **AI drivers**
2. Click "Set primary" on desired driver (e.g., Gemini)
3. Click "Restart Bridge" button in the "Restart Required" card
4. Wait for bridge to restart (typically 2-5 seconds)
5. Dashboard reconnects automatically

## Security Considerations

- **Authentication Required**: Endpoint requires valid Bearer token
- **No Force Flag**: Cannot override safety checks (prevents data loss)
- **Audit Logging**: Restart attempts logged with session/tool details
- **Rate Limiting**: Inherits server-wide rate limiting (no special bypass)

## Future Enhancements

Potential improvements for future versions:

1. **Force Restart Flag**: `POST /restart?force=true` to override safety checks
2. **Graceful Drain**: Wait for in-flight calls to complete (with timeout)
3. **Hot Reload**: Reload config without full restart for certain changes
4. **Restart Scheduling**: Schedule restart for specific time (e.g., 3am)
5. **Multi-Instance Coordination**: Coordinate restarts across bridge cluster
