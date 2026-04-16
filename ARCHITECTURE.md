# Claude IDE Bridge — Architecture

Version 2.30.1 · Node.js ≥ 20 · TypeScript

---

## System Overview

```
┌─────────────────┐        ┌──────────────────────────────┐        ┌──────────────────┐
│  Claude Code    │        │       Bridge (Node.js)        │        │  VS Code         │
│  CLI / Desktop  │        │                               │        │  Extension       │
│                 │◄──WS──►│  McpTransport  ExtensionClient│◄──WS──►│                  │
│  (MCP client)   │  HTTP  │  (JSON-RPC 2.0)  (custom RPC) │        │  (LSP, editor,   │
│                 │  stdio │                               │        │   debug APIs)    │
└─────────────────┘        └──────────────────────────────┘        └──────────────────┘
                                        │
                            ┌───────────┴───────────┐
                            │   HTTP endpoints       │
                            │  /health /dashboard    │
                            │  /mcp (Streamable HTTP)│
                            │  /oauth/*              │
                            └───────────────────────┘
```

Two independent WebSocket connections run simultaneously. The **Claude Code ↔ Bridge** link carries MCP JSON-RPC 2.0: tool calls, resource reads, prompt invocations. The **Extension ↔ Bridge** link carries a separate custom request/response protocol (`extension/<method>`) over which the extension pushes live IDE state (diagnostics, selections, debug state) and responds to tool requests that need VS Code APIs. When the extension is disconnected, tools with `extensionRequired: true` return `isError: true` immediately rather than blocking.

---

## Component Map

### Server Core

| File | Purpose |
|---|---|
| `src/bridge.ts` | Top-level orchestrator: spawns server, extension client, automation hooks, orchestrator, plugins; manages `AgentSession` lifecycle and grace-period reconnection |
| `src/server.ts` | HTTP server; routes `/health`, `/dashboard`, `/dashboard/data`, `/mcp`, `/oauth/*`, `/notify`; WebSocket upgrade for Claude Code clients and extension |
| `src/config.ts` | CLI flag parsing, defaults, validation; produces `Config` object consumed by every subsystem |
| `src/version.ts` | `BRIDGE_PROTOCOL_VERSION` (wire compat) and `PACKAGE_VERSION` (npm) as separate constants |

### Transport & Sessions

| File | Purpose |
|---|---|
| `src/transport.ts` | `McpTransport`: per-session JSON-RPC 2.0 handler; AJV arg validation; rate limiting (200 req/min ring buffer); tool dispatch; cursor-paginated `tools/list` |
| `src/extensionClient.ts` | `ExtensionClient`: bridge↔extension WebSocket RPC; circuit breaker (3 timeouts/30s → open); `tryRequest`, `validatedRequest` helpers; pushes cached state (diagnostics, selection, active file) |
| `src/streamableHttp.ts` | `StreamableHttpHandler`: MCP over HTTP POST/GET/DELETE `/mcp`; session pool (max 5, oldest-idle eviction) |
| `src/sessionCheckpoint.ts` | Periodic session snapshots to `~/.claude/ide/checkpoint-<port>.json`; restored on restart |
| `src/lockfile.ts` | `LockFileManager`: writes `~/.claude/ide/<port>.lock` with `O_EXCL` (0o600); `isBridge: true` flag; PID reuse guard |
| `src/wsUtils.ts` | `safeSend()`, backpressure handling (1 MB threshold, 5s drain timeout); best-effort notification delivery |

### Tool Registry

| File/Directory | Purpose |
|---|---|
| `src/tools/index.ts` | `registerAllTools()`: builds all tool factories, applies `SLIM_TOOL_NAMES` filter in non-full mode, merges plugin tools |
| `src/tools/*.ts` | Individual tool factories; each exports `createXxxTool(deps)` returning `{ schema, handler }` |
| `src/tools/lsp.ts` | 14 LSP tools (goToDefinition, findReferences, getHover, getCallHierarchy, renameSymbol, etc.) |
| `src/tools/utils.ts` | `resolveFilePath()`: path-traversal prevention; null-byte rejection; symlink ancestor walk; workspace containment |
| `src/tools/headless/` | `lspClient.ts` (Content-Length-framed JSON-RPC to `typescript-language-server`); `lspFallback.ts` (LSP fallback for goToDefinition, findReferences, getTypeSignature when extension absent) |

### Automation

