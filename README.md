# Claude IDE Bridge

[![npm version](https://img.shields.io/npm/v/claude-ide-bridge)](https://www.npmjs.com/package/claude-ide-bridge)
[![CI](https://github.com/Oolab-labs/claude-ide-bridge/actions/workflows/ci.yml/badge.svg)](https://github.com/Oolab-labs/claude-ide-bridge/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

**Claude Code, but with your IDE's eyes.**

A WebSocket bridge that connects Claude Code to VS Code (and Windsurf, Cursor) so Claude can see what your IDE sees: live diagnostics, go-to-definition, find references, hover types, open files, breakpoints, debugger state. Not file access — actual IDE context, the same signals a developer reads while working.

Install the companion extension, start the bridge, open Claude. That's it. Claude can now navigate your codebase the way you do, run tests, check diagnostics, commit, and create PRs — without you copy-pasting anything.

```
Claude Code ──── bridge ──── VS Code extension ──── your editor state
```

**Works from your phone.** SSH into your dev machine, send a message, watch Claude fix bugs and run tests on your home machine while you're away.

## Pick your path

| I want to… | Go to |
|---|---|
| Get started (5 min setup) | [Quick Start](#quick-start) |
| Understand what tools are available | [Platform Docs](documents/platform-docs.md) |
| Run two IDEs in parallel | [Multi-IDE Orchestrator](#multi-ide-orchestrator) |
| Access from remote / phone | [Remote Access](docs/remote-access.md) |
| Deploy to a VPS | [Deploy](deploy/README.md) |
| Write a plugin | [Plugin Authoring](documents/plugin-authoring.md) |
| Use with Claude Desktop / Dispatch | [Session Continuity](#session-continuity) |
| Use with claude.ai web | [Custom Connector](#use-with-claudeai-web) |

## Quick Start

**Prerequisites:** [Claude Code CLI](https://claude.ai/code), Node.js ≥ 20

```bash
npm install -g claude-ide-bridge
cd /your/project
claude-ide-bridge init
```

`init` does four things:
1. Installs the companion VS Code/Windsurf/Cursor extension
2. Appends a `## Claude IDE Bridge` section to your `CLAUDE.md` (creating it if needed)
3. Writes `.claude/rules/bridge-tools.md` — a rules file that directs Claude to call MCP tools instead of shell equivalents (`runTests` instead of `npm test`, `getDiagnostics` instead of `tsc`, `gitCommit` instead of `git commit`, `searchWorkspace` instead of `grep`)
4. Registers the bridge as a global MCP server in `~/.claude.json` so bridge tools appear in **every** `claude` session, any directory

The rules file is loaded automatically via `@import` in `CLAUDE.md` on every session. No extra flags or configuration needed.

**Then start the bridge and open Claude:**

```bash
claude-ide-bridge --watch   # terminal 1 — keeps running, auto-restarts on crash
claude --ide                # terminal 2 — Claude Code with IDE tools active
```

> **`--watch`** restarts the bridge automatically if it crashes, with exponential backoff (2s → 30s). Safe for long-running sessions.

Type `/mcp` in Claude to confirm the server is connected, then `/ide` to see open files, diagnostics, and editor state.

> **One bridge per workspace.** Each project needs its own bridge instance on its own port. If you work across multiple repos, start a separate `claude-ide-bridge --watch` in each directory.

> **Why `~/.claude.json` and not `.mcp.json`?** When VS Code, Windsurf, or Cursor launches Claude Code, it injects `--mcp-config` which overrides any project `.mcp.json`. Only `~/.claude.json` is loaded in every session regardless of how Claude Code is started. `init` writes there by design — you don't need to touch `.mcp.json`.

**Adding the bridge to an existing project** (without re-running full `init`):

```bash
claude-ide-bridge gen-claude-md --write
```

This appends the bridge section to your existing `CLAUDE.md` and writes `.claude/rules/bridge-tools.md`. Run it once per project.

**Tools not showing up?** See the [troubleshooting guide](docs/troubleshooting.md).

## Slim Mode vs Full Mode

By default, the bridge starts in **slim mode** — 50 IDE-exclusive tools that Claude can't replicate with its built-in `Read`/`Write`/`Bash` tools: LSP intelligence, debugger, editor decorations, diagnostics, refactoring, impact analysis, and editor state. This is the right default for most workflows because Claude already has file editing and shell access built in.

If you need Claude to use the bridge's **git, terminal, file ops, HTTP client, or GitHub** tools instead of its built-in equivalents, start in full mode:

```bash
claude-ide-bridge --watch --full   # all 136+ tools
```

Or set it permanently in your config file (`claude-ide-bridge.config.json`):

```json
{
  "fullMode": true
}
```

**When to use `--full`:**
- You're running headless/CI and want structured git/GitHub tools instead of raw `git` commands
- You want Claude to use `runTests` (with framework detection and structured output) instead of `npm test`
- You need `sendHttpRequest` with SSRF protection, or `githubCreatePR` with template support
- You're using automation hooks (`--automation`) that need terminal or git tools

**When slim mode is enough (most users):**
- You're working in VS Code/Cursor/Windsurf and want Claude to see your IDE state
- Claude's built-in `Read`/`Write`/`Bash` tools handle file ops and git fine
- You want a smaller tool list for faster responses and less token overhead

See [MCP Tools](#mcp-tools) below for the full tool breakdown by category.

## What Can Claude Do?

With the bridge connected, try these prompts in Claude:

- **"Explain the function at src/server.ts:140"** — uses `explainSymbol` to get type info, docs, callers, and references in one call
- **"Preview what renaming `handleRequest` to `processRequest` would change"** — uses `refactorPreview` to show affected files without applying
- **"Review this file and highlight issues inline"** — Claude uses `setEditorDecorations` to annotate your editor with findings
- **"Fix all errors in open files"** — uses `getDiagnostics` to find errors, then `editText` to fix them
- **"Show me who calls this function"** — uses `getCallHierarchy` to trace callers and callees
- **"Run the tests and fix failures"** — uses `runTests` or `runCommand` to execute tests, reads output, and applies fixes
- **"Create a PR for these changes"** — uses `getGitDiff`, `gitCommit`, and `githubCreatePR` to commit and open a pull request

## Multi-IDE Orchestrator

> **When to use this:** Large projects (50k+ lines) where a single Claude session runs out of context mid-task, or where you're running genuinely parallel workstreams — one agent implementing while another reviews, or one exploring the backend while another works on the frontend. For most projects, a single bridge is sufficient.

Run two bridges simultaneously — one per IDE window — with a meta-orchestrator routing between them. Each agent gets a completely independent context (separate LSP cache, open files, terminal history), so their work doesn't interfere.

```
Claude Code
    │
Meta-Orchestrator (port 4746)
    ├── Bridge A (port 55000) — e.g. backend work, active changes
    └── Bridge B (port 55001) — e.g. frontend work, or clean reviewer
```

**Setup (each IDE needs a fixed port):**

In each VS Code/Windsurf workspace settings, set `claudeIdeBridge.port` to `55000` and `55001` respectively. Then:

```bash
claude-ide-bridge orchestrator --port 4746
claude --ide   # auto-discovers orchestrator, exposes both workspaces' tools
```

Use `switchWorkspace ws1` / `switchWorkspace ws2` in Claude to pin to a specific IDE. Tools from both are available; conflicting names get a `__<IDE>_<port>` suffix.

**Concrete use cases where it pays off:**
- **Large monorepo**: database layer in one IDE, API layer in another — each agent stays focused without context bleed
- **Implement + review**: one agent writes, the other reviews the diff with fresh eyes (no anchoring bias)
- **Self-hosting dev loop**: modify the bridge itself in IDE A, validate through IDE B without downtime

**Where it's not worth the overhead:** projects under ~50k lines, tasks that need to touch both workspaces frequently (handoff cost dominates), or anything a single `runClaudeTask` subprocess handles adequately.

See [docs/multi-ide-review.md](docs/multi-ide-review.md) for the staged review workflow.

## Documentation

> **These guides are essential for setup and deployment** — not optional reading. Each covers a specific scenario you'll encounter when running the bridge beyond localhost.

| Guide | What it covers |
|-------|----------------|
| **[Troubleshooting](docs/troubleshooting.md)** | Tools not showing up, wrong config file, WSL/Windows PATH, port conflicts |
| **[Remote Access](docs/remote-access.md)** | Production reverse proxy setup (Caddy/nginx), TLS, Streamable HTTP transport |
| **[SSH Resilience](docs/ssh-resilience.md)** | Surviving SSH drops, tmux strategies, phone-to-VPS workflows |
| **[IP Allowlist](docs/ip-allowlist.md)** | Firewall rules, network access control for remote bridge instances |
| **[Worktree Isolation](docs/worktree-isolation.md)** | How git worktrees interact with the bridge, safe concurrent editing |
| **[Privacy Policy](docs/privacy-policy.md)** | What data the bridge handles, stores, and never transmits |
| **[Demo Setup](docs/demo-setup.md)** | Standing up a persistent demo instance for review/testing |
| **[Architecture Decisions](docs/adr/)** | ADRs for version numbers, reconnect guards, lock files, error model, session eviction |
| **[Release Checklist](docs/release-checklist.md)** | Pre-release gate: hardcoded count audit, doc completeness, publish steps |

**Reference docs** (in [`documents/`](documents/)):

| Doc | What it covers |
|-----|----------------|
| **[Platform Docs](documents/platform-docs.md)** | Complete tool reference (136+ tools), parameters, examples |
| **[Data Reference](documents/data-reference.md)** | Data flows, state management, protocol details |
| **[Plugin Authoring](documents/plugin-authoring.md)** | Writing custom plugins — manifest schema, entrypoint API |
| **[Use Cases](documents/use-cases.md)** | Real-world workflows and scenarios |
| **[Roadmap](documents/roadmap.md)** | Planned features and development direction |

## Session Continuity

The bridge persists state across restarts and context switches (CLI ↔ Desktop ↔ Cowork).

### Handoff Notes
Use `setHandoffNote` to save context before switching sessions. Notes are **workspace-scoped** — switching workspaces won't overwrite each other's context. `getHandoffNote` retrieves the most recent note for your current workspace.

The bridge also auto-snapshots a basic handoff note whenever a new session connects and the existing note is stale (>5 minutes old).

### Checkpoint Restore
When the bridge restarts within 5 minutes of the previous run, it automatically restores the list of open files from the last session checkpoint. The first connecting client receives a notification:
> `Session restored from checkpoint: N file(s) tracked (checkpoint was Xs old)`

### CLI → Desktop → Cowork Workflow
1. **CLI session:** work normally; bridge tracks opened files
2. **Switching to Desktop:** call `setHandoffNote` first, or run `/mcp__bridge__cowork` to auto-collect context
3. **Cowork:** MCP tools are NOT available inside Cowork — the handoff note is the bridge. Always run `/mcp__bridge__cowork` in regular chat before opening Cowork (Cmd+2).

> **Cowork sessions (Claude Desktop computer-use):** MCP bridge tools are NOT available inside Cowork. Run `/mcp__bridge__cowork` in a regular Desktop chat first to capture context, then open Cowork. Cowork also operates in an isolated git worktree — files won't appear in your main `git status` until merged.

## Full Session Launcher (`start-all`)

> **Not the same as [Multi-IDE Orchestrator](#multi-ide-orchestrator).** The Multi-IDE Orchestrator runs two bridge instances for two parallel IDE windows. `start-all` is a convenience launcher that runs a single bridge instance alongside Claude Code and remote control in a tmux session.

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

The bridge ships as a **Claude Code plugin** with 9 skills, 3 subagents, and 16 hook events — available on the [Claude Code plugin directory](https://claude.com/plugins):

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
| `PreToolUse` | Resolves relative path args to absolute before bridge tools execute |
| `PostToolUse` on Edit/Write | Reminds Claude to check diagnostics after file edits |
| `SessionStart` | Reports bridge status, connection, and tool count |
| `InstructionsLoaded` | Injects live bridge status each time CLAUDE.md loads |
| `Elicitation` | Pre-fills file/path/uri fields using the active editor |
| `ElicitationResult` | Logs user responses (or cancellations) to MCP elicitation dialogs |
| `PostCompact` | Re-injects bridge status after Claude compacts context |
| `WorktreeCreate` | Reports bridge ↔ worktree relationship; warns about LSP limitations |
| `WorktreeRemove` | Warns that IDE state may be stale after worktree removal |
| `SubagentStart` | Verifies bridge is alive before IDE subagents run |
| `SubagentStop` | Surfaces subagent final response summary for parent agent awareness |
| `TeammateIdle` | Reports bridge health when a team agent finishes and awaits coordination |
| `TaskCompleted` | Logs task completion summary and confirms bridge availability |
| `ConfigChange` | Warns if changed config files require a bridge restart |
| `Stop` | Logs session end and surfaces final response for automated workflows |
| `StopFailure` | Logs API errors that ended the turn; checks bridge health |

## MCP Tools

The bridge exposes tools in two modes:

- **Slim mode (default)** — 50 IDE-exclusive tools. Only tools that require a live VS Code extension and have no native Claude equivalent. This is what you get with `claude-ide-bridge --watch`.
- **Full mode (`--full`)** — all 136+ tools, adding git, terminal, file ops, HTTP, and GitHub. Use this for large projects or workflows that rely on those integrations.

### Slim mode — 50 IDE tools (default)

| Category | Tools |
|----------|-------|
| LSP / Code Intelligence | `getDiagnostics` · `watchDiagnostics` · `goToDefinition` · `findReferences` · `getHover` · `getCodeActions` · `applyCodeAction` · `renameSymbol` · `searchWorkspaceSymbols` · `getDocumentSymbols` · `getCallHierarchy` · `getSemanticTokens` · `getCodeLens` · `getDocumentLinks` · `batchGetHover` · `batchGoToDefinition` |
| Impact Analysis | `getChangeImpact` · `getImportedSignatures` |
| Refactor & Navigation | `refactorAnalyze` · `refactorPreview` · `refactorExtractFunction` · `prepareRename` · `selectionRanges` · `foldingRanges` · `signatureHelp` · `explainSymbol` · `getImportTree` |
| Editor Decorations | `setEditorDecorations` · `clearEditorDecorations` |
| Debugger | `startDebugging` · `stopDebugging` · `setDebugBreakpoints` · `evaluateInDebugger` · `getDebugState` |
| Editor State | `getOpenEditors` · `getCurrentSelection` · `getLatestSelection` · `checkDocumentDirty` · `saveDocument` · `openFile` · `closeTab` · `captureScreenshot` |
| VS Code | `executeVSCodeCommand` |
| Bridge | `getBridgeStatus` · `getToolCapabilities` |

### Full mode (`--full`) adds

| Category | Count | Tools (sample) |
|----------|------:|----------------|
| Git | 16 | `getGitStatus` · `getGitDiff` · `gitCommit` · `gitPush` · `gitBlame` · … |
| Terminal | 8 | `runCommand` · `createTerminal` · `sendTerminalCommand` · … |
| File ops | 8 | `createFile` · `editText` · `searchWorkspace` · `getFileTree` · … |
| GitHub | 13 | `githubCreatePR` · `githubListIssues` · `githubPostPRReview` · … |
| HTTP | 2 | `sendHttpRequest` · `parseHttpFile` |
| Code analysis | 9 | `auditDependencies` · `detectUnusedCode` · `getSecurityAdvisories` · … |
| Code quality | 3 | `fixAllLintErrors` · `formatDocument` · `organizeImports` |
| Diagnostics+ | 2 | `runTests` · `getCodeCoverage` |
| Plans | 5 | `createPlan` · `updatePlan` · `getPlan` · … |
| Clipboard | 2 | `readClipboard` · `writeClipboard` |
| LSP extras | 4 | `getHoverAtCursor` · `getTypeSignature` · `getInlayHints` · `getTypeHierarchy` |
| More editor | 2 | `openDiff` · `getBufferContent` |
| Session | 2 | `getHandoffNote` · `setHandoffNote` |

## MCP Prompts (Slash Commands)

The bridge exposes 27 built-in slash commands via the MCP `prompts/list` + `prompts/get` protocol. These appear as `/mcp__bridge__<name>` in any MCP client that supports prompts.

**General / Dispatch**

| Prompt | Argument | Description |
|--------|----------|-------------|
| `/mcp__bridge__review-file` | `file` (required) | Code review for a specific file using current diagnostics |
| `/mcp__bridge__explain-diagnostics` | `file` (required) | Explain and suggest fixes for all diagnostics in a file |
| `/mcp__bridge__generate-tests` | `file` (required) | Generate a test scaffold for the exported symbols in a file |
| `/mcp__bridge__debug-context` | _(none)_ | Snapshot current debug state, open editors, and diagnostics |
| `/mcp__bridge__git-review` | `base` (optional, default: `main`) | Review all changes since a git base branch |
| `/mcp__bridge__cowork` | `task` (optional) | Gather full IDE context and propose a Cowork action plan — run this **before** opening a Cowork session |
| `/mcp__bridge__set-effort` | `level` (optional: `low`/`medium`/`high`, default: `medium`) | Prepend an effort-level instruction to tune Claude's thoroughness for the next task |
| `/mcp__bridge__project-status` | _(none)_ | Quick project health: git status + diagnostics + test summary (Dispatch) |
| `/mcp__bridge__quick-tests` | `filter` (optional) | Run tests and return concise pass/fail summary (Dispatch) |
| `/mcp__bridge__quick-review` | _(none)_ | Review uncommitted changes with diff summary and diagnostics (Dispatch) |
| `/mcp__bridge__build-check` | _(none)_ | Check if the project builds successfully (Dispatch) |
| `/mcp__bridge__recent-activity` | `count` (optional, default: `10`) | Recent git log and uncommitted changes (Dispatch) |
| `/mcp__bridge__team-status` | _(none)_ | Workspace state, active tasks, and recent activity for team leads (Agent Teams) |
| `/mcp__bridge__health-check` | _(none)_ | Comprehensive project health: tests, diagnostics, security (Scheduled Tasks) |
| `/mcp__bridge__orient-project` | _(none)_ | Architecture overview from key docs and CLAUDE.md |

**LSP Intelligence**

| Prompt | Arguments | Description |
|--------|-----------|-------------|
| `/mcp__bridge__find-callers` | `symbol` (required) | List all callers of a symbol via call hierarchy + references |
| `/mcp__bridge__blast-radius` | `file`, `line`, `column` (all required) | Compute change impact at a position — risk badge + reference counts |
| `/mcp__bridge__why-error` | `file` (required), `line` (optional) | Explain a diagnostic in plain English with type context |
| `/mcp__bridge__unused-in` | `file` (required) | Find dead exports and unused code in a file |
| `/mcp__bridge__trace-to` | `symbol` (required) | Trace outgoing call chain from a symbol with type signatures |
| `/mcp__bridge__imports-of` | `symbol` (required) | List every file that imports a symbol, with reference counts |
| `/mcp__bridge__circular-deps` | _(none)_ | Detect circular import cycles in the workspace |
| `/mcp__bridge__refactor-preview` | `file`, `line`, `column`, `newName` (all required) | Preview rename edits and blast-radius risk before committing |
| `/mcp__bridge__module-exports` | `file` (required) | List a file's exported symbols with type signatures |
| `/mcp__bridge__type-of` | `file`, `line`, `column` (all required) | Get the type signature at a position (no documentation) |
| `/mcp__bridge__deprecations` | _(none)_ | Find `@deprecated` APIs workspace-wide and count their callers |
| `/mcp__bridge__coverage-gap` | `file` (required) | List untested functions by correlating coverage data with document symbols |

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
  "onFileChanged": {
    "enabled": true,
    "patterns": ["**/*.ts"],
    "prompt": "A file was edited: {{file}}. Run getDiagnostics to check for new errors.",
    "cooldownMs": 15000
  },
  "onCwdChanged": {
    "enabled": true,
    "prompt": "Working directory changed to {{cwd}}. Call getBridgeStatus and getOpenEditors to orient.",
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
  },
  "onTestRun": {
    "enabled": true,
    "onFailureOnly": true,
    "prompt": "Tests failed ({{failed}}/{{total}}). Fix the failures:\n{{failures}}",
    "cooldownMs": 15000
  },
  "onGitCommit": {
    "enabled": true,
    "prompt": "Committed {{hash}} on {{branch}}: {{message}}\nFiles changed: {{files}}",
    "cooldownMs": 5000
  },
  "onGitPush": {
    "enabled": true,
    "prompt": "Pushed {{branch}} to {{remote}} ({{hash}}). Run getGitLog to confirm.",
    "cooldownMs": 5000
  },
  "onBranchCheckout": {
    "enabled": true,
    "prompt": "Switched to branch {{branch}} (from {{previousBranch}}). Call getDiagnostics to check state.",
    "cooldownMs": 5000
  },
  "onPullRequest": {
    "enabled": true,
    "prompt": "PR #{{number}} opened: {{title}} ({{url}}). Run getDiagnostics on changed files.",
    "cooldownMs": 5000
  },
  "onDiagnosticsCleared": {
    "enabled": true,
    "prompt": "All errors cleared in {{file}}. Run the tests for that file to confirm the fix is complete.",
    "cooldownMs": 10000
  },
  "onTaskCreated": {
    "enabled": false,
    "prompt": "A new task was created ({{taskId}}). Call getClaudeTaskStatus to monitor progress.",
    "cooldownMs": 5000
  },
  "onTaskSuccess": {
    "enabled": false,
    "prompt": "Task {{taskId}} succeeded. Review the output and check for follow-up actions:\n\n{{output}}",
    "cooldownMs": 5000
  },
  "onPermissionDenied": {
    "enabled": false,
    "prompt": "The tool '{{tool}}' was blocked: {{reason}}. Call getBridgeStatus to check bridge health.",
    "cooldownMs": 15000
  }
}
```

When automation is active, VS Code save/change events, diagnostic errors, and Claude Code hook events automatically enqueue Claude tasks. Output streams to the "Claude IDE Bridge" output channel in real time.

**Policy triggers:**

| Trigger | When it fires | Key fields |
|---------|--------------|------------|
| `onDiagnosticsError` | VS Code reports new errors/warnings for a file | `enabled`, `minSeverity` (`error`/`warning`), `prompt` (supports `{{file}}` and `{{diagnostics}}`), `cooldownMs` |
| `onFileSave` | A file matching `patterns` is explicitly saved (Ctrl+S) | `enabled`, `patterns` (minimatch globs), `prompt` (supports `{{file}}`), `cooldownMs` |
| `onFileChanged` | Any buffer edit on a matching file (unsaved changes, external writes) — CC 2.1.83+ | `enabled`, `patterns` (minimatch globs), `prompt` (supports `{{file}}`), `cooldownMs` |
| `onCwdChanged` | Claude Code's working directory changes — CC 2.1.83+; call via `notifyCwdChanged` tool from a CC `CwdChanged` hook | `enabled`, `prompt` (supports `{{cwd}}`), `cooldownMs` |
| `onPostCompact` | Claude compacts its context (Claude Code 2.1.76+) | `enabled`, `prompt`, `cooldownMs` |
| `onInstructionsLoaded` | Claude loads CLAUDE.md at session start (Claude Code 2.1.76+) | `enabled`, `prompt` |
| `onTestRun` | `runTests` completes | `enabled`, `onFailureOnly` (bool, default `true`), `prompt` (supports `{{runner}}`, `{{failed}}`, `{{passed}}`, `{{total}}`, `{{failures}}`), `cooldownMs` |
| `onGitCommit` | `gitCommit` tool succeeds | `enabled`, `prompt` (supports `{{hash}}`, `{{branch}}`, `{{message}}`, `{{count}}`, `{{files}}`), `cooldownMs` |
| `onGitPush` | `gitPush` tool succeeds | `enabled`, `prompt` (supports `{{remote}}`, `{{branch}}`, `{{hash}}`), `cooldownMs` |
| `onBranchCheckout` | Git branch created or switched (via `gitCheckout` tool) | `enabled`, `prompt` (supports `{{branch}}`, `{{previousBranch}}`, `{{created}}`), `cooldownMs` |
| `onPullRequest` | PR event occurs (via `githubCreatePR` or bridge PR tools) | `enabled`, `prompt` (supports `{{url}}`, `{{number}}`, `{{title}}`, `{{branch}}`), `cooldownMs` |
| `onDiagnosticsCleared` | File's error/warning count drops from non-zero to zero | `enabled`, `prompt` (supports `{{file}}`), `cooldownMs` |
| `onTaskCreated` | A Claude Code `TaskCreated` hook fires (CC 2.1.84+) | `enabled`, `prompt` (supports `{{taskId}}`, `{{prompt}}`), `cooldownMs` |
| `onTaskSuccess` | An orchestrator task completes successfully | `enabled`, `prompt` (supports `{{taskId}}`, `{{output}}`), `cooldownMs` |
| `onPermissionDenied` | A Claude Code `PermissionDenied` hook fires (CC 2.1.89+) | `enabled`, `prompt` (supports `{{tool}}`, `{{reason}}`), `cooldownMs` |

> **Every hook prompt is prefixed with `@@ HOOK: <name> | file: <path> | ts: <iso> @@`** before reaching the orchestrator. This lets Claude identify which hook triggered a task and correlate it with IDE context without needing to parse the prompt body.

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

Connect your local VS Code, Cursor, or Windsurf to a VPS via Remote-SSH. The bridge extension runs in the remote extension host automatically — no extra setup. LSP, debugger, terminals, and all editor-state tools work normally because the extension and bridge run together on the server.

> **Windsurf SSH tip:** Windsurf with an active SSH session counts as Remote-SSH — the extension loads on the VPS side and connects to the bridge. Confirm with `curl .../health` and look for `"extension": true`.

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

> **VPS filesystem scope:** A bridge running on a VPS serves **that VPS's filesystem only**. File tools (`readFile`, `writeFile`, `searchWorkspace`, etc.) read and write files on the VPS — not on your local Mac. If you want Claude to work on files on your local machine, run the bridge locally (or use VS Code Remote-SSH, which runs both the extension and bridge on the VPS alongside your remote files).

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

> **Tool availability:** Without the VS Code extension connected, ~50 tools (debugger, LSP intelligence, editor state, decorations, refactoring) are unavailable. Claude Desktop works best alongside the running extension. You can verify connectivity by asking *"What tools do you have available?"* — the response will list what's active.

> **Debugging the shim:** If the connection seems stuck, the shim logs to stderr. In Claude Desktop, check **Settings → Developer → MCP Logs** to see shim output. Common cause: bridge not running — start it with `claude-ide-bridge --watch` first.

**Try it:** Open Claude Desktop and ask *"What diagnostics are in my workspace?"* or *"What files are open in my IDE?"*

You can also use the general config generator:

```bash
bash scripts/gen-mcp-config.sh claude-desktop --write
```

Config location:
- **macOS**: `~/Library/Application Support/Claude/claude_desktop_config.json`
- **Windows**: `%APPDATA%\Claude\claude_desktop_config.json`

## Dispatch (Mobile Remote Control)

[Dispatch](https://docs.anthropic.com) is a Claude Desktop feature that lets you send instructions from your phone to your desktop Claude session. Combined with the bridge, you can check on your project, run tests, and review changes — all from a phone message.

### How it works

```
Your Phone (Claude App)
    │
    ▼  terse instruction
Claude Desktop (main conversation)
    │
    ▼  MCP tool calls
Bridge Server ──► IDE Extension ──► Your Code
    │
    ▼  results
Claude Desktop
    │
    ▼  concise summary
Your Phone
```

Dispatch messages land in Claude Desktop's **main conversation**, which has full MCP bridge access. Claude calls the bridge tools, gathers results, and sends a summary back to your phone.

> **Not Cowork:** Dispatch routes through the main conversation, not a Cowork session. All 136+ bridge tools are available. The Cowork tool-access limitation does not apply here.

### Setup

1. **Bridge running** — `claude-ide-bridge --watch` in your project directory
2. **Claude Desktop connected** — stdio shim configured (see [Use with Claude Desktop](#use-with-claude-desktop))
3. **Dispatch paired** — open Claude Desktop → Cowork → Dispatch → scan QR code with Claude mobile app
4. **Computer awake** — your desktop must be powered on and not sleeping

### Phone-friendly prompts

The bridge includes 5 Dispatch-optimized prompts designed for terse phone triggers. Each instructs Claude to call specific bridge tools and return concise, phone-screen-friendly output:

| Prompt | Phone message | What it does |
|--------|--------------|--------------|
| `project-status` | "How's the build?" | Git status + diagnostics + test summary |
| `quick-tests` | "Run the tests" | Pass/fail summary with failure details |
| `quick-review` | "Review my changes" | Diff summary + diagnostics for changed files |
| `build-check` | "Does it build?" | Build/compile check with error summary |
| `recent-activity` | "What changed?" | Recent git log + uncommitted changes |

You can also type any natural-language instruction — the prompts above are shortcuts that produce consistently formatted output.

### Example Dispatch session

From your phone:
> "How's the build?"

Claude checks git status, diagnostics, and tests, then responds:
```
Branch: feature/oauth (3 uncommitted)
Diagnostics: 0 errors, 2 warnings
Tests: 142 passed, 0 failed (12s)
```

From your phone:
> "Review my changes"

Claude diffs your uncommitted work and responds with a file-by-file summary and an overall assessment.

### Cowork context template

For better Dispatch results, copy `templates/dispatch-context.md` into your Cowork context folder. It maps terse phone commands to bridge tools and sets response formatting guidelines for mobile output.

### Limitations

- **One conversation thread** — Dispatch uses a single persistent thread
- **Computer must be awake** — if your desktop sleeps, Dispatch goes dark
- **No push notifications** — check the phone app manually for responses
- **Best for reads, not writes** — information retrieval (status, tests, review) is highly reliable; multi-file edits from phone messages are not recommended

---

## Agent Teams (Parallel Multi-Agent)

[Agent Teams](https://code.claude.com/docs/en/agent-teams) let multiple Claude Code instances work in parallel on the same project. A team lead assigns tasks, teammates execute them independently, and results are synthesized.

### How it works with the bridge

Each teammate is an independent Claude Code session that connects to the bridge via its own WebSocket/MCP session. The bridge already supports multiple concurrent sessions (`MAX_SESSIONS = 5`), so **agent teams work out of the box** — no additional configuration needed.

```
Team Lead (Claude Code)
    ├── Teammate A ──► Bridge Session 1 ──► IDE
    ├── Teammate B ──► Bridge Session 2 ──► IDE
    └── Teammate C ──► Bridge Session 3 ──► IDE
```

All teammates share the same IDE and workspace. Each gets full access to all 136+ bridge tools.

### Setup

1. Enable agent teams: set `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1` in your environment
2. Bridge running: `claude-ide-bridge --watch`
3. Ask Claude to create a team: *"Create an agent team to review and fix all TypeScript errors"*

### Bridge prompts for team leads

| Prompt | What it does |
|--------|-------------|
| `/mcp__bridge__team-status` | Workspace state, active tasks, recent activity across sessions |
| `/mcp__bridge__health-check` | Full project health: tests, diagnostics, security |

### Best practices

- **Pre-approve tools** — teammates block on permission prompts. Use `--dangerously-skip-permissions` in sandboxed environments or pre-approve common tools.
- **Avoid file conflicts** — assign teammates to different files/modules. The bridge doesn't lock files across sessions.
- **Use the team-status prompt** — the lead can call `/mcp__bridge__team-status` to see workspace state and recent activity across all sessions.
- **SendMessage auto-resume (≥ v2.1.77)** — As of Claude Code v2.1.77, `SendMessage` automatically resumes stopped agents instead of returning an error. You no longer need to check whether a teammate agent is running before sending it a message.

---

## Scheduled Tasks (Recurring Workflows)

Claude Desktop's [Scheduled Tasks](https://code.claude.com/docs/en/scheduled-tasks) run recurring autonomous workflows on a cron schedule. Each run fires a fresh Claude session with full MCP access — including all bridge tools.

### How it works with the bridge

When a scheduled task fires, Claude Desktop loads your MCP servers from config. If the bridge's stdio shim is configured (see [Use with Claude Desktop](#use-with-claude-desktop)), the task gets full access to all bridge tools.

```
Cron trigger (e.g., daily 9am)
    │
    ▼
Claude Desktop (fresh session)
    │
    ▼  loads MCP servers
Bridge Server ──► IDE Extension ──► Your Code
    │
    ▼  structured report
Task history (viewable in Desktop sidebar)
```

### Ready-made task templates

Copy any of these into `~/.claude/scheduled-tasks/` to set up a recurring workflow:

| Template | Schedule | What it does |
|----------|----------|-------------|
| `nightly-review` | Daily | Review uncommitted changes, diagnostics, test status |
| `health-check` | Hourly/Daily | Full project health: tests, diagnostics, security advisories |
| `dependency-audit` | Weekly | Scan dependencies for CVEs and outdated packages |

```bash
# Install a scheduled task template
cp -r templates/scheduled-tasks/health-check ~/.claude/scheduled-tasks/
```

Then open Claude Desktop → Schedule → configure the frequency and permissions for the task.

### Bridge prompts for scheduled contexts

The `health-check` MCP prompt (`/mcp__bridge__health-check`) produces the same structured report as the scheduled task template — useful for ad-hoc runs from any MCP client.

### Bridge automation vs. Desktop scheduled tasks

The bridge has its own event-driven automation system (`--automation --automation-policy`). Here's when to use which:

| Feature | Trigger | Persistence | Best for |
|---------|---------|-------------|----------|
| **Desktop Scheduled Tasks** | Time-based (cron) | Survives restarts | Nightly reviews, weekly audits, periodic checks |
| **Bridge Automation Hooks** | Event-driven (file save, diagnostic error) | Requires bridge running | Immediate reactions: auto-fix on error, lint on save |

They're complementary — use scheduled tasks for periodic health checks and bridge automation for real-time reactions.

---

## Use with Claude.ai Web

Connect the bridge to [claude.ai](https://claude.ai) via a **Custom Connector** — chat with your IDE from the browser without installing anything extra.

**Prerequisites:** The bridge must be reachable over HTTPS from the public internet. The recommended path is a **Cloudflare Named Tunnel** — no domain registration required, free, and the URL never changes.

### Step 1 — Expose the bridge with a Cloudflare Named Tunnel

```bash
# Install cloudflared on the machine running the bridge
curl -L https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64 \
  -o /usr/local/bin/cloudflared && chmod +x /usr/local/bin/cloudflared

# Authenticate (one-time — opens a browser window)
cloudflared tunnel login

# Create a named tunnel (one-time)
cloudflared tunnel create my-bridge

# Route a hostname to it (requires a domain managed on Cloudflare)
cloudflared tunnel route dns my-bridge bridge.yourdomain.com

# Create ~/.cloudflared/config.yml
cat > ~/.cloudflared/config.yml <<'EOF'
tunnel: my-bridge
credentials-file: /root/.cloudflared/<tunnel-id>.json

ingress:
  - hostname: bridge.yourdomain.com
    service: http://localhost:9000
  - service: http_status:404
EOF

# Start the tunnel (permanent — add to systemd or pm2 for auto-start on reboot)
cloudflared tunnel run my-bridge
```

The bridge is now permanently reachable at `https://bridge.yourdomain.com`. The URL **does not change** across `cloudflared` or bridge restarts.

> **Auto-start:** Run `cloudflared service install` to register the tunnel as a systemd service so it starts on boot alongside the bridge.

### Step 2 — Start the bridge with OAuth enabled

```bash
# Generate a token once — keep it safe, you'll need it to approve connections
TOKEN=$(uuidgen)

claude-ide-bridge \
  --bind 0.0.0.0 \
  --workspace /path/to/project \
  --fixed-token $TOKEN \
  --issuer-url https://bridge.yourdomain.com \
  --cors-origin https://claude.ai
```

- `--fixed-token` — token never rotates across restarts
- `--issuer-url` — your public HTTPS URL; activates OAuth 2.0 so claude.ai can authenticate
- `--cors-origin https://claude.ai` — allows claude.ai's browser requests to reach the bridge

### Step 3 — Add the Custom Connector on claude.ai

1. Go to **claude.ai → Settings → Integrations → Add custom connector**
2. Enter the MCP endpoint URL (no token in the URL — OAuth handles auth):
   ```
   https://bridge.yourdomain.com/mcp
   ```
3. Click **Connect** — claude.ai redirects you to the bridge's authorization page
4. Enter your bridge token (`$TOKEN` from Step 2) and click **Authorize**
5. claude.ai completes the OAuth exchange and lists all available tools

> The bridge token is entered once during authorization. After that, claude.ai holds a short-lived OAuth access token that it refreshes automatically — you don't need to update the connector URL when the bridge restarts.

> **Tool availability:** All 136+ tools are available in full mode. VS Code extension-dependent tools (LSP, debugger, editor state) require the extension to be connected on the remote machine. Without the extension, ~57 CLI-backed tools still work (file ops, git, terminal, search, HTTP client). In slim mode (default), only the 50 IDE-exclusive tools are exposed.

### Alternatives

<details>
<summary>Reverse proxy with nginx or Caddy (if you already have a domain + TLS setup)</summary>

Put nginx or Caddy in front of the bridge with TLS — proxy **all paths** (not just `/mcp`) so the OAuth discovery and authorization endpoints are reachable. See [docs/remote-access.md](docs/remote-access.md) for a ready-made config.

</details>

<details>
<summary>Ephemeral Cloudflare Tunnel (one-off testing only)</summary>

> ⚠️ **Do not use for permanent setups.** The subdomain (`abc123.trycloudflare.com`) changes every time `cloudflared` restarts — your MCP config and connector URL will break. Use the named tunnel above for anything you'll use more than once.

```bash
cloudflared tunnel --url http://localhost:9000
# Outputs a temporary URL like: https://abc123.trycloudflare.com
```

</details>

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
claude-ide-bridge init [--workspace <path>]    One-command setup: install extension + write CLAUDE.md + print next steps
claude-ide-bridge start-all [options]          Full tmux orchestrator (bridge + Claude + remote)
claude-ide-bridge install-extension [editor]   Install VS Code extension into your IDE
claude-ide-bridge gen-claude-md [--write] [--workspace <path>]
                                               Print bridge workflow guidance (or write to CLAUDE.md)
```

### Bridge options (default mode)

```
--bind <addr>             Bind address (default: 127.0.0.1)
--fixed-token <uuid>      Stable auth token across restarts (default: random UUID)
--issuer-url <url>        Public HTTPS URL — activates OAuth 2.0 for remote clients
--cors-origin <url>       Allow cross-origin requests from this origin (repeatable)
--workspace <path>        Workspace folder (default: cwd)
--ide-name <name>         IDE name shown to Claude (default: auto-detect)
--editor <cmd>            Editor CLI command (default: auto-detect)
--port <number>           Force specific port (default: random)
--linter <name>           Enable specific linter (repeatable; default: auto-detect)
--grace-period <ms>       Reconnect grace period in ms (default: 30000, max: 600000)
--allow-command <cmd>     Add command to execution allowlist (repeatable)
--timeout <ms>            Command timeout in ms (default: 30000, max: 120000)
--max-result-size <KB>    Max output size in KB (default: 512, max: 4096)
--vps                     VPS/headless mode: adds curl, systemctl, nginx, pm2, docker to allowlist
--watch                   Supervisor mode: auto-restart on crash (exponential backoff, max 30s)
--auto-tmux               Re-exec inside a tmux session automatically
--tool-rate-limit <n>     Max tool calls per minute per session (default: 60)
--audit-log <path>        Append all tool calls to a JSONL file (persistent audit trail)
--claude-driver <mode>    Claude subprocess driver: subprocess | api | none (default: none)
--claude-binary <path>    Path to claude binary (default: claude)
--automation              Enable event-driven automation
--automation-policy <path> Path to JSON automation policy file
--plugin <path>           Load a plugin directory (repeatable)
--plugin-watch            Watch plugin directories and hot-reload on change
--full                    Register all 136+ tools (default: slim mode with 50 IDE-exclusive tools)
--verbose                 Enable debug logging
--version, -v             Print version and exit
--analytics <on|off>      Enable or disable anonymous usage analytics
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
    automation.ts     AutomationHooks — onDiagnosticsError / onFileSave / onFileChanged / onTestRun / onGitCommit / onGitPush / onBranchCheckout / onPullRequest / onCwdChanged / onPostCompact / onInstructionsLoaded policies
    tools/            136+ MCP tool implementations
  vscode-extension/
    src/extension.ts  VS Code extension
    src/connection.ts WebSocket connection management
    src/handlers/     Request handlers (terminal, lsp, debug, ...)
  claude-ide-bridge-plugin/
    skills/           9 slash commands
    agents/           3 specialized subagents
    hooks/            16 hook events (PreToolUse, PostToolUse, SessionStart, InstructionsLoaded, Elicitation, ElicitationResult, PostCompact, WorktreeCreate, WorktreeRemove, SubagentStart, SubagentStop, TeammateIdle, TaskCompleted, ConfigChange, Stop, StopFailure)
    .mcp.json         MCP server config
```

## Tips

### Useful tools you might not know about

- **`bridgeDoctor`** — comprehensive environment health check. Verifies extension connection, git, TypeScript, linter, test runner, lock file, node_modules, and GitHub CLI. Returns actionable suggestions for anything broken. Call this first when tools are missing or the setup feels off.

- **`getBridgeStatus`** — ask Claude to call this when things feel wrong. It returns extension connection state, circuit breaker status (including remaining suspension time), active session count, uptime, and `lastDisconnect` (timestamp, WebSocket close code, and reason for the most recent disconnect — useful for diagnosing 1006 abnormal-close events). Faster than reading logs.

- **`getActivityLog`** — returns a history of all tool calls in the current bridge session. Pass `showStats: true` to get per-tool call counts, average durations, and error rates. Useful after long autonomous tasks.

- **`getHandoffNote`** / **`setHandoffNote`** — a persistent scratchpad (10KB, shared across all MCP sessions) stored at `~/.claude/ide/handoff-note.json`. Use it to pass context between a Claude Code CLI session and Claude Desktop, or between sessions on different machines. Ask Claude to write a summary note before closing a session, then read it in the next.

- **`createGithubIssueFromAIComment`** — Claude can scan your code for `// AI:` comments (e.g. `// AI: this function needs error handling`) and file them as GitHub issues automatically. The extension pushes AI comment cache in real time — call `createGithubIssueFromAIComment` directly to file the detected comments as issues.

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

Claude Code ships with its own built-in commit/PR guidance. When using the bridge's dedicated git tools (`gitCommit`, `gitPush`, `githubCreatePR`, etc.), you can suppress the duplicate Claude Code instructions by adding to `~/.claude/settings.json`:

```json
{
  "includeGitInstructions": false
}
```

This keeps the prompt clean and ensures Claude uses the bridge's structured git tools rather than raw shell commands.

---

## Connection Hardening

Production-grade reliability:
- WebSocket heartbeat (10s) with automatic reconnect
- Sleep/wake detection via heartbeat gap monitoring
- Circuit breaker with exponential backoff for timeout cascades
- Generation counter preventing stale handler responses
- Extension-required tool filtering when extension disconnects
- 1579+ tests (bridge) + 394 extension tests; full WebSocket round-trip integration coverage
- MCP elicitation support (`elicitation: {}` capability) — bridge can send `elicitation/create` mid-task to request structured user input via Claude Code's interactive dialog (Claude Code 2.1.76+)

## Building

```bash
# Bridge
npm run build        # TypeScript compilation
npm run dev          # Development with tsx
npm test             # Run 1579+ bridge tests

# Extension
cd vscode-extension
npm run build        # esbuild bundle
npm run package      # Create .vsix
npm test             # Run 394 extension tests
```

## Troubleshooting

### Claude says a tool doesn't exist or tool count seems low

When the VS Code extension is disconnected, 50 tools that require extension access return an error with reconnect instructions (they remain visible but non-functional). These include LSP, debugger, editor state, and refactoring tools. In slim mode (default), all tools need the extension; in full mode, ~57 CLI-backed tools (git, terminal, file ops, HTTP, GitHub) still work. Check the "Claude IDE Bridge" output channel in VS Code — if you see a disconnection event, use `Claude IDE Bridge: Reconnect` from the command palette, or reload the window.

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

### Tool parameters rejected with type errors in long sessions

After conversation compaction, deferred tools (loaded via ToolSearch) lose their input schemas, causing array/number parameters to be rejected with type errors. This is a known Claude Code bug fixed in v2.1.76.

**Fix:** Update Claude Code to ≥ 2.1.76:

```bash
npm update -g @anthropic-ai/claude-code
```

### `start-all` launched from inside a Claude Code session

Launching `start-all` from within an active Claude Code session can cause tmux conflicts. Kill the existing tmux server first:

```bash
tmux kill-server
env -u CLAUDECODE claude-ide-bridge start-all --workspace /your/project
```

## Developer Documentation

See [Documentation](#documentation) above for all guides, ADRs, and reference docs. AI-specific project instructions:

- **[CLAUDE.md](CLAUDE.md)** — Project instructions for AI assistants (Claude Code, Cursor). Covers architecture rules, plugin system, OAuth, remote deployment, security model.
- **[.cursorrules](.cursorrules)** — Imperative rules for Cursor IDE AI. Condensed mirror of CLAUDE.md.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for development setup, code style, and how to add new tools.

## Support

If Claude IDE Bridge saves you time, consider [sponsoring the project](https://github.com/sponsors/Oolab-labs).

## License

MIT
