# Claude IDE Bridge — Project Instructions

## Documentation

Read and comply with all documents in `/documents/`. Consult the relevant doc before making changes:

- **[documents/platform-docs.md](documents/platform-docs.md)** — Complete feature reference (124+ tools). Consult before adding or modifying features.
- **[documents/ICPs.md](documents/ICPs.md)** — Developer personas. Consider impact on all personas when making changes.
- **[documents/styleguide.md](documents/styleguide.md)** — Code conventions, UI patterns, output formats. Follow all patterns for new tools, handlers, and responses.
- **[documents/roadmap.md](documents/roadmap.md)** — Development direction. Check before starting exploratory work.
- **[documents/data-reference.md](documents/data-reference.md)** — Data flows, state management, protocol details. Consult before modifying connection, auth, or state logic.
- **[documents/plugin-authoring.md](documents/plugin-authoring.md)** — Plugin manifest schema, entrypoint API, and distribution.
- **[docs/adr/](docs/adr/)** — Architecture Decision Records. Read before touching version numbers, lock files, error codes, session management, or reconnect logic.

### CLI Subcommands

`claude-ide-bridge` has several subcommands beyond the default server mode:

- `start-all` — Launch tmux session with bridge + extension watcher panes
- `install-extension` — Install the companion VS Code extension
- `gen-claude-md` — Generate a starter CLAUDE.md for the current workspace
- `print-token [--port N]` — Print the auth token from the active lock file
- `gen-plugin-stub <dir> --name <org/name> --prefix <prefix>` — Scaffold a new plugin

## Bug Fix Protocol

When a bug is reported, do NOT start by trying to fix it. Instead:
1. Write a test that reproduces the bug (the test should fail)
2. Have subagents try to fix the bug and prove it with a passing test
3. Only then consider the bug fixed

## Build & Test

```bash
# Bridge
npm run build          # TypeScript compilation (wipes dist/ first)
npm test               # vitest

# Extension
cd vscode-extension
npm run build          # esbuild bundle
npm run package        # create .vsix

# Always rebuild bridge + extension + VSIX before testing changes
```

Run `npx biome check .` before committing.

## Architecture Rules

- **Tools**: factory pattern `createXxxTool(deps)` returning `{ schema, handler }`. Register in `src/tools/index.ts`.
- **Extension handlers**: standalone async functions in the `handlers` map. Register in `vscode-extension/src/handlers/index.ts`.
- **WebSocket safety**: all `ws.send()` calls must use `safeSend()` or readyState check + try-catch.
- **Extension dependency**: tools requiring the extension must set `extensionRequired: true` in their schema.
- **Tool names**: must match `/^[a-zA-Z0-9_]+$/`.
- **Error handling**: tool execution errors return `isError: true` in content (NOT JSON-RPC errors). JSON-RPC errors (`ErrorCodes`, -32xxx) are for protocol issues only. See [ADR-0004](docs/adr/0004-tool-errors-as-content.md).

## Testing Requirements

- New tools need unit tests in `src/tools/__tests__/`
- New extension handlers need tests in `vscode-extension/src/__tests__/handlers/`
- Use vitest for both bridge and extension tests
- Coverage gates: 70% lines, 65% branches, 70% functions
- Test circuit breaker and reconnect behavior for connection-related changes

## Plugin System

Plugins register additional MCP tools without forking the bridge. They run in-process alongside built-in tools.

- **Scaffold**: `claude-ide-bridge gen-plugin-stub <dir> --name "org/name" --prefix "myPrefix"`
- **Load**: `--plugin <path-or-npm-package>` (repeatable). `--plugin-watch` enables hot reload.
- **Manifest**: `claude-ide-bridge-plugin.json` with `schemaVersion: 1`. All tool names must start with the `toolNamePrefix` (2-20 chars, `/^[a-zA-Z][a-zA-Z0-9_]{1,19}$/`).
- **Entrypoint**: exports `register(ctx)` where `ctx` provides `workspace`, `workspaceFolders`, `config`, `logger`.
- **Distribution**: publish to npm with keyword `claude-ide-bridge-plugin`; install via package name.
- **Lifecycle**: plugins are loaded after CLI probes, before sessions are accepted. On hot-reload, tools are re-registered atomically.

Full reference: [documents/plugin-authoring.md](documents/plugin-authoring.md)

## OAuth 2.0 Mode

For remote deployments where claude.ai custom connectors need authenticated access.

- **Activation**: `--issuer-url <public-https-url>` activates OAuth 2.0. `--cors-origin <origin>` (repeatable) sets `Access-Control-Allow-Origin` on all responses.
- **Endpoints**: `/.well-known/oauth-authorization-server` (RFC 8414), `/.well-known/oauth-protected-resource` (RFC 9396), `/oauth/register` (RFC 7591 dynamic client registration), `/oauth/authorize` (approval page), `/oauth/token`, `/oauth/revoke` (RFC 7009).
- **Design**: PKCE S256 mandatory. Auth codes are single-use with 5-min TTL. Access tokens are opaque base64url strings with 1-hour TTL. No refresh tokens — clients re-authorize.
- **Bridge token**: the resource owner credential. Entered in the `/oauth/authorize` approval page. All string comparisons are timing-safe.
- **CORS env var**: `CLAUDE_IDE_BRIDGE_CORS_ORIGINS=https://claude.ai,https://other.example.com` (comma-separated alternative to `--cors-origin`).
- **Never** include the bridge token, `--fixed-token` values, or real domain names in documentation or config checked into version control.

