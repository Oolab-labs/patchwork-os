# Claude IDE Bridge — Style Guide

UI/UX patterns, code conventions, and output format standards.

---

## Code Style

### Enforced by Biome
- Indent: 2 spaces
- Organize imports: enabled
- Linter: recommended rules
- Ignored: `dist/`, `node_modules/`

### TypeScript
- Strict mode enabled
- ES2022 target, Node16 module resolution
- No implicit any

### Naming
- Files: `camelCase.ts` (tools), `camelCase.ts` (handlers)
- Tool names: `camelCase` (must match `/^[a-zA-Z0-9_]+$/`)
- Event names: `snake_case` (`claude_connected`, `extension_disconnected_notify`, `tool_call`)
- Extension methods: `extension/<camelCase>` (`extension/getDiagnostics`, `extension/goToDefinition`)
- VS Code commands: `Claude IDE Bridge: <Title Case>` (display), `claudeIdeBridge.<camelCase>` (ID)

---

## Tool Implementation Pattern

Every tool follows the factory pattern:

```typescript
// src/tools/myTool.ts
export function createMyTool(workspace: string, extensionClient: ExtensionClient) {
  const schema: ToolSchema = {
    name: "myTool",
    description: "What this tool does",
    inputSchema: {
      type: "object",
      properties: { /* ... */ },
      required: ["param1"],
    },
    extensionRequired: true,  // set if needs extension
    annotations: {
      readOnlyHint: true,     // doesn't modify state
    },
  };

  const handler: ToolHandler = async (args, signal, progress) => {
    // Implementation
    return {
      content: [{ type: "text", text: JSON.stringify(result) }],
    };
  };

  return { schema, handler };
}
```

**Registration** in `src/tools/index.ts`:
```typescript
tools.push(createMyTool(workspace, extensionClient));
```

### Tool Schema Annotations
| Annotation | Meaning |
|------------|---------|
| `readOnlyHint: true` | Tool only reads state |
| `destructiveHint: true` | Tool modifies/deletes data |
| `idempotentHint: true` | Safe to call multiple times |
| `extensionRequired: true` | Hidden when extension disconnected |

---

## Extension Handler Pattern

```typescript
// vscode-extension/src/handlers/myHandler.ts
export const handleMyAction: RequestHandler = async (params) => {
  // Use VS Code API
  return { /* result */ };
};
```

**Registration** in `vscode-extension/src/handlers/index.ts`:
```typescript
"extension/myAction": handleMyAction,
```

---

## MCP Tool Output Conventions

### Success Response
```json
{
  "content": [{ "type": "text", "text": "{\"key\": \"value\"}" }]
}
```
- Content is always an array with one `text` entry
- Text value is JSON-stringified result object
- Keep results concise; respect `maxResultSize` config (default 512 KB)

### Error Response
```json
{
  "content": [{ "type": "text", "text": "Error message here" }],
  "isError": true
}
```
- Tool errors use `isError: true` (NOT JSON-RPC error responses)
- This lets Claude understand and recover from failures
- JSON-RPC errors reserved for protocol issues (method not found, rate limit, etc.)

### Error Codes (JSON-RPC level)
| Code | Name | Usage |
|------|------|-------|
| `-32600` | `INVALID_REQUEST` | Batch requests, uninitialized calls |
| `-32601` | `METHOD_NOT_FOUND` | Unknown JSON-RPC method |
| `-32602` | `INVALID_PARAMS` | Non-object tool arguments |
| `-32603` | `INTERNAL_ERROR` | Rate limit exceeded |
| `-32000` | `TOOL_NOT_FOUND` | Unknown tool name |

---

## Logging Conventions

### Bridge Server
```typescript
this.logger.info("message");       // General info
this.logger.warn("message");       // Recoverable issues
this.logger.error("message");      // Errors
this.logger.debug("message");      // Verbose (--verbose flag)
this.logger.event("name", data);   // Structured JSONL event (--jsonl flag)
```

Child loggers for scoped context:
```typescript
const callLog = this.logger.child({ tool: "myTool", callId: "abc123" });
callLog.debug("Executing...");
```

### VS Code Extension
```typescript
bridge.log("message");         // Info to output channel
bridge.logError("message");    // Error to output channel
```

### Event Name Examples
- `bridge_started`, `claude_connected`, `claude_disconnected`
- `extension_connected`, `extension_disconnected_notify`
- `tool_call`, `diagnostics_changed`, `ai_comments_changed`
- `file_changed`, `debug_session_changed`

---

## Extension UI Patterns

### Status Bar
| State | Icon | Text | Color |
|-------|------|------|-------|
| Connected | `$(plug)` | "Claude Bridge" | Default |
| Disconnected | `$(debug-disconnect)` | "Bridge: Disconnected" | Warning |
| Reconnecting | `$(sync~spin)` | "Bridge: Reconnecting..." | — |

### Notifications
- **Info**: successful connection, version info
- **Warning**: after 3 consecutive reconnect failures (escalating)
- **Error**: critical failures only (auth rejected, incompatible version)
- Escalation pattern: silent reconnects → warning after 3 failures → persistent notification

### Output Channel
- Channel name: "Claude IDE Bridge"
- Format: `[HH:MM:SS] message`
- Structured logs only (no raw JSON dumps)

### Commands
| Display Name | Command ID | Description |
|-------------|------------|-------------|
| `Claude IDE Bridge: Reconnect` | `claudeIdeBridge.reconnect` | Force reconnect |
| `Claude IDE Bridge: Show Logs` | `claudeIdeBridge.showLogs` | Open output channel |
| `Claude IDE Bridge: Copy Connection Info` | `claudeIdeBridge.copyConnectionInfo` | Copy state to clipboard |

---

## WebSocket Safety Patterns

### Always use safeSend() for bridge→Claude messages
```typescript
const sent = await safeSend(ws, JSON.stringify(response), this.logger);
if (!sent) {
  this.logger.warn("Response dropped — socket closed");
}
```

### Best-effort for notifications (no safeSend)
Progress, log, and list_changed notifications are intentionally best-effort. Blocking tool execution on backpressure would be worse than dropping a notification.

```typescript
if (ws.readyState === WebSocket.OPEN && ws.bufferedAmount < BACKPRESSURE_THRESHOLD) {
  try { ws.send(data); } catch { /* best-effort */ }
}
```

### Extension requests use settled flag pattern
Prevents double-resolve/reject when timeout and response arrive simultaneously:
```typescript
let settled = false;
const settle = (fn: () => void) => {
  if (settled) return;
  settled = true;
  fn();
};
```
