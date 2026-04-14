# Claude IDE Bridge — Style Guide

Code conventions, UI patterns, and output format standards for contributors.

---

## Tool Implementation

### Factory Pattern (mandatory)

Every tool is a factory function returning `{ schema, handler }`.

```typescript
// src/tools/myTool.ts
export function createMyTool(workspace: string, extensionClient: ExtensionClient) {
  return {
    schema: {
      name: "myTool",
      description: "What this tool does in ≤200 chars",  // CI enforces limit
      inputSchema: {
        type: "object",
        properties: {
          filePath: { type: "string", description: "Absolute path to file" },
        },
        required: ["filePath"],
      },
      outputSchema: {                        // required for all new tools
        type: "object",
        properties: {
          items: { type: "array", items: { type: "object" } },
          totalCount: { type: "number" },
          truncated: { type: "boolean" },
        },
        required: ["items", "totalCount"],
      },
      extensionRequired: false,              // set true if VS Code extension needed
    },
    handler: async (params: MyParams): Promise<CallToolResult> => {
      const result = { items: [], totalCount: 0, truncated: false };
      return { content: [{ type: "text", text: JSON.stringify(result) }] };
    },
  };
}
```

### Naming

| Thing | Convention | Example |
|---|---|---|
| Tool names | `camelCase`, `/^[a-zA-Z0-9_]+$/` | `findRelatedTests` |
| Factory functions | `createXxxTool` | `createFindRelatedTestsTool` |
| Handler files | `src/tools/myTool.ts` | `src/tools/findRelatedTests.ts` |
| Test files | `src/tools/__tests__/myTool.test.ts` | `src/tools/__tests__/findRelatedTests.test.ts` |
| Extension methods | `extension/<camelCase>` | `extension/getDiagnostics` |
| VS Code command IDs | `claudeIdeBridge.<camelCase>` | `claudeIdeBridge.reconnect` |
| VS Code command display | `Claude IDE Bridge: <Title Case>` | `Claude IDE Bridge: Reconnect` |
| Event names | `snake_case` | `tool_call`, `extension_connected` |

### Registration

Add to `src/tools/index.ts` tools array:
```typescript
tools.push(createMyTool(workspace, extensionClient));
```

For slim mode (LSP/IDE-exclusive tools only): add tool name to `SLIM_TOOL_NAMES` Set in `src/tools/index.ts`.

### Tool Schema Annotations

| Annotation | Meaning |
|---|---|
| `readOnlyHint: true` | Tool only reads state, doesn't modify |
| `destructiveHint: true` | Tool modifies or deletes data |
| `idempotentHint: true` | Safe to call multiple times |
| `extensionRequired: true` | Returns error when extension disconnected |

---

## outputSchema (required for new tools)

Every new tool must include `outputSchema`. CI will fail without it.

- Fields: `description` ≤200 chars
- Handler must return data matching the schema as a JSON string in `content[0].text`
- Include `truncated` + `totalCount` whenever arrays may be capped

```typescript
outputSchema: {
  type: "object",
  properties: {
    items:      { type: "array", items: { type: "object" } },
    totalCount: { type: "number" },
    truncated:  { type: "boolean" },
  },
  required: ["items", "totalCount"],
}
```

Run `npm run schema:check` after adding a tool to confirm snapshot consistency.

---

## Error Handling

### Tool errors vs protocol errors — never mix

Tool execution errors belong in `isError: true` content. JSON-RPC errors (`-32xxx`) are for protocol issues only. See [ADR-0004](../docs/adr/0004-tool-errors-as-content.md).

```typescript
// Correct: tool error as content
return {
  isError: true,
  content: [{ type: "text", text: "File not found: foo.ts" }],
};

// Wrong: don't throw JSON-RPC errors for tool-level failures
throw new McpError(ErrorCodes.InternalError, "File not found");
```

### JSON-RPC error codes (protocol level only)

| Code | Name | Usage |
|---|---|---|
| `-32700` | `PARSE_ERROR` | Malformed JSON |
| `-32600` | `INVALID_REQUEST` | Batch requests, calls before initialize |
| `-32601` | `METHOD_NOT_FOUND` | Unknown JSON-RPC method |
| `-32602` | `INVALID_PARAMS` | Non-object tool arguments |
| `-32004` | `RATE_LIMIT_EXCEEDED` | Per-session rate limit hit |
| `-32000` | `TOOL_NOT_FOUND` | Unknown tool name |

