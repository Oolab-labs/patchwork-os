# Claude IDE Bridge

[![npm version](https://img.shields.io/npm/v/claude-ide-bridge)](https://www.npmjs.com/package/claude-ide-bridge)
[![CI](https://github.com/Oolab-labs/claude-ide-bridge/actions/workflows/ci.yml/badge.svg)](https://github.com/Oolab-labs/claude-ide-bridge/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

A standalone MCP bridge that gives [Claude Code](https://claude.ai/code) full IDE integration — **138+ tools** for LSP, debugging, terminals, Git, GitHub, diagnostics, code analysis, screen capture, and more. Works with any VS Code-compatible editor (VS Code, Windsurf, Cursor) and pairs with a companion extension for real-time editor state.

## How It Works

```
Your Phone / Laptop                    Your Computer
┌──────────────┐                      ┌─────────────────────────────┐
│  Claude Code  │───── SSH/local ─────│  Bridge Server              │
│  (CLI)        │◄── remote control ──│    ↕ WebSocket              │
└──────────────┘                      │  IDE Extension (VS Code)    │
                                      │    ↕ Real-time state        │
       ┌──────────────────────────────│  Your Code & Editor         │
       │   runClaudeTask              └─────────────────────────────┘
       ▼
┌──────────────┐
│  claude -p   │  Autonomous subprocess — full tools, no approval loop
│  subprocess  │  Output streams back to VS Code output channel
└──────────────┘
```

Claude Code connects to the bridge, which connects to your IDE extension. Claude can then open files, run tests, set breakpoints, check diagnostics, commit to Git, create PRs — everything a developer at the keyboard can do.

**Use it from your phone**: SSH into your dev machine, send a message via remote control, and delegate autonomous work to a `claude -p` subprocess running on your home machine. Watch it fix bugs, run tests, and commit — then go back to sleep.

**Autonomous task mode**: With `--claude-driver subprocess`, the bridge can spawn Claude subprocesses on demand via the `runClaudeTask` MCP tool. Tasks run in parallel (up to 10 concurrent), stream output to VS Code in real time, and can be triggered automatically by diagnostics or file saves via an automation policy.

## Quick Start

**Prerequisites:** [Claude Code CLI](https://claude.ai/code), Node.js ≥ 20, tmux (`brew install tmux`)

**Step 1 — Install the VS Code extension**

Search `oolab-labs.claude-ide-bridge-extension` in the VS Code / Windsurf / Cursor extension marketplace, or install from the command line:

```bash
code --install-extension oolab-labs.claude-ide-bridge-extension
# Windsurf: windsurf --install-extension oolab-labs.claude-ide-bridge-extension
# Cursor:   cursor --install-extension oolab-labs.claude-ide-bridge-extension
```

**Step 2 — Install and start the bridge**

```bash
npm install -g claude-ide-bridge
cd /your/project
claude-ide-bridge
```

The bridge starts, writes a lock file to `~/.claude/ide/`, and waits for connections. Your editor extension connects automatically.

> **One bridge per workspace.** Each project directory needs its own bridge instance. If you work across multiple repos, start a separate `claude-ide-bridge` in each workspace.

> **For long-running use**, add `--watch` to auto-restart the bridge if it crashes:
> ```bash
> claude-ide-bridge --watch
> ```
> The supervisor uses exponential backoff (2s → 30s) and is safe to leave running indefinitely.

**Step 3 — Connect Claude Code**

In a new terminal in your project directory:

```bash
CLAUDE_CODE_IDE_SKIP_VALID_CHECK=true claude --ide
```

> **Tip:** Add `export CLAUDE_CODE_IDE_SKIP_VALID_CHECK=true` to your `~/.zshrc` or `~/.bashrc` to make it permanent — after that, `claude --ide` is all you need.

Claude Code connects to the bridge. Type `/ide` to confirm — you'll see your open files, diagnostics, and editor state.

**That's it.** Claude can now read your diagnostics, navigate your code, run tests, commit to Git, and more.

**Step 4 — Add bridge guidance to your project's CLAUDE.md (recommended)**

```bash
claude-ide-bridge gen-claude-md --write
```

This appends a `## Claude IDE Bridge` section to your `CLAUDE.md` (creating it if absent) with:
- **Bug-fix methodology** — write a failing test first, fix, confirm the test passes
- **Documentation practices** — when to update CLAUDE.md and save decisions to Claude's memory
- **Workflow rules** — use bridge tools instead of shell fallbacks
- **Quick-reference tool table** — 14 common tasks mapped to the right tool

Idempotent — safe to re-run; won't duplicate the section if it already exists. When appending to an existing file, a timestamped `.bak` backup is created.

> **Why this matters for existing projects:** Claude Code has no built-in awareness of bridge tools. Without this section, Claude may fall back to raw shell commands for git, testing, and diagnostics — missing structured output, error codes, and IDE integration. Running `gen-claude-md` once teaches Claude how to work in your project from the first message of every session.

---

**Optional — full orchestrator with health monitoring:**

```bash
claude-ide-bridge start-all --workspace /your/project
```

Launches four tmux panes: health monitor, bridge, Claude Code, and remote control — with automatic restart on failure. Requires `tmux`.

## Full Orchestrator

The `start-all` command launches everything in a tmux session: bridge + Claude Code + remote control, with automatic health monitoring and process restart.

```bash
# Via npm global install or npx
claude-ide-bridge start-all --workspace /path/to/your-project

# Or the dedicated alias
claude-ide-bridge-start --workspace /path/to/your-project

# From source
npm run start-all -- --workspace /path/to/your-project
```

Options:

| Flag | Description |
|------|-------------|
| `--workspace <path>` | Project directory (default: `.`) |
| `--notify <topic>` | ntfy.sh topic for push notifications |
| `--ide <name>` | IDE name hint (e.g. `windsurf`) |

Requires `tmux` and the `claude` CLI to be on `PATH`.

## Claude Code Plugin

The bridge ships as a **Claude Code plugin** with 9 skills, 3 subagents, and 3 hooks:

```bash
# Load the plugin
claude --plugin-dir ./claude-ide-bridge-plugin
```

### Skills

| Skill | Description | Remote Session |
|-------|-------------|:-:|
| `/ide-diagnostics-board` | Visual diagnostics dashboard (HTML) across the workspace | CLI fallback |
| `/ide-coverage` | Test coverage heatmap (HTML) from lcov/JSON data | CLI fallback |
| `/ide-quality` | Multi-language lint sweep + auto-fix + format + optional commit | CLI fallback |
| `/ide-debug` | Full debug cycle: run tests, set breakpoints, evaluate expressions, fix, verify | Requires bridge |
| `/ide-review` | Deep PR review using LSP code intelligence + GitHub tools | Requires bridge |
| `/ide-refactor` | Safe refactoring with snapshot checkpoints and auto-rollback | Requires bridge |
| `/ide-explore` | Codebase exploration using LSP (runs in isolated Explore agent) | Requires bridge |
| `/ide-deps` | Interactive dependency graph (HTML) for a file or symbol | Requires bridge |
| `/ide-monitor` | Continuous monitoring for diagnostics, tests, or terminal output | Requires bridge |

> **Remote sessions** (`claude remote-control`): Skills marked "CLI fallback" work without the bridge by using built-in Claude Code tools. Skills marked "Requires bridge" need the `claude --ide` session.

### Subagents

| Agent | Description |
|-------|-------------|
| `ide-code-reviewer` | Evidence-based code review using LSP tools, with persistent memory |
| `ide-debugger` | Autonomous debug cycles with breakpoints and expression evaluation |
| `ide-test-runner` | Runs tests, categorizes failures, applies fixes |

### Hooks

| Event | What it does |
|-------|-------------|
| `PostToolUse` on Edit/Write | Reminds Claude to check diagnostics after file edits |
| `SessionStart` | Reports bridge status, connection, and tool count |
| `SubagentStart` | Verifies bridge is alive before IDE subagents run |

## 138+ MCP Tools

### File Operations (8)
`openFile` · `openDiff` · `saveDocument` · `closeTab` · `closeAllDiffTabs` · `checkDocumentDirty` · `getOpenEditors` · `searchWorkspace`

### LSP / Code Intelligence (13)
`goToDefinition` · `findReferences` · `getHover` · `getHoverAtCursor` · `getCodeActions` · `applyCodeAction` · `renameSymbol` · `searchWorkspaceSymbols` · `getDocumentSymbols` · `getCallHierarchy` · `getTypeHierarchy` · `getInlayHints` · `getTypeSignature`

### Debugging (5)
`setDebugBreakpoints` · `startDebugging` · `evaluateInDebugger` · `getDebugState` · `stopDebugging`

### Terminal (8)
`createTerminal` · `runInTerminal` · `sendTerminalCommand` · `waitForTerminalOutput` · `getTerminalOutput` · `listTerminals` · `disposeTerminal` · `runCommand`

### Git (16)
`getGitStatus` · `getGitDiff` · `getGitLog` · `gitAdd` · `gitCommit` · `gitPush` · `gitPull` · `gitFetch` · `gitListBranches` · `gitCheckout` · `gitStash` · `gitStashList` · `gitStashPop` · `gitBlame` · `getCommitDetails` · `getDiffBetweenRefs`

### GitHub (12)
`githubCreatePR` · `githubViewPR` · `githubGetPRDiff` · `githubPostPRReview` · `githubListPRs` · `githubCreateIssue` · `githubListIssues` · `githubGetIssue` · `githubCommentIssue` · `githubListRuns` · `githubGetRunLogs` · `createGithubIssueFromAIComment`

### Diagnostics & Testing (4)
`getDiagnostics` · `watchDiagnostics` · `runTests` · `getCodeCoverage`

### Code Quality (3)
`fixAllLintErrors` · `formatDocument` · `organizeImports`

### Snapshots & Plans (10)
`createSnapshot` · `restoreSnapshot` · `diffSnapshot` · `listSnapshots` · `deleteSnapshot` · `createPlan` · `updatePlan` · `getPlan` · `listPlans` · `deletePlan`

### Editor State (6)
`getCurrentSelection` · `getLatestSelection` · `getOpenEditors` · `getBufferContent` · `setEditorDecorations` · `clearEditorDecorations`

### Code Analysis & Security (9)
`auditDependencies` · `getSecurityAdvisories` · `detectUnusedCode` · `refactorExtractFunction` · `generateAPIDocumentation` · `getDependencyTree` · `getGitHotspots` · `getImportTree` · `getActivityLog`

### Bridge & Session (3)
`getBridgeStatus` · `getHandoffNote` · `setHandoffNote`

### Clipboard (2)
`readClipboard` · `writeClipboard`

### Screen Capture (1)
`captureScreenshot`

### VS Code Integration (10)
Text editing · Workspace settings · File watchers · Decorations · `executeVSCodeCommand` · `listVSCodeCommands` · `getWorkspaceSettings` · `updateWorkspaceSetting` · `openInBrowser`

| Category | Count | Extension Required |
|----------|------:|:-:|
| File Operations | 8 | No |
| Git | 16 | No |
| GitHub | 12 | No (requires `gh`) |
| LSP / Code Intelligence | 13 | Yes (with fallbacks) |
| Editor State | 6 | Yes |
| Text Editing | 5 | Yes |
| Terminal | 8 | Yes |
| Diagnostics & Testing | 4 | Mixed |
| Code Analysis & Security | 9 | No |
| Code Quality | 3 | Yes |
| Debug | 5 | Yes |
| Decorations | 2 | Yes |
| Screen Capture | 1 | Yes |
| Snapshots & Plans | 10 | No |
| Bridge & Session | 3 | No |
| Clipboard | 2 | Mixed |
| HTTP | 2 | No |
| VS Code Integration | 10 | Yes |
| **Total** | **~119** | |

## MCP Prompts (Slash Commands)

The bridge exposes 7 built-in slash commands via the MCP `prompts/list` + `prompts/get` protocol. These appear as `/mcp__bridge__<name>` in any MCP client that supports prompts.

| Prompt | Argument | Description |
|--------|----------|-------------|
| `/mcp__bridge__review-file` | `file` (required) | Code review for a specific file using current diagnostics |
| `/mcp__bridge__explain-diagnostics` | `file` (required) | Explain and suggest fixes for all diagnostics in a file |
| `/mcp__bridge__generate-tests` | `file` (required) | Generate a test scaffold for the exported symbols in a file |
| `/mcp__bridge__debug-context` | _(none)_ | Snapshot current debug state, open editors, and diagnostics |
| `/mcp__bridge__git-review` | `base` (optional, default: `main`) | Review all changes since a git base branch |
| `/mcp__bridge__cowork` | `task` (optional) | Gather full IDE context and propose a Cowork action plan — run this **before** opening a Cowork session |
| `/mcp__bridge__set-effort` | `level` (optional: `low`/`medium`/`high`, default: `medium`) | Prepend an effort-level instruction to tune Claude's thoroughness for the next task |

> **Cowork sessions and MCP tools:** MCP tools (including all bridge tools) are **not available inside a Cowork session**. Use a two-step workflow: run `/mcp__bridge__cowork` in a regular Claude Code chat first — it gathers full IDE context and produces an action plan — then open a Cowork session armed with that context.

Prompts are served directly from the bridge — no extension required. Implemented in `src/prompts.ts`.

---

## MCP Resources

The bridge exposes your workspace files as MCP Resources via `resources/list` and `resources/read`. Any MCP client that supports the resources protocol can browse and read files directly — without calling individual file tools.

- Workspace tree is walked automatically (skips `node_modules`, `.git`, `dist`, etc.)
- Only text file extensions are exposed
- Cursor-paginated (50 files per page)
- 1 MB per-file cap
- Workspace-confined: paths outside the workspace are rejected

No configuration needed — resources are enabled by default.

---

## HTTP Monitoring Endpoints

The bridge exposes several HTTP endpoints for monitoring and integration. All require `Authorization: Bearer <token>` except `/.well-known/mcp`.

| Endpoint | Description |
|----------|-------------|
| `GET /health` | Liveness probe — returns `{ status, uptime, connections }` |
| `GET /ready` | Readiness probe — returns 200 only after MCP handshake completes and reports tool count + extension state. Returns 503 before ready. |
| `GET /status` | Detailed status object with uptime and session diagnostics |
| `GET /metrics` | Prometheus-format metrics: `bridge_tool_calls_total`, `bridge_tool_duration_ms_avg`, `bridge_uptime_seconds` |
| `GET /stream` | Server-Sent Events stream of all activity log entries in real time (tool calls, lifecycle events). Keep-alive pings included. |
| `GET /tasks` | Sanitized task list (when `--claude-driver` is active) |
| `GET /.well-known/mcp` | Public MCP server discovery — name, version, capabilities, transports (no auth required) |

```bash
TOKEN=$(cat ~/.claude/ide/*.lock | python3 -c "import sys,json; print(json.load(sys.stdin)['authToken'])")

# Live tool call feed
curl -N -H "Authorization: Bearer $TOKEN" http://localhost:PORT/stream

# Prometheus scrape
curl -H "Authorization: Bearer $TOKEN" http://localhost:PORT/metrics
```

---

## OpenTelemetry

The bridge instruments every tool call with OpenTelemetry spans. Tracing is zero-overhead when disabled (the default).

```bash
# Export traces to any OTLP-compatible collector (Jaeger, Datadog, Honeycomb, etc.)
OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318 claude-ide-bridge
OTEL_SERVICE_NAME=my-bridge claude-ide-bridge  # optional service name override
```

Spans are exported on process exit. No bridge code changes needed — the env var activates tracing automatically.

---

## Claude Orchestration & Automation

The bridge can spawn Claude subprocesses, queue tasks, and drive event-driven automation directly from VS Code events.

### Starting with automation enabled

```bash
# Enable subprocess driver + event-driven automation with a policy file
claude-ide-bridge --workspace /path/to/project \
  --claude-driver subprocess \
  --automation \
  --automation-policy ./automation-policy.json
```

### Automation policy file

```json
{
  "onDiagnosticsError": {
    "enabled": true,
    "minSeverity": "error",
    "prompt": "Fix the errors in {{file}}:\n{{diagnostics}}",
    "cooldownMs": 30000
  },
  "onFileSave": {
    "enabled": true,
    "patterns": ["**/*.ts", "!node_modules/**"],
    "prompt": "Review the saved file: {{file}}",
    "cooldownMs": 10000
  },
  "onPostCompact": {
    "enabled": true,
    "prompt": "Context was compacted. Call getOpenEditors and getDiagnostics to rebuild your understanding of the current state.",
    "cooldownMs": 60000
  },
  "onInstructionsLoaded": {
    "enabled": true,
    "prompt": "Call getToolCapabilities to confirm the bridge is connected and note which tools are available for this session."
  }
}
```

When automation is active, VS Code save events and diagnostic errors automatically enqueue Claude tasks. Output streams to the "Claude IDE Bridge" output channel in real time.

**Policy triggers:**

| Trigger | When it fires | Key fields |
|---------|--------------|------------|
| `onDiagnosticsError` | VS Code reports new errors/warnings for a file | `enabled`, `minSeverity` (`error`/`warning`), `prompt` (supports `{{file}}` and `{{diagnostics}}`), `cooldownMs` |
| `onFileSave` | A file matching `patterns` is saved | `enabled`, `patterns` (minimatch globs), `prompt` (supports `{{file}}`), `cooldownMs` |
| `onPostCompact` | Claude compacts its context (Claude Code 2.1.76+) | `enabled`, `prompt`, `cooldownMs` |
| `onInstructionsLoaded` | Claude loads CLAUDE.md at session start (Claude Code 2.1.76+) | `enabled`, `prompt` |

> **Cloud sessions**: If `CLAUDE_CODE_REMOTE=true` (Claude Code on the web), automation tasks will still enqueue but the bridge itself runs locally — those tasks will not execute. Guard policy prompts or the `onInstructionsLoaded` hook with an environment check if needed.

### CLI flags

| Flag | Description |
|------|-------------|
| `--claude-driver <mode>` | `subprocess` \| `api` \| `none` (default: `none`) |
| `--claude-binary <path>` | Path to the `claude` binary (default: `claude`) |
| `--automation` | Enable event-driven automation |
| `--automation-policy <path>` | Path to JSON automation policy file |

### Task management tools (registered when `--claude-driver != none`)

| Tool | Description |
|------|-------------|
| `runClaudeTask` | Enqueue a Claude task with optional context files, streaming, and model override (`model` param, e.g. `"claude-haiku-4-5-20251001"`) |
| `getClaudeTaskStatus` | Poll task status and output by task ID |
| `cancelClaudeTask` | Cancel a pending or running task |
| `listClaudeTasks` | List session-scoped tasks with optional status filter |
| `resumeClaudeTask` | Re-enqueue a completed or failed task by ID, preserving its original prompt, context files, and model |

A `GET /tasks` HTTP endpoint (Bearer-auth required) provides a sanitized task list for external monitoring.

---

## Headless / CI Usage

Use with `claude -p` for automation:

```bash
# Fix all lint errors
claude -p "Use getDiagnostics to find all errors, then fix them" \
  --mcp-config ./mcp-bridge.json

# Run tests and fix failures
claude -p "Run tests with runTests, fix any failures, and commit" \
  --mcp-config ./mcp-bridge.json

# Generate architecture overview
claude -p "Map the project using getFileTree, getDocumentSymbols, and getCallHierarchy" \
  --mcp-config ./mcp-bridge.json --output-format json
```

## Persistent Sessions *(beta)*

When the bridge restarts, it picks up where it left off — restoring the set of files you had open in Claude's view of the workspace.

**What's restored:**
- Open file tracking (the set of files Claude was aware of across the last session's activity)
- Task queue — pending and running tasks survive bridge crashes and restarts (persisted to `~/.claude/ide/tasks-<port>.json`)
- Activity log — all tool calls from past sessions remain readable

**What isn't restored:**
- In-progress tool calls (those are cancelled on disconnect)
- Live diagnostics (always fetched fresh from the extension)
- Claude's own conversation context (that's Claude Code's responsibility, not the bridge's)

**How it works:** The bridge checkpoints session state every 30 seconds to `~/.claude/ide/`. On startup, the first connecting Claude session is seeded with the union of all previously-tracked open files. No configuration needed — this is on by default.

> **Beta caveat:** Checkpoint restore is file-list only. Full "resume from mid-task" support (restoring partial tool progress, re-streaming output) is not yet implemented.

---

## Headless VPS *(new)*

Run the bridge on a remote server with no display — give Claude full IDE capabilities over SSH without opening a desktop environment.

**Recommended: VS Code Remote-SSH or Cursor SSH**

Connect your local VS Code or Cursor to a VPS via Remote-SSH. The bridge extension runs in the remote extension host automatically — no extra setup. LSP, debugger, terminals, and all editor-state tools work normally because the extension and bridge run together on the server.

**Fully headless (no IDE)**

For servers with no VS Code at all:

```bash
# On the VPS — install Node.js 20 + the bridge
curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
apt-get install -y nodejs
npm install -g claude-ide-bridge

# Generate a stable token (survives restarts — save this value)
export BRIDGE_TOKEN=$(uuidgen | tr '[:upper:]' '[:lower:]')

# Start the bridge in the background with tmux
tmux new-session -d -s bridge 'claude-ide-bridge --bind 0.0.0.0 --port 9000 --fixed-token $BRIDGE_TOKEN --workspace /path/to/project'

# Confirm the token
claude-ide-bridge print-token --port 9000
```

```bash
# On your local machine — write an MCP config pointing at the VPS
# Run from inside your project directory (merges into the nearest .mcp.json)
bash scripts/gen-mcp-config.sh remote \
  --host your-vps-ip:9000 \
  --token <token-from-above> \
  --write
```

Available tools in headless mode: file operations, git, terminals, search, CLI linters, dependency audits, HTTP client. LSP, debugger, and editor-state tools require the extension.

> **Stable tokens:** Use `--fixed-token <uuid>` (or `CLAUDE_IDE_BRIDGE_TOKEN=<uuid>`) to keep the same token across restarts. Without it, a new token is generated each time the bridge starts, requiring a config update.

> **Security:** `--bind 0.0.0.0` exposes the bridge to the network. Put nginx or Caddy in front with TLS before exposing to the internet. See [docs/remote-access.md](docs/remote-access.md) for a production Caddy setup.

---

## Supported Editors

| Editor | Status |
|--------|--------|
| VS Code | Supported |
| Windsurf | Supported |
| Cursor | Supported |
| Google Antigravity | Supported |

Install the extension in any supported editor:

```bash
# Auto-detect editor
claude-ide-bridge install-extension

# Specify editor
claude-ide-bridge install-extension windsurf
claude-ide-bridge install-extension cursor

# Or via the install script
bash scripts/install-extension.sh --ide <name>
```

## Remote Desktop IDEs

Run the bridge on a VPS with the IDE on your local machine — full tools, no compromise.

### VS Code Remote-SSH / Cursor SSH (recommended)

When you connect VS Code or Cursor to a VPS via SSH, the extension host runs on the VPS. The bridge extension runs there too — it spawns the bridge, polls lock files, and connects over VPS localhost. Nothing needs to change on your end.

**Setup:**
1. Install the extension in VS Code/Cursor locally (it will auto-install on the VPS via SSH)
2. Connect via Remote-SSH and open your VPS workspace
3. The extension activates on the VPS, auto-installs `claude-ide-bridge` if needed, and starts the bridge
4. Claude Code on your local machine connects normally via the lock file

All tools are available — LSP, debugger, terminals, git, diagnostics — because the extension runs alongside the bridge on the same machine.

### Headless VPS (no IDE, CLI tools only)

For VPS environments without VS Code (e.g. a pure server setup):

```bash
# On the VPS — start bridge with a stable token so it survives restarts
export BRIDGE_TOKEN=$(uuidgen | tr '[:upper:]' '[:lower:]')
tmux new-session -d -s bridge 'claude-ide-bridge --bind 0.0.0.0 --port 9000 --fixed-token $BRIDGE_TOKEN --workspace /path/to/project'

# Get the auth token
claude-ide-bridge print-token --port 9000
```

```bash
# On your local machine — generate and write the MCP config
# Run from inside your project directory (merges into the nearest .mcp.json)
bash scripts/gen-mcp-config.sh remote \
  --host your-vps-ip:9000 \
  --token <token-from-above> \
  --write
```

> **Stable tokens:** `--fixed-token` keeps the same token across bridge restarts so your local config stays valid. Without it, the token changes every restart.

> **Security:** `--bind 0.0.0.0` exposes the bridge to your network. For production, put nginx or Caddy in front with TLS. The `remote` config generator uses `http://` — update the URL to `https://` once TLS is in place.

Available tools in headless mode: file operations, git, terminals, search, CLI linters, dependency audits, HTTP client. LSP, debugger, and editor-state tools are unavailable without the extension.

## Use with Claude Desktop

Connect the Claude Desktop app to your running bridge — chat with your IDE using natural language.

```bash
# Generate the config (prints to stdout)
bash scripts/gen-claude-desktop-config.sh

# Write it to the config file (backs up existing config)
bash scripts/gen-claude-desktop-config.sh --write
```

Then restart Claude Desktop once to load the new config. After that, the bridge's **stdio shim** handles everything automatically — it discovers the running bridge via lock files, buffers requests until connected, and reconnects transparently when the bridge restarts. No port or token needs to be hard-coded, and no further Desktop restarts are needed when the bridge restarts.

> **Tool availability:** Without the VS Code extension connected, ~25 tools (terminal, debug, LSP intelligence, editor state, file watchers) are unavailable. Claude Desktop works best alongside the running extension. You can verify connectivity by asking *"What tools do you have available?"* — the response will list what's active.

> **Debugging the shim:** If the connection seems stuck, the shim logs to stderr. In Claude Desktop, check **Settings → Developer → MCP Logs** to see shim output. Common cause: bridge not running — start it with `claude-ide-bridge --watch` first.

**Try it:** Open Claude Desktop and ask *"What diagnostics are in my workspace?"* or *"What files are open in my IDE?"*

You can also use the general config generator:

```bash
bash scripts/gen-mcp-config.sh claude-desktop --write
```

Config location:
- **macOS**: `~/Library/Application Support/Claude/claude_desktop_config.json`
- **Windows**: `%APPDATA%\Claude\claude_desktop_config.json`

## Use with Claude.ai Web

Connect the bridge to [claude.ai](https://claude.ai) via a **Custom Connector** — chat with your IDE from the browser without installing anything extra.

**Prerequisites:** The bridge must be reachable over HTTPS from the public internet. Two options:

**Option A — Reverse proxy with a domain (production)**
Put nginx or Caddy in front of the bridge with TLS. See [docs/remote-access.md](docs/remote-access.md) for a ready-made setup.

**Option B — Cloudflare Named Tunnel (permanent URL, recommended)**

A named tunnel gives you a stable subdomain under your own domain that survives `cloudflared` restarts.

```bash
# 1. Install cloudflared
curl -L https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64 \
  -o /usr/local/bin/cloudflared && chmod +x /usr/local/bin/cloudflared

# 2. Authenticate with your Cloudflare account (opens browser)
cloudflared tunnel login

# 3. Create a named tunnel (one-time)
cloudflared tunnel create my-bridge

# 4. Route a DNS hostname to the tunnel (requires your domain on Cloudflare)
cloudflared tunnel route dns my-bridge bridge.yourdomain.com

# 5. Create a config file at ~/.cloudflared/config.yml
cat > ~/.cloudflared/config.yml <<EOF
tunnel: my-bridge
credentials-file: /root/.cloudflared/<tunnel-id>.json

ingress:
  - hostname: bridge.yourdomain.com
    service: http://localhost:9000
  - service: http_status:404
EOF

# 6. Run the tunnel (add to systemd/pm2 for auto-start)
cloudflared tunnel run my-bridge
# Bridge is now permanently reachable at https://bridge.yourdomain.com
```

Your MCP connector URL is then permanently `https://bridge.yourdomain.com/mcp?token=<token>` — it will not change across restarts.

**Option C — Ephemeral Cloudflare Tunnel (quick test only)**

> ⚠️ The subdomain changes every time `cloudflared` restarts. Do not use this for a permanent setup — your MCP config and connector URL will break. Use Option B above for anything beyond a one-off test.

```bash
cloudflared tunnel --url http://localhost:9000
# Outputs a temporary URL like: https://abc123.trycloudflare.com
```

Once the bridge is publicly reachable, add a Custom Connector on claude.ai:

1. Go to **claude.ai → Settings → Integrations → Add custom connector**
2. Enter the URL with your token embedded as a query param:
   ```
   https://bridge.yourdomain.com/mcp?token=<your-token>
   ```
3. Save — claude.ai will verify the connection and list all available tools

The `?token=` query param is supported in addition to `Authorization: Bearer` headers, since the claude.ai connector UI cannot set custom request headers.

> **Stable tokens:** Use `--fixed-token <uuid>` when starting the bridge so the token doesn't change across restarts and your connector URL stays valid.

> **Tool availability:** All 138+ tools are available. VS Code extension-dependent tools (LSP, debugger, editor state) require the extension to be connected on the remote machine. Without the extension, ~80 CLI tools still work (file ops, git, terminal, search, HTTP client).

**Mobile app:** The connector syncs to the Claude mobile app once added on the web. If it doesn't appear immediately, use claude.ai in your phone's browser — the connector works there without the native app.

**Try it:** Open [claude.ai](https://claude.ai), start a new conversation, and ask *"What files are in my workspace?"*

---

## Streamable HTTP (Remote MCP)

The bridge also exposes an MCP-compliant **Streamable HTTP** transport at `POST/GET/DELETE /mcp`. This lets any MCP client that speaks HTTP (including Claude Desktop via Custom Connectors, or curl) connect without a WebSocket.

```bash
# Start the bridge (listens on localhost by default)
claude-ide-bridge --workspace /path/to/your-project

# Connect remotely by binding to all interfaces
claude-ide-bridge --workspace /path/to/your-project --bind 0.0.0.0
```

> **Security warning:** `--bind 0.0.0.0` exposes the bridge to your entire network. Always put it behind a reverse proxy with TLS and authentication before exposing it to the internet. See [docs/remote-access.md](docs/remote-access.md) for a production-ready Caddy/nginx setup.

The bridge token (from the lock file at `~/.claude/ide/<port>.lock`) is required as a Bearer header:

```bash
TOKEN=$(cat ~/.claude/ide/*.lock | python3 -c "import sys,json; print(json.load(sys.stdin)['authToken'])")

# Initialize a session
curl -X POST http://localhost:PORT/mcp \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-11-25","capabilities":{},"clientInfo":{"name":"my-client","version":"1.0"}}}'
```

For remote access over the internet, see [docs/remote-access.md](docs/remote-access.md) for Caddy/nginx reverse proxy setup with TLS.

## CLI Reference

### Subcommands

```
claude-ide-bridge start-all [options]          Full tmux orchestrator (bridge + Claude + remote)
claude-ide-bridge install-extension [editor]   Install VS Code extension into your IDE
claude-ide-bridge gen-claude-md [--write] [--workspace <path>]
                                               Print bridge workflow guidance (or write to CLAUDE.md)
```

### Bridge options (default mode)

```
--workspace <path>        Workspace folder (default: cwd)
--ide-name <name>         IDE name shown to Claude (default: auto-detect)
--editor <cmd>            Editor CLI command (default: auto-detect)
--port <number>           Force specific port (default: random)
--linter <name>           Enable specific linter (repeatable; default: auto-detect)
--allow-command <cmd>     Add command to execution allowlist (repeatable)
--timeout <ms>            Command timeout in ms (default: 30000, max: 120000)
--max-result-size <KB>    Max output size in KB (default: 512, max: 4096)
--watch                   Supervisor mode: auto-restart on crash (exponential backoff, max 30s)
--auto-tmux               Re-exec inside a tmux session automatically
--tool-rate-limit <n>     Max tool calls per minute per session (default: 60)
--claude-driver <mode>    Claude subprocess driver: subprocess | api | none (default: none)
--claude-binary <path>    Path to claude binary (default: claude)
--automation              Enable event-driven automation
--automation-policy <path> Path to JSON automation policy file
--plugin <path>           Load a plugin directory (repeatable)
--plugin-watch            Watch plugin directories and hot-reload on change
--verbose                 Enable debug logging
--help                    Show this help
```

## Architecture

```
claude-ide-bridge/
  src/
    bridge.ts         Main orchestrator
    server.ts         HTTP/WebSocket server
    transport.ts      MCP transport layer
    extensionClient.ts Extension WebSocket client
    config.ts         CLI args & config
    claudeDriver.ts   IClaudeDriver interface + SubprocessDriver
    claudeOrchestrator.ts Task queue (MAX_CONCURRENT=10, MAX_QUEUE=20)
    automation.ts     AutomationHooks — onDiagnosticsError / onFileSave / onPostCompact / onInstructionsLoaded policies
    tools/            138+ MCP tool implementations
  vscode-extension/
    src/extension.ts  VS Code extension
    src/connection.ts WebSocket connection management
    src/handlers/     Request handlers (terminal, lsp, debug, ...)
  claude-ide-bridge-plugin/
    skills/           9 slash commands
    agents/           3 specialized subagents
    hooks/            3 lifecycle automations
    .mcp.json         MCP server config
```

## Tips

### Useful tools you might not know about

- **`getBridgeStatus`** — ask Claude to call this when things feel wrong. It returns extension connection state, circuit breaker status (including remaining suspension time), active session count, and uptime. Faster than reading logs.

- **`getActivityLog`** — returns a history of all tool calls in the current bridge session. Pass `showStats: true` to get per-tool call counts, average durations, and error rates. Useful after long autonomous tasks.

- **`getHandoffNote`** / **`setHandoffNote`** — a persistent scratchpad (10KB, shared across all MCP sessions) stored at `~/.claude/ide/handoff-note.json`. Use it to pass context between a Claude Code CLI session and Claude Desktop, or between sessions on different machines. Ask Claude to write a summary note before closing a session, then read it in the next.

- **`createGithubIssueFromAIComment`** — Claude can scan your code for `// AI:` comments (e.g. `// AI: this function needs error handling`) and file them as GitHub issues automatically. Run `getAIComments` first to populate the cache, then `createGithubIssueFromAIComment` to file them.

- **`executeVSCodeCommand`** — run any VS Code command by ID with optional arguments. Requires the command to be on the allowlist (`--vscode-allow-command <id>`). Use `listVSCodeCommands` to discover available command IDs.

### Keep your documentation and AI memory fresh

Claude's effectiveness improves significantly when your project documentation and memory stay current. A few habits that pay off:

- **Update `CLAUDE.md` after architectural changes.** Run `claude-ide-bridge gen-claude-md --write` when you add new tools or change patterns — stale guidance causes Claude to use wrong workflows.
- **Tell Claude to remember important decisions.** Say "remember that we don't mock the database in tests" or "remember we're targeting Node 20". Claude Code stores these in its memory and applies them in future sessions automatically.
- **Update memory at end-of-session.** If you've been working on a complex feature or debugging a subtle issue, ask Claude to save a summary to memory before closing — next session picks up where you left off with full context.
- **Prune stale memories.** Ask Claude "what do you remember about this project?" occasionally and tell it to forget anything outdated. Stale memory causes Claude to confidently do the wrong thing.
- **Keep `documents/` in sync with code.** If your team has docs in the `documents/` directory (platform-docs, roadmap, etc.), update them when features ship. Claude reads these at session start — accurate docs mean fewer mistakes.

> **Quick memory check:** Ask Claude *"What do you remember about this project?"* at the start of a new session to confirm context loaded correctly.

### After restarting the bridge

When you restart the bridge (e.g. after an update or crash), existing sessions need to reconnect:

- **Claude Code (remote):** Start a **new Claude Code conversation** — the old session's MCP connection is tied to the previous bridge process.
- **Claude Desktop:** The stdio shim reconnects automatically — no app restart needed. Only restart Claude Desktop if the shim process itself died (check MCP Logs in Settings → Developer).
- **VS Code extension:** The extension reconnects automatically. If the bridge was updated, **reload the VS Code window** (`Developer: Reload Window`) so the extension picks up the new version.

### Persistent Sessions (beta)

The bridge saves a checkpoint every 30 seconds to `~/.claude/ide/checkpoint-<port>.json`. On restart, it reads the most recent checkpoint to restore state.

**What persists:**

- **Open-file tracking** — restored only after a **crash or kill signal**, not after a clean `stop()` (which deletes the checkpoint). The first Claude Code session to reconnect after a crash receives the merged list of files that were open across all prior sessions. Subsequent sessions in the same run start empty.
- **Task history** (when `--claude-driver` is enabled) — saved to `~/.claude/ide/tasks-<port>.json` and restored on every restart, including clean stops.

**Staleness window:** Checkpoints older than **5 minutes** are silently ignored and no restore occurs. A `console.warn` is emitted when a stale checkpoint is rejected.

**Multi-workspace safety:** Each checkpoint is tagged with its workspace path. Two bridge instances running on different workspaces will not share or cross-contaminate each other's checkpoints.

### Reduce duplicate git instructions

Claude Code ships with its own built-in commit/PR guidance. When using the bridge's dedicated git tools (`gitCommit`, `gitPush`, `gitCreatePR`, etc.), you can suppress the duplicate Claude Code instructions by adding to `~/.claude/settings.json`:

```json
{
  "includeGitInstructions": false
}
```

This keeps the prompt clean and ensures Claude uses the bridge's structured git tools rather than raw shell commands.

---

## Connection Hardening

Production-grade reliability:
- WebSocket heartbeat (20s) with automatic reconnect
- Sleep/wake detection via heartbeat gap monitoring
- Circuit breaker with exponential backoff for timeout cascades
- Generation counter preventing stale handler responses
- Extension-required tool filtering when extension disconnects
- 1214 tests (bridge) + 362 extension tests; full WebSocket round-trip integration coverage
- MCP elicitation support (`elicitation: {}` capability) — bridge can send `elicitation/create` mid-task to request structured user input via Claude Code's interactive dialog (Claude Code 2.1.76+)

## Building

```bash
# Bridge
npm run build        # TypeScript compilation
npm run dev          # Development with tsx
npm test             # Run 1214 bridge tests

# Extension
cd vscode-extension
npm run build        # esbuild bundle
npm run package      # Create .vsix
npm test             # Run 362 extension tests
```

## Troubleshooting

### Claude says a tool doesn't exist or tool count seems low

When the VS Code extension is disconnected, tools that require extension access are automatically hidden from Claude's tool list. About 50 tools become unavailable (terminal, LSP, debug, editor state, etc.). Check the "Claude IDE Bridge" output channel in VS Code — if you see a disconnection event, use `Claude IDE Bridge: Reconnect` from the command palette, or reload the window.

### Bridge and extension version mismatch

The extension auto-installs the bridge via npm on first use. If you also have a manually installed version, they may diverge. To check:

```bash
claude-ide-bridge --version          # bridge version
# Compare with the version shown in the extension's output channel on startup
```

To force the extension's managed version:

```bash
# Run the Install / Upgrade command from VS Code's command palette:
# "Claude IDE Bridge: Install / Upgrade Bridge"
# Or manually:
npm install -g claude-ide-bridge@latest
```

Then reload the VS Code window.

### Extension keeps reconnecting (oscillation)

Repeated disconnects / `tools/list` changes usually mean multiple old VSIX versions are installed across VS Code forks (e.g. both VS Code and Cursor). Install the latest extension in every editor and reload each window.

### Remote control: prompt doesn't appear or gets stuck (Claude mobile app)

When using `claude remote-control` from the Claude mobile app, the user prompt sometimes fails to appear in the session or the input appears stuck. This is a known quirk of the remote control connection, not a bridge issue.

**Fix:** Force-quit and relaunch the Claude app. The session reconnects and the prompt reappears.

This tends to happen after the phone has been in the background for a while or after a network change (switching from WiFi to cellular). If you notice messages not sending or the UI not updating, a quick app restart is the fastest fix.

### Remote control: agent is running but not making progress

Occasionally a running agent or tool call hangs — the bridge is active, the extension is connected, but Claude isn't advancing. This usually means the subprocess or agent has stalled internally.

**Fix:** Stop the current process (interrupt the Claude Code session or cancel the running task), then try again. In most cases the task resumes cleanly on the second attempt. If it happens repeatedly on the same prompt, try breaking the task into smaller steps.

### `start-all` launched from inside a Claude Code session

Launching `start-all` from within an active Claude Code session can cause tmux conflicts. Kill the existing tmux server first:

```bash
tmux kill-server
env -u CLAUDECODE claude-ide-bridge start-all --workspace /your/project
```

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for development setup, code style, and how to add new tools.

## Support

If Claude IDE Bridge saves you time, consider [sponsoring the project](https://github.com/sponsors/Oolab-labs).

## License

MIT
