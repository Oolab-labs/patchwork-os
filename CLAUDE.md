# Claude IDE Bridge — Project Instructions

## Documentation

Read and comply with all documents in `/documents/`. Consult the relevant doc before making changes:

- **[documents/platform-docs.md](documents/platform-docs.md)** — Complete feature reference (130+ tools). Consult before adding or modifying features.
- **[documents/ICPs.md](documents/ICPs.md)** — Developer personas. Consider impact on all personas when making changes.
- **[documents/styleguide.md](documents/styleguide.md)** — Code conventions, UI patterns, output formats. Follow all patterns for new tools, handlers, and responses.
- **[documents/roadmap.md](documents/roadmap.md)** — Development direction. Check before starting exploratory work.
- **[documents/data-reference.md](documents/data-reference.md)** — Data flows, state management, protocol details. Consult before modifying connection, auth, or state logic.
- **[documents/plugin-authoring.md](documents/plugin-authoring.md)** — Plugin manifest schema, entrypoint API, and distribution.
- **[docs/adr/](docs/adr/)** — Architecture Decision Records. Read before touching version numbers, lock files, error codes, session management, or reconnect logic.

> **Cowork (computer-use) sessions:** MCP bridge tools are NOT available inside Cowork. Always run `/mcp__bridge__cowork` in regular Desktop chat first to capture IDE context, then switch to Cowork. Cowork runs in an isolated git worktree — output won't appear in `git status` on main until merged. (see [docs/cowork-workflow.md](docs/cowork-workflow.md))

### CLI Subcommands

`claude-ide-bridge` has several subcommands beyond the default server mode:

- `init [--workspace <path>]` — One-command setup: install extension + write CLAUDE.md + print next steps
- `start-all` — Launch tmux session with bridge + extension watcher panes
- `install-extension` — Install the companion VS Code extension
- `gen-claude-md` — Generate a starter CLAUDE.md for the current workspace
- `print-token [--port N]` — Print the auth token from the active lock file
- `gen-plugin-stub <dir> --name <org/name> --prefix <prefix>` — Scaffold a new plugin
- `--watch` — Auto-restart supervisor with exponential backoff (2s → 30s). Safe for production use.

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

Before staging files for commit, run `npx biome check --write <files>` on the files you changed. This auto-fixes formatting and safe lint issues before the pre-commit hook rejects the commit. Do not wait for the hook to fail — fix first, then stage.

## LSP Workflows

All LSP tools are available in default slim mode. Use these sequences for the most common tasks.

**Adding a new tool**
1. `searchWorkspaceSymbols` — confirm similar tool doesn't exist
2. `getDocumentSymbols` on `src/extensionClient.ts` — see available methods
3. `getHover { filePath, line, column }` — verify method signature before writing
4. `getDiagnostics { uri: "src/tools/myTool.ts" }` — catch type errors before `npm run build`
5. `getDiagnostics { uri: "src/tools/index.ts" }` — confirm no import errors after registering

> Note: `getDiagnostics` uses `uri`, not `filePath`. Passing the wrong key silently returns all-workspace diagnostics.

**Code review**
1. `getCallHierarchy { direction: "incoming" }` on each changed symbol — blast radius
2. `findReferences` on changed interfaces/types — find all implementation sites including test mocks
3. `getCodeActions` on flagged ranges — surface language server suggestions
4. `setEditorDecorations { id: "code-review", style: "warning"|"error", hoverMessage, message }` — annotate inline
5. `clearEditorDecorations { id: "code-review" }` when done

**Refactoring**
1. `refactorAnalyze` — returns `risk` (low/medium/high), `referenceCount`, `callerCount`. High risk (>20 refs or >10 callers) → write tests first per Bug Fix Protocol.
2. `refactorPreview` — see exact edits before committing
3. `renameSymbol` — execute; or `refactorExtractFunction { file, ... }` (note: param is `file`, not `filePath`)
4. `getDiagnostics` with no `uri` — workspace-wide type check (uses CLI/tsc path when extension not connected, more complete)

