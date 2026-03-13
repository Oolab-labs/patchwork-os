# Claude IDE Bridge — Data Reference

Domain data connections, state management, and protocol flows that are not expressed directly in the code's type system.

---

## Connection Topology

```
                    ┌──────────────────┐
                    │  Lock File       │
                    │  ~/.claude/ide/  │
                    │  <port>.lock     │
                    └────────┬─────────┘
                             │ discovery
                             ▼
┌──────────────┐    ┌──────────────────┐    ┌──────────────────┐
│ Claude Code  │◄──►│  Bridge Server   │◄──►│  VS Code         │
│ CLI          │ WS │  (Node.js)       │ WS │  Extension       │
│              │ MCP│                  │    │                  │
└──────────────┘    └──────────────────┘    └──────────────────┘
                         │          │          │
                    /health   /status   /metrics
                    (HTTP)    (JSON)    (Prometheus)
```

**Two independent WebSocket connections:**
1. **Claude Code → Bridge**: MCP protocol (JSON-RPC 2.0). Authenticated via lock file token.
2. **Extension → Bridge**: Custom request/response + notifications protocol. Authenticated via `x-claude-ide-extension` header.

---

## State Ownership

### Bridge Server (`bridge.ts`)
| State | Type | Lifecycle |
|-------|------|-----------|
| `sessions` | `Map<string, AgentSession>` | One entry per connected Claude Code client (max 5); removed on disconnect+grace expiry |
| `authToken` | `string` (UUID) | Generated once at startup; never changes |
| `listChangedTimer` | `setTimeout` | Debounce timer for `tools/list_changed` notifications (2s) |
| `lastConnectAt` | `string \| null` | ISO timestamp of most recent Claude Code connection |
| `lastDisconnectAt` | `string \| null` | ISO timestamp of most recent Claude Code disconnection |
| `checkpoint` | `SessionCheckpoint \| null` | Writes periodic snapshots to `~/.claude/ide/checkpoint-<port>.json` |

### AgentSession (per-connection, inside `bridge.ts`)
| State | Type | Lifecycle |
|-------|------|-----------|
| `id` | `string` | Unique 8-char hex per connection |
| `openedFiles` | `Set<string>` | Preserved during grace period; cleared on new session or grace expiry |
| `currentWs` | `WebSocket \| null` | Active WebSocket for this session |
| `graceTimer` | `setTimeout \| null` | Grace period timer (config.gracePeriodMs, default 30s) before full cleanup |
| `terminalPrefix` | `string` | Session-scoped terminal name prefix (agent teams) |
| `connectedAt` | `number` | Unix timestamp of initial connection |

### Transport (`transport.ts`)
| State | Type | Lifecycle |
|-------|------|-----------|
| `generation` | `number` | Incremented on each `attach()`; stale handlers check this |
| `activeToolCalls` | `number` | Floor-guarded with `Math.max(0, ...)` |
| `inFlightControllers` | `Map<id, AbortController>` | Cleared on `detach()` |
| `rateLimitBuf` | `Float64Array(200)` | Ring buffer for O(1) sliding-window rate limiting |
| `rateLimitHead` | `number` | Pointer into ring buffer |
| `initialized` | `boolean` | Reset on new `initialize` request; blocks `tools/list` and `tools/call` |
| `clientLogLevel` | `LogLevel` | Set by client via `logging/setLevel` |

### Extension Client (`extensionClient.ts`)
| State | Type | Lifecycle |
|-------|------|-----------|
| `latestDiagnostics` | `Map<string, Diagnostic[]>` | Pushed by extension; capped at 500 files; NOT cleared on reconnect |
| `latestSelection` | `SelectionState \| null` | Last known editor selection |
| `latestActiveFile` | `string \| null` | Last known active file path |
| `latestAIComments` | `Map<string, AIComment[]>` | Pushed by extension; capped at 200 files |
| `latestDebugState` | `DebugState \| null` | Pushed by extension on debug session changes |
| `extensionSuspendedUntil` | `number` | Circuit breaker: timestamp until requests are fast-failed |
| `extensionFailures` | `number` | Consecutive failure count for backoff calculation |
| `extensionHalfOpen` | `boolean` | Circuit breaker half-open probe state |
| `diagnosticsListeners` | `Set<Function>` | Cleared on extension disconnect (prevents stale closures) |
| `pendingRequests` | `Map<number, PendingRequest>` | All rejected on disconnect; use `settled` flag pattern |

