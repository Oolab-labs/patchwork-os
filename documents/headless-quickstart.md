# Headless Mode Quickstart

## What is Headless Mode?

The bridge runs without VS Code attached. No extension means no LSP, debugger, or editor state tools. BUT a subset of tools remain available via built-in fallbacks: filesystem, shell, git, and limited code navigation via `typescript-language-server` and `ctags`.

Use cases: CI pipelines, Docker containers, VPS deployments, GitHub Actions, server-side automation.

---

## Probe Table

At startup the bridge probes for available CLIs. Tool availability depends on what is found:

| Probe | CLI checked | Tools unlocked | Notes |
|-------|-------------|----------------|-------|
| `rg` | `rg` (ripgrep) | `searchWorkspace`, `findRelatedTests` (rg path) | Alpine: `apk add ripgrep` |
| `ctags` | `ctags --version \| grep "Universal Ctags"` | `searchWorkspaceSymbols` ctags fallback, `navigateToSymbolByName` | Alpine: `apk add ctags` |
| `typescript-language-server` | `typescript-language-server --version` | `goToDefinition`, `findReferences`, `getTypeSignature` LSP fallback | `npm i -g typescript-language-server typescript` |
| `gh` | `gh auth status` | `githubCreatePR`, `listPRs`, GitHub tools | Install GitHub CLI |
| `git` | `git --version` | All git tools | Usually pre-installed |

Call `getBridgeStatus` after connecting to see which probes passed and which tools are available.

---

## What Works Without the Extension

### Files

| Tool | Notes |
|------|-------|
| `getFileTree` | Directory listing, depth-limited |
| `findFiles` | Glob pattern search |
| `getBufferContent` | Reads from disk (no open editor buffer) |
| `createFile` | Write new file to workspace |
| `editText` | Line-range edit on disk |
| `deleteFile` | Remove file from workspace |

### Search

| Tool | Notes |
|------|-------|
| `searchWorkspace` | Requires `rg` probe |
| `findFiles` | Glob, always available |
| `findRelatedTests` | rg path; requires `rg` probe |

### Git

| Tool | Notes |
|------|-------|
| `getGitStatus` | Working tree status |
| `getGitDiff` | Staged and unstaged diffs |
| `getGitLog` | Commit history |
| `gitAdd` | Stage files |
| `gitCommit` | Create commit |
| `gitPush` | Push to remote |
| `gitBlame` | Line-level blame |
| `gitCheckout` | Switch or create branch |
| `gitPull` | Pull from remote |
| `gitListBranches` | List local and remote branches |

### GitHub (requires `gh`)

| Tool | Notes |
|------|-------|
| `githubCreatePR` | Open pull request |
| `listPRs` | List open PRs |
| `getIssues` | List issues |

### Shell

| Tool | Notes |
|------|-------|
| `runInTerminal` | Spawn shell command |
| `getTerminalOutput` | Read terminal output buffer |
| `runCommand` | Allowlisted command execution |

### Code Navigation (fallback paths)

| Tool | Fallback | Requires |
|------|----------|----------|
| `goToDefinition` | `typescript-language-server` LSP | TSServer probe |
| `findReferences` | `typescript-language-server` LSP | TSServer probe |
| `getTypeSignature` | `typescript-language-server` LSP | TSServer probe |
| `searchWorkspaceSymbols` | `ctags --output-format=json` | Universal Ctags probe |
| `navigateToSymbolByName` | `rg` declaration-pattern search | `rg` probe |

### Quality and Orchestration

| Tool | Notes |
|------|-------|
| `auditDependencies` | Checks for outdated packages |
| `getSecurityAdvisories` | CVE scan |
| `runTests` | vitest / jest / pytest / cargo / go test |
| `runClaudeTask` | Requires `--claude-driver subprocess` or `api` |
| `listClaudeTasks` | Requires `--claude-driver` |
| `getClaudeTaskStatus` | Requires `--claude-driver` |

### Task Launcher CLI (v2.42.0+)

Headless parity with the VS Code sidebar — launch context-aware Claude tasks from a terminal. Same prompt-building logic as the sidebar, same dispatch path. Requires a running bridge with `--claude-driver subprocess`.

```bash
# 7 presets: fixErrors · refactorFile · addTests · explainCode · optimizePerf · runTests · resumeLastCancelled
claude-ide-bridge quick-task fix-errors
claude-ide-bridge quick-task add-tests --json
claude-ide-bridge quick-task optimize-perf --port 55000

# free-form description (Claude gathers its own context via getProjectContext + getHandoffNote)
claude-ide-bridge start-task "Refactor the auth module for clarity, keep behaviour identical"

# resume prior session from handoff note (no-op if note is an auto-snapshot)
claude-ide-bridge continue-handoff
```

