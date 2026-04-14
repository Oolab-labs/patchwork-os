# MCP Prompts Reference

## Overview

MCP prompts are reusable prompt templates invocable via `prompts/get` or `/name` in Claude Desktop. The bridge ships 72 prompts across four categories. Invoke with `/prompt-name` in any chat session.

Prompts appear in the Claude Desktop prompt picker automatically when the bridge is connected. In Claude Code CLI, use `/prompt-name args`.

---

## Core Prompts (28)

### Status & Context

| Prompt | What it does | Tools called | Notes |
|--------|-------------|--------------|-------|
| `project-status` | Git status + diagnostics summary → workspace health report | `getGitStatus`, `getDiagnostics` | Also a Dispatch prompt |
| `recent-activity` | Git log + git status → what changed recently | `getGitLog`, `getGitStatus` | Also a Dispatch prompt |
| `build-check` | Project info + diagnostics + build command → pass/fail | `getProjectInfo`, `getDiagnostics`, `runCommand` | Also a Dispatch prompt |
| `quick-review` | Git status + diff + diagnostics → change quality summary | `getGitStatus`, `getGitDiff`, `getDiagnostics` | Also a Dispatch prompt |
| `context-bundle` | Captures full IDE snapshot for handoff | `contextBundle` | Slim mode |
| `health-check` | Diagnostics + security advisories + git status + tests → full health report | `getDiagnostics`, `getSecurityAdvisories`, `getGitStatus`, `runTests` | Scheduled task variant available |

### Code Quality

| Prompt | What it does | Tools called | Notes |
|--------|-------------|--------------|-------|
| `code-review` | Diff + diagnostics → inline review with severity ratings | `getGitDiff`, `getDiagnostics` | Full mode |
| `review-changes` | Staged/unstaged diff + diagnostics → diff review | `getGitDiff`, `getDiagnostics` | Full mode |
| `lint-fix` | Fix all lint errors and format document | `fixAllLintErrors`, `formatDocument` | Also a Dispatch prompt |
| `security-audit` | CVEs + outdated packages → vulnerability report | `getSecurityAdvisories`, `auditDependencies` | Full mode |
| `unused-code` | Dead code report for workspace | `detectUnusedCode` | Full mode |
| `coverage-report` | Test coverage summary | `getCodeCoverage` | Full mode; parses lcov/clover |

### Git & Releases

| Prompt | What it does | Tools called | Notes |
|--------|-------------|--------------|-------|
| `stage-and-commit` | Stage all changes and commit with message | `gitAdd`, `gitCommit` | Also a Dispatch prompt |
| `push-and-pr` | Push branch and open pull request | `gitPush`, `githubCreatePR` | Also a Dispatch prompt |
| `release-notes` | Changelog for version bump from git history | `getGitLog`, `getGitDiff` | Full mode |

### Navigation

| Prompt | What it does | Tools called | Notes |
|--------|-------------|--------------|-------|
| `find-symbol` | Locate definition of named symbol | `searchWorkspaceSymbols` | Slim mode |
| `explain-file` | File purpose + exports overview | `getDocumentSymbols`, `explainSymbol` | Slim mode |
| `trace-call` | Who calls this function (incoming call hierarchy) | `getCallHierarchy` | Slim mode; direction: incoming |
| `find-tests` | Test files related to current source file | `findRelatedTests` | Full mode |

### Refactoring

| Prompt | What it does | Tools called | Notes |
|--------|-------------|--------------|-------|
| `refactor-safe` | Risk level + exact edit preview before committing | `refactorAnalyze`, `refactorPreview` | Slim mode |
| `rename-symbol` | Safe rename workflow with impact analysis | `refactorAnalyze`, `renameSymbol` | Slim mode |
| `extract-function` | Extract selected code range to a named function | `refactorExtractFunction` | Slim mode |

### Debugging

| Prompt | What it does | Tools called | Notes |
|--------|-------------|--------------|-------|
| `debug-session` | Set breakpoints and launch debugger | `setDebugBreakpoints`, `startDebugging` | Slim mode |
| `diagnose-errors` | All current errors (error severity only) | `getDiagnostics` | Slim mode; also a Dispatch prompt |
| `watch-diagnostics` | Live error stream (long-poll) | `watchDiagnostics` | Slim mode |