| File | Purpose |
|---|---|
| `src/automation.ts` | `AutomationHooks`: all 18 hook handlers; cooldown enforcement; loop guards; `_enqueueAutomationTask()`; `AutomationPolicy` interface |
| `src/claudeDriver.ts` | `SubprocessDriver`: spawns `claude --verbose` subprocess; streams JSONL output; abort/timeout; `--effort`, `--model`, `--system-prompt` forwarding |
| `src/claudeOrchestrator.ts` | `ClaudeOrchestrator`: task queue, status lifecycle (`pending→running→done|error|cancelled|interrupted`), 50 KB output cap |

### Plugin System

| File | Purpose |
|---|---|
| `src/pluginLoader.ts` | Reads `claude-ide-bridge-plugin.json` manifest; imports `index.mjs` entrypoint; calls `register(ctx)`; validates `toolNamePrefix` |
| `src/pluginWatcher.ts` | `PluginWatcher`: fs.watch + 300ms debounce; ESM cache-busting (`?t=<timestamp>`); atomic re-registration |

### Utilities

| File | Purpose |
|---|---|
| `src/oauth.ts` | `OAuthServerImpl`: RFC 8414/7591/9396 endpoints; PKCE S256; 24h opaque access tokens; timing-safe comparisons |
| `src/probe.ts` | `probeAll()`: detects available CLI tools (ctags, typescript-language-server, rg, git, gh); results drive `getToolCapabilities` |
| `src/activityLog.ts` | Bounded ring buffer (500 entries); percentiles; co-occurrence; JSONL persistence |
| `src/errors.ts` | `ErrorCodes` (JSON-RPC -32xxx) and `ToolErrorCodes` (string codes for `isError: true` content) |
| `src/dashboard.ts` | Inline HTML/CSS/JS served at `/dashboard`; `/dashboard/data` JSON: version, uptimeMs, sessions, extensionConnected |

---

## Request Lifecycle

1. **Arrive**: JSON-RPC 2.0 message arrives over WebSocket (or HTTP POST `/mcp` for Streamable HTTP transport).
2. **Auth check** (`server.ts`): `x-claude-code-ide-authorization` header compared with `crypto.timingSafeEqual`; 401 on mismatch. Host header checked for DNS rebinding.
3. **Rate limit** (`transport.ts`): O(1) ring-buffer check (200 req/min). Exceeding returns `-32004 RATE_LIMIT_EXCEEDED`. Failed AJV validation does not consume tokens.
4. **Initialize guard**: `tools/call` and `tools/list` blocked until client has sent `initialize` + bridge sent `initialized` notification.
5. **AJV validation**: tool `inputSchema` validated at transport layer before handler is invoked. Invalid args return `-32602 INVALID_PARAMS`.
6. **Dispatch** (`transport.ts → tools/index.ts`): tool name looked up in registered map. Unknown tool → `isError: true` content.
7. **Extension gate**: if `schema.extensionRequired === true` and extension is disconnected, handler is skipped; response is `isError: true` with reconnect instructions.
8. **Handler execution**: factory-produced handler runs. Calls `extensionClient.tryRequest()` / `validatedRequest()` for VS Code operations, or native Node.js APIs directly.
9. **LSP fallback** (select tools only): if extension disconnected and tool has `extensionFallback: true`, handler retries via `typescript-language-server` stdio LSP.
10. **Serialize**: handler returns `{ content: [...] }`. Tools with `outputSchema` also populate `structuredContent`. Results exceeding 50 KB inject `_meta["anthropic/maxResultSizeChars"]` for Claude Code 2.1.91+ persistence hint.
11. **Return**: JSON-RPC response sent via `safeSend()` with backpressure check.

---

## Tool Registry

`registerAllTools()` in `src/tools/index.ts` constructs all tool factories with explicit dependency injection (workspace path, `extensionClient`, `config`, `probes`, `activityLog`, `orchestrator`, `automationHooks`, `fileLock`, `transport`). It returns a flat `ToolSchema[]` array.

**Full mode** (default since v2.43.0): the `SLIM_TOOL_NAMES` filter is bypassed; all ~140 tools are registered. Full-only tools include git write operations, terminal, file tree, GitHub, HTTP client, Claude orchestration, and code quality tools.

**Slim mode** (`--slim`): `SLIM_TOOL_NAMES` is a `Set<string>` of ~60 names. Only tools whose `schema.name` is in this set are registered. Slim mode exposes IDE-exclusive tools — LSP, debugger, editor state, decorations — that Claude Code cannot replicate natively.

