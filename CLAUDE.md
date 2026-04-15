# Claude IDE Bridge — Project Instructions

## Documentation

Comply with all docs in `/documents/`. Consult before changes:

- **[documents/platform-docs.md](documents/platform-docs.md)** — Full feature reference (137 tools). Consult before adding/modifying features.
- **[documents/prompts-reference.md](documents/prompts-reference.md)** — All 72 MCP prompts reference.
- **[documents/styleguide.md](documents/styleguide.md)** — Code conventions, UI patterns, output formats. Follow for all new tools, handlers, responses.
- **[documents/roadmap.md](documents/roadmap.md)** — Development direction. Check before exploratory work.
- **[documents/data-reference.md](documents/data-reference.md)** — Data flows, state mgmt, protocol details. Consult before modifying connection/auth/state logic.
- **[documents/plugin-authoring.md](documents/plugin-authoring.md)** — Plugin manifest schema, entrypoint API, distribution.
- **[docs/adr/](docs/adr/)** — Architecture Decision Records. Read before touching version numbers, lock files, error codes, session mgmt, or reconnect logic.

> **Cowork (computer-use) sessions:** MCP bridge tools NOT available inside Cowork. Run `/mcp__bridge__cowork` in regular Desktop chat first to capture IDE context, then switch to Cowork. Cowork runs in isolated git worktree — output won't appear in `git status` on main until merged. (see [docs/cowork.md](docs/cowork.md))

### CLI Subcommands

- `init [--workspace <path>]` — One-command setup: install extension + write CLAUDE.md + print next steps
- `start-all` — Launch tmux session with bridge + extension watcher panes
- `install-extension` — Install companion VS Code extension
- `gen-claude-md` — Generate starter CLAUDE.md for current workspace
- `print-token [--port N]` — Print auth token from active lock file
- `gen-plugin-stub <dir> --name <org/name> --prefix <prefix>` — Scaffold new plugin
- `--watch` — Auto-restart supervisor with exponential backoff (2s → 30s). Safe for production.

## Bug Fix Protocol

When bug reported, do NOT fix first. Instead:
1. Write test that reproduces bug (test must fail)
2. Have subagents fix bug and prove it with passing test
3. Only then consider bug fixed

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

**Extension versioning rule:** Windsurf caches `.vsix` files by version number and will silently reuse the old bundle if the version hasn't changed. **Always bump `vscode-extension/package.json` version before packaging** when the user will install the `.vsix` in Windsurf (or any VS Code fork). Patch bump (`1.4.2` → `1.4.3`) is sufficient. Never repackage without bumping — the user will install it and see no change.

Before staging, run `npx biome check --write <files>` on changed files. Fix before stage — don't wait for hook to fail.

## LSP Workflows

All LSP tools available in default slim mode.

**Adding a new tool**
1. `searchWorkspaceSymbols` — confirm similar tool doesn't exist
2. `getDocumentSymbols` on `src/extensionClient.ts` — see available methods
3. `getHover { filePath, line, column }` — verify method signature before writing
4. `getDiagnostics { uri: "src/tools/myTool.ts" }` — catch type errors before `npm run build`
5. `getDiagnostics { uri: "src/tools/index.ts" }` — confirm no import errors after registering

> `getDiagnostics` uses `uri`, not `filePath`. Wrong key silently returns all-workspace diagnostics.

**Code review**
1. `getCallHierarchy { direction: "incoming" }` on each changed symbol — blast radius
2. `findReferences` on changed interfaces/types — find all implementation sites including test mocks
3. `getCodeActions` on flagged ranges — surface language server suggestions
4. `setEditorDecorations { id: "code-review", style: "warning"|"error", hoverMessage, message }` — annotate inline
5. `clearEditorDecorations { id: "code-review" }` when done

**Refactoring**
1. `refactorAnalyze` — returns `risk` (low/medium/high), `referenceCount`, `callerCount`. High risk (>20 refs or >10 callers) → write tests first per Bug Fix Protocol.
2. `refactorPreview` — see exact edits before committing
3. `renameSymbol` — execute; or `refactorExtractFunction { file, ... }` (param is `file`, not `filePath`)
4. `getDiagnostics` with no `uri` — workspace-wide type check (uses CLI/tsc when extension not connected)