### Miscellaneous

| Prompt | What it does | Tools called | Notes |
|--------|-------------|--------------|-------|
| `scaffold-tests` | Generate test stubs for current file | `generateTests` | Full mode |
| `pr-template` | Fill PR description template | `getPRTemplate` | Full mode |
| `cowork-handoff` | Bundle IDE context and write handoff note before switching to Cowork | `contextBundle`, `setHandoffNote` | Alias: `mcp__bridge__cowork` |

---

## Dispatch Prompts (8)

Short prompts designed for mobile use via Claude Desktop Dispatch or Siri. Responses are capped at 20 lines. All require `--full` mode.

Invoke by voice phrase or by typing the prompt name in any Claude chat.

| Prompt | Phone phrase | Tools called |
|--------|-------------|--------------|
| `project-status` | "How's the build?" | `getGitStatus`, `getDiagnostics` |
| `quick-review` | "Review my changes" | `getGitStatus`, `getGitDiff`, `getDiagnostics` |
| `build-check` | "Does it build?" | `getProjectInfo`, `getDiagnostics`, `runCommand` |
| `recent-activity` | "What changed?" | `getGitLog`, `getGitStatus` |
| `lint-fix` | "Fix lint errors" | `fixAllLintErrors`, `formatDocument` |
| `push-and-pr` | "Push and open PR" | `gitPush`, `githubCreatePR` |
| `diagnose-errors` | "Any errors?" | `getDiagnostics` (error filter) |
| `stage-and-commit` | "Commit everything" | `gitAdd`, `gitCommit` |

---

## LSP Composition Prompts (13)

Deep code intelligence prompts combining multiple LSP tools. All available in slim mode unless noted.

| Prompt | What it does | Tools used |
|--------|-------------|-----------|
| `explain-symbol` | Full symbol analysis: hover + definition + refs + type hierarchy | `explainSymbol` |
| `find-usages` | All call sites and test files that use a symbol | `findReferences`, `findRelatedTests` |
| `impact-analysis` | Blast radius for a proposed change: ref counts + diagnostics | `getChangeImpact`, `getDiagnostics` |
| `type-hierarchy` | Supertypes and subtypes of a class or interface | `getTypeHierarchy` |
| `call-chain` | Full incoming and outgoing call graph for a function | `getCallHierarchy` (both directions) |
| `import-tree` | What this file imports and the signatures of those imports | `getImportedSignatures` |
| `refactor-preview` | Analyze rename/extract risk then show exact edits | `refactorAnalyze`, `refactorPreview` |
| `annotate-code-review` | Apply inline warning/error review decorations to open editor | `setEditorDecorations` |
| `code-lens-summary` | Test run counts and reference counts for all symbols in file | `getCodeLens` |
| `semantic-map` | Semantic token types and modifiers across the current file | `getSemanticTokens` |
| `inlay-hints` | Inline type annotations and parameter name hints | `getInlayHints` |
| `symbol-history` | Definition origin + blame + git log follow for a symbol | `getSymbolHistory` |
| `screenshot-plan` | Derive dev URL + gather diagnostics + diff → Playwright action plan | `screenshotAndAnnotate` |

---

## Agent & Scheduled Prompts (23)

Prompts designed for automated or orchestrated use. Most require `--full` mode.

### Agent Coordination

| Prompt | What it does | Tools called | Notes |
|--------|-------------|--------------|-------|
| `team-status` | Workspace state + active tasks + recent activity across all connected sessions | `getGitStatus`, `listClaudeTasks`, `getActivityLog` | Requires multiple Claude Code sessions connected simultaneously |
| `task-report` | List all Claude subprocess tasks with current status | `listClaudeTasks` | Full mode |
| `handoff-summary` | Read handoff note + git status → session transition brief | `getHandoffNote`, `getGitStatus` | Use at session start to recover prior context |

### Scheduled Tasks

These prompts are designed to be run on a timer. Copy templates from `templates/scheduled-tasks/` to `~/.claude/scheduled-tasks/` and restart Claude Desktop.

