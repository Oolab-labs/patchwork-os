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
