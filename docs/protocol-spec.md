# Claude IDE Bridge — Protocol Specification

**Audience:** Developers building clients for the bridge (Neovim, JetBrains, Zed, custom tooling).  
**Bridge version:** 2.35.x  
**MCP protocol version:** 2025-11-25

---

## 1. Transport Overview

The bridge exposes three transports. Choose based on your deployment:

| Transport | Use when |
|---|---|
| **WebSocket** | Local IDE plugin connecting to a bridge running on the same machine |
| **stdio shim** | Claude Desktop (uses `claude-ide-bridge shim` — wraps WebSocket in stdin/stdout JSON-RPC) |
| **Streamable HTTP** | Remote access (claude.ai custom connectors, Codex CLI, cross-machine) |

All three transports speak MCP (JSON-RPC 2.0). The wire protocol is identical; only the framing differs.

---

## 2. WebSocket Transport

### 2.1 Finding the port and token

The bridge writes a lock file on startup:

```
~/.claude/ide/<port>.lock
```

The file is JSON with these fields:

```json
{
  "pid": 12345,
  "port": 50000,
  "workspace": "/path/to/workspace",
  "authToken": "abcdef...",
  "isBridge": true
}
```

**Selection rules:**
- `isBridge: true` — distinguishes bridge-owned locks from IDE-owned locks (see [ADR-0003](adr/0003-isbridge-lock-file-flag.md))
- Match `workspace` against your target directory (absolute path, normalized)
- If multiple locks exist, prefer the most recently modified one

Lock file permissions are `0o600` (owner read/write only). The file is created with `O_EXCL` to prevent symlink attacks.

### 2.2 Connecting

```
ws://127.0.0.1:<port>
```

Required headers on the WebSocket upgrade request:

```
x-claude-code-ide-authorization: <authToken>
```

Optional header for session resumption (see §2.4):

```
X-Claude-Code-Session-Id: <uuid>
```

**Host header restriction:** The bridge validates the HTTP `Host` header against a loopback allowlist (`localhost`, `127.0.0.1`, `[::1]`). Connections with other Host values are rejected with HTTP 403. This is a DNS-rebinding defense.

**Origin header restriction:** Browser-originated connections (non-`vscode-*` origins) are rejected. IDE plugin connections should omit the `Origin` header entirely, or use a `vscode-file://` / `vscode-webview://` origin.

**Connection throttle:** A minimum 500 ms must elapse between successive WebSocket connections from the same client type. Rapid reconnects receive HTTP 429.

### 2.3 Wire framing

JSON-RPC 2.0 messages are sent as UTF-8 text WebSocket frames. Each frame is one complete JSON object — there is no Content-Length framing. Maximum payload: 4 MB.

Keepalive: the bridge sends WebSocket ping frames every 10 seconds (default; configurable). After 4 missed pongs the connection is terminated.

### 2.4 Session resumption

After a disconnect, the bridge holds session state for a grace period (default: 120 seconds). To resume:

1. Read the same lock file as before (token unchanged).
2. Connect with the header `X-Claude-Code-Session-Id: <your-previous-session-uuid>`.
3. The bridge reattaches the existing `McpTransport` instance — no re-initialization needed, rate-limit counters preserved.

The stdio shim generates a stable per-process UUID automatically.

---

## 3. MCP Handshake

All transports follow the same MCP initialization sequence.

### 3.1 Step 1 — `initialize` request (client → server)

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "initialize",
  "params": {
    "protocolVersion": "2025-11-25",
    "clientInfo": {
      "name": "my-neovim-plugin",
      "version": "1.0.0"
    },
    "capabilities": {}
  }
}
```

**Supported protocol versions:** `["2025-11-25"]`. If the client requests an unsupported version the bridge responds with its newest supported version (not an error).

### 3.2 Step 2 — `initialize` response (server → client)

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "result": {
    "protocolVersion": "2025-11-25",
    "capabilities": {
      "tools": { "listChanged": true },
      "resources": { "listChanged": false },
      "prompts": { "listChanged": false },
      "logging": {},
      "elicitation": {}
    },
    "serverInfo": {
      "name": "claude-ide-bridge",
      "version": "1.1.0",
      "_meta": { "packageVersion": "2.35.1" }
    },
    "instructions": "..."
  }
}
```