### ActivityLog (`activityLog.ts`)
| State | Type | Lifecycle |
|-------|------|-----------|
| `entries` | `ActivityEntry[]` | Capped at `maxEntries` (default 500); batch-evicted at 120% capacity |
| `lifecycleEntries` | `LifecycleEntry[]` | Same cap; records connection lifecycle events |
| `nextId` | `number` | Shared monotonic counter across both entry types (enables timeline merge) |
| `persistPath` | `string \| null` | Set via `setPersistPath()`; enables JSONL append to `~/.claude/ide/activity-<port>.jsonl` |

### SessionCheckpoint (`sessionCheckpoint.ts`)
| State | Type | Lifecycle |
|-------|------|-----------|
| `checkpointPath` | `string` | `~/.claude/ide/checkpoint-<port>.json` |
| `intervalHandle` | `ReturnType<setInterval> \| null` | Writes every 30s (unref'd — doesn't block process exit) |

---

## Auth Flow

```
1. Bridge starts → generates random UUID → writes to ~/.claude/ide/<port>.lock
   Lock file: { authToken, pid, workspace, ideName }

2. Claude Code CLI → scans ~/.claude/ide/*.lock → finds matching workspace
   → connects WebSocket with auth token in upgrade headers

3. VS Code Extension → scans same lock files → connects with x-claude-ide-extension header
   → sends extension/hello notification with version

4. Bridge validates token → accepts or rejects upgrade
```

**Key constraints:**
- One bridge per workspace (start with `--workspace`)
- Lock files cleaned on startup (`cleanStale()` removes dead PIDs)
- Lock file deleted on graceful shutdown

---

## Tool Lifecycle

```
Registration (startup):
  registerAllTools() → transport.registerTool(schema, handler, timeoutMs?)
  └─ Tool name validated: /^[a-zA-Z0-9_]+$/

Discovery (runtime):
  Claude sends tools/list → transport filters by extensionRequired flag
  └─ extension connected: all tools visible
  └─ extension disconnected: extensionRequired tools hidden

Execution:
  Claude sends tools/call → rate limit check → concurrent limit check
  → create AbortController → start timeout race
  → handler executes → record in activityLog
  → respond with result or isError:true content

Cancellation:
  Claude sends notifications/cancelled → abort controller fires
  → handler receives AbortSignal.aborted

Timeout:
  60s default (per-tool override via timeoutMs)
  → controller.abort() → zombie tracking logs late completion
```

---

## Extension Request/Response Protocol

```
Bridge → Extension:
  { jsonrpc: "2.0", id: <number>, method: "extension/<method>", params: {...} }

Extension → Bridge:
  { jsonrpc: "2.0", id: <number>, result: {...} }
  or
  { jsonrpc: "2.0", id: <number>, error: { message: "..." } }

Extension → Bridge (notifications, no id):
  { jsonrpc: "2.0", method: "extension/<event>", params: {...} }
```

**Extension notification types:**
| Method | Data | Trigger |
|--------|------|---------|
| `extension/diagnosticsChanged` | `{ file, diagnostics[] }` | VS Code `onDidChangeDiagnostics` |
| `extension/selectionChanged` | `{ file, startLine, endLine, ... selectedText }` | Editor selection change |
| `extension/activeFileChanged` | `{ file }` | Active editor tab change |
| `extension/aiCommentsChanged` | `{ comments[] }` | `// AI:` comment scan results |
| `extension/fileChanged` | `{ id, type, file }` | Watched file change event |
| `extension/debugSessionChanged` | `{ hasActiveSession, ... }` | Debug session start/stop/pause |
| `extension/hello` | `{ extensionVersion }` | On connect (version handshake) |
| `extension/fileSaved` | `{}` | File save event (currently unused) |

**Circuit breaker behavior:**
1. Extension request times out (10s default)
2. `extensionFailures` incremented
3. Backoff calculated: `random(1, min(1000 * 2^(failures-1), 60000))` ms (AWS full jitter)
4. All requests fast-failed with `ExtensionTimeoutError` until backoff expires
5. First request after backoff: half-open probe
6. Success: reset all counters. Failure: recalculate backoff.

---

## Diagnostic Data Flow