All three support:
- `--json` — structured output for scripting (`{ok, result: {taskId, status, ...}}`)
- `--port <n>` — target a specific bridge (default: most recent lock file)
- `--source <name>` — tag for cooldown diagnostics (default: `cli`)

Under the hood: `quick-task` POSTs to `/launch-quick-task` with bearer auth from the lock file; `start-task` + `continue-handoff` open a short-lived MCP session over HTTP and call `runClaudeTask` directly. 5s bridge-global cooldown per preset (shared across sidebar + CLI + MCP callers — prevents task-spam from multiple clients).

---

## What Requires the Extension

| Category | Tools | Why |
|----------|-------|-----|
| LSP (full) | `getDiagnostics`, `getDocumentSymbols`, `getHover`, `signatureHelp`, `getInlayHints`, `getCallHierarchy`, `getTypeHierarchy`, `getCodeActions`, `getCodeLens`, `getSemanticTokens`, `watchDiagnostics` | Language server runs inside VS Code |
| Debugger | `setDebugBreakpoints`, `startDebugging`, `evaluateInDebugger`, `stopDebugging` | Debug adapter lives in VS Code |
| Editor state | `getOpenEditors`, `captureScreenshot`, `contextBundle`, `getHoverAtCursor` | VS Code window required |
| Formatting | `formatDocument`, `fixAllLintErrors` | Extension invokes VS Code formatter |
| VS Code commands | `executeVSCodeCommand`, `listVSCodeTasks`, `runVSCodeTask` | VS Code runtime required |
| Decorations | `setEditorDecorations`, `clearEditorDecorations` | VS Code renderer required |

---

## Docker Setup

The official Docker image includes all probes pre-installed:

```dockerfile
FROM ghcr.io/oolab-labs/claude-ide-bridge:latest
```

Or build your own Dockerfile (Alpine base):

```dockerfile
FROM node:20-alpine

RUN apk add --no-cache tini ctags ripgrep git curl bash

RUN npm install -g claude-ide-bridge typescript-language-server typescript

WORKDIR /workspace

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["claude-ide-bridge", "--workspace", "/workspace", "--bind", "0.0.0.0", "--full"]
```

Start a container with workspace bind-mount:

```bash
docker run \
  -v /your/project:/workspace \
  -v ~/.claude:/root/.claude \
  -p 18765:18765 \
  ghcr.io/oolab-labs/claude-ide-bridge:latest \
  --workspace /workspace --bind 0.0.0.0
```

The `~/.claude` bind-mount lets `print-token` work from the host:

```bash
claude-ide-bridge print-token --port 18765
```

### docker-compose example

```yaml
services:
  bridge:
    image: ghcr.io/oolab-labs/claude-ide-bridge:latest
    ports:
      - "18765:18765"
    volumes:
      - ./:/workspace
      - ~/.claude:/root/.claude
    command: >
      --workspace /workspace
      --bind 0.0.0.0
      --full
      --watch
    restart: unless-stopped
```

---

## GitHub Actions

```yaml
name: Bridge analysis

on: [push]

jobs:
  analyze:
    runs-on: ubuntu-latest

    steps:
      - uses: actions/checkout@v4

      - name: Install bridge
        run: npm install -g claude-ide-bridge typescript-language-server typescript

      - name: Install probes
        run: sudo apt-get install -y ripgrep universal-ctags

      - name: Start bridge
        run: |
          claude-ide-bridge --workspace . --full &
          sleep 2

      - name: Print auth token
        run: claude-ide-bridge print-token

      - name: Run analysis via Claude
        env:
          ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
        run: |
          TOKEN=$(claude-ide-bridge print-token)
          # Use token with your MCP-aware Claude invocation
```

### Minimal CI config (no full probe install)

If you only need git and shell tools, skip the probe installs — the bridge starts fine without them and degrades gracefully:

```yaml
- name: Start bridge (minimal)
  run: |
    npx claude-ide-bridge --workspace . &
    sleep 2
```

Probes not found at startup emit a single `WARN probe not found: <name>` log line and those fallback paths are disabled. Everything else continues normally.

---

## Getting the Auth Token Headless

The bridge writes a lock file at `$CLAUDE_CONFIG_DIR/ide/<port>.lock` containing the auth token:

```bash
# Print token for the default port (18765)
claude-ide-bridge print-token

# Specify port explicitly
claude-ide-bridge print-token --port 18766

# Read raw JSON from lock file
cat ~/.claude/ide/18765.lock
```

The lock file JSON structure:

```json
{
  "pid": 12345,
  "workspace": "/your/project",
  "authToken": "abc123...",
  "isBridge": true,
  "port": 18765
}
```

