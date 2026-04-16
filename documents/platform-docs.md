# Claude IDE Bridge — Platform Documentation

Version **2.42.0** · 141 tools · 72 MCP prompts · 20 automation hooks

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
| `onPostCompact` | Claude Code compacts conversation context (CC 2.1.76+) | — |
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
