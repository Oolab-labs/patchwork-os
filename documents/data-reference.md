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
| `pendingListChanged` | `boolean` | Set when `sendListChanged` fires but no session has an open WS; cleared when the next session completes the MCP handshake and receives the notification |
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
| `persistPath` | `string \| null` | Set via `setPersistPath()`; enables JSONL append to `~/.claude/ide/activity-<port>.jsonl` (respects `CLAUDE_CONFIG_DIR`) |

Entries loaded from disk are type-validated on read: `status` must be a string, `timestamp` a number, and `durationMs` a number or undefined. Entries failing validation are silently skipped — this prevents corrupted or truncated JSONL lines from poisoning in-memory state.

### SessionCheckpoint (`sessionCheckpoint.ts`)
| State | Type | Lifecycle |
|-------|------|-----------|
| `checkpointPath` | `string` | `~/.claude/ide/checkpoint-<port>.json` (respects `CLAUDE_CONFIG_DIR`) |
| `workspace` | `string \| undefined` | Passed at construction; written to each `CheckpointData.workspace` field; used by `loadLatest()` to filter out checkpoints from other instances |
| `intervalHandle` | `ReturnType<setInterval> \| null` | Writes every 30s (unref'd — doesn't block process exit) |

**`CheckpointData` schema** (stored in checkpoint JSON):
```typescript
{
  savedAt: number;           // Unix ms timestamp
  workspace?: string;        // Bridge workspace path — used to filter cross-instance checkpoints
  sessions: Array<{
    sessionId: string;
    openedFiles: string[];
  }>;
}
```
`loadLatest()` accepts an optional `workspace` param. When provided, it skips checkpoints whose `workspace` field is set but does not match — this prevents cross-instance contamination when multiple bridges share the same `~/.claude/ide/` directory. Legacy checkpoints without the `workspace` field are still loaded (upgrade compat). Stale checkpoints (future `savedAt` > `Date.now() + 5s`) are rejected and emit `console.warn`.

---

## Auth Flow

```
1. Bridge starts → generates random UUID → writes to ~/.claude/ide/<port>.lock
   Lock file: { authToken, pid, workspace, ideName, isBridge: true }

2. Claude Code CLI → scans ~/.claude/ide/*.lock → finds matching workspace
   → connects WebSocket with auth token in upgrade headers

3. VS Code Extension → scans same lock files → connects with x-claude-ide-extension header
   → sends extension/hello notification with version

4. Claude Desktop shim → scans ~/.claude/ide/*.lock → prefers files with isBridge: true
   → connects via stdio relay (mcp-stdio-shim.cjs)
   → if no lock found at startup: polls every 3 s until one appears (no exit)
   → watches ~/.claude/ide/ via fs.watch (500 ms debounce) — reconnects on bridge restart
   → polling fallback (3 s interval) runs after any disconnect as guard against missed FSEvents

5. Bridge validates token → accepts or rejects upgrade
```

**Key constraints:**
- One bridge per workspace (start with `--workspace`)
- Lock files cleaned on startup (`cleanStale()` removes dead PIDs)
- Lock file deleted on graceful shutdown
- `isBridge: true` in the lock file distinguishes the bridge from IDE-owned lock files (e.g. Windsurf writes its own lock in `~/.claude/ide/`); the stdio shim filters on this field to avoid connecting to the wrong process
- `CLAUDE_CONFIG_DIR` overrides `~/.claude` for **all** persistence paths: lock file, checkpoint, activity log, and task queue. Set this env var to isolate multiple bridge instances (e.g. in CI) or to use a non-home-directory config location.

---

## Prompts Protocol (MCP)

The bridge implements the MCP `prompts` capability alongside `tools`. Prompt registration happens at startup via `registerPrompts()` in `src/prompts.ts`.