---

## extensionClient Usage

**Never use `proxy<T>()`** — blind TypeScript cast with no runtime validation. Source of 8 latent shape-mismatch bugs (v2.25.18–v2.25.24).

Choose the right helper based on the handler's return contract:

| Helper | When to use |
|---|---|
| `tryRequest<T>(method, params, timeout, signal)` | Success path is a single `T` shape; auto-unwraps `{error}` / `{success: false, error}` to `null` |
| `validatedRequest<T>(method, params, validator)` | Success path is an object with specific required fields; pass a shape predicate |
| Direct `requestOrNull` + inline unwrap | Handler has rich contract (`{success, data, error}`) and caller needs structured error info |

**Before choosing:** read ALL return statements in `vscode-extension/src/handlers/*.ts`. Test mocks lie — the handler file is ground truth.

---

## WebSocket Safety

All `ws.send()` calls must use `safeSend()` or check `readyState + try-catch`. Never call `ws.send()` directly without a guard.

```typescript
// Correct: tool responses
const sent = await safeSend(ws, JSON.stringify(response), this.logger);
if (!sent) {
  this.logger.warn("Response dropped — socket closed");
}

// Correct: best-effort notifications (progress, list_changed)
if (ws.readyState === WebSocket.OPEN && ws.bufferedAmount < BACKPRESSURE_THRESHOLD) {
  try { ws.send(data); } catch { /* intentionally best-effort */ }
}
```

Progress and list_changed notifications are best-effort by design — blocking tool execution on backpressure is worse than dropping a notification.

---

## TypeScript Conventions

- Strict mode — no `any` without a comment explaining why
- Prefer `unknown` over `any` for untrusted input
- `!` non-null assertions only when value is provably non-null by invariant; add a comment
- `interface` for public contracts; `type` for unions and intersections
- Avoid `namespace`; use ES modules
- ES2022 target, Node16 module resolution
- Indent: 2 spaces (enforced by Biome)

### Union narrowing for composite tools

Use `"isError" in foo && foo.isError` to narrow tool result unions — don't use `as` casts.

```typescript
const result = await depTool.handler(params);
if ("isError" in result && result.isError) {
  return result; // propagate error
}
```

---

## Testing Conventions

- Framework: vitest for both bridge and extension
- Test files mirror source: `src/tools/__tests__/myTool.test.ts`
- Use factory pattern in tests: `createMyTool(mockWorkspace, mockExtensionClient)`
- Mock `ExtensionClient` with minimal interface — only mock methods the tool under test calls
- Always test error paths — assert `isError: true` in returned content
- No raw `setTimeout` in tests; use `vi.useFakeTimers()` for time-dependent logic
- `git init -b main` in git-related tests (Ubuntu CI defaults to `master`)

Coverage gates (enforced in CI):
- 75% lines
- 70% branches
- 75% functions

---

## Extension Handler Pattern

```typescript
// vscode-extension/src/handlers/myHandler.ts
export const handleMyAction: RequestHandler = async (params) => {
  // VS Code API calls
  return { result: "value" };
};
```

Register in `vscode-extension/src/handlers/index.ts`:
```typescript
"extension/myAction": handleMyAction,
```

Tests: `vscode-extension/src/__tests__/handlers/myHandler.test.ts`

---

## Logging Conventions

### Bridge server

```typescript
this.logger.info("message");        // General operational info
this.logger.warn("message");        // Recoverable issues
this.logger.error("message");       // Errors worth alerting on
this.logger.debug("message");       // Verbose (--verbose flag only)
this.logger.event("name", data);    // Structured JSONL event (--jsonl flag)
```

Child loggers for scoped context:
```typescript
const callLog = this.logger.child({ tool: "myTool", callId: "abc123" });
callLog.debug("Executing...");
```

### VS Code extension

```typescript
bridge.log("message");       // Info → output channel
bridge.logError("message");  // Error → output channel
```

Output channel name: `"Claude IDE Bridge"`. Format: `[HH:MM:SS] message`. No raw JSON dumps.

---

## Security Patterns

### runCommand flag blocking

Two complementary mechanisms:

- **`DANGEROUS_PATH_FLAGS`** (global set): flags dangerous for any command (e.g. `curl --output`, `-O`). Block regardless of which command is running.
- **`DANGEROUS_FLAGS_FOR_COMMAND`** (per-command map): flags dangerous only for specific commands. Prefer this when a flag is safe for most commands but dangerous for one (e.g. `-r` is fine for `grep -r` but dangerous for `node -r`).