**Debugging**
1. `searchWorkspaceSymbols` — jump to a symbol from a stack trace
2. `getCallHierarchy { direction: "outgoing" }` on the failing handler — trace data flow
3. `getDocumentSymbols` on `src/extensionClient.ts` vs test mock — catch interface drift
4. `setDebugBreakpoints` + `evaluateInDebugger` — inspect runtime state

**Onboarding to unfamiliar code**
1. `getDocumentSymbols` — instant file outline
2. `explainSymbol` on the primary export — richer than hover alone
3. `getCallHierarchy { direction: "incoming" }` — what depends on this module
4. `getImportTree` — full downstream dependency chain

**Quick reference**

| Situation | Tool |
|---|---|
| Does a tool for X exist? | `searchWorkspaceSymbols` |
| What does this method accept? | `getHover` |
| Hover for N symbols at once | `batchGetHover` |
| Jump to definition for N symbols at once | `batchGoToDefinition` |
| Find implementations for N symbols at once | `batchFindImplementations` |
| Is this change breaking? | `getChangeImpact` (blast radius) or `getDiagnostics` + `findReferences` |
| How many callers does this have? | `getCallHierarchy { direction: "incoming" }` |
| Safe to rename? | `refactorAnalyze` → `refactorPreview` → `renameSymbol` |
| What does this file export? | `getDocumentSymbols` |
| What does this file import (with signatures)? | `getImportedSignatures` |
| Links / file references in a document? | `getDocumentLinks` |
| Code lens counts (tests, refs)? | `getCodeLens` |

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
- Coverage gates: 75% lines, 70% branches, 75% functions
- Test circuit breaker and reconnect behavior for connection-related changes

## Plugin System

Plugins register additional MCP tools without forking the bridge. They run in-process alongside built-in tools.

- **Scaffold**: `claude-ide-bridge gen-plugin-stub <dir> --name "org/name" --prefix "myPrefix"`
- **Load**: `--plugin <path-or-npm-package>` (repeatable). `--plugin-watch` enables hot reload.
- **Manifest**: `claude-ide-bridge-plugin.json` with `schemaVersion: 1`. All tool names must start with the `toolNamePrefix` (2-20 chars, `/^[a-zA-Z][a-zA-Z0-9_]{1,19}$/`).
- **Entrypoint**: exports `register(ctx)` where `ctx` provides `workspace`, `workspaceFolders`, `config`, `logger`.
- **Distribution**: publish to npm with keyword `claude-ide-bridge-plugin`; install via package name.
- **Lifecycle**: plugins are loaded after CLI probes, before sessions are accepted. On hot-reload, tools are re-registered atomically.
- **No symlinks for plugin copies**: Files in `claude-ide-bridge-plugin/` are standalone copies, not symlinks. After modifying plugin source, manually sync the copies — they will NOT auto-update.

Full reference: [documents/plugin-authoring.md](documents/plugin-authoring.md)

## OAuth 2.0 Mode

For remote deployments where claude.ai custom connectors need authenticated access.

- **Activation**: `--issuer-url <public-https-url>` activates OAuth 2.0. `--cors-origin <origin>` (repeatable) sets `Access-Control-Allow-Origin` on all responses.
- **Endpoints**: `/.well-known/oauth-authorization-server` (RFC 8414), `/.well-known/oauth-protected-resource` (RFC 9396), `/oauth/register` (RFC 7591 dynamic client registration), `/oauth/authorize` (approval page), `/oauth/token`, `/oauth/revoke` (RFC 7009).
- **Design**: PKCE S256 mandatory. Auth codes are single-use with 5-min TTL. Access tokens are opaque base64url strings with 24-hour TTL. No refresh tokens — clients re-authorize.
- **Bridge token**: the resource owner credential. Entered in the `/oauth/authorize` approval page. All string comparisons are timing-safe.
- **CORS env var**: `CLAUDE_IDE_BRIDGE_CORS_ORIGINS=https://claude.ai,https://other.example.com` (comma-separated alternative to `--cors-origin`).
- **Never** include the bridge token, `--fixed-token` values, or real domain names in documentation or config checked into version control. Also never commit real domain names, `--issuer-url` values, or `--cors-origin` values to version control.

## Remote Deployment