```
Discovery:
  Claude sends prompts/list → transport returns all registered prompts
  └─ Response: { prompts: Array<{ name, description, arguments? }>, nextCursor? }
  └─ Cursor-paginated (same page-size-50 mechanism as tools/list)

Resolution:
  Claude sends prompts/get { name, arguments } → transport looks up prompt
  └─ Handler receives validated args → returns { description?, messages: Array<PromptMessage> }
  └─ PromptMessage: { role: "user" | "assistant", content: { type: "text", text } }
  └─ Returns JSON-RPC error -32602 if required argument missing
  └─ Returns JSON-RPC error -32601 if prompt name not found
```

**Registered prompts:**

| Name | Required Args | Optional Args |
|------|--------------|---------------|
| `review-file` | `file` | — |
| `explain-diagnostics` | `file` | — |
| `generate-tests` | `file` | — |
| `debug-context` | — | — |
| `git-review` | — | `base` (default: `main`) |

**Transport state additions:**
- `prompts` registry (`Map<string, RegisteredPrompt>`) stored on the transport alongside `tools`
- `prompts/list_changed` notification fired when prompts registry changes (currently static — fires once on init)

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
  → message text sanitized: control chars stripped, capped at 500 chars

WITHOUT extension (fallback):
  getDiagnostics tool → runs CLI linters directly:
  → tsc --noEmit (TypeScript)
  → eslint (JavaScript/TypeScript)
  → pyright / ruff (Python)
  → cargo check (Rust)
  → go vet (Go)
  → biome check (JS/TS)
  Auto-detected via probeAll() at startup
  → message text sanitized: control chars stripped, capped at 500 chars (same path)

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
  Pending flag: if no session WS is open when the notification fires, bridge sets
    pendingListChanged=true; the next session to receive notifications/initialized
    gets the notification immediately (onInitialized hook on McpTransport)

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

All handler methods use the `extension/` prefix and communicate via JSON-RPC 2.0 over WebSocket. Positions use **1-based** line and column numbers in the protocol (converted to 0-based internally). **52 handler methods** total across 7 registration groups.

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

### Other Handlers (16 methods)

| Method | Parameters | Return Shape |
|--------|-----------|--------------|
| `extension/getDiagnostics` | `file?` | `Array<{message, severity, line, ...}>` or `{diagnostics, truncated}` |
| `extension/getSelection` | _(none)_ | `{file, startLine, startColumn, endLine, endColumn, selectedText}` |
| `extension/getAIComments` | _(none)_ | `Array<{file, line, comment, severity}>` |
| `extension/watchFiles` | `id, pattern` | `{watching, id?, pattern?}` |
| `extension/unwatchFiles` | `id` | `{unwatched, id?}` |
| `extension/setDecorations` | `id, file, decorations: Array<{startLine, style?, hoverMessage?, message?}>` | `{applied, editorsUpdated}` |
| `extension/clearDecorations` | `id?` | `{cleared}` |
| `extension/readClipboard` | _(none)_ | `{text, byteLength, truncated}` |
| `extension/writeClipboard` | `text` | `{written, byteLength}` |
| `extension/getInlayHints` | `file, startLine, endLine` | `{hints: Array<{position, label, kind, tooltip?}>, count}` |
| `extension/getTypeHierarchy` | `file, line, column, direction?, maxResults?` | `{found, root?, supertypes?, subtypes?}` |
| `extension/getWorkspaceSettings` | `section?` | `{section, settings: Record<string, {value, defaultValue, ...}>}` |
| `extension/setWorkspaceSetting` | `key, value, target?` | `{set, key, target}` |
| `extension/executeVSCodeCommand` | `command, args?` | `{result}` |
| `extension/listVSCodeCommands` | `filter?` | `{commands: string[], count, truncated}` |
| `extension/captureScreenshot` | _(none)_ | `{base64, mimeType: "image/png"}` |

### Notifications (Extension → Bridge)