Interpreter commands (node, python, bash, etc.) are permanently blocked from `--allow-command`.

### Path validation

Use `resolveFilePath` from `src/tools/utils.ts` for any user-supplied path. It rejects null bytes, symlink escapes, and paths outside the workspace.

### Automation placeholders

All untrusted placeholder values (file paths, diagnostic messages, commit messages) must be wrapped in `untrustedBlock()` with a per-trigger nonce before interpolation into prompts.

---

## Biome (Linter/Formatter)

Run before staging every changed file:

```bash
npx biome check --write src/tools/myTool.ts src/tools/__tests__/myTool.test.ts
```

**Known hazard — `?.replace()` auto-conversion:** Biome may convert `cfg.prompt!.replace(` to `cfg.prompt?.replace(`, changing the return type from `string` to `string | undefined`. After running biome on `automation.ts` or similar files, grep for `?.replace(` on prompt variables and restore `!.replace(` where the value is guaranteed non-null.

---

## Commit Style

Conventional Commits. Subject ≤72 chars. Imperative mood. No AI attribution.

```
feat(tools): add findRelatedTests tool
fix(automation): cap LSP retry sleep to remaining deadline
chore(release): bump to v2.30.0
refactor(transport): extract cursor pagination helper
test(lsp): add contract tests for goToDefinition fallback
```

---

## File Organization

```
src/
  tools/
    myTool.ts                    # tool implementation (factory pattern)
    __tests__/
      myTool.test.ts             # unit tests
    headless/                    # LSP fallback tools (no extension required)
  automation.ts                  # automation hooks
  bridge.ts                      # main Bridge class
  transport.ts                   # MCP transport layer (WebSocket + HTTP)
  extensionClient.ts             # VS Code extension proxy
  companions/
    registry.ts                  # companion package registry
  commands/
    install.ts                   # install subcommand

vscode-extension/src/
  handlers/
    myHandler.ts                 # extension-side handler
    index.ts                     # handler registration
  __tests__/handlers/
    myHandler.test.ts
```

---

## Adding a New Tool — Checklist

1. Create `src/tools/myTool.ts` with factory pattern
2. Add `outputSchema` — CI fails without it
3. Keep all descriptions (tool, fields, args) ≤200 chars
4. Set `extensionRequired: true` if the tool needs VS Code
5. Add to `src/tools/index.ts` tools array
6. If slim-mode eligible: add name to `SLIM_TOOL_NAMES` Set
7. Write tests in `src/tools/__tests__/myTool.test.ts`; test error paths
8. Run `npx biome check --write src/tools/myTool.ts src/tools/__tests__/myTool.test.ts`
9. Run `node scripts/audit-lsp-tools.mjs` — confirms description gate passes
10. Run `npm run schema:check` — confirms outputSchema snapshot is consistent
11. Run `npm test` — all tests pass

---

## MCP Output Conventions

### Success response

```json
{
  "content": [{ "type": "text", "text": "{\"items\": [], \"totalCount\": 0}" }]
}
```

Content is always an array with one `text` entry. Text is a JSON-stringified result object. Respect `maxResultSize` config (default 512 KB).

### Error response

```json
{
  "content": [{ "type": "text", "text": "Descriptive error message" }],
  "isError": true
}
```

Descriptive messages help Claude understand and recover. Include the relevant value (filename, symbol name) in the message.

---

## Extension UI Patterns

### Status bar

| State | Icon | Text | Color |
|---|---|---|---|
| Connected | `$(plug)` | "Claude Bridge" | Default |
| Disconnected | `$(debug-disconnect)` | "Bridge: Disconnected" | Warning |
| Reconnecting | `$(sync~spin)` | "Bridge: Reconnecting..." | — |

### Notifications

- **Info**: successful connection, version info
- **Warning**: after 3 consecutive reconnect failures
- **Error**: critical failures only (auth rejected, incompatible version)

Escalation: silent reconnects → warning after 3 failures → persistent notification.

### Commands

| Display Name | Command ID |
|---|---|
| `Claude IDE Bridge: Reconnect` | `claudeIdeBridge.reconnect` |
| `Claude IDE Bridge: Show Logs` | `claudeIdeBridge.showLogs` |
| `Claude IDE Bridge: Copy Connection Info` | `claudeIdeBridge.copyConnectionInfo` |