**Debugging**
1. `searchWorkspaceSymbols` — jump to symbol from stack trace
2. `getCallHierarchy { direction: "outgoing" }` on failing handler — trace data flow
3. `getDocumentSymbols` on `src/extensionClient.ts` vs test mock — catch interface drift
4. `setDebugBreakpoints` + `evaluateInDebugger` — inspect runtime state

**Onboarding to unfamiliar code**
1. `getDocumentSymbols` — instant file outline
2. `explainSymbol` on primary export — richer than hover alone
3. `getCallHierarchy { direction: "incoming" }` — what depends on this module
4. `getImportTree` — full downstream dependency chain

**Quick reference**

| Situation | Tool |
|---|---|
| Tool for X exist? | `searchWorkspaceSymbols` |
| Method accepts what? | `getHover` |
| Hover N symbols | `batchGetHover` |
| Definition N symbols | `batchGoToDefinition` |
| Implementations N symbols | `batchFindImplementations` |
| Change breaking? | `getChangeImpact` or `getDiagnostics` + `findReferences` |
| Caller count? | `getCallHierarchy { direction: "incoming" }` |
| Safe to rename? | `refactorAnalyze` → `refactorPreview` → `renameSymbol` |
| File exports? | `getDocumentSymbols` |
| File imports (signatures)? | `getImportedSignatures` |
| Links / file refs in doc? | `getDocumentLinks` |
| Code lens counts? | `getCodeLens` |

## Architecture Rules

- **Tools**: factory pattern `createXxxTool(deps)` returning `{ schema, handler }`. Register in `src/tools/index.ts`.
- **Extension handlers**: standalone async functions in `handlers` map. Register in `vscode-extension/src/handlers/index.ts`.
- **WebSocket safety**: all `ws.send()` calls must use `safeSend()` or readyState check + try-catch.
- **Extension dependency**: tools requiring extension must set `extensionRequired: true` in schema.
- **Tool names**: must match `/^[a-zA-Z0-9_]+$/`.
- **Error handling**: tool execution errors return `isError: true` in content (NOT JSON-RPC errors). JSON-RPC errors (`ErrorCodes`, -32xxx) for protocol issues only. See [ADR-0004](docs/adr/0004-tool-errors-as-content.md).
- **`extensionClient` shape validation**: `proxy<T>()` is blind TypeScript cast with no runtime validation — **do NOT use for new methods**. Eight latent shape-mismatch bugs (v2.25.18–v2.25.24) from this pattern. For new methods:
  - `tryRequest<T>(method, params, timeout, signal)` — auto-unwraps `{error}` / `{success: false, error}` to `null`. Use when success path is single T shape and caller doesn't need to distinguish error paths.
  - `validatedRequest<T>(method, params, validator)` — runtime shape predicate. Use when success path is object with specific required fields (e.g. `{items, count}` wrappers).
  - Direct `requestOrNull` + inline unwrap — when handler has rich contract (e.g. `{success: true/false, data, error}`) and caller needs structured error (see `closeTab`, `saveFile`). Do NOT use `tryRequest` — hides info caller needs.
  - When auditing: read handler in `vscode-extension/src/handlers/*.ts`, enumerate ALL return statements (success AND error paths) before choosing helper. Test mocks always lie — handler file is ground truth.

## Testing Requirements

- New tools: unit tests in `src/tools/__tests__/`
- New extension handlers: tests in `vscode-extension/src/__tests__/handlers/`
- Use vitest for both bridge and extension tests
- Coverage gates: 75% lines, 70% branches, 75% functions
- Test circuit breaker and reconnect behavior for connection-related changes

## Plugin System

Plugins register additional MCP tools without forking bridge. Run in-process alongside built-in tools.