- **VPS flags**: `--bind 0.0.0.0` exposes to all interfaces. `--vps` expands command allowlist (adds curl, systemctl, docker, etc.). `--fixed-token <uuid>` prevents token rotation on restart.
- **Headless (no IDE)**: `print-token [--port N]` retrieves auth token from lock file. CLI tools work; LSP/debugger tools require the VS Code extension.
- **VS Code Remote-SSH / Cursor SSH**: extension has `extensionKind: ["workspace"]` — loads on the VPS side automatically. Full tool support.
- **Reverse proxy**: required for remote access (nginx or Caddy with TLS). See [docs/remote-access.md](docs/remote-access.md).
- **Systemd + deploy scripts**: `deploy/bootstrap-new-vps.sh` (full provisioning), `deploy/install-vps-service.sh` (idempotent service install). See [deploy/README.md](deploy/README.md).

- **Scheduled task templates not auto-installed**: Copy templates from `templates/scheduled-tasks/` to `~/.claude/scheduled-tasks/` manually, then restart Claude Desktop for the task to be detected.

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

## Claude IDE Bridge

@import .claude/rules/bridge-tools.md

The bridge is connected via MCP. The session-start hook reports connection status, tool count, and extension state automatically — check that summary before proceeding. If tools appear missing, call `getBridgeStatus` to diagnose.

### Bug fix methodology

When a bug is reported, do NOT start by trying to fix it. Instead:
1. Write a test that reproduces the bug (the test should fail)
2. Fix the bug and confirm the test now passes
3. Only then consider the bug fixed

### Documentation & memory

Keep project documentation and Claude's memory in sync with the code:

- **After architectural changes** — update `CLAUDE.md` so future sessions have accurate context. If a pattern, rule, or constraint changes, the file should reflect it.
- **At the end of a work session** — if meaningful decisions were made (why a pattern was chosen, what was tried and rejected, what the next steps are), save a summary to memory: *"Remember that we chose X approach because Y."*
- **Prune stale instructions** — if `CLAUDE.md` contains outdated guidance, remove or correct it. Stale instructions cause confident mistakes in future sessions.

### Modular rules (optional)

For large projects, move individual rules out of CLAUDE.md into scoped files under `.claude/rules/`:

```
.claude/rules/testing.md     — applies when working with test files
.claude/rules/security.md    — applies to auth, payments, sensitive modules
.claude/rules/typescript.md  — TypeScript-specific conventions
```

Reference them from CLAUDE.md with:
```
@import .claude/rules/testing.md
```

Path globs on rule files mean Claude only loads them when working on matching files — keeps context focused and token-efficient.

### Workflow rules

Bridge tool substitution rules are in `.claude/rules/bridge-tools.md` (loaded above). The Quick reference table below is a summary.

### Quick reference

> Tools marked **[full]** require `--full` mode (not available in default slim mode). Slim mode exposes only IDE-exclusive tools (LSP, debugger, editor state). Call `getToolCapabilities` to confirm what is available in the current session.

| Task | Tool | Mode |
|---|---|---|
| Check errors / warnings | `getDiagnostics` | slim |
| Navigate to definition | `goToDefinition` | slim |
| Find all references | `findReferences` | slim |
| Call hierarchy | `getCallHierarchy` | slim |
| File symbols | `getDocumentSymbols` | slim |
| Interactive debug | `setDebugBreakpoints`, `startDebugging`, `evaluateInDebugger` | slim |
| Function signature at call site | `signatureHelp` | slim |
| Type hierarchy (supertypes/subtypes) | `getTypeHierarchy` | slim |
| Explain a symbol (composite) | `explainSymbol` | slim |
| Inline type hints | `getInlayHints` | slim |
| Refactor safely | `refactorAnalyze` → `refactorPreview` → `renameSymbol` | slim |
| Extract function | `refactorExtractFunction` | slim |
| Git status / diff | `getGitStatus`, `getGitDiff` | **[full]** |
| Stage, commit, push | `gitAdd`, `gitCommit`, `gitPush` | **[full]** |
| Open a pull request | `githubCreatePR` | **[full]** |
| File tree | `getFileTree` | **[full]** |
| Run a shell command | `runInTerminal`, `getTerminalOutput` | **[full]** |
| Lint / format | `fixAllLintErrors`, `formatDocument` | **[full]** |
| Security audit | `getSecurityAdvisories`, `auditDependencies` | **[full]** |
| Unused code | `detectUnusedCode` | **[full]** |
| Coverage report | `getCodeCoverage` | **[full]** |
| Change-heavy files | `getGitHotspots` | **[full]** |
| Scaffold tests | `generateTests` | **[full]** |
| PR description | `getPRTemplate` | **[full]** |