| Prompt | Cadence | What it does | Tools called |
|--------|---------|-------------|--------------|
| `nightly-review` | Nightly | Full review: tests + coverage + security + git hotspots | `runTests`, `getCodeCoverage`, `getSecurityAdvisories`, `getGitHotspots` |
| `health-check` | Hourly | Lighter check: diagnostics + advisories + git status | `getDiagnostics`, `getSecurityAdvisories`, `getGitStatus` |
| `dependency-audit` | Weekly | Outdated packages + CVE report | `auditDependencies`, `getSecurityAdvisories` |

### Automation Policy Prompts

Invoked automatically by automation hooks when configured with `promptName`. Each maps to a hook event.

| Prompt | Triggered by | What it does | Tools called |
|--------|-------------|-------------|--------------|
| `on-save-lint` | `onFileSave` | Run lint and format on the saved file | `fixAllLintErrors`, `formatDocument` |
| `on-error-fix` | `onDiagnosticsError` | Attempt to auto-fix newly introduced errors | `getDiagnostics`, `getCodeActions` |
| `on-commit-review` | `onGitCommit` | Post-commit review of staged changes | `getGitDiff`, `getDiagnostics` |
| `on-test-failure` | `onTestRun` (failure only) | Diagnose test failures and suggest fixes | `getDiagnostics`, `findReferences` |
| `on-pr-opened` | `onPullRequest` | Auto-review pull request on open | `getGitDiff`, `getDiagnostics`, `getPRTemplate` |
| `on-branch-checkout` | `onBranchCheckout` | Context brief for newly checked-out branch | `getGitStatus`, `getGitLog`, `contextBundle` |
| `on-debug-end` | `onDebugSessionEnd` | Post-debug summary: what ran, what failed | `getDiagnostics`, `getGitStatus` |
| `on-git-push` | `onGitPush` | Post-push summary for remote branch | `getGitLog`, `getGitStatus` |
| `on-git-pull` | `onGitPull` | Summarize incoming changes after pull | `getGitLog`, `getGitDiff` |
| `on-permission-denied` | `onPermissionDenied` | Log and explain denied tool call | — |
| `on-task-created` | `onTaskCreated` | Log new Claude subprocess task | `listClaudeTasks` |
| `on-task-success` | `onTaskSuccess` | Summarize completed task output | — |
| `on-cwd-changed` | `onCwdChanged` | Brief context refresh after working directory change | `getGitStatus`, `getDiagnostics` |

---

## Using Named Prompts in Automation Policy

Instead of inline `prompt` strings, reference a prompt by name using `promptName` and pass arguments with `promptArgs`:

```json
{
  "onFileSave": {
    "enabled": true,
    "promptName": "on-save-lint",
    "promptArgs": { "file": "{{file}}" }
  }
}
```

`promptArgs` values are substituted into the named prompt's template. Bridge placeholder expansion happens first — `{{file}}` is replaced with the actual file path before being passed to the prompt.

This keeps automation policy files clean and avoids duplicating long prompt strings across multiple hook entries.

---

## Invoking Prompts from Claude Code

```
/project-status
/explain-symbol symbolName=MyClass file=src/foo.ts
/find-tests file=src/utils.ts
/code-review
/refactor-safe symbol=processPayment file=src/billing.ts
```

Arguments are passed as `key=value` pairs after the prompt name. Prompts that take no arguments can be invoked with just `/prompt-name`.

In Claude Desktop, prompts appear in the `/` picker. Typing the first few characters filters the list.

---

## Prompt Availability by Mode

| Category | Slim mode | Full mode required |
|----------|-----------|-------------------|
| Status & Context | `context-bundle` | All others |
| Code Quality | — | All |
| Git & Releases | — | All |
| Navigation | `find-symbol`, `explain-file`, `trace-call` | `find-tests` |
| Refactoring | `refactor-safe`, `rename-symbol`, `extract-function` | — |
| Debugging | `debug-session`, `diagnose-errors`, `watch-diagnostics` | — |
| Miscellaneous | — | `scaffold-tests`, `pr-template`, `cowork-handoff` |
| Dispatch | — | All (require `--full`) |
| LSP Composition | All 13 | — |
| Agent & Scheduled | — | All |

Call `getToolCapabilities` at session start to confirm which tools (and therefore which prompts) are active in the current mode.