`serverInfo.version` is the wire protocol version (`BRIDGE_PROTOCOL_VERSION`, currently `"1.1.0"`). The npm package version is in `_meta.packageVersion`. See [ADR-0001](adr/0001-dual-version-numbers.md) for the dual-version design.

### 3.3 Step 3 — `notifications/initialized` (client → server)

```json
{
  "jsonrpc": "2.0",
  "method": "notifications/initialized"
}
```

This notification completes the handshake. The bridge will reject `tools/list` and `tools/call` until this is received.

### 3.4 `tools/list`

```json
{
  "jsonrpc": "2.0",
  "id": 2,
  "method": "tools/list",
  "params": {}
}
```

Response (paginated):

```json
{
  "jsonrpc": "2.0",
  "id": 2,
  "result": {
    "tools": [ ... ],
    "nextCursor": "MTAw"
  }
}
```

**Pagination:** If `nextCursor` is present, send another `tools/list` with `{ "cursor": "<nextCursor>" }` to fetch the next page. The cursor is an opaque base64-encoded decimal offset. Page size: 200 tools per page.

### 3.5 `tools/call`

```json
{
  "jsonrpc": "2.0",
  "id": 3,
  "method": "tools/call",
  "params": {
    "name": "getDiagnostics",
    "arguments": { "uri": "src/index.ts" },
    "_meta": { "progressToken": "tok1" }
  }
}
```

Success response:

```json
{
  "jsonrpc": "2.0",
  "id": 3,
  "result": {
    "content": [{ "type": "text", "text": "..." }],
    "structuredContent": { ... }
  }
}
```

Tool-level error (not a JSON-RPC error):

```json
{
  "jsonrpc": "2.0",
  "id": 3,
  "result": {
    "content": [{ "type": "text", "text": "{\"error\": \"...\", \"code\": \"extension_required\"}" }],
    "isError": true
  }
}
```

**Important:** Tool execution errors are returned as `isError: true` content blocks — they are **not** JSON-RPC error responses. JSON-RPC error responses (`error` field) are reserved for protocol-level failures. See [ADR-0004](adr/0004-tool-errors-as-content.md).

**Cancellation:** Send `notifications/cancelled` with `{ "requestId": <id> }` to abort an in-flight tool call.

**Concurrent limit:** Maximum 10 simultaneous in-flight tool calls. Exceeding this returns `isError: true` (not a JSON-RPC error).

---

## 4. Extension Handshake (VS Code Extension ↔ Bridge)

The VS Code extension connects on a **separate** WebSocket to the same port. This is distinct from the MCP client connection.

### 4.1 Extension upgrade

The extension sends a different auth header:

```
x-claude-ide-extension: <authToken>
```

Same token as the MCP client. The bridge routes connections by header name.

### 4.2 `extension/hello` notification

After connecting, the extension sends:

```json
{
  "method": "extension/hello",
  "params": {
    "extensionVersion": "1.1.0",
    "packageVersion": "1.4.5",
    "workspace": "/path/to/workspace"
  }
}
```

- `extensionVersion` — wire protocol version (e.g. `"1.1.0"`)
- `packageVersion` — npm package version (e.g. `"1.4.5"`)
- The bridge logs a warning if the major wire versions differ

### 4.3 Effect on tool availability

When the extension is connected, LSP and editor tools become functional. When disconnected:
- Tools with `extensionRequired: true` return `isError: true` with code `extension_required`
- These tools still appear in `tools/list` — clients should not hide them
- The bridge's `getBridgeStatus` tool reports connection state

**Slim mode:** If the bridge started with `--slim`, only ~60 tools are registered (all LSP/editor tools, no shell/git/orchestration). Extension connection still enables LSP functionality within that set. Full mode (the default since v2.43.0) registers ~140 tools.

---

## 5. Streamable HTTP Transport