**Plugin tools**: always bypass the slim filter regardless of mode. Registered after built-ins via `ctx.registerTool(schema, handler)` in the plugin's `register(ctx)` call.

**Runtime introspection**: `getToolCapabilities` reports which tools are available, which require the extension (`extensionRequired`), which have probe-based fallbacks (`probe:<name>`), and which have dual-path availability (`extensionFallback`).

---

## Extension Protocol

A dedicated WebSocket connection (separate from the Claude Code connection) runs between the VS Code extension and the bridge. The extension initiates the connection; the bridge accepts it on the same port via path `/extension`.

**Auth**: extension sends `x-claude-ide-extension: <bridgeToken>` on upgrade; bridge validates with `crypto.timingSafeEqual`.

**Method naming**: requests use `extension/<camelCase>` (e.g. `extension/getDiagnostics`, `extension/goToDefinition`). Notifications from extension to bridge use the same scheme (e.g. `extension/diagnosticsChanged`, `extension/selectionChanged`).

**Push state**: extension pushes diagnostics, selections, active file, AI comments, and debug state as notifications. `ExtensionClient` caches these locally (capped: 500 files for diagnostics, 200 for AI comments, 32 KB for active file content). Tool handlers read from cache without making a round-trip to the extension.

**Circuit breaker**: `ExtensionClient` opens after ≥ 3 timeouts within a 30-second window. While open, all extension requests fast-fail. Exponential backoff with full jitter governs the half-open probe interval. When breaker opens, `extensionRequired` tools return `isError: true`; tools with LSP fallback reroute to `typescript-language-server`.

---

## Automation Engine

`AutomationHooks` (`src/automation.ts`) implements 18 hooks defined in the `AutomationPolicy` interface:

| Hook | Trigger |
|---|---|
| `onDiagnosticsError` | New error/warning diagnostics appear for a file |
| `onDiagnosticsCleared` | Errors/warnings drop to zero for a file |
| `onFileSave` | Matching file saved (minimatch glob) |
| `onFileChanged` | Matching file buffer changed (CC 2.1.83+) |
| `onCwdChanged` | Claude Code working directory changes (CC 2.1.83+) |
| `onPostCompact` | Claude Code compacts context (CC 2.1.76+) |
| `onInstructionsLoaded` | Claude Code session starts (CC 2.1.76+) |
| `onTestRun` | `runTests` tool completes |
| `onTestPassAfterFailure` | Test runner transitions fail → pass |
| `onGitCommit` | `gitCommit` tool succeeds |
| `onGitPush` | `gitPush` tool succeeds |
| `onGitPull` | `gitPull` tool succeeds |
| `onBranchCheckout` | `gitCheckout` tool succeeds |
| `onPullRequest` | `githubCreatePR` tool succeeds |
| `onTaskCreated` | Claude Code TaskCreated hook (CC 2.1.84+) |
| `onTaskSuccess` | Orchestrator task completes with status `done` |
| `onPermissionDenied` | Claude Code PermissionDenied hook (CC 2.1.89+) |
| `onDebugSessionEnd` | VS Code debug session terminates |

**Event flow**: lifecycle event fires (tool call completes or `/notify` POST received) → `handle*()` method checks policy enabled + per-file/event cooldown (min 5s) + loop guard (prevents re-entrant triggers) → `_evaluateWhen()` checks `AutomationCondition` (minDiagnosticCount, diagnosticsMinSeverity, testRunnerLastStatus) → `_enqueueAutomationTask()` → `SubprocessDriver` spawns `claude --verbose` subprocess with the resolved prompt. Rolling 60-minute rate limit window caps tasks per hour (default 20). Requires `--claude-driver subprocess`.

---

## Plugin System

Load path at bridge startup:

1. `--plugin <path-or-npm-package>` CLI flag (repeatable) passed to `loadPlugins()` in `src/pluginLoader.ts`.
2. `pluginLoader` reads `claude-ide-bridge-plugin.json` manifest (`schemaVersion: 1`). Validates `toolNamePrefix` matches `/^[a-zA-Z][a-zA-Z0-9_]{1,19}$/`.
3. Imports `index.mjs` entrypoint via dynamic `import()`.
4. Calls `register(ctx)` where `ctx` exposes `workspace`, `workspaceFolders`, `config`, `logger`, and `ctx.registerTool(schema, handler)`.
5. Registered tools are merged into the registry after all built-ins; they always bypass the slim filter.

