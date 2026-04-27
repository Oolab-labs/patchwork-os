# Patchwork OS

**Proactive AI automation that runs on your machine. Oversight built in. No vendor lock-in.**

```bash
npx patchwork-os@alpha patchwork-init
```

Sets up 5 local recipes, detects Ollama, and opens a terminal dashboard — under 90 seconds.

---

## What it is

Patchwork OS is a local automation platform that watches your workspace for events, runs AI-powered recipes in response, and routes anything risky through an approval queue before it goes anywhere.

Think of it as a background agent that acts on your behalf — but asks before sending, writing, or modifying anything consequential.

- Test suite fails on CI → triage note in your inbox before you wake up
- Customer email arrives → draft reply in your voice, pending your approval
- Field-trip permission form flagged → reply drafted to the teacher, waiting for your nod

---

## How it works

**Recipes** are plain YAML files. They declare a trigger (cron, file save, git commit, test run, webhook) and an action (run a prompt, write to inbox, call a connector). No code required. Share them like dotfiles.

**Models** are yours. Claude, GPT, Gemini, Grok, or local Ollama. Swap at any time. Nothing phones home.

**Oversight** is non-negotiable. Every write or external action lands in `~/.patchwork/inbox/` for approval. The web UI at `http://localhost:3100` shows pending approvals, live sessions, recipe run history, and analytics.

---

## Quickstart

```bash
# Install globally
npm install -g patchwork-os

# One-command setup: extension + CLAUDE.md + starter recipes
patchwork-os patchwork-init

# Explore
patchwork-os recipe list                      # installed recipes
patchwork-os recipe run daily-status         # run one now
patchwork-os recipe run morning-brief --local # run with local Ollama
patchwork-os tools list                      # browse 170+ tools
patchwork-os                                 # open terminal dashboard
```

**Web UI** — start the bridge, then open `http://localhost:3100`

```bash
patchwork-os start-all    # bridge + extension watcher in tmux
```

---

## Starter recipes

No external API keys needed for these:

| Recipe | Trigger | What it does |
|---|---|---|
| `ambient-journal` | git commit | Appends one line to `~/.patchwork/journal/` |
| `daily-status` | cron 08:00 | Morning brief from yesterday's commits |
| `watch-failing-tests` | test run | Drops triage note to inbox on failure |
| `lint-on-save` | file save | Surfaces new TS/JS diagnostics to inbox |
| `stale-branches` | cron weekly | Lists branches older than 30 days |
| `morning-brief` | cron 08:00 | Commits + Linear issues + Calendar events |
| `sentry-to-linear` | manual | Sentry issue → Linear ticket (one-shot) |

Connectors (Linear, Sentry, Slack, Google Calendar) require API keys and approval-gated writes.

---

## Architecture

```
patchwork-os CLI
├── Recipe runner          YAML triggers → LLM prompt → action
├── Claude IDE Bridge      MCP server — 170+ tools over WebSocket/HTTP
│   ├── VS Code extension  LSP, debugger, editor state, live diagnostics
│   ├── Git / GitHub       gitCommit, gitPush, githubCreatePR, …
│   ├── Terminal           runInTerminal, getTerminalOutput, …
│   ├── Connectors         Linear, Sentry, Slack, Google Calendar
│   └── Orchestrator       Claude subprocess tasks, automation hooks
├── Oversight inbox        ~/.patchwork/inbox/ — approval queue
└── Web dashboard          http://localhost:3100 — approvals, sessions, analytics
```

**Transport layers:**

| Client | Protocol |
|---|---|
| Claude Code CLI | WebSocket `ws://127.0.0.1:<port>` |
| Claude Desktop | stdio shim → WebSocket |
| Remote (claude.ai, Codex) | Streamable HTTP + Bearer token |

**Tool modes:**

| Mode | Tools | When to use |
|---|---|---|
| Full _(default)_ | ~170 | All git, GitHub, terminal, file ops, orchestration |
| Slim (`--slim`) | ~60 | LSP + debugger + editor state only |

---

## Tool surface (v0.2.0-alpha.33)

170+ MCP tools across 15 categories. Highlights:

| Category | Tools |
|---|---|
| LSP / Code Intelligence | `getDiagnostics`, `goToDefinition`, `findReferences`, `getCallHierarchy`, `renameSymbol`, `refactorAnalyze`, `explainSymbol`, … (37 tools) |
| Git | `getGitStatus`, `getGitDiff`, `gitCommit`, `gitPush`, `gitCheckout`, `gitBlame`, … (16 tools) |
| GitHub | `githubCreatePR`, `githubListPRs`, `githubCreateIssue`, `githubPostPRReview`, … (13 tools) |
| Terminal | `runInTerminal`, `createTerminal`, `getTerminalOutput`, `waitForTerminalOutput` |
| File Operations | `editText`, `searchAndReplace`, `searchWorkspace`, `findFiles`, `getFileTree`, … |
| Debugger | `setDebugBreakpoints`, `startDebugging`, `evaluateInDebugger` |
| Orchestrator | `runClaudeTask`, `listClaudeTasks`, `getClaudeTaskStatus` |
| Context Platform | `ctxGetTaskContext`, `ctxQueryTraces`, `ctxSaveTrace`, `enrichStackTrace` |

Full reference: [documents/platform-docs.md](documents/platform-docs.md)

---

## Automation hooks

Event-driven hooks trigger Claude tasks automatically. Activate with `--automation --automation-policy <path.json> --claude-driver subprocess`.

Key hooks:

| Hook | Fires when |
|---|---|
| `onFileSave` | Matching files saved |
| `onDiagnosticsStateChange` | Errors appear or clear |
| `onRecipeSave` | Any `.yaml`/`.yml` saved — runs preflight |
| `onGitCommit` | After successful commit |
| `onTestRun` | After test run completes |
| `onBranchCheckout` | After branch switch |
| `onCompaction` | Before/after Claude context compaction |

All hooks support inline prompts, named prompt references, and a minimum 5s cooldown.

Full reference: [documents/platform-docs.md → Automation Hooks](documents/platform-docs.md)

---

## Plugin system

Extend the tool surface without forking the bridge.

```bash
# Scaffold a new plugin
patchwork-os gen-plugin-stub ./my-plugin --name "org/name" --prefix "myPrefix"

# Load at runtime
patchwork-os --plugin ./my-plugin
```

Plugins register MCP tools in-process. Publish to npm with keyword `claude-ide-bridge-plugin`.

Full reference: [documents/plugin-authoring.md](documents/plugin-authoring.md)

---

## Remote deployment

Patchwork runs headless on a VPS with full tool support via VS Code Remote-SSH.

```bash
patchwork-os --bind 0.0.0.0 \
  --issuer-url https://your-domain.com \
  --fixed-token <uuid> \
  --vps
```

Systemd service and deploy scripts in [`deploy/`](deploy/). Full guide: [docs/remote-access.md](docs/remote-access.md).

---

## What's shipped

| Feature | Status |
|---|---|
| `patchwork-init` — one-command setup | **shipped** |
| Terminal dashboard | **shipped** |
| Web oversight UI (approvals, sessions, recipes) | **shipped** |
| Recipe runner (YAML, cron, manual, webhook) | **shipped** |
| Multi-provider LLM (Claude, Gemini, OpenAI, Grok, Ollama) | **shipped** |
| 170+ MCP tools (LSP, git, tests, debugger, diagnostics) | **shipped** |
| Linear connector (read + approval-gated write) | **shipped** |
| Sentry connector | **shipped** |
| Google Calendar connector (read-only) | **shipped** |
| Slack connector | **shipped** |
| Cross-session memory (traces, handoff notes) | **shipped** |
| JetBrains plugin | **shipped** (marketplace review) |
| Mobile oversight PWA | in progress |
| Community recipe marketplace | Q3 |

---

## Install from source

```bash
git clone https://github.com/Oolab-labs/patchwork-os
cd patchwork-os
npm install && npm run build

# Pack first — do NOT use `npm install -g .`
# Symlink installs break the macOS LaunchAgent (EPERM at startup)
npm pack
npm install -g patchwork-os-*.tgz
patchwork-os patchwork-init
```

---

## Documentation

| Doc | Contents |
|---|---|
| [documents/platform-docs.md](documents/platform-docs.md) | Full tool reference (170+ tools), automation hooks, connectors |
| [documents/prompts-reference.md](documents/prompts-reference.md) | All 72 MCP prompts |
| [documents/styleguide.md](documents/styleguide.md) | Code conventions, UI patterns |
| [documents/roadmap.md](documents/roadmap.md) | Development direction |
| [documents/data-reference.md](documents/data-reference.md) | Data flows, state management, protocol details |
| [documents/plugin-authoring.md](documents/plugin-authoring.md) | Plugin manifest schema, entrypoint API, distribution |
| [docs/adr/](docs/adr/) | Architecture Decision Records |
| [docs/remote-access.md](docs/remote-access.md) | VPS deployment guide |

---

## License

MIT © Oolab Labs