```
WITH extension:
  VS Code diagnostics API → extension/diagnosticsChanged notification
  → extensionClient.latestDiagnostics cache (Map<file, Diagnostic[]>)
  → bridge sends notifications/tools/list_changed to Claude (debounced 2s)
  → Claude queries getDiagnostics tool → returns cached + fresh from extension

WITHOUT extension (fallback):
  getDiagnostics tool → runs CLI linters directly:
  → tsc --noEmit (TypeScript)
  → eslint (JavaScript/TypeScript)
  → pyright / ruff (Python)
  → cargo check (Rust)
  → go vet (Go)
  → biome check (JS/TS)
  Auto-detected via probeAll() at startup

watchDiagnostics (long-poll):
  → registers listener in diagnosticsListeners Set
  → waits for next diagnosticsChanged notification
  → returns new diagnostics (or times out)
  → listeners cleared on extension disconnect
```

---

## Notification Flow (Bridge → Claude Code)

```
notifications/tools/list_changed:
  Triggered by: extension connect, extension disconnect, diagnostics change,
                AI comments change, file change, debug session change
  Debounced: 2s (except extension connect — immediate)
  Effect: Claude re-queries tools/list to discover new/removed tools

notifications/progress:
  Triggered by: tools calling progressFn(progress, total?, message?)
  Backpressure-aware: skipped if bufferedAmount > threshold
  Best-effort: no retry on failure

notifications/message:
  Triggered by: bridge.sendLogMessage(level, logger, data)
  Filtered by: clientLogLevel (set via logging/setLevel)
  Best-effort: no retry on failure
```

---

## Extension Handler Protocol Reference

All handler methods use the `extension/` prefix and communicate via JSON-RPC 2.0 over WebSocket. Positions use **1-based** line and column numbers in the protocol (converted to 0-based internally). **55 handler methods** total across 7 registration groups.

### LSP (9 methods)

| Method | Parameters | Return Shape |
|--------|-----------|--------------|
| `extension/goToDefinition` | `file, line, column` | `Array<{file, line, column, endLine, endColumn}>` or `null` |
| `extension/findReferences` | `file, line, column` | `{references: Array<{file, line, column, ...}>, count}` |
| `extension/getHover` | `file, line, column` | `{contents: string[], range}` or `null` |
| `extension/getCodeActions` | `file, startLine, startColumn, endLine, endColumn` | `{actions: Array<{title, kind, isPreferred}>}` |
| `extension/applyCodeAction` | `file, startLine, startColumn, endLine, endColumn, actionTitle` | `{applied, title?, error?}` |
| `extension/renameSymbol` | `file, line, column, newName` | `{success, affectedFiles?, totalEdits?}` |
| `extension/searchSymbols` | `query, maxResults?` (max 200) | `{symbols: Array<{name, kind, file, line, ...}>, count, truncated}` |
| `extension/getDocumentSymbols` | `file` | `{symbols: Array<{name, kind, detail, line, ...}>, count}` |
| `extension/getCallHierarchy` | `file, line, column, direction?, maxResults?` | `{symbol, incoming?, outgoing?}` or `null` |

### Terminal (7 methods)

| Method | Parameters | Return Shape |
|--------|-----------|--------------|
| `extension/listTerminals` | _(none)_ | `{terminals: Array<{name, index, isActive, hasOutputCapture}>, count}` |
| `extension/getTerminalOutput` | `name?, index?, lines?` (default 100) | `{available, terminalName, lines?, lineCount?}` |
| `extension/createTerminal` | `name?, cwd?, env?, show?` | `{success, name, index}` |
| `extension/disposeTerminal` | `name?, index?` | `{success, terminalName?}` |
| `extension/sendTerminalCommand` | `text, name?, index?, addNewline?` | `{success, terminalName?}` |
| `extension/executeInTerminal` | `command, name?, index?, timeoutMs?, show?` | `{success, exitCode?, output?, truncated?}` |
| `extension/waitForTerminalOutput` | `pattern (regex), name?, index?, timeoutMs?` | `{matched, matchedLine?, elapsed?}` |

### Debug (5 methods)

| Method | Parameters | Return Shape |
|--------|-----------|--------------|
| `extension/getDebugState` | _(none)_ | `{hasActiveSession, isPaused, callStack?, scopes?, breakpoints}` |
| `extension/evaluateInDebugger` | `expression, frameId?, context?` | `{result, type?}` |
| `extension/setDebugBreakpoints` | `file, breakpoints: Array<{line, condition?, hitCondition?, logMessage?}>` | `{set, file}` |
| `extension/startDebugging` | `configName?` | `{started}` |
| `extension/stopDebugging` | _(none)_ | `{stopped}` |

