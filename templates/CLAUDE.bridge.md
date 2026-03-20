## Claude IDE Bridge

The bridge is connected via MCP. Call `getToolCapabilities` at the start of each session to confirm which tools are available and note any that require the VS Code extension.

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

- **After editing any file** — call `getDiagnostics` to catch errors introduced by the change
- **Running tests** — use `runTests` instead of shell commands; output streams in real time
- **Git operations** — use bridge git tools (`getGitStatus`, `gitAdd`, `gitCommit`, `gitPush`) for structured, auditable operations
- **Debugging** — use `setDebugBreakpoints` → `startDebugging` → `evaluateInDebugger` for interactive debugging
- **Navigating code** — prefer `goToDefinition`, `findReferences`, and `getCallHierarchy` over grep

### Quick reference

| Task | Tool |
|---|---|
| Check errors / warnings | `getDiagnostics` |
| Run tests | `runTests` |
| Git status / diff | `getGitStatus`, `getGitDiff` |
| Stage, commit, push | `gitAdd`, `gitCommit`, `gitPush` |
| Open a pull request | `githubCreatePR` |
| Navigate to definition | `goToDefinition` |
| Find all references | `findReferences` |
| Call hierarchy | `getCallHierarchy` |
| File tree / symbols | `getFileTree`, `getDocumentSymbols` |
| Run a shell command | `runInTerminal`, `getTerminalOutput` |
| Interactive debug | `setDebugBreakpoints`, `startDebugging`, `evaluateInDebugger` |
| Lint / format | `fixAllLintErrors`, `formatDocument` |
| Security audit | `getSecurityAdvisories`, `auditDependencies` |
| Unused code | `detectUnusedCode` |

### Dispatch prompts (mobile)

When responding to terse Dispatch messages from a phone, use these prompts for consistent, concise output:

| Phone message | Prompt | Tools called |
|---|---|---|
| "How's the build?" | `project-status` | `getGitStatus`, `getDiagnostics`, `runTests` |
| "Run the tests" | `quick-tests` | `runTests` |
| "Review my changes" | `quick-review` | `getGitStatus`, `getGitDiff`, `getDiagnostics` |
| "Does it build?" | `build-check` | `getProjectInfo`, `getDiagnostics`, `runCommand` |
| "What changed?" | `recent-activity` | `getGitLog`, `getGitStatus` |

Keep responses concise (under 20 lines) when the conversation arrives via Dispatch.

### Agent Teams & Scheduled Tasks

| Context | Prompt | What it does |
|---|---|---|
| Team lead checking on parallel agents | `team-status` | Workspace state, active tasks, recent activity across sessions |
| Scheduled nightly/hourly health check | `health-check` | Tests + diagnostics + security advisories + git status |

Ready-made scheduled task templates are available in `templates/scheduled-tasks/` — copy to `~/.claude/scheduled-tasks/` for recurring autonomous workflows (nightly-review, health-check, dependency-audit).