Endpoint: `POST/GET/DELETE /mcp`

Auth: `Authorization: Bearer <token>` (same token from lock file, or OAuth access token in remote mode).

### 5.1 Creating a session — `POST /mcp`

Send the `initialize` request as JSON body:

```
POST /mcp HTTP/1.1
Content-Type: application/json
Authorization: Bearer <token>

{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-11-25","clientInfo":{"name":"my-client","version":"1.0.0"},"capabilities":{}}}
```

Response includes the session ID header:

```
HTTP/1.1 200 OK
Content-Type: application/json
Mcp-Session-Id: 550e8400-e29b-41d4-a716-446655440000

{"jsonrpc":"2.0","id":1,"result":{...}}
```

All subsequent requests must include `Mcp-Session-Id: <id>`.

### 5.2 Sending requests — `POST /mcp`

```
POST /mcp HTTP/1.1
Content-Type: application/json
Authorization: Bearer <token>
Mcp-Session-Id: 550e8400-e29b-41d4-a716-446655440000

{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"getDiagnostics","arguments":{}}}
```

- Requests (with `id`) → bridge waits for tool completion, returns JSON response body
- Notifications (no `id`) → bridge returns `202 Accepted` with empty body

Body size limit: 1 MB.

### 5.3 Receiving server-initiated notifications — `GET /mcp`

```
GET /mcp HTTP/1.1
Authorization: Bearer <token>
Mcp-Session-Id: 550e8400-e29b-41d4-a716-446655440000
Accept: text/event-stream
```

Response is a Server-Sent Events stream:

```
Content-Type: text/event-stream

id: 0
data: {"jsonrpc":"2.0","method":"notifications/progress","params":{...}}

id: 1
data: {"jsonrpc":"2.0","method":"notifications/tools/list_changed","params":{}}

: heartbeat
```

Each SSE event has a monotonic numeric `id`. The bridge sends `: heartbeat` comments every 20 seconds to keep the stream alive through proxies.

**Reconnect with replay:** If the SSE connection drops, reconnect with `Last-Event-ID: <last-seen-id>`. The bridge replays buffered notifications (up to 100 events, within the last 30 seconds):

```
GET /mcp HTTP/1.1
Last-Event-ID: 5
Mcp-Session-Id: 550e8400-...
```

### 5.4 Closing a session — `DELETE /mcp`

```
DELETE /mcp HTTP/1.1
Authorization: Bearer <token>
Mcp-Session-Id: 550e8400-e29b-41d4-a716-446655440000
```

Returns `200 OK`. The session is immediately terminated.

### 5.5 Session limits

- Max 5 concurrent HTTP sessions (configurable via `--max-sessions`)
- Idle TTL: 2 hours
- On capacity, the oldest idle session (idle > 60 s) is evicted

See [ADR-0005](adr/0005-http-session-eviction.md).

### 5.6 Session-scoped tool deny list

Send `X-Bridge-Deny-Tools: toolName1,toolName2` on the `initialize` POST to block specific tools for that session. Denied tools return `isError: true` at call time but still appear in `tools/list`.

---

## 6. Error Codes

### 6.1 JSON-RPC protocol errors

These appear in the `error` field of a JSON-RPC response. Used for protocol-level failures only.

| Code | Name | Cause |
|---|---|---|
| -32700 | PARSE_ERROR | Message is not valid JSON |
| -32600 | INVALID_REQUEST | Batch requests, duplicate IDs, pre-init calls |
| -32601 | METHOD_NOT_FOUND | Unknown method |
| -32602 | INVALID_PARAMS | AJV schema validation failure on tool arguments |
| -32001 | BRIDGE_UNAVAILABLE | Bridge not ready |
| -32003 | TOOL_NOT_FOUND | Tool name not registered |
| -32004 | RATE_LIMIT_EXCEEDED | Session request rate limit (200/min) exceeded |
| -32029 | TOOL_CALL_RATE_LIMIT_EXCEEDED | Per-session tool call rate limit exceeded |

Note: AJV validation failures do **not** consume a rate-limit token.