### Dispatch prompts (mobile)

When a terse message arrives via Claude Desktop Dispatch (phone/Siri), Claude automatically routes it to the appropriate bridge prompt. You can also invoke these prompts directly by name in any chat.

When responding to terse Dispatch messages from a phone, use these prompts for consistent, concise output.

> These prompts use git, test, and project tools that require `--full` mode. They will not work in default slim mode.

| Phone message | Prompt | Tools called |
|---|---|---|
| "How's the build?" | `project-status` | `getGitStatus`, `getDiagnostics` |
| "Review my changes" | `quick-review` | `getGitStatus`, `getGitDiff`, `getDiagnostics` |
| "Does it build?" | `build-check` | `getProjectInfo`, `getDiagnostics`, `runCommand` |
| "What changed?" | `recent-activity` | `getGitLog`, `getGitStatus` |

Keep responses concise (under 20 lines) when the conversation arrives via Dispatch.

### Agent Teams & Scheduled Tasks

| Context | Prompt | What it does |
|---|---|---|
| Team lead checking on parallel agents | `team-status` | Workspace state, active tasks, recent activity across sessions |
| Scheduled nightly/hourly health check | `health-check` | Tests + diagnostics + security advisories + git status |

> Prerequisite for `team-status`: multiple Claude Code sessions must be connected simultaneously. Solo sessions will show empty team activity.

> **Claude Code ≥ v2.1.77**: `SendMessage` auto-resumes stopped agents — no need to check whether a teammate is running before sending to it.

Ready-made scheduled task templates (nightly-review, health-check, dependency-audit) are included with the bridge package. Copy the ones you want to `~/.claude/scheduled-tasks/` and restart Claude Desktop to activate them. Find them in the `templates/scheduled-tasks/` directory of the `claude-ide-bridge` npm package (typically `$(npm root -g)/claude-ide-bridge/templates/scheduled-tasks/`).

### Cowork (computer-use)

**MCP bridge tools are NOT available inside Cowork sessions.** Always run `/mcp__bridge__cowork` in a regular Claude Code or Claude Desktop chat first to gather context and write a handoff note, then open Cowork.

Workflow:
1. Regular chat: run `/mcp__bridge__cowork` → Claude collects IDE state → calls `setHandoffNote`
2. Open Cowork (Cmd+2 on Mac) → Cowork reads the handoff note for context

**If bridge tools are missing from your tool list inside Cowork:** you're in the wrong context. Exit, run the prompt in regular chat, then return.

Full details: [docs/cowork-workflow.md](docs/cowork-workflow.md)

**Cowork uses git worktrees:** Cowork sessions operate in an isolated git worktree (separate branch/working copy), not the main workspace root. Files written by Cowork land in the worktree. Always add "write all files to the workspace root, not a subdirectory" as the first instruction in your CLAUDE.md when using Cowork with a synced workspace. After Cowork finishes, review and merge the worktree branch back to main.

### Session continuity

| Scenario | Action |
|---|---|
| Switching CLI → Desktop | Call `setHandoffNote` before switching; bridge auto-snapshots if note is >5 min stale |
| Session just started | Call `getHandoffNote` to pick up prior context (workspace-scoped). **Caution:** the `onInstructionsLoaded` automation hook may have auto-overwritten the note at session start — if the content looks generic or templated, treat it as stale and consult any persistent session log your project maintains (e.g. `docs/session-log.md`) for authoritative history. |
| Bridge restarted | First connected client receives a "restored from checkpoint" notification |
| Preparing for Cowork | Run `/mcp__bridge__cowork` in regular chat first — Cowork has no MCP access |
| Multi-workspace | Notes are workspace-scoped; switching workspaces won't overwrite each other's notes |