## Remote Deployment

- **VPS flags**: `--bind 0.0.0.0` exposes to all interfaces. `--vps` expands command allowlist (adds curl, systemctl, docker, etc.). `--fixed-token <uuid>` prevents token rotation on restart.
- **Headless (no IDE)**: `print-token [--port N]` retrieves auth token from lock file. CLI tools work; LSP/debugger tools require the VS Code extension.
- **VS Code Remote-SSH / Cursor SSH**: extension has `extensionKind: ["workspace"]` — loads on the VPS side automatically. Full tool support.
- **Reverse proxy**: required for remote access (nginx or Caddy with TLS). See [docs/remote-access.md](docs/remote-access.md).
- **Systemd + deploy scripts**: `deploy/bootstrap-new-vps.sh` (full provisioning), `deploy/install-vps-service.sh` (idempotent service install). See [deploy/README.md](deploy/README.md).

## Claude Orchestration

The bridge can spawn Claude Code subprocesses as background tasks.

- **Activation**: `--claude-driver subprocess` (or `api`). Default is `none` (disabled).
- **Tools**: `runClaudeTask` (enqueue prompt), `getClaudeTaskStatus`, `cancelClaudeTask`, `listClaudeTasks`, `resumeClaudeTask`.
- **Task lifecycle**: `pending` → `running` → `done | error | cancelled | interrupted`. Output streams to VS Code output channel, capped at 50KB.
- **Binary**: `--claude-binary <path>` overrides the Claude CLI path (default: `claude` on PATH).

Full reference: [documents/platform-docs.md](documents/platform-docs.md) (Claude orchestration section).

## Automation Policy

Event-driven hooks that trigger Claude tasks automatically.

- **Activation**: `--automation --automation-policy <path.json> --claude-driver subprocess`
- **Hooks**:
  - `onDiagnosticsError` — fires on new error/warning diagnostics. Placeholders: `{{file}}`, `{{diagnostics}}`. Severity filter + cooldown.
  - `onFileSave` — fires when matching files are saved. Minimatch glob patterns. Placeholder: `{{file}}`.
  - `onPostCompact` — fires after Claude Code compacts context. Re-injects IDE state.
  - `onInstructionsLoaded` — fires at session start. Injects bridge status summary.
- **Cooldown**: minimum 5 seconds between triggers for the same file/event. Max prompt size: 32KB.

## Transport & Session Model

Three transports serve different clients:

| Transport | Client | Protocol |
|-----------|--------|----------|
| WebSocket | Claude Code CLI | `ws://127.0.0.1:<port>` with `x-claude-code-ide-authorization` header |
| stdio shim | Claude Desktop | stdin/stdout JSON-RPC, bridges to WebSocket internally |
| Streamable HTTP | Remote MCP clients (claude.ai, Codex CLI) | `POST/GET/DELETE /mcp` with Bearer token |

- **Lock file**: `~/.claude/ide/<port>.lock` — `{pid, workspace, authToken, isBridge: true, ...}`. Created with `O_EXCL` (prevents symlink attacks), permissions `0o600`. The `isBridge: true` flag distinguishes bridge locks from IDE-owned locks. See [ADR-0003](docs/adr/0003-isbridge-lock-file-flag.md).
- **Auth**: token from lock file, validated with `crypto.timingSafeEqual`. Host header DNS rebinding defense rejects non-loopback hosts.
- **HTTP sessions**: max 5 concurrent, 10-min idle TTL, oldest idle (>60s) evicted on capacity. See [ADR-0005](docs/adr/0005-http-session-eviction.md).
- **Grace period**: `--grace-period <ms>` (default 30s) preserves session state across brief disconnects.
- **Version numbers**: `BRIDGE_PROTOCOL_VERSION` (wire format, bump rarely) vs `PACKAGE_VERSION` (npm, every release). See [ADR-0001](docs/adr/0001-dual-version-numbers.md).
- **Generation guards**: every WebSocket callback checks `gen !== this.generation` to prevent stale callbacks from corrupting new connection state. See [ADR-0002](docs/adr/0002-generation-guards-on-reconnect.md).

## Security Model

- **Command allowlist**: `runCommand` only executes allowlisted commands. Interpreter commands (node, python, bash, etc.) are permanently blocked from `--allow-command`. Argument splitting prevents `--flag=value` injection.
- **SSRF defense** (`sendHttpRequest`): hostname blocklist for private/loopback ranges, DNS pre-resolution re-check, Host header override after user headers.
- **Path traversal** (`resolveFilePath` in `src/tools/utils.ts`): rejects null bytes, symlink escapes (ancestor chain walk), and paths outside workspace.
- **Input validation**: AJV validates all tool arguments at the transport layer before execution. `isValidRef` rejects leading-dash git refs. `searchAndReplace` rejects null bytes and `-`-prefixed globs. Clipboard enforces 1MB cap via `Buffer.byteLength`.
- **Rate limiting**: 200 requests/min (ring buffer), 500 notifications/min, per-session tool token bucket (default 60/min, configurable via `--tool-rate-limit`). Failed AJV validation does not consume rate limit tokens.
- **Error codes**: `ToolErrorCodes` (string codes in `isError: true` content blocks) for tool failures; `ErrorCodes` (JSON-RPC -32xxx) for protocol issues. Never mix them. See [ADR-0004](docs/adr/0004-tool-errors-as-content.md).