### Files (10 methods)

| Method | Parameters | Return Shape |
|--------|-----------|--------------|
| `extension/getOpenFiles` | _(none)_ | `Array<{filePath, isActive, isDirty, languageId?}>` |
| `extension/isDirty` | `file` | `boolean` |
| `extension/openFile` | `file, line?` | `true` |
| `extension/saveFile` | `file` | `true` or `{success: false, error}` |
| `extension/closeTab` | `file` | `{success, promptedToSave?}` |
| `extension/getFileContent` | `file` | `{content, isDirty, languageId, lineCount, version, source}` |
| `extension/createFile` | `filePath, content?, isDirectory?, overwrite?, openAfterCreate?` | `{success, filePath, created}` |
| `extension/deleteFile` | `filePath, recursive?, useTrash?` | `{success, filePath, deleted}` |
| `extension/renameFile` | `oldPath, newPath, overwrite?` | `{success, oldPath, newPath, renamed}` |
| `extension/getWorkspaceFolders` | _(none)_ | `{folders: Array<{name, path, uri, index}>, count}` |

### Text Editing (2 methods)

| Method | Parameters | Return Shape |
|--------|-----------|--------------|
| `extension/editText` | `filePath, edits: Array<{type, line, column, endLine?, endColumn?, text?}>` (max 1000), `save?` | `{success, editCount, saved}` |
| `extension/replaceBlock` | `filePath, oldContent, newContent, save?` | `{success, saved, source}` |

### Code Actions (3 methods)

| Method | Parameters | Return Shape |
|--------|-----------|--------------|
| `extension/formatDocument` | `file` | `{success, editsApplied}` |
| `extension/fixAllLintErrors` | `file` | `{success, actionsApplied}` |
| `extension/organizeImports` | `file` | `{success, actionsApplied}` |

### Other Handlers (19 methods)

| Method | Parameters | Return Shape |
|--------|-----------|--------------|
| `extension/getDiagnostics` | `file?` | `Array<{message, severity, line, ...}>` or `{diagnostics, truncated}` |
| `extension/getSelection` | _(none)_ | `{file, startLine, startColumn, endLine, endColumn, selectedText}` |
| `extension/getAIComments` | _(none)_ | `Array<{file, line, comment, severity}>` |
| `extension/watchFiles` | `id, pattern` | `{watching, id?, pattern?}` |
| `extension/unwatchFiles` | `id` | `{unwatched, id?}` |
| `extension/setDecorations` | `id, file, decorations: Array<{startLine, style?, hoverMessage?, message?}>` | `{applied, editorsUpdated}` |
| `extension/clearDecorations` | `id?` | `{cleared}` |
| `extension/getNotebookCells` | `file` | `{file, cellCount, cells}` |
| `extension/runNotebookCell` | `file, cellIndex, timeoutMs?` | `{cellIndex, durationMs, output}` |
| `extension/getNotebookOutput` | `file, cellIndex` | `{cellIndex, executionCount, output}` |
| `extension/listTasks` | _(none)_ | `{tasks: Array<{name, type, source, group, detail}>, count}` |
| `extension/runTask` | `name, type?, timeoutMs?` | `{name, type, exitCode, durationMs, success}` |
| `extension/readClipboard` | _(none)_ | `{text, byteLength, truncated}` |
| `extension/writeClipboard` | `text` | `{written, byteLength}` |
| `extension/getInlayHints` | `file, startLine, endLine` | `{hints: Array<{position, label, kind, tooltip?}>, count}` |
| `extension/getTypeHierarchy` | `file, line, column, direction?, maxResults?` | `{found, root?, supertypes?, subtypes?}` |
| `extension/getWorkspaceSettings` | `section?` | `{section, settings: Record<string, {value, defaultValue, ...}>}` |
| `extension/setWorkspaceSetting` | `key, value, target?` | `{set, key, target}` |
| `extension/executeVSCodeCommand` | `command, args?` | `{result}` |

### Notifications (Extension → Bridge)

| Notification | Payload | Trigger |
|-------------|---------|---------|
| `extension/debugSessionChanged` | `{hasActiveSession, sessionId?, isPaused, breakpoints}` | Debug session start/stop/change |
| `extension/fileChanged` | `{id, type, file}` | File watcher event |
| `extension/diagnosticsChanged` | _(debounced)_ | Language server diagnostics update |
| `extension/aiCommentsChanged` | _(debounced)_ | Document content change |