### 6.2 Tool error codes

These appear inside `content[0].text` as a JSON object when `isError: true`. They are **not** JSON-RPC error codes.

| Code string | Meaning |
|---|---|
| `file_not_found` | Workspace file does not exist |
| `permission_denied` | Path outside workspace or access denied |
| `workspace_escape` | Path traversal attempt detected |
| `extension_required` | Tool needs VS Code extension (not connected) |
| `timeout` | Tool execution exceeded its timeout |
| `invalid_args` | Tool-level argument validation failure |
| `git_error` | Git command failed |
| `external_command_failed` | Shell command exited with non-zero |
| `task_not_found` | Claude orchestrator task ID not found |
| `driver_not_configured` | Orchestrator driver set to `none` |

---

## 7. Rate Limiting

### 7.1 Session request rate limit

- **Limit:** 200 requests per 60-second sliding window
- **Scope:** per session (not per IP)
- **Implementation:** O(1) ring buffer (`Float64Array` of 200 timestamps)
- **On limit:** JSON-RPC error `-32004` with message "Rate limit exceeded"
- **Reconnect behavior:** The rate-limit counter is **not reset** on reconnect. Rapidly cycling connections cannot bypass the limit.

### 7.2 Tool call token bucket

- **Default:** 60 tool calls per minute per session
- **Configurable:** `--tool-rate-limit <n>` flag
- **On limit:** JSON-RPC error `-32029`
- **HTTP sessions:** All HTTP sessions for the same client share a bucket (prevents bypass via session cycling)

### 7.3 Notification rate limit

- **Limit:** 500 client-to-server notifications per minute
- **On limit:** notification is silently dropped (no error response — notifications have no response channel)

---

## 8. Slim vs Full Mode

### 8.1 Modes

| Mode | Flag | Tool count | What's included |
|---|---|---|---|
| Full | _(default since v2.43.0)_ | ~140 | Slim + file I/O, shell commands, git, GitHub, orchestration, test runner |
| Slim | `--slim` | ~60 | All LSP, diagnostics, editor state, debugger, bridge introspection |

### 8.2 Slim tool set

Slim mode exposes: editor state (`getOpenEditors`, `getCurrentSelection`, `captureScreenshot`, `contextBundle`, ...), LSP/code intelligence (`getDiagnostics`, `goToDefinition`, `findReferences`, `getCallHierarchy`, `explainSymbol`, `getSemanticTokens`, ...), editor decorations (`setEditorDecorations`, `clearEditorDecorations`), debugger (`setDebugBreakpoints`, `startDebugging`, `evaluateInDebugger`), and bridge introspection (`getBridgeStatus`, `getToolCapabilities`, `searchTools`).

Full-mode-only tools include: `runInTerminal`, `getFileTree`, `editText`, `createFile`, `getGitStatus`, `gitCommit`, `runTests`, `runClaudeTask`, and ~88 others.

### 8.3 Detecting current mode

Call `getToolCapabilities` after the MCP handshake:

```json
{
  "jsonrpc": "2.0",
  "id": 4,
  "method": "tools/call",
  "params": {
    "name": "getToolCapabilities",
    "arguments": {}
  }
}
```

The response includes `fullMode: true|false` and the full tool availability table including which tools have extension/probe fallbacks.

---

## 9. HTTP Utility Endpoints

These endpoints are available over HTTP (no WebSocket) on the same port.

| Method | Path | Auth required | Description |
|---|---|---|---|
| GET | `/ping` | No | Liveness probe. Returns `{"ok":true,"v":"<version>"}` |
| GET | `/health` | No | Health data: `status`, `uptimeMs`, `connections`, extension state |
| GET | `/ready` | No | 200 if MCP handshake complete, 503 if not |
| GET | `/dashboard` | No | HTML dashboard (disable with `--no-dashboard`) |
| GET | `/dashboard/data` | No | JSON dashboard data |
| GET | `/status` | Yes | Rich session + event data |
| GET | `/metrics` | Yes | Prometheus text format |
| GET | `/analytics` | Yes | Tool usage analytics (`?windowHours=N`) |
| GET | `/stream` | Yes | SSE activity event stream (max 20 subscribers) |
| GET | `/tasks` | Yes | Orchestrator task list (no raw prompts) |
| POST | `/notify` | Yes | CC hook event delivery (automation) |
| GET | `/.well-known/mcp/server-card.json` | No | MCP server card |

