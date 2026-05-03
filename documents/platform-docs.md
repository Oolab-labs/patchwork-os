# Claude IDE Bridge — Platform Documentation

Version **0.2.0-alpha.35** · 170+ tools · 72 MCP prompts · 20 automation hooks · 19 connectors (Slack, GitHub, Linear, Gmail, Google Calendar, Google Drive, Sentry, Notion, Confluence, Datadog, HubSpot, Intercom, Stripe, Zendesk, Jira, PagerDuty, Discord, Asana, GitLab — see [README](../README.md) for canonical list)

> **Deployment model:** Remote deployment (VPS + reverse proxy, systemd service, `--bind 0.0.0.0 --issuer-url <https-url>`) is a first-class, production-ready pattern and is the recommended architecture for team or cloud access. Local mode (`127.0.0.1`, no `--issuer-url`) is for individual development.

---

## Table of Contents

- [Tool Modes](#tool-modes)
- [Extension-Required Tools](#extension-required-tools)
- [Tool Reference](#tool-reference)
  - [Editor State](#editor-state)
  - [LSP / Code Intelligence](#lsp--code-intelligence)
  - [Debugger](#debugger)
  - [Editor Decorations](#editor-decorations)
  - [Bridge Introspection](#bridge-introspection)
  - [Composite Tools](#composite-tools)
  - [Git](#git)
  - [GitHub](#github)
  - [Terminal](#terminal)
  - [File Operations](#file-operations)
  - [Formatting and Quality](#formatting-and-quality)
  - [Workspace and Settings](#workspace-and-settings)
  - [HTTP and Clipboard](#http-and-clipboard)
  - [Plans](#plans)
  - [Handoff and Session](#handoff-and-session)
  - [VS Code Integration](#vs-code-integration)
  - [File Watching](#file-watching)
  - [Code Generation](#code-generation)
  - [AI Workflow Composite](#ai-workflow-composite)
  - [Orchestrator / Claude Subprocesses](#orchestrator--claude-subprocesses)
- [When to Use X vs Y](#when-to-use-x-vs-y)
- [MCP Prompts](#mcp-prompts)
- [Automation Hooks](#automation-hooks)
- [Headless / CI Mode](#headless--ci-mode)
- [Connectors](#connectors)
- [Model Support](#model-support)

---

## Tool Modes

The bridge operates in two modes controlled at startup:

| Mode | Flag | Tool count | Description |
|------|------|-----------|-------------|
| Full | _(default since v2.43.0)_ | ~140 | All tools including git, GitHub, terminal, file ops, HTTP, orchestration |
| Slim | `--slim` | ~60 | IDE-exclusive tools only — LSP, debugger, editor state, bridge introspection |

**Full mode** (the default) exposes every workspace operation. Use this when Claude needs to perform git operations, run terminal commands, edit files, or interact with GitHub without falling back to shell commands.

**Slim mode** (opt-in via `--slim`) exposes only tools Claude cannot replicate via its native Read/Write/Bash capabilities. Use slim mode when you prefer Claude's native file/shell tools or want to minimize the exposed surface in locked-down environments.

The `SLIM_TOOL_NAMES` set in `src/tools/index.ts` is the canonical source of truth for which tools remain available in slim mode.

**Slim tool categories:**

| Category | Count |
|----------|-------|
| Editor State | 10 |
| LSP / Code Intelligence | 37 |
| Debugger | 5 |
| Editor Decorations | 2 |
| Bridge Introspection | 3 |
| VS Code escape hatch (`executeVSCodeCommand`) | 1 |

**Full-only tool categories (hidden when `--slim` is passed):**

| Category | Count |
|----------|-------|
| Git | 16 |
| GitHub (gh CLI required) | 13 |
| Terminal | 7 |
| File Operations | 10 |
| Formatting and Quality | 9 |
| Workspace and Settings (partial) | 5 |
| HTTP and Clipboard (partial) | 2 |
| Plans | 5 |
| Handoff and Session | 2 |
| VS Code Integration (partial) | 3 |
| Code Generation | 2 |
| AI Workflow Composite | 5 |
| Orchestrator / Claude Subprocesses | 5 |

**Runtime introspection:** call `getToolCapabilities` at session start to confirm which tools are available and whether the VS Code extension is connected. This is especially important in headless or CI environments where some tools may have missing probes.

---

## Extension-Required Tools

Tools marked `extensionRequired: true` need the VS Code extension connected. They behave differently from optional extension tools:

- They are **always visible** in `tools/list` regardless of extension state.
- If the extension is disconnected, calling them returns `isError: true` with structured reconnect instructions rather than a "Tool Not Found" error.
- This allows Claude to report the problem clearly instead of silently missing the tool.

**Tools with `extensionFallback: true`** have a secondary code path that works without the extension:

| Tool | Fallback mechanism |
|------|--------------------|
| `goToDefinition` | `typescript-language-server --stdio` (LSP JSON-RPC) |
| `findReferences` | `typescript-language-server --stdio` |
| `getTypeSignature` | `typescript-language-server --stdio` |
| `searchWorkspaceSymbols` | Universal Ctags (`ctags --output-format=json`) |
| `navigateToSymbolByName` | ripgrep declaration-pattern search |
| `getDiagnostics` | CLI linters: `tsc --noEmit`, `eslint`, `pyright`, `ruff`, `cargo check`, `go vet`, `biome` |
| `watchDiagnostics` | CLI linters (same fallback as `getDiagnostics`) |

The fallback activates only when the probe for the required CLI tool succeeded at startup. Call `getBridgeStatus` to see which fallback paths are available (`toolAvailability` field).

---

## Tool Reference

**Mode column:** `S` = slim (retained when `--slim` is passed), `F` = full-only (hidden in slim mode). Full mode is the default.

---

### Editor State

| Tool | Mode | Description | Notes |
|------|------|-------------|-------|
| `getOpenEditors` | S | List open editor tabs with dirty/language info | extensionRequired |
| `getCurrentSelection` | S | Current editor selection — text and position | extensionRequired |
| `getLatestSelection` | S | Cached selection state, no extension round-trip | extensionRequired |
| `checkDocumentDirty` | S | Check if a file has unsaved changes | extensionRequired |
| `saveDocument` | S | Save an open document | extensionRequired |
| `openFile` | S | Open a file in the editor with optional line navigation | extensionRequired |
| `closeTab` | S | Close a specific editor tab | extensionRequired |
| `captureScreenshot` | S | Capture current display as MCP image block. Uses `screencapture -x` on macOS, ImageMagick on Linux | extensionRequired |
| `watchActivityLog` | S | Long-poll activity log for new entries. Params: `sinceId`, `maxEntries` (default 10, max 50), `timeoutMs` (1000–30000 ms). Returns `{ entries, lastId }` | |
| `contextBundle` | S | Composite snapshot: active file + content (32 KB cap) + diagnostics + diff + open editors + git status + handoff note, fetched in parallel via `Promise.allSettled` | |

---

### LSP / Code Intelligence

| Tool | Mode | Description | Notes |
|------|------|-------------|-------|
| `getDiagnostics` | S | Errors and warnings — extension if connected, CLI linters as fallback | extensionFallback |
| `watchDiagnostics` | S | Long-poll for diagnostic changes. Each entry includes `firstSeenAt`, `recurrenceCount`, and optional `introducedByCommit` | extensionFallback |
| `getDocumentSymbols` | S | List all symbols in a document (classes, functions, variables) | extensionRequired |
| `goToDefinition` | S | Jump to symbol definition | extensionFallback via typescript-language-server |
| `findReferences` | S | Find all references to a symbol. Supports cursor-based pagination (`cursor` param, `nextCursor` in response, PAGE_SIZE=100) | extensionFallback via typescript-language-server |
| `findImplementations` | S | Find all concrete implementations of an interface or abstract class | extensionRequired |
| `goToTypeDefinition` | S | Navigate to the type definition of a symbol (e.g. variable → interface) | extensionRequired |
| `goToDeclaration` | S | Navigate to the declaration (distinct from definition; relevant in C/C++ headers) | extensionRequired |
| `getHover` | S | Hover info and type documentation at a file position | extensionRequired |
| `getCodeActions` | S | List available code actions for a range | extensionRequired |
| `applyCodeAction` | S | Apply a specific code action | extensionRequired |
| `previewCodeAction` | S | Show exact edits a code action would make without applying. Returns `{ title, changes, totalFiles, totalEdits }` | extensionRequired |
| `refactorPreview` | S | Preview exact edits a rename/refactor would make before committing | extensionRequired |
| `renameSymbol` | S | Rename a symbol across the entire workspace (15 s timeout) | extensionRequired |
| `searchWorkspaceSymbols` | S | Search symbols across the workspace by name | extensionFallback via Universal Ctags |
| `getCallHierarchy` | S | Incoming or outgoing call hierarchy (15 s timeout). Cursor pagination supported (PAGE_SIZE=50 per direction) | extensionRequired |
| `explainSymbol` | S | Composite: hover + definition + references + optional type hierarchy + code actions in one call | extensionRequired |
| `prepareRename` | S | Check if a symbol can be renamed before attempting (rename safety check) | extensionRequired |
| `signatureHelp` | S | Function signature docs and parameter info at a call site | extensionRequired |
| `refactorAnalyze` | S | Assess refactoring impact: refs, callers, inheritance, risk level (low/medium/high) | extensionRequired |
| `foldingRanges` | S | Foldable code regions (functions, classes, imports) for a file | extensionRequired |
| `selectionRanges` | S | Hierarchical selection boundaries at a position (innermost → outermost) | extensionRequired |
| `refactorExtractFunction` | S | Extract a code range into a new function with signature inference. Param is `file`, not `filePath` | extensionRequired |
| `getImportTree` | S | BFS traversal of static/dynamic imports and CommonJS `require()` from a file. Returns tree with depths and cycle detection | |
| `getImportedSignatures` | S | Resolve imported symbols to type signatures via `goToDefinition` → `getHover`. 5-concurrent; hover truncated to 4000 chars | extensionRequired |
| `getDocumentLinks` | S | Extract file references and URLs from a document. Filters `file://` through workspace containment; caps at 100 links | extensionRequired |
| `batchGetHover` | S | Fan-out `getHover` for up to 10 positions in one call via `Promise.allSettled` | extensionRequired |
| `batchGoToDefinition` | S | Fan-out `goToDefinition` for up to 10 positions in one call | extensionRequired |
| `batchFindImplementations` | S | Fan-out `findImplementations` for up to 10 positions in one call | extensionRequired |
| `getSemanticTokens` | S | Token-level semantic classification (type/variable/function + modifiers like readonly/deprecated). Decodes VS Code delta-encoded Uint32Array; `startLine`/`endLine` filter; caps at 2000 tokens | extensionRequired |
| `getCodeLens` | S | Code lens items at each location (reference counts, test run indicators). Omits `commandId`; truncates titles to 200 chars | extensionRequired |
| `getChangeImpact` | S | Blast-radius composite: live diagnostics + reference counts for changed symbols. Returns `blastRadius: low/medium/high` | extensionRequired |
| `getTypeHierarchy` | S | Type hierarchy — supertypes and subtypes (15 s timeout) | extensionRequired |
| `getInlayHints` | S | Inline type annotations and parameter name hints for a line range | extensionRequired |
| `getHoverAtCursor` | S | Hover info at the current cursor position (no coordinates needed) | extensionRequired |
| `getTypeSignature` | S | TypeScript/language type signature at a file position. Returns the first fenced code block from hover markdown | extensionFallback via typescript-language-server |
| `formatRange` | S | Format a specific line range via VS Code formatter | extensionRequired |
| `explainDiagnostic` | S | Compound: code context + go-to-definition + call hierarchy for an error location. Returns plain-English explanation of a diagnostic | extensionRequired |

---

### Edit Transactions

| Tool | Mode | Description | Notes |
|------|------|-------------|-------|
| `previewEdit` | S | Show unified diff of a pending edit (lineRange or searchReplace) without writing to disk | |
| `beginTransaction` | S | Start an in-memory multi-file edit transaction. Returns `transactionId` | |
| `stageEdit` | S | Queue a lineRange or searchReplace edit into an open transaction | |
| `commitTransaction` | S | Atomically write all staged edits in a transaction to disk | |
| `rollbackTransaction` | S | Discard all staged edits in a transaction without writing | |

---

### Debugger

All debugger tools are slim and require the VS Code extension.

| Tool | Mode | Description | Notes |
|------|------|-------------|-------|
| `getDebugState` | S | Active debug session state: breakpoints, call stack, scopes | extensionRequired |
| `evaluateInDebugger` | S | Evaluate expressions in the active debug context | extensionRequired |
| `setDebugBreakpoints` | S | Set breakpoints with optional conditions | extensionRequired |
| `startDebugging` | S | Start a debug session (15 s timeout) | extensionRequired |
| `stopDebugging` | S | Stop the active debug session | extensionRequired |

---

### Editor Decorations

| Tool | Mode | Description | Notes |
|------|------|-------------|-------|
| `setEditorDecorations` | S | Apply visual decorations (info, warning, error, focus, strikethrough, dim). Param: `id` (decoration set name), `style`, `hoverMessage`, `message` | extensionRequired |
| `clearEditorDecorations` | S | Remove all decorations for a decoration set by `id` | extensionRequired |

---

### Bridge Introspection

| Tool | Mode | Description |
|------|------|-------------|
| `getBridgeStatus` | S | Bridge status: extension connection state, circuit breaker, active sessions, uptime, tool availability flags, automation hook wiring. Call to diagnose missing tools or disconnected extension. |
| `getToolCapabilities` | S | List available CLI probes (rg, ctags, typescript-language-server, gh, etc.) and which tools they enable. Call once at session start. |
| `bridgeDoctor` | S | Automated diagnostics: checks lock file, extension connection, probe availability, and common misconfiguration. Returns actionable fix suggestions. |

---

### Composite Tools

These tools combine multiple primitives to replace common multi-step patterns.

| Tool | Mode | Description | Notes |
|------|------|-------------|-------|
| `formatAndSave` | S | `formatDocument` + `saveDocument` in one call. Propagates formatter errors; save is not attempted on format failure | extensionRequired |
| `jumpToFirstError` | S | `getDiagnostics` → `openFile` at error line → `setEditorDecorations` in one call. Returns `{ found: false }` when workspace is clean | extensionRequired |
| `navigateToSymbolByName` | S | `searchWorkspaceSymbols` → `goToDefinition` → `openFile`. Returns chosen symbol, its definition, and up to 4 alternatives | extensionFallback via ripgrep |

---

### Git

All git tools are full-only.

| Tool | Mode | Description |
|------|------|-------------|
| `getGitStatus` | F | Working tree status: staged, unstaged, untracked |
| `getGitDiff` | F | Diff output — staged, unstaged, or between commit ranges |
| `getGitLog` | F | Commit history with formatting options |
| `getCommitDetails` | F | Detailed info for a specific commit |
| `getDiffBetweenRefs` | F | Diff between any two git refs |
| `gitAdd` | F | Stage files |
| `gitCommit` | F | Create commits. Triggers `onGitCommit` automation hook on success |
| `gitCheckout` | F | Switch branches or create new ones. Triggers `onBranchCheckout` hook. When leaving detached HEAD, response includes `previousCommit` (12-char hash) and `wasDetached: true` |
| `gitBlame` | F | Line-by-line blame annotation |
| `gitFetch` | F | Fetch from remotes |
| `gitListBranches` | F | List local and remote branches |
| `gitPull` | F | Pull from remote. Triggers `onGitPull` hook on success |
| `gitPush` | F | Push to remote. Triggers `onGitPush` hook on success |
| `gitStash` | F | Stash changes |
| `gitStashPop` | F | Pop stashed changes |
| `gitStashList` | F | List stashes |

---

### GitHub

All GitHub tools are full-only and require the `gh` CLI. Tools are only registered when `gh` is found in the probe results at startup.

| Tool | Mode | Description | Notes |
|------|------|-------------|-------|
| `githubCreatePR` | F | Create a pull request. Triggers `onPullRequest` hook on success | gh required |
| `githubListPRs` | F | List pull requests with filters | gh required |
| `githubViewPR` | F | View PR details | gh required |
| `githubListIssues` | F | List issues with filters | gh required |
| `githubGetIssue` | F | View issue details | gh required |
| `githubCreateIssue` | F | Create a new issue | gh required |
| `githubCommentIssue` | F | Post a comment on an issue | gh required |
| `githubListRuns` | F | List GitHub Actions workflow runs | gh required |
| `githubGetRunLogs` | F | Get logs from a workflow run | gh required |
| `githubGetPRDiff` | F | Get PR diff content | gh required |
| `githubPostPRReview` | F | Post review comments on a PR | gh required |
| `getAIComments` | F | Scan open files for `// AI:` comments with severity levels (fix, todo, question, warn, task) | extensionRequired |
| `createGithubIssueFromAIComment` | F | Create a GitHub issue from a cached `// AI:` comment. Derives title from comment text | gh required, extensionRequired |

---

### Terminal

All terminal tools are full-only and require the VS Code extension. `isCommand: false` on `sendTerminalCommand` bypasses allowlist validation and sends raw text to the PTY — use for stdin responses to interactive prompts.

| Tool | Mode | Description |
|------|------|-------------|
| `createTerminal` | F | Create a new VS Code integrated terminal with optional name/cwd/env |
| `disposeTerminal` | F | Close a terminal |
| `listTerminals` | F | List VS Code integrated terminals |
| `getTerminalOutput` | F | Get recent output (ring buffer, up to 5000 lines) |
| `sendTerminalCommand` | F | Send text to a terminal (allowlist enforced unless `isCommand: false`) |
| `runInTerminal` | F | Execute a command and capture output (allowlist enforced). Returns error on shell integration timeout — use `runCommand` for reliable non-interactive output capture |
| `waitForTerminalOutput` | F | Wait for a pattern match in terminal output |

---

### File Operations

All file operation tools are full-only.

| Tool | Mode | Description |
|------|------|-------------|
| `editText` | F | Apply precise line-range text edits via VS Code API |
| `createFile` | F | Create files or directories |
| `deleteFile` | F | Delete files with optional trash/recursive |
| `renameFile` | F | Rename or move files |
| `getBufferContent` | F | In-memory content of an open file. Falls back to disk. `startLine`/`endLine` range works on files of any size |
| `replaceBlock` | F | Replace a block of text by matching old content |
| `searchAndReplace` | F | Find and replace across workspace files using regex. Globs starting with `-` are rejected to prevent `rg` flag injection |
| `searchWorkspace` | F | Content search via `rg` (preferred) or `grep` fallback |
| `findFiles` | F | File search via `fd` (preferred) or `find` fallback |
| `getFileTree` | F | Directory tree with configurable depth |

---

### Formatting and Quality

All tools in this category are full-only.

| Tool | Mode | Description | Notes |
|------|------|-------------|-------|
| `formatDocument` | F | Format via VS Code formatter (extension) or CLI fallback (prettier, black, gofmt, rustfmt, biome) | |
| `fixAllLintErrors` | F | Auto-fix all lint errors via VS Code or CLI (eslint --fix, biome, ruff) | |
| `organizeImports` | F | Organize imports via VS Code | extensionRequired |
| `detectUnusedCode` | F | Scan for unused exports, functions, and variables combining LSP references with static analysis | |
| `getCodeCoverage` | F | Parse coverage reports (lcov, coverage-summary.json, clover.xml). Auto-detects report in workspace. Supports `minCoverage` filter | |
| `testTraceToSource` | S | Parse existing lcov.info or coverage-summary.json to find source lines exercised by a test pattern. No instrumentation required; note: without per-test coverage returns whole-suite data filtered by filename | |
| `auditDependencies` | F | Detect outdated packages and report current vs latest versions. Auto-detects package manager from lock files | |
| `getSecurityAdvisories` | F | Run security audit returning vulnerabilities with severity, CVE IDs, and remediation steps. Supports npm, yarn, pnpm, cargo audit, pip-audit | |
| `getDependencyTree` | F | Unified dependency graph across npm, pip, cargo, and go mod | |
| `getGitHotspots` | F | Most frequently changed files in git history. Useful for prioritizing refactoring focus | |

---

### Workspace and Settings

| Tool | Mode | Description | Notes |
|------|------|-------------|-------|
| `getWorkspaceFolders` | S | Workspace path info. Enhanced with extension data when connected | |
| `getWorkspaceSettings` | F | Read VS Code settings | extensionRequired |
| `setWorkspaceSetting` | F | Write VS Code settings | extensionRequired |
| `setActiveWorkspaceFolder` | F | Switch active workspace in multi-root setups | |
| `getProjectInfo` | F | Auto-detect project type, dependencies, and structure | |
| `openInBrowser` | F | Open a URL in the system browser | |
| `openDiff` | F | Open side-by-side diff view between two files or versions | |

---

### HTTP and Clipboard

| Tool | Mode | Description |
|------|------|-------------|
| `sendHttpRequest` | F | Send HTTP requests. SSRF defense: private/loopback ranges blocked by default (override with `--allow-private-http`) |
| `parseHttpFile` | F | Parse `.http` files into structured request objects |
| `readClipboard` | S | Read system clipboard (1 MB cap) |
| `writeClipboard` | S | Write to system clipboard (1 MB cap) |

---

### Plans

All plan tools are full-only.

| Tool | Mode | Description |
|------|------|-------------|
| `createPlan` | F | Persist an implementation plan to disk |
| `updatePlan` | F | Update a saved plan |
| `getPlan` | F | Load a saved plan by name |
| `deletePlan` | F | Remove a saved plan |
| `listPlans` | F | List all saved plans |

---

### Handoff and Session

| Tool | Mode | Description |
|------|------|-------------|
| `setHandoffNote` | F | Persist a context summary to `~/.claude/ide/handoff-note.json`. Shared across all MCP sessions. Content capped at 10 000 chars |
| `getHandoffNote` | F | Read handoff note from a previous session. Returns `note`, `updatedAt`, `updatedBy`, and human-readable `age` |
| `getDiffFromHandoff` | S | Git diff + diagnostic delta since the last handoff note was written. Useful for session-start orientation | |

---

### VS Code Integration

| Tool | Mode | Description | Notes |
|------|------|-------------|-------|
| `executeVSCodeCommand` | S | Execute arbitrary VS Code commands by ID | extensionRequired |
| `listVSCodeCommands` | F | List available VS Code commands with optional filter | extensionRequired |
| `listVSCodeTasks` | F | List tasks from `.vscode/tasks.json` plus detected Makefile targets. Optional `type` filter | extensionRequired |
| `runVSCodeTask` | F | Execute a named VS Code task and wait for completion. Returns `{ exitCode, success }` | extensionRequired |

---

### File Watching

| Tool | Mode | Description | Notes |
|------|------|-------------|-------|
| `watchFiles` | S | Watch file glob patterns for changes | extensionRequired |
| `unwatchFiles` | S | Stop watching a file pattern | extensionRequired |

---

### Code Generation

| Tool | Mode | Description |
|------|------|-------------|
| `generateTests` | F | Extract exported symbols from a source file and generate a test scaffold (vitest/jest/pytest). Auto-detects framework from config files |
| `generateAPIDocumentation` | F | Generate API documentation from JSDoc/docstring comments. Outputs Markdown with function signatures, descriptions, and parameters |

---

### AI Workflow Composite

| Tool | Mode | Description |
|------|------|-------------|
| `getArchitectureContext` | F | Query codebase memory for an architecture overview: entry points, key modules, dependency patterns |
| `getSymbolHistory` | F | Composite: `goToDefinition` + `git blame` porcelain + `git log --follow`. Returns definition location, blame for the definition line, and commit history for the defining file |
| `findRelatedTests` | F | Name-pattern and import-reference search for test files related to a source file. Optional coverage from `coverage-summary.json` |
| `screenshotAndAnnotate` | F | Derives dev URL from `package.json` scripts, fans out to diagnostics and diff, returns a `playwrightSteps` action plan and `ideState` snapshot | extensionRequired |
| `getPRTemplate` | F | Generate a pull request body from git commit messages and diff stats. Supports bullet, prose, and conventional commit styles |

---

### Orchestrator / Claude Subprocesses

These tools require `--claude-driver subprocess` (or `api`) at startup. They are not registered otherwise.

| Tool | Mode | Description |
|------|------|-------------|
| `runClaudeTask` | F | Enqueue a Claude subprocess task. Params: `prompt` (max 32 KB), `contextFiles` (max 20, workspace-confined), `timeoutMs` (5000–600000, default 120000), `stream` (bool), `model`. Returns `{ taskId, status }` immediately, or blocks and streams if `stream: true` |
| `getClaudeTaskStatus` | F | Poll a task by ID. Returns `{ taskId, status, output (500 char cap), startedAt, completedAt, durationMs }`. Session-scoped; automation-spawned tasks (`sessionId=""`) visible to all sessions |
| `cancelClaudeTask` | F | Cancel a pending or running task. No-op if already completed. Session-scoped |
| `listClaudeTasks` | F | List tasks with optional `status` filter. Session-scoped; automation-spawned tasks included for all sessions. Output capped at 100 chars per task |
| `resumeClaudeTask` | F | Re-enqueue a completed or failed task. Preserves original prompt, contextFiles, timeoutMs, and model. Session-scoped |

Task lifecycle: `pending → running → done | error | cancelled`.

---

## When to Use X vs Y

| Decision | Use this | Not this | Reason |
|----------|----------|----------|--------|
| Jump to where a symbol is defined (know file/position) | `goToDefinition` | `navigateToSymbolByName` | LSP precision — returns exact definition site |
| Jump to symbol by name (don't know file/position) | `navigateToSymbolByName` | `searchWorkspaceSymbols` + `goToDefinition` | Composite tool handles both steps and opens the file |
| Find type errors and lint issues | `getDiagnostics` | `runTests` | `runTests` is for functional failures; `getDiagnostics` is for static analysis |
| Run test suite | `runTests` | `getDiagnostics` | `getDiagnostics` does not execute code |
| Find files by name or path pattern | `findFiles` | `searchWorkspace` | `searchWorkspace` searches file content; `findFiles` searches file paths |
| Search file content with regex | `searchWorkspace` | `findFiles` | `findFiles` matches filenames, not content |
| Edit specific line numbers | `editText` | `replaceBlock` or `searchAndReplace` | `editText` uses precise line-range targeting |
| Replace a block identified by its current content | `replaceBlock` | `editText` | `replaceBlock` matches by content; safer when line numbers may drift |
| Find and replace a pattern across many files | `searchAndReplace` | `editText` | `searchAndReplace` operates across the entire workspace |
| Symbol definition + blame + commit history in one call | `getSymbolHistory` | `gitBlame` + `goToDefinition` separately | `getSymbolHistory` is a composite; `gitBlame` returns raw line-by-line blame for any file |
| How many things reference this symbol | `getChangeImpact` | `findReferences` | `getChangeImpact` returns a `blastRadius` summary; `findReferences` returns the full reference list with locations |

---

## MCP Prompts

The bridge serves **72 built-in prompts** via `prompts/list` and `prompts/get`. They appear as `/mcp__bridge__<name>` in any MCP client supporting the MCP prompts protocol.

### Core Prompts

| Prompt | Argument(s) | Description |
|--------|-------------|-------------|
| `review-file` | `file` (required) | Code review for a specific file using current diagnostics |
| `explain-diagnostics` | `file` (required) | Explain all diagnostics in a file and suggest fixes |
| `generate-tests` | `file` (required) | Generate a test scaffold for exported symbols |
| `debug-context` | — | Snapshot current debug state, open editors, and diagnostics |
| `git-review` | `base` (default: `main`) | Review all changes since a git base branch |
| `set-effort` | `level` (low/medium/high, default: medium) | Prepend an effort-level instruction for the next task |
| `cowork` | `task` (optional) | Load full IDE context and propose a Cowork action plan. Auto-calls `getHandoffNote`, `getOpenEditors`, `getDiagnostics`, `getGitStatus`, `getProjectInfo` |
| `gen-claude-md` | — | Generate a CLAUDE.md bridge workflow section for the current project |
| `review-changes` | — | Review all uncommitted changes with diagnostics and diff |

### Dispatch Prompts (Mobile)

Optimized for terse phone triggers via Claude Desktop Dispatch. Returns concise output (under 20 lines).

| Prompt | Argument(s) | Description |
|--------|-------------|-------------|
| `project-status` | — | Git status + diagnostics + test summary |
| `quick-tests` | `filter` (optional) | Run tests; pass/fail summary with failure details |
| `quick-review` | — | Diff summary + diagnostics for changed files |
| `build-check` | — | Build/compile check with error summary |
| `recent-activity` | `count` (default: 10) | Recent git log + uncommitted changes |

### LSP Composition Prompts

Multi-step LSP workflows composed from bridge primitives.

| Prompt | Arguments | Description |
|--------|-----------|-------------|
| `find-callers` | `symbol` (required) | Every caller of a symbol with file:line. Wraps `searchWorkspaceSymbols` + `getCallHierarchy(incoming)` + `findReferences` |
| `blast-radius` | `file`, `line`, `column` (required) | Diagnostics + ref counts + risk badge. Wraps `getChangeImpact` |
| `why-error` | `file` (required), `line` (optional) | Explain a diagnostic in plain English with type context. Wraps `getDiagnostics` + `explainSymbol` |
| `unused-in` | `file` (required) | Unused exports, parameters, imports with reference verification. Wraps `detectUnusedCode` + `findReferences` |
| `trace-to` | `symbol` (required) | Call chain to target symbol with type signatures at each hop. Wraps `getCallHierarchy(outgoing)` + `getImportedSignatures` |
| `imports-of` | `symbol` (required) | Every file that imports a symbol with reference counts. Wraps `findReferences` + `getImportTree` |
| `circular-deps` | — | Detect circular import dependencies. Wraps `getImportTree` with cycle detection |
| `refactor-preview` | `file`, `line`, `column`, `newName` (required) | Preview exact edits a rename would make plus blast-radius risk. Wraps `refactorAnalyze` + `refactorPreview` |
| `module-exports` | `file` (required) | Module exported symbols with type signatures as Markdown. Wraps `getDocumentSymbols` + `getHover` |
| `type-of` | `file`, `line`, `column` (required) | Type signature at a position. Wraps `getHoverAtCursor` + `getTypeSignature` |
| `deprecations` | — | Find `@deprecated` APIs and count callers. Wraps `searchWorkspace` + `findReferences` |
| `coverage-gap` | `file` (required) | Untested functions by correlating coverage with document symbols. Wraps `getCodeCoverage` + `getDocumentSymbols` |
| `explore-type` | `file`, `line`, `column` (required) | Type declaration, definition, and all implementations. Wraps `getHover` + `goToDeclaration` + `goToTypeDefinition` + `findImplementations` |

### Edit Workflow Prompts

Multi-step workflows using `previewEdit`, transaction tools, `explainDiagnostic`, and `getDiffFromHandoff`.

| Prompt | Arguments | Description |
|--------|-----------|-------------|
| `safe-refactor` | `description` (required), `files` (optional, comma-sep) | Preview all edits as unified diffs, ask for confirmation, then apply atomically via `beginTransaction` → `stageEdit` → `commitTransaction` |
| `diagnose-and-fix` | `filePath` (optional) | Explain first error via `explainDiagnostic`, preview fix with `previewEdit`, apply, then re-check `getDiagnostics` |
| `session-delta` | — | Call `getDiffFromHandoff`, summarise files changed and diagnostic delta, suggest next action |

### Agent Teams and Scheduled Tasks

| Prompt | Argument(s) | Description |
|--------|-------------|-------------|
| `team-status` | — | Workspace state, active tasks, recent activity for coordinating parallel agents. Requires multiple Claude Code sessions simultaneously |
| `health-check` | — | Tests + diagnostics + security advisories + git status. HEALTHY/DEGRADED/FAILING grading. Designed for nightly/hourly scheduled runs |

---

## Automation Hooks

When started with `--automation --automation-policy <file>`, the bridge enqueues Claude tasks in response to IDE events. The policy is a JSON file with any of these 18 hook keys:

| Hook | Trigger | Placeholders |
|------|---------|--------------|
| `onDiagnosticsError` | New error/warning diagnostics appear | `{{file}}`, `{{diagnostics}}` |
| `onDiagnosticsCleared` | Errors/warnings drop to zero (non-zero → zero) | `{{file}}` |
| `onFileSave` | Matching file saved. `patterns`: minimatch globs | `{{file}}` |
| `onFileChanged` | Matching file buffer changes before save. `patterns`: minimatch globs | `{{file}}` |
| `onGitCommit` | `gitCommit` tool succeeds | `{{hash}}`, `{{branch}}`, `{{message}}`, `{{count}}`, `{{files}}` |
| `onGitPull` | `gitPull` tool succeeds | `{{remote}}`, `{{branch}}` |
| `onGitPush` | `gitPush` tool succeeds | `{{remote}}`, `{{branch}}`, `{{hash}}` |
| `onBranchCheckout` | `gitCheckout` tool succeeds | `{{branch}}`, `{{previousBranch}}`, `{{created}}` |
| `onPullRequest` | `githubCreatePR` tool succeeds | `{{url}}`, `{{number}}`, `{{title}}`, `{{branch}}` |
| `onTestRun` | `runTests` tool completes. `onFailureOnly: true` (default) skips passing runs | `{{runner}}`, `{{failed}}`, `{{passed}}`, `{{total}}`, `{{failures}}` (JSON array) |
| `onTestPassAfterFailure` | Test runner transitions from fail → pass | `{{runner}}`, `{{passed}}`, `{{total}}` |
| `onTaskCreated` | Claude Code `TaskCreated` hook (CC 2.1.84+) | `{{taskId}}`, `{{prompt}}` (truncated 500 chars) |
| `onTaskSuccess` | Orchestrator task completes with status `done` | `{{taskId}}`, `{{output}}` |
| `onPermissionDenied` | Claude Code `PermissionDenied` hook (CC 2.1.89+) | `{{tool}}`, `{{reason}}` |
| `onCwdChanged` | Claude Code working directory changes (CC 2.1.83+) | `{{cwd}}` |
| `onCompaction` (v2.43.0+) | Claude Code compacts conversation context (CC 2.1.76+). Set `phase: "pre"` or `phase: "post"` | — |
| `onPreCompact`/`onPostCompact` (deprecated) | Legacy split form of `onCompaction`. Still accepted; emits a deprecation warning at load time. Removed no earlier than v2.46 + 30 days | — |
| `onInstructionsLoaded` | Session starts or CLAUDE.md reloads (CC 2.1.76+). No cooldown | — |
| `onGitCommit` (via `when` condition) | Conditional evaluation with `AutomationCondition` | — |

**Shared options (all hooks):**

- `prompt` — inline prompt template with `{{placeholder}}` substitution
- `promptName` / `promptArgs` — named MCP prompt reference with argument substitution
- `cooldownMs` — minimum ms between triggers for the same file/event (min 5000)
- `when` — `AutomationCondition`: `minDiagnosticCount`, `diagnosticsMinSeverity`, `testRunnerLastStatus`
- Loop guard — if the hook's own Claude task is still `pending` or `running`, re-trigger is suppressed

**CC hook wiring:** hooks that depend on Claude Code's built-in hook events need entries in `~/.claude/settings.json`. The bridge auto-wires these when `--automation` is active.

| CC hook event | Settings.json command |
|---|---|
| `PostCompact` | `claude-ide-bridge notify PostCompact` |
| `InstructionsLoaded` | `claude-ide-bridge notify InstructionsLoaded` |
| `TaskCreated` | `claude-ide-bridge notify TaskCreated --taskId $TASK_ID --prompt $PROMPT` |
| `PermissionDenied` | `claude-ide-bridge notify PermissionDenied --tool $TOOL --reason $REASON` |
| `CwdChanged` | `claude-ide-bridge notify CwdChanged --cwd $CWD` |

---

## Headless / CI Mode

For use without VS Code — see `documents/headless-quickstart.md` for the full setup guide.

**What works headless (no extension):**

- All full-mode tools that do not require the extension: git, GitHub, terminal, file operations, formatting (CLI fallback), dependency/security analysis, orchestration.
- `getDiagnostics` and `watchDiagnostics` via CLI linters.
- `goToDefinition`, `findReferences`, `getTypeSignature` via `typescript-language-server --stdio` (TypeScript projects only).
- `searchWorkspaceSymbols` via Universal Ctags.
- `navigateToSymbolByName` via ripgrep.

**What requires the extension:**

- All pure LSP tools not listed above (`getHover`, `getCallHierarchy`, `explainSymbol`, `renameSymbol`, `getDocumentSymbols`, etc.).
- All debugger tools.
- All editor state tools (open editors, selections, buffer content from memory, decorations).
- Terminal tools (`createTerminal`, `runInTerminal`, etc.) — these use VS Code shell integration.

**CI pattern:** run the bridge with `--headless` (no extension), configure `typescript-language-server` and `ctags` in the Docker image, and use `getToolCapabilities` in the first step to confirm which fallback paths are active. Full mode is the default; pass `--slim` if you want only IDE-exclusive tools. See `documents/headless-quickstart.md` for Docker and GitHub Actions examples.

## Patchwork Approval Gate

Dashboard-backed UI for Claude Code's `ask` permission rules. Runs at two layers: CC's `PreToolUse` hook (native CC tool calls) and the bridge's MCP transport middleware. Design rationale in [ADR-0006](../docs/adr/0006-approval-gate-design.md).

### HTTP surface

| Route | Purpose |
|---|---|
| `POST /approvals` | Request approval. Body: `{ toolName, specifier?, params?, summary?, permissionMode?, sessionId? }`. Returns `{ decision: "allow"|"deny", reason, callId? }`. |
| `GET /approvals?session=<id>` | List pending approvals, optionally filtered by session. |
| `POST /approve/:callId` | Human approves a queued call. |
| `POST /reject/:callId` | Human rejects a queued call. |
| `GET /cc-permissions` | Returns merged rules (`allow` / `ask` / `deny`) + `workspace` + `attributed` (origin-tagged: `managed` / `project` / `user`). |
| `POST /hooks/<name>` | Recipe webhook trigger. Dispatches matching recipe. |

### Decision precedence

Every `POST /approvals` resolves via:

1. CC `deny` rule → deny (`reason: cc_deny_rule`).
2. CC `allow` rule → allow (`reason: cc_allow_rule`).
3. `permissionMode` short-circuits:
   - `dontAsk` → deny (`reason: dontAsk_mode`) — no UI to prompt, safer to deny.
   - `auto` → allow (`reason: auto_mode`) — CC owns escalation.
   - `plan` + read-only tool → allow (`reason: plan_mode_read`).
   - `plan` + write tool → deny (`reason: plan_mode_write`).
4. `approvalGate` setting:
   - `off` → allow (`reason: gate_off`).
   - `high` + low-tier tool → allow (`reason: gate_below_threshold`).
   - otherwise → queue for dashboard, await resolve/reject.

`reason` strings are stable — dashboard filters and analytics depend on them.

### Rule merge (ccPermissions)

Loaded from disk live, merged in CC's documented precedence: **managed > project > user**. `managedSettingsPath` is an admin-writable JSON file; rules there cannot be overridden by lower scopes. This is how an org enforces "never allow `gitPush` to main" across all developers without forking CC.

Glob specifiers (`Bash(npm run *)`) are matched via `evaluateRules` — never reimplement matching inline. Exact tool-name matches (`Read`, `gitPush`) always win over specifier patterns.

### Gate tiers

`approvalGate` is runtime-adjustable from the settings UI; no reconnect required.

| Value | Behavior |
|---|---|
| `off` | Dev mode. Bypass queueing; allow everything after rule precedence. |
| `high` | Queue only high-tier tools (`classifyTool` = `"high"`: writes, network, exec). |
| `all` | Queue every tool that survives allow/deny short-circuits. |

### Risk signals

High-tier queued items carry `riskSignals` — advisory badges surfaced in the dashboard. Detected patterns:

- **Destructive flags** (Bash/runCommand): `rm -rf`, `--force`, `sudo`, `DROP TABLE`, `TRUNCATE`, shell chaining (`` ` `` / `$()` / `&&` / `||`).
- **Domain reputation** (WebFetch/sendHttpRequest): non-HTTPS URLs, raw IP hostnames.
- **Path escape** (Write/Edit/Read): `file_path` resolves outside workspace.

Signals never change the decision — they help the human decide.

### Recipe triggers

Recipes live in `~/.patchwork/recipes/` (JSON or YAML). Supported triggers:

- **manual** — run via `patchwork recipe run <name>` CLI.
- **cron** — `@every 5m` syntax; runs via the recipe scheduler.
- **webhook** — `POST /hooks/<name>` dispatches matching recipes.
- **file_watch** — minimatch patterns on workspace files.

Install with `patchwork recipe install <path-to-recipe.yaml>`. Run history persists as JSONL at `~/.patchwork/runs.jsonl` via `RecipeRunLog` (append-only file + bounded in-memory ring); surfaced in the dashboard `/recipes` and `/runs` pages.

### Webhook SSRF defenses

`webhookUrl` (approval-queued notification) enforces:

- HTTPS-only.
- Bare `localhost` blocked.
- DNS-resolved IP checked against loopback / RFC-1918 / link-local blocklist.
- 5s timeout via `AbortController`.
- Failures logged, never thrown — webhook errors must not block approval flow.

### Mobile push notifications (phone-path approvals)

When `pushServiceUrl` is configured, the bridge dispatches a push notification alongside the webhook after queuing a call. The push relay (`services/push-relay/`) receives the payload, looks up the user's FCM/APNS device tokens, and sends the notification.

**Configuration** (runtime-mutable via `POST /settings`, no restart):

| Setting | Env var | Description |
|---|---|---|
| `pushServiceUrl` | `PATCHWORK_PUSH_URL` | HTTPS URL of push relay (e.g. `https://notify.patchwork.dev`) |
| `pushServiceToken` | `PATCHWORK_PUSH_TOKEN` | Bearer token for relay auth |
| `pushServiceBaseUrl` | `PATCHWORK_PUSH_BASE_URL` | Public HTTPS URL of this bridge (phone calls back here) |

**Phone-path auth:** each queued call gets a per-callId `approvalToken` (256-bit hex, single-use, timing-safe) delivered in the push payload. The phone POSTs to `POST /approve/:callId` or `POST /reject/:callId` with an `x-approval-token` header — no bridge bearer token needed. Token expires with the queue TTL (default 5 min).

**Invariants:**
- `approvalToken` is never returned by `GET /approvals` — only via push.
- Push dispatch is fire-and-forget and never delays the approval flow.
- Feature is fully opt-in: no behavior change when `pushServiceUrl` is absent.

Setup guide: [docs/mobile-oversight.md](../docs/mobile-oversight.md). Architecture: [docs/adr/0006-approval-gate-design.md](../docs/adr/0006-approval-gate-design.md) (amended).

## Patchwork Context Platform — Phase 3 Moat

Cross-session memory for agents. Every decision (approval verdict, enrichment link, recipe run, agent-authored fix) is persisted to JSONL and queryable through a single surface. New sessions see a digest of recent decisions automatically in their MCP instructions block — no tool call required.

### Tools

| Tool | Purpose |
|---|---|
| `ctxSaveTrace(ref, problem, solution, tags?)` | Agent writes a durable trace after resolving a task. Persists to `DecisionTraceLog`. Required: `ref` (issue/PR/commit/free-text, ≤256 chars), `problem` (≤500 chars), `solution` (≤500 chars). Optional: up to 10 tags × 32 chars each. |
| `ctxGetTaskContext(ref)` | Unified context for an issue, PR, commit, or error ref. Auto-detects ref type. Composes `gh issue view` / `gh pr view` / `git show` + `CommitIssueLinkLog` reverse lookup. Fail-soft: partial context on missing `gh` / git / log rather than throw. |
| `ctxQueryTraces({traceType?, key?, since?, limit?})` | Unified query over all four trace stores. `traceType: "approval" \| "enrichment" \| "recipe_run" \| "decision"` (omit for all). Key substring match. Returns `{traces:[{traceType, ts, key, summary, body}], count, sources}`. |

### Persistence

All four stores are JSONL with bounded in-memory rings (no SQLite). Located under `~/.patchwork/`:

| File | Writer | Dedup |
|---|---|---|
| `runs.jsonl` | `RecipeRunLog` — recipe/cron/webhook runs | none (every run is a new row) |
| `commit_issue_links.jsonl` | `CommitIssueLinkLog` — `enrichCommit` output | on `(workspace, sha, ref)` unless `linkType` / `resolved` / `issueState` / `reason` changes |
| `decision_traces.jsonl` | `DecisionTraceLog` — `ctxSaveTrace` output | none (every agent write is a new trace) |
| (activityLog lifecycle rows) | approval gate `onDecision` | by seq |

### Session-start digest

On every Claude Code session connect, the bridge refreshes a compact digest of the last 12h of decisions and prepends it to the MCP instructions block:

```
RECENT DECISIONS (last 12h):
  • deny gitPush (cc_deny_rule) — 4h ago
  ⇄ closes #42 (resolved) — fix auth timeout — 2h ago
  ▸ nightly (cron) → done — 30m ago
  ★ #42 — base case changed to return 1 when n<=1 — 10m ago
```

Strictly bounded: 12h window, top 5, 80 chars per summary, 2 KB total byte cap. Refresh is fire-and-forget on connect — if slow or failed, session sees the previous digest (or empty heading). Never blocks session setup.

### HTTP surface

| Route | Purpose |
|---|---|
| `GET /traces?traceType=&key=&since=&limit=` | Query wrapper over `ctxQueryTraces` — backs the dashboard `/traces` page. |
| dashboard `/traces` | Filter tabs (All / Approval / Enrichment / Recipe Run / Decision), key substring search, click-to-expand body JSON. Polls every 3s. |

### Ref-detection heuristics

`ctxGetTaskContext` parses refs with these rules (first match wins):

| Pattern | Type | Examples |
|---|---|---|
| `(GH-\|#)?N` (1–5 digits) | `issue` | `#42`, `GH-42`, `42` |
| `PR-N`, `pull/N`, `pr/N`, `#PRN` | `pull_request` | `PR-7`, `pull/7` |
| `TEAM-N` (2+ uppercase letters + digits) | `linear_issue` | `LIN-42`, `TEAM-123` |
| Linear URL (`linear.app/.../issue/ID`) | `linear_issue` | full Linear issue URL |
| 7–40 hex chars | `commit` | `abc1234`, full SHA |
| else | `unknown` (warning) | |

Failure modes never throw — the returned `{sources, warnings}` tells the caller what was and wasn't available.

---

## Connectors

Connectors give Patchwork agents authenticated access to external services. OAuth tokens are stored in the platform-native secret vault (Keychain on macOS, DPAPI on Windows, Secret Service on Linux) with an encrypted-file fallback at `~/.patchwork/tokens/<id>.enc` (mode 0600). Tokens auto-refresh on 401 via `baseConnector.refreshToken()` — no manual re-authorization needed until the refresh token itself expires. Managed from the dashboard **Connections** page or via HTTP routes.

> **Important distinction:** the bridge's *own* OAuth server (clients connecting TO the bridge) does not issue refresh tokens — those clients re-authorize after the 24-hour access-token TTL. The above auto-refresh applies only to *connector* tokens (the bridge connecting OUT to external services like Gmail, Linear, etc.).

### Supported connectors

| Connector | Auth | Token env var | MCP tool(s) | Recipe step(s) |
|---|---|---|---|---|
| Gmail | OAuth 2.0 (refresh token) | — | — | `gmail.fetch_unread`, `gmail.search`, `gmail.fetch_thread` |
| GitHub | `gh` CLI auth | — | — | `github.list_issues`, `github.list_prs` |
| Sentry | Personal auth token | `SENTRY_AUTH_TOKEN` | `fetchSentryIssue` | — |
| Linear | Personal API key | `LINEAR_API_KEY` | `fetchLinearIssue` | `linear.list_issues` |

### HTTP routes

All connectors share the same route shape:

| Route | Purpose |
|---|---|
| `GET /connections` | List status of all connectors (`id`, `status`, `lastSync`) |
| `POST /connections/<id>/connect` | Store + verify credentials |
| `POST /connections/<id>/test` | Re-verify stored credentials |
| `DELETE /connections/<id>` | Revoke + delete stored credentials |

### Sentry connector

Requires a Sentry **personal auth token** with `event:read`, `org:read`, `project:read` scopes.

```bash
curl -X POST http://localhost:<port>/connections/sentry/connect \
  -H "Content-Type: application/json" \
  -d '{"auth_token": "sntryu_...", "org": "my-org-slug"}'
```

The `org` field is optional but required for org-scoped issue resolution. Without it, only public issue endpoints are used.

**`fetchSentryIssue(issueId)`** — fetches a Sentry issue + latest event, converts the stack trace to Node.js format, then pipes through `enrichStackTrace` for per-frame git blame. Returns: `issueId`, `title`, `stackTrace`, `frames`, `topSuspect`, `confidence`, `sentryConnected`.

Accepts a numeric ID (`"12345"`) or a full Sentry issue URL.

### Linear connector

Requires a Linear **personal API key** from `linear.app/settings/api`.

```bash
curl -X POST http://localhost:<port>/connections/linear/connect \
  -H "Content-Type: application/json" \
  -d '{"api_key": "lin_api_..."}'
```

On connect, the workspace slug is resolved automatically from the token and stored alongside it.

**`fetchLinearIssue(issueId)`** — fetches a Linear issue by identifier or URL. Returns: `id`, `identifier`, `title`, `description`, `state`, `assignee`, `priority`, `priorityLabel`, `url`, `team`, `labels`, `createdAt`, `updatedAt`, `linearConnected`.

**`linear.list_issues` recipe step** — queries issues assigned to the authenticated user. Parameters:

| Parameter | Default | Description |
|---|---|---|
| `assignee` | `"@me"` | `"@me"` for current user |
| `state` | `"started,unstarted"` | Comma-separated Linear state types |
| `team` | — | Team key filter (e.g. `"LIN"`) |
| `max` | `20` | Max results |
| `into` | — | Context key for downstream steps |

**`ctxGetTaskContext` integration** — Linear issue refs (`LIN-42`, `TEAM-123`, or a full Linear URL) are resolved automatically. Response includes a `linearIssue` field with the full issue payload.

---

## Model Support

**Is Patchwork Claude-only?**

No. Patchwork is model-agnostic by design — that's one of its core differentiators.

### Provider drivers

The `--claude-driver` flag selects the provider backend for subprocess orchestration tasks:

| Flag value | Provider | Auth | Subscription support |
|---|---|---|---|
| `subprocess` | Claude (default) | Claude Code CLI auth | Yes — Claude Max, Pro |
| `api` | Claude | `ANTHROPIC_API_KEY` | No |
| `gemini` | Google Gemini | `gemini auth login` CLI | Yes — Google account |
| `openai` | OpenAI | `OPENAI_API_KEY` | No |
| `grok` | xAI Grok | `XAI_API_KEY` | No |
| `none` | — | — | Orchestration disabled |

**Subscription vs API key:** `subprocess` and `gemini` drivers spawn the provider's CLI, which handles OAuth/subscription auth locally. No API key required if you have an active subscription. `api`, `openai`, and `grok` always require an API key.

**Default model per driver:**

| Driver | Default model |
|---|---|
| `subprocess` / `api` | `claude-sonnet-4-6` |
| `gemini` | `gemini-2.5-flash` |
| `openai` | `gpt-4o` |
| `grok` | `grok-2-latest` |

Override with `--model` or per-recipe `model:` field.

### How model routing works

Each recipe or task specifies which model to use. Models can be mixed within a single workflow — for example: Claude drafts a sensitive email, a cheaper OpenAI model categorizes receipts, and Gemini handles anything that shouldn't leave the Google ecosystem.

### What is Claude-specific

| Component | Dependency |
|---|---|
| `claude-ide-bridge` CLI | Uses Claude Code as the subprocess orchestration driver |
| MCP protocol | Pioneered by Anthropic, now an open standard — other tools are adopting it |

The bridge's orchestration layer requires Claude Code CLI. The work each recipe does — the actual model calls — can be routed to any supported provider.

**Summary:** Claude is the engine room, but recipes, outputs, and model choices are provider-neutral. If you only have an OpenAI key or a Gemini subscription you can still run most recipes; you'd be missing the deep IDE integration that the bridge provides, but the model layer itself is not locked to Anthropic.

---

## Not Yet Implemented

Honest capability gaps as of the current release:

- **Programmatic tool calling / code sandboxes** — Tool results are returned raw to the model. Processing results in isolated sandboxes before returning them (to reduce token usage on complex workflows) is not yet implemented.
- **Form-mode elicitation** — Tools that need missing parameters return `isError: true` with instructions to re-invoke with the required fields. URL-mode (OAuth redirects) is supported; interactive form prompts inside the MCP flow are not.
- **Full deferred tool loading** — `searchTools` returns tool metadata without full schemas, partially reducing context load. The 85%-token-reduction pattern (load full schemas only on demand at call time) is not yet implemented; all registered tool schemas are sent to the model at session start.

---

## Personal AI API

Run your bridge as an OAuth-protected API that any web app, mobile shortcut, or custom tool can call.

### Activation

```bash
claude-ide-bridge --full \
  --issuer-url https://bridge.example.com \
  --cors-origin https://your-app-origin.com \
  --fixed-token <strong-random-token>
```

Once `--issuer-url` is set the bridge activates its full OAuth 2.0 server:

| Endpoint | RFC | Purpose |
|---|---|---|
| `/.well-known/oauth-authorization-server` | RFC 8414 | Metadata discovery |
| `/.well-known/oauth-protected-resource` | RFC 9396 | Resource server metadata |
| `/oauth/register` | RFC 7591 | Dynamic client registration |
| `/oauth/authorize` | RFC 6749 | Authorization code grant (PKCE S256 mandatory) |
| `/oauth/token` | RFC 6749 | Token exchange |
| `/oauth/revoke` | RFC 7009 | Token revocation |

Bearer tokens issued via the OAuth flow are accepted on all API endpoints alongside the static bridge token.

### Reference app

`examples/personal-api-demo/index.html` is a self-contained single-page app that demonstrates the complete OAuth flow:

1. **Dynamic registration** — registers itself with the bridge, no manual client setup
2. **PKCE authorization** — redirects to `/oauth/authorize`, user enters bridge token
3. **Token exchange** — exchanges code for bearer token
4. **Authenticated API calls** — lists recipes, triggers a run, responds to approvals

Run it locally:

```bash
cd examples/personal-api-demo
npx serve .
```

Open the served URL, enter your bridge URL, and click **Connect & Sign in**.

### Security checklist

- Always use HTTPS for remote deployments (`--issuer-url` must be `https://` in production)
- Set `--cors-origin` to your exact app origin (not `*`)
- Use `--fixed-token` with a strong random value (`openssl rand -hex 32`) so the bridge token doesn't rotate on restart
- Bearer tokens expire after 24 hours — clients must re-authorize
- The bridge token entered on the authorization page is the single credential that gates all OAuth flows
