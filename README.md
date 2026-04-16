# Claude IDE Bridge

[![npm version](https://img.shields.io/npm/v/claude-ide-bridge)](https://www.npmjs.com/package/claude-ide-bridge)
[![CI](https://github.com/Oolab-labs/claude-ide-bridge/actions/workflows/ci.yml/badge.svg)](https://github.com/Oolab-labs/claude-ide-bridge/actions/workflows/ci.yml)
[![Docker](https://img.shields.io/badge/docker-ghcr.io%2FOolab--labs%2Fclaude--ide--bridge-blue)](https://github.com/Oolab-labs/claude-ide-bridge/pkgs/container/claude-ide-bridge)
[![License: MIT](https://img.shields.io/npm/l/claude-ide-bridge)](https://opensource.org/licenses/MIT)

**MCP bridge giving Claude Code IDE superpowers: 141 tools for LSP, debugging, git, GitHub, terminals, and more.**

A WebSocket bridge between Claude Code CLI and your VS Code extension. Claude sees what your IDE sees — live diagnostics, go-to-definition, call hierarchies, hover types, breakpoints, debugger state — and can act on it: edit files, run tests, commit, open PRs, all without you copy-pasting anything.

Works locally, over SSH, in Docker, and on a VPS. Extension is optional — headless mode covers git, terminals, GitHub, and LSP via `typescript-language-server`.

```
Claude Code ──── bridge ──── VS Code extension ──── your editor state
```

> **See it work in 5 minutes:** save a broken file, Claude notices, diagnoses, proposes a fix — no prompt typed. [Self-healing quickstart →](./docs/self-healing-quickstart.md)

## Quick Start

**Prerequisites:** [Claude Code CLI](https://claude.ai/code), Node.js ≥ 20

```bash
# 1. Install the bridge
npm install -g claude-ide-bridge

# 2. One-command setup (installs extension, writes CLAUDE.md, registers MCP server)
cd /your/project
claude-ide-bridge init

# 3. Start the bridge
claude-ide-bridge --full --watch

# 4. Open Claude Code — bridge connects automatically
claude --ide
```

> **Updating?** Use `npm install -g claude-ide-bridge@latest` — `npm update -g` may lag the registry cache after a new release.

After `init`, type `/mcp` in Claude Code to confirm the bridge is connected. Type `/ide` to see open files, diagnostics, and editor state.

> **One bridge per workspace.** Each project runs its own bridge instance on its own port. Start a separate `claude-ide-bridge --watch` in each directory.

### Installing the VS Code extension separately

```bash
claude-ide-bridge install-extension
```

Or search **Claude IDE Bridge** in the VS Code / Cursor / Windsurf marketplace.

---

## Tool Categories

| Category | Count | Example tools | Mode |
|---|---|---|---|
| LSP & Code Intelligence | 29 | `goToDefinition`, `findReferences`, `getCallHierarchy`, `getHover`, `explainSymbol` | S |
| Debugging | 6 | `setDebugBreakpoints`, `startDebugging`, `evaluateInDebugger`, `getDebugState` | S |
| Refactoring | 5 | `refactorAnalyze`, `refactorPreview`, `renameSymbol`, `refactorExtractFunction` | S |
| Editor State | 8 | `getDiagnostics`, `getDocumentSymbols`, `getOpenEditors`, `contextBundle`, `watchDiagnostics` | S |
| Git | 12 | `gitAdd`, `gitCommit`, `gitPush`, `getGitStatus`, `getGitDiff`, `gitCheckout`, `gitBlame` | F |
| GitHub | 5 | `githubCreatePR`, `getPRTemplate`, `getGitHotspots` | F |
| Files & Search | 10 | `findFiles`, `getFileTree`, `searchWorkspace`, `searchAndReplace`, `createFile`, `editText` | F |
| Terminal & Shell | 6 | `runInTerminal`, `getTerminalOutput`, `runCommand`, `runVSCodeTask`, `listVSCodeTasks` | F |
| Claude Orchestration | 5 | `runClaudeTask`, `listClaudeTasks`, `getClaudeTaskStatus`, `cancelClaudeTask` | F |
| Quality & Analysis | 11 | `getCodeCoverage`, `auditDependencies`, `detectUnusedCode`, `generateTests`, `getSecurityAdvisories` | F |

**S = slim mode (default) · F = full mode (`--full` flag)**

---

## Slim vs Full Mode

The bridge starts in **slim mode** by default — 56 IDE-exclusive tools covering LSP, debugging, refactoring, and editor state. These are capabilities Claude does not have natively, so slim mode adds signal without duplicating built-in file/shell tools.

Add `--full` to unlock all 141 tools, including git, GitHub, terminal, file tree, and orchestration:

```bash
claude-ide-bridge --full --watch
```

Or set permanently in `claude-ide-bridge.config.json`:

```json
{ "fullMode": true }
```

**Use `--full` when:**
- Running headless or in CI and you want structured git/GitHub output
- You want `runTests` (framework detection, structured pass/fail) instead of `npm test`
- You need `githubCreatePR` with PR template support
- You want Claude managing the whole workflow end-to-end (edit → test → commit → PR)

---

## Usage Examples

### Find every caller of a function
```
"Show me everything that calls processPayment()"
```
Claude runs `getCallHierarchy` — returns the full incoming call tree with file paths and line numbers, no grep required.

### Fix all type errors in the workspace
```
"Fix the TypeScript errors in src/api/"
```
Claude calls `getDiagnostics` to get live compiler errors, then `editText` to patch each one. No build step needed — diagnostics are live from the language server.

### Create a PR from the current branch
```
"Push my branch and open a PR against main"
```
Claude calls `gitPush`, then `githubCreatePR` — picks up your repo's PR template automatically and pre-fills it from recent commits.

### Set a breakpoint and inspect a variable
```
"Break on line 42 of auth.ts and tell me what token contains"
```
Claude calls `setDebugBreakpoints`, `startDebugging`, then `evaluateInDebugger` — real debugger evaluation, not console.log guessing.

### Refactor a symbol safely
```
"Rename UserService to AuthService everywhere"
```
Claude calls `refactorAnalyze` (checks blast radius and risk), `refactorPreview` (shows every edit before touching a file), then `renameSymbol` — language-server rename, not find-and-replace.

---

## Deployment Options

### Local (VS Code / Cursor / Windsurf)
Standard setup. Extension connects automatically. Full LSP, debugger, and editor state available.

### Remote SSH
VS Code Remote-SSH and Cursor SSH load the extension on the VPS side (`extensionKind: ["workspace"]`). Start the bridge on the remote machine. All 141 tools work over SSH.

```bash
# On the remote machine
claude-ide-bridge --full --watch --bind 0.0.0.0
```

### VPS + systemd
Persistent bridge with automatic restarts, fixed auth token, and optional OAuth 2.0 for remote MCP clients (claude.ai, Codex CLI).

```bash
# Full provisioning
bash deploy/bootstrap-new-vps.sh

# Or just the service
bash deploy/install-vps-service.sh
```

See [deploy/README.md](deploy/README.md) and [docs/remote-access.md](docs/remote-access.md).

### Docker
```bash
docker run -p 3284:3284 ghcr.io/oolab-labs/claude-ide-bridge:latest --full --bind 0.0.0.0
```

Or with Compose:
```bash
docker compose up
```

Headless image includes `typescript-language-server` and `universal-ctags` for LSP and symbol search without VS Code. See [documents/headless-quickstart.md](documents/headless-quickstart.md).

### Launch tasks from a terminal (headless parity)

The sidebar's quick-task buttons also work from the CLI — same context-gathering, same prompt-building, same dispatch path:

```bash
# 7 presets: fixErrors · refactorFile · addTests · explainCode · optimizePerf · runTests · resumeLastCancelled
claude-ide-bridge quick-task fix-errors
claude-ide-bridge quick-task add-tests --json

# free-form description (Claude gathers its own context)
claude-ide-bridge start-task "Refactor the auth module for clarity, keep behaviour identical"

# resume prior session from handoff note
claude-ide-bridge continue-handoff
```

Requires `--claude-driver subprocess` on the running bridge. All three subcommands accept `--json`, `--port`, `--source`. Enforces a 5s bridge-global cooldown per preset (shared with the sidebar).

---

## Automation Hooks

Event-driven hooks that trigger Claude tasks automatically — no polling, no manual invocation.

```json
{
  "hooks": [
    {
      "event": "onDiagnosticsError",
      "prompt": "Fix the type error in {{file}}: {{diagnostics}}",
      "cooldownMs": 30000
    },
    {
      "event": "onFileSave",
      "patterns": ["src/**/*.ts"],
      "prompt": "Run tests for {{file}} and fix any failures"
    },
    {
      "event": "onGitCommit",
      "prompt": "Review commit {{hash}}: {{message}}"
    }
  ]
}
```

Start with:
```bash
claude-ide-bridge --full --watch --automation --automation-policy ./policy.json --claude-driver subprocess
```

**18 hook events:** `onFileSave`, `onFileChanged`, `onDiagnosticsError`, `onDiagnosticsCleared`, `onGitCommit`, `onGitPush`, `onGitPull`, `onBranchCheckout`, `onPullRequest`, `onTestRun`, `onTestPassAfterFailure`, `onPostCompact`, `onInstructionsLoaded`, `onTaskCreated`, `onTaskSuccess`, `onPermissionDenied`, `onCwdChanged`, `onDebugSessionEnd`

All hooks support `cooldownMs` (min 5s), `promptName`/`promptArgs` for named prompts, and `when` conditions (`minDiagnosticCount`, `testRunnerLastStatus`). See [docs/automation.md](docs/automation.md).

---

## Plugin System

Extend the bridge with custom MCP tools without forking. Plugins load in-process alongside built-in tools and support hot reload.

```bash
# Scaffold a new plugin
claude-ide-bridge gen-plugin-stub ./my-plugin --name "org/my-plugin" --prefix "myPrefix"

# Load it
claude-ide-bridge --full --watch --plugin ./my-plugin --plugin-watch
```

Publish to npm with keyword `claude-ide-bridge-plugin` — users install by package name:

```bash
claude-ide-bridge --plugin claude-ide-bridge-my-plugin
```

See [documents/plugin-authoring.md](documents/plugin-authoring.md) for the full manifest schema and entrypoint API.

---

## Companion Marketplace

Install curated companion MCP servers directly into your Claude Desktop config:

```bash
claude-ide-bridge marketplace list
claude-ide-bridge marketplace search memory
claude-ide-bridge install claude-mem
```

`install` merges the companion into `mcpServers` in your Claude Desktop config atomically and idempotently — no manual JSON editing.

---

## CLI Reference

| Command | What it does |
|---|---|
| `claude-ide-bridge init` | One-command setup: install extension + write CLAUDE.md + register MCP server |
| `claude-ide-bridge --watch` | Start bridge with auto-restart on crash (2s → 30s backoff) |
| `claude-ide-bridge --full` | Enable all 141 tools (default: 56 slim tools) |
| `claude-ide-bridge install-extension` | Install companion VS Code extension |
| `claude-ide-bridge gen-claude-md --write` | Add bridge section to existing CLAUDE.md |
| `claude-ide-bridge print-token` | Print auth token from active lock file |
| `claude-ide-bridge gen-plugin-stub <dir>` | Scaffold a new plugin |
| `claude-ide-bridge marketplace list` | List available companion servers |
| `claude-ide-bridge install <companion>` | Install companion into Claude Desktop config |
| `claude-ide-bridge notify <Event>` | Post a hook event to a running bridge (for CC hook wiring) |
| `claude-ide-bridge quick-task <preset>` | Launch a context-aware Claude task from a preset (headless parity with the sidebar) |
| `claude-ide-bridge start-task "<description>"` | Enqueue a free-form Claude task with workspace context |
| `claude-ide-bridge continue-handoff` | Resume prior session using the stored handoff note |
| `claude-ide-bridge start-all` | Launch tmux session with bridge + extension watcher |

**Key flags:**

| Flag | Default | Description |
|---|---|---|
| `--full` | off | Enable all tools |
| `--watch` | off | Auto-restart on crash |
| `--bind <host>` | `127.0.0.1` | Bind address (`0.0.0.0` for remote access) |
| `--port <n>` | auto | Port (auto-detected from lock files) |
| `--fixed-token <uuid>` | — | Stable auth token across restarts |
| `--automation` | off | Enable automation hooks |
| `--automation-policy <path>` | — | Path to policy JSON |
| `--claude-driver subprocess` | none | Enable Claude subprocess orchestration |
| `--plugin <path>` | — | Load a plugin (repeatable) |
| `--plugin-watch` | off | Hot-reload plugins on change |
| `--issuer-url <url>` | — | Activate OAuth 2.0 mode |
| `--cors-origin <origin>` | — | Add CORS origin (repeatable) |
| `--vps` | off | Expand command allowlist for VPS use |
| `--grace-period <ms>` | 120000 | Session preservation window across disconnects |

---

## Documentation

| File | Description |
|---|---|
| [ARCHITECTURE.md](ARCHITECTURE.md) | System topology, request lifecycle, component map, design decisions |
| [documents/platform-docs.md](documents/platform-docs.md) | Full tool reference — all 141 tools with parameters and examples |
| [documents/prompts-reference.md](documents/prompts-reference.md) | All MCP prompts (31 prompts, 12 plugin skills, 4 subagents) |
| [docs/automation.md](docs/automation.md) | Automation hooks reference — all 18 events, policy schema, condition filters |
| [docs/troubleshooting.md](docs/troubleshooting.md) | Diagnostics, common errors, and fixes |
| [docs/remote-access.md](docs/remote-access.md) | VPS setup, OAuth 2.0, nginx/Caddy reverse proxy |
| [documents/headless-quickstart.md](documents/headless-quickstart.md) | CI, Docker, server use without VS Code |
| [docs/cowork-workflow.md](docs/cowork-workflow.md) | Computer-use (Cowork) workflow and git worktree setup |
| [docs/multi-ide.md](docs/multi-ide.md) | Multiple sessions and parallel editor instances |
| [docs/migration.md](docs/migration.md) | Upgrade guide between major versions |
| [documents/plugin-authoring.md](documents/plugin-authoring.md) | Plugin manifest schema, entrypoint API, distribution |
| [documents/styleguide.md](documents/styleguide.md) | Code conventions, tool factory pattern, output formats |
| [docs/adr/](docs/adr/) | Architecture Decision Records |
| [CONTRIBUTING.md](CONTRIBUTING.md) | Contributor guide, build setup, test requirements |
| [deploy/README.md](deploy/README.md) | VPS provisioning and systemd service scripts |

---

## Requirements

- **Node.js ≥ 20** (bridge)
- **VS Code, Cursor, or Windsurf** — optional. Headless mode covers git, terminals, GitHub, and LSP via `typescript-language-server`. Extension required for debugger, editor decorations, and live editor state.
- **Claude Code CLI** — for local use. Remote MCP clients (claude.ai, Codex CLI) work via Streamable HTTP transport with OAuth 2.0.

---

## License

MIT — see [LICENSE](LICENSE).

---

## Contributing

Bug reports and PRs welcome. See [CONTRIBUTING.md](CONTRIBUTING.md).

When reporting a bug, include the output of:
```bash
claude-ide-bridge print-token   # confirms bridge is running
# then in Claude: call getBridgeStatus
```

Per the project's bug fix protocol: a reproducing test must exist before a fix lands.