**Hot reload** (`--plugin-watch`): `PluginWatcher` (`src/pluginWatcher.ts`) watches the plugin directory. File changes trigger a 300ms debounced reload. ESM module cache is busted via `?t=<timestamp>` query param. Tools are re-registered atomically under a `reloadInFlight` guard. Tool names must start with the declared `toolNamePrefix`.

---

## Session Model

**WebSocket sessions** (Claude Code clients): `AgentSession` per connection tracked in `Bridge.sessions` map. On WebSocket close, a grace timer starts (default 120s). A reconnecting client that sends `X-Claude-Code-Session-Id` matching an in-grace session is reattached to it — no new initialization, `openedFiles` set preserved. The stdio shim generates a stable per-process UUID automatically.

**HTTP sessions** (Streamable HTTP `/mcp`): max 5 concurrent. When at capacity, the oldest idle session (idle > 60s) is evicted. Sessions with active tool calls are not evicted. 10-minute idle TTL.

**Lock file**: `~/.claude/ide/<port>.lock` created with `O_EXCL` (prevents symlink attacks), permissions `0o600`. Schema: `{ pid, workspace, authToken, isBridge: true, startedAt }`. `isBridge: true` distinguishes bridge-owned locks from IDE-owned locks. PID reuse guard: a lock whose PID resolves to a live process that started more than 24 hours ago is treated as stale and cleaned up.

**Per-session stats**: `callCount` and `errorCount` are not reset on `detach()`; they accumulate across reconnects and are read at final `cleanupSession()`.

---

## Auth & Security

- **Token validation**: bridge auth token compared with `crypto.timingSafeEqual` on every request; applies to WebSocket upgrade header, HTTP Bearer token, and extension handshake.
- **DNS rebinding defense**: Host header parsed; non-loopback hostnames rejected on WebSocket upgrade.
- **OAuth 2.0** (`--issuer-url`): PKCE S256 mandatory; auth codes single-use with 5-min TTL; access tokens opaque base64url with 24h TTL; timing-safe comparisons throughout.
- **SSRF** (`sendHttpRequest`): three-layer defense — lexical `isPrivateHost()` blocklist → DNS pre-resolution re-check → post-resolution IP pinning. `::ffff:` prefix recursively unwrapped. Host header override applied after user headers.
- **Command allowlist** (`runCommand`): only explicitly allowlisted commands execute. Interpreter commands (node, python, bash, etc.) permanently blocked from `--allow-command`. Argument splitting prevents `--flag=value` injection.
- **Path traversal** (`resolveFilePath` in `src/tools/utils.ts`): rejects null bytes; walks full symlink ancestor chain; rejects any path resolving outside workspace root.
- **Input validation**: AJV validates all tool arguments at transport layer before handler invocation. Failed validation does not consume rate-limit tokens.
- **Rate limiting**: 200 requests/min (ring buffer, O(1)); 500 notifications/min; per-session tool token bucket (default 60/min, configurable via `--tool-rate-limit`).

---

## Key Design Decisions

- **Dual version numbers** — `BRIDGE_PROTOCOL_VERSION` (wire format, bumped rarely) vs `PACKAGE_VERSION` (npm, every release). Same pattern applies to the VS Code extension: `EXTENSION_PROTOCOL_VERSION` ("1.1.0") vs npm package version. → [ADR-0001](docs/adr/0001-dual-version-numbers.md)
- **Generation guards on reconnect** — every WebSocket callback captures `gen` at attach time and checks `gen !== this.generation` before mutating state, preventing stale callbacks from corrupting a new connection. → [ADR-0002](docs/adr/0002-generation-guards-on-reconnect.md)
- **`isBridge` lock file flag** — bridge-created locks carry `isBridge: true` so tooling (VS Code extension lock scanner, `bridgeDoctor`) can distinguish them from IDE-owned locks on the same port range. → [ADR-0003](docs/adr/0003-isbridge-lock-file-flag.md)
- **Tool errors as content** — tool execution errors return `{ isError: true }` in the MCP content array, not JSON-RPC `-32xxx` error objects. JSON-RPC errors are reserved for protocol-level failures (auth, parse, rate limit). → [ADR-0004](docs/adr/0004-tool-errors-as-content.md)
- **HTTP session eviction** — oldest idle session (idle > 60s) evicted when the 5-session pool is full, rather than rejecting new connections. Active sessions are never evicted. → [ADR-0005](docs/adr/0005-http-session-eviction.md)