- **Scaffold**: `claude-ide-bridge gen-plugin-stub <dir> --name "org/name" --prefix "myPrefix"`
- **Load**: `--plugin <path-or-npm-package>` (repeatable). `--plugin-watch` enables hot reload.
- **Manifest**: `claude-ide-bridge-plugin.json` with `schemaVersion: 1`. Tool names must start with `toolNamePrefix` (2-20 chars, `/^[a-zA-Z][a-zA-Z0-9_]{1,19}$/`).
- **Entrypoint**: exports `register(ctx)` where `ctx` provides `workspace`, `workspaceFolders`, `config`, `logger`.
- **Distribution**: publish to npm with keyword `claude-ide-bridge-plugin`; install via package name.
- **Lifecycle**: loaded after CLI probes, before sessions accepted. On hot-reload, tools re-registered atomically.
- **No symlinks**: Files in `claude-ide-bridge-plugin/` are standalone copies, not symlinks. After modifying plugin source, manually sync copies — they will NOT auto-update.

Full reference: [documents/plugin-authoring.md](documents/plugin-authoring.md)

## OAuth 2.0 Mode

For remote deployments where claude.ai custom connectors need authenticated access.

- **Activation**: `--issuer-url <public-https-url>` activates OAuth 2.0. `--cors-origin <origin>` (repeatable) sets `Access-Control-Allow-Origin` on all responses.
- **Endpoints**: `/.well-known/oauth-authorization-server` (RFC 8414), `/.well-known/oauth-protected-resource` (RFC 9396), `/oauth/register` (RFC 7591 dynamic client registration), `/oauth/authorize` (approval page), `/oauth/token`, `/oauth/revoke` (RFC 7009).
- **Design**: PKCE S256 mandatory. Auth codes single-use, 5-min TTL. Access tokens opaque base64url, 24-hour TTL. No refresh tokens — clients re-authorize.
- **Bridge token**: resource owner credential. Entered in `/oauth/authorize` approval page. All string comparisons timing-safe.
- **CORS env var**: `CLAUDE_IDE_BRIDGE_CORS_ORIGINS=https://claude.ai,https://other.example.com` (comma-separated alternative to `--cors-origin`).
- **Never** commit bridge token, `--fixed-token` values, real domain names, `--issuer-url` values, or `--cors-origin` values to version control.

## Remote Deployment

- **VPS flags**: `--bind 0.0.0.0` exposes to all interfaces. `--vps` expands command allowlist (adds curl, systemctl, docker, etc.). `--fixed-token <uuid>` prevents token rotation on restart.
- **Headless (no IDE)**: `print-token [--port N]` retrieves auth token from lock file. CLI tools work; LSP/debugger tools require VS Code extension.
- **VS Code Remote-SSH / Cursor SSH**: extension has `extensionKind: ["workspace"]` — loads on VPS side automatically. Full tool support.
- **Reverse proxy**: required for remote access (nginx or Caddy with TLS). See [docs/remote-access.md](docs/remote-access.md).
- **Systemd + deploy scripts**: `deploy/bootstrap-new-vps.sh` (full provisioning), `deploy/install-vps-service.sh` (idempotent service install). See [deploy/README.md](deploy/README.md).
- **Scheduled task templates not auto-installed**: Copy from `templates/scheduled-tasks/` to `~/.claude/scheduled-tasks/` manually, then restart Claude Desktop.

## Claude Orchestration

Bridge spawns Claude Code subprocesses as background tasks.

- **Activation**: `--claude-driver subprocess` (or `api`). Default `none` (disabled).
- **Tools**: `runClaudeTask` (enqueue prompt), `getClaudeTaskStatus`, `cancelClaudeTask`, `listClaudeTasks`, `resumeClaudeTask`.
- **Task lifecycle**: `pending` → `running` → `done | error | cancelled | interrupted`. Output streams to VS Code output channel, capped at 50KB.
- **Binary**: `--claude-binary <path>` overrides Claude CLI path (default: `claude` on PATH).

Full reference: [documents/platform-docs.md](documents/platform-docs.md) (Claude orchestration section).

## Automation Policy

Event-driven hooks that trigger Claude tasks automatically.

