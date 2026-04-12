## Claude IDE Bridge

@import .claude/rules/bridge-tools.md
> **BRIDGE TOOL ENFORCEMENT — mandatory when bridge is connected**
> Do NOT use native Claude Code tools or shell commands for workspace operations:
> - File reading: `getBufferContent` (not `Read` tool)
> - File editing: `editText` or `searchAndReplace` (not `Edit`/`Write` tools)
> - File search: `searchWorkspace` / `findFiles` (not `Grep`/`Glob` tools)
> - Testing: `runTests` (not `npm test` / `npx vitest`)
> - Diagnostics: `getDiagnostics` (not `tsc --noEmit` / `npm run lint`)
> - Git: `gitCommit`, `gitAdd`, `gitPush` (not `git commit` etc.)
> - Shell commands: `runInTerminal` (not `Bash` tool)
>
> **Exceptions:** `Read`/`Edit`/`Write` on files outside the workspace (`~/.claude/`, system paths) have no bridge equivalent.
>
> Full substitution table: see `.claude/rules/bridge-tools.md` (loaded above via @import).
The bridge is connected via MCP. The session-start hook reports connection status, tool count, and extension state automatically — check that summary before proceeding. If tools appear missing, call `getBridgeStatus` to diagnose.

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

Bridge tool substitution rules are in `.claude/rules/bridge-tools.md` (loaded above). The Quick reference table below is a summary.

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

When a terse message arrives via Claude Desktop Dispatch (phone/Siri), Claude automatically routes it to the appropriate bridge prompt. You can also invoke these prompts directly by name in any chat.

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

> Prerequisite for `team-status`: multiple Claude Code sessions must be connected simultaneously. Solo sessions will show empty team activity.

> **Claude Code ≥ v2.1.77**: `SendMessage` auto-resumes stopped agents — no need to check whether a teammate is running before sending to it.

Ready-made scheduled task templates (nightly-review, health-check, dependency-audit) are included with the bridge package. Copy the ones you want to `~/.claude/scheduled-tasks/` and restart Claude Desktop to activate them. Find them in the `templates/scheduled-tasks/` directory of the `claude-ide-bridge` npm package (typically `$(npm root -g)/claude-ide-bridge/templates/scheduled-tasks/`).

### Cowork (computer-use)

**MCP bridge tools are NOT available inside Cowork sessions.** Always run `/mcp__bridge__cowork` in a regular Claude Code or Claude Desktop chat first to gather context and write a handoff note, then open Cowork.

Workflow:
1. Regular chat: run `/mcp__bridge__cowork` → Claude collects IDE state → calls `setHandoffNote`
2. Open Cowork (Cmd+2 on Mac) → Cowork reads the handoff note for context

**If bridge tools are missing from your tool list inside Cowork:** you're in the wrong context. Exit, run the prompt in regular chat, then return.

Full details: [docs/cowork-workflow.md](docs/cowork-workflow.md)

**Cowork uses git worktrees:** Cowork sessions operate in an isolated git worktree (separate branch/working copy), not the main workspace root. Files written by Cowork land in the worktree. Always add "write all files to the workspace root, not a subdirectory" as the first instruction in your CLAUDE.md when using Cowork with a synced workspace. After Cowork finishes, review and merge the worktree branch back to main.

### Session continuity

| Scenario | Action |
|---|---|
| Switching CLI → Desktop | Call `setHandoffNote` before switching; bridge auto-snapshots if note is >5 min stale |
| Session just started | Call `getHandoffNote` to pick up prior context (workspace-scoped). **Caution:** the `onInstructionsLoaded` automation hook may have auto-overwritten the note at session start — if the content looks generic or templated, treat it as stale and consult any persistent session log your project maintains (e.g. `docs/session-log.md`) for authoritative history. |
| Bridge restarted | First connected client receives a "restored from checkpoint" notification |
| Preparing for Cowork | Run `/mcp__bridge__cowork` in regular chat first — Cowork has no MCP access |
| Multi-workspace | Notes are workspace-scoped; switching workspaces won't overwrite each other's notes |