| Notification | Payload | Trigger |
|-------------|---------|---------|
| `extension/debugSessionChanged` | `{hasActiveSession, sessionId?, isPaused, breakpoints}` | Debug session start/stop/change |
| `extension/fileChanged` | `{id, type, file}` | File watcher event |
| `extension/diagnosticsChanged` | _(debounced)_ | Language server diagnostics update |
| `extension/aiCommentsChanged` | _(debounced)_ | Document content change |

---

## ClaudeOrchestrator Data Flow

### Overview

```
VS Code event / MCP tool call
        │
        ▼
AutomationHooks (src/automation.ts)        runClaudeTask MCP tool
   onDiagnosticsError / onFileSave  ──────►  ClaudeOrchestrator.enqueue()
                                                    │
                                              Task queued (pending)
                                                    │
                                     MAX_CONCURRENT=10 slots available?
                                            ├─ yes → run immediately
                                            └─ no  → wait in queue (MAX_QUEUE=20)
                                                    │
                                              SubprocessDriver
                                              spawns: claude -p <prompt>
                                              (CLAUDECODE stripped from env)
                                                    │
                                          ┌─────────┴──────────┐
                                     Track 1                Track 2
                               MCP progress              bridge/claudeTaskOutput
                               notifications             WS push notification
                               (Claude Code)             (VS Code extension output
                                                          channel: "Claude IDE Bridge")
                                                    │
                                              Task complete → status: done | error | cancelled
```

### ClaudeTask State Machine

```
pending ──► running ──► done
                   └──► error
                   └──► cancelled  (via cancelClaudeTask or AbortController)
```

| State | Description |
|-------|-------------|
| `pending` | Enqueued, waiting for a concurrency slot |
| `running` | Subprocess spawned; output streaming via both tracks |
| `done` | Subprocess exited with code 0; `output` contains full stdout |
| `error` | Subprocess exited non-zero, timed out, or threw; `error` field contains message |
| `cancelled` | Cancelled before or during execution |

### Orchestrator Limits

| Setting | Value |
|---------|-------|
| Max concurrent tasks | 10 (`MAX_CONCURRENT`) |
| Max queue depth | 20 (`MAX_QUEUE`) — enqueue() rejects beyond this |
| Max task history | 100 (`MAX_HISTORY`) — oldest completed tasks evicted |
| Default task timeout | 60 000 ms |
| Min task timeout | 5 000 ms |
| Max task timeout | 600 000 ms |
| Max prompt size | 32 KB |
| Max context files | 20 (workspace-confined) |

### Session Scoping

Each MCP session gets isolated task visibility. `getClaudeTaskStatus`, `cancelClaudeTask`, and `listClaudeTasks` only surface tasks belonging to the calling session. Cross-session task access is rejected with a tool error.

### AutomationHooks Policy

Loaded from `--automation-policy <path>` at startup. Two hook types:

| Hook | Trigger | Template placeholders |
|------|---------|----------------------|
| `onDiagnosticsError` | Extension `diagnosticsChanged` notification with severity ≥ `minSeverity` | `{{file}}`, `{{diagnostics}}` |
| `onFileSave` | Extension `fileSaved` notification matching `patterns` glob list | `{{file}}` |

Cooldown enforcement: each hook tracks `lastFiredAt` per file. A cooldown of at minimum 5 000 ms must elapse before the same file re-triggers. `{{diagnostics}}` is rendered as a severity-filtered list with each message capped at 500 chars and delimited by `--- BEGIN/END DIAGNOSTIC DATA ---` to prevent prompt injection.

### Output Delivery (Two Tracks)

**Track 1 — MCP progress notifications** (Claude Code terminal)
- Sent via `transport.sendProgress()` while task is `running`
- Best-effort; skipped if bufferedAmount exceeds backpressure threshold

**Track 2 — `bridge/claudeTaskOutput` push notification** (VS Code)
- Sent via `extensionClient.notify()` on each stdout chunk
- Extension appends to the "Claude IDE Bridge" output channel in real time
- Delivered regardless of whether Claude Code is connected

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