- **Activation**: `--automation --automation-policy <path.json> --claude-driver subprocess`
- **Hooks**:
  - `onDiagnosticsError` — new error/warning diagnostics. Placeholders: `{{file}}`, `{{diagnostics}}`. Severity filter + cooldown.
  - `onDiagnosticsCleared` — errors/warnings drop to zero. Placeholder: `{{file}}`. Cooldown.
  - `onFileSave` — matching files saved. Minimatch glob patterns. Placeholder: `{{file}}`.
  - `onFileChanged` — matching files changed (buffer change, not save). Minimatch glob patterns. Placeholder: `{{file}}`.
  - `onPreCompact` — fires before Claude Code compacts context. Snapshot state before trimming.
  - `onPostCompact` — fires after Claude Code compacts context. Re-injects IDE state.
  - `onInstructionsLoaded` — fires at session start. Injects bridge status summary.
  - `onGitCommit` — fires after successful `gitCommit`. Placeholders: `{{hash}}`, `{{branch}}`, `{{message}}`, `{{count}}`, `{{files}}`.
  - `onGitPull` — fires after successful `gitPull`. Placeholders: `{{remote}}`, `{{branch}}`.
  - `onGitPush` — fires after successful `gitPush`. Placeholders: `{{remote}}`, `{{branch}}`, `{{hash}}`.
  - `onBranchCheckout` — fires after successful `gitCheckout`. Placeholders: `{{branch}}`, `{{previousBranch}}`, `{{created}}`.
  - `onPullRequest` — fires after successful `githubCreatePR`. Placeholders: `{{url}}`, `{{number}}`, `{{title}}`, `{{branch}}`.
  - `onTestRun` — fires after `runTests` completes. Placeholders: `{{runner}}`, `{{failed}}`, `{{passed}}`, `{{total}}`, `{{failures}}` (JSON array). Supports `onFailureOnly` flag.
  - `onTaskCreated` — fires on Claude Code TaskCreated hook (CC 2.1.84+). Placeholders: `{{taskId}}`, `{{prompt}}`.
  - `onTaskSuccess` — fires when orchestrator task completes successfully. Placeholders: `{{taskId}}`, `{{output}}`.
  - `onPermissionDenied` — fires on Claude Code PermissionDenied hook (CC 2.1.89+). Placeholders: `{{tool}}`, `{{reason}}`.
  - `onCwdChanged` — fires when Claude Code CWD changes (CC 2.1.83+). Placeholder: `{{cwd}}`.
  - `onDebugSessionStart` — fires when a VS Code debug session starts. Placeholders: `{{sessionName}}`, `{{sessionType}}`, `{{breakpointCount}}`, `{{activeFile}}`.
  - `onDebugSessionEnd` — fires when a VS Code debug session terminates. Placeholders: `{{sessionName}}`, `{{sessionType}}`.
- **Shared options**: all hooks support inline `prompt` string or `promptName`/`promptArgs` named prompt references. All support `cooldownMs` (min 5000).
- **Cooldown**: min 5s between triggers for same file/event. Max prompt size: 32KB.
- **CC hook wiring** — hooks relying on Claude Code's hook system need MCP notify tools called from `settings.json`. Bridge registers these automatically when `--automation` active:

  | CC hook event | Shell command (settings.json) |
  |---|---|
  | `PreCompact` | `claude-ide-bridge notify PreCompact` |
  | `PostCompact` | `claude-ide-bridge notify PostCompact` |
  | `InstructionsLoaded` | `claude-ide-bridge notify InstructionsLoaded` |
  | `TaskCreated` | `claude-ide-bridge notify TaskCreated --taskId $TASK_ID --prompt $PROMPT` |
  | `PermissionDenied` | `claude-ide-bridge notify PermissionDenied --tool $TOOL --reason $REASON` |
  | `CwdChanged` | `claude-ide-bridge notify CwdChanged --cwd $CWD` |

  `notify` subcommand reads bridge lock file, looks up running port and auth token, POSTs to `/notify` HTTP endpoint. Bridge must be running.

  Example `~/.claude/settings.json` block (Claude Code requires `matcher` + `hooks` arrays):
  ```json
  "hooks": {
    "PreCompact": [
      { "matcher": "", "hooks": [{ "type": "command", "command": "claude-ide-bridge notify PreCompact" }] }
    ],
    "PostCompact": [
      { "matcher": "", "hooks": [{ "type": "command", "command": "claude-ide-bridge notify PostCompact" }] }
    ],
    "InstructionsLoaded": [
      { "matcher": "", "hooks": [{ "type": "command", "command": "claude-ide-bridge notify InstructionsLoaded" }] }
    ],
    "TaskCreated": [
      { "matcher": "", "hooks": [{ "type": "command", "command": "claude-ide-bridge notify TaskCreated --taskId $TASK_ID --prompt $PROMPT" }] }
    ],
    "PermissionDenied": [
      { "matcher": "", "hooks": [{ "type": "command", "command": "claude-ide-bridge notify PermissionDenied --tool $TOOL --reason $REASON" }] }
    ],
    "CwdChanged": [
      { "matcher": "", "hooks": [{ "type": "command", "command": "claude-ide-bridge notify CwdChanged --cwd $CWD" }] }
    ]
  }
  ```