---

## 10. OAuth 2.0 Mode (Remote Deployments)

When the bridge is started with `--issuer-url <public-https-url>`, it activates an OAuth 2.0 authorization server. This is required for claude.ai custom connector integration.

**Endpoints:**

| Path | Standard |
|---|---|
| `GET /.well-known/oauth-authorization-server` | RFC 8414 discovery |
| `GET /.well-known/oauth-protected-resource` | RFC 9396 resource metadata |
| `POST /oauth/register` | RFC 7591 dynamic client registration |
| `GET /oauth/authorize` | Authorization code flow (PKCE S256 required) |
| `POST /oauth/token` | Token exchange |
| `POST /oauth/revoke` | RFC 7009 token revocation |

**Token properties:**
- Auth codes: single-use, 5-minute TTL
- Access tokens: opaque base64url, 24-hour TTL (configurable via `oauthTokenTtlDays`)
- No refresh tokens — clients re-authorize on expiry

**Usage:** OAuth access tokens are accepted as `Authorization: Bearer` on HTTP endpoints only. WebSocket connections must use the static bridge token via `x-claude-code-ide-authorization`.

---

## 11. Quick-Start Example (curl)

```bash
# 1. Find the lock file
PORT=$(ls ~/.claude/ide/*.lock | xargs -I{} sh -c 'python3 -c "import json,sys; d=json.load(open(sys.argv[1])); print(d[\"port\"]) if d.get(\"isBridge\") else None" {}' 2>/dev/null | head -1)
TOKEN=$(cat ~/.claude/ide/${PORT}.lock | python3 -c "import json,sys; print(json.load(sys.stdin)['authToken'])")

# 2. Initialize session
curl -s -X POST http://127.0.0.1:${PORT}/mcp \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer ${TOKEN}" \
  -D - \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-11-25","clientInfo":{"name":"curl-test","version":"1.0"},"capabilities":{}}}'

# Save Mcp-Session-Id from response headers, then:

SESSION_ID=<id-from-response>

# 3. Complete handshake (notifications/initialized)
curl -s -X POST http://127.0.0.1:${PORT}/mcp \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer ${TOKEN}" \
  -H "Mcp-Session-Id: ${SESSION_ID}" \
  -d '{"jsonrpc":"2.0","method":"notifications/initialized"}'

# 4. List tools
curl -s -X POST http://127.0.0.1:${PORT}/mcp \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer ${TOKEN}" \
  -H "Mcp-Session-Id: ${SESSION_ID}" \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}'

# 5. Call a tool
curl -s -X POST http://127.0.0.1:${PORT}/mcp \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer ${TOKEN}" \
  -H "Mcp-Session-Id: ${SESSION_ID}" \
  -d '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"getBridgeStatus","arguments":{}}}'

# 6. Close session
curl -s -X DELETE http://127.0.0.1:${PORT}/mcp \
  -H "Authorization: Bearer ${TOKEN}" \
  -H "Mcp-Session-Id: ${SESSION_ID}"
```

---

## 12. Architecture Decision Records

| ADR | Topic |
|---|---|
| [ADR-0001](adr/0001-dual-version-numbers.md) | Dual version numbers: wire protocol vs npm package |
| [ADR-0002](adr/0002-generation-guards-on-reconnect.md) | Generation guards preventing stale callbacks |
| [ADR-0003](adr/0003-isbridge-lock-file-flag.md) | `isBridge` flag in lock file |
| [ADR-0004](adr/0004-tool-errors-as-content.md) | Tool errors as `isError:true` content, not JSON-RPC errors |
| [ADR-0005](adr/0005-http-session-eviction.md) | HTTP session eviction policy |