---

## Error Codes Reference

### JSON-RPC Protocol Errors

Returned as `{ jsonrpc: "2.0", id, error: { code, message, data? } }`. Request was malformed or unroutable.

| Code | Name | When It Occurs | Recovery |
|------|------|----------------|----------|
| `-32700` | Parse Error | Message is not valid JSON | Fix JSON payload |
| `-32600` | Invalid Request | Batch request, not initialized, or duplicate request ID | Send individual requests; complete handshake; use unique IDs |
| `-32601` | Method Not Found | Unrecognized JSON-RPC method | Use `initialize`, `tools/list`, `tools/call`, `ping`, or notifications |
| `-32602` | Invalid Params | Args not object, exceed 1 MB, or fail AJV schema validation | Fix arguments to match tool's `inputSchema` |
| `-32003` | Tool Not Found | Tool not registered or hidden (extensionRequired + disconnected) | Call `tools/list`; reconnect extension |
| `-32004` | Rate Limit | >200 requests in 60s sliding window | Back off; limit is 200 req/min per connection |

### HTTP/WebSocket Rejections

| HTTP Code | When | Recovery |
|-----------|------|----------|
| `401` | Missing/invalid Bearer token | Read token from `~/.claude/ide/<port>.lock` |
| `403` | Invalid Host header (DNS rebinding) or unexpected Origin (CSRF) | Connect from localhost |
| `429` | Connection rate limit (<50ms between connections) | Wait and retry |

### Tool Errors (`isError: true`)

Tool execution errors return successful JSON-RPC responses with `result.isError: true`. Error text in `result.content[0].text`.

| Category | Common Patterns | Recovery |
|----------|----------------|----------|
| **Concurrency** | `Too many concurrent tool calls (max 10)` | Wait for in-flight calls to finish |
| **Timeout** | `Tool "<name>" timed out after <N>ms` | Retry; check extension connectivity |
| **Extension** | `VS Code extension not connected`, `Extension request timed out` | Reconnect IDE; call `getBridgeStatus` |
| **File path** | `Path escapes workspace`, `File not found`, `hardlink write denied` | Use workspace-relative paths; verify file exists |
| **Concurrency edit** | `File was modified concurrently` | Re-read file and retry |
| **Validation** | `<key> must be a string/integer/boolean/array` | Fix argument types |
| **Commands** | `Command not in allowlist`, `Flag blocked` | Use `--allow-command` or remove blocked flags |
| **GitHub** | `gh not found`, `Not authenticated`, `PR #N not found` | Install `gh`; run `gh auth login` |
| **Linters** | `biome/eslint/pyright/ruff: failed to parse output` | Check linter installation; errors tracked in `linterErrors` map |
| **Notifications** | Silently dropped if >500/min | Reduce frequency; no error response (logged server-side) |

### Error Flow

```
Request → [JSON parse] → [rate limit] → [method dispatch]
  ├── Protocol error → JSON-RPC error response (negative code)
  └── Tool error → JSON-RPC success with isError: true (LLM-readable message)
```

Key distinction: **JSON-RPC errors** = request structurally invalid. **Tool errors** = request valid but operation failed — LLM can read and adapt.

---

## Key Data Type Interfaces

### Diagnostic
```typescript
{ file: string, line: number, column: number,
  severity: "error" | "warning" | "information" | "hint",
  message: string, source?: string, code?: string | number }
```

### SelectionState
```typescript
{ file: string, startLine: number, startColumn: number,
  endLine: number, endColumn: number, selectedText: string }
```

### AIComment
```typescript
{ file: string, line: number, comment: string, syntax: string,
  fullLine: string, severity?: "fix" | "todo" | "question" | "warn" | "task" }
```

### DecorationSpec
```typescript
{ startLine: number, endLine?: number, message?: string,
  hoverMessage?: string, style: "info" | "warning" | "error" | "focus" | "strikethrough" | "dim" }
```

### DebugState
```typescript
{ hasActiveSession: boolean, sessionId?: string, sessionName?: string,
  sessionType?: string, isPaused: boolean,
  pausedAt?: { file, line, column },
  callStack?: Array<{ id, name, file, line, column }>,
  scopes?: Array<{ name, variables: Array<{ name, value, type }> }>,
  breakpoints: Array<{ file, line, condition?, enabled }> }
```