## Transport & Session Model

| Transport | Client | Protocol |
|-----------|--------|----------|
| WebSocket | Claude Code CLI | `ws://127.0.0.1:<port>` with `x-claude-code-ide-authorization` header |
| stdio shim | Claude Desktop | stdin/stdout JSON-RPC, bridges to WebSocket internally |
| Streamable HTTP | Remote MCP clients (claude.ai, Codex CLI) | `POST/GET/DELETE /mcp` with Bearer token |

- **Lock file**: `~/.claude/ide/<port>.lock` — `{pid, workspace, authToken, isBridge: true, ...}`. Created with `O_EXCL` (prevents symlink attacks), permissions `0o600`. `isBridge: true` distinguishes bridge locks from IDE-owned locks. See [ADR-0003](docs/adr/0003-isbridge-lock-file-flag.md).
- **Auth**: token from lock file, validated with `crypto.timingSafeEqual`. Host header DNS rebinding defense rejects non-loopback hosts.
- **HTTP sessions**: max 5 concurrent, 10-min idle TTL, oldest idle (>60s) evicted on capacity. See [ADR-0005](docs/adr/0005-http-session-eviction.md).
- **Grace period**: `--grace-period <ms>` (default 120s) preserves session state across brief disconnects. Reconnecting client sending `X-Claude-Code-Session-Id` matching in-grace session is reattached (no new session, no re-initialization). stdio shim sends stable per-process UUID automatically.
- **Version numbers**: `BRIDGE_PROTOCOL_VERSION` (wire format, bump rarely) vs `PACKAGE_VERSION` (npm, every release). See [ADR-0001](docs/adr/0001-dual-version-numbers.md). Same dual-version applies to extension: `EXTENSION_PROTOCOL_VERSION` (wire compat, `"1.1.0"`) vs npm package version (`1.3.x`). `extension/hello` reports both — `protocolVersion` and `packageVersion`. Check both in bridge logs; `version=1.1.0` in logs is the wire version, not stale extension.
- **Generation guards**: every WebSocket callback checks `gen !== this.generation` to prevent stale callbacks corrupting new connection state. See [ADR-0002](docs/adr/0002-generation-guards-on-reconnect.md).

## Security Model

- **Command allowlist**: `runCommand` only executes allowlisted commands. Interpreter commands (node, python, bash, etc.) permanently blocked from `--allow-command`. Argument splitting prevents `--flag=value` injection.
- **SSRF defense** (`sendHttpRequest`): hostname blocklist for private/loopback ranges, DNS pre-resolution re-check, Host header override after user headers.
- **Path traversal** (`resolveFilePath` in `src/tools/utils.ts`): rejects null bytes, symlink escapes (ancestor chain walk), paths outside workspace.
- **Input validation**: AJV validates all tool arguments at transport layer before execution. `isValidRef` rejects leading-dash git refs. `searchAndReplace` rejects null bytes and `-`-prefixed globs. Clipboard enforces 1MB cap via `Buffer.byteLength`.
- **Rate limiting**: 200 requests/min (ring buffer), 500 notifications/min, per-session tool token bucket (default 60/min, configurable via `--tool-rate-limit`). Failed AJV validation does not consume rate limit tokens.
- **Error codes**: `ToolErrorCodes` (string codes in `isError: true` content blocks) for tool failures; `ErrorCodes` (JSON-RPC -32xxx) for protocol issues. Never mix. See [ADR-0004](docs/adr/0004-tool-errors-as-content.md).