Use the token in the `x-claude-code-ide-authorization` header for WebSocket connections, or as a Bearer token for Streamable HTTP (`Authorization: Bearer <token>`).

---

## TypeScript LSP Fallback Details

When the extension is absent, the bridge spawns `typescript-language-server --stdio` lazily on the first LSP tool call. It targets the workspace root.

**Initialization:** ~2s on first call (cold start). Subsequent calls reuse the singleton process.

**Workspace requirements:** `node_modules` must be present. Run `npm install` before starting the bridge if you need accurate type resolution.

**Supported fallback tools:**

| Tool | Fallback behavior |
|------|-------------------|
| `goToDefinition` | TS LSP `textDocument/definition` |
| `findReferences` | TS LSP `textDocument/references` |
| `getTypeSignature` | TS LSP `textDocument/hover` (extracts type from hover markdown) |

**Limitations vs extension-backed LSP:**

- `getDiagnostics` is not available headless — compilation errors require VS Code
- `getDocumentSymbols` headless path is not implemented
- Hover, references, and definition work but may be slower than the VS Code language client
- Multi-root workspaces: fallback targets the first workspace folder only

---

## VPS / Remote Server

For a persistent headless deployment on a VPS:

```bash
# Install
npm install -g claude-ide-bridge

# Start with fixed token (prevents rotation on restart)
claude-ide-bridge \
  --workspace /srv/myproject \
  --bind 0.0.0.0 \
  --full \
  --fixed-token "$(uuidgen)" \
  --watch \
  --vps
```

Use a reverse proxy (nginx or Caddy) with TLS in front. See `docs/remote-access.md` for full proxy config.

For systemd service installation:

```bash
bash deploy/install-vps-service.sh
```

Or full VPS provisioning (installs Node, bridge, nginx, systemd unit):

```bash
bash deploy/bootstrap-new-vps.sh
```

---

## Environment Variables

| Variable | Default | Purpose |
|----------|---------|---------|
| `CLAUDE_CONFIG_DIR` | `~/.claude` | Lock file and token location |
| `BRIDGE_BIND_ADDRESS` | `127.0.0.1` | Bind address (`0.0.0.0` for containers) |
| `PORT` | `18765` | Listen port |
| `CLAUDE_IDE_BRIDGE_CORS_ORIGINS` | _(none)_ | Comma-separated CORS origins for OAuth mode |

---

## Checking Tool Availability at Runtime

After connecting, call `getBridgeStatus` to see the full picture:

```json
{
  "extensionConnected": false,
  "probes": {
    "rg": true,
    "ctags": true,
    "typescriptLanguageServer": true,
    "gh": false,
    "git": true
  },
  "toolAvailability": {
    "goToDefinition": { "available": true, "extensionFallback": true },
    "getDiagnostics": { "available": false, "extensionRequired": true },
    "searchWorkspace": { "available": true, "probe": "rg" }
  }
}
```

Tools with `extensionRequired: true` and no fallback are unavailable until a VS Code extension connects. Tools with `extensionFallback: true` degrade to the CLI fallback path automatically.

---

## Troubleshooting

**"Tool X unavailable" in headless mode**

Check `getBridgeStatus.toolAvailability`. If the relevant probe shows `false`, install the CLI and restart the bridge.

**`typescript-language-server` not finding types**

Ensure `node_modules` is present in the workspace root. Run `npm install` first. The LSP server needs installed packages to resolve imports.

**`getBufferContent` returns disk content, not editor buffer**

Expected in headless mode — there is no open editor. Content is read directly from disk. This is correct behavior.

**Ctags fallback returns no results**

Run `ctags --version` and confirm "Universal Ctags" appears in the output. The standard `exuberant-ctags` package does not support `--output-format=json` and will not be detected. On Alpine use `apk add ctags`; on Ubuntu use `apt-get install universal-ctags`.

**Bridge exits immediately in Docker**

Ensure you are not running as PID 1 without a proper init. Use `tini` (`/sbin/tini --`) as the entrypoint, or add `--init` to `docker run`. The `SIGTERM` handler in the bridge expects a normal process tree.

**`print-token` returns "no lock file found"**

The bridge may not have started yet, or it is writing to a different `CLAUDE_CONFIG_DIR`. Check that `CLAUDE_CONFIG_DIR` matches between the bridge process and the `print-token` call. In Docker, verify the volume mount covers `~/.claude` (or whatever `CLAUDE_CONFIG_DIR` is set to).

**Rate limiting in CI (`-32004` errors)**

The bridge enforces 200 requests/min per session. CI scripts that hammer the bridge in a tight loop will hit this. Add a short delay between batched calls, or increase the limit with `--tool-rate-limit <n>`.