## Claude IDE Bridge

@import .claude/rules/bridge-tools.md

Bridge connected via MCP. Session-start hook reports connection status, tool count, and extension state automatically — check that summary before proceeding. If tools appear missing, call `getBridgeStatus` to diagnose.

### Bug fix methodology

When bug reported, do NOT fix first. Instead:
1. Write test that reproduces bug (must fail)
2. Fix bug, confirm test passes
3. Only then consider bug fixed

### Documentation & memory

- **After architectural changes** — update `CLAUDE.md` so future sessions have accurate context.
- **At end of work session** — save meaningful decisions to memory: *"Remember that we chose X approach because Y."*
- **Prune stale instructions** — remove/correct outdated guidance. Stale instructions cause confident mistakes.

### Modular rules (optional)

Move rules out of CLAUDE.md into scoped files under `.claude/rules/`:

```
.claude/rules/testing.md     — applies when working with test files
.claude/rules/security.md    — applies to auth, payments, sensitive modules
.claude/rules/typescript.md  — TypeScript-specific conventions
```

Reference from CLAUDE.md with:
```
@import .claude/rules/testing.md
```

Path globs on rule files mean Claude only loads them when working on matching files.

### Workflow rules

Bridge tool substitution rules in `.claude/rules/bridge-tools.md` (loaded above). Quick reference table below is summary.

### Quick reference

> Tools marked **[full]** require `--full` mode (not available in default slim mode). Slim mode exposes only IDE-exclusive tools (LSP, debugger, editor state). Call `getToolCapabilities` to confirm available tools.

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
| Explain symbol (composite) | `explainSymbol` | slim |
| Inline type hints | `getInlayHints` | slim |
| Refactor safely | `refactorAnalyze` → `refactorPreview` → `renameSymbol` | slim |
| Extract function | `refactorExtractFunction` | slim |
| Bridge/extension health | `getBridgeStatus` | slim |
| Available tools? | `getToolCapabilities` | slim |
| Watch live diagnostics (long-poll) | `watchDiagnostics` | slim |
| Bundle editor context | `contextBundle` | slim |
| Stream recent activity events | `watchActivityLog` | slim |
| Screenshot | `captureScreenshot` | slim |
| List open editors | `getOpenEditors` | slim |
| Hover at cursor | `getHoverAtCursor` | slim |
| Go to declaration | `goToDeclaration` | slim |
| Go to type definition | `goToTypeDefinition` | slim |
| Find all implementations | `findImplementations` | slim |
| Batch find implementations | `batchFindImplementations` | slim |
| Selection range expand/shrink | `selectionRanges` | slim |
| Folding ranges | `foldingRanges` | slim |
| Preview code action | `previewCodeAction` | slim |
| Git status / diff | `getGitStatus`, `getGitDiff` | **[full]** |
| Stage, commit, push | `gitAdd`, `gitCommit`, `gitPush` | **[full]** |
| Open pull request | `githubCreatePR` | **[full]** |
| File tree | `getFileTree` | **[full]** |
| Run shell command | `runInTerminal`, `getTerminalOutput` | **[full]** |
| Edit file by line range | `editText` | **[full]** |
| Open file in editor | `openFile` | **[full]** |
| Find + replace across workspace | `searchAndReplace` | **[full]** |
| List VS Code tasks | `listVSCodeTasks` | **[full]** |
| Run VS Code task | `runVSCodeTask` | **[full]** |
| Project info (name, version, deps) | `getProjectInfo` | **[full]** |
| Enqueue Claude subprocess task | `runClaudeTask` | **[full]** |
| List Claude subprocess tasks | `listClaudeTasks` | **[full]** |
| Checkout branch | `gitCheckout` | **[full]** |
| Pull from remote | `gitPull` | **[full]** |
| List branches | `gitListBranches` | **[full]** |
| Blame file | `gitBlame` | **[full]** |
| Run VS Code command by ID | `executeVSCodeCommand` | **[full]** |
| Cross-session context | `setHandoffNote` / `getHandoffNote` | **[full]** |
| Lint / format | `fixAllLintErrors`, `formatDocument` | **[full]** |
| Security audit | `getSecurityAdvisories`, `auditDependencies` | **[full]** |
| Unused code | `detectUnusedCode` | **[full]** |
| Coverage report | `getCodeCoverage` | **[full]** |
| Change-heavy files | `getGitHotspots` | **[full]** |
| Scaffold tests | `generateTests` | **[full]** |
| PR description | `getPRTemplate` | **[full]** |

### Dispatch prompts (mobile)

Terse messages via Claude Desktop Dispatch (phone/Siri) are auto-routed to bridge prompts. Invoke directly by name in any chat. Keep responses under 20 lines for Dispatch.

> Require `--full` mode. Won't work in slim mode.

| Phone message | Prompt | Tools called |
|---|---|---|
| "How's the build?" | `project-status` | `getGitStatus`, `getDiagnostics` |
| "Review my changes" | `quick-review` | `getGitStatus`, `getGitDiff`, `getDiagnostics` |
| "Does it build?" | `build-check` | `getProjectInfo`, `getDiagnostics`, `runCommand` |
| "What changed?" | `recent-activity` | `getGitLog`, `getGitStatus` |

### Agent Teams & Scheduled Tasks

| Context | Prompt | What it does |
|---|---|---|
| Team lead checking parallel agents | `team-status` | Workspace state, active tasks, recent activity across sessions |
| Scheduled nightly/hourly health check | `health-check` | Tests + diagnostics + security advisories + git status |

> `team-status` requires multiple Claude Code sessions connected simultaneously.

> **Claude Code ≥ v2.1.77**: `SendMessage` auto-resumes stopped agents.

Scheduled task templates (nightly-review, health-check, dependency-audit) included with bridge package. Copy to `~/.claude/scheduled-tasks/` and restart Claude Desktop. Find in `$(npm root -g)/claude-ide-bridge/templates/scheduled-tasks/`.

### Cowork (computer-use)

**MCP bridge tools NOT available inside Cowork.** Run `/mcp__bridge__cowork` in regular Claude Code or Desktop chat first to gather context and write handoff note, then open Cowork.

Workflow:
1. Regular chat: run `/mcp__bridge__cowork` → Claude collects IDE state → calls `setHandoffNote`
2. Open Cowork (Cmd+2 on Mac) → Cowork reads handoff note for context

**If bridge tools missing inside Cowork:** wrong context. Exit, run prompt in regular chat, return.

Full details: [docs/cowork.md](docs/cowork.md)

**Cowork uses git worktrees:** Cowork operates in isolated git worktree, not main workspace root. Files land in worktree. Always add "write all files to workspace root, not subdirectory" as first instruction in CLAUDE.md when using Cowork with synced workspace. After Cowork finishes, review and merge worktree branch back to main.

### Session continuity

| Scenario | Action |
|---|---|
| Switching CLI → Desktop | Call `setHandoffNote` before switching; bridge auto-snapshots if note >5 min stale |
| Session just started | Call `getHandoffNote` to pick up prior context (workspace-scoped). **Caution:** `onInstructionsLoaded` hook may have auto-overwritten note at session start — if content looks generic/templated, treat as stale and consult persistent session log (e.g. `docs/session-log.md`). |
| Bridge restarted | First connected client receives "restored from checkpoint" notification |
| Preparing for Cowork | Run `/mcp__bridge__cowork` in regular chat first — Cowork has no MCP access |
| Multi-workspace | Notes are workspace-scoped; switching workspaces won't overwrite each other's notes |
